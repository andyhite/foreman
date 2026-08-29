/**
 * One-word status pills (agent status, run state, stage) used inline in
 * tables, tab bars and the header. Deliberately just a themed string, not a
 * drawing function: it needs to compose inside table cells and tab labels
 * that already own their own layout.
 */

import type { Theme, ToneName } from "../theme.ts";

export type BadgeKind = "ok" | "warn" | "danger" | "muted" | "info";

const TONE_BY_KIND: Record<BadgeKind, ToneName> = {
  ok: "badgeOk",
  warn: "badgeWarn",
  danger: "badgeDanger",
  muted: "badgeMuted",
  info: "info",
};

export function badge(theme: Theme, text: string, kind: BadgeKind): string {
  return theme.tone(TONE_BY_KIND[kind], ` ${text} `);
}
