/**
 * Footer key-hint bar. The footer is one row and the hint list is
 * open-ended per view, so hints must drop whole pairs from the end rather
 * than truncate mid-pair — a half-rendered "ctrl-" is worse than a shorter
 * list.
 */

import type { Theme } from "../theme.ts";
import { stringWidth } from "../width.ts";

export function keyHints(theme: Theme, hints: readonly (readonly [string, string])[], width: number): string {
  if (width <= 0) return "";

  const rendered: string[] = [];
  let used = 0;
  for (const [key, label] of hints) {
    const plain = `${key} ${label}`;
    const separator = rendered.length > 0 ? " · " : "";
    const additional = stringWidth(separator) + stringWidth(plain);
    if (used + additional > width) break;
    rendered.push(`${separator}${theme.tone("key", key)} ${theme.tone("muted", label)}`);
    used += additional;
  }
  return rendered.join("");
}
