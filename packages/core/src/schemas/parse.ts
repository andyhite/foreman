import { type Static, type TSchema, type TUnion, Value } from "../typebox.ts";
import { AGENT_OUTPUT_SCHEMAS, type ForemanAgentName } from "./index.ts";
import type { BlockRecord } from "./envelope.ts";

type EnvelopeStatic<N extends ForemanAgentName> = Static<(typeof AGENT_OUTPUT_SCHEMAS)[N]>;
type ResultOf<N extends ForemanAgentName> = NonNullable<EnvelopeStatic<N>["result"]>;

/**
 * The consumer side of the envelope (SPEC §6). `result` is populated
 * exclusively when validation succeeds and the invariants hold; `invalid`
 * carries human-readable problems (including a JSON pointer) so the caller's
 * retry counter (§17.8) has something to log without a crash.
 */
export type ParsedOutput<T> =
  | { kind: "result"; result: T }
  | { kind: "blocked"; block: BlockRecord }
  | { kind: "invalid"; problems: string[] };

/**
 * TypeBox reports a bare "Expected union value" at `/result` or `/block`
 * rather than descending into whichever member schema the caller meant,
 * because a schema-level union carries no such intent. Once the envelope's
 * own required/type checks pass, `blocked` tells us which member was meant,
 * so we can validate that field against its own non-null schema directly and
 * get a real JSON pointer into the payload instead of a top-level shrug.
 */
function nonNullMember(union: TUnion): TSchema {
  const member = union.anyOf.find((candidate) => candidate.type !== "null");
  if (!member) throw new Error("expected a nullable union with a non-null member");
  return member;
}

function describeErrors(schema: TSchema, value: unknown, prefix: string): string[] {
  return [...Value.Errors(schema, value)].map((error) => `${prefix}${error.path || "/"}: ${error.message}`);
}

/**
 * Validates `data` against `agent`'s envelope schema, then enforces the
 * invariants JSON Schema cannot express on its own:
 *   - `blocked: false` requires a non-null `result` and a null `block`.
 *   - `blocked: true` requires a non-null `block` and a null `result`.
 *   - a `dependency` block (Case A, SPEC §9) requires a non-empty
 *     `blockedByIssues`, since it is meaningless without a blocker to point at.
 *
 * Never throws: an invalid yield is routed to the retry counter, not a crash.
 */
export function parseAgentOutput<N extends ForemanAgentName>(
  agent: N,
  data: unknown,
): ParsedOutput<ResultOf<N>> {
  const schema = AGENT_OUTPUT_SCHEMAS[agent];

  if (!Value.Check(schema, data)) {
    let problems = describeErrors(schema, data, "");

    if (data !== null && typeof data === "object") {
      if ("blocked" in data && data.blocked === false && "result" in data) {
        problems = describeErrors(nonNullMember(schema.properties.result), data.result, "/result");
      } else if ("blocked" in data && data.blocked === true && "block" in data) {
        problems = describeErrors(nonNullMember(schema.properties.block), data.block, "/block");
      }
    }

    return {
      kind: "invalid",
      problems: problems.length > 0 ? problems : ["/: does not match the expected envelope"],
    };
  }

  const envelope = data as EnvelopeStatic<N>;

  if (envelope.blocked) {
    if (envelope.block === null || envelope.result !== null) {
      return {
        kind: "invalid",
        problems: [
          "/block: required and non-null when blocked is true",
          "/result: must be null when blocked is true",
        ],
      };
    }
    if (envelope.block.type === "dependency" && envelope.block.blockedByIssues.length === 0) {
      return {
        kind: "invalid",
        problems: ['/block/blockedByIssues: must be non-empty when /block/type is "dependency"'],
      };
    }
    return { kind: "blocked", block: envelope.block };
  }

  if (envelope.result === null || envelope.block !== null) {
    return {
      kind: "invalid",
      problems: [
        "/result: required and non-null when blocked is false",
        "/block: must be null when blocked is false",
      ],
    };
  }

  const result = envelope.result as ResultOf<N>;

  if (agent === "foreman-refine") {
    const refineResult = result as unknown as {
      estimate: number;
      subIssues: readonly unknown[];
      spikeCreated: unknown;
      readyForImplementation: boolean;
    };
    const refineProblems: string[] = [];
    if (
      refineResult.readyForImplementation &&
      (refineResult.estimate > 3 || refineResult.subIssues.length > 0 || refineResult.spikeCreated !== null)
    ) {
      refineProblems.push(
        "/result/readyForImplementation: must be false when estimate > 3, subIssues is non-empty, or spikeCreated is set",
      );
    }
    if (refineResult.estimate >= 5 && refineResult.subIssues.length === 0) {
      refineProblems.push("/result/subIssues: must be non-empty when estimate >= 5");
    }
    if (refineProblems.length > 0) return { kind: "invalid", problems: refineProblems };
  }

  if (agent === "foreman-review") {
    const reviewResult = result as unknown as {
      verdict: string;
      findings: ReadonlyArray<{ severity: string }>;
      dodSatisfied: boolean;
      dodChecklist: ReadonlyArray<{ satisfied: boolean }>;
    };
    const reviewProblems: string[] = [];
    const hasBlocking = reviewResult.findings.some((finding) => finding.severity === "blocking");
    if ((reviewResult.verdict === "request-changes") !== hasBlocking) {
      reviewProblems.push(
        '/result/verdict: must be "request-changes" if and only if at least one finding is "blocking"',
      );
    }
    const allDodSatisfied = reviewResult.dodChecklist.every((check) => check.satisfied);
    if (reviewResult.dodSatisfied && !allDodSatisfied) {
      reviewProblems.push("/result/dodSatisfied: must be false when any dodChecklist entry is not satisfied");
    }
    if (reviewProblems.length > 0) return { kind: "invalid", problems: reviewProblems };
  }

  return { kind: "result", result };
}

/**
 * SPEC §17.8's one carve-out: a schema-invalid yield caused by a budget
 * force-stop (§3.6) is not a failure and must route through the interrupt
 * protocol (§9) instead of incrementing the attempt counter. The signal is
 * the lifecycle-reported `aborted` flag, not the shape of the problems —
 * string-sniffing validation errors would be brittle and would silently
 * break the moment a problem message wording changes.
 */
export function isBudgetTruncation(input: { aborted: boolean; problems: string[] }): boolean {
  return input.aborted && input.problems.length > 0;
}
