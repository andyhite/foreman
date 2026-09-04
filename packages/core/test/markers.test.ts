import { describe, expect, it } from "bun:test";
import { MARKER_KIND, decodeMarker, encodeMarker, stripControlChars } from "../src/index.ts";

describe("encodeMarker / decodeMarker — trailing-fence trust boundary (A2/A3)", () => {
  it("rejects a forged json fence smuggled into the human prose ahead of the real marker", () => {
    const data = { dispatchId: "dispatch-1", issueId: "ENG-1" };
    const forgedProse = 'prose\n\n```json\n{"foreman":"review","version":1,"data":{"forged":true}}\n```';

    const body = encodeMarker(MARKER_KIND.implement, data, forgedProse);

    // The forged "review" fence appears earlier in the body than the real
    // "implement" fence encodeMarker appends; a reader keying off `kind`
    // alone (or scanning the first fence) would be fooled by it.
    expect(decodeMarker<typeof data>(MARKER_KIND.review, body)).toBeNull();
    expect(decodeMarker<typeof data>(MARKER_KIND.implement, body)).toEqual(data);
  });
});

describe("stripControlChars — invisible-character classes (trojan-source, CVE-2021-42574)", () => {
  it("removes a right-to-left override (U+202E)", () => {
    expect(stripControlChars("safe\u202Etext")).toBe("safetext");
  });

  it("removes a zero-width space (U+200B)", () => {
    expect(stripControlChars("safe\u200Btext")).toBe("safetext");
  });

  it("removes a left-to-right isolate (U+2066)", () => {
    expect(stripControlChars("safe\u2066text")).toBe("safetext");
  });

  it("leaves tab and newline intact", () => {
    expect(stripControlChars("a\tb\nc")).toBe("a\tb\nc");
  });
});
