/**
 * Column-width math for a 16-color terminal renderer. Every widget lays out
 * against terminal *columns*, not JS string length or UTF-16 code units —
 * East Asian wide characters occupy two columns, combining marks and
 * variation selectors occupy zero, and SGR escape bytes occupy none at all.
 * Getting this wrong is what makes box-drawing borders drift by a column
 * whenever a title or log line contains CJK text or an emoji.
 *
 * This module is the single source of truth for width; `theme.ts`,
 * `canvas.ts`, and every widget delegate to it instead of re-deriving it.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x200b, 0x200f], // zero-width space/joiners, direction marks
  [0xfe00, 0xfe0f], // variation selectors
  [0x20d0, 0x20f0],
];

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial
  [0x1160, 0x11ff], // Hangul Jamo medial/final (wide, not zero — see below)
  [0x2600, 0x27bf], // misc symbols / dingbats (✅ ❌ ⚠ ✨)
  [0x2b50, 0x2b50], // ⭐
  [0x2e80, 0x303e], // CJK radicals .. just before 0x303f
  [0x3040, 0xa4cf], // resumes after excluding 0x303f
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f1e6, 0x1f1ff], // regional indicators (flag letters)
  [0x1f300, 0x1f64f], // misc symbols / emoji
  [0x1f680, 0x1f6ff], // transport & map symbols (🚀 🚧 🛑)
  [0x1f900, 0x1f9ff], // supplemental symbols / emoji
  [0x1fa70, 0x1faff], // symbols and pictographs extended-a
  [0x20000, 0x3fffd], // CJK extension planes
];

// Skin-tone modifiers (Fitzpatrix U+1F3FB-1F3FF) combine with a preceding
// emoji via a ZWJ/base sequence that the terminal renders as one wide
// glyph, not two — but they fall inside the emoji WIDE_RANGES above and
// would otherwise double-count a modified emoji. Treat them as zero-width,
// the least-wrong simple model for a renderer with no cluster awareness:
// it undercounts unmodified use of the modifier alone (rare) instead of
// overcounting every modified emoji (common).
const SKIN_TONE_MODIFIERS: readonly [number, number] = [0x1f3fb, 0x1f3ff];

// Hangul Jamo medial/final (U+1160-U+11FF) is listed as zero-width in the
// spec above (it combines with a preceding initial to form one wide
// syllable block); wide-range Jamo initials still register as wide.
const HANGUL_JAMO_COMBINING: readonly [number, number] = [0x1160, 0x11ff];

function inRanges(codePoint: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/** Width of one Unicode code point in terminal columns: 0, 1, or 2. */
export function charWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint === 0) return 0;
  if (codePoint >= HANGUL_JAMO_COMBINING[0] && codePoint <= HANGUL_JAMO_COMBINING[1]) return 0;
  if (codePoint >= SKIN_TONE_MODIFIERS[0] && codePoint <= SKIN_TONE_MODIFIERS[1]) return 0;
  if (inRanges(codePoint, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

/** Visible column width of `text`, ANSI-aware and grapheme-aware. */
export function stringWidth(text: string): number {
  let width = 0;
  // Strip SGR runs first so iterating code points below never sees escape
  // bytes; positions don't matter here, only total width.
  const rest = text.replace(ANSI_RE, "");
  for (const ch of rest) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    width += charWidth(codePoint);
  }
  return width;
}

/**
 * Truncates `text` to at most `width` columns, counting SGR sequences as
 * free. Never splits an escape sequence, and if the cut lands inside a
 * styled run, appends a reset so the terminal doesn't bleed color into
 * whatever follows.
 */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  const ellipsisWidth = stringWidth(ellipsis);
  let out = "";
  let col = 0;
  let styled = false;
  let cut = false;
  let i = 0;
  const budget = Math.max(0, width - (stringWidth(text) > width ? ellipsisWidth : 0));

  while (i < text.length) {
    const match = text.startsWith("\x1b[", i) ? /^\x1b\[[0-9;]*m/.exec(text.slice(i)) : null;
    if (match) {
      out += match[0];
      styled = match[0] !== "\x1b[0m" && !/^\x1b\[0?m$/.test(match[0]);
      i += match[0].length;
      continue;
    }
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const ch = String.fromCodePoint(codePoint);
    const w = charWidth(codePoint);
    if (col + w > budget) {
      cut = true;
      break;
    }
    out += ch;
    col += w;
    i += ch.length;
  }

  if (cut) {
    if (styled) out += "\x1b[0m";
    out += ellipsis;
  }
  return out;
}

/** Pads or truncates `text` to exactly `width` columns. */
export function padTo(text: string, width: number, align: "left" | "right" | "center" = "left"): string {
  if (width <= 0) return "";
  const w = stringWidth(text);
  if (w > width) {
    // A wide char can land the cut a column short of `width` (e.g. the
    // ellipsis replaces a 2-column char with a 1-column one); pad the
    // truncated result back up so every cell downstream stays aligned.
    const truncated = truncate(text, width);
    const truncatedWidth = stringWidth(truncated);
    return truncatedWidth < width ? truncated + " ".repeat(width - truncatedWidth) : truncated;
  }
  const gap = width - w;
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    const right = gap - left;
    return " ".repeat(left) + text + " ".repeat(right);
  }
  return text + " ".repeat(gap);
}

/** Word-wraps plain (unstyled) text to `width` columns, preserving explicit newlines. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return text.length > 0 ? [""] : [];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const word of paragraph.split(" ")) {
      const wordWidth = stringWidth(word);
      if (wordWidth > width) {
        if (current !== "") {
          lines.push(current);
          current = "";
          currentWidth = 0;
        }
        // Hard-break a token longer than the available width.
        let remaining = word;
        while (stringWidth(remaining) > width) {
          let cut = 0;
          let col = 0;
          for (const ch of remaining) {
            const codePoint = ch.codePointAt(0);
            const w = codePoint === undefined ? 1 : charWidth(codePoint);
            if (col + w > width) break;
            col += w;
            cut += ch.length;
          }
          // A single wide char wider than `width` (e.g. width 1) never
          // fits: force one code point of progress so this always
          // terminates instead of pushing empty lines forever.
          if (cut === 0) cut = [...remaining][0]?.length ?? remaining.length;
          lines.push(remaining.slice(0, cut));
          remaining = remaining.slice(cut);
        }
        current = remaining;
        currentWidth = stringWidth(remaining);
        continue;
      }
      const sep = current === "" ? "" : " ";
      const nextWidth = currentWidth + (sep === "" ? 0 : 1) + wordWidth;
      if (nextWidth > width) {
        lines.push(current);
        current = word;
        currentWidth = wordWidth;
      } else {
        current += sep + word;
        currentWidth = nextWidth;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}
