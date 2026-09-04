import type { Initiative, InitiativeRef, LinearReader } from "@foreman/core";
import { describe, expect, it } from "bun:test";
import { fetchInitiativeDigest } from "../src/runtime.ts";

/**
 * The optional initiative layer of the context digest (SPEC §4.7). Every rule
 * here is an omission rule: an initiative is operator-maintained background
 * that Foreman reads and never writes, so the layer has to disappear cleanly
 * in each way it can be absent, ambiguous, or unreadable — and it must never
 * cost the caller the product and project layers, which carry the Definition
 * of Done `foreman-review` grades against.
 */

function doc(title: string, content: string | null) {
  return { id: `doc-${title}`, title, content, updatedAt: "2026-01-01T00:00:00.000Z" };
}

/**
 * Only the two members under test are real. Anything else this reader is asked
 * for is a bug in the code path, so it throws rather than returning a
 * plausible empty value that would hide the call.
 */
function makeReader(overrides: {
  projectInitiatives: () => Promise<InitiativeRef[]>;
  initiative?: (id: string) => Promise<Initiative | null>;
}): LinearReader {
  return new Proxy({} as LinearReader, {
    get(_target, prop) {
      if (prop === "projectInitiatives") return overrides.projectInitiatives;
      if (prop === "initiative") return overrides.initiative ?? (async () => null);
      return () => {
        throw new Error(`unexpected LinearReader.${String(prop)} call`);
      };
    },
  });
}

const ONE_REF: InitiativeRef[] = [{ id: "init-1", name: "Plotroom Fleet" }];

describe("fetchInitiativeDigest", () => {
  it("omits the layer when the project belongs to no initiative", async () => {
    const reader = makeReader({ projectInitiatives: async () => [] });
    expect(await fetchInitiativeDigest(reader, "project-1")).toBeNull();
  });

  it("renders the layer when the project belongs to exactly one initiative with a document", async () => {
    const reader = makeReader({
      projectInitiatives: async () => ONE_REF,
      initiative: async () => ({
        id: "init-1",
        name: "Plotroom Fleet",
        documents: [doc("Charter", "Fleet owns the host-facing surface.")],
      }),
    });

    expect(await fetchInitiativeDigest(reader, "project-1")).toBe(
      "## Initiative (Plotroom Fleet)\n### Charter\nFleet owns the host-facing surface.",
    );
  });

  it("omits the layer when the project belongs to two initiatives", async () => {
    // Two is ambiguous, and no routing decision may pick one, so the layer is
    // dropped rather than guessed at.
    const reader = makeReader({
      projectInitiatives: async () => [
        { id: "init-1", name: "Plotroom Fleet" },
        { id: "init-2", name: "Plotroom Zero" },
      ],
      initiative: async () => {
        throw new Error("must not resolve an initiative when membership is ambiguous");
      },
    });

    expect(await fetchInitiativeDigest(reader, "project-1")).toBeNull();
  });

  it("omits the layer when the referenced initiative no longer resolves", async () => {
    const reader = makeReader({ projectInitiatives: async () => ONE_REF, initiative: async () => null });
    expect(await fetchInitiativeDigest(reader, "project-1")).toBeNull();
  });

  it("omits the layer entirely rather than emitting a bare heading when every document is empty", async () => {
    const reader = makeReader({
      projectInitiatives: async () => ONE_REF,
      initiative: async () => ({
        id: "init-1",
        name: "Plotroom Fleet",
        documents: [doc("Untouched", null), doc("Whitespace", "   \n  ")],
      }),
    });

    expect(await fetchInitiativeDigest(reader, "project-1")).toBeNull();
  });

  it("renders every document with content and skips the empty ones", async () => {
    const reader = makeReader({
      projectInitiatives: async () => ONE_REF,
      initiative: async () => ({
        id: "init-1",
        name: "Plotroom Fleet",
        documents: [doc("Charter", "Owns the host surface."), doc("Empty", ""), doc("Bounds", "No cross-host writes.")],
      }),
    });

    expect(await fetchInitiativeDigest(reader, "project-1")).toBe(
      "## Initiative (Plotroom Fleet)\n### Charter\nOwns the host surface.\n\n### Bounds\nNo cross-host writes.",
    );
  });

  it("swallows a failed initiative read so the caller keeps its product and project layers", async () => {
    const reader = makeReader({
      projectInitiatives: async () => {
        throw new Error("Entity not found: Project");
      },
    });

    expect(await fetchInitiativeDigest(reader, "project-1")).toBeNull();
  });

  it("swallows a failure resolving the initiative itself, not just its membership", async () => {
    const reader = makeReader({
      projectInitiatives: async () => ONE_REF,
      initiative: async () => {
        throw new Error("500 Internal Server Error");
      },
    });

    expect(await fetchInitiativeDigest(reader, "project-1")).toBeNull();
  });
});
