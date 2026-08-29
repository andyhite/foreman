/**
 * A hand-rolled stdin decoder. `node:readline`'s keypress emulation exists
 * but is tied to its own interface and line-editing state machine, which
 * fights a full-screen renderer that wants raw, synchronous key events with
 * no echo and no line buffering. Terminals disagree on the exact bytes for
 * modified arrows and function keys; this decoder normalizes the common
 * xterm/vt220 forms rather than chasing every terminfo entry.
 */

export interface Key {
  readonly name: string;
  readonly char: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly raw: string;
}

function plain(name: string, char: string, raw: string, mods?: { ctrl?: boolean; alt?: boolean; shift?: boolean }): Key {
  return {
    name,
    char,
    ctrl: mods?.ctrl ?? false,
    alt: mods?.alt ?? false,
    shift: mods?.shift ?? false,
    raw,
  };
}

// xterm modifier parameter: 1=none, then bitmask+1 (1 shift, 2 alt, 4 ctrl).
function decodeModifier(param: string | undefined): { shift: boolean; alt: boolean; ctrl: boolean } {
  const n = param ? Number.parseInt(param, 10) : 1;
  const bits = Number.isFinite(n) ? Math.max(0, n - 1) : 0;
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

const CSI_LETTER_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "backtab",
};

const SS3_LETTER_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const TILDE_NAMES: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
};

const CTRL_LETTER_EXCEPTIONS: Record<string, true> = {
  "\r": true,
  "\n": true,
  "\t": true,
  "\x7f": true,
  "\x08": true,
  "\x1b": true,
};

function decodeControlChar(ch: string): Key | null {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 1 && code <= 26 && !CTRL_LETTER_EXCEPTIONS[ch]) {
    const letter = String.fromCharCode(code + 96);
    return plain(letter, letter, ch, { ctrl: true });
  }
  return null;
}

interface Cursor {
  text: string;
  pos: number;
}

function tryConsumeCsi(cursor: Cursor): Key | null {
  const { text } = cursor;
  const start = cursor.pos;
  if (text.slice(start, start + 2) !== "\x1b[") return null;

  // Bracketed paste wrappers: consume and drop, or unwrap the body.
  if (text.startsWith("\x1b[200~", start)) {
    cursor.pos = start + 6;
    return null; // signalled via caller loop, see decodeKeys paste handling
  }
  if (text.startsWith("\x1b[201~", start)) {
    cursor.pos = start + 6;
    return null;
  }

  const match = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(text.slice(start));
  if (!match) return null;
  const params = match[1] ?? "";
  const finalByte = match[2] ?? "";
  const raw = match[0];
  cursor.pos = start + raw.length;

  const parts = params.split(";");
  if (finalByte === "~") {
    const codeParam = parts[0] ?? "";
    const modParam = parts[1];
    const name = TILDE_NAMES[codeParam];
    if (!name) return plain("unknown", "", raw);
    const mods = decodeModifier(modParam);
    return plain(name, "", raw, mods);
  }

  const name = CSI_LETTER_NAMES[finalByte];
  if (!name) return plain("unknown", "", raw);
  // "\x1b[1;5C" form: params[0] is always "1" (ignored), params[1] is the modifier.
  const modParam = parts.length > 1 ? parts[1] : parts[0];
  const mods = params === "" ? { shift: false, alt: false, ctrl: false } : decodeModifier(modParam);
  return plain(name, "", raw, mods);
}

function tryConsumeSs3(cursor: Cursor): Key | null {
  const { text } = cursor;
  const start = cursor.pos;
  if (text.slice(start, start + 2) !== "\x1bO") return null;
  const letter = text[start + 2];
  if (letter === undefined) return null;
  const name = SS3_LETTER_NAMES[letter];
  cursor.pos = start + 3;
  const raw = text.slice(start, start + 3);
  if (!name) return plain("unknown", "", raw);
  return plain(name, "", raw);
}

/** Decodes one raw stdin chunk into zero or more keys. */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  const cursor: Cursor = { text: chunk, pos: 0 };
  const { text } = cursor;

  while (cursor.pos < text.length) {
    const start = cursor.pos;
    const ch = text[start] ?? "";

    // Bracketed paste: emit the pasted body as literal printable keys.
    if (text.startsWith("\x1b[200~", start)) {
      const end = text.indexOf("\x1b[201~", start + 6);
      const body = end === -1 ? text.slice(start + 6) : text.slice(start + 6, end);
      for (const pastedChar of body) {
        keys.push(plain(pastedChar === " " ? "space" : pastedChar, pastedChar, pastedChar));
      }
      cursor.pos = end === -1 ? text.length : end + 6;
      continue;
    }

    if (ch === "\x1b") {
      // CSI sequence.
      if (text[start + 1] === "[") {
        const before = cursor.pos;
        const key = tryConsumeCsi(cursor);
        if (key) {
          keys.push(key);
          continue;
        }
        if (cursor.pos !== before) continue; // consumed (e.g. paste wrapper stray)
        // Unrecognized CSI: consume the introducer to avoid leaking bytes.
        cursor.pos = start + 2;
        continue;
      }
      // SS3 sequence.
      if (text[start + 1] === "O") {
        const key = tryConsumeSs3(cursor);
        if (key) {
          keys.push(key);
          continue;
        }
        cursor.pos = start + 2;
        continue;
      }
      // Lone escape.
      if (start + 1 >= text.length) {
        keys.push(plain("escape", "", ch));
        cursor.pos = start + 1;
        continue;
      }
      // Alt + printable.
      const next = text[start + 1] ?? "";
      keys.push(plain(next === " " ? "space" : next, next, "\x1b" + next, { alt: true }));
      cursor.pos = start + 2;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      keys.push(plain("enter", "", ch));
      cursor.pos = start + 1;
      continue;
    }
    if (ch === "\t") {
      keys.push(plain("tab", "", ch));
      cursor.pos = start + 1;
      continue;
    }
    if (ch === "\x7f" || ch === "\x08") {
      keys.push(plain("backspace", "", ch));
      cursor.pos = start + 1;
      continue;
    }
    if (ch === " ") {
      keys.push(plain("space", " ", ch));
      cursor.pos = start + 1;
      continue;
    }

    const controlKey = decodeControlChar(ch);
    if (controlKey) {
      keys.push(controlKey);
      cursor.pos = start + 1;
      continue;
    }

    const codePoint = text.codePointAt(start);
    const literal = codePoint !== undefined ? String.fromCodePoint(codePoint) : ch;
    keys.push(plain(literal, literal, literal));
    cursor.pos = start + literal.length;
  }

  return keys;
}

/** Human-readable label for a key, for footer hint bars. */
export function keyLabel(key: Key): string {
  const parts: string[] = [];
  if (key.ctrl) parts.push("ctrl");
  if (key.alt) parts.push("alt");
  if (key.shift && key.name !== "backtab") parts.push("shift");

  const arrowGlyphs: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };
  const base = arrowGlyphs[key.name] ?? key.name;
  parts.push(base === "" ? key.char : base);
  return parts.join("-");
}

const MODIFIER_NAMES: Record<string, true> = { ctrl: true, alt: true, shift: true, meta: true };

/** Matches a decoded key against a spec like "ctrl-s", "alt-1", "up", "?". */
export function matchesKey(key: Key, spec: string): boolean {
  const segments = spec.split("-");
  const trailing = segments[segments.length - 1] ?? "";
  const modifierSegments = segments.slice(0, -1).map((s) => s.toLowerCase());

  let wantCtrl = false;
  let wantAlt = false;
  let wantShift = false;
  for (const seg of modifierSegments) {
    if (!MODIFIER_NAMES[seg]) return false;
    if (seg === "ctrl") wantCtrl = true;
    else if (seg === "alt" || seg === "meta") wantAlt = true;
    else if (seg === "shift") wantShift = true;
  }

  if (wantCtrl !== key.ctrl) return false;
  if (wantAlt !== key.alt) return false;

  if (trailing.length === 1) {
    if (key.char !== trailing) return false;
    return true;
  }

  if (wantShift !== key.shift && key.name !== "backtab") {
    // Names other than single characters may or may not track shift
    // (e.g. arrow keys with shift); only enforce when explicitly requested.
    if (wantShift && !key.shift) return false;
  }

  return key.name.toLowerCase() === trailing.toLowerCase();
}
