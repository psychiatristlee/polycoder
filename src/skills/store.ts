// Procedural skill library: reusable playbooks Polymath distills from VERIFIED
// successful runs and replays on similar future goals. This is orthogonal to the
// efficiency `insights` (which learn model→task routing); a skill captures *how to
// approach a kind of task*, so the agent stops re-deriving the same plan and burns
// fewer tokens. One skill == one markdown file (frontmatter + body) under the
// global config dir, so users can read/edit/share them like Claude Code skills.
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config/paths.js";
import type { GoalType } from "../planner/tasks.js";

export interface Skill {
  /** kebab-case slug; also the filename (without .md). */
  name: string;
  /** one-line summary used to MATCH a skill to a new goal. */
  description: string;
  goalType: GoalType;
  /** whether the proven approach uses file/command tools. */
  tools: boolean;
  createdAt: string;
  updatedAt: string;
  /** times this skill was applied to a later run. */
  uses: number;
  /** verified successes this skill was distilled / reinforced from. */
  sources: number;
  /** average total run cost of the sources (USD). */
  avgCostUsd: number;
  /** markdown playbook ("## When to use" + "## Approach"). */
  body: string;
}

export function skillsDir(): string {
  return path.join(configDir(), "skills");
}

export function ensureSkillsDir(): string {
  const dir = skillsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}

export function skillFilePath(name: string): string {
  return path.join(skillsDir(), `${slugify(name)}.md`);
}

function num(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function serializeSkill(s: Skill): string {
  const fm = [
    "---",
    `name: ${s.name}`,
    `description: ${s.description.replace(/\n/g, " ")}`,
    `goalType: ${s.goalType}`,
    `tools: ${s.tools}`,
    `createdAt: ${s.createdAt}`,
    `updatedAt: ${s.updatedAt}`,
    `uses: ${s.uses}`,
    `sources: ${s.sources}`,
    `avgCostUsd: ${s.avgCostUsd}`,
    "---",
    "",
  ].join("\n");
  return fm + s.body.trim() + "\n";
}

export function parseSkill(md: string, fallbackName: string): Skill {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = md;
  if (m) {
    for (const line of m[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    body = m[2];
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || "",
    goalType: (meta.goalType as GoalType) || "other",
    tools: meta.tools === "true",
    createdAt: meta.createdAt || "",
    updatedAt: meta.updatedAt || meta.createdAt || "",
    uses: num(meta.uses, 0),
    sources: num(meta.sources, 1),
    avgCostUsd: num(meta.avgCostUsd, 0),
    body: body.trim() + "\n",
  };
}

export function listSkills(): Skill[] {
  const dir = skillsDir();
  if (!fs.existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const md = fs.readFileSync(path.join(dir, f), "utf8");
      out.push(parseSkill(md, f.replace(/\.md$/, "")));
    } catch {
      /* skip unreadable */
    }
  }
  // Most-reinforced / most-used first.
  out.sort((a, b) => b.sources + b.uses - (a.sources + a.uses));
  return out;
}

export function loadSkill(name: string): Skill | null {
  const file = skillFilePath(name);
  if (!fs.existsSync(file)) return null;
  try {
    return parseSkill(fs.readFileSync(file, "utf8"), slugify(name));
  } catch {
    return null;
  }
}

/** Raw on-disk markdown (preserves any user edits) for `poly skills show`. */
export function readSkillFile(name: string): string | null {
  const file = skillFilePath(name);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function saveSkill(s: Skill): void {
  ensureSkillsDir();
  fs.writeFileSync(skillFilePath(s.name), serializeSkill(s), "utf8");
}

export function deleteSkill(name: string): boolean {
  const file = skillFilePath(name);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
