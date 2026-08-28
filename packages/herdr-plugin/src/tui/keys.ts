/**
 * Raw-byte key decoding for the board TUI (SPEC §17.4). No dependency: herdr
 * plugins carry only `@sinclair/typebox` in this workspace, so terminal input
 * is decoded by hand from `process.stdin` bytes.
 *
 * Escape sequences arrive from the terminal in a burst, but a slow pipe (SSH,
 * a loaded terminal emulator) can split `ESC [ A` across two `read` events.
 * `KeyDecoder` is a small state machine that buffers a leading ESC until
 * either more bytes complete the sequence or a timer decides it was a bare
 * Escape keypress.
 */

export type Key =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "enter" }
  | { kind: "escape" }
  | { kind: "tab" }
  | { kind: "backspace" }
  | { kind: "digit"; value: number }
  | { kind: "char"; value: string }
  | { kind: "ctrl"; value: string };

const ESC = 0x1b;
const CR = 0x0d;
const LF = 0x0a;
const TAB = 0x09;
const BACKSPACE = 0x7f;

const CSI_FINAL = /[A-Za-z~]/;

/** Complete (non-escape) sequences recognized after `ESC [`. */
function decodeCsi(body: string): Key | null {
  switch (body) {
    case "A":
      return { kind: "up" };
    case "B":
      return { kind: "down" };
    case "C":
      return { kind: "right" };
    case "D":
      return { kind: "left" };
    default:
      return null;
  }
}

function decodeSingleByte(byte: number): Key | null {
  if (byte === CR || byte === LF) return { kind: "enter" };
  if (byte === TAB) return { kind: "tab" };
  if (byte === BACKSPACE) return { kind: "backspace" };
  if (byte >= 0x30 && byte <= 0x39) return { kind: "digit", value: byte - 0x30 };
  if (byte >= 0x01 && byte <= 0x1a && byte !== TAB) {
    return { kind: "ctrl", value: String.fromCharCode(byte + 0x60) };
  }
  if (byte >= 0x20 && byte < 0x7f) {
    return { kind: "char", value: String.fromCharCode(byte) };
  }
  return null;
}

/**
 * Stateful decoder: feed raw chunks via `push`, receive zero or more `Key`s.
 * A trailing lone ESC is held until `flushPendingEscape` (call on a short
 * timer, e.g. 50ms) resolves it to a bare `escape` key.
 */
export class KeyDecoder {
  private pending: number[] = [];

  push(chunk: Uint8Array): Key[] {
    const keys: Key[] = [];
    const bytes = [...this.pending, ...chunk];
    this.pending = [];

    let i = 0;
    while (i < bytes.length) {
      const byte = bytes[i];
      if (byte === undefined) break;

      if (byte === ESC) {
        const next = bytes[i + 1];
        if (next === undefined) {
          // Lone ESC at the end of this chunk: might be a bare Escape, or the
          // sequence continues in the next push(). Hold it.
          this.pending = [byte];
          i += 1;
          continue;
        }
        if (next !== 0x5b /* '[' */ && next !== 0x4f /* 'O' */) {
          keys.push({ kind: "escape" });
          i += 1;
          continue;
        }
        // Scan forward for the CSI/SS3 final byte, which may not have arrived yet.
        let j = i + 2;
        while (j < bytes.length) {
          const b = bytes[j];
          if (b !== undefined && CSI_FINAL.test(String.fromCharCode(b))) break;
          j += 1;
        }
        const finalByte = bytes[j];
        if (finalByte === undefined) {
          // Sequence not yet complete; hold everything from ESC onward.
          this.pending = bytes.slice(i);
          i = bytes.length;
          continue;
        }
        const body = String.fromCharCode(finalByte);
        const decoded = decodeCsi(body);
        if (decoded) keys.push(decoded);
        i = j + 1;
        continue;
      }

      if (byte === 0x6a /* 'j' */) {
        keys.push({ kind: "down" });
        i += 1;
        continue;
      }
      if (byte === 0x6b /* 'k' */) {
        keys.push({ kind: "up" });
        i += 1;
        continue;
      }

      const decoded = decodeSingleByte(byte);
      if (decoded) keys.push(decoded);
      i += 1;
    }

    return keys;
  }

  /** Resolve a held lone ESC to a bare Escape key once no continuation arrives. */
  flushPendingEscape(): Key | null {
    if (this.pending.length === 1 && this.pending[0] === ESC) {
      this.pending = [];
      return { kind: "escape" };
    }
    return null;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
