import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliverer, deliveryFor, loadCommandPrompts, type PickupResult } from "./index";

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
  const question = "\n=== smoke — QUESTION — branch test/bus-smoke\nShould I call it A or B?\n";
  const report = "\n=== smoke (done) — branch test/bus-smoke\nforeman 0.6.0\n";
  const task = "Rework the retry policy in core/retry.ts.\n\n-- foreman protocol --\n";

  test("a report interrupts the boss, because the boss is the one waiting on it", () => {
    // Measured on one live run over this same channel: queued, the report
    // landed 78.6s after filing and after the boss's closing message, having
    // sent it hunting through twelve tool calls to `report.md` on disk.
    // Steered, its sibling question landed in 1.65s.
    const { deliverAs, customType, content } = deliveryFor(report);
    expect(deliverAs).toBe("steer");
    expect(customType).toBe("Foreman Report");
    expect(content).toContain("foreman 0.6.0");
  });

  test("a question interrupts, and says it is blocking somebody", () => {
    const { deliverAs, customType, content } = deliveryFor(question);
    expect(deliverAs).toBe("steer");
    expect(customType).toBe("Foreman Question");
    expect(content).toContain("Should I call it A or B?");
    expect(content).toContain("blocked and waiting");
  });

  test("a task queues, because a worker interrupted mid-change is what the CLI refuses to create", () => {
    const { deliverAs, customType, content } = deliveryFor(task);
    expect(deliverAs).toBe("followUp");
    expect(customType).toBe("Foreman Task");
    expect(content).toBe(task);
  });

  test("every interruption carries the protocol for absorbing it", () => {
    // A bare steer reads as "drop everything", which loses a half-applied
    // edit. Being interrupted is normal for a boss; finishing the current
    // step first is what keeps it from being destructive.
    for (const text of [report, question]) {
      expect(deliveryFor(text).content).toContain("todo list");
      expect(deliveryFor(text).content).toContain("finish the step you are already on");
    }
  });

  test("a mixed sweep leads with the part that is blocking somebody", () => {
    // One sweep can print several workers. The question is the only half with
    // an agent stalled on it, so it names the interruption.
    const mixed = deliveryFor(report + question);
    expect(mixed.deliverAs).toBe("steer");
    expect(mixed.customType).toBe("Foreman Question");
  });

  test("a task body that merely mentions a report header does not count as one", () => {
    // The header has to start the line: `=== ` mid-sentence is prose.
    const chatty = "Refactor so the output reads === smoke (done) — branch b\n";
    expect(deliveryFor(chatty).deliverAs).toBe("followUp");
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
