// The extension also imports a few Node built-ins (`node:fs`, `node:fs/
// promises`, `node:os`, `node:path`) that Bun's node-compat layer serves at
// runtime. `@types/node` is the usual source for their types, but this
// zero-dependency plugin never installs it — declare only the functions
// extension/index.ts actually calls.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
}

declare module "node:fs/promises" {
  export function unlink(path: string): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
}

// The only Node process API this plugin touches: `env` reads (HERDR_ENV,
// FOREMAN_BIN, FOREMAN_ASIDE_POLL_MS). `pid`/`cwd()` used to back the
// `foreman bus --arm` liveness marker; deleted along with that call (the
// sidecar's own presence is now proof enough — see extension/index.ts's
// "Inbound delivery" comment) since neither has a remaining consumer.
declare const process: {
  env: Record<string, string | undefined>;
};

// Ambient shapes for `@oh-my-pi/pi-coding-agent` and the Bun globals this
// plugin relies on. Neither is an installed dependency: the omp runtime
// provides the real module at load time (see extension/index.ts:6-15), and
// Bun's own types come only from `@types/bun`, which this zero-dependency
// plugin deliberately never installs. Without this file `tsc` cannot resolve
// either surface at all, so `extension/index.ts` would stay untyped forever
// and bugs like the ones that motivated this CI gate would keep reaching
// main unnoticed. Declares only the slice `extension/index.ts` actually
// calls — extend it if that file starts touching more of the real API.

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

  export type InferShape<Shape extends ZodRawShape> = { [Key in RequiredShapeKeys<Shape>]: ZodOutput<Shape[Key]> } & {
    [Key in OptionalShapeKeys<Shape>]?: ZodOutput<Shape[Key]>;
  };

  export interface ZodObject<Shape extends ZodRawShape> extends ZodType<InferShape<Shape>> {}

  // The extension only reaches `pi.zod` for `object`/`string`/`boolean`/
  // `number`/`array`/`enum` — matches the tool-parameter schemas actually
  // declared in extension/index.ts.
  interface ZodStatic {
    object<Shape extends ZodRawShape>(shape: Shape): ZodObject<Shape>;
    string(): ZodString;
    boolean(): ZodBoolean;
    number(): ZodNumber;
    array<Element extends ZodType<unknown>>(element: Element): ZodArray<ZodOutput<Element>>;
    enum<Values extends readonly [string, ...string[]]>(values: Values): ZodEnum<Values[number]>;
  }

  // `ctx` as seen by a tool's `execute`, and by every event handler below
  // (`omp://extensions.md` documents every handler sharing one
  // `ExtensionContext`). extension/index.ts imports this directly instead
  // of declaring its own structurally-identical copy — nothing left to
  // duplicate once the import resolves.
  export interface ExtensionToolContext {
    cwd: string;
    setInterval(fn: () => void | Promise<void>, ms: number): unknown;
    clearTimer(handle: unknown): void;
    [key: string]: unknown;
  }

  export type ExtensionToolUpdate = (update: { content: Array<{ type: string; text: string }> }) => void;

  interface ExtensionToolResult {
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }

  interface ExtensionToolConfig<Shape extends ZodRawShape> {
    name: string;
    label: string;
    description: string;
    parameters: ZodObject<Shape>;
    execute(
      toolCallId: string,
      params: InferShape<Shape>,
      signal: AbortSignal | undefined,
      onUpdate: ExtensionToolUpdate | undefined,
      ctx: ExtensionToolContext,
    ): Promise<ExtensionToolResult>;
  }

  interface ExtensionCommandConfig {
    description: string;
    handler: (args: string) => void | Promise<void>;
  }

  interface ExtensionSendMessageOptions {
    deliverAs: string;
    triggerTurn: boolean;
  }

  interface ExtensionCustomMessage {
    customType: string;
    content: string;
    display: boolean;
    attribution: string;
  }

  interface ExecOptions {
    signal?: AbortSignal;
    cwd: string;
  }

  // Payload for the notification bus's `mcp_notification` event — the
  // sidecar's wake ping carries no `params` by design (see
  // `herdr/bin/foreman`'s `bus` subcommand: the receiving extension asks the
  // CLI what to deliver via `foreman pickup` rather than trusting a payload
  // that could go stale between send and receive). Declaring `params` as
  // `unknown` rather than omitting it matches the wire shape without
  // inventing fields extension/index.ts never reads.
  interface McpNotificationEvent {
    server: string;
    method: string;
    params?: unknown;
  }

  export interface ExtensionAPI {
    zod: ZodStatic;
    // Result is `unknown`, never a concrete shape: every call site in
    // extension/index.ts casts it with `as ForemanExecResult` itself
    // because the real return type isn't resolvable here either.
    exec(command: string, args: string[], options: ExecOptions): Promise<unknown>;
    registerTool<Shape extends ZodRawShape>(config: ExtensionToolConfig<Shape>): void;
    registerCommand(name: string, config: ExtensionCommandConfig): void;
    // `session_start` and `mcp_notification` are the only events this
    // extension subscribes to; declaring a generic `on(event: string, ...)`
    // here would let a typo'd event name type-check silently instead of
    // failing the build. `ctx` reuses `ExtensionToolContext` (not a third
    // shape) because `omp://extensions.md` documents every handler
    // receiving the same `ExtensionContext`, and the extension only ever
    // reads `setInterval`/`clearTimer`/`cwd` off it, identical to a tool's
    // own ctx. `session_start`'s payload is typed `unknown`, not a
    // dedicated interface: extension/index.ts reads nothing off it, only
    // `ctx.setInterval` via `ensureJoinPoller`.
    on(event: "session_start", handler: (event: unknown, ctx: ExtensionToolContext) => void): void;
    // Fired for every MCP server's push notifications this session has
    // wired up, not just foreman's — extension/index.ts filters on
    // `server`/`method` itself rather than this file inventing a
    // foreman-only event name the real runtime doesn't have.
    on(event: "mcp_notification", handler: (event: McpNotificationEvent, ctx: ExtensionToolContext) => void): void;
    sendMessage(message: ExtensionCustomMessage, options: ExtensionSendMessageOptions): Promise<void>;
    sendUserMessage(text: string): Promise<void>;
  }
}

// The extension is loaded and executed by Bun (see package.json's
// `omp.extensions` entry), never bundled or run under Node, but this repo
// has no `@types/bun` dependency to describe that global — declare only the
// `Bun.spawn`/`Bun.write` slice extension/index.ts calls plus the
// `import.meta.dir` Bun adds to every module.
declare namespace Bun {
  // The slice of Bun's `Subprocess` this extension actually relies on —
  // typing `spawn`'s return as this instead of `unknown` is what lets
  // `extension/index.ts` drop the `as unknown as ForemanSubprocess` double
  // cast it used to need to get from an opaque result to a usable shape.
  interface Subprocess {
    kill(): void;
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array> | number | null;
    stderr: ReadableStream<Uint8Array> | number | null;
  }
  function spawn(
    command: string[],
    options?: { cwd?: string; stdout?: "pipe" | "inherit" | "ignore"; stderr?: "pipe" | "inherit" | "ignore" },
  ): Subprocess;
  function write(destination: string, data: string): Promise<number>;
}

interface ImportMeta {
  dir: string;
}
