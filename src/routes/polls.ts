/**
 * Polls: elections, referenda and full-forum votes.
 *
 * Secret-ballot edits are authenticated per request with (voteId, code) sent
 * from the browser. We deliberately do NOT keep an "unlocked" flag in the
 * server session: the session row also identifies the user, so storing the
 * vote ID there would link voter to ballot at rest.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { config } from "../config";
import * as db from "../db";
import { requireLogin, requirePerm } from "../auth";
import { GOVPERMS } from "../auth/permissions";
import * as polls from "../services/polls";
import * as amendments from "../services/amendments";
import * as ballots from "../services/ballots";
import * as mail from "../services/mail";
import * as discord from "../services/discord";
import * as realtime from "../realtime";
import type { Question } from "../services/tally";
import { intParam, str, fromLocalInput } from "./util";

const router = Router();
const manage = requirePerm(GOVPERMS.MANAGE);

type PReq = Request & { poll: polls.Poll };
const P = (req: Request) => (req as PReq).poll;

async function load(req: Request, res: Response, next: NextFunction) {
  const poll = await polls.get(intParam(req.params.id));
  if (!poll) return res.status(404).render("error", { title: "Poll not found", message: "That poll doesn't exist." });
  (req as PReq).poll = poll;
  next();
}

/** Two polls grabbing one amendment at once: the unique index stops the second. */
async function claimSafely<T>(res: Response, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code !== "23505") throw e;
    res.status(409).json({ errors: ["That amendment was just attached to another poll."] });
    return undefined;
  }
}

async function broadcastResults(pollId: number) {
  const poll = await polls.get(pollId);
  if (poll && polls.resultsVisible(poll)) realtime.emit(`poll:${pollId}`, "results", await polls.results(poll));
}

// ---- List ------------------------------------------------------------------
router.get("/", async (req, res) => {
  const rows = (await db.all("SELECT * FROM polls ORDER BY closes_at DESC")).map((p) => ({ ...p, status: polls.status(p as never) }));
  const voted = req.user ? new Set((await db.all("SELECT poll_id FROM poll_voters WHERE username=$1", [req.user.username])).map((r) => r.poll_id)) : new Set();
  res.render("polls/list", { title: "Elections & Votes", rows, voted });
});

// ---- Builder ---------------------------------------------------------------
async function builderLocals(poll: polls.Poll | null) {
  return {
    title: poll ? `Edit: ${poll.title}` : "New Poll",
    poll,
    amendments: await amendments.pollChoices(poll?.id ?? null, poll?.amendment_id ?? null),
    hasBallots: poll ? !!(await db.get("SELECT 1 FROM ballots WHERE poll_id=$1", [poll.id])) : false,
  };
}

router.get("/new", manage, async (req, res) => res.render("polls/builder", await builderLocals(null)));
router.get("/:id/edit", manage, load, async (req, res) => res.render("polls/builder", await builderLocals(P(req))));

interface BuilderPayload {
  title: string;
  description: string;
  secret: boolean;
  show_live_results: boolean;
  opens_at: string;
  closes_at: string;
  amendment_id: number | null;
  questions: Array<{ id?: number; type: Question["type"]; prompt: string; description?: string; options: Question["options"]; config: Question["config"] }>;
}

function cleanPayload(b: Partial<BuilderPayload>) {
  const errors: string[] = [];
  const title = str(b.title);
  const opens = fromLocalInput(b.opens_at);
  const closes = fromLocalInput(b.closes_at);
  if (!title) errors.push("Title is required.");
  if (!opens || !closes) errors.push("Opening and closing times are required.");
  else if (closes <= opens) errors.push("The poll must close after it opens.");
  const qs = (Array.isArray(b.questions) ? b.questions : []).map((q, i) => {
    const type = (["choice", "multi", "vote", "text"] as const).includes(q.type) ? q.type : "choice";
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => ({ id: str(o.id) || crypto.randomBytes(4).toString("hex"), label: str(o.label), statement: str(o.statement) || undefined }))
      .filter((o) => o.label);
    const threshold = q.config?.threshold === null || q.config?.threshold === undefined || String(q.config.threshold) === "" ? null : Number(q.config.threshold);
    if (!str(q.prompt)) errors.push(`Question ${i + 1} needs a prompt.`);
    if (type !== "text" && options.length < 1) errors.push(`Question ${i + 1} needs at least one option.`);
    if (threshold !== null && (Number.isNaN(threshold) || threshold < 0 || threshold > 100)) errors.push(`Question ${i + 1}: threshold must be 0–100%.`);
    return {
      id: q.id ? Number(q.id) : undefined,
      type,
      prompt: str(q.prompt),
      description: String(q.description ?? "").trim().slice(0, 10000),
      options: type === "text" ? [] : options,
      config: {
        method: type === "vote" ? (q.config?.method === "irv" ? "irv" : "pick1") : undefined,
        writeIn: (type === "vote" || type === "choice") && !!q.config?.writeIn,
        threshold,
        required: q.config?.required !== false,
      },
    };
  });
  if (!qs.length) errors.push("Add at least one question.");
  return {
    errors,
    poll: { title, description: String(b.description ?? ""), secret: !!b.secret, show_live_results: !!b.show_live_results, opens, closes, amendment_id: b.amendment_id ? Number(b.amendment_id) : null },
    questions: qs,
  };
}

async function saveQuestions(pollId: number, qs: ReturnType<typeof cleanPayload>["questions"]) {
  const keep = qs.filter((q) => q.id).map((q) => q.id);
  await db.run("DELETE FROM poll_questions WHERE poll_id=$1 AND NOT (id = ANY($2::int[]))", [pollId, keep]);
  for (const [i, q] of qs.entries()) {
    const existing = q.id && (await db.get("SELECT 1 FROM poll_questions WHERE id=$1 AND poll_id=$2", [q.id, pollId]));
    if (existing) {
      await db.run("UPDATE poll_questions SET sort=$1,type=$2,prompt=$3,options=$4,config=$5,description=$6 WHERE id=$7", [i, q.type, q.prompt, JSON.stringify(q.options), JSON.stringify(q.config), q.description, q.id]);
    } else {
      await db.run("INSERT INTO poll_questions(poll_id,sort,type,prompt,options,config,description) VALUES ($1,$2,$3,$4,$5,$6,$7)", [pollId, i, q.type, q.prompt, JSON.stringify(q.options), JSON.stringify(q.config), q.description]);
    }
  }
}

router.post("/", manage, async (req, res) => {
  const c = cleanPayload(req.body);
  if (c.poll.amendment_id) {
    const err = await amendments.pollClaimError(c.poll.amendment_id, null);
    if (err) c.errors.push(err);
  }
  if (c.errors.length) return res.status(400).json({ errors: c.errors });
  const id = await claimSafely(res, () => db.tx(async () => {
    const r = await db.run(
      `INSERT INTO polls(title,description,secret,show_live_results,opens_at,closes_at,amendment_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [c.poll.title, c.poll.description, c.poll.secret, c.poll.show_live_results, c.poll.opens, c.poll.closes, c.poll.amendment_id, req.user!.username]
    );
    await saveQuestions(r.rows[0].id, c.questions);
    if (c.poll.amendment_id) await amendments.lock(c.poll.amendment_id);
    return r.rows[0].id as number;
  }));
  if (id === undefined) return;
  void discord.announce({ threadName: `Vote: ${c.poll.title}`, content: `**${c.poll.title}** is open for voting until ${c.poll.closes!.toLocaleString()}\n${config.baseUrl}/polls/${id}` });
  res.json({ ok: true, redirect: `/polls/${id}` });
});

router.post("/:id", manage, load, async (req, res) => {
  const c = cleanPayload(req.body);
  const poll = P(req);
  const swapped = c.poll.amendment_id !== (poll.amendment_id ?? null);
  if (swapped && c.poll.amendment_id) {
    const err = await amendments.pollClaimError(c.poll.amendment_id, poll.id);
    if (err) c.errors.push(err);
  }
  if (c.errors.length) return res.status(400).json({ errors: c.errors });
  const saved = await claimSafely(res, () => db.tx(async () => {
    await db.run("UPDATE polls SET title=$1,description=$2,secret=$3,show_live_results=$4,opens_at=$5,closes_at=$6,amendment_id=$7,finalized=false WHERE id=$8", [
      c.poll.title,
      c.poll.description,
      // Secrecy can't be changed once ballots exist (it would expose or orphan them).
      (await db.get("SELECT 1 FROM ballots WHERE poll_id=$1", [poll.id])) ? poll.secret : c.poll.secret,
      c.poll.show_live_results,
      c.poll.opens,
      c.poll.closes,
      c.poll.amendment_id,
      poll.id,
    ]);
    await saveQuestions(poll.id, c.questions);
    if (swapped) {
      if (c.poll.amendment_id) await amendments.lock(c.poll.amendment_id);
      await amendments.releaseIfUnclaimed(poll.amendment_id);
    }
    return true;
  }));
  if (!saved) return;
  await broadcastResults(poll.id);
  res.json({ ok: true, redirect: `/polls/${poll.id}` });
});

router.post("/:id/close-now", manage, load, async (req, res) => {
  await db.run("UPDATE polls SET closes_at=now() WHERE id=$1", [P(req).id]);
  const poll = await polls.get(P(req).id);
  if (poll) await polls.finalize(poll);
  await broadcastResults(P(req).id);
  res.redirect(`/polls/${P(req).id}/results`);
});

router.post("/:id/delete", manage, load, async (req, res) => {
  await db.tx(async () => {
    await db.run("DELETE FROM polls WHERE id=$1", [P(req).id]);
    await amendments.releaseIfUnclaimed(P(req).amendment_id);
  });
  req.flash("success", "Poll deleted.");
  res.redirect("/polls");
});

// ---- Voting ----------------------------------------------------------------
router.get("/:id", load, async (req, res) => {
  const poll = P(req);
  const user = req.user;
  let state: "anon" | "ineligible" | "new" | "public-edit" | "secret-voted" = "anon";
  let existing = null;
  if (user && !user.hasPermission(GOVPERMS.VOTE)) state = "ineligible";
  else if (user) {
    if (!(await ballots.hasVoted(poll.id, user.username))) state = "new";
    else if (poll.secret) state = "secret-voted";
    else {
      state = "public-edit";
      existing = await ballots.publicBallotFor(poll.id, user.username);
    }
  }
  res.render("polls/vote", { title: poll.title, poll, state, existing, resultsVisible: polls.resultsVisible(poll) });
});

function openGuard(req: Request, res: Response, next: NextFunction) {
  if (P(req).status !== "open") return res.status(400).json({ error: "This poll is not open." });
  if (!req.user!.hasPermission(GOVPERMS.VOTE)) return res.status(403).json({ error: "You aren't eligible to vote." });
  next();
}

/** Secret polls: check the (voteId, code) pair from the request body. */
async function secretAuth(req: Request): Promise<string | null> {
  const voteId = str(req.body.voteId);
  return (await ballots.verifySecret(P(req).id, voteId, str(req.body.code))) ? voteId : null;
}

// Cast a first ballot, or update an existing one.
router.post("/:id/vote", requireLogin, load, openGuard, async (req, res) => {
  const poll = P(req);
  const user = req.user!;
  const { answers, errors } = polls.validateAnswers(poll, req.body.answers);
  if (errors.length) return res.status(400).json({ errors });

  if (await ballots.hasVoted(poll.id, user.username)) {
    if (poll.secret) {
      if (!str(req.body.voteId)) return res.status(409).json({ error: "You've already voted. Enter the vote ID and code from your email to change your vote." });
      const voteId = await secretAuth(req);
      if (!voteId) return res.status(403).json({ error: "Vote ID or code is incorrect." });
      await ballots.update(poll.id, voteId, answers);
    } else {
      const b = await ballots.publicBallotFor(poll.id, user.username);
      if (!b) return res.status(409).json({ error: "Couldn't find your ballot." });
      await ballots.update(poll.id, b.vote_id, answers);
    }
    await broadcastResults(poll.id);
    return res.json({ ok: true, updated: true });
  }

  try {
    const { voteId, code } = await ballots.cast(poll, user.username, answers);
    if (code) {
      await mail.send({
        to: user.email,
        subject: `Your secret ballot for "${poll.title}"`,
        text: [
          `Thanks for voting in "${poll.title}".`,
          "",
          `Vote ID: ${voteId}`,
          `Code:    ${code}`,
          "",
          "Keep these private. Together they let you view, change, or withdraw your vote until",
          `${new Date(poll.closes_at).toLocaleString()}: ${config.baseUrl}/polls/${poll.id}`,
          "",
          "Your vote ID appears on the public ledger so you can check your ballot was counted.",
          "HouseGov does not store your code. If you lose it you can't edit your vote.",
        ].join("\n"),
      });
    }
    await broadcastResults(poll.id);
    res.json({ ok: true, voteId, code, secret: poll.secret });
  } catch (e) {
    if (e instanceof ballots.AlreadyVotedError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

// Secret ballot "log in": return the ballot for a valid (voteId, code).
router.post("/:id/ballot", requireLogin, load, async (req, res) => {
  const voteId = await secretAuth(req);
  if (!voteId) return res.status(403).json({ error: "Vote ID or code is incorrect." });
  res.json({ ok: true, ballot: await ballots.get(P(req).id, voteId) });
});

router.post("/:id/withdraw", requireLogin, load, openGuard, async (req, res) => {
  const poll = P(req);
  const user = req.user!;
  if (poll.secret) {
    const voteId = await secretAuth(req);
    if (!voteId) return res.status(403).json({ error: "Vote ID or code is incorrect." });
    await ballots.withdraw(poll.id, voteId, str(req.body.code), user.username);
  } else {
    const b = await ballots.publicBallotFor(poll.id, user.username);
    if (b) await ballots.withdraw(poll.id, b.vote_id, null, user.username);
  }
  await broadcastResults(poll.id);
  res.json({ ok: true });
});

router.post("/:id/rotate", requireLogin, load, openGuard, async (req, res) => {
  const poll = P(req);
  const voteId = await secretAuth(req);
  if (!poll.secret || !voteId) return res.status(403).json({ error: "Vote ID or code is incorrect." });
  const code = await ballots.rotateCode(poll.id, voteId, str(req.body.code));
  await mail.send({
    to: req.user!.email,
    subject: `New code for your ballot in "${poll.title}"`,
    text: `Your ballot code was reset.\n\nVote ID: ${voteId}\nNew code: ${code}\n\nThe old code no longer works.`,
  });
  res.json({ ok: true, code });
});

// ---- Results & public ledger -----------------------------------------------
router.get("/:id/results", load, async (req, res) => {
  const poll = P(req);
  const visible = polls.resultsVisible(poll);
  const isManager = !!req.user?.hasPermission(GOVPERMS.MANAGE);
  res.render("polls/results", {
    title: `Results: ${poll.title}`,
    poll,
    visible,
    isManager,
    results: visible ? await polls.results(poll, { withText: isManager }) : null,
    ledger: visible ? await ballots.all(poll.id) : [],
  });
});

router.get("/:id/results.json", load, async (req, res) => {
  const poll = P(req);
  if (!polls.resultsVisible(poll)) return res.status(403).json({ error: "Results are hidden until the poll closes." });
  res.json(await polls.results(poll, { withText: !!req.user?.hasPermission(GOVPERMS.MANAGE) }));
});

router.post("/:id/ballots/:voteId/exclude", manage, load, async (req, res) => {
  await db.run("UPDATE ballots SET excluded=$1 WHERE poll_id=$2 AND vote_id=$3", [!!req.body.excluded, P(req).id, str(req.params.voteId)]);
  await broadcastResults(P(req).id);
  res.json({ ok: true });
});

export default router;
