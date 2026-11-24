import { Router, type Request } from "express";
import { config } from "../config";
import * as db from "../db";
import { requirePerm } from "../auth";
import { GOVPERMS } from "../auth/permissions";
import * as proposals from "../services/proposals";
import * as meetings from "../services/meetings";
import * as govdocs from "../services/govdocs";
import * as amendmentClaims from "../services/amendments";
import { wordCount } from "../services/markdown";
import * as mail from "../services/mail";
import * as discord from "../services/discord";
import * as realtime from "../realtime";
import { MONEY_RE, intParam, str, safeReturn, back, wantsJson } from "./util";

const router = Router();
const manage = requirePerm(GOVPERMS.MANAGE);
const manageOrPresent = requirePerm([GOVPERMS.MANAGE, GOVPERMS.PRESENTATION]);

// ---- List / search (public, paginated) -------------------------------------
router.get("/", async (req, res) => {
  const q = str(req.query.q);
  const status = str(req.query.status) || "all";
  const type = str(req.query.type);
  const page = Math.max(1, intParam(req.query.page) || 1);
  const size = config.proposals.pageSize;

  const idMatch = /^#?(\d+)$/.exec(q);
  if (idMatch) return res.redirect(`/proposals/${idMatch[1]}`);

  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (q) where.push(`search @@ websearch_to_tsquery('english', ${p(q)})`);
  if (status !== "all") where.push(`status = ${p(status)}`);
  if (proposals.isType(type)) where.push(`type = ${p(type)}`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = q ? `ORDER BY ts_rank(search, websearch_to_tsquery('english', $1)) DESC, created_at DESC` : "ORDER BY created_at DESC";

  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM proposals ${whereSql}`, params))?.n ?? 0);
  const rows = await db.all(
    `SELECT id,title,type,author,coauthors,summary,status,decision,created_at,meeting_id
     FROM proposals ${whereSql} ${order} LIMIT ${p(size)} OFFSET ${p((page - 1) * size)}`,
    params
  );
  res.render("proposals/list", { title: "Proposals", rows, q, status, type, page, pages: Math.max(1, Math.ceil(total / size)), total, TYPES: proposals.TYPES });
});

// ---- Submit ----------------------------------------------------------------
interface FormValues {
  coauthors?: string;
  title?: string;
  type?: string;
  amount?: string;
  account?: string;
  special_notes?: string;
  summary?: string;
  full_text?: string;
  amendments: string[];
}

async function formLocals(req: Request, values: FormValues, errors: string[] = []) {
  return {
    title: "Submit Proposal",
    values,
    errors,
    drafts: await db.all(
      `SELECT a.id,a.title,a.doc_slug,d.title AS doc_title FROM amendments a JOIN docs d ON d.slug=a.doc_slug
       WHERE a.author=$1 AND a.status='draft' ORDER BY a.updated_at DESC`,
      [req.user!.username]
    ),
    TYPES: proposals.TYPES,
    consideration: await meetings.considerationFor(new Date()),
    wordLimit: config.proposals.summaryWordLimit,
  };
}

router.get("/new", requirePerm(GOVPERMS.PROPOSE), async (req, res) => {
  const amendment = str(req.query.amendment);
  const values: FormValues = { type: amendment ? "amendment" : "fundrequest", amendments: amendment ? [amendment] : [] };
  res.render("proposals/new", await formLocals(req, values));
});

router.post("/", requirePerm(GOVPERMS.PROPOSE), async (req, res) => {
  const b = req.body;
  const user = req.user!;
  const v: FormValues = {
    coauthors: str(b.coauthors),
    title: str(b.title),
    type: str(b.type),
    amount: str(b.amount).replace(/^\$/, ""),
    account: proposals.normalizeAccount(b.account) ?? "",
    special_notes: str(b.special_notes),
    summary: str(b.summary),
    full_text: str(b.full_text),
    amendments: ([] as unknown[]).concat(b.amendments || []).map(String),
  };
  const errors: string[] = [];
  if (!v.title) errors.push("Please supply a title");
  if (!proposals.isType(v.type)) errors.push("Invalid proposal type");
  if (v.type === "fundrequest") {
    if (!v.amount) errors.push("Fund requests must specify an amount");
    else if (!MONEY_RE.test(v.amount)) errors.push("Funding amount does not look like a monetary amount");
    if (v.account && !proposals.ACCOUNT_RE.test(v.account)) errors.push("The account number can only contain letters, digits, spaces, dots, dashes and slashes (or leave it blank for a new account).");
  }
  if (!v.summary) errors.push("Please supply a summary");
  const words = wordCount(v.summary);
  if (words > config.proposals.summaryWordLimit) errors.push(`The unofficial summary is ${words} words; the limit is ${config.proposals.summaryWordLimit}.`);
  if (!v.full_text) errors.push("Please supply proposal text");
  if (errors.length || !proposals.isType(v.type)) return res.status(400).render("proposals/new", await formLocals(req, v, errors));
  const type = v.type;

  const myDrafts = await db.all("SELECT * FROM amendments WHERE author=$1 AND status='draft'", [user.username]);
  const attach = myDrafts.filter((a) => v.amendments.includes(String(a.id)));
  // Freeze each amendment's patch (diff against its base) before the transaction.
  const patches = new Map<number, string>();
  for (const a of attach) patches.set(a.id, govdocs.unifiedDiff(await govdocs.read(a.doc_slug, a.base_commit), a.content, `${a.doc_slug}.md`));

  let id: number;
  try {
    id = await db.tx(async () => {
      const r = await db.run(
        `INSERT INTO proposals(author,coauthors,title,type,special_notes,summary,full_text,final_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
        [user.username, v.coauthors, v.title, type, v.special_notes, v.summary, v.full_text]
      );
      const pid: number = r.rows[0].id;
      if (type === "fundrequest") {
        await db.run("INSERT INTO proposal_attachments(proposal_id,kind,amount,final_amount,account_number) VALUES ($1,'funding',$2,$2,$3)", [pid, v.amount, v.account || null]);
      }
      for (const a of attach) {
        // Re-check inside the transaction: a double submit must not attach one draft twice.
        const locked = await db.run("UPDATE amendments SET status='submitted', patch=$1, updated_at=now() WHERE id=$2 AND status='draft'", [patches.get(a.id), a.id]);
        if (!locked.rowCount) throw new amendmentClaims.AmendmentUnavailableError(`"${a.title}" was just attached to another proposal or poll.`);
        await db.run("INSERT INTO proposal_attachments(proposal_id,kind,amendment_id) VALUES ($1,'amendment',$2)", [pid, a.id]);
      }
      await proposals.log(pid, user.username, "Submitted");
      return pid;
    });
  } catch (e) {
    if (!(e instanceof amendmentClaims.AmendmentUnavailableError)) throw e;
    return res.status(409).render("proposals/new", await formLocals(req, v, [e.message]));
  }

  // Notify. The email links to the full text instead of inlining it.
  const t = proposals.TYPES[type];
  const authorLine = v.coauthors ? `${user.username} (with ${v.coauthors})` : user.username;
  const url = `${config.baseUrl}/proposals/${id}`;
  const body = [
    `${authorLine} has created a new proposal: ${v.title}`,
    "",
    t.mail.replace("{amount}", v.amount || ""),
    ...(type === "fundrequest" ? [`Funds go to ${proposals.accountPhrase(v.account || null)}.`] : []),
    "",
    "Special procedural notes:",
    v.special_notes || "none",
    "",
    "Unofficial Summary:",
    v.summary,
    "",
    `Read the official full text: ${url}`,
    "",
    "------------------------------------------------------------",
    "This is an Automatic E-mail",
    " - do not reply to this address (use a Simmons discussion list instead)",
  ].join("\n");
  await mail.send({ to: config.proposals.mailTo, subject: `Proposed: ${v.title} by ${user.username}`, text: body });
  void discord.announce({ threadName: `#${id}: ${v.title}`, content: `**${v.title}** — ${t.label} by ${authorLine}\n${url}` });

  req.flash("success", "Your proposal submission has been received.");
  res.redirect(`/proposals/${id}`);
});

// ---- View ------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  const p = await proposals.get(intParam(req.params.id));
  if (!p) return res.status(404).render("error", { title: "Proposal not found", message: `There is no proposal #${req.params.id}.` });
  res.render("proposals/view", {
    title: `Proposal #${p.id}`,
    p,
    TYPES: proposals.TYPES,
    procedureHtml: proposals.procedureHtml(p),
    upcoming: await meetings.upcoming(),
  });
});

// ---- House Chair tools -----------------------------------------------------
router.get("/:id/edit", manageOrPresent, async (req, res) => {
  const p = await proposals.get(intParam(req.params.id));
  if (!p) return res.redirect("/proposals");
  res.render("proposals/edit", {
    title: `Edit Proposal #${p.id}`,
    p,
    wordLimit: config.proposals.summaryWordLimit,
    returnTo: safeReturn(req.query.return, `/proposals/${p.id}`),
  });
});

router.post("/:id/edit", manageOrPresent, async (req, res) => {
  const p = await proposals.get(intParam(req.params.id));
  if (!p) return res.redirect("/proposals");
  const user = req.user!;
  const text = str(req.body.final_text);
  const summary = str(req.body.summary);
  const editUrl = `/proposals/${p.id}/edit?return=${encodeURIComponent(safeReturn(req.body.return, `/proposals/${p.id}`))}`;
  if (summary && summary !== p.summary) {
    const words = wordCount(summary);
    if (words > config.proposals.summaryWordLimit) {
      req.flash("danger", `The unofficial summary is ${words} words; the limit is ${config.proposals.summaryWordLimit}. Nothing was saved.`);
      return res.redirect(editUrl);
    }
  }
  const amount = str(req.body.final_amount).replace(/^\$/, "");
  const account = proposals.normalizeAccount(req.body.account_number);
  if (p.funding && account && !proposals.ACCOUNT_RE.test(account)) {
    req.flash("danger", "The account number can only contain letters, digits, spaces, dots, dashes and slashes (or leave it blank for a new account).");
    return res.redirect(editUrl);
  }
  if (p.funding && amount && Number(amount) !== Number(p.funding.final_amount)) {
    if (!MONEY_RE.test(amount)) {
      req.flash("danger", "Funding amount does not look like a monetary amount");
      return res.redirect(editUrl);
    }
    await db.run("UPDATE proposal_attachments SET final_amount=$1 WHERE id=$2", [amount, p.funding.id]);
    await proposals.log(p.id, user.username, `Funding amended from $${p.funding.final_amount} to $${amount}`);
  }
  if (p.funding && "account_number" in req.body && account !== (p.funding.account_number ?? null)) {
    await db.run("UPDATE proposal_attachments SET account_number=$1 WHERE id=$2", [account, p.funding.id]);
    await proposals.log(p.id, user.username, `Funding account changed from ${proposals.accountPhrase(p.funding.account_number)} to ${proposals.accountPhrase(account)}`);
  }
  if (summary && summary !== p.summary) {
    await db.run("UPDATE proposals SET summary=$1 WHERE id=$2", [summary, p.id]);
    await proposals.log(p.id, user.username, "Unofficial summary edited");
  }
  if (text && text !== p.final_text) {
    await db.run("UPDATE proposals SET final_text=$1 WHERE id=$2", [text, p.id]);
    await proposals.log(p.id, user.username, "Full text amended");
  }
  if (p.meeting_id) realtime.emit(`meeting:${p.meeting_id}`, "agenda", {});
  req.flash("success", "Proposal updated.");
  res.redirect(safeReturn(req.body.return, `/proposals/${p.id}`));
});

router.post("/:id/agenda", manage, async (req, res) => {
  const p = await proposals.get(intParam(req.params.id));
  const m = await meetings.upcoming();
  if (!p || !m) {
    req.flash("danger", "There's no upcoming meeting to add this proposal to. Schedule one first.");
    return res.redirect(back(req, "/proposals"));
  }
  await db.tx(async () => {
    await db.run("UPDATE proposals SET status='agenda', meeting_id=$1 WHERE id=$2", [m.id, p.id]);
    if (!(await db.get("SELECT 1 FROM agenda_items WHERE meeting_id=$1 AND proposal_id=$2", [m.id, p.id]))) {
      await db.run("INSERT INTO agenda_items(meeting_id,sort,kind,proposal_id) VALUES ($1,$2,'proposal',$3)", [m.id, await meetings.nextSort(m.id), p.id]);
    }
    await proposals.log(p.id, req.user!.username, `Added to agenda for ${m.title}`);
  });
  realtime.emit(`meeting:${m.id}`, "agenda", {});
  req.flash("success", `Added #${p.id} to ${m.title}.`);
  res.redirect(back(req, `/proposals/${p.id}`));
});

router.post("/:id/decision", manageOrPresent, async (req, res) => {
  const p = await proposals.get(intParam(req.params.id));
  const decision = str(req.body.decision) as proposals.Decision;
  if (!p || !proposals.TYPES[p.type].decisions.includes(decision)) return res.status(400).json({ error: "Invalid decision" });
  const results = await proposals.decide(p.id, decision, req.user!.username);
  if (p.meeting_id) realtime.emit(`meeting:${p.meeting_id}`, "agenda", {});
  if (wantsJson(req)) return res.json({ ok: true, results });
  res.redirect(back(req, `/proposals/${p.id}`));
});

// Hand count (or correction) of the meeting vote on a proposal.
router.post("/:id/votes", manageOrPresent, async (req, res) => {
  const p = await proposals.get(intParam(req.params.id));
  const yay = Number(req.body.yay), nay = Number(req.body.nay);
  if (!p || !proposals.TYPES[p.type].required) return res.status(400).json({ error: "This proposal doesn't take a vote." });
  if (![yay, nay].every((n) => Number.isInteger(n) && n >= 0 && n < 100000)) return res.status(400).json({ error: "Counts must be whole numbers." });
  await proposals.recordVote(p.id, yay, nay, req.user!.username, "Vote count recorded");
  if (p.meeting_id) realtime.emit(`meeting:${p.meeting_id}`, "agenda", {});
  res.json({ ok: true, outcome: proposals.voteOutcome(p.type, yay, nay) });
});

router.post("/:id/dismiss", manage, async (req, res) => {
  const id = intParam(req.params.id);
  const reason = str(req.body.reason);
  if (!reason) {
    req.flash("danger", "Please give a reason for dismissing the proposal.");
    return res.redirect(`/proposals/${id}`);
  }
  await db.tx(async () => {
    await db.run("UPDATE proposals SET status='dismissed', dismissed_by=$1, dismiss_reason=$2, meeting_id=NULL WHERE id=$3", [req.user!.username, reason, id]);
    await db.run("DELETE FROM agenda_items WHERE proposal_id=$1", [id]);
    await proposals.log(id, req.user!.username, `Dismissed: ${reason}`);
  });
  req.flash("success", `Proposal #${id} dismissed. It stays in the log.`);
  res.redirect(`/proposals/${id}`);
});

router.post("/:id/restore", manage, async (req, res) => {
  const id = intParam(req.params.id);
  await db.run("UPDATE proposals SET status='open', dismissed_by=NULL, dismiss_reason=NULL WHERE id=$1 AND status='dismissed'", [id]);
  await proposals.log(id, req.user!.username, "Restored to open proposals");
  res.redirect(`/proposals/${id}`);
});

// Hard delete: removes the row entirely (offensive content / space).
router.post("/:id/delete", manage, async (req, res) => {
  const id = intParam(req.params.id);
  if (str(req.body.confirm) !== String(id)) {
    req.flash("danger", "Type the proposal number to confirm permanent deletion.");
    return res.redirect(`/proposals/${id}`);
  }
  await db.tx(async () => {
    // Attached amendments go back to being editable drafts (unless a poll still holds them).
    const held = await db.all("SELECT amendment_id FROM proposal_attachments WHERE proposal_id=$1 AND amendment_id IS NOT NULL", [id]);
    await db.run("DELETE FROM proposals WHERE id=$1", [id]);
    for (const { amendment_id } of held) await amendmentClaims.releaseIfUnclaimed(amendment_id);
  });
  console.log(`[audit] proposal #${id} permanently deleted by ${req.user!.username}`);
  req.flash("success", `Proposal #${id} was permanently deleted.`);
  res.redirect("/proposals");
});

export default router;
