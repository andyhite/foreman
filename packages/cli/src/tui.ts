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
  "8888888888                                                       ",
  "888                                                              ",
  "888                                                              ",
  "8888888  .d88b.  888d888 .d88b.  88888b.d88b.   8888b.  88888b.  ",
  "888     d88\"\"88b 888P\"  d8P  Y8b 888 \"888 \"88b     \"88b 888 \"88b ",
  "888     888  888 888    88888888 888  888  888 .d888888 888  888 ",
  "888     Y88..88P 888    Y8b.     888  888  888 888  888 888  888 ",
  "888      \"Y88P\"  888     \"Y8888  888  888  888 \"Y888888 888  888 ",
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
