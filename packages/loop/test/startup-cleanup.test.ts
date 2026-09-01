/**
 * Regression test for the zombie-loop bug (SPEC §17.4, §17.5).
 *
 * `runRepo` (packages/loop/src/repo.ts) and `runTeam`
 * (packages/loop/src/team.ts) each acquire the singleton `loop.lock`, then
 * start a `ControlServer` listening on a unix socket, then run an "ensure
 * pass" that makes the process's first real Linear call. That ensure pass
 * used to `return` on a fatal `ConfigError` from a point *outside* any
 * cleanup — the listening socket kept the event loop alive with nothing left
 * to run, so the process never exited, `loop.lock` was never released, and
 * every later `foreman repo`/`foreman team` in that repo failed with
 * `LoopLockHeldError`. The fix wraps everything after lock acquisition in one
 * `try`/`finally` (see the comment above that block in both files) so the
 * lock is released and the socket is closed no matter how the run ends.
 *
 * This can only be observed by spawning the real CLI as a child process: the
 * bug is precisely about process lifetime (does the process exit?) and open
 * OS handles (is the socket file gone?), neither of which an in-process call
 * can see — an in-process call runs in the *test's* event loop, which stays
 * alive regardless of what `runRepo` does to its own resources.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTAKE_LOOP_ID, loopPaths, repoLoopId, type GlobalConfig } from "@foreman/core";

// packages/loop/test -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "main.ts");

const SPAWN_TIMEOUT_MS = 20_000;

let home: string;
let server: Bun.Server<undefined>;
let endpoint: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "foreman-startup-"));

  // A local, deterministic stand-in for the Linear API: every request fails
  // with 401 and a GraphQL error body, so the ensure pass's first real
  // network call is a fatal, reproducible error — no network dependency.
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
  });
  endpoint = `http://127.0.0.1:${server.port}/graphql`;

  const config = {
    repos: {
      demo: { path: home, initiatives: ["init-1"], team: "ENG" },
    },
    loop: { stateDir: join(home, "state") },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint },
  };
  mkdirSync(join(home, ".foreman"), { recursive: true });
  writeFileSync(join(home, ".foreman", "config.json"), JSON.stringify(config), "utf8");
});

afterEach(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

/** Spawns `foreman <args>` against the fake `--home`, bogus credential, and no network dependency beyond the local fake server. */
function spawnForeman(args: string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    env: { ...process.env, LINEAR_API_KEY: "bogus" },
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO_ROOT,
  });
}

/**
 * Races `proc.exited` against a timeout, failing with a clear message when
 * the timeout wins — a hang is exactly the bug under test, so this is a
 * deliberate real-wall-clock guard around a real spawned process, not a
 * substitute for awaiting a deterministic signal.
 */
async function waitForExit(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, label: string): Promise<number> {
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SPAWN_TIMEOUT_MS));
  const result = await Promise.race([proc.exited, timeout]);
  if (result === "timeout") {
    proc.kill();
    throw new Error(`${label}: process did not exit within ${SPAWN_TIMEOUT_MS}ms (this is the zombie-loop bug)`);
  }
  return result;
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

/** GlobalConfig shape needed by `loopPaths`; only the fields it reads. */
function configForPaths(): GlobalConfig {
  return { loop: { stateDir: join(home, "state") } } as GlobalConfig;
}

describe("startup cleanup (zombie-loop regression)", () => {
  it("a fatal ensure-pass error releases the lock and unlinks the socket", async () => {
    const proc = spawnForeman(["repo", "demo", "--home", home, "--team", "ENG"]);
    const [exitCode, stderr] = await Promise.all([
      waitForExit(proc, "foreman repo"),
      readAll(proc.stderr),
    ]);

    expect(exitCode).not.toBe(0);
    const paths = loopPaths(configForPaths(), repoLoopId("demo"), home);
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
    expect(stderr).toContain("401");
  });

  it("two consecutive runs both fail the same way, never LoopLockHeldError", async () => {
    const first = spawnForeman(["repo", "demo", "--home", home, "--team", "ENG"]);
    const [firstExit, firstOut, firstErr] = await Promise.all([
      waitForExit(first, "foreman repo (run 1)"),
      readAll(first.stdout),
      readAll(first.stderr),
    ]);
    expect(firstExit).not.toBe(0);
    expect(firstOut + firstErr).not.toContain("LoopLockHeldError");

    const second = spawnForeman(["repo", "demo", "--home", home, "--team", "ENG"]);
    const [secondExit, secondOut, secondErr] = await Promise.all([
      waitForExit(second, "foreman repo (run 2)"),
      readAll(second.stdout),
      readAll(second.stderr),
    ]);
    expect(secondExit).not.toBe(0);
    expect(secondOut + secondErr).not.toContain("LoopLockHeldError");
  });

  it("the same holds for foreman team --once", async () => {
    // `--once` runs a single tick outside the continuous poll loop's
    // per-tick isolation (SPEC §17.5), so a persistently bad credential is
    // still fatal here — the same "must not hang, must not zombie the lock"
    // guarantee the `repo` tests above assert.
    const first = spawnForeman(["team", "ENG", "--home", home, "--once", "--no-control"]);
    const [firstExit, firstOut, firstErr] = await Promise.all([
      waitForExit(first, "foreman team (run 1)"),
      readAll(first.stdout),
      readAll(first.stderr),
    ]);
    expect(firstExit).not.toBe(0);
    expect(firstOut + firstErr).not.toContain("LoopLockHeldError");

    const second = spawnForeman(["team", "ENG", "--home", home, "--once", "--no-control"]);
    const [secondExit, secondOut, secondErr] = await Promise.all([
      waitForExit(second, "foreman team (run 2)"),
      readAll(second.stdout),
      readAll(second.stderr),
    ]);
    expect(secondExit).not.toBe(0);
    expect(secondOut + secondErr).not.toContain("LoopLockHeldError");

    const paths = loopPaths(configForPaths(), INTAKE_LOOP_ID, home);
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
  });

  it("foreman team in continuous mode survives a persistent tick error and still cleans up on SIGTERM", async () => {
    // SPEC §17.5's per-worker isolation, mirrored for the team process: a
    // transient (or even persistent) Linear error during a tick must not
    // crash the unattended process — it logs and retries on the next
    // cadence. This process is still alive and well-behaved, so a graceful
    // SIGTERM (not a crash) is what releases the lock and closes the socket.
    const proc = spawnForeman(["team", "ENG", "--home", home]);
    const paths = loopPaths(configForPaths(), INTAKE_LOOP_ID, home);
    const deadline = Date.now() + SPAWN_TIMEOUT_MS;
    while (!existsSync(paths.lock)) {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error("foreman team never acquired its lock");
      }
      await Bun.sleep(20);
    }
    proc.kill("SIGTERM");
    const [, out, err] = await Promise.all([
      waitForExit(proc, "foreman team (SIGTERM)"),
      readAll(proc.stdout),
      readAll(proc.stderr),
    ]);
    expect(out + err).not.toContain("LoopLockHeldError");
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
  });

  it("--no-control still cleans up the lock (and never created a socket)", async () => {
    const proc = spawnForeman(["repo", "demo", "--home", home, "--team", "ENG", "--no-control"]);
    const exitCode = await waitForExit(proc, "foreman repo --no-control");

    expect(exitCode).not.toBe(0);
    const paths = loopPaths(configForPaths(), repoLoopId("demo"), home);
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
  });
});
