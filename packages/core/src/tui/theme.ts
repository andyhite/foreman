/**
 * Shared terminal styling for every Foreman surface that renders to a real
 * TTY (the herdr board, `foreman loop`'s console output, `foreman setup`).
 *
 * Truecolor is deliberately not used — 16-color SGR only, safe across herdr
 * panes, tmux, and SSH. `packages/core/src/render/status.ts` renders into an
 * omp chat session instead of a terminal and must never import this module;
 * it stays Markdown.
 */

const CODES = {
  bold: 1,
  dim: 2,
  reverse: 7,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

export type StyleName = keyof typeof CODES;

export type ToneName = "title" | "muted" | "selected" | "danger" | "warn" | "ok" | "accent";

const TONES: Record<ToneName, readonly StyleName[]> = {
  title: ["bold"],
  muted: ["dim"],
  selected: ["reverse"],
  danger: ["bold", "red"],
  warn: ["yellow"],
  ok: ["green"],
  accent: ["cyan"],
};

export interface Theme {
  readonly enabled: boolean;
  style(name: StyleName, text: string): string;
  tone(name: ToneName, text: string): string;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strips SGR escape sequences, e.g. before measuring or logging plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Length of `text` as it will actually occupy on screen, ignoring escape bytes. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Builds a `Theme`. When `enabled` is false, `style`/`tone` return `text` untouched. */
export function createTheme(enabled: boolean): Theme {
  return {
    enabled,
    style(name, text) {
      if (!enabled) return text;
      return `\x1b[${CODES[name]}m${text}\x1b[0m`;
    },
    tone(name, text) {
      if (!enabled) return text;
      const codes = TONES[name].map((styleName) => CODES[styleName]).join(";");
      return `\x1b[${codes}m${text}\x1b[0m`;
    },
  };
}

/** Styling on when stdout is a TTY and `$NO_COLOR` is unset; matches the prior CLI-only default. */
export const defaultTheme: Theme = createTheme(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

/** Convenience wrapper delegating to `defaultTheme`, for call sites that don't thread a `Theme`. */
export function style(name: StyleName, text: string): string {
  return defaultTheme.style(name, text);
}
