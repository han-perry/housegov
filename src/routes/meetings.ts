import { Router, type Request, type Response, type NextFunction } from "express";
import QRCode from "qrcode";
import { config } from "../config";
import * as db from "../db";
import type { Row } from "../db";
import { requireLogin, requirePerm } from "../auth";
import { GOVPERMS } from "../auth/permissions";
import * as meetings from "../services/meetings";
import * as proposals from "../services/proposals";
import * as realtime from "../realtime";
import { intParam, str, wantsJson, fromLocalInput } from "./util";

const router = Router();
const manage = requirePerm(GOVPERMS.MANAGE);
const present = requirePerm([GOVPERMS.PRESENTATION, GOVPERMS.MANAGE]);
const room = (id: number) => `meeting:${id}`;

type MReq = Request & { meeting: Row };

async function load(req: Request, res: Response, next: NextFunction) {
  const m = await db.get("SELECT * FROM meetings WHERE id=$1", [intParam(req.params.id)]);
  if (!m) return res.status(404).render("error", { title: "Meeting not found", message: "That meeting doesn't exist." });
  (req as MReq).meeting = m;
  next();
}
const M = (req: Request) => (req as MReq).meeting;

function term(d: Date) {
  return `${d.getMonth() < 6 ? "Spring" : "Fall"} ${d.getFullYear()}`;
}

async function adhocTally(voteId: number) {
  const rows = await db.all("SELECT choice, COUNT(*)::int AS n FROM adhoc_responses WHERE vote_id=$1 GROUP BY choice", [voteId]);
  const t: Record<string, number> = { yay: 0, nay: 0 };
  for (const r of rows) if (r.choice in t) t[r.choice] = r.n;
  return t;
}

async function openAdhoc(meetingId: number) {
  const v = await db.get("SELECT * FROM adhoc_votes WHERE meeting_id=$1 AND status='open' ORDER BY id DESC LIMIT 1", [meetingId]);
  return v ? { ...v, tally: await adhocTally(v.id) } : null;
}

// ---- List / searchable archive ---------------------------------------------
router.get("/", async (req, res) => {
  const q = str(req.query.q);
  const past = q
    ? await db.all(
        `SELECT DISTINCT m.* FROM meetings m
         LEFT JOIN agenda_items ai ON ai.meeting_id = m.id
         LEFT JOIN proposals p ON p.id = ai.proposal_id
         WHERE m.status='completed' AND (
           to_tsvector('english', m.title || ' ' || m.minutes) @@ websearch_to_tsquery('english', $1)
           OR to_tsvector('english', coalesce(ai.title,'') || ' ' || coalesce(ai.body,'')) @@ websearch_to_tsquery('english', $1)
           OR p.search @@ websearch_to_tsquery('english', $1))
         ORDER BY m.meeting_at DESC`,
        [q]
      )
    : await db.all("SELECT * FROM meetings WHERE status='completed' ORDER BY meeting_at DESC");
  const byTerm: { term: string; meetings: Row[] }[] = [];
  for (const m of past) {
    const t = term(new Date(m.meeting_at));
    if (byTerm.at(-1)?.term !== t) byTerm.push({ term: t, meetings: [] });
    byTerm.at(-1)!.meetings.push(m);
  }
  const upcoming = await db.all("SELECT * FROM meetings WHERE status<>'completed' ORDER BY meeting_at");
  res.render("meetings/list", { title: "House Meetings", byTerm, upcoming, q });
});

// ---- Schedule --------------------------------------------------------------
router.get("/new", manage, (req, res) => res.render("meetings/form", { title: "Schedule a Meeting", m: null }));

router.post("/", manage, async (req, res) => {
  const title = str(req.body.title);
  const meetingAt = fromLocalInput(req.body.meeting_at);
  const cutoffAt = fromLocalInput(req.body.cutoff_at);
  if (!title || !meetingAt || !cutoffAt) {
    req.flash("danger", "Title, meeting time and proposal cutoff are required.");
    return res.redirect("/meetings/new");
  }
  const id = await db.tx(async () => {
    const r = await db.run("INSERT INTO meetings(title,meeting_at,cutoff_at,preface,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [
      title,
      meetingAt,
      cutoffAt,
      str(req.body.preface),
      req.user!.username,
    ]);
    const mid: number = r.rows[0].id;
    // Standing agenda sections from govtracker v1.
    const standing = ["House Chair's Announcements", "President's Announcements", "Committee Reports"];
    for (const [i, t] of standing.entries()) {
      await db.run("INSERT INTO agenda_items(meeting_id,sort,kind,title,body) VALUES ($1,$2,'block',$3,'')", [mid, i + 1, t]);
    }
    return mid;
  });
  res.redirect(`/meetings/${id}/manage`);
});

// ---- Public agenda / record ------------------------------------------------
router.get("/:id", load, async (req, res) => {
  const m = M(req);
  const items = [];
  for (const i of await meetings.agenda(m.id)) items.push(i.proposal_id ? { ...i, p: await proposals.get(i.proposal_id) } : i);
  const adhoc = [];
  for (const v of await db.all("SELECT * FROM adhoc_votes WHERE meeting_id=$1 ORDER BY id", [m.id])) adhoc.push({ ...v, tally: await adhocTally(v.id) });
  res.render("meetings/view", { title: m.title, m, items, adhoc, TYPES: proposals.TYPES });
});

// ---- Agenda management -----------------------------------------------------
router.get("/:id/manage", manage, load, async (req, res) => {
  const m = M(req);
  res.render("meetings/manage", {
    title: `Manage: ${m.title}`,
    m,
    items: await meetings.agenda(m.id),
    open: await db.all("SELECT id,title,type,author,created_at FROM proposals WHERE status='open' ORDER BY created_at"),
    TYPES: proposals.TYPES,
  });
});

router.post("/:id", manage, load, async (req, res) => {
  const m = M(req);
  await db.run("UPDATE meetings SET title=$1, meeting_at=$2, cutoff_at=$3, preface=$4 WHERE id=$5", [
    str(req.body.title) || m.title,
    fromLocalInput(req.body.meeting_at) ?? m.meeting_at,
    fromLocalInput(req.body.cutoff_at) ?? m.cutoff_at,
    str(req.body.preface),
    m.id,
  ]);
  realtime.emit(room(m.id), "agenda", {});
  req.flash("success", "Meeting updated.");
  res.redirect(`/meetings/${m.id}/manage`);
});

router.post("/:id/items", manage, load, async (req, res) => {
  const m = M(req);
  await db.run("INSERT INTO agenda_items(meeting_id,sort,kind,title,body) VALUES ($1,$2,'block',$3,$4)", [
    m.id,
    await meetings.nextSort(m.id),
    str(req.body.title) || "Untitled",
    String(req.body.body ?? ""),
  ]);
  realtime.emit(room(m.id), "agenda", {});
  res.redirect(`/meetings/${m.id}/manage`);
});

router.post("/:id/items/:itemId", manage, load, async (req, res) => {
  const m = M(req);
  await db.run("UPDATE agenda_items SET title=$1, body=$2 WHERE id=$3 AND meeting_id=$4 AND kind='block'", [
    str(req.body.title),
    String(req.body.body ?? ""),
    intParam(req.params.itemId),
    m.id,
  ]);
  realtime.emit(room(m.id), "agenda", {});
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(`/meetings/${m.id}/manage`);
});

router.post("/:id/items/:itemId/delete", manage, load, async (req, res) => {
  const m = M(req);
  const item = await db.get("SELECT * FROM agenda_items WHERE id=$1 AND meeting_id=$2", [intParam(req.params.itemId), m.id]);
  if (item) {
    await db.tx(async () => {
      await db.run("DELETE FROM agenda_items WHERE id=$1", [item.id]);
      if (item.proposal_id) {
        await db.run("UPDATE proposals SET status='open', meeting_id=NULL WHERE id=$1 AND decision IS NULL", [item.proposal_id]);
        await proposals.log(item.proposal_id, req.user!.username, `Removed from agenda for ${m.title}`);
      }
    });
  }
  realtime.emit(room(m.id), "agenda", {});
  res.redirect(`/meetings/${m.id}/manage`);
});

router.post("/:id/order", manage, load, async (req, res) => {
  const m = M(req);
  const ids: number[] = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
  await db.tx(async () => {
    for (const [i, itemId] of ids.entries()) await db.run("UPDATE agenda_items SET sort=$1 WHERE id=$2 AND meeting_id=$3", [i + 1, itemId, m.id]);
  });
  realtime.emit(room(m.id), "agenda", {});
  res.json({ ok: true });
});

// ---- Presentation ----------------------------------------------------------
router.get("/:id/state", load, async (req, res) => {
  const m = M(req);
  const slides = await meetings.buildSlides(m.id);
  // Until the meeting is started everyone sits on the title slide.
  const current = m.status === "live" ? Math.min(m.current_slide, slides.length - 1) : 0;
  res.json({ status: m.status, current, slides, adhoc: await openAdhoc(m.id), minutes: req.user?.hasPermission([GOVPERMS.PRESENTATION, GOVPERMS.MANAGE]) ? m.minutes : undefined });
});

router.get("/:id/qr.svg", load, async (req, res) => {
  const svg = await QRCode.toString(`${config.baseUrl}/meetings/${M(req).id}/live`, { type: "svg", margin: 1 });
  res.type("image/svg+xml").send(svg);
});

// Projector view: public, follows the console.
router.get("/:id/slides", load, (req, res) => {
  const shortLive = `${new URL(config.baseUrl).host}${config.basePath}/live`;
  res.render("meetings/slides", { title: M(req).title, m: M(req), liveUrl: `${config.baseUrl}/meetings/${M(req).id}/live`, shortLive });
});

// Mobile live view: current slide + ad hoc "clicker" voting.
router.get("/:id/live", load, (req, res) => res.render("meetings/live", { title: M(req).title, m: M(req) }));

router.get("/:id/console", present, load, (req, res) => res.render("meetings/console", { title: `Console: ${M(req).title}`, m: M(req) }));

// Opening the console or projector never starts a meeting: the presenter
// presses "Start meeting". Before that, the console can click through slides
// locally (rehearsal) without moving anyone else's screen.
const NOT_LIVE = "The meeting hasn't started. Press Start meeting first.";

router.post("/:id/start", present, load, async (req, res) => {
  const m = M(req);
  if (m.status === "completed") return res.status(409).json({ error: "This meeting was already adjourned." });
  if (m.status !== "live") await db.run("UPDATE meetings SET status='live', current_slide=0 WHERE id=$1", [m.id]);
  realtime.emit(room(m.id), "status", { status: "live" });
  realtime.emit(room(m.id), "slide", { index: 0 });
  res.json({ ok: true, status: "live" });
});

// Undo an accidental start: back to scheduled, any open vote is closed.
router.post("/:id/unstart", present, load, async (req, res) => {
  const m = M(req);
  if (m.status !== "live") return res.status(409).json({ error: "The meeting isn't live." });
  await db.run("UPDATE meetings SET status='scheduled', current_slide=0 WHERE id=$1", [m.id]);
  await db.run("UPDATE adhoc_votes SET status='closed' WHERE meeting_id=$1 AND status='open'", [m.id]);
  realtime.emit(room(m.id), "adhoc", null);
  realtime.emit(room(m.id), "status", { status: "scheduled" });
  realtime.emit(room(m.id), "slide", { index: 0 });
  res.json({ ok: true, status: "scheduled" });
});

router.post("/:id/slide", present, load, async (req, res) => {
  const m = M(req);
  if (m.status !== "live") return res.status(409).json({ error: NOT_LIVE });
  const slides = await meetings.buildSlides(m.id);
  const index = Math.max(0, Math.min(intParam(req.body.index) || 0, slides.length - 1));
  await db.run("UPDATE meetings SET current_slide=$1 WHERE id=$2", [index, m.id]);
  realtime.emit(room(m.id), "slide", { index });
  res.json({ ok: true, index });
});

// Scroll a long slide on every projector by one step (or back to the top). Not persisted.
router.post("/:id/scroll", present, load, (req, res) => {
  if (M(req).status !== "live") return res.status(409).json({ error: NOT_LIVE });
  const step = req.body.step === "top" ? "top" : Math.sign(Number(req.body.step) || 0);
  realtime.emit(room(M(req).id), "scroll", { index: intParam(req.body.index), step });
  res.json({ ok: true });
});

router.post("/:id/minutes", present, load, async (req, res) => {
  const m = M(req);
  const minutes = String(req.body.minutes ?? "");
  await db.run("UPDATE meetings SET minutes=$1 WHERE id=$2", [minutes, m.id]);
  realtime.emit(room(m.id), "minutes", { minutes, by: req.user!.username, clientId: req.body.clientId });
  res.json({ ok: true });
});

router.post("/:id/adjourn", present, load, async (req, res) => {
  const m = M(req);
  await meetings.adjourn(m.id, req.user!.username);
  realtime.emit(room(m.id), "adjourned", {});
  req.flash("success", "Meeting adjourned. Tabled proposals went back to the open pool.");
  res.redirect(`/meetings/${m.id}`);
});

// ---- Ad hoc votes ----------------------------------------------------------
router.post("/:id/adhoc", present, load, async (req, res) => {
  const m = M(req);
  if (m.status !== "live") return res.status(409).json({ error: NOT_LIVE });
  await db.run("UPDATE adhoc_votes SET status='closed' WHERE meeting_id=$1 AND status='open'", [m.id]);
  // A vote can be called on a proposal on this meeting's agenda; its counts
  // are then recorded on the proposal when the vote closes.
  const p = req.body.proposal_id ? await db.get("SELECT id,title FROM proposals WHERE id=$1 AND meeting_id=$2", [intParam(req.body.proposal_id), m.id]) : null;
  const question = str(req.body.question) || (p ? `#${p.id}: ${p.title}` : "Motion on the floor");
  await db.run("INSERT INTO adhoc_votes(meeting_id,question,proposal_id) VALUES ($1,$2,$3)", [m.id, question, p?.id ?? null]);
  const adhoc = await openAdhoc(m.id);
  realtime.emit(room(m.id), "adhoc", adhoc);
  res.json({ ok: true, adhoc });
});

router.post("/:id/adhoc/:voteId/close", present, load, async (req, res) => {
  const m = M(req);
  const v = await db.get("SELECT * FROM adhoc_votes WHERE id=$1 AND meeting_id=$2", [intParam(req.params.voteId), m.id]);
  if (!v) return res.status(404).json({ error: "No such vote" });
  await db.run("UPDATE adhoc_votes SET status='closed' WHERE id=$1", [v.id]);
  const t = await adhocTally(v.id);
  // Record the result in the minutes.
  if (v.proposal_id) {
    await proposals.recordVote(v.proposal_id, t.yay, t.nay, req.user!.username, `Vote at ${m.title}`);
    realtime.emit(room(m.id), "agenda", {});
  }
  const line = `\n\n> **${v.proposal_id ? "Vote" : "Ad hoc vote"}:** ${v.question} — Yay ${t.yay}, Nay ${t.nay}\n`;
  const r = await db.run("UPDATE meetings SET minutes = minutes || $1 WHERE id=$2 RETURNING minutes", [line, m.id]);
  realtime.emit(room(m.id), "adhoc", null);
  realtime.emit(room(m.id), "minutes", { minutes: r.rows[0].minutes, by: req.user!.username });
  res.json({ ok: true, tally: t });
});

router.post("/:id/adhoc/:voteId/respond", requireLogin, load, async (req, res) => {
  const m = M(req);
  if (!req.user!.hasPermission(GOVPERMS.VOTE)) return res.status(403).json({ error: "You aren't eligible to vote." });
  const v = await db.get("SELECT * FROM adhoc_votes WHERE id=$1 AND meeting_id=$2 AND status='open'", [intParam(req.params.voteId), m.id]);
  const choice = str(req.body.choice);
  if (!v || !["yay", "nay"].includes(choice)) return res.status(400).json({ error: "Voting is closed." });
  await db.run(
    "INSERT INTO adhoc_responses(vote_id,username,choice) VALUES ($1,$2,$3) ON CONFLICT (vote_id,username) DO UPDATE SET choice=EXCLUDED.choice",
    [v.id, req.user!.username, choice]
  );
  realtime.emit(room(m.id), "adhoc", { ...v, tally: await adhocTally(v.id) });
  res.json({ ok: true, choice });
});

export default router;
