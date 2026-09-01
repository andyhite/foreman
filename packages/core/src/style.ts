/**
 * Shared 16-color ANSI styling for `foreman setup`/`foreman init`'s terminal
 * output.
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

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** Wraps `text` in the named SGR code; returns `text` untouched when stdout isn't a color-capable TTY or `$NO_COLOR` is set. */
export function style(name: StyleName, text: string): string {
  if (!enabled) return text;
  return `\x1b[${CODES[name]}m${text}\x1b[0m`;
}
