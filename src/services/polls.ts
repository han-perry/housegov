import * as db from "../db";
import * as ballots from "./ballots";
import * as govdocs from "./govdocs";
import { amendmentOutcome, tallyPoll, WRITE_IN, type Answer, type Question } from "./tally";

export type PollStatus = "upcoming" | "open" | "closed";

export interface PollRow {
  id: number;
  title: string;
  description: string;
  secret: boolean;
  opens_at: Date;
  closes_at: Date;
  show_live_results: boolean;
  proposal_id: number | null;
  finalized: boolean;
  created_by: string;
  created_at: Date;
}

export function status(poll: { opens_at: Date; closes_at: Date }, now = new Date()): PollStatus {
  if (now < new Date(poll.opens_at)) return "upcoming";
  if (now >= new Date(poll.closes_at)) return "closed";
  return "open";
}

export function questions(pollId: number): Promise<Question[]> {
  return db.all<Question>("SELECT id,type,prompt,description,options,config,amendment_id FROM poll_questions WHERE poll_id=$1 ORDER BY sort, id", [pollId]);
}

export interface QuestionAmendment {
  id: number;
  title: string;
  doc_slug: string;
  doc_title: string;
  status: string;
}

export async function get(id: number) {
  if (!Number.isInteger(id)) return null;
  const p = await db.get<PollRow>("SELECT * FROM polls WHERE id=$1", [id]);
  if (!p) return null;
  const qs = await questions(id);
  const ids = qs.map((q) => q.amendment_id).filter((x): x is number => !!x);
  const rows = ids.length
    ? await db.all<QuestionAmendment>("SELECT a.id,a.title,a.doc_slug,a.status,d.title AS doc_title FROM amendments a JOIN docs d ON d.slug=a.doc_slug WHERE a.id = ANY($1::int[])", [ids])
    : [];
  const byId = new Map(rows.map((a) => [a.id, a]));
  return {
    ...p,
    questions: qs.map((q) => ({ ...q, amendment: q.amendment_id ? byId.get(q.amendment_id) ?? null : null })),
    status: status(p),
  };
}
export type Poll = NonNullable<Awaited<ReturnType<typeof get>>>;

/**
 * Tallies for a poll. Free-text responses can identify their author by
 * writing style, so they're only included for poll admins (`withText`);
 * everyone else sees how many there were.
 */
export async function results(poll: Poll, { withText = false } = {}) {
  const all = await ballots.all(poll.id);
  const tallies = tallyPoll(poll.questions, all).map((t) => {
    const q = poll.questions.find((x) => x.id === t.questionId)!;
    const out = t.kind === "text" && !withText ? { ...t, responses: [], hidden: true } : t;
    // Questions that decide an amendment say so, with whether it's passing.
    if (!q.amendment) return out;
    return { ...out, amendment: { ...q.amendment, ...amendmentOutcome(q, t) } };
  });
  return { tallies, ballotCount: all.length, counted: all.filter((b) => !b.excluded).length };
}

/** Visible once closed, or live if the chair enabled it. */
export function resultsVisible(poll: Poll): boolean {
  return poll.status === "closed" || !!poll.show_live_results;
}

/** Validate a submitted answer set against the poll's questions. */
export function validateAnswers(poll: Poll, raw: Record<string, unknown> | undefined) {
  const answers: Record<string, Answer> = {};
  const errors: string[] = [];
  for (const q of poll.questions) {
    const a = raw?.[String(q.id)];
    const ids = new Set(q.options.map((o) => o.id));
    const required = q.config.required !== false && q.type !== "text";
    const isWriteIn = (x: unknown): x is { writeIn: string } =>
      !!q.config.writeIn && typeof x === "object" && x !== null && typeof (x as { writeIn?: unknown }).writeIn === "string" && !!(x as { writeIn: string }).writeIn.trim();

    if (q.type === "text") {
      if (typeof a === "string" && a.trim()) answers[q.id] = a.trim().slice(0, 5000);
    } else if (q.type === "choice" || (q.type === "vote" && q.config.method !== "irv")) {
      if (isWriteIn(a)) answers[q.id] = { writeIn: a.writeIn.trim().slice(0, 100) };
      else if (typeof a === "string" && ids.has(a)) answers[q.id] = a;
      else if (required) errors.push(`Please answer: ${q.prompt}`);
    } else if (q.type === "multi") {
      const sel = Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && ids.has(x)) : [];
      if (sel.length) answers[q.id] = [...new Set(sel)];
      else if (required) errors.push(`Please select at least one option: ${q.prompt}`);
    } else if (q.type === "vote") {
      const ranking = Array.isArray(a)
        ? a
            .filter((x): x is string => typeof x === "string")
            .filter((x) => ids.has(x) || (!!q.config.writeIn && x.startsWith(WRITE_IN) && x.length > WRITE_IN.length))
            .map((x) => x.slice(0, 120))
        : [];
      if (ranking.length) answers[q.id] = [...new Set(ranking)];
      else if (required) errors.push(`Please rank at least one candidate: ${q.prompt}`);
    }
  }
  return { answers, errors };
}

/**
 * When a poll closes, each question that decides an amendment applies it if
 * its adopting option won (tally.amendmentOutcome), and rejects it otherwise.
 * Questions are independent; two amendments to the same document in one poll
 * are applied in question order, and the second may need conflict resolution.
 */
export async function finalize(poll: Poll) {
  if (poll.finalized || poll.status !== "closed") return null;
  const claimed = await db.run("UPDATE polls SET finalized=true WHERE id=$1 AND finalized=false", [poll.id]);
  if (!claimed.rowCount) return null;
  const decided = poll.questions.filter((q) => q.amendment_id);
  if (!decided.length) return [];
  const { tallies } = await results(poll);
  const out: Array<{ amendmentId: number; questionId: number; passes: boolean; ok?: boolean; reason?: string }> = [];
  for (const q of decided) {
    const t = tallies.find((x) => x.questionId === q.id);
    const passes = !!t && amendmentOutcome(q, t).passes;
    const context = `Poll #${poll.id}, question "${q.prompt}"`;
    if (passes) {
      const r = await govdocs.applyAmendment(q.amendment_id!, { actor: "housegov", context });
      out.push({ amendmentId: q.amendment_id!, questionId: q.id, passes, ok: r.ok, reason: r.ok ? undefined : r.reason });
    } else {
      await db.run("UPDATE amendments SET status='rejected' WHERE id=$1 AND status<>'applied'", [q.amendment_id]);
      out.push({ amendmentId: q.amendment_id!, questionId: q.id, passes });
    }
  }
  return out;
}

/** Run periodically: finalize polls whose deadline has passed. */
export async function finalizeDue() {
  const due = await db.all("SELECT id FROM polls WHERE finalized=false AND closes_at <= now()");
  for (const { id } of due) {
    try {
      const p = await get(id);
      if (p) await finalize(p);
    } catch (e) {
      console.error(`[polls] finalize ${id} failed:`, e);
    }
  }
}
