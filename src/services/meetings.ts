import * as db from "../db";
import { config } from "../config";
import { render, escapeHtml as esc } from "./markdown";
import * as proposals from "./proposals";

/** The next meeting that hasn't been completed (live or scheduled). */
export function upcoming() {
  return db.get("SELECT * FROM meetings WHERE status <> 'completed' ORDER BY meeting_at ASC LIMIT 1");
}

export function previous() {
  return db.get("SELECT * FROM meetings WHERE status = 'completed' ORDER BY meeting_at DESC LIMIT 1");
}

/** Which meeting will consider a proposal submitted at `when`? */
export async function considerationFor(when = new Date()) {
  const meeting = await upcoming();
  if (!meeting) return { meeting: null, missedCutoff: false };
  return { meeting, missedCutoff: when >= new Date(meeting.cutoff_at) || meeting.status !== "scheduled" };
}

export function agenda(meetingId: number) {
  return db.all(
    `SELECT ai.*, p.title AS p_title, p.type AS p_type, p.author AS p_author, p.decision AS p_decision
     FROM agenda_items ai LEFT JOIN proposals p ON p.id = ai.proposal_id
     WHERE ai.meeting_id=$1 ORDER BY ai.sort, ai.id`,
    [meetingId]
  );
}

export async function nextSort(meetingId: number): Promise<number> {
  const r = await db.get<{ n: number }>("SELECT COALESCE(MAX(sort),0)+1 AS n FROM agenda_items WHERE meeting_id=$1", [meetingId]);
  return Number(r?.n ?? 1);
}

export interface Slide {
  kind: "title" | "block" | "proposal" | "end";
  title: string;
  html: string;
  itemId?: number;
  proposalId?: number;
  decision?: string | null;
  decisions?: string[];
  outcome?: proposals.VoteOutcome | null;
  required?: string | null;
}

/**
 * Build the deck from the agenda. The same array feeds the projector
 * (reveal.js), the presenter console, and the mobile live view.
 */
export async function buildSlides(meetingId: number): Promise<Slide[]> {
  const m = await db.get("SELECT * FROM meetings WHERE id=$1", [meetingId]);
  if (!m) return [];
  const date = new Date(m.meeting_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const slides: Slide[] = [{ kind: "title", title: m.title, html: `<h1>${esc(m.title)}</h1><h3>${date}</h3>${render(m.preface)}` }];

  for (const item of await agenda(meetingId)) {
    if (item.kind === "block") {
      slides.push({ kind: "block", itemId: item.id, title: item.title, html: `<h2>${esc(item.title)}</h2>${render(item.body)}` });
      continue;
    }
    const p = item.proposal_id ? await proposals.get(Number(item.proposal_id)) : null;
    if (!p) continue;
    const t = proposals.TYPES[p.type];
    const by = p.coauthors ? `${esc(p.author)} and ${esc(p.coauthors)}` : esc(p.author);
    const funding = p.funding
      ? `<p class="slide-funding">Requesting <b>$${esc(p.funding.final_amount)}</b> for ${esc(proposals.accountPhrase(p.funding.account_number))}</p>`
      : "";
    const amendments = p.attachments
      .filter((a) => a.kind === "amendment")
      .map(
        (a) =>
          `<li>Amends <a href="${config.basePath}/docs/${encodeURIComponent(a.doc_slug)}" target="_blank" rel="noopener"><i>${esc(a.doc_title || a.doc_slug)}</i></a>: ` +
          `<a href="${config.basePath}/docs/amendments/${Number(a.amendment_id)}" target="_blank" rel="noopener">${esc(a.amendment_title)}</a></li>`
      )
      .join("");
    slides.push({
      kind: "proposal",
      itemId: item.id,
      proposalId: p.id,
      title: `#${p.id}: ${p.title}`,
      decision: p.decision,
      decisions: t.decisions,
      outcome: p.outcome,
      required: t.required?.label ?? null,
      html:
        `<h2>#${p.id}: ${esc(p.title)}</h2>` +
        `<p class="slide-byline">by ${by} — <i>${t.slideLabel}</i></p>` +
        (p.special_notes ? `<p class="slide-notes">${esc(p.special_notes)}</p>` : "") +
        funding +
        (amendments ? `<ul class="slide-amendments">${amendments}</ul>` : "") +
        // The official text is always shown (the room can't click to expand);
        // skip the summary when the author pasted the same text into both.
        (p.summary.trim() === p.final_text.trim()
          ? `<div class="slide-fulltext">${render(p.final_text)}</div>`
          : `<div class="slide-summary">${render(p.summary)}</div>` +
            `<div class="slide-fulltext"><h3>Official full text</h3>${render(p.final_text)}</div>`) +
        (p.outcome || p.decision
          ? `<p class="slide-decision">` +
            (p.outcome ? `Vote: Yay <b>${p.outcome.yay}</b> · Nay <b>${p.outcome.nay}</b> (${p.outcome.required} needed)` : "") +
            (p.outcome && p.decision ? " — " : "") +
            (p.decision ? `Decision: <b>${esc(p.decision)}</b>` : "") +
            `</p>`
          : ""),
    });
  }
  slides.push({ kind: "end", title: "Adjourned", html: "<h1>Meeting Adjourned</h1><p>Thanks for coming!</p>" });
  return slides;
}

/**
 * Close the meeting. TABLED proposals go back to the open pool (as in v1),
 * and so do any the meeting never got to.
 */
export async function adjourn(meetingId: number, actor: string) {
  await db.tx(async () => {
    const carry = await db.all("SELECT id, decision FROM proposals WHERE meeting_id=$1 AND (decision='TABLED' OR decision IS NULL)", [meetingId]);
    for (const { id, decision } of carry) {
      await db.run("UPDATE proposals SET status='open', decision=NULL, meeting_id=NULL WHERE id=$1", [id]);
      await db.run("DELETE FROM agenda_items WHERE meeting_id=$1 AND proposal_id=$2", [meetingId, id]);
      await proposals.log(id, actor, decision ? "Returned to open proposals after being tabled" : "Not reached at the meeting; returned to open proposals");
    }
    await db.run("UPDATE meetings SET status='completed' WHERE id=$1", [meetingId]);
  });
}
