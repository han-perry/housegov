import { Router, type Request } from "express";
import * as db from "../db";
import type { Row } from "../db";
import { requireLogin, requirePerm } from "../auth";
import { GOVPERMS, type User } from "../auth/permissions";
import * as govdocs from "../services/govdocs";
import { render } from "../services/markdown";
import * as amendmentClaims from "../services/amendments";
import { intParam, str } from "./util";

const router = Router();
const docsManage = requirePerm(GOVPERMS.DOCS_MANAGE);

async function loadDoc(slug: string) {
  if (!govdocs.SLUG_RE.test(slug)) return null;
  return db.get("SELECT * FROM docs WHERE slug=$1 AND deleted_at IS NULL", [slug]);
}

/** Drafts are editable by their author; docs managers can edit anything not yet applied. */
function canEdit(a: Row, user: User | null) {
  if (!user || a.status === "applied") return false;
  if (user.hasPermission(GOVPERMS.DOCS_MANAGE)) return true;
  return a.status === "draft" && a.author === user.username;
}

// ---- Index -----------------------------------------------------------------
router.get("/", async (req, res) => {
  const docs = await db.all("SELECT * FROM docs WHERE deleted_at IS NULL ORDER BY category, title");
  const byCategory = new Map<string, Row[]>();
  for (const d of docs) byCategory.set(d.category, [...(byCategory.get(d.category) || []), d]);
  res.render("docs/list", {
    title: "Policy Documents",
    byCategory: [...byCategory],
    myDrafts: req.user ? await db.all("SELECT * FROM amendments WHERE author=$1 AND status IN ('draft','conflict') ORDER BY updated_at DESC", [req.user.username]) : [],
    pending: await db.all("SELECT a.*, d.title AS doc_title FROM amendments a JOIN docs d ON d.slug=a.doc_slug WHERE d.deleted_at IS NULL AND a.status IN ('submitted','conflict') ORDER BY a.updated_at DESC"),
    deleted: req.user?.hasPermission(GOVPERMS.DOCS_MANAGE) ? await db.all("SELECT * FROM docs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC") : [],
  });
});

router.get("/new", docsManage, (req, res) => res.render("docs/new", { title: "New Document" }));

router.post("/", docsManage, async (req, res) => {
  const slug = str(req.body.slug).toLowerCase();
  const title = str(req.body.title);
  if (!govdocs.SLUG_RE.test(slug) || !title) {
    req.flash("danger", "A title and a URL slug (lowercase letters, digits, dashes) are required.");
    return res.redirect("/docs/new");
  }
  const archived = await db.get("SELECT title FROM docs WHERE slug=$1 AND deleted_at IS NOT NULL", [slug]);
  if (archived) {
    req.flash("danger", `"${slug}" belongs to a deleted document (${archived.title}). Restore it from the Policies page, or pick another slug.`);
    return res.redirect("/docs/new");
  }
  try {
    await govdocs.createDoc({ slug, title, category: str(req.body.category) || "Policy", content: String(req.body.content ?? `# ${title}\n`), author: req.user!.username });
  } catch (e) {
    req.flash("danger", (e as Error).message);
    return res.redirect("/docs/new");
  }
  res.redirect(`/docs/${slug}`);
});

// ---- Amendments (registered before /:slug) ---------------------------------
async function loadAmendment(req: Request) {
  const a = await db.get("SELECT a.*, d.title AS doc_title FROM amendments a JOIN docs d ON d.slug=a.doc_slug WHERE a.id=$1", [intParam(req.params.id)]);
  if (!a) return null;
  a.attachedTo = await db.get("SELECT p.id, p.title, p.decision FROM proposal_attachments pa JOIN proposals p ON p.id=pa.proposal_id WHERE pa.amendment_id=$1", [a.id]);
  a.poll = await db.get("SELECT p.id, p.title, p.finalized, q.prompt, q.options, q.config FROM poll_questions q JOIN polls p ON p.id=q.poll_id WHERE q.amendment_id=$1", [a.id]);
  return a;
}

/**
 * Manual apply is only for amendments the House already passed, i.e. to finish
 * the job after a merge conflict was resolved. It can't skip the vote.
 * (A finalized poll that rejected it would have marked it 'rejected'.)
 */
function passed(a: Row): boolean {
  if (a.status !== "submitted") return false;
  return a.attachedTo?.decision === "APPROVED" || !!a.poll?.finalized;
}

router.get("/amendments/:id", async (req, res) => {
  const a = await loadAmendment(req);
  if (!a) return res.status(404).render("error", { title: "Not found", message: "No such amendment." });
  // Not called `base`: that template local is the app's URL prefix.
  const baseText = await govdocs.read(a.doc_slug, a.base_commit);
  res.render("docs/amendment", {
    title: `Amendment #${a.id}`,
    a,
    baseText,
    docTitle: a.doc_title,
    titleHint: amendmentClaims.TITLE_HINT,
    editable: canEdit(a, req.user),
    canApply: passed(a) && !!req.user?.hasPermission(GOVPERMS.DOCS_MANAGE),
    // Nothing is waiting to vote on it, so a docs manager may apply it as a custodial change.
    canCustodial: !!req.user?.hasPermission(GOVPERMS.DOCS_MANAGE) && !a.attachedTo && !a.poll && ["draft", "submitted"].includes(a.status),
    openCustodial: req.query.custodial === "1",
    behind: (await govdocs.head(a.doc_slug)) !== a.base_commit,
    patch: a.patch || govdocs.unifiedDiff(baseText, a.content, `${a.doc_slug}.md`),
  });
});

// Autosave from the editor.
router.put("/amendments/:id", requireLogin, async (req, res) => {
  const a = await loadAmendment(req);
  if (!a || !canEdit(a, req.user)) return res.status(403).json({ error: "This amendment is locked." });
  const content = govdocs.normalize(String(req.body.content ?? a.content));
  const title = typeof req.body.title === "string" ? str(req.body.title) : a.title;
  // Once submitted, a docs manager's edit (e.g. a motion to amend the wording) refreshes the frozen patch.
  const patch = a.status === "draft" ? null : govdocs.unifiedDiff(await govdocs.read(a.doc_slug, a.base_commit), content, `${a.doc_slug}.md`);
  const conflictResolved = a.status === "conflict" && !govdocs.hasConflictMarkers(content);
  await db.run("UPDATE amendments SET content=$1, title=$2, patch=COALESCE($3, patch), status=$4, updated_at=now() WHERE id=$5", [
    content,
    title,
    patch,
    conflictResolved ? "submitted" : a.status,
    a.id,
  ]);
  res.json({ ok: true, savedAt: new Date().toISOString(), status: conflictResolved ? "submitted" : a.status });
});

// Pull the latest version of the document into a draft (rebase onto HEAD).
router.post("/amendments/:id/rebase", requireLogin, async (req, res) => {
  const a = await loadAmendment(req);
  if (!a || !canEdit(a, req.user)) return res.status(403).render("error", { title: "Locked", message: "This amendment is locked." });
  const r = await govdocs.rebaseContent(a.doc_slug, a.base_commit, a.content);
  await db.run("UPDATE amendments SET content=$1, base_commit=$2, status=$3, updated_at=now() WHERE id=$4", [
    r.content,
    await govdocs.head(a.doc_slug),
    r.ok ? (a.status === "conflict" ? "submitted" : a.status) : "conflict",
    a.id,
  ]);
  req.flash(r.ok ? "success" : "warning", r.ok ? "Updated to the latest version of the document." : `Updated, with ${r.conflicts} conflict(s) to resolve. Look for <<<<<<< markers.`);
  res.redirect(`/docs/amendments/${a.id}`);
});

router.post("/amendments/:id/apply", docsManage, async (req, res) => {
  const a = await loadAmendment(req);
  if (!a) return res.redirect("/docs");
  if (!passed(a)) {
    req.flash("danger", a.status === "conflict" ? "Resolve the conflict markers first." : "Only amendments the House has approved can be applied.");
    return res.redirect(`/docs/amendments/${a.id}`);
  }
  const r = await govdocs.applyAmendment(a.id, { actor: req.user!.username, context: "applied manually" });
  req.flash(
    r.ok ? "success" : "warning",
    r.ok ? `Applied as ${r.sha.slice(0, 7)}.` : r.reason ?? "The document changed and the amendment conflicts. Resolve the markers, then apply again."
  );
  res.redirect(r.ok ? `/docs/${a.doc_slug}` : `/docs/amendments/${a.id}`);
});

/**
 * Custodial change: a docs manager applies an amendment without a vote, for
 * changes that don't need one (updating a date, fixing a typo, renumbering).
 * Only for amendments nothing is waiting to vote on; detach it from its
 * proposal first if needed. Goes through the normal 3-way apply, so a change
 * committed in the meantime is merged, never overwritten.
 */
router.post("/amendments/:id/custodial", docsManage, async (req, res) => {
  let a = await loadAmendment(req);
  if (!a) return res.redirect("/docs");
  const back = `/docs/amendments/${a.id}`;
  const reason = str(req.body.reason);
  if (!reason) {
    req.flash("danger", "Say what the custodial change is (e.g. \"Update term dates for 2027\").");
    return res.redirect(`${back}?custodial=1`);
  }
  if (a.attachedTo || a.poll) {
    req.flash("danger", a.attachedTo
      ? `This amendment is waiting on proposal #${a.attachedTo.id}. Detach it from the proposal first if it doesn't need a vote.`
      : `This amendment is waiting on poll #${a.poll.id}. Remove it from the poll question first if it doesn't need a vote.`);
    return res.redirect(back);
  }
  if (!["draft", "submitted"].includes(a.status)) {
    req.flash("danger", a.status === "conflict" ? "Resolve the conflict markers first." : `This amendment was already ${a.status}.`);
    return res.redirect(back);
  }
  // The form carries the editor's latest text so an autosave still in flight isn't lost.
  if (typeof req.body.content === "string") {
    const content = govdocs.normalize(req.body.content);
    if (govdocs.hasConflictMarkers(content)) {
      req.flash("danger", "Resolve the conflict markers first.");
      return res.redirect(back);
    }
    const title = typeof req.body.title === "string" ? str(req.body.title) : a.title;
    await db.run("UPDATE amendments SET content=$1, title=$2, updated_at=now() WHERE id=$3", [content, title, a.id]);
    a = (await loadAmendment(req))!;
  }
  if (govdocs.normalize(a.content) === govdocs.normalize(await govdocs.read(a.doc_slug, a.base_commit))) {
    req.flash("danger", "There are no changes to apply. Edit the document first.");
    return res.redirect(`${back}?custodial=1`);
  }
  const user = req.user!.username;
  // The reason names the change well enough if no title was given.
  if (amendmentClaims.isPlaceholderTitle(a.title, a.doc_title)) await db.run("UPDATE amendments SET title=$1 WHERE id=$2", [reason, a.id]);
  await db.run("UPDATE amendments SET custodial_by=$1, custodial_reason=$2 WHERE id=$3", [user, reason, a.id]);
  const r = await govdocs.applyAmendment(a.id, { actor: user, context: `custodial change, no vote: ${reason}` });
  if (!r.ok) await db.run("UPDATE amendments SET custodial_by=NULL, custodial_reason=NULL WHERE id=$1 AND status<>'applied'", [a.id]);
  console.log(`[audit] custodial change: amendment #${a.id} to ${a.doc_slug} by ${user}${r.ok ? ` (${r.sha.slice(0, 7)})` : " (not applied)"}: ${reason}`);
  req.flash(
    r.ok ? "success" : "warning",
    r.ok ? `Custodial change applied as ${r.sha.slice(0, 7)}.` : r.reason ?? "The document changed since this draft was started and the edits overlap. Resolve the markers, then apply again."
  );
  res.redirect(r.ok ? `/docs/${a.doc_slug}` : back);
});

// The editor calls this (sendBeacon) when the page is left. Only an untouched
// draft goes: unattached and identical to the document it was started from.
router.post("/amendments/:id/discard", requireLogin, async (req, res) => {
  const a = await loadAmendment(req);
  if (a && a.status === "draft" && canEdit(a, req.user) && !a.attachedTo && !a.poll && !(await amendmentClaims.hasChanges(a))) {
    await db.run("DELETE FROM amendments WHERE id=$1 AND status='draft'", [a.id]);
    return res.json({ ok: true, discarded: true });
  }
  res.json({ ok: true, discarded: false });
});

router.post("/amendments/:id/delete", requireLogin, async (req, res) => {
  const a = await loadAmendment(req);
  if (!a || !canEdit(a, req.user)) return res.status(403).render("error", { title: "Locked", message: "Submitted amendments can only be deleted by a docs manager." });
  await db.run("DELETE FROM amendments WHERE id=$1", [a.id]);
  req.flash("success", "Amendment deleted.");
  res.redirect(`/docs/${a.doc_slug}`);
});

// ---- Documents -------------------------------------------------------------
router.get("/:slug", async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).render("error", { title: "Not found", message: "No such document." });
  const rev = /^[0-9a-f]{7,40}$/.test(str(req.query.rev)) ? str(req.query.rev) : "HEAD";
  const content = await govdocs.read(doc.slug, rev);
  const hist = await govdocs.history(doc.slug);
  res.render("docs/view", {
    title: doc.title,
    doc,
    head: await govdocs.head(doc.slug),
    html: render(content),
    rev: rev === "HEAD" ? null : rev,
    lastChange: hist[0],
    amendments: await db.all("SELECT * FROM amendments WHERE doc_slug=$1 AND status IN ('submitted','conflict') ORDER BY id DESC", [doc.slug]),
  });
});

router.get("/:slug/history", async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).render("error", { title: "Not found", message: "No such document." });
  res.render("docs/history", { title: `History: ${doc.title}`, doc, commits: await govdocs.history(doc.slug) });
});

router.get("/:slug/commits/:sha", async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).render("error", { title: "Not found", message: "No such document." });
  const commits = await govdocs.history(doc.slug);
  const c = commits.find((x) => x.sha.startsWith(String(req.params.sha)));
  if (!c) return res.status(404).render("error", { title: "Not found", message: "No such version." });
  res.render("docs/commit", { title: `${doc.title} @ ${c.sha.slice(0, 7)}`, doc, c, patch: await govdocs.commitDiff(doc.slug, c.sha) });
});

/** Who may start this kind of draft: proposers, or docs managers for a custodial edit. */
function mayStart(req: Request, custodial: boolean): string | null {
  if (custodial) return req.user!.hasPermission(GOVPERMS.DOCS_MANAGE) ? null : "Only docs managers can make custodial changes.";
  return req.user!.hasPermission(GOVPERMS.PROPOSE) ? null : "You need permission to propose amendments.";
}

// A new draft. Nothing is stored until the first save that changes the document.
router.get("/:slug/amend", requirePerm([GOVPERMS.PROPOSE, GOVPERMS.DOCS_MANAGE]), async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.redirect("/docs");
  const custodial = req.query.custodial === "1";
  const denied = mayStart(req, custodial);
  if (denied) return res.status(403).render("error", { title: "Not allowed", message: denied });
  const baseText = await govdocs.read(doc.slug);
  res.render("docs/amendment", {
    title: `Amend ${doc.title}`,
    a: { id: null, doc_slug: doc.slug, doc_title: doc.title, author: req.user!.username, title: "", status: "draft", base_commit: await govdocs.head(doc.slug), content: baseText },
    baseText,
    docTitle: doc.title,
    titleHint: amendmentClaims.TITLE_HINT,
    editable: true,
    canApply: false,
    canCustodial: req.user!.hasPermission(GOVPERMS.DOCS_MANAGE),
    openCustodial: custodial,
    behind: false,
    patch: "",
  });
});

// Older pages posted here; send them to the editor.
router.post("/:slug/amend", requirePerm([GOVPERMS.PROPOSE, GOVPERMS.DOCS_MANAGE]), (req, res) => {
  res.redirect(`/docs/${encodeURIComponent(String(req.params.slug))}/amend${req.body?.custodial ? "?custodial=1" : ""}`);
});

// First save of a new draft (JSON, from the editor).
router.post("/:slug/amendments", requirePerm([GOVPERMS.PROPOSE, GOVPERMS.DOCS_MANAGE]), async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).json({ error: "No such document." });
  const denied = mayStart(req, !!req.body?.custodial);
  if (denied) return res.status(403).json({ error: denied });
  const baseCommit = str(req.body?.base_commit);
  let baseText: string;
  try {
    if (!/^[0-9a-f]{7,40}$/.test(baseCommit)) throw new Error();
    baseText = await govdocs.read(doc.slug, baseCommit);
  } catch {
    return res.status(400).json({ error: "Unknown document version. Reload the page." });
  }
  const content = govdocs.normalize(String(req.body?.content ?? ""));
  if (content === govdocs.normalize(baseText)) return res.status(400).json({ error: "Nothing has changed yet." });
  const r = await db.run("INSERT INTO amendments(doc_slug,author,title,base_commit,content) VALUES ($1,$2,$3,$4,$5) RETURNING id", [
    doc.slug,
    req.user!.username,
    str(req.body?.title),
    baseCommit,
    content,
  ]);
  res.json({ ok: true, id: r.rows[0].id, savedAt: new Date().toISOString(), status: "draft" });
});

// Embeddable, chrome-free rendering for other sites (iframe).
router.get("/:slug/embed", async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).send("Not found");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.render("docs/embed", { doc, html: render(await govdocs.read(doc.slug)) });
});

// Restore an old version as a new commit (docs managers). See govdocs.restoreVersion.
router.post("/:slug/restore-version", docsManage, async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.redirect("/docs");
  const rev = str(req.body.rev);
  const reason = str(req.body.reason);
  const back = `/docs/${doc.slug}?rev=${encodeURIComponent(rev)}#restore`;
  if (!/^[0-9a-f]{7,40}$/.test(rev) || !/^[0-9a-f]{40}$/.test(str(req.body.expected_head))) return res.redirect(`/docs/${doc.slug}/history`);
  if (!reason) {
    req.flash("danger", "Say why you're restoring this version.");
    return res.redirect(back);
  }
  const r = await govdocs.restoreVersion(doc.slug, rev, { author: req.user!.username, reason, expectedHead: str(req.body.expected_head) });
  if (!r.ok) {
    req.flash("danger", r.reason);
    return res.redirect(r.reason.startsWith("The document changed") ? `/docs/${doc.slug}/history` : back);
  }
  console.log(`[audit] ${doc.slug}: version ${rev.slice(0, 7)} restored by ${req.user!.username} as ${r.sha.slice(0, 7)}: ${reason}`);
  req.flash("success", `Restored version ${rev.slice(0, 7)} as a new version (${r.sha.slice(0, 7)}). Earlier versions are still in the history.`);
  res.redirect(`/docs/${doc.slug}`);
});

// Delete = archive: hidden from the site, history and applied amendments kept.
// Refused while a proposal or poll is waiting to apply one of its amendments.
router.post("/:slug/delete", docsManage, async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.redirect("/docs");
  if (str(req.body.confirm) !== doc.slug) {
    req.flash("danger", `Type the document's slug (${doc.slug}) to confirm.`);
    return res.redirect(`/docs/${doc.slug}#delete`);
  }
  const held = await db.all(
    `SELECT a.id, a.title FROM amendments a
      WHERE a.doc_slug=$1 AND a.status IN ('draft','submitted','conflict')
        AND (EXISTS (SELECT 1 FROM proposal_attachments pa WHERE pa.amendment_id=a.id)
          OR EXISTS (SELECT 1 FROM poll_questions q WHERE q.amendment_id=a.id))`,
    [doc.slug]
  );
  if (held.length) {
    req.flash("danger", `Can't delete: ${held.map((a) => `amendment #${a.id} (${a.title})`).join(", ")} ${held.length === 1 ? "is" : "are"} still waiting on a proposal or poll. Detach or finish ${held.length === 1 ? "it" : "them"} first.`);
    return res.redirect(`/docs/${doc.slug}`);
  }
  const drafts = await db.tx(async () => {
    const r = await db.run("DELETE FROM amendments WHERE doc_slug=$1 AND status IN ('draft','submitted','conflict')", [doc.slug]);
    await db.run("UPDATE docs SET deleted_at=now(), deleted_by=$1 WHERE slug=$2", [req.user!.username, doc.slug]);
    return r.rowCount ?? 0;
  });
  console.log(`[audit] document ${doc.slug} deleted (archived) by ${req.user!.username}; ${drafts} unattached draft(s) removed`);
  req.flash("success", `Deleted "${doc.title}"${drafts ? ` and ${drafts} unattached draft amendment${drafts === 1 ? "" : "s"}` : ""}. Its history is kept; docs managers can restore it from this page.`);
  res.redirect("/docs");
});

router.post("/:slug/undelete", docsManage, async (req, res) => {
  const slug = String(req.params.slug);
  const r = await db.run("UPDATE docs SET deleted_at=NULL, deleted_by=NULL WHERE slug=$1 AND deleted_at IS NOT NULL", [slug]);
  if (r.rowCount) {
    console.log(`[audit] document ${slug} restored by ${req.user!.username}`);
    req.flash("success", "Document restored.");
  }
  res.redirect(r.rowCount ? `/docs/${slug}` : "/docs");
});

router.get("/:slug/raw.md", async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).send("Not found");
  res.type("text/markdown; charset=utf-8").setHeader("Access-Control-Allow-Origin", "*").send(await govdocs.read(doc.slug));
});

export default router;
