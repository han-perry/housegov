/**
 * Who holds an amendment. An amendment belongs to at most one live proposal
 * or one poll question. The one exception: a proposal MOVED TO FULL FORUM
 * hands its amendment to the poll question that decides it. Partial unique
 * indexes in schema.sql back this up against races.
 */
import * as db from "../db";
import * as govdocs from "./govdocs";

const HANDED_TO_FORUM = "MOVED TO FULL FORUM";

export class AmendmentUnavailableError extends Error {}

/** Amendments this poll's questions can carry (including the ones they already have). */
export function pollChoices(pollId: number | null) {
  return db.all(
    `SELECT a.id, a.title, a.doc_slug, a.status, d.title AS doc_title FROM amendments a JOIN docs d ON d.slug = a.doc_slug
     WHERE EXISTS (SELECT 1 FROM poll_questions q WHERE q.amendment_id = a.id AND q.poll_id = $1) OR (
       a.status IN ('draft','submitted','conflict')
       AND NOT EXISTS (SELECT 1 FROM poll_questions q WHERE q.amendment_id = a.id AND q.poll_id IS DISTINCT FROM $1)
       AND NOT EXISTS (SELECT 1 FROM proposal_attachments pa JOIN proposals pr ON pr.id = pa.proposal_id
                       WHERE pa.amendment_id = a.id AND pr.decision IS DISTINCT FROM '${HANDED_TO_FORUM}'))
     ORDER BY a.id DESC`,
    [pollId]
  );
}

/** Why this poll can't take the amendment, or null if it can. */
export async function pollClaimError(amendmentId: number, pollId: number | null): Promise<string | null> {
  const a = await db.get("SELECT id, status FROM amendments WHERE id=$1", [amendmentId]);
  if (!a) return "That amendment doesn't exist.";
  const otherPoll = await db.get(
    "SELECT p.id, p.title FROM poll_questions q JOIN polls p ON p.id = q.poll_id WHERE q.amendment_id=$1 AND p.id IS DISTINCT FROM $2",
    [amendmentId, pollId]
  );
  if (otherPoll) return `Amendment #${amendmentId} is already on poll #${otherPoll.id} (${otherPoll.title}).`;
  const proposal = await db.get(
    `SELECT pr.id FROM proposal_attachments pa JOIN proposals pr ON pr.id = pa.proposal_id
     WHERE pa.amendment_id=$1 AND pr.decision IS DISTINCT FROM '${HANDED_TO_FORUM}'`,
    [amendmentId]
  );
  if (proposal) return `Amendment #${amendmentId} is attached to proposal #${proposal.id}. Move that proposal to full forum first.`;
  if (!["draft", "submitted", "conflict"].includes(a.status)) return `Amendment #${amendmentId} has already been ${a.status}.`;
  return null;
}

/** Lock a draft once something will vote on it, freezing its patch. */
export async function lock(amendmentId: number) {
  const a = await db.get("SELECT * FROM amendments WHERE id=$1", [amendmentId]);
  if (!a || a.status !== "draft") return;
  const patch = govdocs.unifiedDiff(await govdocs.read(a.doc_slug, a.base_commit), a.content, `${a.doc_slug}.md`);
  await db.run("UPDATE amendments SET status='submitted', patch=$1, updated_at=now() WHERE id=$2 AND status='draft'", [patch, amendmentId]);
}

/** Nothing holds it any more: hand it back to its author as an editable draft. */
export async function releaseIfUnclaimed(amendmentId: number | null | undefined) {
  if (!amendmentId) return;
  await db.run(
    `UPDATE amendments SET status='draft', patch=NULL, updated_at=now()
     WHERE id=$1 AND status='submitted'
       AND NOT EXISTS (SELECT 1 FROM poll_questions WHERE amendment_id=$1)
       AND NOT EXISTS (SELECT 1 FROM proposal_attachments WHERE amendment_id=$1)`,
    [amendmentId]
  );
}
