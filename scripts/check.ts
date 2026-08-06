#!/usr/bin/env bun
/**
 * Consistency checker for every plugin this repo publishes.
 *
 * The repo is a marketplace: `foreman` at the root, plus one plugin per
 * directory under `plugins/`. It's mostly prose (commands/skills/agents/rules
 * as markdown), so nothing type-checks it. This script catches the failure
 * modes that bit us during authoring: a required frontmatter field missing, a
 * `skill://<name>` or `/<plugin>:<command>` reference that doesn't resolve, a
 * sibling plugin that leaks a dependency on foreman or never got registered in
 * the catalog, a rule name that collides with another plugin's, and duplicate
 * adjacent lines (the signature of a botched line-range edit).
 *
 * Every content check is per-plugin: a pack under `plugins/` may grow its own
 * commands, skills, and agents, and they are validated against that plugin's
 * own namespace rather than foreman's.
 *
 * Run: `bun scripts/check.ts` (or `node scripts/check.ts`). Exits non-zero
 * with a report on failure.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// `import.meta.dirname` over Bun's `import.meta.dir`: Bun aliases the two to
// the same getter (since v1.0.23), so this also runs under bare `node`, which
// strips types natively — one less thing to install to check a prose repo.
const ROOT = join(import.meta.dirname, "..");

type Frontmatter = Record<string, string | string[]>;

function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: content };
  const fm: Frontmatter = {};
  let key: string | null = null;
  for (const line of match[1].split("\n")) {
    // Block-sequence entries belong to the key opened above them. Path rules
    // declare `condition:` followed by `  - "**/glob"` lines, and a plain
    // key:value parser reads that as an empty condition.
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      const value = item[1].trim().replace(/^["']|["']$/g, "");
      const existing = fm[key];
      if (Array.isArray(existing)) existing.push(value);
      else fm[key] = [value];
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    // Leave an empty value unset so a following block sequence owns the key.
    if (kv[2].trim()) fm[key] = kv[2].trim();
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

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory());
  } catch {
    return [];
  }
}

const errors: string[] = [];
const warnings: string[] = [];

// --- plugin roots: foreman at the repo root, plus every directory under
// plugins/. `id` doubles as the command prefix omp derives from the plugin
// name, so a pack's own commands resolve as /<id>:<command>. ---
type PluginRoot = {
  id: string;
  dir: string;
  prefix: string;
  standalone: boolean;
  commands: Set<string>;
  skills: Set<string>;
};
const pluginRoots: PluginRoot[] = [
  { id: "foreman", dir: ROOT, prefix: "", standalone: false, commands: new Set(), skills: new Set() },
  ...listDirs(join(ROOT, "plugins")).map((name) => ({
    id: name,
    dir: join(ROOT, "plugins", name),
    prefix: `plugins/${name}/`,
    standalone: true,
    commands: new Set<string>(),
    skills: new Set<string>(),
  })),
];

// The catalog and the tree must agree in both directions: an unregistered
// directory ships to nobody, and a registered directory that doesn't exist
// fails at install time for everyone.
{
  const catalog = JSON.parse(
    readFileSync(join(ROOT, ".omp-plugin", "marketplace.json"), "utf8"),
  ) as { plugins?: { name?: unknown; source?: unknown }[] };
  const entries = catalog.plugins ?? [];
  const sources = new Set(entries.map((p) => String(p.source)));
  for (const plugin of pluginRoots) {
    if (!plugin.standalone) continue;
    if (!sources.has(`./plugins/${plugin.id}`)) {
      errors.push(
        `plugins/${plugin.id}/: not registered in .omp-plugin/marketplace.json — add an entry with "source": "./plugins/${plugin.id}"`,
      );
    }
  }
  const dirs = new Set(pluginRoots.map((p) => p.dir));
  for (const entry of entries) {
    const source = String(entry.source);
    if (!source.startsWith("./")) continue;
    // `resolve` not `join`: foreman's source is "./", and join would leave a
    // trailing slash that never equals the normalized root.
    if (!dirs.has(resolve(ROOT, source))) {
      errors.push(
        `.omp-plugin/marketplace.json: plugin "${String(entry.name)}" has source "${source}", which is not a plugin directory in this repo — installing it would fail`,
      );
    }
    // A directory named differently from its plugin name would break the
    // /<plugin>:<command> prefix that omp derives from the name.
    const name = String(entry.name);
    if (source.startsWith("./plugins/") && source !== `./plugins/${name}`) {
      errors.push(
        `.omp-plugin/marketplace.json: plugin "${name}" lives at "${source}" — the directory must match the plugin name, since omp prefixes its commands with the name`,
      );
    }
  }
}

let ruleCount = 0;
const ruleOrigin: Record<string, string> = {};

for (const plugin of pluginRoots) {
  // --- commands/*.md: must have `description`; the filename must not re-bake
  // the plugin's own name (that produces the double-prefix bug we hit once) ---
  for (const file of listMd(join(plugin.dir, "commands"))) {
    const rel = `${plugin.prefix}commands/${file}`;
    const { fm } = parseFrontmatter(readFileSync(join(plugin.dir, "commands", file), "utf8"));
    const name = file.replace(/\.md$/, "");
    plugin.commands.add(name);
    if (!fm.description) errors.push(`${rel}: missing frontmatter "description"`);
    if (name.includes(":")) {
      errors.push(
        `${rel}: filename bakes in a namespace prefix — omp already prefixes plugin commands with the plugin name, so this would double up (see the foreman:init incident)`,
      );
    }
  }

  // --- skills/<name>/SKILL.md: must have name == dirname and a description ---
  for (const dir of listDirs(join(plugin.dir, "skills"))) {
    const rel = `${plugin.prefix}skills/${dir}/SKILL.md`;
    let content: string;
    try {
      content = readFileSync(join(plugin.dir, "skills", dir, "SKILL.md"), "utf8");
    } catch {
      errors.push(`${plugin.prefix}skills/${dir}/: no SKILL.md`);
      continue;
    }
    const { fm } = parseFrontmatter(content);
    plugin.skills.add(dir);
    if (!fm.name) errors.push(`${rel}: missing frontmatter "name"`);
    else if (fm.name !== dir) errors.push(`${rel}: name "${String(fm.name)}" doesn't match directory "${dir}"`);
    if (!fm.description) errors.push(`${rel}: missing frontmatter "description"`);
  }

  // --- agents/*.md: must have name + description ---
  for (const file of listMd(join(plugin.dir, "agents"))) {
    const rel = `${plugin.prefix}agents/${file}`;
    const { fm } = parseFrontmatter(readFileSync(join(plugin.dir, "agents", file), "utf8"));
    if (!fm.name) errors.push(`${rel}: missing frontmatter "name"`);
    if (!fm.description) errors.push(`${rel}: missing frontmatter "description"`);
  }

  // --- rules/*.md. Three valid shapes, and the scope requirement differs per
  // shape because omp derives scope from a glob-shaped condition:
  //   command rule: regex `condition` + explicit `scope` (never bare "tool")
  //   path rule:    `condition` as a glob sequence, NO scope (omp infers
  //                 tool:edit()/tool:write() and substitutes condition `.*`)
  //   standing rule: `alwaysApply: true`, no condition, no scope
  const rulesDir = join(plugin.dir, "rules");
  for (const file of listMd(rulesDir)) {
    ruleCount++;
    const rel = `${plugin.prefix}rules/${file}`;
    const { fm } = parseFrontmatter(readFileSync(join(rulesDir, file), "utf8"));

    // omp identifies rules by name (filename) across every installed plugin
    // and keeps only the first, so a collision silently disables one of them.
    const name = file.replace(/\.md$/, "");
    if (ruleOrigin[name]) {
      errors.push(
        `${rel}: rule name "${name}" already defined by ${ruleOrigin[name]} — omp deduplicates rules by name, so one would silently shadow the other. Prefix it with its tool or domain.`,
      );
    } else ruleOrigin[name] = rel;

    if (!fm.description) errors.push(`${rel}: missing frontmatter "description"`);

    const isPathRule = Array.isArray(fm.condition);
    const isStanding = fm.alwaysApply === "true";
    if (!fm.condition && !fm.astCondition && !isStanding) {
      errors.push(
        `${rel}: needs a trigger — a regex "condition", an "astCondition", a glob-sequence "condition", or "alwaysApply: true" for a standing rule. Without one the rule is unreachable.`,
      );
    }

    if (isPathRule || isStanding) {
      if (fm.scope) {
        errors.push(
          `${rel}: ${isPathRule ? "a glob-sequence condition already infers tool:edit()/tool:write() scope" : "a standing alwaysApply rule is injected into the prompt, not matched"} — an explicit "scope" here is wrong. For a path rule it adds a second scope entry with catch-all condition ".*", which fires the rule on every command in that scope.`,
        );
      }
      continue;
    }

    if (!fm.condition) continue;
    if (!fm.scope) {
      errors.push(
        `${rel}: a regex "condition" needs an explicit "scope" (use "tool:bash" for a shell-command rule) — omitting it watches assistant prose and every tool's arguments.`,
      );
    } else if (typeof fm.scope === "string" && /^"?tool"?$/.test(fm.scope)) {
      errors.push(
        `${rel}: scope is bare "tool" — matches every tool call's arguments (including write/edit content), not just bash. Use "tool:bash" (see the false-positive incident this was fixed from).`,
      );
    }
  }
}

// --- cross-reference checks across every markdown file in every plugin ---
const allDirs = ["commands", "skills", "agents", "rules"];
function walkMd(base: string): string[] {
  const out: string[] = [];
  for (const top of allDirs) {
    const dir = join(base, top);
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

const foreman = pluginRoots.find((p) => !p.standalone)!;

for (const plugin of pluginRoots) {
  for (const path of walkMd(plugin.dir)) {
    const content = readFileSync(path, "utf8");
    const rel = path.slice(ROOT.length + 1);

    // A plugin may reference its OWN skills. A standalone pack referencing a
    // skill it doesn't define would depend on another plugin being installed,
    // which nothing guarantees.
    for (const m of content.matchAll(/skill:\/\/([a-z0-9-]+)/g)) {
      if (plugin.skills.has(m[1])) continue;
      errors.push(
        plugin.standalone
          ? `${rel}: references skill://${m[1]}, which ${plugin.id} doesn't define — a standalone plugin can't depend on another plugin's skills; add the skill here or inline the guidance`
          : `${rel}: references skill://${m[1]}, which doesn't exist`,
      );
    }

    // Commands resolve as /<plugin>:<command>. Referencing foreman's from a
    // standalone pack is the coupling this split exists to prevent.
    for (const m of content.matchAll(/\/([a-z0-9-]+):([a-z0-9-]+)/g)) {
      const [, ns, cmd] = m;
      if (ns !== plugin.id && ns !== foreman.id) continue;
      if (ns !== plugin.id) {
        errors.push(`${rel}: references /${ns}:${cmd} — a standalone plugin can't depend on ${ns}'s commands`);
      } else if (!plugin.commands.has(cmd)) {
        errors.push(`${rel}: references /${ns}:${cmd}, which doesn't exist`);
      }
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
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error("");
  process.exit(1);
}
const commands = pluginRoots.reduce((n, p) => n + p.commands.size, 0);
const skills = pluginRoots.reduce((n, p) => n + p.skills.size, 0);
console.log(
  `ok: ${pluginRoots.length} plugins, ${commands} commands, ${skills} skills, ${ruleCount} rules checked, no errors${warnings.length ? ` (${warnings.length} warning(s) above)` : ""}`,
);
