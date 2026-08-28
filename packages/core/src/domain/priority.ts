/** Linear's native Priority is Foreman's single urgency/severity axis (SPEC §4.3). */

export const PRIORITY = {
  None: 0,
  Urgent: 1,
  High: 2,
  Medium: 3,
  Low: 4,
} as const;

export type PriorityValue = (typeof PRIORITY)[keyof typeof PRIORITY];

export const PRIORITY_NAMES: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export function priorityName(value: number): string {
  return PRIORITY_NAMES[value] ?? `Unknown(${value})`;
}

/**
 * Queue order for the loop's pickup. `None` is load-bearing (SPEC §4.3): an
 * unprioritized issue is not eligible for refinement, so it sorts last rather
 * than ahead of `Urgent` the way its raw value 0 would.
 */
export function priorityRank(value: number): number {
  return value === PRIORITY.None ? Number.MAX_SAFE_INTEGER : value;
}
