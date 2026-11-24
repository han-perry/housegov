import path from "node:path";
import http from "node:http";
import express, { type ErrorRequestHandler } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { config, withBase } from "./config";
import { pool, migrate } from "./db";
import * as amendmentClaims from "./services/amendments";
import { attachUser } from "./auth";
import { GOVPERMS } from "./auth/permissions";
import * as realtime from "./realtime";
import { render as renderMd, renderInline as renderMdInline } from "./services/markdown";
import * as polls from "./services/polls";
import { seedIfEmpty } from "./seed";

import home from "./routes/home";
import proposalsRouter from "./routes/proposals";
import meetingsRouter from "./routes/meetings";
import pollsRouter from "./routes/polls";
import docsRouter from "./routes/docs";
import orgchartRouter from "./routes/orgchart";
import devRouter from "./routes/dev";

export const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(config.root, "views"));
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

const PgStore = connectPg(session);
const sessionMiddleware = session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  // Own cookie name + path so other apps behind the same proxy don't collide.
  name: "housegov.sid",
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    path: config.basePath || "/",
    secure: config.baseUrl.startsWith("https://"),
    maxAge: 30 * 24 * 3600 * 1000,
  },
});
app.use(sessionMiddleware);

// Everything lives on `site`, mounted at the base path ("/" or e.g. "/housegov").
const site = express.Router();

// Root-relative redirects ("/proposals/1") get the base path added.
site.use((req, res, next) => {
  const redirect = res.redirect.bind(res) as (a: number | string, b?: string) => void;
  res.redirect = ((a: number | string, b?: string) =>
    typeof a === "number" ? redirect(a, withBase(String(b))) : redirect(withBase(a))) as typeof res.redirect;
  next();
});

// Static assets + browser builds of front-end libraries straight from node_modules.
site.use("/static", express.static(path.join(config.root, "public")));
const vendor: Record<string, string> = {
  bootstrap: "bootstrap/dist",
  "bootstrap-icons": "bootstrap-icons/font",
  reveal: "reveal.js/dist",
  chartjs: "chart.js/dist",
  diff2html: "diff2html/bundles",
  jsdiff: "diff/dist",
};
for (const [name, dir] of Object.entries(vendor)) {
  site.use(`/vendor/${name}`, express.static(path.join(config.root, "node_modules", dir)));
}

site.use(attachUser);
site.use((req, res, next) => {
  res.locals.GOVPERMS = GOVPERMS;
  res.locals.path = req.path; // relative to the base path
  res.locals.base = config.basePath;
  res.locals.url = withBase;
  // Every template uses `base`/`url` for links; a route passing its own value
  // under those names would silently break every link on the page.
  const render = res.render.bind(res) as (view: string, opts?: object, cb?: never) => void;
  res.render = ((view: string, opts?: Record<string, unknown>, cb?: never) => {
    if (opts && ("base" in opts || "url" in opts)) throw new Error(`render("${view}"): "base" and "url" are reserved template locals`);
    return render(view, opts, cb);
  }) as typeof res.render;
  // <%- icon("pencil") %> → decorative Bootstrap icon (hidden from screen readers;
  // the button's text or aria-label carries the meaning).
  res.locals.icon = (name: string) => `<i class="bi bi-${name.replace(/[^a-z0-9-]/g, "")}" aria-hidden="true"></i>`;
  res.locals.md = renderMd;
  res.locals.mdInline = renderMdInline;
  res.locals.config = config;
  res.locals.flash = req.session.flash || [];
  if (req.session.flash?.length) req.session.flash = [];
  req.flash = (type, message) => {
    req.session.flash = [...(req.session.flash || []), { type, message }];
  };
  res.locals.fmtDate = (d: Date | string | null, opts: { dateOnly?: boolean } = {}) =>
    d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: opts.dateOnly ? undefined : "short" }) : "";
  // <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm".
  res.locals.toLocalInput = (d: Date | string | null) => {
    if (!d) return "";
    const x = new Date(d);
    return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  next();
});

site.use("/", home);
site.use("/proposals", proposalsRouter);
site.use("/meetings", meetingsRouter);
site.use("/polls", pollsRouter);
site.use("/docs", docsRouter);
site.use("/orgchart", orgchartRouter);
site.get("/attributions", (_req, res) => res.render("attributions", { title: "Attributions" }));
if (config.devAuth) site.use("/dev", devRouter);

site.use((req, res) => res.status(404).render("error", { title: "Not found", message: "That page doesn't exist." }));
app.use(config.basePath || "/", site);
// Outside the base path (only reachable when hitting the app directly).
if (config.basePath) app.get("/", (req, res) => res.redirect(config.basePath + "/"));
app.use((req, res) => res.status(404).type("text").send("Not found"));
const onError: ErrorRequestHandler = (err, req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  const message = err.expose ? err.message : "An unexpected error occurred.";
  // JSON callers get JSON. Errors raised before the site middleware (e.g. a
  // malformed request body) have no template locals, so they get plain text.
  if (req.accepts(["html", "json"]) === "json") return res.status(status).json({ error: message });
  if (res.locals.base === undefined) return res.status(status).type("text").send(message);
  res.status(status).render("error", { title: "Something went wrong", message });
};
app.use(onError);

export const server = http.createServer(app);
realtime.init(server, sessionMiddleware);

async function main() {
  await migrate();
  await amendmentClaims.purgeEmptyDrafts();
  setInterval(() => amendmentClaims.purgeEmptyDrafts().catch((e) => console.error("[amendments] purge failed", e)), 3600_000).unref();
  await seedIfEmpty();
  // Apply amendments / lock results for polls whose deadline has passed.
  setInterval(() => void polls.finalizeDue(), 30_000).unref();
  await polls.finalizeDue();
  server.listen(config.port, () => console.log(`HouseGov listening on ${config.baseUrl}`));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
