import { describe, expect, test } from "bun:test";
import {
  CONTEXT_DOC_TEMPLATE,
  type ContextDocRemoval,
  type ContextDocSections,
  mergeContextDoc,
  renderContextDoc,
  splitContextDoc,
} from "../src/domain/context-doc.ts";

describe("CONTEXT_DOC_TEMPLATE", () => {
  test("carries the four canonical headings and the DoD checklist unchanged", () => {
    expect(CONTEXT_DOC_TEMPLATE).toContain("## Architectural decisions and constraints");
    expect(CONTEXT_DOC_TEMPLATE).toContain("## Domain vocabulary");
    expect(CONTEXT_DOC_TEMPLATE).toContain("## Known non-goals");
    expect(CONTEXT_DOC_TEMPLATE).toContain("## Definition of Done");
    expect(CONTEXT_DOC_TEMPLATE).toContain("- [ ] Tests written and passing");
    expect(CONTEXT_DOC_TEMPLATE).toContain("- [ ] Lint and typecheck clean");
    expect(CONTEXT_DOC_TEMPLATE).toContain("- [ ] No new LSP diagnostics");
    expect(CONTEXT_DOC_TEMPLATE).toContain("- [ ] Docs updated if public API changed");
  });
});

describe("splitContextDoc / renderContextDoc", () => {
  const sections: ContextDocSections = {
    decisions: "We use Bun.",
    vocabulary: "Issue means a Linear issue.",
    nonGoals: "We do not support Windows.",
    definitionOfDone: "- [ ] Tests written and passing",
  };

  test("round-trips through render then split", () => {
    expect(splitContextDoc(renderContextDoc(sections))).toEqual(sections);
  });

  test("parses the seed template into its four sections", () => {
    const parsed = splitContextDoc(CONTEXT_DOC_TEMPLATE);
    expect(parsed.decisions).toContain("Record the decisions");
    expect(parsed.vocabulary).toContain("Define the terms");
    expect(parsed.nonGoals).toContain("deliberately does not do");
    expect(parsed.definitionOfDone).toContain("Tests written and passing");
  });

  test("parses sections presented out of canonical order", () => {
    const outOfOrder = [
      "## Definition of Done",
      "",
      "- [ ] Tests written and passing",
      "",
      "## Domain vocabulary",
      "",
      "Issue means a Linear issue.",
      "",
      "## Architectural decisions and constraints",
      "",
      "We use Bun.",
      "",
      "## Known non-goals",
      "",
      "We do not support Windows.",
      "",
    ].join("\n");
    expect(splitContextDoc(outOfOrder)).toEqual(sections);
  });

  test("discards content under an unrecognised heading rather than misattributing it", () => {
    const doc = [
      "## Architectural decisions and constraints",
      "",
      "We use Bun.",
      "",
      "## Some Rogue Heading",
      "",
      "This should not appear anywhere.",
      "",
      "## Domain vocabulary",
      "",
      "Issue means a Linear issue.",
      "",
    ].join("\n");
    const parsed = splitContextDoc(doc);
    expect(parsed.decisions).toBe("We use Bun.");
    expect(parsed.vocabulary).toBe("Issue means a Linear issue.");
    expect(JSON.stringify(parsed)).not.toContain("Rogue");
    expect(JSON.stringify(parsed)).not.toContain("should not appear");
  });

  test("always renders in canonical order with Definition of Done last", () => {
    const rendered = renderContextDoc(sections);
    const decisionsIdx = rendered.indexOf("## Architectural decisions and constraints");
    const vocabIdx = rendered.indexOf("## Domain vocabulary");
    const nonGoalsIdx = rendered.indexOf("## Known non-goals");
    const dodIdx = rendered.indexOf("## Definition of Done");
    expect(decisionsIdx).toBeLessThan(vocabIdx);
    expect(vocabIdx).toBeLessThan(nonGoalsIdx);
    expect(nonGoalsIdx).toBeLessThan(dodIdx);
  });
});

describe("mergeContextDoc", () => {
  const existing = renderContextDoc({
    decisions: "We use Bun.\nWe use TypeScript.",
    vocabulary: "Issue means a Linear issue.",
    nonGoals: "We do not support Windows.",
    definitionOfDone: "- [ ] Tests written and passing",
  });

  test("refuses a proposal that drops a decision line without declaring it as a removal", () => {
    const result = mergeContextDoc(
      existing,
      {
        decisions: "We use Bun.",
        vocabulary: "Issue means a Linear issue.",
        nonGoals: "We do not support Windows.",
      },
      [],
    );
    expect(result.content).toBeNull();
    expect(result.undeclaredRemovals).toContain("We use TypeScript.");
  });

  test("accepts the same drop when a matching removals entry is supplied", () => {
    const removals: ContextDocRemoval[] = [
      { section: "decisions", text: "We use TypeScript.", reason: "superseded by JSDoc types" },
    ];
    const result = mergeContextDoc(
      existing,
      {
        decisions: "We use Bun.",
        vocabulary: "Issue means a Linear issue.",
        nonGoals: "We do not support Windows.",
      },
      removals,
    );
    expect(result.undeclaredRemovals).toEqual([]);
    expect(result.content).not.toBeNull();
    expect(result.content).not.toContain("We use TypeScript.");
  });

  test("treats an emphasis-marker-only difference as unchanged, not a removal", () => {
    const existingWithEmphasis = renderContextDoc({
      decisions: "_We use Bun._",
      vocabulary: "Issue means a Linear issue.",
      nonGoals: "We do not support Windows.",
      definitionOfDone: "- [ ] Tests written and passing",
    });
    // Simulates Linear rewriting `_text_` to `*text*` on write (docs/VERIFIED.md).
    const proposal = {
      decisions: "*We use Bun.*",
      vocabulary: "Issue means a Linear issue.",
      nonGoals: "We do not support Windows.",
    };
    const result = mergeContextDoc(existingWithEmphasis, proposal, []);
    expect(result.undeclaredRemovals).toEqual([]);
  });

  /*
   * Caught by a live round trip, not by reasoning: Linear rewrites a `- item`
   * bullet to `* item` as well as rewriting `_x_` to `*x*`. Normalising only
   * emphasis turned a `*` bullet into `_` while leaving a `-` bullet alone, so
   * a proposal that faithfully re-sent the line it had just read was refused
   * as an undeclared removal — which would have broken the second
   * `/foreman:context` run on any doc whose first run wrote a bullet list.
   */
  test("treats a rewritten list bullet as unchanged, not a removal", () => {
    const asWritten = renderContextDoc({
      decisions: "- We use Bun, not Node.",
      vocabulary: "- Issue means a Linear issue.",
      nonGoals: "- We do not support Windows.",
      definitionOfDone: "- [ ] Tests written and passing",
    });
    const asStoredByLinear = asWritten.replace(/^- (?!\[)/gm, "* ");
    expect(asStoredByLinear).toContain("* We use Bun, not Node.");

    const result = mergeContextDoc(
      asStoredByLinear,
      { decisions: "- We use Bun, not Node.", vocabulary: "- Issue means a Linear issue.", nonGoals: "- We do not support Windows." },
      [],
    );
    expect(result.undeclaredRemovals).toEqual([]);
    expect(result.content).toBeNull();
  });

  test("still refuses a dropped line whose bullet marker was rewritten", () => {
    const asStoredByLinear = renderContextDoc({
      decisions: "* We use Bun, not Node.\n* We vendor nothing.",
      vocabulary: "",
      nonGoals: "",
      definitionOfDone: "- [ ] Tests written and passing",
    });
    const result = mergeContextDoc(
      asStoredByLinear,
      { decisions: "- We use Bun, not Node.", vocabulary: "", nonGoals: "" },
      [],
    );
    expect(result.content).toBeNull();
    expect(result.undeclaredRemovals).toEqual(["* We vendor nothing."]);
  });

  test("returns null content for a no-change proposal", () => {
    const parsed = splitContextDoc(existing);
    const result = mergeContextDoc(
      existing,
      {
        decisions: parsed.decisions,
        vocabulary: parsed.vocabulary,
        nonGoals: parsed.nonGoals,
      },
      [],
    );
    expect(result.content).toBeNull();
    expect(result.undeclaredRemovals).toEqual([]);
  });

  test("carries the live definitionOfDone through verbatim regardless of proposal", () => {
    const parsed = splitContextDoc(existing);
    const result = mergeContextDoc(
      existing,
      {
        decisions: `${parsed.decisions}\nWe added a decision.`,
        vocabulary: parsed.vocabulary,
        nonGoals: parsed.nonGoals,
      },
      [],
    );
    expect(result.content).not.toBeNull();
    expect(splitContextDoc(result.content ?? "").definitionOfDone).toBe(parsed.definitionOfDone);
  });

  test("silently ignores a removals entry that matches nothing in the existing doc", () => {
    const parsed = splitContextDoc(existing);
    const result = mergeContextDoc(
      existing,
      {
        decisions: parsed.decisions,
        vocabulary: parsed.vocabulary,
        nonGoals: parsed.nonGoals,
      },
      [{ section: "decisions", text: "This line never existed.", reason: "stale" }],
    );
    expect(result.content).toBeNull();
    expect(result.undeclaredRemovals).toEqual([]);
  });
});
