#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_OUTPUT_SCHEMAS, SCHEMA_FILENAMES } from "../src/schemas/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "..", "omp-plugin");
const outDir = join(pluginDir, "schemas");
const agentsDir = join(pluginDir, "agents");

const BEGIN = "# BEGIN generated output schema";
const END = "# END generated output schema";

/**
 * Inline each agent's schema into its frontmatter `output:` key.
 *
 * A frontmatter `output` string is `JSON.parse`d, never read as a path: an
 * `output: schemas/foo.json` fails preflight with `JSON Parse error: Unexpected
 * identifier "schemas"` (docs/VERIFIED.md §16.8). So the schema has to be in the
 * file. Generating it keeps the TypeBox definition in `core` the single source of
 * truth, which is the whole reason the sibling `schemas/*.json` files exist too.
 *
 * The region goes last in the frontmatter so everything a human reads — tools,
 * thinking level, autoloaded skills — stays above several hundred lines of JSON.
 */
function rewriteFrontmatter(source: string, schemaJson: string): string {
  if (!source.startsWith("---\n")) {
    throw new Error("agent file does not open with YAML frontmatter");
  }
  const close = source.indexOf("\n---", 3);
  if (close === -1) throw new Error("agent file frontmatter is unterminated");

  const head = source.slice(4, close).split("\n");
  const body = source.slice(close + 4);

  const kept: string[] = [];
  for (let index = 0; index < head.length; index++) {
    const line = head[index] as string;
    if (line.startsWith(BEGIN)) {
      while (index < head.length && !(head[index] as string).startsWith(END)) index++;
      continue;
    }
    // A comment block from the interim convention where the extension injected
    // the schema per spawn. It contradicts the generated region below it, so it
    // is stripped rather than left to confuse the next reader.
    if (/^#\s*`?output`?\s+is deliberately absent/.test(line)) {
      // Stop at the generated marker: it is a comment too, and swallowing it
      // would orphan the JSON block that follows.
      while (
        index + 1 < head.length &&
        (head[index + 1] as string).startsWith("#") &&
        !(head[index + 1] as string).startsWith(BEGIN)
      ) {
        index++;
      }
      continue;
    }
    // A bare `output:` key from an earlier convention, plus any indented block
    // scalar or flow-mapping continuation lines beneath it.
    if (/^output\s*:/.test(line)) {
      while (index + 1 < head.length && /^\s+\S/.test(head[index + 1] as string)) index++;
      continue;
    }
    kept.push(line);
  }

  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === "") kept.pop();

  const indented = schemaJson
    .split("\n")
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join("\n");

  const region = [
    BEGIN,
    "# Regenerate with `bun run schemas`. Edit packages/core/src/schemas/*.ts,",
    "# never this block: omp JSON-parses this string rather than reading a path,",
    "# so the schema must be inlined (docs/VERIFIED.md §16.8).",
    "output: |",
    indented,
    END,
  ].join("\n");

  return `---\n${kept.join("\n")}\n${region}\n---${body}`;
}


/**
 * Finds any `$ref` in the emitted schema that does not target this document's
 * own root (`#` or `#/...`). The agent frontmatter loads each file standalone
 * (SPEC §7), so a ref into another document would be an unresolved, silently
 * broken contract at load time rather than at emit time.
 */
function findExternalRef(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) {
      const found = findExternalRef(node[index], `${path}/${index}`);
      if (found) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
        return `${path}/$ref (${value})`;
      }
      const found = findExternalRef(value, `${path}/${key}`);
      if (found) return found;
    }
  }
  return null;
}

await mkdir(outDir, { recursive: true });

let hadExternalRef = false;

for (const [agent, filename] of Object.entries(SCHEMA_FILENAMES) as [
  keyof typeof SCHEMA_FILENAMES,
  string,
][]) {
  const schema = AGENT_OUTPUT_SCHEMAS[agent];
  const document = { $schema: "http://json-schema.org/draft-07/schema#", ...schema };

  const externalRef = findExternalRef(document, "");
  if (externalRef) {
    console.error(`${filename}: external $ref found at ${externalRef}`);
    hadExternalRef = true;
    continue;
  }

  const serialized = JSON.stringify(document, null, 2);

  const outPath = join(outDir, filename);
  const content = `${serialized}\n`;
  await writeFile(outPath, content, "utf8");
  console.log(`wrote ${outPath} (${Buffer.byteLength(content, "utf8")} bytes)`);

  const agentPath = join(agentsDir, `${agent}.md`);
  const before = await readFile(agentPath, "utf8");
  const after = rewriteFrontmatter(before, serialized);
  if (after === before) {
    console.log(`  ${agentPath} already current`);
    continue;
  }
  await writeFile(agentPath, after, "utf8");
  console.log(`  inlined into ${agentPath}`);
}

if (hadExternalRef) {
  process.exit(1);
}
