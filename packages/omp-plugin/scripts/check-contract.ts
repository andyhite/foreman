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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_OUTPUT_SCHEMAS, SCHEMA_FILENAMES } from "@foreman/core";
import { stageFor } from "../src/enforce/task-guard.ts";
import { registerGitHubPrTool } from "../src/tools/github-pr.ts";
import { registerLinearReadTool } from "../src/tools/linear-read.ts";

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

/**
 * Every tool the extension registers, collected by running the registration
 * code against a stub `pi` rather than restating it in a table here. A
 * hand-maintained list is the same silent-failure class this script exists to
 * catch: it would drift from the extension and then happily validate agent
 * frontmatter against tools that no longer exist.
 *
 * The stub only satisfies the schema builders the registrations call. One node
 * answers every builder and every chained refinement by returning itself, and
 * `execute` is never invoked, so collecting the configs touches neither Linear
 * nor GitHub.
 */
function registeredTools(): Array<{ name: string; loadMode?: string }> {
  const zod: Record<string, unknown> = {};
  for (const method of [
    "object", "string", "boolean", "number", "array", "enum",
    "optional", "describe", "default", "int", "positive", "min",
  ]) {
    zod[method] = () => zod;
  }
  const configs: Array<{ name: string; loadMode?: string }> = [];
  const pi = {
    zod,
    registerTool: (config: { name: string; loadMode?: string }) => {
      configs.push(config);
    },
  };
  registerLinearReadTool(pi as never);
  registerGitHubPrTool(pi as never);
  return configs;
}

const FOREMAN_TOOL_CONFIGS = registeredTools();

/** Tools this extension registers, keyed for the frontmatter allowlist check. */
const FOREMAN_TOOLS: Record<string, true> = Object.fromEntries(
  FOREMAN_TOOL_CONFIGS.map((config) => [config.name, true as const]),
);

/** Spellings the SPEC used that omp does not have. Named so the error is useful. */
const WRONG_TOOL_NAMES: Record<string, string> = {
  search: "there is no `search` tool — use `grep` and `glob`",
  dap: "there is no `dap` tool — use `debug`",
  exec: "`exec` is an expansion alias — list `eval` and `bash` explicitly",
};

interface Frontmatter {
  scalars: Map<string, string>;
  blocks: Map<string, string>;
  sequences: Map<string, string[]>;
}

/**
 * Minimal frontmatter reader: top-level `key: value` scalars, `key: |`
 * block scalars, and `key:` followed by a `- item` block sequence.
 * Deliberately not a YAML parser — the plugin has no runtime
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
  const sequences = new Map<string, string[]>();

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
    if (rest === "") {
      const items: string[] = [];
      while (index + 1 < lines.length) {
        const seqMatch = /^\s*-\s*(.*)$/.exec(lines[index + 1] as string);
        if (!seqMatch) break;
        items.push(decodeYamlScalar((seqMatch[1] as string).trim()));
        index++;
      }
      if (items.length > 0) {
        sequences.set(key, items);
        continue;
      }
    }
    scalars.set(key, rest.trim());
  }
  return { scalars, blocks, sequences };
}

/** Decodes a YAML flow scalar: strips a single/double-quote wrapper and
 * resolves the escapes that form legitimately implies, rather than only
 * stripping the surrounding quote characters. */
function decodeYamlScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const escapes: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
    return raw.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => escapes[ch] ?? ch);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/** Splits a comma-separated list on commas that sit outside `()`/`{}`, so a
 * brace glob like `tool:edit({a,b}.ts)` survives as one token. */
function splitOutsideParens(input: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      tokens.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  tokens.push(current.trim());
  return tokens.filter((token) => token.length > 0);
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

/*
 * `readFrontmatter` above is deliberately not a YAML parser, so it happily
 * reads a block omp's real parser rejects. omp logs one warning and drops the
 * whole frontmatter — losing the description, the argument hint, and the
 * `---` fence, which then leaks into the prompt body the agent receives. That
 * is the silent-degradation class this script exists to catch, so every
 * discovered markdown file gets parsed by an actual YAML parser here.
 * `commands/triage.md` shipped broken this way: an unquoted
 * `argument-hint: [--stale-low-days <days>] <ISSUE-ID...>` reads as a flow
 * sequence followed by garbage.
 */
for (const dir of ["agents", "commands", "rules", "skills"]) {
  const root = join(pluginRoot, dir);
  if (!existsSync(root)) continue;
  const files = dir === "skills"
    ? readdirSync(root).flatMap((entry) => {
        const nested = join(root, entry);
        if (!statSync(nested).isDirectory()) return [];
        return readdirSync(nested)
          .filter((f) => f.endsWith(".md"))
          .map((f) => join(nested, f));
      })
    : readdirSync(root)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(root, f));

  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8");
    if (!text.startsWith("---\n")) continue;
    const close = text.indexOf("\n---", 3);
    if (close === -1) {
      problems.push(`${relative(pluginRoot, file)}: unterminated frontmatter fence`);
      continue;
    }
    try {
      Bun.YAML.parse(text.slice(4, close));
    } catch (error) {
      problems.push(
        `${relative(pluginRoot, file)}: frontmatter is not valid YAML — omp drops it entirely and the ` +
          `fence leaks into the prompt body (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      );
    }
  }
}

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

/*
 * omp defaults an extension tool to `loadMode: "discoverable"`, and its
 * `tools.xdev` layer — on by default — then demotes every discoverable tool out
 * of the model's tool list into an `xd://` device, in any session that holds
 * `write` without naming the tool in an explicit allowlist. The supervisor
 * session that runs every `/foreman:*` command is exactly that shape, and the
 * commands, agents, and skills all name these tools directly. A demoted
 * registration therefore turns that prose into a reference the supervisor
 * cannot resolve, and it burns the dispatch hunting for a tool that looks
 * missing. Nothing warns: the demotion is silent, which is why it lives here.
 */
for (const config of FOREMAN_TOOL_CONFIGS) {
  if (config.loadMode !== "essential") {
    problems.push(
      `src: tool "${config.name}" registers loadMode ${JSON.stringify(config.loadMode ?? "discoverable")}; ` +
        `it must be "essential", or omp mounts it as an xd:// device and drops it ` +
        `from the tool list of every session that names it`,
    );
  }
}

/*
 * Every `omp.extensions` entry must exist on disk. omp includes a declared
 * entry only if the file is there, and drops a missing one without a warning
 * — so the entrypoint is exactly the silent-failure class this script guards.
 * It matters more than it looks: `omp plugin install` copies this package out
 * of a git clone and never runs a package manager, so an entrypoint that is
 * only ever produced locally by `bun run build` is absent for every installed
 * repo. The markdown agents, commands, skills, and rules still discover from
 * the copied tree, which makes the plugin look installed while both tools, the
 * task guard, the lock manager, and the result appliers are all missing.
 */
const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
  omp?: { extensions?: string[] };
};
const entrypoints = manifest.omp?.extensions ?? [];
if (entrypoints.length === 0) {
  problems.push(
    `package.json: no \`omp.extensions\` array — the extension module never loads, and ` +
      `omp resolves \`omp\` before the legacy \`pi\` key, so a misspelled key fails in silence`,
  );
}
for (const entry of entrypoints) {
  if (!existsSync(join(pluginRoot, entry))) {
    problems.push(
      `package.json: \`omp.extensions\` entry "${entry}" does not exist. It is a build ` +
        `artifact that must be committed — run \`bun run build\``,
    );
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

for (const [agent, filename] of Object.entries(SCHEMA_FILENAMES) as [keyof typeof SCHEMA_FILENAMES, string][]) {
  const schemaPath = join(pluginRoot, "schemas", filename);
  if (!existsSync(schemaPath)) {
    problems.push(`schemas/${filename}: missing — run \`bun run schemas\``);
    continue;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch (error) {
    problems.push(`schemas/${filename}: not valid JSON: ${String(error)}`);
    continue;
  }
  const expected = {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...AGENT_OUTPUT_SCHEMAS[agent],
  };
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    const wantKeys = new Set(Object.keys(expected as Record<string, unknown>));
    const gotKeys = new Set(Object.keys((parsed ?? {}) as Record<string, unknown>));
    const missing = [...wantKeys].filter((key) => !gotKeys.has(key));
    const extra = [...gotKeys].filter((key) => !wantKeys.has(key));
    const drift = [
      missing.length > 0 ? `missing keys: ${missing.join(", ")}` : null,
      extra.length > 0 ? `extra keys: ${extra.join(", ")}` : null,
      missing.length === 0 && extra.length === 0 ? "content drift (same top-level keys)" : null,
    ]
      .filter((part): part is string => part !== null)
      .join("; ");
    problems.push(`schemas/${filename}: drifted from AGENT_OUTPUT_SCHEMAS (${drift}) — run \`bun run schemas\``);
  }
}

for (const dir of skillDirs) {
  const path = join(pluginRoot, "skills", dir, "SKILL.md");
  if (!existsSync(path)) {
    problems.push(`skills/${dir}/: no SKILL.md`);
    continue;
  }
  const { scalars } = readFrontmatter(path);
  if (!scalars.get("description")) {
    problems.push(`skills/${dir}/SKILL.md: missing description, which providers require`);
  }
  const declaredName = scalars.get("name");
  if (declaredName !== dir) {
    problems.push(
      `skills/${dir}/SKILL.md: frontmatter name "${declaredName}" does not match its directory — ` +
        "provider resolution looks up skills by name, so a mismatch fails to resolve",
    );
  }
}

for (const file of readdirSync(join(pluginRoot, "commands")).filter((f) => f.endsWith(".md"))) {
  const { scalars } = readFrontmatter(join(pluginRoot, "commands", file));
  if (!scalars.get("description")) problems.push(`commands/${file}: missing description`);
}

for (const file of readdirSync(join(pluginRoot, "rules")).filter((f) => f.endsWith(".md"))) {
  const { scalars, sequences } = readFrontmatter(join(pluginRoot, "rules", file));
  const label = `rules/${file}`;
  if (!scalars.get("description")) {
    problems.push(`${label}: missing description, so it is excluded from the rulebook`);
  }
  const condition = scalars.get("condition");
  if (condition !== undefined) {
    let pattern = decodeYamlScalar(condition);
    let flags = "";
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const [prefix, flag] of [["(?i)", "i"], ["(?m)", "m"], ["(?s)", "s"]] as const) {
        if (pattern.startsWith(prefix)) {
          if (!flags.includes(flag)) flags += flag;
          pattern = pattern.slice(prefix.length);
          stripped = true;
        }
      }
    }
    try { new RegExp(pattern, flags); }
    catch (error) { problems.push(`${label}: condition is not a valid regex: ${String(error)}`); }
  }
  const scopeTokens = sequences.get("scope") ?? (scalars.has("scope") ? splitOutsideParens(decodeYamlScalar(scalars.get("scope") as string)) : undefined);
  if (scopeTokens) {
    for (const token of scopeTokens) {
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
    `${FOREMAN_TOOL_CONFIGS.length} essential tools, ` +
    `schemas match AGENT_OUTPUT_SCHEMAS (agents + schemas/*.json)`,
);
