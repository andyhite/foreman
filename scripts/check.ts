#!/usr/bin/env bun
/**
 * Consistency checker for the omp-foreman plugin's own markdown content.
 *
 * This repo is mostly prose (commands/skills/agents/rules as markdown), so
 * nothing type-checks it. This script catches the failure modes that bit us
 * during authoring: a required frontmatter field missing, a `skill://<name>`
 * reference to a skill that doesn't exist, a `/foreman:<name>` reference to
 * a command that doesn't exist (or still carries the old baked-in
 * `foreman:` filename prefix), and duplicate adjacent lines (the signature
 * of a botched line-range edit).
 *
 * Run: `bun scripts/check.ts`. Exits non-zero with a report on failure.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Frontmatter = Record<string, string>;

function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: content };
  const fm: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: match[2] };
}

function listMd(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function listSkillDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory());
  } catch {
    return [];
  }
}

const errors: string[] = [];
const warnings: string[] = [];

// --- commands/*.md: must have `description`, filename must not re-bake the
// plugin's own name (that produces the double-prefix bug we already hit
// once) ---
const commandNames = new Set<string>();
for (const file of listMd(join(ROOT, "commands"))) {
  const path = join(ROOT, "commands", file);
  const { fm } = parseFrontmatter(readFileSync(path, "utf8"));
  const name = file.replace(/\.md$/, "");
  commandNames.add(name);
  if (!fm.description) errors.push(`commands/${file}: missing frontmatter "description"`);
  if (name.includes(":")) {
    errors.push(
      `commands/${file}: filename bakes in a namespace prefix — omp already prefixes plugin commands with the package name, so this would double up (see the foreman:init incident)`,
    );
  }
}

// --- skills/<name>/SKILL.md: must have name == dirname, must have
// description ---
const skillNames = new Set<string>();
for (const dir of listSkillDirs(join(ROOT, "skills"))) {
  const path = join(ROOT, "skills", dir, "SKILL.md");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    errors.push(`skills/${dir}/: no SKILL.md`);
    continue;
  }
  const { fm } = parseFrontmatter(content);
  skillNames.add(dir);
  if (!fm.name) errors.push(`skills/${dir}/SKILL.md: missing frontmatter "name"`);
  else if (fm.name !== dir)
    errors.push(`skills/${dir}/SKILL.md: name "${fm.name}" doesn't match directory "${dir}"`);
  if (!fm.description) errors.push(`skills/${dir}/SKILL.md: missing frontmatter "description"`);
}

// --- agents/*.md: must have name + description ---
for (const file of listMd(join(ROOT, "agents"))) {
  const path = join(ROOT, "agents", file);
  const { fm } = parseFrontmatter(readFileSync(path, "utf8"));
  if (!fm.name) errors.push(`agents/${file}: missing frontmatter "name"`);
  if (!fm.description) errors.push(`agents/${file}: missing frontmatter "description"`);
}

// --- rules/*.md: must have description + condition + scope, and scope
// should be tool-restricted (bare "tool" re-introduces the false-positive
// bug — it fires on write/edit content, not just bash invocations) ---
for (const file of listMd(join(ROOT, "rules"))) {
  const path = join(ROOT, "rules", file);
  const { fm } = parseFrontmatter(readFileSync(path, "utf8"));
  if (!fm.description) errors.push(`rules/${file}: missing frontmatter "description"`);
  if (!fm.condition) errors.push(`rules/${file}: missing frontmatter "condition"`);
  if (!fm.scope) errors.push(`rules/${file}: missing frontmatter "scope"`);
  else if (/^"?tool"?$/.test(fm.scope)) {
    errors.push(
      `rules/${file}: scope is bare "tool" — matches every tool call's arguments (including write/edit content), not just bash. Use "tool:bash" (see the false-positive incident this was fixed from).`,
    );
  }
}

// --- cross-reference checks across every markdown file in the package ---
const allDirs = ["commands", "skills", "agents", "rules"];
function walkAllMd(): string[] {
  const out: string[] = [];
  for (const top of allDirs) {
    const dir = join(ROOT, top);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        for (const f of listMd(p)) out.push(join(p, f));
      } else if (entry.endsWith(".md")) {
        out.push(p);
      }
    }
  }
  return out;
}

for (const path of walkAllMd()) {
  const content = readFileSync(path, "utf8");
  const rel = path.slice(ROOT.length + 1);

  for (const m of content.matchAll(/skill:\/\/([a-z0-9-]+)/g)) {
    if (!skillNames.has(m[1])) errors.push(`${rel}: references skill://${m[1]}, which doesn't exist`);
  }
  for (const m of content.matchAll(/\/foreman:([a-z0-9-]+)/g)) {
    if (!commandNames.has(m[1])) errors.push(`${rel}: references /foreman:${m[1]}, which doesn't exist`);
  }

  // Duplicate adjacent non-blank lines are the signature of a line-range
  // edit that widened past its intended boundary (happened twice while
  // authoring this repo).
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1].trim();
    const b = lines[i].trim();
    if (a && a === b && a.length > 20) {
      warnings.push(`${rel}:${i + 1}: duplicate adjacent line (possible leftover from an edit) — "${a.slice(0, 60)}..."`);
    }
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error("");
  process.exit(1);
}
console.log(`ok: ${commandNames.size} commands, ${skillNames.size} skills checked, no errors${warnings.length ? ` (${warnings.length} warning(s) above)` : ""}`);
