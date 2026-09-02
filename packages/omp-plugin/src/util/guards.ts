/** Canonical `unknown`-narrowing guard for this package (ts-no-local-is-record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * omp's `structuredOutput`, measured off a real `SingleResult` (docs/VERIFIED.md):
 * `{ source, mode, status: "valid" | "invalid" | "unavailable", data, error? }`.
 *
 * `status` is the discriminant — there is no `valid` boolean. An earlier
 * `{ data, valid }` guess here rejected every genuine payload, which silently
 * disabled the whole apply pipeline: `extractFromToolResult` skipped each
 * result as "not structured output" and no agent result ever reached Linear.
 */
export interface StructuredOutput {
  data: unknown;
  status: "valid" | "invalid" | "unavailable";
}

const STRUCTURED_OUTPUT_STATUSES: Record<string, true> = { valid: true, invalid: true, unavailable: true };

export function isStructuredOutput(value: unknown): value is StructuredOutput {
  if (!isRecord(value)) return false;
  if (!("data" in value)) return false;
  return typeof value.status === "string" && STRUCTURED_OUTPUT_STATUSES[value.status] === true;
}
