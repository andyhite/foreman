import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultAndValidateGlobalConfig } from "../src/config/load.ts";
import type { GlobalConfig } from "../src/config/schema.ts";
import { ControlClient, probeSocket, waitForSocket } from "../src/control/client.ts";
import { discoverLoops, readStatusFile, writeStatusFile } from "../src/control/registry.ts";
import { FrameDecoder, LOOP_MODES, emptyBoardCounts, isLoopMode } from "../src/control/protocol.ts";
import type { ControlOp, LoopSnapshot, LoopMode, ServerInfo } from "../src/control/protocol.ts";
import { ControlServer, type ControlHandlers } from "../src/control/server.ts";
import { INTAKE_LOOP_ID, loopPaths, repoLoopId } from "../src/control/paths.ts";

const cleanupDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-control-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSnapshot(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    loop: {
      id: "repo:demo",
      kind: "repo",
      label: "demo",
      alias: "demo",
      team: "ENG",
      repoPath: "/tmp/demo",
      initiativeIds: [],
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.0",
    },
    runtime: {
      state: "running",
      mode: "yolo",
      dispatcher: "print",
      pausedAt: null,
      lastTickAt: null,
      nextTickAt: null,
      ticks: 0,
      uptimeMs: 0,
    },
    workers: [],
    agents: [],
    wip: { global: { used: 0, cap: 3 }, byStage: [] },
    backpressure: { tripped: false, blockedCount: 0, threshold: 5, reason: null },
    board: emptyBoardCounts(),
    queues: { blocked: [], proposals: [], decisions: [], pipeline: [] },
    linear: { ok: true, lastPollAt: null, lastError: null, requests: 0 },
    history: { dispatchesPerTick: [] },
    ...overrides,
  };
}

function makeInfo(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return {
    loopId: "repo:demo",
    kind: "repo",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: "0.0.0",
    protocol: 1,
    ...overrides,
  };
}

interface HandlerCall {
  op: ControlOp;
  args: unknown[];
}

function makeHandlers(snapshot: LoopSnapshot, calls: HandlerCall[]): ControlHandlers {
  return {
    snapshot: () => snapshot,
    pause: () => {
      calls.push({ op: "pause", args: [] });
    },
    resume: () => {
      calls.push({ op: "resume", args: [] });
    },
    stop: (mode) => {
      calls.push({ op: "stop", args: [mode] });
    },
    tick: (workers) => {
      calls.push({ op: "tick", args: [workers] });
    },
    setMode: (mode: LoopMode) => {
      calls.push({ op: "setMode", args: [mode] });
    },
    patchConfig: (patch) => {
      calls.push({ op: "patchConfig", args: [patch] });
    },
    reload: () => {
      calls.push({ op: "reload", args: [] });
    },
    attachAgent: (dispatchId) => {
      calls.push({ op: "attachAgent", args: [dispatchId] });
    },
    killAgent: (dispatchId) => {
      calls.push({ op: "killAgent", args: [dispatchId] });
    },
  };
}

describe("ControlServer / ControlClient round trip", () => {
  it("connects, fetches a snapshot, and forwards control verbs to the handlers", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const snapshot = makeSnapshot();
    const calls: HandlerCall[] = [];
    const server = new ControlServer({ socketPath, handlers: makeHandlers(snapshot, calls), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      const info = await client.connect();
      expect(info.protocol).toBe(1);
      expect(await client.request<LoopSnapshot>("snapshot")).toEqual(snapshot);
      await client.request("pause");
      await client.request("resume");
      await client.request("tick", { workers: ["refine"] });
      await client.request("setMode", { mode: "confirm" });
      expect(calls).toEqual([
        { op: "pause", args: [] },
        { op: "resume", args: [] },
        { op: "tick", args: [["refine"]] },
        { op: "setMode", args: ["confirm"] },
      ]);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("returns ok:false with the message when a handler throws, and keeps answering", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const handlers: ControlHandlers = {
      snapshot: () => {
        throw new Error("linear is down");
      },
      pause: () => {},
      resume: () => {},
      stop: () => {},
      tick: () => {},
      setMode: () => {},
      patchConfig: () => {},
      reload: () => {},
      attachAgent: () => {},
      killAgent: () => {},
    };
    const server = new ControlServer({ socketPath, handlers, info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      await expect(client.request("snapshot")).rejects.toThrow("linear is down");
      await client.request("pause"); // still answers after a prior failure
    } finally {
      client.close();
      await server.close();
    }
  });

  it("subscribe receives a broadcast log event, and pre-subscribe logs replay via recentLogs", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const snapshot = makeSnapshot();
    const server = new ControlServer({
      socketPath,
      handlers: makeHandlers(snapshot, []),
      info: makeInfo(),
    });
    await server.listen();
    server.publishLog("info", "before subscribe");
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      const { promise: gotAfter, resolve: resolveAfter } = Promise.withResolvers<void>();
      const received: string[] = [];
      const unsubscribe = await client.subscribe((event) => {
        if (event.event !== "log") return;
        received.push(event.line);
        if (event.line === "after subscribe") resolveAfter();
      });
      server.publishLog("warn", "after subscribe");
      await gotAfter;
      expect(received).toContain("after subscribe");
      expect(server.recentLogs().map((r) => r.line)).toContain("before subscribe");
      unsubscribe();
    } finally {
      client.close();
      await server.close();
    }
  });
});

describe("FrameDecoder", () => {
  it("reassembles a frame split mid-JSON across three chunks", () => {
    const decoder = new FrameDecoder();
    const payload = JSON.stringify({ id: 1, op: "snapshot" });
    const part1 = payload.slice(0, 5);
    const part2 = payload.slice(5, 12);
    const part3 = `${payload.slice(12)}\n`;
    expect(decoder.push(part1)).toEqual([]);
    expect(decoder.push(part2)).toEqual([]);
    expect(decoder.push(part3)).toEqual([{ id: 1, op: "snapshot" }]);
  });

  it("drops a garbage line without losing the following valid frame", () => {
    const decoder = new FrameDecoder();
    const good = JSON.stringify({ id: 2, op: "pause" });
    const frames = decoder.push(`not json at all\n${good}\n`);
    expect(frames).toEqual([{ id: 2, op: "pause" }]);
  });
});

describe("ControlServer.listen", () => {
  it("rejects against a socket path held by a live server", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const snapshot = makeSnapshot();
    const server = new ControlServer({
      socketPath,
      handlers: makeHandlers(snapshot, []),
      info: makeInfo(),
    });
    await server.listen();
    const contender = new ControlServer({
      socketPath,
      handlers: makeHandlers(snapshot, []),
      info: makeInfo(),
    });
    try {
      await expect(contender.listen()).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("succeeds against a stale socket file with no listener", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    // A leftover socket inode with nothing listening on it, the way a killed process would leave one.
    writeFileSync(socketPath, "");
    expect(existsSync(socketPath)).toBe(true);

    const server = new ControlServer({
      socketPath,
      handlers: makeHandlers(makeSnapshot(), []),
      info: makeInfo(),
    });
    await server.listen();
    expect(server.listening).toBe(true);
    await server.close();
  });
});

describe("ControlServer param validation", () => {
  it("rejects tick with a non-string-array workers param instead of throwing", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      await expect(client.request("tick", { workers: 42 })).rejects.toThrow(/invalid workers/);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("rejects stop with an unknown mode", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      await expect(client.request("stop", { mode: "immediately" })).rejects.toThrow(/invalid stop mode/);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("rejects logs with a negative sinceSeq", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      await expect(client.request("logs", { sinceSeq: -1 })).rejects.toThrow(/invalid sinceSeq/);
    } finally {
      client.close();
      await server.close();
    }
  });
});

describe("ControlServer.close unlink safety", () => {
  it("does not unlink the socket file when listen() never bound (e.g. EADDRINUSE loss)", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const holder = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await holder.listen();
    const contender = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    try {
      await expect(contender.listen()).rejects.toThrow();
      // The contender never bound; closing it must not delete the holder's live socket file.
      await contender.close();
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await holder.close();
    }
  });
});

describe("probeSocket / waitForSocket", () => {
  it("probeSocket resolves false for a nonexistent path rather than throwing", async () => {
    const dir = tempDir();
    await expect(probeSocket(join(dir, "nope.sock"), 200)).resolves.toBe(false);
  });

  it("waitForSocket resolves the info once the server starts listening", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({
      socketPath,
      handlers: makeHandlers(makeSnapshot(), []),
      info: makeInfo(),
    });
    // Deliberately delays listen() past waitForSocket's first poll, to exercise the poll loop for real.
    const { promise: listenPromise, resolve: resolveListen } = Promise.withResolvers<void>();
    setTimeout(() => {
      server.listen().then(resolveListen);
    }, 100);
    const [info] = await Promise.all([waitForSocket(socketPath, 2000), listenPromise]);
    expect(info?.protocol).toBe(1);
    await server.close();
  });
});

describe("probeSocket / waitForSocket", () => {
  it("probeSocket resolves false for a nonexistent path rather than throwing", async () => {
    const dir = tempDir();
    await expect(probeSocket(join(dir, "nope.sock"), 200)).resolves.toBe(false);
  });

  it("waitForSocket resolves the info once the server starts listening", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({
      socketPath,
      handlers: makeHandlers(makeSnapshot(), []),
      info: makeInfo(),
    });
    const listenPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        server.listen().then(resolve);
      }, 100);
    });
    const [info] = await Promise.all([waitForSocket(socketPath, 2000), listenPromise]);
    expect(info?.protocol).toBe(1);
    await server.close();
  });
});

describe("writeStatusFile / readStatusFile", () => {
  it("round trips a snapshot", () => {
    const dir = tempDir();
    const statusPath = join(dir, "status.json");
    const snapshot = makeSnapshot();
    writeStatusFile(statusPath, snapshot);
    const statusFile = readStatusFile(statusPath);
    expect(statusFile).not.toBeNull();
    expect(statusFile?.snapshot).toEqual(snapshot);
    expect(statusFile?.schema).toBe(1);
  });

  it("reads a truncated status file as null", () => {
    const dir = tempDir();
    const statusPath = join(dir, "status.json");
    writeStatusFile(statusPath, makeSnapshot());
    truncateSync(statusPath, 10);
    expect(readStatusFile(statusPath)).toBeNull();
  });

  it("reads a missing status file as null", () => {
    const dir = tempDir();
    expect(readStatusFile(join(dir, "missing.json"))).toBeNull();
  });
});

describe("discoverLoops", () => {
  function makeConfig(home: string): GlobalConfig {
    return defaultAndValidateGlobalConfig(
      {
        loop: { stateDir: join(home, "state") },
        repos: {
          zeta: { path: join(home, "zeta"), initiatives: ["INIT-1"] },
          alpha: { path: join(home, "alpha"), initiatives: ["INIT-2"] },
        },
      },
      "test fixture",
    );
  }

  it("returns repo aliases sorted plus intake, all stopped and unreachable", async () => {
    const home = tempDir();
    const config = makeConfig(home);
    const handles = await discoverLoops(config, { home, probe: true, staleAfterMs: 90_000 });
    expect(handles.map((h) => h.id)).toEqual([repoLoopId("alpha"), repoLoopId("zeta"), INTAKE_LOOP_ID]);
    for (const handle of handles) {
      expect(handle.running).toBe(false);
      expect(handle.reachable).toBe(false);
      expect(handle.status).toBeNull();
    }
    expect(handles[2]?.kind).toBe("intake");
    expect(handles[2]?.label).toBe("intake");
  });
});

describe("ControlServer / ControlClient backpressure and frame validation", () => {
  it("round-trips a snapshot response above the socket write-buffer size instead of destroying the connection", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    // A single `queues.pipeline` entry pads the payload well past 64 KiB (the historical socket
    // buffer threshold that used to trigger `destroy()` on `write() === false`) once repeated.
    const bigSnapshot = makeSnapshot({
      queues: {
        blocked: [],
        proposals: [],
        decisions: [],
        pipeline: Array.from({ length: 400 }, (_, i) => ({
          issueId: `ENG-${i}`,
          title: "x".repeat(300),
          state: "Backlog",
          priority: 3,
          estimate: null,
          labels: [],
          assignee: null,
          updatedAt: "2026-08-29T00:00:00.000Z",
          url: `https://linear.app/example/issue/ENG-${i}`,
        })),
      },
    });
    const server = new ControlServer({ socketPath, handlers: makeHandlers(bigSnapshot, []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      const received = await client.request<LoopSnapshot>("snapshot");
      expect(JSON.stringify(received).length).toBeGreaterThan(64 * 1024);
      expect(received).toEqual(bigSnapshot);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("rejects setMode with a non-LoopMode value instead of forwarding it to the handler", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const snapshot = makeSnapshot();
    const calls: HandlerCall[] = [];
    const server = new ControlServer({ socketPath, handlers: makeHandlers(snapshot, calls), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      await expect(client.request("setMode", { mode: "full-autonomy" })).rejects.toThrow();
      expect(calls).toEqual([]);
    } finally {
      client.close();
      await server.close();
    }
  });
});

describe("isLoopMode / LOOP_MODES", () => {
  it("accepts every declared mode and rejects everything else", () => {
    for (const mode of LOOP_MODES) {
      expect(isLoopMode(mode)).toBe(true);
    }
    expect(isLoopMode("full-autonomy")).toBe(false);
    expect(isLoopMode(null)).toBe(false);
    expect(isLoopMode(undefined)).toBe(false);
    expect(isLoopMode(3)).toBe(false);
  });
});

describe("ControlServer.listen permissions", () => {
  it("creates the socket's parent directory at 0700 and chmods the socket to 0600", async () => {
    const dir = tempDir();
    const nested = join(dir, "nested");
    const socketPath = join(nested, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    try {
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });
});

describe("ControlClient resilience", () => {
  it("a throwing subscriber does not break delivery to a later subscriber, and does not crash the client", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      const { promise: gotIt, resolve: resolveGotIt } = Promise.withResolvers<void>();
      await client.subscribe(() => {
        throw new Error("subscriber blew up");
      });
      await client.subscribe((event) => {
        if (event.event === "log" && event.line === "ping") resolveGotIt();
      });
      server.publishLog("info", "ping");
      await gotIt;
    } finally {
      client.close();
      await server.close();
    }
  });


  it("delivers a broadcast that arrives while subscribe is in flight", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    try {
      await client.connect();
      const { promise: gotRace, resolve: resolveRace } = Promise.withResolvers<void>();
      const subscribePromise = client.subscribe((event) => {
        if (event.event === "log" && event.line === "during subscribe") resolveRace();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      server.publishLog("info", "during subscribe");
      await subscribePromise;
      await gotRace;
    } finally {
      client.close();
      await server.close();
    }
  });

  it("invokes each close handler only once when error and close both fire", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    await client.connect();
    let closeCount = 0;
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    client.onClose(() => {
      closeCount += 1;
      resolveClosed();
    });
    await server.close();
    await closed;
    expect(closeCount).toBe(1);
  });
  it("a throwing close handler does not prevent a later close handler from running", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "control.sock");
    const server = new ControlServer({ socketPath, handlers: makeHandlers(makeSnapshot(), []), info: makeInfo() });
    await server.listen();
    const client = new ControlClient({ socketPath });
    await client.connect();
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    client.onClose(() => {
      throw new Error("close handler blew up");
    });
    client.onClose(() => resolveClosed());
    await server.close();
    await closed;
  });
});


describe("ControlServer lockPath", () => {
  it("names the holder from lockPath, not dirname(socketPath), when the socket is already held", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "runtime", "foreman.sock");
    const lockPath = join(dir, "state", "loop.lock");
    mkdirSync(dirname(socketPath), { recursive: true });
    mkdirSync(dirname(lockPath), { recursive: true });

    const first = new ControlServer({
      socketPath,
      lockPath,
      handlers: makeHandlers(makeSnapshot(), []),
      info: makeInfo(),
    });
    await first.listen();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", token: "t" }),
      "utf8",
    );

    const second = new ControlServer({
      socketPath,
      lockPath,
      handlers: makeHandlers(makeSnapshot(), []),
      info: makeInfo(),
    });
    await expect(second.listen()).rejects.toThrow(/pid 4242/);
    await first.close();
  });
});

describe("writeStatusFile validation", () => {
  it("refuses to write a snapshot that fails StatusFileSchema validation, leaving any prior file intact", () => {
    const dir = tempDir();
    const statusPath = join(dir, "status.json");
    const good = makeSnapshot();
    writeStatusFile(statusPath, good);
    const invalid = { ...good, runtime: { ...good.runtime, mode: "not-a-real-mode" } } as unknown as LoopSnapshot;
    writeStatusFile(statusPath, invalid);
    const statusFile = readStatusFile(statusPath);
    expect(statusFile?.snapshot).toEqual(good);
  });
});

describe("loopPaths socket fallback", () => {
  it("moves the socket into a private 0700 per-user runtime directory, not directly into the shared tmpdir, for a long alias", () => {
    const home = tempDir();
    const config = defaultAndValidateGlobalConfig(
      { loop: { stateDir: join(home, "a".repeat(60), "deeply", "nested", "state", "root") }, repos: {} },
      "test fixture",
    );
    const paths = loopPaths(config, repoLoopId("x".repeat(60)), home);
    expect(paths.socket.length).toBeLessThanOrEqual(104);
    if (!process.env.XDG_RUNTIME_DIR) {
      const uid = process.getuid?.() ?? 0;
      const runtimeDir = join(tmpdir(), `foreman-${uid}`);
      expect(paths.socket.startsWith(`${runtimeDir}/`)).toBe(true);
      expect(paths.socket).not.toBe(join(tmpdir(), `foreman-${uid}.sock`));
      expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
    }
  });
});
