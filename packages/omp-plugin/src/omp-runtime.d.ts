/**
 * Ambient declarations for `@oh-my-pi/pi-coding-agent`.
 *
 * The omp runtime provides this module at load time and never publishes types
 * for it, so the plugin declares the slice it calls. Everything here was checked
 * against `omp://extensions.md`, `omp://skills/authoring-extensions.md`,
 * `omp://tools/task.md`, and a working reference extension on disk.
 *
 * Two deliberate looseness decisions:
 *
 * - `on()` is typed per known event name rather than `(event: string, ...)`, so a
 *   typo'd event name fails the build instead of registering a handler that can
 *   never fire. Only `session_start`, `session_shutdown`, `tool_call`,
 *   `tool_result`, and the three `task:subagent:*` events are declared, because
 *   those are the ones Foreman subscribes to.
 * - The `task:subagent:*` payloads are `unknown`. Their shape is documented only
 *   as "emitted on the parent event bus" with no field list, so pretending to
 *   know it would put a fabricated contract in the type system. `results/sink.ts`
 *   probes the payload structurally instead.
 */

declare module "@oh-my-pi/pi-coding-agent" {
  type ZodOutput<T> = T extends ZodType<infer U> ? U : never;

  interface ZodType<Output> {
    optional(): ZodType<Output | undefined>;
    describe(description: string): this;
    default(value: Exclude<Output, undefined>): ZodType<Exclude<Output, undefined>>;
  }

  interface ZodString extends ZodType<string> {}
  interface ZodBoolean extends ZodType<boolean> {}
  interface ZodNumber extends ZodType<number> {
    int(): this;
    positive(): this;
  }
  interface ZodArray<Element> extends ZodType<Element[]> {
    min(length: number): this;
  }
  interface ZodEnum<Values extends string> extends ZodType<Values> {}

  export type ZodRawShape = Record<string, ZodType<unknown>>;

  type OptionalShapeKeys<Shape extends ZodRawShape> = {
    [Key in keyof Shape]: undefined extends ZodOutput<Shape[Key]> ? Key : never;
  }[keyof Shape];
  type RequiredShapeKeys<Shape extends ZodRawShape> = {
    [Key in keyof Shape]: undefined extends ZodOutput<Shape[Key]> ? never : Key;
  }[keyof Shape];

  export type InferShape<Shape extends ZodRawShape> = {
    [Key in RequiredShapeKeys<Shape>]: ZodOutput<Shape[Key]>;
  } & {
    [Key in OptionalShapeKeys<Shape>]?: ZodOutput<Shape[Key]>;
  };

  export interface ZodObject<Shape extends ZodRawShape> extends ZodType<InferShape<Shape>> {}

  export interface ZodStatic {
    object<Shape extends ZodRawShape>(shape: Shape): ZodObject<Shape>;
    string(): ZodString;
    boolean(): ZodBoolean;
    number(): ZodNumber;
    array<Element extends ZodType<unknown>>(element: Element): ZodArray<ZodOutput<Element>>;
    enum<Values extends readonly [string, ...string[]]>(values: Values): ZodEnum<Values[number]>;
  }

  export interface ExtensionUIContext {
    notify(message: string, level?: "info" | "warn" | "error"): void;
    setStatus(key: string, value: string): void;
  }

  /** Shared by every handler and by a tool's `execute`. */
  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    setInterval(fn: () => void | Promise<void>, ms: number): unknown;
    setTimeout(fn: () => void | Promise<void>, ms: number): unknown;
    clearTimer(handle: unknown): void;
    ui: ExtensionUIContext;
    /** Present only when this tool shadows a native built-in of the same name. */
    invokeTool?: (
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => Promise<ExtensionToolResult>;
    [key: string]: unknown;
  }

  /** Command handlers additionally get session controls; Foreman uses `waitForIdle`. */
  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
  }

  export type ExtensionToolUpdate = (update: {
    content: Array<{ type: string; text: string }>;
  }) => void;

  export interface ExtensionToolResult {
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }

  export interface ExtensionToolConfig<Shape extends ZodRawShape> {
    name: string;
    label: string;
    description: string;
    parameters: ZodObject<Shape>;
    /** `read` keeps Foreman's read tools out of the write-approval path. */
    approval?: "read" | "write" | "exec";
    loadMode?: "essential" | "discoverable";
    execute(
      toolCallId: string,
      params: InferShape<Shape>,
      signal: AbortSignal | undefined,
      onUpdate: ExtensionToolUpdate | undefined,
      ctx: ExtensionContext,
    ): Promise<ExtensionToolResult>;
  }

  export interface ExtensionCommandConfig {
    description: string;
    handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
  }

  export interface ExtensionSendOptions {
    deliverAs?: "steer" | "followUp" | "nextTurn";
    triggerTurn?: boolean;
  }

  export interface ExtensionCustomMessage {
    customType: string;
    content: string;
    display: boolean;
    attribution: "user" | "assistant";
  }

  /**
   * Pre-exec tool interception. Returning `{ block, reason }` fails the call
   * closed; returning `{ input }` replaces the arguments the tool executes with,
   * and the revision is revalidated and seen by the approval gate. This is the
   * only surface where Foreman can force `schemaMode: "strict"` onto a spawn,
   * since `schemaMode` is a per-spawn `task` field and not agent frontmatter.
   */
  export interface ToolCallEvent {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }

  export interface ToolCallDecision {
    block?: boolean;
    reason?: string;
    input?: Record<string, unknown>;
  }

  /**
   * Measured against the running runtime (docs/VERIFIED.md), not inferred:
   * `tool_result` carries `details` *flat on the event*, alongside `content`
   * and `isError`. There is no enclosing `result` field - declaring one is
   * what let `payload.result.details.results` typecheck while reading
   * `undefined` on every real dispatch.
   */
  export interface ToolResultEvent {
    type: "tool_result";
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
    isError: boolean;
  }

  export interface ExtensionLogger {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  }

  export interface ExtensionAPI {
    zod: ZodStatic;
    logger: ExtensionLogger;
    setLabel(label: string): void;
    registerTool<Shape extends ZodRawShape>(config: ExtensionToolConfig<Shape>): void;
    registerCommand(name: string, config: ExtensionCommandConfig): void;
    sendMessage(
      message: ExtensionCustomMessage,
      options?: ExtensionSendOptions,
    ): Promise<void>;
    exec(
      command: string,
      args: string[],
      options: { cwd: string; signal?: AbortSignal },
    ): Promise<unknown>;

    on(
      event: "session_start" | "session_shutdown",
      handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
    on(
      event: "tool_call",
      handler: (
        event: ToolCallEvent,
        ctx: ExtensionContext,
      ) => void | ToolCallDecision | Promise<void | ToolCallDecision>,
    ): void;
    on(
      event: "tool_result",
      handler: (event: ToolResultEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
    on(
      event: "task:subagent:lifecycle" | "task:subagent:progress" | "task:subagent:event",
      handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
  }
}
