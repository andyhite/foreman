import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@oh-my-pi/pi-coding-agent";
import {
  canSend,
  deriveHandle,
  drainOnce,
  loadRoleConfig,
  loadSetupConfig,
  messageFilename,
  renderInbox,
  resolveBrief,
  resolveSelf,
  stateSlug,
  deliveryOptions,
  urgencyKind,
  validHandle,
  waitForMail,
  type DrainDeps,
  type BriefRequest,
  type Message,
  type RoleDefinition,
  type RosterEntry,
} from "./index";

// ---------------------------------------------------------------------
// 1. stateSlug
// ---------------------------------------------------------------------

describe("stateSlug", () => {
  test("slugifies an absolute git-common-dir path, stripping the leading separator", () => {
    expect(stateSlug("/Users/a/Code/plotroom/.git")).toBe("Users-a-Code-plotroom-.git");
  });
});

// ---------------------------------------------------------------------
// 2. validHandle
// ---------------------------------------------------------------------

describe("validHandle", () => {
  test("accepts lowercase letters, digits, hyphens, underscores, up to 32 chars", () => {
    expect(validHandle("a")).toBe(true);
    expect(validHandle("auth-2")).toBe(true);
    expect(validHandle("a_b")).toBe(true);
    expect(validHandle("a".repeat(32))).toBe(true);
  });

  test("rejects empty, digit-first, uppercase, spaces, and 33+ chars", () => {
    expect(validHandle("")).toBe(false);
    expect(validHandle("1a")).toBe(false);
    expect(validHandle("Auth")).toBe(false);
    expect(validHandle("a b")).toBe(false);
    expect(validHandle("a".repeat(33))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 3. deriveHandle
// ---------------------------------------------------------------------

describe("deriveHandle", () => {
  test("passes a clean repo name through unchanged", () => {
    expect(deriveHandle("/Users/a/Code/plotroom", [])).toBe("plotroom");
  });

  test("lowercases and replaces invalid characters", () => {
    expect(deriveHandle("/Users/a/Code/My.Repo", [])).toBe("my-repo");
  });

  test("prefixes r when the slug does not start with a letter", () => {
    expect(deriveHandle("/Users/a/Code/2fast", [])).toBe("r2fast");
  });

  test("appends -2 on collision", () => {
    expect(deriveHandle("/Users/a/Code/plotroom", ["plotroom"])).toBe("plotroom-2");
  });
});

// ---------------------------------------------------------------------
// 4. messageFilename
// ---------------------------------------------------------------------

describe("messageFilename", () => {
  test("sorts ascending for increasing n", () => {
    const a = messageFilename("plotroom", 0);
    const b = messageFilename("plotroom", 1);
    expect(a < b).toBe(true);
  });

  test("two senders at the same n produce different names", () => {
    const a = messageFilename("alice", 5);
    const b = messageFilename("bob", 5);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------
// 5. urgencyKind + deliveryOptions
// ---------------------------------------------------------------------

function msg(kind: Message["kind"], overrides: Partial<Message> = {}): Message {
  return { from: "plotroom", to: "auth", kind, text: "text", sentAt: new Date().toISOString(), ...overrides };
}

describe("urgencyKind", () => {
  test("all send stays send", () => {
    expect(urgencyKind([msg("send"), msg("send")])).toBe("send");
  });

  test("any ask promotes the whole batch to ask", () => {
    expect(urgencyKind([msg("send"), msg("ask")])).toBe("ask");
  });
});

describe("deliveryOptions", () => {
  // Dropping `triggerTurn` is the silent-loss bug: an idle worker pane never
  // gets a next user prompt to flush the queued message.
  test("every kind sets triggerTurn", () => {
    for (const kind of ["brief", "send", "ask"] as const) {
      expect(deliveryOptions(kind).triggerTurn).toBe(true);
    }
  });

  test("only ask is allowed to interrupt", () => {
    expect(deliveryOptions("ask").deliverAs).toBe("steer");
    expect(deliveryOptions("send").deliverAs).toBe("followUp");
    expect(deliveryOptions("brief").deliverAs).toBe("followUp");
  });
});

// ---------------------------------------------------------------------
// 6. renderInbox
// ---------------------------------------------------------------------

describe("renderInbox", () => {
  const self: RosterEntry = {
    handle: "auth",
    parent: "plotroom",
    cwd: "/Users/a/Code/plotroom-auth",
    branch: "andy/auth",
    spawnSha: "abc123",
    workspaceId: "wA5",
    paneId: "wA5:p1",
    kind: "worker",
    createdAt: new Date().toISOString(),
  };

  test("brief includes the branch and worktree", () => {
    const text = renderInbox([msg("brief", { text: "build the thing" })], self);
    expect(text).toContain("Branch: andy/auth");
    expect(text).toContain("Worktree: /Users/a/Code/plotroom-auth");
  });

  test("ask includes BLOCKED and the sender handle", () => {
    const text = renderInbox([msg("ask", { from: "plotroom", text: "which colour?" })], self);
    expect(text).toContain("BLOCKED");
    expect(text).toContain("[foreman:plotroom]");
  });

  test("a message from self's parent carries the worker-skill reminder", () => {
    const text = renderInbox([msg("send", { from: "plotroom" })], self);
    expect(text).toContain("skill://foreman-worker");
  });

  test("a message from self's parent also carries the explicit foreman_send reminder", () => {
    const text = renderInbox([msg("send", { from: "plotroom" })], self);
    expect(text).toContain("call foreman_send to report back");
  });

  test("a message from a spawned child does not carry the foreman_send reminder", () => {
    const text = renderInbox([msg("send", { from: "auth-sub", to: "auth" })], self);
    expect(text).not.toContain("call foreman_send to report back");
  });

  test("a message from a spawned child carries the spawner-skill reminder", () => {
    const text = renderInbox([msg("send", { from: "auth-sub", to: "auth" })], self);
    expect(text).toContain("skill://foreman-spawner");
  });

  test("a 3-message batch is prefixed and separated correctly", () => {
    const text = renderInbox([msg("send"), msg("send"), msg("send")], self);
    expect(text.startsWith("[foreman] 3 queued messages")).toBe(true);
    expect(text.split("\n\n---\n\n").length - 1).toBe(2);
  });

  const expertSelf: RosterEntry = { ...self, handle: "pm", branch: null, spawnSha: null, kind: "expert" };

  test("a convened expert's brief has no branch/worktree, names itself standing", () => {
    const text = renderInbox([msg("brief", { from: "plotroom", to: "pm", text: "plan the sprint" })], expertSelf);
    expect(text).not.toContain("Branch:");
    expect(text).toContain("standing expert");
    expect(text).toContain(expertSelf.cwd);
  });

  test("a message from a convened expert's parent carries the expert-skill reminder", () => {
    const text = renderInbox([msg("send", { from: "plotroom", to: "pm" })], expertSelf);
    expect(text).toContain("skill://foreman-expert");
    expect(text).toContain("call foreman_send to report back");
  });
});

// ---------------------------------------------------------------------
// 7. resolveSelf
// ---------------------------------------------------------------------

function seedRoster(root: string, entry: Partial<RosterEntry> & { handle: string }): void {
  const dir = join(root, "roster");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${entry.handle}.json`), JSON.stringify(entry));
}

describe("resolveSelf", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "foreman-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("disambiguates two roster entries sharing a cwd by pane id", () => {
    const base = {
      parent: "plotroom",
      cwd: "/x/shared",
      branch: null,
      spawnSha: null,
      workspaceId: "wA5",
      kind: "expert",
      createdAt: new Date().toISOString(),
    };
    seedRoster(root, { ...base, handle: "pm", paneId: "wA5:pB" });
    seedRoster(root, { ...base, handle: "release", paneId: "wA5:pC" });
    const self = resolveSelf(root, "/x/shared", "wA5:pC");
    expect(self.handle).toBe("release");
  });

  test("defaults a roster entry with no kind field to worker", () => {
    seedRoster(root, {
      handle: "auth",
      parent: "plotroom",
      cwd: "/x/plotroom-auth",
      branch: "andy/auth",
      spawnSha: "abc123",
      workspaceId: "wA5",
      paneId: "wA5:p1",
      createdAt: new Date().toISOString(),
    });
    const self = resolveSelf(root, "/x/plotroom-auth", "wA5:p1");
    expect(self.kind).toBe("worker");
  });

  test("registers a brand-new handle for an unknown cwd", () => {
    const self = resolveSelf(root, "/x/plotroom-new", null);
    expect(self.kind).toBe("worker");
    expect(self.cwd).toBe("/x/plotroom-new");
  });
});

// ---------------------------------------------------------------------
// 8-11. drainOnce
// ---------------------------------------------------------------------

function makeExec(repoRoot: string) {
  return async (cmd: string, args: string[]): Promise<unknown> => {
    if (cmd === "git" && args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      return { code: 0, stdout: `${repoRoot}/.git\n`, stderr: "" };
    }
    if (cmd === "git" && args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
    }
    throw new Error(`unexpected exec in test stub: ${cmd} ${args.join(" ")}`);
  };
}

function seedMail(root: string, handle: string, filename: string, content: string): void {
  const dir = join(root, "mail", handle);
  writeFileSync(join(dir, filename), content);
}

describe("drainOnce", () => {
  let stateDir: string;
  const repoRoot = "/synthetic/plotroom";
  const handle = "plotroom"; // deriveHandle("/synthetic/plotroom", []) === "plotroom"

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "foreman-test-"));
    process.env.FOREMAN_STATE = stateDir;
    const mailDir = join(stateDir, "mail", handle);
    mkdirSync(mailDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.FOREMAN_STATE;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("delivers once, moves files from mail/ to done/", async () => {
    seedMail(stateDir, handle, "1-boss-000.json", JSON.stringify(msg("send", { to: handle, text: "hello" })));
    let calls = 0;
    let lastContent = "";
    const deps: DrainDeps = {
      pi: {
        exec: makeExec(repoRoot),
        sendMessage: async (message) => {
          calls++;
          lastContent = message.content;
        },
      },
      cwd: repoRoot,
    };
    await drainOnce(deps);
    expect(calls).toBe(1);
    expect(lastContent).toContain("hello");
    expect(readdirSync(join(stateDir, "mail", handle))).toEqual([]);
    expect(readdirSync(join(stateDir, "done", handle))).toEqual(["1-boss-000.json"]);
  });

  test("sendMessage rejecting leaves files in mail/ for the next tick to retry", async () => {
    seedMail(stateDir, handle, "1-boss-000.json", JSON.stringify(msg("send", { to: handle, text: "hello" })));
    let calls = 0;
    const failingDeps: DrainDeps = {
      pi: {
        exec: makeExec(repoRoot),
        sendMessage: async () => {
          calls++;
          throw new Error("delivery failed");
        },
      },
      cwd: repoRoot,
    };
    await expect(drainOnce(failingDeps)).rejects.toThrow("delivery failed");
    expect(readdirSync(join(stateDir, "mail", handle))).toEqual(["1-boss-000.json"]);

    const succeedingDeps: DrainDeps = {
      pi: { exec: makeExec(repoRoot), sendMessage: async () => {} },
      cwd: repoRoot,
    };
    await drainOnce(succeedingDeps);
    expect(calls).toBe(1);
    expect(readdirSync(join(stateDir, "mail", handle))).toEqual([]);
    expect(readdirSync(join(stateDir, "done", handle))).toEqual(["1-boss-000.json"]);
  });

  test("a file that fails to parse lands in done/ with .bad appended; valid siblings still deliver", async () => {
    seedMail(stateDir, handle, "1-boss-000.json", "not json");
    seedMail(stateDir, handle, "2-boss-001.json", JSON.stringify(msg("send", { to: handle, text: "still arrives" })));
    let calls = 0;
    let lastContent = "";
    const deps: DrainDeps = {
      pi: {
        exec: makeExec(repoRoot),
        sendMessage: async (message) => {
          calls++;
          lastContent = message.content;
        },
      },
      cwd: repoRoot,
    };
    await drainOnce(deps);
    expect(calls).toBe(1);
    expect(lastContent).toContain("still arrives");
    expect(readdirSync(join(stateDir, "mail", handle))).toEqual([]);
    const done = readdirSync(join(stateDir, "done", handle)).sort();
    expect(done).toEqual(["1-boss-000.json.bad", "2-boss-001.json"]);
  });

  test("re-entrancy: a second concurrent call is a no-op while the first is in flight", async () => {
    seedMail(stateDir, handle, "1-boss-000.json", JSON.stringify(msg("send", { to: handle, text: "hello" })));
    let calls = 0;
    const { promise: sent, resolve: notifySent } = Promise.withResolvers<void>();
    const { promise: held, resolve: releaseSend } = Promise.withResolvers<void>();
    const deps: DrainDeps = {
      pi: {
        exec: makeExec(repoRoot),
        sendMessage: async () => {
          calls++;
          notifySent();
          // Held open so `first` is provably still in flight when `second`
          // returns early, then released below — leaving it pending would
          // stick the module-level `draining` flag for every later test.
          return held;
        },
      },
      cwd: repoRoot,
    };
    const first = drainOnce(deps);
    const second = drainOnce(deps);
    await second; // returns immediately: `first` set `draining` synchronously
    await sent; // the real signal that `first` reached sendMessage, not a guessed duration
    expect(calls).toBe(1);
    releaseSend();
    await first;
  });
});

// ---------------------------------------------------------------------
// 12. canSend
// ---------------------------------------------------------------------

describe("canSend", () => {
  const self: RosterEntry = {
    handle: "auth",
    parent: "plotroom",
    cwd: "/x/plotroom-auth",
    branch: "andy/auth",
    spawnSha: "abc123",
    workspaceId: "wA5",
    paneId: "wA5:p1",
    kind: "worker",
    createdAt: new Date().toISOString(),
  };
  const sibling: RosterEntry = { ...self, handle: "billing", cwd: "/x/plotroom-billing" };
  const child: RosterEntry = { ...self, handle: "auth-sub", parent: "auth", cwd: "/x/plotroom-auth-sub" };
  const roster = [self, sibling, child];

  test("accepts the parent", () => {
    expect(canSend(self, "plotroom", roster)).toBe(true);
  });

  test("accepts a worker it spawned", () => {
    expect(canSend(self, "auth-sub", roster)).toBe(true);
  });

  test("rejects a sibling", () => {
    expect(canSend(self, "billing", roster)).toBe(false);
  });

  test("rejects an unknown handle", () => {
    expect(canSend(self, "nobody", roster)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 13. waitForMail — mail must reach exactly one of the two delivery paths
// ---------------------------------------------------------------------

describe("waitForMail", () => {
  let stateDir: string;
  let calls: number;
  let deps: DrainDeps;
  let tick: (() => void | Promise<void>) | null;
  let ctx: ExtensionToolContext;
  const repoRoot = "/synthetic/plotroom";
  const handle = "plotroom";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "foreman-wait-"));
    process.env.FOREMAN_STATE = stateDir;
    mkdirSync(join(stateDir, "mail", handle), { recursive: true });
    calls = 0;
    deps = {
      pi: {
        exec: makeExec(repoRoot),
        sendMessage: async () => {
          calls++;
        },
      },
      cwd: repoRoot,
    };
    // Driving the interval by hand rather than with real timers: Bun's
    // `setInterval` returns a Timer, not the `number` the DOM lib promises,
    // so a fake that actually armed one could not clear it without a cast.
    tick = null;
    ctx = {
      cwd: repoRoot,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearTimer: () => {
        tick = null;
      },
    };
  });

  afterEach(() => {
    delete process.env.FOREMAN_STATE;
    rmSync(stateDir, { recursive: true, force: true });
  });

  // Every test drives the timeout check by hand, so nothing here waits on the
  // wall clock. The "mail arrives while blocked" case is deliberately absent:
  // it enters `drainOnce` on the same `takeDelivery` branch the first test
  // already covers, and reaching it from outside would mean racing the drain
  // `waitForMail` fires on arming.

  test("mail already pending is handed to the waiter, not injected", async () => {
    seedMail(stateDir, handle, "1-boss-000.json", JSON.stringify(msg("send", { to: handle, text: "hello" })));
    expect(await waitForMail(deps, ctx, undefined, 60_000)).toContain("hello");
    // The whole point: no second copy went out as an injected turn.
    expect(calls).toBe(0);
    expect(readdirSync(join(stateDir, "done", handle))).toEqual(["1-boss-000.json"]);
  });

  test("a wait with nothing to deliver resolves null", async () => {
    const pending = waitForMail(deps, ctx, undefined, 0);
    tick?.();
    expect(await pending).toBeNull();
    expect(calls).toBe(0);
  });


  test("an aborted wait resolves null and releases the slot", async () => {
    const controller = new AbortController();
    const pending = waitForMail(deps, ctx, controller.signal, 60_000);
    controller.abort();
    tick?.();
    expect(await pending).toBeNull();
    // Slot released, so a fresh wait is accepted rather than refused.
    const second = waitForMail(deps, ctx, undefined, 0);
    tick?.();
    expect(await second).toBeNull();
  });

  test("a second wait is refused while one is blocked", async () => {
    const first = waitForMail(deps, ctx, undefined, 0);
    await expect(waitForMail(deps, ctx, undefined, 0)).rejects.toThrow("already blocked");
    tick?.();
    expect(await first).toBeNull();
  });
});

// ---------------------------------------------------------------------
// 14. loadRoleConfig
// ---------------------------------------------------------------------

describe("loadRoleConfig", () => {
  let rolesFile: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
    rolesFile = join(dir, "roles.json");
    savedEnv = process.env.FOREMAN_ROLES_FILE;
    process.env.FOREMAN_ROLES_FILE = rolesFile;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.FOREMAN_ROLES_FILE;
    else process.env.FOREMAN_ROLES_FILE = savedEnv;
    rmSync(join(rolesFile, ".."), { recursive: true, force: true });
  });

  test("returns no roles when the file doesn't exist", () => {
    expect(loadRoleConfig("/unused")).toEqual({});
  });

  test("parses a role, defaulting missing skills and model", () => {
    writeFileSync(rolesFile, JSON.stringify({ pm: { description: "Owns scope.", brief: "Plan sprints." } }));
    expect(loadRoleConfig("/unused")).toEqual({
      pm: { description: "Owns scope.", brief: "Plan sprints.", skills: [], model: null },
    });
  });

  test("parses skills and model when present", () => {
    writeFileSync(
      rolesFile,
      JSON.stringify({ release: { description: "Ships.", brief: "Tag releases.", skills: ["skill://release-process"], model: "opus" } }),
    );
    expect(loadRoleConfig("/unused").release).toEqual({
      description: "Ships.",
      brief: "Tag releases.",
      skills: ["skill://release-process"],
      model: "opus",
    });
  });

  test("throws on invalid JSON", () => {
    writeFileSync(rolesFile, "{not json");
    expect(() => loadRoleConfig("/unused")).toThrow(/not valid JSON/);
  });

  test("throws when a role is missing description or brief", () => {
    writeFileSync(rolesFile, JSON.stringify({ pm: { brief: "Plan sprints." } }));
    expect(() => loadRoleConfig("/unused")).toThrow(/needs a "description" and "brief"/);
  });

  test("throws when skills isn't a string array", () => {
    writeFileSync(rolesFile, JSON.stringify({ pm: { description: "d", brief: "b", skills: [1, 2] } }));
    expect(() => loadRoleConfig("/unused")).toThrow(/non-string "skills"/);
  });

  test("throws when model isn't a string or null", () => {
    writeFileSync(rolesFile, JSON.stringify({ pm: { description: "d", brief: "b", model: 7 } }));
    expect(() => loadRoleConfig("/unused")).toThrow(/non-string "model"/);
  });
});

// ---------------------------------------------------------------------
// 15. resolveBrief — shared by foreman_spawn and foreman_convene
// ---------------------------------------------------------------------

describe("resolveBrief", () => {
  const roles: Record<string, RoleDefinition> = {
    pm: { description: "Owns scope.", brief: "Plan sprints.", skills: ["skill://sprint-planning"], model: "opus" },
    empty: { description: "No extras.", brief: "Do the thing.", skills: [], model: null },
  };

  function request(overrides: Partial<BriefRequest> & { handle: string }): BriefRequest {
    return { ...overrides };
  }

  test("sources brief, skills, and model from the role alone", () => {
    const result = resolveBrief(request({ handle: "pm", role: "pm" }), roles);
    expect(result).toEqual({ text: "Load these skills, in order: skill://sprint-planning\n\nPlan sprints.", model: "opus" });
  });

  test("per-call brief is appended after the role's brief", () => {
    const result = resolveBrief(request({ handle: "pm", role: "pm", brief: "Plan this quarter specifically." }), roles);
    expect(result.text).toBe("Load these skills, in order: skill://sprint-planning\n\nPlan sprints.\n\nPlan this quarter specifically.");
  });

  test("per-call model overrides the role's model", () => {
    const result = resolveBrief(request({ handle: "pm", role: "pm", model: "sonnet" }), roles);
    expect(result.model).toBe("sonnet");
  });

  test("per-call skills are appended after the role's own", () => {
    const result = resolveBrief(request({ handle: "pm", role: "pm", skills: ["skill://extra"] }), roles);
    expect(result.text.startsWith("Load these skills, in order: skill://sprint-planning, skill://extra\n\n")).toBe(true);
  });

  test("throws naming known roles when an unconfigured role is requested", () => {
    expect(() => resolveBrief(request({ handle: "x", role: "ghost" }), roles)).toThrow(/known roles: pm, empty/);
  });

  test("throws saying no roles exist when the role map is empty", () => {
    expect(() => resolveBrief(request({ handle: "x", role: "ghost" }), {})).toThrow(/has no roles/);
  });

  test("throws when neither brief nor a role supplying one is given", () => {
    expect(() => resolveBrief(request({ handle: "x" }), roles)).toThrow(/needs a "brief"/);
  });

  test("text equals the brief verbatim when there are no skills", () => {
    const result = resolveBrief(request({ handle: "e", role: "empty" }), roles);
    expect(result.text).toBe("Do the thing.");
  });

  test("omits the model key entirely when no model resolves", () => {
    const result = resolveBrief(request({ handle: "e", role: "empty" }), roles);
    expect("model" in result).toBe(false);
  });

  test("ad hoc brief with no role works without any role map entry — the foreman_spawn case with no roles configured", () => {
    const result = resolveBrief(request({ handle: "x", brief: "Just do it." }), {});
    expect(result).toEqual({ text: "Just do it." });
  });

  test("a worker handle resolves the same way an expert handle does — no kind-specific branching", () => {
    const result = resolveBrief(request({ handle: "webhooks", role: "pm", skills: ["skill://webhooks"] }), roles);
    expect(result.text).toBe("Load these skills, in order: skill://sprint-planning, skill://webhooks\n\nPlan sprints.");
    expect(result.model).toBe("opus");
  });
});

// ---------------------------------------------------------------------
// 16. loadSetupConfig
// ---------------------------------------------------------------------

describe("loadSetupConfig", () => {
  let setupFile: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
    setupFile = join(dir, "setup.json");
    savedEnv = process.env.FOREMAN_SETUP_FILE;
    process.env.FOREMAN_SETUP_FILE = setupFile;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.FOREMAN_SETUP_FILE;
    else process.env.FOREMAN_SETUP_FILE = savedEnv;
    rmSync(join(setupFile, ".."), { recursive: true, force: true });
  });

  test("returns empty setup and teardown when the file doesn't exist", () => {
    expect(loadSetupConfig("/unused")).toEqual({ setup: [], teardown: [] });
  });

  test("parses both setup and teardown command arrays", () => {
    writeFileSync(setupFile, JSON.stringify({ setup: ["npm ci", "mise trust"], teardown: ["docker compose down"] }));
    expect(loadSetupConfig("/unused")).toEqual({ setup: ["npm ci", "mise trust"], teardown: ["docker compose down"] });
  });

  test("defaults a missing key to an empty array", () => {
    writeFileSync(setupFile, JSON.stringify({ setup: ["npm ci"] }));
    expect(loadSetupConfig("/unused")).toEqual({ setup: ["npm ci"], teardown: [] });
  });

  test("throws on invalid JSON", () => {
    writeFileSync(setupFile, "{not json");
    expect(() => loadSetupConfig("/unused")).toThrow(/not valid JSON/);
  });

  test("throws when the root isn't a JSON object", () => {
    writeFileSync(setupFile, JSON.stringify(["npm ci"]));
    expect(() => loadSetupConfig("/unused")).toThrow(/must be a JSON object/);
  });

  test("throws when setup isn't an array of command strings", () => {
    writeFileSync(setupFile, JSON.stringify({ setup: [1, 2] }));
    expect(() => loadSetupConfig("/unused")).toThrow(/"setup" must be an array of command strings/);
  });

  test("throws when teardown isn't an array of command strings", () => {
    writeFileSync(setupFile, JSON.stringify({ teardown: "docker compose down" }));
    expect(() => loadSetupConfig("/unused")).toThrow(/"teardown" must be an array of command strings/);
  });
});
