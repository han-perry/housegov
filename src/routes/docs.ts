import { Router, type Request } from "express";
import * as db from "../db";
import type { Row } from "../db";
import { requireLogin, requirePerm } from "../auth";
import { GOVPERMS, type User } from "../auth/permissions";
import * as govdocs from "../services/govdocs";
import { render } from "../services/markdown";
import { intParam, str, wantsJson } from "./util";

const router = Router();
const docsManage = requirePerm(GOVPERMS.DOCS_MANAGE);

async function loadDoc(slug: string) {
  if (!govdocs.SLUG_RE.test(slug)) return null;
  return db.get("SELECT * FROM docs WHERE slug=$1", [slug]);
}

/** Drafts are editable by their author; docs managers can edit anything not yet applied. */
function canEdit(a: Row, user: User | null) {
  if (!user || a.status === "applied") return false;
  if (user.hasPermission(GOVPERMS.DOCS_MANAGE)) return true;
  return a.status === "draft" && a.author === user.username;
}

// ---- Index -----------------------------------------------------------------
router.get("/", async (req, res) => {
  const docs = await db.all("SELECT * FROM docs ORDER BY category, title");
  const byCategory = new Map<string, Row[]>();
  for (const d of docs) byCategory.set(d.category, [...(byCategory.get(d.category) || []), d]);
  res.render("docs/list", {
    title: "Policy Documents",
    byCategory: [...byCategory],
    myDrafts: req.user ? await db.all("SELECT * FROM amendments WHERE author=$1 AND status IN ('draft','conflict') ORDER BY updated_at DESC", [req.user.username]) : [],
    pending: await db.all("SELECT a.*, d.title AS doc_title FROM amendments a JOIN docs d ON d.slug=a.doc_slug WHERE a.status IN ('submitted','conflict') ORDER BY a.updated_at DESC"),
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
    editable: canEdit(a, req.user),
    canApply: passed(a) && !!req.user?.hasPermission(GOVPERMS.DOCS_MANAGE),
    behind: (await govdocs.head(a.doc_slug)) !== a.base_commit,
    patch: a.patch || govdocs.unifiedDiff(baseText, a.content, `${a.doc_slug}.md`),
  });
});

// Autosave from the editor.
router.put("/amendments/:id", requireLogin, async (req, res) => {
  const a = await loadAmendment(req);
  if (!a || !canEdit(a, req.user)) return res.status(403).json({ error: "This amendment is locked." });
  const content = govdocs.normalize(String(req.body.content ?? a.content));
  const title = str(req.body.title) || a.title;
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

router.post("/:slug/amend", requirePerm(GOVPERMS.PROPOSE), async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.redirect("/docs");
  const r = await db.run("INSERT INTO amendments(doc_slug,author,title,base_commit,content) VALUES ($1,$2,$3,$4,$5) RETURNING id", [
    doc.slug,
    req.user!.username,
    `Amend ${doc.title}`,
    await govdocs.head(doc.slug),
    await govdocs.read(doc.slug),
  ]);
  res.redirect(`/docs/amendments/${r.rows[0].id}`);
});

// Embeddable, chrome-free rendering for other sites (iframe).
router.get("/:slug/embed", async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).send("Not found");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.render("docs/embed", { doc, html: render(await govdocs.read(doc.slug)) });
});

router.get("/:slug/raw.md", async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.status(404).send("Not found");
  res.type("text/markdown; charset=utf-8").setHeader("Access-Control-Allow-Origin", "*").send(await govdocs.read(doc.slug));
});

// Docs managers can commit a direct edit (e.g. typo fixes) without the amendment process.
router.post("/:slug/edit", docsManage, async (req, res) => {
  const doc = await loadDoc(String(req.params.slug));
  if (!doc) return res.redirect("/docs");
  const sha = await govdocs.commit(doc.slug, String(req.body.content ?? ""), { author: req.user!.username, message: str(req.body.message) || "Editorial change" });
  if (wantsJson(req)) return res.json({ ok: true, sha });
  res.redirect(`/docs/${doc.slug}`);
});

export default router;
