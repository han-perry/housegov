/**
 * Ballot storage, including the secret-ballot scheme from the spec.
 *
 *   ballots      (vote_id, poll_id, username|NULL, answers, excluded)
 *   ballot_keys  (key_hash = SHA-256(vote_id ":" code), poll_id)
 *   poll_voters  (poll_id, username)        -- "has this person voted?"
 *
 * Secret ballot: username is never stored on the ballot. The voter receives
 * (vote_id, code) by email. The server keeps only H(vote_id:code), so both are
 * needed to edit, withdraw, or rotate. vote_id is public (ledger); the code is
 * 128 random bits, so the hash can't be brute-forced from the ledger.
 *
 * Known limits (see README "Secret ballot threat model"):
 *  - The server sees username and ballot in the same request when casting.
 *    We don't log it, but a malicious operator could: this is "trust the
 *    server not to record" secrecy, not end-to-end cryptographic secrecy.
 *  - Withdrawing removes you from poll_voters so you can vote again; at that
 *    moment the server again sees both identities.
 */
import crypto from "node:crypto";
import * as db from "../db";
import type { Answer } from "./tally";

export interface BallotRow {
  vote_id: string;
  poll_id: number;
  username: string | null;
  answers: Record<string, Answer>;
  excluded: boolean;
}

const newVoteId = () => crypto.randomBytes(8).toString("hex"); // 16 hex chars, shown in the ledger
const newCode = () => crypto.randomBytes(16).toString("base64url"); // 22 chars, emailed
const keyHash = (voteId: string, code: string) => crypto.createHash("sha256").update(`${voteId}:${code}`).digest("hex");

export async function hasVoted(pollId: number, username: string): Promise<boolean> {
  return !!(await db.get("SELECT 1 FROM poll_voters WHERE poll_id=$1 AND username=$2", [pollId, username]));
}

export async function publicBallotFor(pollId: number, username: string): Promise<BallotRow | undefined> {
  return db.get<BallotRow>("SELECT * FROM ballots WHERE poll_id=$1 AND username=$2", [pollId, username]);
}

export class AlreadyVotedError extends Error {}

/** Cast a first ballot. Returns {voteId, code?}. */
export async function cast(poll: { id: number; secret: boolean }, username: string, answers: Record<string, Answer>) {
  return db.tx(async () => {
    // The PK on poll_voters is the real double-vote guard (race-safe).
    const ins = await db.run("INSERT INTO poll_voters(poll_id,username) VALUES ($1,$2) ON CONFLICT DO NOTHING", [poll.id, username]);
    if (ins.rowCount === 0) throw new AlreadyVotedError("You have already voted in this poll.");
    const voteId = newVoteId();
    if (poll.secret) {
      const code = newCode();
      await db.run("INSERT INTO ballots(vote_id,poll_id,username,answers) VALUES ($1,$2,NULL,$3)", [voteId, poll.id, JSON.stringify(answers)]);
      await db.run("INSERT INTO ballot_keys(key_hash,poll_id) VALUES ($1,$2)", [keyHash(voteId, code), poll.id]);
      return { voteId, code };
    }
    await db.run("INSERT INTO ballots(vote_id,poll_id,username,answers) VALUES ($1,$2,$3,$4)", [voteId, poll.id, username, JSON.stringify(answers)]);
    return { voteId, code: undefined };
  });
}

/** Verify a (vote_id, code) pair for a secret poll. */
export async function verifySecret(pollId: number, voteId: string, code: string): Promise<boolean> {
  const v = String(voteId || "").trim();
  const c = String(code || "").trim();
  if (!v || !c) return false;
  const k = await db.get("SELECT 1 FROM ballot_keys WHERE key_hash=$1 AND poll_id=$2", [keyHash(v, c), pollId]);
  const b = await db.get("SELECT 1 FROM ballots WHERE vote_id=$1 AND poll_id=$2", [v, pollId]);
  return !!(k && b);
}

export async function update(pollId: number, voteId: string, answers: Record<string, Answer>) {
  await db.run("UPDATE ballots SET answers=$1 WHERE vote_id=$2 AND poll_id=$3", [JSON.stringify(answers), voteId, pollId]);
}

export async function withdraw(pollId: number, voteId: string, code: string | null, username: string) {
  await db.tx(async () => {
    await db.run("DELETE FROM ballots WHERE vote_id=$1 AND poll_id=$2", [voteId, pollId]);
    if (code) await db.run("DELETE FROM ballot_keys WHERE key_hash=$1", [keyHash(voteId, code)]);
    await db.run("DELETE FROM poll_voters WHERE poll_id=$1 AND username=$2", [pollId, username]);
  });
}

/** Replace a compromised code. Caller must already have verified the old pair. */
export async function rotateCode(pollId: number, voteId: string, oldCode: string): Promise<string> {
  const code = newCode();
  await db.tx(async () => {
    await db.run("DELETE FROM ballot_keys WHERE key_hash=$1", [keyHash(voteId, oldCode)]);
    await db.run("INSERT INTO ballot_keys(key_hash,poll_id) VALUES ($1,$2)", [keyHash(voteId, code), pollId]);
  });
  return code;
}

export async function get(pollId: number, voteId: string): Promise<BallotRow | undefined> {
  return db.get<BallotRow>("SELECT * FROM ballots WHERE vote_id=$1 AND poll_id=$2", [voteId, pollId]);
}

export async function all(pollId: number): Promise<BallotRow[]> {
  return db.all<BallotRow>("SELECT * FROM ballots WHERE poll_id=$1 ORDER BY vote_id", [pollId]);
}
