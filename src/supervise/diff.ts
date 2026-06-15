// Capturing "what the supervised agent changed" WITHOUT touching the user's git state.
//
// We keep a private "shadow" git repo under the temp dir (keyed by the project path) and
// point it at the project via GIT_DIR + GIT_WORK_TREE. Snapshotting stages the whole work
// tree into a TEMPORARY index (GIT_INDEX_FILE) and `write-tree`s it to a tree object in
// the shadow object db — so we never create a `.git` in the project, never touch its HEAD
// or index, and still get exact before/after diffs (committed or not). The project's own
// .gitignore (at the work-tree root) is still respected, so build output stays out.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let counter = 0;

function shadowDir(cwd: string): string {
  const h = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `poly-supervise-git-${h}`);
}

function baseEnv(cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_DIR: shadowDir(cwd), GIT_WORK_TREE: path.resolve(cwd) };
}

function git(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): string {
  // Capture stderr (don't inherit) so probes stay quiet; errors still carry their message.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...baseEnv(cwd), ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

/** Whether our shadow repo for this project already exists. */
export function isGitRepo(cwd: string): boolean {
  return fs.existsSync(path.join(shadowDir(cwd), "HEAD"));
}

/** Initialize the private shadow repo for `cwd` (idempotent). Never creates project/.git. */
export function ensureRepo(cwd: string): void {
  if (isGitRepo(cwd)) return;
  fs.mkdirSync(shadowDir(cwd), { recursive: true });
  // `git init` with GIT_DIR set creates the object db at the shadow dir, not the project.
  git(cwd, ["init", "-q"]);
}

/** Snapshot the current working tree → tree-object SHA (non-destructive). */
export function snapshot(cwd: string): string {
  ensureRepo(cwd);
  const idxFile = path.join(os.tmpdir(), `poly-sup-idx-${process.pid}-${counter++}`);
  try {
    git(cwd, ["add", "-A"], { GIT_INDEX_FILE: idxFile }); // stage all (respects .gitignore) → temp index
    return git(cwd, ["write-tree"], { GIT_INDEX_FILE: idxFile }).trim();
  } finally {
    try {
      fs.rmSync(idxFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface DiffResult {
  stat: string; // `--stat` summary (files + ± line counts)
  patch: string; // unified diff, capped
  filesChanged: number;
  insertions: number;
  deletions: number;
  empty: boolean;
}

/** Diff two tree snapshots → the agent's edits. `cap` bounds the patch fed to the LLM. */
export function diffTrees(cwd: string, before: string, after: string, cap = 24_000): DiffResult {
  if (before === after) {
    return { stat: "", patch: "", filesChanged: 0, insertions: 0, deletions: 0, empty: true };
  }
  const stat = git(cwd, ["diff", "--stat", before, after]).trim();
  let patch = git(cwd, ["diff", "--no-color", before, after]);
  if (patch.length > cap) patch = patch.slice(0, cap) + `\n…[diff truncated at ${cap} chars]`;
  const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  return {
    stat,
    patch,
    filesChanged: m ? parseInt(m[1], 10) || 0 : 0,
    insertions: m && m[2] ? parseInt(m[2], 10) : 0,
    deletions: m && m[3] ? parseInt(m[3], 10) : 0,
    empty: patch.trim() === "",
  };
}
