/**
 * ANSI styling for `foreman setup` output.
 *
 * Hand-rolled, same rationale as `prompt.ts`: no chalk/kleur dependency.
 * Styling is disabled outright when stdout isn't a TTY or `$NO_COLOR` is
 * set, so piped output (CI logs, `foo | tee setup.log`) stays plain text
 * instead of littered with escape codes.
 */

const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const CODES = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

type StyleName = keyof typeof CODES;

/** Wraps `text` in the named SGR code, or returns it untouched when styling is disabled. */
export function style(name: StyleName, text: string): string {
  return colorEnabled ? `\x1b[${CODES[name]}m${text}\x1b[0m` : text;
}

const BANNER_LINES = [
  " ___                                  ",
  "|  _|___  ___ ___ _____ ___ ___     ",
  "|  _| . || .'|   |     | .'|   |    ",
  "|_| |___||__,|_|_|_|_|_|__,|_|_|    ",
];

/** Prints the `foreman setup` banner once, at the top of the wizard. */
export function printBanner(log: (message: string) => void): void {
  log("");
  for (const line of BANNER_LINES) log(style("cyan", style("bold", line)));
  log(style("dim", "  Foreman setup — Linear + omp installer"));
}

/** Prints a boxed section header: a colored rule, the title, and a matching rule. */
export function printSection(log: (message: string) => void, title: string): void {
  const rule = "─".repeat(Math.max(2, 60 - title.length));
  log("");
  log(`${style("cyan", "──")} ${style("bold", title)} ${style("cyan", rule)}`);
}

/** One indented status line, e.g. `  ✓ bun: found` or `  ✗ gh: not found`. */
export function statusLine(ok: boolean, text: string): string {
  const mark = ok ? style("green", "✓") : style("yellow", "○");
  return `  ${mark} ${text}`;
}
