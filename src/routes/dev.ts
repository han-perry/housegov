/** Dev-only tools: switch user / permissions, read the mail outbox. Disabled when DEV_AUTH=0. */
import { Router } from "express";
import * as db from "../db";
import { ALL_PERMS } from "../auth/permissions";
import { str } from "./util";

const router = Router();

router.get("/", (req, res) => {
  res.render("dev", { title: "Dev tools", allPerms: ALL_PERMS, current: req.user });
});

router.post("/login", (req, res) => {
  req.session.devLoggedOut = false;
  req.session.devUser = str(req.body.username).toLowerCase() || "perryh";
  req.session.devPerms = ([] as unknown[]).concat(req.body.perms || []).map(String).filter((p) => (ALL_PERMS as string[]).includes(p));
  req.flash("success", `Now signed in as ${req.session.devUser}.`);
  res.redirect("/dev");
});

router.post("/logout", (req, res) => {
  req.session.devLoggedOut = true;
  res.redirect("/");
});

router.get("/outbox", async (req, res) => {
  res.render("outbox", { title: "Mail outbox", mails: await db.all("SELECT * FROM outbox ORDER BY id DESC LIMIT 100") });
});

export default router;
