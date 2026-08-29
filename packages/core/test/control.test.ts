import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAndValidateGlobalConfig } from "../src/config/load.ts";
import type { GlobalConfig } from "../src/config/schema.ts";
import { ControlClient, probeSocket, waitForSocket } from "../src/control/client.ts";
import { discoverLoops, readStatusFile, writeStatusFile } from "../src/control/registry.ts";
import { FrameDecoder, emptyBoardCounts } from "../src/control/protocol.ts";
import type { ControlOp, LoopSnapshot, LoopStage, ServerInfo } from "../src/control/protocol.ts";
import { ControlServer, type ControlHandlers } from "../src/control/server.ts";
import { INTAKE_LOOP_ID, repoLoopId } from "../src/control/paths.ts";

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
      stage: "full",
      dryRun: false,
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
    setStage: (stage: LoopStage) => {
      calls.push({ op: "setStage", args: [stage] });
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
      await client.request("setStage", { stage: "read-only" });
      expect(calls).toEqual([
        { op: "pause", args: [] },
        { op: "resume", args: [] },
        { op: "tick", args: [["refine"]] },
        { op: "setStage", args: ["read-only"] },
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
      setStage: () => {},
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
