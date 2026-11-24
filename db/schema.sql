-- HouseGov schema (idempotent; applied at startup).

CREATE TABLE IF NOT EXISTS meetings (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  preface       TEXT NOT NULL DEFAULT '',
  meeting_at    TIMESTAMPTZ NOT NULL,
  cutoff_at     TIMESTAMPTZ NOT NULL,              -- proposals submitted before this are considered
  status        TEXT NOT NULL DEFAULT 'scheduled'  -- scheduled | live | completed
                CHECK (status IN ('scheduled','live','completed')),
  current_slide INTEGER NOT NULL DEFAULT 0,
  minutes       TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meetings_minutes_search ON meetings
  USING GIN (to_tsvector('english', title || ' ' || minutes));

CREATE TABLE IF NOT EXISTS proposals (
  id              SERIAL PRIMARY KEY,
  author          TEXT NOT NULL,
  coauthors       TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('amendment','fundrequest','policy','announcement')),
  special_notes   TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL,           -- unofficial summary (word-limited), markdown
  full_text       TEXT NOT NULL,           -- original official text, never changes
  final_text      TEXT NOT NULL,           -- as amended by the House Chair / meeting
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','agenda','decided','dismissed')),
  decision        TEXT,                    -- APPROVED | REJECTED | TABLED | DISCUSSED | MOVED TO FULL FORUM
  meeting_id      INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  dismissed_by    TEXT,
  dismiss_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search          TSVECTOR GENERATED ALWAYS AS (
                    setweight(to_tsvector('english', title), 'A') ||
                    setweight(to_tsvector('english', summary), 'B') ||
                    setweight(to_tsvector('english', final_text), 'C') ||
                    to_tsvector('simple', author || ' ' || coauthors)
                  ) STORED
);
CREATE INDEX IF NOT EXISTS proposals_search ON proposals USING GIN (search);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS proposal_log (
  id          SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  message     TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GovDocs: content lives in per-document git repos; these tables index them.
CREATE TABLE IF NOT EXISTS docs (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Policy',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS amendments (
  id             SERIAL PRIMARY KEY,
  doc_slug       TEXT NOT NULL REFERENCES docs(slug) ON DELETE CASCADE,
  author         TEXT NOT NULL,
  title          TEXT NOT NULL,
  base_commit    TEXT NOT NULL,
  content        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','submitted','applied','rejected','conflict')),
  patch          TEXT,                    -- unified diff frozen at submission (the ".patch")
  applied_commit TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Attachments: funding requests and govdoc amendments.
CREATE TABLE IF NOT EXISTS proposal_attachments (
  id           SERIAL PRIMARY KEY,
  proposal_id  INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('funding','amendment')),
  amount       NUMERIC(10,2),           -- funding: requested
  final_amount NUMERIC(10,2),           -- funding: after amendment at meeting
  account_number TEXT,                  -- funding: existing account to add to; NULL = create a new account
  amendment_id INTEGER REFERENCES amendments(id) ON DELETE SET NULL
);

-- Older databases: the fixed proposal/discretionary/lounge accounts were
-- replaced by a free-form account number.
ALTER TABLE proposal_attachments ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE proposal_attachments DROP CONSTRAINT IF EXISTS proposal_attachments_account_check;

-- Agenda = ordered mix of proposals and free-form content blocks.
CREATE TABLE IF NOT EXISTS agenda_items (
  id          SERIAL PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sort        INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('proposal','block')),
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
  title       TEXT,
  body        TEXT
);

CREATE TABLE IF NOT EXISTS adhoc_votes (
  id          SERIAL PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A vote called on a proposal records its counts on the proposal when closed.
ALTER TABLE adhoc_votes ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS vote_yay INTEGER;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS vote_nay INTEGER;

CREATE TABLE IF NOT EXISTS adhoc_responses (
  vote_id   INTEGER NOT NULL REFERENCES adhoc_votes(id) ON DELETE CASCADE,
  username  TEXT NOT NULL,
  choice    TEXT NOT NULL CHECK (choice IN ('yay','nay')),
  PRIMARY KEY (vote_id, username)
);

-- Polls: elections, referenda, full-forum votes.
CREATE TABLE IF NOT EXISTS polls (
  id                 SERIAL PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  secret             BOOLEAN NOT NULL DEFAULT true,
  opens_at           TIMESTAMPTZ NOT NULL,
  closes_at          TIMESTAMPTZ NOT NULL,
  show_live_results  BOOLEAN NOT NULL DEFAULT false,
  proposal_id        INTEGER REFERENCES proposals(id) ON DELETE SET NULL,  -- moved to full forum
  amendment_id       INTEGER REFERENCES amendments(id) ON DELETE SET NULL, -- applied if it passes
  finalized          BOOLEAN NOT NULL DEFAULT false,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS poll_questions (
  id        SERIAL PRIMARY KEY,
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  sort      INTEGER NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('choice','multi','vote','text')),
  prompt    TEXT NOT NULL,
  options   JSONB NOT NULL DEFAULT '[]',  -- [{id,label,statement}]
  config    JSONB NOT NULL DEFAULT '{}'   -- {method:'pick1'|'irv', writeIn, threshold, required}
);

-- An amendment belongs to one proposal and at most one poll (the full-forum
-- handoff); see services/amendments.ts.
CREATE UNIQUE INDEX IF NOT EXISTS polls_one_per_amendment ON polls (amendment_id) WHERE amendment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS attachments_one_per_amendment ON proposal_attachments (amendment_id) WHERE amendment_id IS NOT NULL;

ALTER TABLE poll_questions ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';  -- markdown

-- A ballot is keyed by a random vote ID. For secret polls username is NULL
-- and there are no timestamps, so nothing links it to poll_voters.
CREATE TABLE IF NOT EXISTS ballots (
  vote_id   TEXT PRIMARY KEY,
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  username  TEXT,
  answers   JSONB NOT NULL,
  excluded  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ballots_poll ON ballots (poll_id);

-- Secret ballots: SHA-256(vote_id ":" code). Possessing both proves ownership.
CREATE TABLE IF NOT EXISTS ballot_keys (
  key_hash  TEXT PRIMARY KEY,
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE
);

-- Who has voted (prevents double voting), with no link to the ballot.
CREATE TABLE IF NOT EXISTS poll_voters (
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  username  TEXT NOT NULL,
  PRIMARY KEY (poll_id, username)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id         SERIAL PRIMARY KEY,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
