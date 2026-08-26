// The extension also imports a few Node built-ins (`node:fs`, `node:os`,
// `node:path`) that Bun's node-compat layer serves at runtime. `@types/node`
// is the usual source for their types, but this zero-dependency plugin never
// installs it — declare only the functions extension/index.ts actually
// calls.
declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function renameSync(from: string, to: string): void;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
}

// The only Node process API this plugin touches: `env` reads (HERDR_ENV,
// FOREMAN_STATE, FOREMAN_POLL_MS, FOREMAN_SPAWN_TIMEOUT_MS).
declare const process: {
  env: Record<string, string | undefined>;
};

// Ambient shapes for `@oh-my-pi/pi-coding-agent`, an installed dependency
// the omp runtime provides at load time, never `@types`-published. Declares
// only the slice extension/index.ts actually calls — extend it if that file
// starts touching more of the real API.
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

  interface ExecOptions {
    signal?: AbortSignal;
    cwd: string;
  }

  export interface ExtensionSendOptions {
    deliverAs?: "steer" | "followUp" | "nextTurn";
    triggerTurn?: boolean;
  }

  // The envelope `pi.sendMessage` takes. Only the four fields foreman sets are
  // declared; the real API also accepts `details`.
  export interface ExtensionCustomMessage {
    customType: string;
    content: string;
    display: boolean;
    attribution: "user";
  }

  export interface ExtensionAPI {
    zod: ZodStatic;
    // Result is `unknown`, never a concrete shape: every call site in
    // extension/index.ts casts it through a validated `run` helper because
    // the real return type isn't resolvable here either.
    exec(command: string, args: string[], options: ExecOptions): Promise<unknown>;
    registerTool<Shape extends ZodRawShape>(config: ExtensionToolConfig<Shape>): void;
    // `session_start` is the only event this extension subscribes to;
    // declaring a generic `on(event: string, ...)` here would let a typo'd
    // event name type-check silently instead of failing the build.
    on(event: "session_start", handler: (event: unknown, ctx: ExtensionToolContext) => void): void;
    // Declared as returning a promise so `DrainDeps` can be faked with an
    // async stub, but the runtime call returns `undefined` and yields no
    // delivery receipt: the drain's retry path fires on a synchronous throw,
    // never on a rejection. `sendUserMessage` is deliberately absent — it
    // takes no `triggerTurn`, and `triggerTurn` is what wakes an idle
    // receiver, so its `followUp` was measured never to arrive at all.
    sendMessage(message: ExtensionCustomMessage, options?: ExtensionSendOptions): Promise<void>;
  }
}
