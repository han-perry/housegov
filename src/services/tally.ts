/**
 * Vote tabulation. Pure functions over ballots: easy to test, and cheap
 * enough to rerun on every ballot change for live results.
 *
 * Answer shapes per question type:
 *   choice:      "optId" | {writeIn}
 *   multi:       ["optId", ...]
 *   vote/pick1:  "optId" | {writeIn}
 *   vote/irv:    ["optId" | "writein:Name", ...]   (most preferred first)
 *   text:        "free text"
 */

export const WRITE_IN = "writein:";

export interface Option {
  id: string;
  label: string;
  statement?: string;
}
export interface QuestionConfig {
  method?: "pick1" | "irv";
  writeIn?: boolean;
  threshold?: number | null; // percent, e.g. 66.7
  required?: boolean;
  /** Option id that adopts the question's amendment (choice questions only). */
  adopt?: string | null;
}
export interface Question {
  id: number;
  type: "choice" | "multi" | "vote" | "text";
  prompt: string; // inline markdown
  description?: string; // markdown
  options: Option[];
  config: QuestionConfig;
  amendment_id?: number | null;
}
export type Answer = string | string[] | { writeIn: string };
export interface Ballot {
  answers: Record<string, Answer>;
  excluded?: boolean;
}

export interface ThresholdInfo {
  required: number;
  met: boolean;
}
export interface Row {
  id: string;
  label: string;
  count: number;
  share: number;
  threshold?: ThresholdInfo | null;
}
export interface IrvRound {
  counts: Row[];
  exhausted: number;
  eliminated: string | null;
}
export type QuestionTally =
  | { kind: "bars"; total: number; rows: Row[] }
  | { kind: "irv"; total: number; rounds: IrvRound[]; winner: Row | null; rows: Row[] }
  | { kind: "text"; total: number; responses: string[] };

export function optionLabel(q: Question, id: string): string {
  if (id.startsWith(WRITE_IN)) return `${id.slice(WRITE_IN.length)} (write-in)`;
  return q.options.find((o) => o.id === id)?.label ?? id;
}

/** Normalise write-ins so "Jane Doe" and " jane doe " count together. */
function writeInKey(name: string): string {
  return WRITE_IN + name.trim().replace(/\s+/g, " ").toLowerCase();
}

function thresholdInfo(q: Question, share: number): ThresholdInfo | null {
  const t = q.config.threshold;
  if (t === undefined || t === null || Number.isNaN(Number(t))) return null;
  return { required: Number(t), met: share >= Number(t) / 100 };
}

function countSingle(q: Question, answers: (Answer | undefined)[]): QuestionTally {
  const counts = new Map<string, number>(q.options.map((o) => [o.id, 0]));
  let total = 0;
  for (const a of answers) {
    if (a === undefined || a === null || a === "" || Array.isArray(a)) continue;
    const key = typeof a === "object" ? writeInKey(a.writeIn) : a;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  }
  // A threshold asks "did one option carry with at least X%?", so it is
  // judged only on the clear leader (ties carry nothing).
  const max = Math.max(0, ...counts.values());
  const leaders = [...counts.values()].filter((n) => n === max).length;
  const rows = [...counts].map(([id, n]) => {
    const share = total ? n / total : 0;
    const leads = n > 0 && n === max && leaders === 1;
    return { id, label: optionLabel(q, id), count: n, share, threshold: leads ? thresholdInfo(q, share) : null };
  });
  return { kind: "bars", total, rows };
}

/** Multi-select: share = fraction of ballots that selected the option (approval-style). */
function countMulti(q: Question, answers: (Answer | undefined)[]): QuestionTally {
  const counts = new Map<string, number>(q.options.map((o) => [o.id, 0]));
  let total = 0;
  for (const a of answers) {
    if (!Array.isArray(a) || !a.length) continue;
    total++;
    for (const id of new Set(a)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const rows = [...counts].map(([id, n]) => {
    const share = total ? n / total : 0;
    return { id, label: optionLabel(q, id), count: n, share, threshold: thresholdInfo(q, share) };
  });
  return { kind: "bars", total, rows };
}

/**
 * Instant-runoff voting. Each round, every ballot counts for its highest-
 * ranked continuing candidate. A majority of continuing ballots wins;
 * otherwise eliminate the lowest. Ties for elimination are broken by fewest
 * first-round votes, then alphabetically (deterministic, but the House Chair
 * should review any tie).
 */
export function instantRunoff(q: Question, answers: (Answer | undefined)[]): QuestionTally {
  const ballots = answers
    .filter((a): a is string[] => Array.isArray(a))
    .map((r) => [...new Set(r.map((id) => (id.startsWith(WRITE_IN) ? writeInKey(id.slice(WRITE_IN.length)) : id)))])
    .filter((r) => r.length);

  const continuing = new Set<string>(q.options.map((o) => o.id));
  for (const b of ballots) for (const id of b) continuing.add(id);
  const firstRound = new Map<string, number>();
  const rounds: IrvRound[] = [];
  let winner: Row | null = null;

  while (continuing.size > 0) {
    const tally = new Map<string, number>([...continuing].map((c) => [c, 0]));
    let exhausted = 0;
    for (const b of ballots) {
      const top = b.find((id) => continuing.has(id));
      if (top === undefined) exhausted++;
      else tally.set(top, tally.get(top)! + 1);
    }
    const active = ballots.length - exhausted;
    if (!rounds.length) for (const [c, n] of tally) firstRound.set(c, n);
    const round: IrvRound = {
      counts: [...tally]
        .map(([id, n]) => ({ id, label: optionLabel(q, id), count: n, share: active ? n / active : 0 }))
        .sort((a, b) => b.count - a.count),
      exhausted,
      eliminated: null,
    };
    rounds.push(round);

    const leader = round.counts[0];
    if (!leader || active === 0) break;
    if (leader.count * 2 > active || continuing.size === 1) {
      winner = leader;
      break;
    }
    const min = Math.min(...round.counts.map((c) => c.count));
    const lowest = round.counts
      .filter((c) => c.count === min)
      .sort((a, b) => (firstRound.get(a.id) ?? 0) - (firstRound.get(b.id) ?? 0) || a.label.localeCompare(b.label))[0];
    round.eliminated = lowest.label;
    continuing.delete(lowest.id);
  }

  const last = rounds.at(-1);
  return {
    kind: "irv",
    total: ballots.length,
    rounds,
    winner: winner && { ...winner, threshold: thresholdInfo(q, winner.share) },
    rows: last ? last.counts.map((c) => ({ ...c, threshold: winner && c.id === winner.id ? thresholdInfo(q, c.share) : null })) : [],
  };
}

export function tallyQuestion(q: Question, ballots: Ballot[]): QuestionTally {
  const answers = ballots.map((b) => b.answers[String(q.id)]);
  switch (q.type) {
    case "choice":
      return countSingle(q, answers);
    case "multi":
      return countMulti(q, answers);
    case "vote":
      return q.config.method === "irv" ? instantRunoff(q, answers) : countSingle(q, answers);
    case "text": {
      const responses = answers.filter((a): a is string => typeof a === "string" && !!a);
      return { kind: "text", total: responses.length, responses };
    }
  }
}

export type PollTally = QuestionTally & { questionId: number; prompt: string; type: Question["type"]; thresholdRequired: number | null };

/** Tally every question, skipping ballots the chair excluded. */
export function tallyPoll(questions: Question[], ballots: Ballot[]): PollTally[] {
  const counted = ballots.filter((b) => !b.excluded);
  return questions.map((q) => ({
    questionId: q.id,
    prompt: q.prompt,
    type: q.type,
    thresholdRequired: q.config.threshold === undefined || q.config.threshold === null ? null : Number(q.config.threshold),
    ...tallyQuestion(q, counted),
  }));
}

/**
 * Does the question's amendment pass? The adopting option must be the clear
 * leader and reach the threshold, or, with no threshold, more than half of
 * the answers to this question. Blank answers don't count either way.
 */
export function amendmentOutcome(q: Question, t: QuestionTally) {
  const required = q.config.threshold === undefined || q.config.threshold === null ? null : Number(q.config.threshold);
  const rows = t.kind === "bars" ? t.rows : [];
  const row = rows.find((r) => r.id === q.config.adopt);
  const max = Math.max(0, ...rows.map((r) => r.count));
  const leads = !!row && row.count > 0 && row.count === max && rows.filter((r) => r.count === max).length === 1;
  const share = row?.share ?? 0;
  const passes = required !== null ? leads && share >= required / 100 : share > 0.5;
  return { adoptLabel: row?.label ?? optionLabel(q, q.config.adopt ?? ""), share, required, passes };
}
