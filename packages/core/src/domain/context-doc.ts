/**
 * The product `Context` doc's seed (SPEC §4.7/§4.8). `provisionTeam` writes
 * this exact title and body once, when no team document titled `Context`
 * exists (SPEC §4.7). The body is operator-owned prose from that point on —
 * Foreman never rewrites it, because `foreman-review` grades `ReviewResult`
 * against it and the bar must not move under the thing being measured.
 */

/** The team document's title, matched case-insensitively after trimming by both the reader (context digest) and the writer (`provisionTeam`), so they cannot drift apart. */
export const CONTEXT_DOC_TITLE = "Context";

/**
 * SPEC §4.7's four sections; SPEC §4.8's Definition of Done. This table is
 * the single source of truth for heading text and body order: both
 * `CONTEXT_DOC_TEMPLATE` and the parser/renderer below are derived from it,
 * so heading literals cannot drift apart between "what we seed" and "what we
 * read back".
 */
const CONTEXT_DOC_SECTION_TABLE = [
  {
    key: "decisions",
    heading: "Architectural decisions and constraints",
    seed: "_Record the decisions and constraints that shape how this repo is built, so agents stop re-deriving or re-litigating them._",
  },
  {
    key: "vocabulary",
    heading: "Domain vocabulary",
    seed: "_Define the terms this repo's issues and code use in a specific sense, so agents read them the way the team means them._",
  },
  {
    key: "nonGoals",
    heading: "Known non-goals",
    seed: "_List what this repo deliberately does not do, so agents stop proposing it._",
  },
  {
    key: "definitionOfDone",
    heading: "Definition of Done",
    seed: "- [ ] Tests written and passing\n- [ ] Lint and typecheck clean\n- [ ] No new LSP diagnostics\n- [ ] Docs updated if public API changed",
  },
] as const satisfies ReadonlyArray<{ key: keyof ContextDocSections; heading: string; seed: string }>;

/** The doc's four canonical sections. `definitionOfDone` is agent-locked (see module doc). */
export interface ContextDocSections {
  decisions: string;
  vocabulary: string;
  nonGoals: string;
  definitionOfDone: string;
}

function renderSection(heading: string, body: string): string {
  return `## ${heading}\n\n${body}\n`;
}

/** SPEC §4.7's four sections; SPEC §4.8's Definition of Done, verbatim. */
export const CONTEXT_DOC_TEMPLATE = CONTEXT_DOC_SECTION_TABLE.map((section) =>
  renderSection(section.heading, section.seed),
).join("\n");

/**
 * Parses a stored doc body into its sections. Missing section -> empty string.
 *
 * Headings are matched case-insensitively after trimming, tolerating any
 * section order. Content before the first recognised `## ` heading, and
 * content under an unrecognised heading, is intentionally discarded rather
 * than silently attached to a neighbouring section: operator prose outside
 * the four canonical sections has nowhere safe to live once re-rendered in
 * canonical order, and folding it into the wrong section would look like an
 * agent-authored change to that section's content.
 */
export function splitContextDoc(content: string): ContextDocSections {
  const result: ContextDocSections = {
    decisions: "",
    vocabulary: "",
    nonGoals: "",
    definitionOfDone: "",
  };
  const headingByKey: Record<string, keyof ContextDocSections> = Object.fromEntries(
    CONTEXT_DOC_SECTION_TABLE.map((section) => [section.heading.toLowerCase(), section.key] as const),
  );
  const lines = content.split("\n");
  let currentKey: keyof ContextDocSections | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentKey !== null) {
      result[currentKey] = buffer.join("\n").trim();
    }
    buffer = [];
  };
  for (const line of lines) {
    const headingMatch = /^##\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      const key: keyof ContextDocSections | undefined = headingByKey[(headingMatch[1] ?? "").trim().toLowerCase()];
      if (key !== undefined) {
        flush();
        currentKey = key;
        continue;
      }
      // Unrecognised heading: stop attributing to the previous section, and
      // discard everything until the next recognised heading (see doc comment).
      flush();
      currentKey = null;
      continue;
    }
    if (currentKey !== null) {
      buffer.push(line);
    }
  }
  flush();
  return result;
}

/** Renders sections back to a doc body, always in canonical order, DoD last. */
export function renderContextDoc(sections: ContextDocSections): string {
  return CONTEXT_DOC_SECTION_TABLE.map((section) => renderSection(section.heading, sections[section.key])).join(
    "\n",
  );
}

/**
 * The agent-proposable zone only. No `definitionOfDone` member exists, which
 * is what makes the review bar structurally unreachable from agent output.
 */
export type ContextDocProposal = Omit<ContextDocSections, "definitionOfDone">;

export interface ContextDocRemoval {
  section: "decisions" | "vocabulary" | "non-goals";
  text: string;
  reason: string;
}

export interface ContextDocMergeResult {
  /** The doc body to write, or null when nothing changed. */
  content: string | null;
  /** Non-empty when the merge is REFUSED; `content` is null. */
  undeclaredRemovals: string[];
}

const OPEN_SECTIONS = [
  { key: "decisions", section: "decisions" },
  { key: "vocabulary", section: "vocabulary" },
  { key: "nonGoals", section: "non-goals" },
] as const satisfies ReadonlyArray<{ key: keyof ContextDocProposal; section: ContextDocRemoval["section"] }>;

/**
 * A line's identity for removal-tracking, independent of the markers Linear
 * rewrites on write (both measured against the live API — docs/VERIFIED.md):
 *
 * - `_text_` reads back as `*text*`, so emphasis characters normalise together.
 * - a `- item` bullet reads back as `* item`, so the leading list marker
 *   normalises to one form. Doing only the first would turn a `*` bullet into
 *   `_` while leaving a `-` bullet alone, and a proposal that faithfully
 *   re-sent the line it just read would look like a deletion plus an addition.
 *
 * The consequence worth stating: an agent may write `-` bullets and plain
 * `_italic_` without its next proposal being refused for lines it never
 * touched.
 */
function comparableLine(line: string): string {
  return line.replace(/^[-*+]\s+/, "- ").replace(/[_*]/g, "_");
}

/**
 * Splices a proposal into the live doc: the three open sections are replaced,
 * the live `definitionOfDone` is carried through verbatim.
 *
 * Refuses when a non-empty line present in an open section of `existing` is
 * absent from the proposal and not accounted for by a `removals` entry whose
 * `text` matches it. Silent loss of a recorded decision is the one failure
 * this function exists to make impossible.
 */
export function mergeContextDoc(
  existing: string,
  proposal: ContextDocProposal,
  removals: readonly ContextDocRemoval[],
): ContextDocMergeResult {
  const existingSections = splitContextDoc(existing);
  const undeclaredRemovals: string[] = [];
  for (const { key, section } of OPEN_SECTIONS) {
    const existingLines = existingSections[key]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const proposedLines = new Set(
      proposal[key]
        .split("\n")
        .map((line) => comparableLine(line.trim()))
        .filter((line) => line.length > 0),
    );
    const declaredRemovals = new Set(
      removals
        .filter((removal) => removal.section === section)
        .map((removal) => comparableLine(removal.text.trim())),
    );
    for (const line of existingLines) {
      const normalized = comparableLine(line);
      if (!proposedLines.has(normalized) && !declaredRemovals.has(normalized)) {
        undeclaredRemovals.push(line);
      }
    }
  }
  if (undeclaredRemovals.length > 0) {
    return { content: null, undeclaredRemovals };
  }
  const merged = renderContextDoc({
    decisions: proposal.decisions,
    vocabulary: proposal.vocabulary,
    nonGoals: proposal.nonGoals,
    definitionOfDone: existingSections.definitionOfDone,
  });
  const comparable = (body: string) =>
    body
      .split("\n")
      .map((line) => comparableLine(line.trim()))
      .filter((line) => line.length > 0)
      .join("\n");
  if (comparable(merged) === comparable(existing)) {
    return { content: null, undeclaredRemovals: [] };
  }
  return { content: merged, undeclaredRemovals: [] };
}
