import path from "node:path";

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);

/**
 * The app can live under a sub-path behind a path-routing proxy, e.g.
 * BASE_URL=https://example.org/housegov. The path part ("/housegov") is the
 * base path; BASE_PATH overrides it. The proxy must pass the full path through
 * (don't strip the prefix).
 */
const rawBaseUrl = new URL(process.env.BASE_URL || `http://localhost:${port}`);
const basePath = (process.env.BASE_PATH ?? rawBaseUrl.pathname).replace(/\/+$/, "").replace(/^(?=[^/])/, "/");
if (basePath && !/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath)) throw new Error(`Invalid base path: ${basePath}`);

/** Prefix a root-relative path ("/proposals") with the base path, once. */
export function withBase(p: string): string {
  if (!basePath || !p.startsWith("/") || p.startsWith("//")) return p;
  return p === basePath || p.startsWith(basePath + "/") || p.startsWith(basePath + "?") ? p : basePath + p;
}

export const config = {
  root,
  port,
  /** Absolute URL of the app including the base path, no trailing slash (emails, QR codes, embeds). */
  baseUrl: rawBaseUrl.origin + basePath,
  /** "" at the root, or e.g. "/housegov". */
  basePath,
  databaseUrl: process.env.DATABASE_URL || "postgres://housegov:housegov@localhost:5432/housegov_dev",
  // Git repositories for GovDocs live here (a Docker volume in production).
  dataDir: process.env.DATA_DIR || path.join(root, "data"),
  sessionSecret: process.env.SESSION_SECRET || "dev-only-change-me",

  // Dev auth logs everyone in as this user with every permission (switchable
  // at /dev). Replace with the membrane / @simmons-tech/auth OIDC connector.
  devAuth: process.env.DEV_AUTH !== "0",
  devDefaultUser: process.env.DEV_USER || "perryh",

  proposals: {
    summaryWordLimit: Number(process.env.SUMMARY_WORD_LIMIT || 150),
    pageSize: 20,
    mailTo: process.env.PROPOSALS_MAIL_TO || "proposals@simmons.mit.edu",
    mailFrom: '"GovTracker Automated E-mails" <govtracker-proposals@simmons.mit.edu>',
  },

  // When SMTP_URL is unset, mail goes to the `outbox` table (viewable at /dev/outbox).
  smtpUrl: process.env.SMTP_URL || null,
  mailDomain: process.env.MAIL_DOMAIN || "mit.edu",

  // Optional one-way Discord feed. Point at a forum-channel webhook and each
  // new proposal/poll becomes its own thread.
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
};
