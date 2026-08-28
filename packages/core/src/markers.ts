/**
 * Machine-readable payloads embedded in Linear comments.
 *
 * Foreman keeps no second store: approval state, lock ownership, block records,
 * and review results are all derivable from Linear alone (SPEC §7.1, §11). That
 * only works if a comment can carry structure a worker can parse without
 * guessing, so every Foreman comment is a human rendering followed by one fenced
 * JSON block tagged with its kind.
 *
 * Parsing is by JSON content, not by position or heading text: regex-matching a
 * markdown heading is exactly the fragility the structured-output design exists
 * to remove.
 */

export const MARKER_KIND = {
  /** Lock ownership: dispatch id, timestamp, release state. */
  lock: "lock",
  /** One triage proposal item, awaiting approval. */
  proposal: "proposal",
  /** Written after an approved proposal is applied, so it is never applied twice. */
  applied: "applied",
  /** A BlockRecord the operator has to answer. */
  block: "block",
  /** The operator's reply that clears a block. */
  unblock: "unblock",
  /** A rendered ReviewResult, pinned to a head SHA. */
  review: "review",
  /** A rendered ImplementResult. */
  implement: "implement",
  /** Blocking review findings routed back to implement. */
  findings: "findings",
  /** A dispatch failed twice and was converted to a decision (SPEC §17.8). */
  failure: "failure",
} as const;

export type MarkerKind = (typeof MARKER_KIND)[keyof typeof MARKER_KIND];

const MARKER_FIELD = "foreman";
const MARKER_VERSION = 1;

export interface MarkerEnvelope<T> {
  foreman: MarkerKind;
  version: number;
  data: T;
}

/** A decoded marker plus the comment it came from. */
export interface FoundMarker<T> {
  commentId: string;
  createdAt: string;
  data: T;
}

const FENCE = /```json\s*\n([\s\S]*?)\n```/g;

/**
 * Render a comment body: human prose, then the machine copy.
 *
 * The human half is what the operator reads in Linear; the JSON half is what
 * `/foreman:apply`, the reaper, and the review worker read back.
 */
export function encodeMarker<T>(kind: MarkerKind, data: T, human: string): string {
  const envelope: MarkerEnvelope<T> = {
    [MARKER_FIELD]: kind,
    version: MARKER_VERSION,
    data,
  } as MarkerEnvelope<T>;
  return `${human.trimEnd()}\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``;
}

/** The payload of the first marker of `kind` in `body`, or null. */
export function decodeMarker<T>(kind: MarkerKind, body: string): T | null {
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(body); match !== null; match = FENCE.exec(body)) {
    const raw = match[1];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as MarkerEnvelope<T>)[MARKER_FIELD] === kind
    ) {
      return (parsed as MarkerEnvelope<T>).data;
    }
  }
  return null;
}

export interface MarkerSource {
  id: string;
  body: string;
  createdAt: string;
}

/** Every marker of `kind` across a comment list, oldest first. */
export function findMarkers<T>(
  kind: MarkerKind,
  comments: readonly MarkerSource[],
): FoundMarker<T>[] {
  const found: FoundMarker<T>[] = [];
  for (const comment of comments) {
    const data = decodeMarker<T>(kind, comment.body);
    if (data !== null) {
      found.push({ commentId: comment.id, createdAt: comment.createdAt, data });
    }
  }
  found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return found;
}

/** The newest marker of `kind`, or null. */
export function latestMarker<T>(
  kind: MarkerKind,
  comments: readonly MarkerSource[],
): FoundMarker<T> | null {
  const all = findMarkers<T>(kind, comments);
  return all.length === 0 ? null : (all[all.length - 1] as FoundMarker<T>);
}
