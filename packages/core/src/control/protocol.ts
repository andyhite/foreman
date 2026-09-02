/**
 * The control-plane wire protocol (SPEC §17).
 *
 * A running loop is a long-lived process an operator wants to observe and
 * steer without stopping it: the TUI, `foreman status`, and a future web
 * dashboard all need the same view of "what is this loop doing right now"
 * and the same small set of verbs to act on it. `LoopSnapshot` is that view
 * — everything a client needs to render, computed once by the loop itself so
 * every consumer agrees, and written to `status.json` for anyone the socket
 * cannot reach and read live over `ControlServer`/`ControlClient`.
 *
 * The transport is newline-delimited JSON over a unix socket: no HTTP
 * framing dependency, no extra runtime package (SPEC's "zero new runtime
 * dependencies" rule), and trivial to buffer through `FrameDecoder` when a
 * request or event arrives split across TCP-style stream chunks.
 *
 * Every shape that crosses the socket or lands in `status.json` is a TypeBox
 * schema, `additionalProperties: false`, matching `config/schema.ts` — a
 * malformed frame from a mismatched client/server version must fail loudly
 * in validation, never silently misrender.
 */

import { type Static, Type } from "../typebox.ts";
import type { LoopId, LoopKind } from "./paths.ts";

export type LoopMode = "confirm" | "yolo";
export type RunState = "starting" | "running" | "paused" | "draining" | "stopped";
export type AgentStatus = "starting" | "running" | "settled" | "lost" | "unknown";

const LoopModeSchema = Type.Union([Type.Literal("confirm"), Type.Literal("yolo")]);

/** Every valid `LoopMode`, least autonomous first. */
export const LOOP_MODES: readonly LoopMode[] = ["confirm", "yolo"];

/** Narrows an arbitrary value (e.g. a control-request param) to a `LoopMode`, rejecting everything else. */
export function isLoopMode(value: unknown): value is LoopMode {
  return typeof value === "string" && (LOOP_MODES as readonly string[]).includes(value);
}
const RunStateSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("draining"),
  Type.Literal("stopped"),
]);
const AgentStatusSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("settled"),
  Type.Literal("lost"),
  Type.Literal("unknown"),
]);
const LoopKindSchema = Type.Union([Type.Literal("repo"), Type.Literal("intake")]);

const WorkerViewSchema = Type.Object(
  {
    name: Type.String(),
    cadenceMs: Type.Number(),
    lastRunAt: Type.Union([Type.String(), Type.Null()]),
    nextRunAt: Type.Union([Type.String(), Type.Null()]),
    running: Type.Boolean(),
    dispatched: Type.Number(),
    skipped: Type.Number(),
    errors: Type.Number(),
    lastSkips: Type.Array(
      Type.Object(
        {
          issueId: Type.Union([Type.String(), Type.Null()]),
          code: Type.String(),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    lastError: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkerView = Static<typeof WorkerViewSchema>;

const AgentViewSchema = Type.Object(
  {
    dispatchId: Type.String(),
    agent: Type.String(),
    stage: Type.String(),
    issueId: Type.Union([Type.String(), Type.Null()]),
    projectId: Type.Union([Type.String(), Type.Null()]),
    startedAt: Type.String(),
    ageMs: Type.Number(),
    status: AgentStatusSchema,
    herdr: Type.Union([
      Type.Object({ paneId: Type.String(), agentName: Type.String() }, { additionalProperties: false }),
      Type.Null(),
    ]),
    pid: Type.Union([Type.Number(), Type.Null()]),
    worktree: Type.Union([Type.String(), Type.Null()]),
    ttlMs: Type.Number(),
    pastTtl: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AgentView = Static<typeof AgentViewSchema>;

const BoardCountsSchema = Type.Object(
  {
    backlog: Type.Number(),
    todo: Type.Number(),
    inProgress: Type.Number(),
    inReview: Type.Number(),
    blocked: Type.Number(),
    proposals: Type.Number(),
    readyBuffer: Type.Number(),
    triageInbox: Type.Number(),
  },
  { additionalProperties: false },
);
export type BoardCounts = Static<typeof BoardCountsSchema>;

const BlockedItemSchema = Type.Object(
  {
    issueId: Type.String(),
    title: Type.String(),
    type: Type.String(),
    question: Type.String(),
    detectedAt: Type.Union([Type.String(), Type.Null()]),
    options: Type.Array(
      Type.Object({ label: Type.String(), tradeoff: Type.String() }, { additionalProperties: false }),
    ),
    recommendation: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type BlockedItem = Static<typeof BlockedItemSchema>;

const ProposalItemSchema = Type.Object(
  {
    issueId: Type.String(),
    title: Type.String(),
    destination: Type.String(),
    proposedPriority: Type.Union([Type.Number(), Type.Null()]),
    duplicateOf: Type.Union([Type.String(), Type.Null()]),
    proposedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type ProposalItem = Static<typeof ProposalItemSchema>;

const DecisionItemSchema = Type.Object(
  {
    issueId: Type.String(),
    stage: Type.String(),
    kind: Type.String(),
    attempts: Type.Number(),
    detectedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type DecisionItem = Static<typeof DecisionItemSchema>;

const QueueItemSchema = Type.Object(
  {
    issueId: Type.String(),
    title: Type.String(),
    state: Type.String(),
    priority: Type.Number(),
    estimate: Type.Union([Type.Number(), Type.Null()]),
    labels: Type.Array(Type.String()),
    assignee: Type.Union([Type.String(), Type.Null()]),
    updatedAt: Type.String(),
    url: Type.String(),
  },
  { additionalProperties: false },
);
export type QueueItem = Static<typeof QueueItemSchema>;

export const LoopSnapshotSchema = Type.Object(
  {
    loop: Type.Object(
      {
        id: Type.String(),
        kind: LoopKindSchema,
        label: Type.String(),
        alias: Type.Union([Type.String(), Type.Null()]),
        team: Type.Union([Type.String(), Type.Null()]),
        repoPath: Type.Union([Type.String(), Type.Null()]),
        initiativeIds: Type.Array(Type.String()),
        pid: Type.Number(),
        startedAt: Type.String(),
        version: Type.String(),
      },
      { additionalProperties: false },
    ),
    runtime: Type.Object(
      {
        state: RunStateSchema,
        mode: LoopModeSchema,
        dispatcher: Type.Union([Type.Literal("herdr"), Type.Literal("print"), Type.Literal("none")]),
        pausedAt: Type.Union([Type.String(), Type.Null()]),
        lastTickAt: Type.Union([Type.String(), Type.Null()]),
        nextTickAt: Type.Union([Type.String(), Type.Null()]),
        ticks: Type.Number(),
        uptimeMs: Type.Number(),
      },
      { additionalProperties: false },
    ),
    workers: Type.Array(WorkerViewSchema),
    agents: Type.Array(AgentViewSchema),
    wip: Type.Object(
      {
        global: Type.Object({ used: Type.Number(), cap: Type.Number() }, { additionalProperties: false }),
        byStage: Type.Array(
          Type.Object(
            { stage: Type.String(), used: Type.Number(), cap: Type.Number() },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    backpressure: Type.Object(
      {
        tripped: Type.Boolean(),
        blockedCount: Type.Number(),
        threshold: Type.Number(),
        reason: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    board: BoardCountsSchema,
    queues: Type.Object(
      {
        blocked: Type.Array(BlockedItemSchema),
        proposals: Type.Array(ProposalItemSchema),
        decisions: Type.Array(DecisionItemSchema),
        pipeline: Type.Array(QueueItemSchema),
      },
      { additionalProperties: false },
    ),
    linear: Type.Object(
      {
        ok: Type.Boolean(),
        lastPollAt: Type.Union([Type.String(), Type.Null()]),
        lastError: Type.Union([Type.String(), Type.Null()]),
        requests: Type.Number(),
      },
      { additionalProperties: false },
    ),
    history: Type.Object(
      { dispatchesPerTick: Type.Array(Type.Number()) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type LoopSnapshot = Static<typeof LoopSnapshotSchema>;

export const StatusFileSchema = Type.Object(
  {
    schema: Type.Literal(1),
    writtenAt: Type.String(),
    snapshot: LoopSnapshotSchema,
  },
  { additionalProperties: false },
);
export type StatusFile = Static<typeof StatusFileSchema>;

export const CONTROL_PROTOCOL_VERSION = 1 as const;

const ControlOpSchema = Type.Union([
  Type.Literal("hello"),
  Type.Literal("snapshot"),
  Type.Literal("subscribe"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("stop"),
  Type.Literal("tick"),
  Type.Literal("setMode"),
  Type.Literal("patchConfig"),
  Type.Literal("reload"),
  Type.Literal("attachAgent"),
  Type.Literal("killAgent"),
  Type.Literal("logs"),
]);
export type ControlOp = Static<typeof ControlOpSchema>;

export const ControlRequestSchema = Type.Object(
  {
    id: Type.Number(),
    op: ControlOpSchema,
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ControlRequest = Static<typeof ControlRequestSchema>;

export type ControlResponse =
  | { id: number; ok: true; data?: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

export interface ServerInfo {
  loopId: LoopId;
  kind: LoopKind;
  pid: number;
  startedAt: string;
  version: string;
  protocol: 1;
}

const LogEventSchema = Type.Object(
  {
    event: Type.Literal("log"),
    seq: Type.Number(),
    at: Type.String(),
    level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
    line: Type.String(),
  },
  { additionalProperties: false },
);
const StateEventSchema = Type.Object(
  {
    event: Type.Literal("state"),
    seq: Type.Number(),
    at: Type.String(),
    runtime: LoopSnapshotSchema.properties.runtime,
  },
  { additionalProperties: false },
);
const TickEventSchema = Type.Object(
  {
    event: Type.Literal("tick"),
    seq: Type.Number(),
    at: Type.String(),
    worker: Type.String(),
    dispatched: Type.Number(),
    skipped: Type.Number(),
    errors: Type.Number(),
  },
  { additionalProperties: false },
);
const DispatchEventSchema = Type.Object(
  {
    event: Type.Literal("dispatch"),
    seq: Type.Number(),
    at: Type.String(),
    agent: AgentViewSchema,
  },
  { additionalProperties: false },
);
const SnapshotEventSchema = Type.Object(
  {
    event: Type.Literal("snapshot"),
    seq: Type.Number(),
    at: Type.String(),
    snapshot: LoopSnapshotSchema,
  },
  { additionalProperties: false },
);

export const ControlEventSchema = Type.Union([
  LogEventSchema,
  StateEventSchema,
  TickEventSchema,
  DispatchEventSchema,
  SnapshotEventSchema,
]);
export type ControlEvent = Static<typeof ControlEventSchema>;

/**
 * What a producer hands to `ControlServer.broadcast` — the event without the
 * fields only the server can supply. `Omit` must distribute over the union
 * here: a plain `Omit<ControlEvent, …>` collapses to the keys every member
 * shares (`event` alone), so `runtime`, `line` and `agent` would all be
 * rejected as unknown properties.
 */
export type EmittableEvent = ControlEvent extends infer Member
  ? Member extends ControlEvent
    ? Omit<Member, "seq" | "at">
    : never
  : never;

/** Newline-delimited JSON: the whole wire framing. */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** A frame split across chunks — or corrupted by a partial write — must never take the loop down; a bad line is dropped, not thrown. */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export class FrameDecoder {
  #buffer = "";

  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_BUFFER_BYTES) {
      // No complete frame is arriving; a stuck sender should not grow this
      // buffer without bound. Reset and wait for the next newline.
      this.#buffer = "";
      return [];
    }
    const frames: unknown[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          frames.push(JSON.parse(line));
        } catch {
          // Malformed frame: dropped silently, per module contract.
        }
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return frames;
  }

  get pending(): number {
    return this.#buffer.length;
  }
}

export function emptyBoardCounts(): BoardCounts {
  return {
    backlog: 0,
    todo: 0,
    inProgress: 0,
    inReview: 0,
    blocked: 0,
    proposals: 0,
    readyBuffer: 0,
    triageInbox: 0,
  };
}
