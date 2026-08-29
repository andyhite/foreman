#!/usr/bin/env bun
/**
 * Guards the plugin's enforcement surface.
 *
 * Every failure this script catches is silent at runtime. omp drops a tool name
 * it does not recognize without a warning, drops an unknown `autoloadSkills`
 * name without a warning (SPEC §8), and resolves skills first-wins across
 * providers so a same-named user skill shadows ours. An agent then runs happily
 * without its procedure or its block protocol and nothing tells you. A frontmatter
 * schema that has drifted from the TypeBox definition is the same class of
 * problem: the extension would validate against one contract while the model
 * was given another.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_OUTPUT_SCHEMAS } from "@foreman/core";
import { stageFor } from "../src/enforce/task-guard.ts";

// Defaults to this plugin. An explicit argument lets the check run against a
// mutated copy, which is how its own failure paths get tested.
const pluginRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical omp tool names. Anything outside this table is silently dropped. */
const OMP_TOOLS: Record<string, true> = {
  ask: true, "ast-edit": true, "ast-grep": true, bash: true, browser: true,
  checkpoint: true, computer: true, debug: true, edit: true, eval: true,
  generate_image: true, github: true, glob: true, grep: true, hub: true,
  inspect_image: true, learn: true, lsp: true, manage_skill: true,
  memory_edit: true, read: true, recall: true, reflect: true, retain: true,
  rewind: true, security_scan: true, task: true, todo: true, tts: true,
  web_search: true, write: true, yield: true,
};

/** Tools this extension registers. */
const FOREMAN_TOOLS: Record<string, true> = {
  foreman_linear_read: true,
  foreman_github_pr: true,
};

/** Spellings the SPEC used that omp does not have. Named so the error is useful. */
const WRONG_TOOL_NAMES: Record<string, string> = {
  search: "there is no `search` tool — use `grep` and `glob`",
  dap: "there is no `dap` tool — use `debug`",
  exec: "`exec` is an expansion alias — list `eval` and `bash` explicitly",
};

interface Frontmatter {
  scalars: Map<string, string>;
  blocks: Map<string, string>;
}

/**
 * Minimal frontmatter reader: top-level `key: value` scalars plus `key: |`
 * block scalars. Deliberately not a YAML parser — the plugin has no runtime
 * dependencies and this only has to read files this repo generates and owns.
 */
function readFrontmatter(path: string): Frontmatter {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${path}: no frontmatter`);
  const close = text.indexOf("\n---", 3);
  if (close === -1) throw new Error(`${path}: unterminated frontmatter`);

  const lines = text.slice(4, close).split("\n");
  const scalars = new Map<string, string>();
  const blocks = new Map<string, string>();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.startsWith("#") || line.trim() === "") continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    if (rest === "|" || rest === "|-") {
      const collected: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] as string;
        if (next.trim() !== "" && !next.startsWith("  ")) break;
        collected.push(next.slice(2));
        index++;
      }
      blocks.set(key, collected.join("\n"));
      continue;
    }
    scalars.set(key, rest.trim());
  }
  return { scalars, blocks };
}

function parseFlowList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

const problems: string[] = [];
const agentFiles = readdirSync(join(pluginRoot, "agents")).filter((f) => f.endsWith(".md"));
const skillDirs = new Set(readdirSync(join(pluginRoot, "skills")));

if (agentFiles.length !== Object.keys(AGENT_OUTPUT_SCHEMAS).length) {
  problems.push(
    `agents/ has ${agentFiles.length} definitions but AGENT_OUTPUT_SCHEMAS has ` +
      `${Object.keys(AGENT_OUTPUT_SCHEMAS).length}: every agent needs a validated contract`,
  );
}

for (const agent of Object.keys(AGENT_OUTPUT_SCHEMAS)) {
  if (stageFor(agent) === null) {
    problems.push(`AGENT_OUTPUT_SCHEMAS key "${agent}" has no stageFor branch, so its agent can never dispatch`);
  }
}

for (const file of agentFiles.sort()) {
  const path = join(pluginRoot, "agents", file);
  const { scalars, blocks } = readFrontmatter(path);
  const label = `agents/${file}`;

  const name = scalars.get("name");
  if (name !== file.replace(/\.md$/, "")) {
    problems.push(`${label}: frontmatter name "${name}" does not match the filename`);
  }
  if (!scalars.get("description")) problems.push(`${label}: missing description`);

  for (const forbidden of ["spawns", "schemaMode", "isolated"]) {
    if (scalars.has(forbidden)) {
      problems.push(
        `${label}: sets \`${forbidden}\`, which must never appear on a Foreman agent ` +
          `(see docs/VERIFIED.md)`,
      );
    }
  }

  const tools = parseFlowList(scalars.get("tools"));
  if (tools.length === 0) problems.push(`${label}: no tools allowlist`);
  for (const tool of tools) {
    const wrong = WRONG_TOOL_NAMES[tool];
    if (wrong) {
      problems.push(`${label}: tool "${tool}" — ${wrong}`);
      continue;
    }
    if (tool === "task") {
      problems.push(`${label}: grants \`task\`, which enables the fan-out SPEC §5 forbids`);
      continue;
    }
    if (!OMP_TOOLS[tool] && !FOREMAN_TOOLS[tool]) {
      problems.push(`${label}: tool "${tool}" is not a known omp or Foreman tool`);
    }
  }

  for (const skill of parseFlowList(scalars.get("autoloadSkills"))) {
    if (!skillDirs.has(skill)) {
      problems.push(`${label}: autoloadSkills "${skill}" has no skills/${skill}/ directory`);
      continue;
    }
    const skillPath = join(pluginRoot, "skills", skill, "SKILL.md");
    if (!existsSync(skillPath)) {
      problems.push(`${label}: skills/${skill}/SKILL.md is missing`);
      continue;
    }
    const declared = readFrontmatter(skillPath).scalars.get("name");
    if (declared !== skill) {
      problems.push(
        `${label}: skills/${skill}/SKILL.md declares name "${declared}"; ` +
          `autoloadSkills resolves by name, so it must equal the directory`,
      );
    }
    for (const shadow of [
      join(process.cwd(), ".omp", "skills", skill),
      join(homedir(), ".omp", "agent", "skills", skill),
    ]) {
      if (existsSync(shadow)) {
        problems.push(
          `${label}: skill "${skill}" is shadowed by ${shadow} at a higher provider ` +
            `priority — the agent would autoload that one instead`,
        );
      }
    }
  }

  const inlined = blocks.get("output");
  if (!inlined) {
    problems.push(
      `${label}: no inlined \`output\` schema. omp JSON-parses this value rather ` +
        `than reading a path, so run \`bun run schemas\``,
    );
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inlined);
    } catch (error) {
      problems.push(`${label}: inlined output schema is not valid JSON: ${String(error)}`);
      parsed = null;
    }
    const agentName = file.replace(/\.md$/, "") as keyof typeof AGENT_OUTPUT_SCHEMAS;
    const expected = AGENT_OUTPUT_SCHEMAS[agentName];
    if (!expected) {
      problems.push(`${label}: no entry in AGENT_OUTPUT_SCHEMAS for "${agentName}"`);
    } else if (parsed !== null) {
      const want = JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        ...expected,
      });
      if (JSON.stringify(parsed) !== want) {
        problems.push(
          `${label}: inlined output schema has drifted from AGENT_OUTPUT_SCHEMAS — ` +
            `run \`bun run schemas\``,
        );
      }
    }
  }
}

for (const dir of skillDirs) {
  const path = join(pluginRoot, "skills", dir, "SKILL.md");
  if (!existsSync(path)) {
    problems.push(`skills/${dir}/: no SKILL.md`);
    continue;
  }
  if (!readFrontmatter(path).scalars.get("description")) {
    problems.push(`skills/${dir}/SKILL.md: missing description, which providers require`);
  }
}

for (const file of readdirSync(join(pluginRoot, "commands")).filter((f) => f.endsWith(".md"))) {
  const { scalars } = readFrontmatter(join(pluginRoot, "commands", file));
  if (!scalars.get("description")) problems.push(`commands/${file}: missing description`);
}

for (const file of readdirSync(join(pluginRoot, "rules")).filter((f) => f.endsWith(".md"))) {
  const { scalars } = readFrontmatter(join(pluginRoot, "rules", file));
  const label = `rules/${file}`;
  if (!scalars.get("description")) {
    problems.push(`${label}: missing description, so it is excluded from the rulebook`);
  }
  const condition = scalars.get("condition");
  if (condition !== undefined) {
    const raw = condition.replace(/^["']|["']$/g, "");
    const insensitive = raw.startsWith("(?i)");
    try { new RegExp(insensitive ? raw.slice(4) : raw, insensitive ? "i" : ""); }
    catch (error) { problems.push(`${label}: condition is not a valid regex: ${String(error)}`); }
  }
  const scope = scalars.get("scope");
  if (scope !== undefined) {
    for (const token of scope.replace(/^["']|["']$/g, "").split(",").map((value) => value.trim())) {
      if (!/^(text|thinking|tool|toolcall|tool:[A-Za-z][\w-]*\([^)]*\))$/.test(token)) {
        problems.push(`${label}: invalid scope token "${token}"`);
      }
    }
  }
  const hasTrigger =
    scalars.has("condition") || scalars.has("astCondition") || scalars.get("alwaysApply") === "true";
  if (!hasTrigger) {
    problems.push(`${label}: no condition, astCondition, or alwaysApply — it will never register`);
  }
}

if (problems.length > 0) {
  console.error(`agent contract check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `agent contract OK: ${agentFiles.length} agents, ${skillDirs.size} skills, ` +
    `schemas match AGENT_OUTPUT_SCHEMAS`,
);
