import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import foremanExtension, { createDeliverer, deliveryFor, loadCommandPrompts, taskText, type PickupResult } from "./index";

describe("loadCommandPrompts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-command-prompts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("parses frontmatter description and strips it from the body", () => {
    writeFileSync(
      join(dir, "boss.md"),
      "---\ndescription: Claim the boss handle\n---\nHello $ARGUMENTS\n",
    );
    const [prompt] = loadCommandPrompts(dir);
    expect(prompt.name).toBe("boss");
    expect(prompt.description).toBe("Claim the boss handle");
    expect(prompt.body).toBe("Hello $ARGUMENTS\n");
  });

  test("a file with no frontmatter uses the filename as its description and keeps the whole body", () => {
    writeFileSync(join(dir, "init.md"), "Just a plain prompt body.");
    const [prompt] = loadCommandPrompts(dir);
    expect(prompt.name).toBe("init");
    expect(prompt.description).toBe("init");
    expect(prompt.body).toBe("Just a plain prompt body.");
  });

  test("an unterminated frontmatter fence falls back to treating the whole file as the body", () => {
    writeFileSync(join(dir, "broken.md"), "---\ndescription: never closes\nStill going\n");
    const [prompt] = loadCommandPrompts(dir);
    expect(prompt.name).toBe("broken");
    expect(prompt.description).toBe("broken");
    expect(prompt.body).toBe("---\ndescription: never closes\nStill going");
  });

  test("a broken symlink is skipped instead of crashing the whole load", () => {
    writeFileSync(join(dir, "boss.md"), "---\ndescription: Claim the boss handle\n---\nBody\n");
    // Emacs' lock file convention: a dotfile matching *.md whose target
    // doesn't exist, exactly the shape that used to crash the whole plugin
    // (see loadCommandPrompts' own comment on this).
    symlinkSync(join(dir, "does-not-exist.md"), join(dir, ".#boss.md"));
    const prompts = loadCommandPrompts(dir);
    expect(prompts.map((p) => p.name)).toEqual(["boss"]);
  });

  test("a name with characters outside [a-z0-9_-] is skipped", () => {
    writeFileSync(join(dir, "has space.md"), "Body");
    writeFileSync(join(dir, "ok-name.md"), "Body");
    const prompts = loadCommandPrompts(dir);
    expect(prompts.map((p) => p.name)).toEqual(["ok-name"]);
  });

  test("a missing directory yields no prompts instead of throwing", () => {
    expect(loadCommandPrompts(join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("deliveryFor", () => {
  const question = "foreman-delivery: interrupt question\nShould I call it A or B?\n";
  const report = "foreman-delivery: queue report\nforeman 0.6.0\n";
  const task = "foreman-delivery: queue task\nRework the retry policy in core/retry.ts.\n\n-- foreman protocol --\n";

  test("interrupt question steers and says it is blocking somebody", () => {
    // Interrupt means someone is blocked waiting on the receiver — that is
    // a worker's question and nothing else, so this is the one case that
    // still carries the absorb protocol.
    const { deliverAs, customType, content } = deliveryFor(question);
    expect(deliverAs).toBe("steer");
    expect(customType).toBe("Foreman Question");
    expect(content).toContain("Should I call it A or B?");
    expect(content).toContain("blocked and waiting");
    expect(content).toContain("todo list");
  });

  test("queue report queues and drops the absorb sentence", () => {
    // A queued delivery lands at a turn boundary, where there is no
    // half-applied edit for `absorb` to protect — carrying it anyway would
    // make every report read as an interruption nobody is waiting on.
    const { deliverAs, customType, content } = deliveryFor(report);
    expect(deliverAs).toBe("followUp");
    expect(customType).toBe("Foreman Report");
    expect(content).toContain("foreman 0.6.0");
    expect(content).toContain("filed its report");
    expect(content).not.toContain("todo list");
  });

  test("queue task queues untouched, because the CLI already classified it", () => {
    const { deliverAs, customType, content } = deliveryFor(task);
    expect(deliverAs).toBe("followUp");
    expect(customType).toBe("Foreman Task");
    expect(content).toBe(task.slice(task.indexOf("\n") + 1));
  });

  test("the declared header is stripped from every payload, not just tasks", () => {
    // Leaving the header in the delivered content would leak CLI-internal
    // framing into what the receiving agent reads as the message body.
    for (const text of [question, report, task]) {
      expect(deliveryFor(text).content).not.toContain("foreman-delivery:");
    }
  });

  test("a missing or unparseable header defaults to the safe queue path, text untouched", () => {
    // Queue is the delivery that cannot itself become the destructive case
    // (an errant interrupt) if the CLI's header contract ever drifts.
    const stray = "Rework the retry policy in core/retry.ts.\n";
    const { deliverAs, customType, content } = deliveryFor(stray);
    expect(deliverAs).toBe("followUp");
    expect(customType).toBe("Foreman Task");
    expect(content).toBe(stray);
  });
});

describe("taskText", () => {
  // `foreman_spawn` names a brief `task`, so two shipped runs reached for
  // `task` on the follow-up too and burned a call on `text must be a string
  // (was missing)`. Both names resolve to the one argument now.
  test("task is accepted, because that is what foreman_spawn calls it", () => {
    expect(taskText({ task: "rework retries" }, "foreman_send")).toBe("rework retries");
  });

  test("text is accepted, because an untracked message really is text", () => {
    expect(taskText({ text: "B" }, "foreman_send")).toBe("B");
  });

  test("neither name is a clear error naming both, not a bare schema failure", () => {
    expect(() => taskText({}, "foreman_send")).toThrow(
      "foreman_send requires exactly one of task or text",
    );
  });

  test("both names at once is refused rather than silently picking one", () => {
    expect(() => taskText({ task: "a", text: "b" }, "foreman_msg")).toThrow(
      "foreman_msg requires exactly one of task or text",
    );
  });

  // An empty string is the shape a caller lands on by building the body from
  // something that turned out to be missing; treating it as present would
  // dispatch a worker a blank brief.
  test("an empty string counts as absent", () => {
    expect(taskText({ task: "", text: "real body" }, "foreman_send")).toBe("real body");
    expect(() => taskText({ task: "", text: "" }, "foreman_send")).toThrow("exactly one");
  });
});

describe("createDeliverer", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  test("exit 0 with stdout maps to delivered and publishes the text", async () => {
    const published: string[] = [];
    const deliverer = createDeliverer(
      async () => ({ kind: "delivered", text: "worker report" }),
      async (text) => {
        published.push(text);
      },
    );
    const outcome = await deliverer.deliverInbound("/repo");
    expect(outcome).toBe("delivered");
    expect(published).toEqual(["worker report"]);
  });

  test("exit 3 (nothing to deliver) maps to empty and never publishes", async () => {
    const published: string[] = [];
    const deliverer = createDeliverer(
      async () => ({ kind: "empty" }),
      async (text) => {
        published.push(text);
      },
    );
    expect(await deliverer.deliverInbound("/repo")).toBe("empty");
    expect(published).toEqual([]);
  });

  test("any other exit code maps to error", async () => {
    const deliverer = createDeliverer(
      async () => ({ kind: "error" }),
      async () => {},
    );
    expect(await deliverer.deliverInbound("/repo")).toBe("error");
  });

  test("a missing binary maps to missing-binary", async () => {
    const deliverer = createDeliverer(
      async () => ({ kind: "missing-binary" }),
      async () => {},
    );
    expect(await deliverer.deliverInbound("/repo")).toBe("missing-binary");
  });

  test("concurrent calls never run two pickups at once", async () => {
    const published: string[] = [];
    let active = 0;
    let maxActive = 0;
    let pickupCalls = 0;
    const gate = deferred<void>();
    const deliverer = createDeliverer(
      async (): Promise<PickupResult> => {
        pickupCalls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        // Only the first call blocks on the gate; the coalesced re-run
        // (triggered by `second` arriving mid-flight) resolves immediately.
        if (pickupCalls === 1) await gate.promise;
        active -= 1;
        return { kind: "delivered", text: `pass-${pickupCalls}` };
      },
      async (text) => {
        published.push(text);
      },
    );

    const first = deliverer.deliverInbound("/repo");
    // The second call arrives while the first is still in flight (blocked
    // on `gate`) — it must coalesce into the first pass rather than run its
    // own overlapping `pickup`, and it must not await its own delivery.
    const second = deliverer.deliverInbound("/repo");
    gate.resolve();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    // Two passes ran (the second call's coalesced re-run drains the wake
    // it queued), but never concurrently — `deliverInFlight` serializes them.
    expect(pickupCalls).toBe(2);
    expect(maxActive).toBe(1);
    expect(published).toEqual(["pass-1", "pass-2"]);
    expect(firstOutcome).toBe("delivered");
    expect(secondOutcome).toBe("empty");
  });

  test("a wake landing mid-tick runs exactly one more pass afterwards", async () => {
    const published: string[] = [];
    const texts = ["first", "second"];
    let pickupCalls = 0;
    const firstGate = deferred<void>();
    const deliverer = createDeliverer(
      async (): Promise<PickupResult> => {
        const text = texts[pickupCalls];
        pickupCalls += 1;
        if (pickupCalls === 1) await firstGate.promise;
        return { kind: "delivered", text };
      },
      async (text) => {
        published.push(text);
      },
    );

    const first = deliverer.deliverInbound("/repo");
    // Simulate a wake arriving while the first pickup is still in flight,
    // then let the first pickup resolve.
    const second = deliverer.deliverInbound("/repo");
    firstGate.resolve();
    await Promise.all([first, second]);

    // Exactly one extra pass drained the coalesced wake — not zero (lost
    // delivery) and not one per queued wake (redundant pickups).
    expect(pickupCalls).toBe(2);
    expect(published).toEqual(["first", "second"]);
  });
});

/**
 * Guards the parameter *names* the tools expose, not their behaviour. Two
 * shipped runs failed their first call on a name alone — `text` where the
 * schema said only `task`, then `handle` where one schema said `target` —
 * so the names are a contract with the agent and drift in them is a bug.
 * Activating with a stub `pi` is safe because the poll timer is armed from
 * the `session_start` listener, which a captured-but-never-fired `on` never
 * runs.
 */
describe("registered tool schemas", () => {
  const params = new Map<string, string[]>();
  let priorHerdrEnv: string | undefined;

  beforeAll(() => {
    priorHerdrEnv = process.env.HERDR_ENV;
    // The extension registers nothing outside herdr, on purpose.
    process.env.HERDR_ENV = "1";

    // Only the shape matters here, so every zod node is the same chainable
    // sink. This keeps the test independent of which zod omp injects.
    const node: Record<string, unknown> = {};
    for (const method of ["describe", "optional", "int", "positive", "min", "max", "default"]) {
      node[method] = () => node;
    }
    const sink = () => node;
    const zod = {
      object: (shape: Record<string, unknown>) => ({ shape }),
      string: sink,
      boolean: sink,
      number: sink,
      array: sink,
      enum: sink,
    };

    const pi = {
      zod,
      registerTool: (config: { name: string; parameters: { shape: Record<string, unknown> } }) => {
        params.set(config.name, Object.keys(config.parameters.shape));
      },
      on: () => {},
      registerCommand: () => {},
    };
    foremanExtension(pi as unknown as Parameters<typeof foremanExtension>[0]);
  });

  afterAll(() => {
    if (priorHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = priorHerdrEnv;
  });

  test("activating registers the whole tool surface", () => {
    expect(params.size).toBeGreaterThan(0);
    expect([...params.keys()]).toContain("foreman_msg");
  });

  test("no tool names its recipient anything but handle", () => {
    const synonyms = ["target", "to", "worker", "recipient", "member", "name"];
    const violations: string[] = [];
    for (const [tool, keys] of params) {
      for (const synonym of synonyms) {
        if (keys.includes(synonym)) violations.push(`${tool}.${synonym}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("foreman_msg takes the handle its prose examples all pass", () => {
    expect(params.get("foreman_msg")).toContain("handle");
  });

  test("both message-sending tools accept either body name", () => {
    for (const tool of ["foreman_send", "foreman_msg"]) {
      expect(params.get(tool)).toContain("task");
      expect(params.get(tool)).toContain("text");
    }
  });
});
