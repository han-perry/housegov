import path from "node:path";

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);

export const config = {
  root,
  port,
  baseUrl: process.env.BASE_URL || `http://localhost:${port}`,
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
