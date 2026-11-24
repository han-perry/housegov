import * as db from "../db";
import * as govdocs from "./govdocs";

export type ProposalType = "amendment" | "fundrequest" | "policy" | "announcement";
export type Decision = "APPROVED" | "REJECTED" | "TABLED" | "DISCUSSED" | "MOVED TO FULL FORUM";

// Procedure wording carried over verbatim from govtracker v1.
export interface TypeInfo {
  label: string;
  slideLabel: string;
  procedure: string;
  mail: string;
  decisions: Decision[];
  /** Share of Yay among Yay+Nay needed to pass; null = no vote. */
  required: { fraction: number; label: string; strict: boolean } | null;
}
const MAJORITY = { fraction: 0.5, label: "majority", strict: true };

export const TYPES: Record<ProposalType, TypeInfo> = {
  amendment: {
    label: "Constitutional Amendment",
    slideLabel: "Constitutional Amendment",
    procedure: "This proposal is a <b>constitutional amendment</b> and requires a 2/3 approval vote.",
    mail: "This proposal is a constitutional amendment and requires a 2/3 approval vote.",
    decisions: ["APPROVED", "REJECTED", "TABLED", "MOVED TO FULL FORUM"],
    required: { fraction: 2 / 3, label: "2/3", strict: false },
  },
  fundrequest: {
    label: "Funding Request",
    slideLabel: "Request for House Funds",
    procedure: "This proposal requests <b>House funds</b> in the amount of {amount} and requires a majority approval.",
    mail: "This proposal requests House funds in the amount of ${amount} and requires a majority approval.",
    decisions: ["APPROVED", "REJECTED", "TABLED", "MOVED TO FULL FORUM"],
    required: MAJORITY,
  },
  policy: {
    label: "Opinion or Policy",
    slideLabel: "Official Policy or House Opinion",
    procedure: "This proposal seeks an <b>official House opinion or policy</b> and requires a majority approval.",
    mail: "This proposal seeks an official House opinion or policy and requires a majority approval.",
    decisions: ["APPROVED", "REJECTED", "TABLED", "MOVED TO FULL FORUM"],
    required: MAJORITY,
  },
  announcement: {
    label: "Announcement (no vote)",
    slideLabel: "Announcement/Discussion",
    procedure: "This proposal is <b>only an announcement</b> and requires no approval vote.",
    mail: "This proposal is only an announcement and requires no approval vote.",
    decisions: ["DISCUSSED", "TABLED"],
    required: null,
  },
};

/**
 * Funding goes either to an existing account (raising its budget) or, when no
 * number is given, to a new account the treasurer creates. Numbers are free
 * text: letters, digits, spaces, dots, dashes, slashes.
 */
export const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-\/]{0,39}$/;

export function normalizeAccount(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  return s || null;
}

/** "existing account 1234567" / "a new account" */
export function accountPhrase(accountNumber: string | null | undefined): string {
  return accountNumber ? `existing account ${accountNumber}` : "a new account";
}

export interface ProposalRow {
  id: number;
  author: string;
  coauthors: string;
  title: string;
  type: ProposalType;
  special_notes: string;
  summary: string;
  full_text: string;
  final_text: string;
  status: "open" | "agenda" | "decided" | "dismissed";
  decision: Decision | null;
  meeting_id: number | null;
  dismissed_by: string | null;
  dismiss_reason: string | null;
  vote_yay: number | null;
  vote_nay: number | null;
  created_at: Date;
}

export interface VoteOutcome {
  yay: number;
  nay: number;
  share: number;
  required: string;
  passes: boolean;
}

/** Does a Yay/Nay count meet the proposal type's requirement? */
export function voteOutcome(type: ProposalType, yay: number | null, nay: number | null): VoteOutcome | null {
  const req = TYPES[type].required;
  if (!req || yay === null || nay === null) return null;
  const total = yay + nay;
  const share = total ? yay / total : 0;
  const passes = total > 0 && (req.strict ? share > req.fraction : share >= req.fraction - 1e-9);
  return { yay, nay, share, required: req.label, passes };
}

/** Record a meeting vote count on a proposal. */
export async function recordVote(proposalId: number, yay: number, nay: number, actor: string, how: string) {
  await db.run("UPDATE proposals SET vote_yay=$1, vote_nay=$2 WHERE id=$3", [yay, nay, proposalId]);
  await log(proposalId, actor, `${how}: Yay ${yay}, Nay ${nay}`);
}

export const isType = (t: unknown): t is ProposalType => typeof t === "string" && t in TYPES;

export async function log(proposalId: number, actor: string, message: string) {
  await db.run("INSERT INTO proposal_log(proposal_id,actor,message) VALUES ($1,$2,$3)", [proposalId, actor, message]);
}

export async function get(id: number) {
  if (!Number.isInteger(id)) return null;
  const p = await db.get<ProposalRow>("SELECT * FROM proposals WHERE id=$1", [id]);
  if (!p) return null;
  const attachments = await db.all(
    `SELECT pa.*, a.title AS amendment_title, a.doc_slug, a.status AS amendment_status, d.title AS doc_title
     FROM proposal_attachments pa LEFT JOIN amendments a ON a.id = pa.amendment_id LEFT JOIN docs d ON d.slug = a.doc_slug
     WHERE pa.proposal_id=$1 ORDER BY pa.id`,
    [id]
  );
  return {
    ...p,
    attachments,
    funding: attachments.find((a) => a.kind === "funding") ?? null,
    log: await db.all("SELECT * FROM proposal_log WHERE proposal_id=$1 ORDER BY id DESC", [id]),
    outcome: voteOutcome(p.type, p.vote_yay, p.vote_nay),
    meeting: p.meeting_id ? await db.get("SELECT id,title,meeting_at,status FROM meetings WHERE id=$1", [p.meeting_id]) : null,
  };
}
export type Proposal = NonNullable<Awaited<ReturnType<typeof get>>>;

export function procedureHtml(p: Proposal): string {
  const amt = p.funding ? `<b class="money">$${p.funding.final_amount}</b>` : "";
  return TYPES[p.type].procedure.replace("{amount}", amt);
}

/**
 * Record a decision. APPROVED applies attached govdoc amendments; TABLED
 * proposals return to the open pool when the meeting is adjourned.
 */
export async function decide(proposalId: number, decision: Decision, actor: string) {
  const p = await get(proposalId);
  if (!p) throw new Error("Proposal not found");
  await db.run("UPDATE proposals SET decision=$1, status=$2 WHERE id=$3", [decision, decision === "TABLED" ? "agenda" : "decided", proposalId]);
  await log(proposalId, actor, `${decision}${p.meeting ? ` at ${p.meeting.title}` : ""}`);

  const amendments = p.attachments.filter((x) => x.kind === "amendment" && x.amendment_id);
  const results: Array<{ amendmentId: number } & govdocs.ApplyResult> = [];
  if (decision === "APPROVED") {
    for (const a of amendments) {
      const r = await govdocs.applyAmendment(a.amendment_id, { actor, context: `Proposal #${p.id}` });
      results.push({ amendmentId: a.amendment_id, ...r });
      await log(
        proposalId,
        actor,
        r.ok ? `Amendment #${a.amendment_id} applied to ${a.doc_slug} (${r.sha.slice(0, 7)})` : `Amendment #${a.amendment_id} not applied: ${r.reason ?? "merge conflict with the current document; a docs manager needs to resolve it"}`
      );
    }
  } else if (decision === "REJECTED") {
    for (const a of amendments) await db.run("UPDATE amendments SET status='rejected' WHERE id=$1 AND status<>'applied'", [a.amendment_id]);
  }
  return results;
}
