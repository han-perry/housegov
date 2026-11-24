import path from "node:path";
import http from "node:http";
import express, { type ErrorRequestHandler } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { config } from "./config";
import { pool, migrate } from "./db";
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
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 },
});
app.use(sessionMiddleware);

// Static assets + browser builds of front-end libraries straight from node_modules.
app.use("/static", express.static(path.join(config.root, "public")));
const vendor: Record<string, string> = {
  bootstrap: "bootstrap/dist",
  reveal: "reveal.js/dist",
  chartjs: "chart.js/dist",
  diff2html: "diff2html/bundles",
  jsdiff: "diff/dist",
};
for (const [name, dir] of Object.entries(vendor)) {
  app.use(`/vendor/${name}`, express.static(path.join(config.root, "node_modules", dir)));
}

app.use(attachUser);
app.use((req, res, next) => {
  res.locals.GOVPERMS = GOVPERMS;
  res.locals.path = req.path;
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

app.use("/", home);
app.use("/proposals", proposalsRouter);
app.use("/meetings", meetingsRouter);
app.use("/polls", pollsRouter);
app.use("/docs", docsRouter);
app.use("/orgchart", orgchartRouter);
if (config.devAuth) app.use("/dev", devRouter);

app.use((req, res) => res.status(404).render("error", { title: "Not found", message: "That page doesn't exist." }));
const onError: ErrorRequestHandler = (err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).render("error", { title: "Something went wrong", message: err.expose ? err.message : "An unexpected error occurred." });
};
app.use(onError);

export const server = http.createServer(app);
realtime.init(server, sessionMiddleware);

async function main() {
  await migrate();
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
