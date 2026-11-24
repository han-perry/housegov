/**
 * GovDocs: one git repository per document, driven entirely from the web UI.
 *
 * - Each doc is <DATA_DIR>/govdocs/<slug>/document.md with a linear history.
 * - An amendment draft records the commit it was based on. Applying it is a
 *   rebase: if the doc hasn't moved, commit directly; otherwise 3-way merge
 *   (base → draft, replayed onto HEAD). Conflicts are surfaced to a docs
 *   manager instead of being committed.
 *
 * git is always invoked via execFile with an argv array (never a shell), and
 * writes to a given repo are serialised with a per-slug lock.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Diff from "diff";
import { config } from "../config";
import * as db from "../db";

const execFileP = promisify(execFile);
const FILE = "document.md";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REV_RE = /^[0-9a-f]{4,40}$|^HEAD$/;
const docsRoot = () => path.join(config.dataDir, "govdocs");

function repoDir(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error("Invalid document slug");
  return path.join(docsRoot(), slug);
}

// Ignore host/global git config (signing, hooks, editors…): these repos are app data.
const ISOLATED_GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

async function git(slug: string, args: string[], author = "housegov"): Promise<string> {
  const env = {
    ...process.env,
    ...ISOLATED_GIT_ENV,
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author}@${config.mailDomain}`,
    GIT_COMMITTER_NAME: "HouseGov",
    GIT_COMMITTER_EMAIL: `housegov@${config.mailDomain}`,
  };
  const { stdout } = await execFileP("git", args, { cwd: repoDir(slug), env, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// Per-repo mutex so concurrent commits to one document don't interleave.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(slug) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(slug, next);
  return next;
}

export function normalize(text: string | null | undefined): string {
  const t = (text || "").replace(/\r\n/g, "\n");
  return t.endsWith("\n") ? t : t + "\n";
}

export async function createDoc(opts: { slug: string; title: string; category?: string; content: string; author: string }) {
  const dir = repoDir(opts.slug);
  if (existsSync(dir)) throw new Error("A document with that slug already exists");
  await fs.mkdir(dir, { recursive: true });
  await git(opts.slug, ["init", "-q", "-b", "main"]);
  await fs.writeFile(path.join(dir, FILE), normalize(opts.content));
  await git(opts.slug, ["add", FILE]);
  await git(opts.slug, ["commit", "-q", "-m", `Create ${opts.title}`], opts.author);
  await db.run("INSERT INTO docs(slug,title,category) VALUES ($1,$2,$3)", [opts.slug, opts.title, opts.category || "Policy"]);
}

export async function head(slug: string): Promise<string> {
  return (await git(slug, ["rev-parse", "HEAD"])).trim();
}

export async function read(slug: string, rev = "HEAD"): Promise<string> {
  if (!REV_RE.test(rev)) throw new Error("Invalid revision");
  return git(slug, ["show", `${rev}:${FILE}`]);
}

export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export async function history(slug: string): Promise<Commit[]> {
  const out = await git(slug, ["log", "--format=%H%x1f%an%x1f%aI%x1f%s"]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, subject] = line.split("\x1f");
      return { sha, author, date, subject };
    });
}

/** Unified diff introduced by one commit (works for the root commit too). */
export async function commitDiff(slug: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new Error("Invalid revision");
  return git(slug, ["show", "--format=", "--no-color", sha, "--", FILE]);
}

async function commitUnlocked(slug: string, content: string, author: string, message: string): Promise<string> {
  await fs.writeFile(path.join(repoDir(slug), FILE), normalize(content));
  await git(slug, ["add", FILE]);
  if (!(await git(slug, ["status", "--porcelain"])).trim()) return head(slug); // no change
  await git(slug, ["commit", "-q", "-m", message], author);
  return head(slug);
}

export function commit(slug: string, content: string, opts: { author: string; message: string }): Promise<string> {
  return withLock(slug, () => commitUnlocked(slug, content, opts.author, opts.message));
}

/**
 * Restore an old version: a new commit whose content is the document as of
 * `rev`. History is kept (nothing is rewritten). `expectedHead` is the version
 * the user was looking at; if the document moved since, nothing is committed,
 * so a change someone just made can't be thrown away unseen.
 */
export function restoreVersion(
  slug: string,
  rev: string,
  opts: { author: string; reason: string; expectedHead: string }
): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
  return withLock(slug, async () => {
    const current = await head(slug);
    if (current !== opts.expectedHead) return { ok: false as const, reason: "The document changed while you were looking at this page. Review the latest history and try again." };
    const full = (await git(slug, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
    const content = await read(slug, full);
    if (normalize(content) === normalize(await read(slug, "HEAD"))) return { ok: false as const, reason: "That version is identical to the current document." };
    const message = `Restore version ${full.slice(0, 7)}: ${opts.reason}\n\nRestored by ${opts.author}. Changes made after ${full.slice(0, 7)} are undone; they stay in the history.`;
    return { ok: true as const, sha: await commitUnlocked(slug, content, opts.author, message) };
  });
}

export function unifiedDiff(oldText: string, newText: string, label = FILE): string {
  return Diff.createTwoFilesPatch(`a/${label}`, `b/${label}`, normalize(oldText), normalize(newText));
}

/** Replay (baseCommit → draft) onto the current HEAD. Does not commit. */
export async function rebaseContent(slug: string, baseCommit: string, draft: string): Promise<{ ok: boolean; content: string; conflicts: number }> {
  if ((await head(slug)) === baseCommit) return { ok: true, content: normalize(draft), conflicts: 0 };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "housegov-merge-"));
  try {
    const write = async (name: string, text: string) => {
      const p = path.join(tmp, name);
      await fs.writeFile(p, normalize(text));
      return p;
    };
    const cur = await write("current", await read(slug, "HEAD"));
    const base = await write("base", await read(slug, baseCommit));
    const ours = await write("amendment", draft);
    try {
      const { stdout } = await execFileP("git", ["merge-file", "-p", "-L", "current", "-L", "base", "-L", "amendment", cur, base, ours], { env: { ...process.env, ...ISOLATED_GIT_ENV } });
      return { ok: true, content: stdout, conflicts: 0 };
    } catch (e) {
      // git merge-file exits with the number of conflicts (1..127) and still prints the merge.
      const err = e as { code?: number; stdout?: string };
      if (typeof err.code === "number" && err.code > 0 && err.code < 128 && err.stdout !== undefined) {
        return { ok: false, content: err.stdout, conflicts: err.code };
      }
      throw e;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export type ApplyResult = { ok: true; sha: string } | { ok: false; conflicts: number; reason?: string };

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;
export const hasConflictMarkers = (text: string) => CONFLICT_MARKER.test(text);

/** Apply a submitted amendment. On conflict the draft is rebased with markers for manual resolution. */
export async function applyAmendment(amendmentId: number, opts: { actor: string; context?: string }): Promise<ApplyResult> {
  const first = await db.get("SELECT doc_slug FROM amendments WHERE id=$1", [amendmentId]);
  if (!first) throw new Error("Amendment not found");

  return withLock(first.doc_slug, async (): Promise<ApplyResult> => {
    // Re-read under the lock so two simultaneous approvals can't both commit.
    const a = await db.get("SELECT * FROM amendments WHERE id=$1", [amendmentId]);
    if (!a) throw new Error("Amendment not found");
    if (a.status === "applied") return { ok: true, sha: a.applied_commit };
    if (a.status === "rejected") return { ok: false, conflicts: 0, reason: "This amendment was rejected." };
    // Unresolved conflict: never commit <<<<<<< markers into a policy document.
    if (a.status === "conflict" || hasConflictMarkers(a.content)) {
      return { ok: false, conflicts: (a.content.match(/^<{7}/gm) || []).length, reason: "Resolve the conflict markers first." };
    }
    const r = await rebaseContent(a.doc_slug, a.base_commit, a.content);
    if (!r.ok) {
      await db.run("UPDATE amendments SET status='conflict', content=$1, base_commit=$2, updated_at=now() WHERE id=$3", [
        r.content,
        await head(a.doc_slug),
        a.id,
      ]);
      return { ok: false as const, conflicts: r.conflicts };
    }
    const message = `Amendment #${a.id}: ${a.title}${opts.context ? ` (${opts.context})` : ""}\n\nProposed by ${a.author}; applied by ${opts.actor}.`;
    const sha = await commitUnlocked(a.doc_slug, r.content, a.author, message);
    await db.run("UPDATE amendments SET status='applied', applied_commit=$1, updated_at=now() WHERE id=$2", [sha, a.id]);
    return { ok: true as const, sha };
  });
}
