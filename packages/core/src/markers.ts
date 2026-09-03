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

import { sanitizeAgentText } from "./sanitize.ts";

export const MARKER_KIND = {
  /** Lock ownership: dispatch id, timestamp, release state. */
  lock: "lock",
  /** A BlockRecord the operator has to answer. */
  block: "block",
  /** The operator's reply that clears a block. */
  unblock: "unblock",
  /** A rendered ReviewResult, pinned to a head SHA. */
  review: "review",
  /** A rendered ImplementResult. */
  implement: "implement",
  /** A branch or PR merge recorded by `/foreman:merge`, authoritative for direct-branch merge detection. */
  merged: "merged",
} as const;

export type MarkerKind = (typeof MARKER_KIND)[keyof typeof MARKER_KIND];

const MARKER_FIELD = "foreman";
const MARKER_VERSION = 1;

export interface MarkerEnvelope<T> {
  foreman: MarkerKind;
  version: number;
  data: T;
}

/** Payload of a `merged` marker (`MARKER_KIND.merged`), written by `/foreman:merge` in direct-branch mode. */
export interface MergedRecord {
  issueId: string;
  branch: string;
  baseBranch: string;
  mergeCommit: string;
  strategy: string;
  mergedAt: string;
}

/** A decoded marker plus the comment it came from. */
export interface FoundMarker<T> {
  commentId: string;
  createdAt: string;
  data: T;
}

const TRAILING_FENCE = /```json\s*\n([\s\S]*?)\n```\s*$/;

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
  return `${sanitizeAgentText(human).trimEnd()}\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``;
}

/** The payload of `body`'s trailing marker fence when it is of `kind`, or null — a fence anywhere earlier in the body is untrusted prose, not a marker. */
export function decodeMarker<T>(kind: MarkerKind, body: string): T | null {
  const match = TRAILING_FENCE.exec(body);
  const raw = match?.[1];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as MarkerEnvelope<T>)[MARKER_FIELD] === kind &&
    (parsed as MarkerEnvelope<T>).version === MARKER_VERSION
  ) {
    return (parsed as MarkerEnvelope<T>).data;
  }
  return null;
}

export interface MarkerSource {
  id: string;
  body: string;
  createdAt: string;
  /** The comment's author, when known. Null for sources (e.g. rendering-only reads) that don't need provenance. */
  user: { id: string } | null;
}

/** Options gating marker trust by comment authorship. Rendering-only reads omit this. */
export interface MarkerReadOptions {
  /**
   * When set, comments not authored by this user id are skipped entirely —
   * a forged marker from another Linear user cannot be read back as truth
   * by control-plane logic (lock ownership, review/merge gating, etc).
   */
  authoredBy?: string;
}

/** Every marker of `kind` across a comment list, oldest first. */
export function findMarkers<T>(
  kind: MarkerKind,
  comments: readonly MarkerSource[],
  options?: MarkerReadOptions,
): FoundMarker<T>[] {
  const found: FoundMarker<T>[] = [];
  for (const comment of comments) {
    if (options?.authoredBy !== undefined && comment.user?.id !== options.authoredBy) continue;
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
  options?: MarkerReadOptions,
): FoundMarker<T> | null {
  const all = findMarkers<T>(kind, comments, options);
  return all.length === 0 ? null : (all[all.length - 1] as FoundMarker<T>);
}
