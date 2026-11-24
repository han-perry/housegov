import { Router } from "express";
import * as db from "../db";
import * as meetings from "../services/meetings";

const router = Router();

router.get("/", async (req, res) => {
  const next = await meetings.upcoming();
  const prev = await meetings.previous();
  res.render("home", {
    title: "HouseGov",
    next,
    // The progress bar runs from the previous meeting (or when this one was scheduled) to this one.
    countdownStart: prev ? prev.meeting_at : next?.created_at,
    openPolls: await db.all("SELECT * FROM polls WHERE opens_at <= now() AND closes_at > now() ORDER BY closes_at"),
    openProposals: await db.all("SELECT id,title,type,author,created_at FROM proposals WHERE status='open' ORDER BY created_at DESC LIMIT 8"),
    pastMeetings: await db.all("SELECT id,title,meeting_at FROM meetings WHERE status='completed' ORDER BY meeting_at DESC LIMIT 5"),
  });
});

// Short, typeable link shown on the projector: follows whichever meeting is
// live right now (or the next one, which shows "waiting to start").
router.get("/live", async (req, res) => {
  const m = (await db.get("SELECT id FROM meetings WHERE status='live' ORDER BY meeting_at DESC LIMIT 1")) ?? (await meetings.upcoming());
  if (!m) return res.status(404).render("error", { title: "No meeting right now", message: "There's no live or upcoming House meeting." });
  res.redirect(302, `/meetings/${m.id}/live`);
});

export default router;
