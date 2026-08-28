/** Canonical `unknown`-narrowing guard for this package (ts-no-local-is-record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `structuredOutput`'s documented shape: `{ data, valid, mode, source, error }`. `valid` is the discriminant that separates a genuine structured result from an arbitrary object that merely has a `data` key. */
export interface StructuredOutput {
  data: unknown;
  valid: boolean;
}

export function isStructuredOutput(value: unknown): value is StructuredOutput {
  if (!isRecord(value)) return false;
  if (!("valid" in value) || !("data" in value)) return false;
  return typeof value.valid === "boolean";
}
