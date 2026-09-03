/**
 * Label vocabulary (SPEC §4.5).
 *
 * Every label here is read by a gate validator or a worker predicate. Adding one
 * that nothing reads is the thing this file exists to prevent.
 */

export const LABEL_GROUP = {
  foreman: "foreman:",
  type: "type:",
} as const;

export type LabelGroupName = keyof typeof LABEL_GROUP;

/** `type:` ⊕ — informational classification, read by no gate or rule. */
export const TYPE_LABEL = {
  bug: "type:bug",
  feature: "type:feature",
  chore: "type:chore",
  spike: "type:spike",
  docs: "type:docs",
} as const;

export type TypeLabel = (typeof TYPE_LABEL)[keyof typeof TYPE_LABEL];
export const TYPE_LABELS = Object.values(TYPE_LABEL) as TypeLabel[];

/** `foreman:` ⊕ — the one managed group carrying what status cannot. */
export const FOREMAN_LABEL = {
  running: "foreman:running",
  blocked: "foreman:blocked",
  handsOff: "foreman:hands-off",
} as const;

export type ForemanLabel = (typeof FOREMAN_LABEL)[keyof typeof FOREMAN_LABEL];
export const FOREMAN_LABELS = Object.values(FOREMAN_LABEL) as ForemanLabel[];

/** Every label Foreman itself creates at install time. */
export const MANAGED_LABELS: readonly string[] = [...TYPE_LABELS, ...FOREMAN_LABELS];

/** Groups that Linear should enforce as mutually exclusive. */
export const MANAGED_LABEL_GROUPS: ReadonlyArray<{
  prefix: string;
  members: readonly string[];
}> = [
  { prefix: LABEL_GROUP.type, members: TYPE_LABELS },
  { prefix: LABEL_GROUP.foreman, members: FOREMAN_LABELS },
];

export interface HasLabels {
  labels: ReadonlyArray<{ name: string }>;
}

export function labelNames(target: HasLabels): string[] {
  return target.labels.map((label) => label.name);
}

export function hasLabel(target: HasLabels, name: string): boolean {
  return target.labels.some((label) => label.name === name);
}

export function hasAnyLabel(target: HasLabels, names: readonly string[]): boolean {
  return target.labels.some((label) => names.includes(label.name));
}

/** All labels on `target` belonging to a group, e.g. `labelsInGroup(issue, "foreman:")`. */
export function labelsInGroup(target: HasLabels, prefix: string): string[] {
  return target.labels
    .map((label) => label.name)
    .filter((name) => name.startsWith(prefix));
}

export function typeLabel(target: HasLabels): string | null {
  return labelsInGroup(target, LABEL_GROUP.type)[0] ?? null;
}

export function foremanLabel(target: HasLabels): string | null {
  return labelsInGroup(target, LABEL_GROUP.foreman)[0] ?? null;
}

/**
 * Translates between our canonical colon-form label ids (SPEC §4.5, e.g.
 * `"type:bug"`) and Linear's native nested label groups — a parent label
 * (`isGroup: true`, e.g. "Type") with member labels (e.g. "Bug") beneath it,
 * shown in Linear's UI as "Type > Bug". We keep the colon form as the
 * in-memory identifier everywhere (gates, filters, schemas, comments) and
 * translate only at the Linear I/O boundary in `linear/client.ts`, so the
 * rest of the codebase never has to know Linear's display names.
 */

/** `"hands-off"` -> `"Hands Off"`; `"type"` -> `"Type"`. */
export function labelDisplayName(kebab: string): string {
  return kebab
    .split("-")
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** A `LABEL_GROUP` prefix (with or without the trailing colon) -> its Linear group display name, e.g. `"blocked:"` -> `"Blocked"`. */
export function groupDisplayName(prefix: string): string {
  const key = prefix.endsWith(":") ? prefix.slice(0, -1) : prefix;
  return labelDisplayName(key);
}

/**
 * Reassembles a canonical colon-form id from a label read back off Linear —
 * the inverse of `labelDisplayName`/`groupDisplayName`. Apostrophes are
 * stripped before kebab-casing so a manually-renamed "Won't Fix" still
 * round-trips to `triage:wont-fix`. A label with no parent group keeps its
 * own name, kebab-cased, as the id.
 */
export function labelIdFromParts(name: string, parentName: string | null): string {
  const kebab = (value: string) => value.trim().toLowerCase().replace(/['’]/g, "").replace(/\s+/g, "-");
  return parentName ? `${kebab(parentName)}:${kebab(name)}` : kebab(name);
}
