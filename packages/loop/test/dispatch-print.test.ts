import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "@foreman/core";
import { RESERVATIONS_ENV } from "@foreman/core";
import { herdrAgentName } from "../src/dispatch/herdr.ts";
import { PrintDispatcher } from "../src/dispatch/print.ts";

/** A fake `omp` binary: ignores every argument and exits with the given code. */
function fakeOmpBin(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-fake-omp-"));
  const path = join(dir, "fake-omp.sh");
  writeFileSync(path, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A fake `omp` binary that records its own argv to a file before exiting. */
function recordingOmpBin(exitCode: number): { bin: string; argvPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "foreman-fake-omp-"));
  const bin = join(dir, "fake-omp.sh");
  const argvPath = join(dir, "argv.json");
  writeFileSync(
    bin,
    `#!/bin/sh\nnode -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' '${argvPath}' "$@"\nexit ${exitCode}\n`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return { bin, argvPath };
}

function makeConfig(ompBin: string): GlobalConfig {
  return {
    repos: {},
    loop: {
      wipGlobal: 3,
      wip: { refine: 2, implement: 3, review: 2, plan: 1 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      claimGraceMs: 300_000,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      mode: "yolo",
      workerModes: {},
      mergeDetection: true,
      cleanupMergedWorktrees: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, batchesPerDay: 1, timezone: "UTC" },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql", allowCustomEndpoint: false },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin, approvalMode: "yolo", herdrBin: "herdr", herdrLayout: "tab", orchestratorMaxBatches: 20 },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

describe("PrintDispatcher.settle (SPEC §17.8: retained logs must be pruned once the outcome resolves)", () => {
  it("prunes the internal running entry after the first settle; a sibling settle returns the untracked default", async () => {
    const ompBin = fakeOmpBin(1);
    const dispatcher = new PrintDispatcher(makeConfig(ompBin));
    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: tmpdir(),
      alias: "acme",
      items: [
        { issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1", worktree: null },
        { issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2", worktree: null },
      ],
    });
    expect(handles).toHaveLength(2);

    const outcome = await dispatcher.settle(handles[0] as never);
    expect(outcome.status).toBe("settled");
    expect(outcome.exitCode).toBe(1);

    // The batch resolved once; the entry is pruned immediately, not held
    // for every handle to consume. A sibling's settle falls back to the
    // untracked-handle default rather than replaying the outcome.
    const sibling = await dispatcher.settle(handles[1] as never);
    expect(sibling).toEqual({ status: "settled", exitCode: null, log: "", handle: handles[1] as never });
  });
});

describe("PrintDispatcher", () => {
  it("spawns exactly one child carrying every subject in the batch's prompt argument", async () => {
    const { bin, argvPath } = recordingOmpBin(0);
    const dispatcher = new PrintDispatcher(makeConfig(bin));
    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: tmpdir(),
      alias: "acme",
      items: [
        { issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1", worktree: null },
        { issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2", worktree: null },
      ],
    });

    const outcomes = await Promise.all(handles.map((handle) => dispatcher.settle(handle)));
    expect(outcomes[0]?.exitCode).toBe(0);
    expect(outcomes[1]?.exitCode).toBe(0);
    expect(outcomes[0]?.log).toBe(outcomes[1]?.log);

    const argv = JSON.parse(readFileSync(argvPath, "utf8")) as string[];
    // The prompt is the single trailing argument, carrying both subjects.
    expect(argv[argv.length - 1]).toBe("/foreman:refine ENG-1 ENG-2");
  });

  it("sets FOREMAN_DISPATCH_ID only for a single-item request, and reservations for both", async () => {
    const singleDir = mkdtempSync(join(tmpdir(), "foreman-print-env-"));
    const singleScript = join(singleDir, "print-env");
    writeFileSync(
      singleScript,
      "#!/bin/sh\nprintf '%s|%s' \"${FOREMAN_DISPATCH_ID-unset}\" \"${FOREMAN_DISPATCH_RESERVATIONS-unset}\"\n",
    );
    chmodSync(singleScript, 0o755);
    const reservationsDir = mkdtempSync(join(tmpdir(), "foreman-reservations-"));
    try {
      const dispatcher = new PrintDispatcher(makeConfig(singleScript), { reservationsDir });

      const singleHandles = await dispatcher.dispatch({
        agent: "foreman-implement",
        command: "/foreman:implement",
        cwd: singleDir,
        alias: "acme",
        items: [{ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1", worktree: null }],
      });
      const singleOutcome = await dispatcher.settle(singleHandles[0] as never);
      const [singleDispatchId, singleReservations] = singleOutcome.log.split("|");
      expect(singleDispatchId).toBe("dispatch-1");
      expect(singleReservations).toBe(join(reservationsDir, "foreman-implement.json"));

      const batchHandles = await dispatcher.dispatch({
        agent: "foreman-refine",
        command: "/foreman:refine",
        cwd: singleDir,
        alias: "acme",
        items: [
          { issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2", worktree: null },
          { issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3", worktree: null },
        ],
      });
      const batchOutcome = await dispatcher.settle(batchHandles[0] as never);
      const [batchDispatchId, batchReservations] = batchOutcome.log.split("|");
      expect(batchDispatchId).toBe("unset");
      expect(batchReservations).toBe(join(reservationsDir, "foreman-refine.json"));
    } finally {
      rmSync(singleDir, { recursive: true, force: true });
      rmSync(reservationsDir, { recursive: true, force: true });
    }
  });

  it("sets FOREMAN_LOOP_SOCKET only when controlSocket is passed", async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "foreman-print-socket-"));
    const scriptPath = join(scriptDir, "print-env");
    writeFileSync(scriptPath, "#!/bin/sh\nprintf '%s' \"${FOREMAN_LOOP_SOCKET-unset}\"\n");
    chmodSync(scriptPath, 0o755);
    try {
      const withSocket = new PrintDispatcher(makeConfig(scriptPath), { controlSocket: "/state/control.sock" });
      const withHandles = await withSocket.dispatch({
        agent: "foreman-implement",
        command: "/foreman:implement",
        cwd: scriptDir,
        alias: "acme",
        items: [{ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1", worktree: null }],
      });
      const withOutcome = await withSocket.settle(withHandles[0] as never);
      expect(withOutcome.log).toBe("/state/control.sock");

      const withoutSocket = new PrintDispatcher(makeConfig(scriptPath));
      const withoutHandles = await withoutSocket.dispatch({
        agent: "foreman-implement",
        command: "/foreman:implement",
        cwd: scriptDir,
        alias: "acme",
        items: [{ issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2", worktree: null }],
      });
      const withoutOutcome = await withoutSocket.settle(withoutHandles[0] as never);
      expect(withoutOutcome.log).toBe("unset");
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it("scrubs configured credentials and returns the actual settled outcome", async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "foreman-print-"));
    const scriptPath = join(scriptDir, "print-env");
    writeFileSync(scriptPath, "#!/bin/sh\nprintf '%s' \"${FOREMAN_TEST_SCRUB-unset}\"\n");
    chmodSync(scriptPath, 0o755);
    const prior = process.env.FOREMAN_TEST_SCRUB;
    process.env.FOREMAN_TEST_SCRUB = "secret";
    try {
      const config = {
        agent: { ompBin: scriptPath, approvalMode: "yolo", maxRuntimeMs: 0 },
      } as GlobalConfig;
      const dispatcher = new PrintDispatcher(config, { scrubEnv: ["FOREMAN_TEST_SCRUB"] });
      const handles = await dispatcher.dispatch({
        agent: "foreman-implement",
        command: "/foreman-implement",
        cwd: scriptDir,
        alias: "acme",
        items: [{ issueId: "ENG-142", subject: "ENG-142", dispatchId: "dispatch-1", worktree: null }],
      });

      const outcome = await dispatcher.settle(handles[0] as never);
      expect(outcome).toMatchObject({ status: "settled", exitCode: 0, log: "unset" });
    } finally {
      if (prior === undefined) delete process.env.FOREMAN_TEST_SCRUB;
      else process.env.FOREMAN_TEST_SCRUB = prior;
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it("surfaces a non-zero batch exit code as the outcome for every handle", async () => {
    const ompBin = fakeOmpBin(7);
    const dispatcher = new PrintDispatcher(makeConfig(ompBin));
    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: tmpdir(),
      alias: "acme",
      items: [
        { issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1", worktree: null },
        { issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2", worktree: null },
      ],
    });

    const outcomes = await Promise.all(handles.map((handle) => dispatcher.settle(handle)));
    expect(outcomes[0]?.exitCode).toBe(7);
    expect(outcomes[1]?.exitCode).toBe(7);
    expect(outcomes[0]?.status).toBe("settled");
    expect(outcomes[1]?.status).toBe("settled");
  });
});

describe("herdrAgentName", () => {
  it("retains the random dispatch-id suffix when truncating batch agent names", () => {
    const first = herdrAgentName("triage-batch-20260829T120000-aaaa1111");
    const second = herdrAgentName("triage-batch-20260829T120000-bbbb2222");
    expect(first).not.toBe(second);
    expect(first).toEndWith("aaaa1111");
    expect(second).toEndWith("bbbb2222");
    expect(first.length).toBeLessThanOrEqual(32);
  });
});
