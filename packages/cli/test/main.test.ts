import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "../src/main.ts";

/*
 * Run the entrypoint from source, not `dist`: CI tests before it builds, so a
 * test that needed the bundle would pass locally and fail there.
 */
const entrypoint = (): string => join(import.meta.dir, "..", "src", "main.ts");
const checkoutRoot = (): string => join(import.meta.dir, "..", "..", "..");

describe("parseArgs", () => {
  it("treats every installer command as distinct, not as aliases", () => {
    expect(parseArgs(["setup"]).command).toBe("setup");
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs(["deinit"]).command).toBe("deinit");
    expect(parseArgs(["doctor"]).command).toBe("doctor");
    expect(parseArgs(["update"]).command).toBe("update");
    expect(parseArgs([]).command).toBeNull();
  });

  it("parses --path for init and deinit and defaults it to unset", () => {
    expect(parseArgs(["init"]).path).toBeNull();
    expect(parseArgs(["init", "--path", "/tmp/some-repo"]).path).toBe("/tmp/some-repo");
    expect(parseArgs(["deinit", "--path", "/tmp/some-repo"]).path).toBe("/tmp/some-repo");
    expect(() => parseArgs(["init", "--path"])).toThrow(/missing value for --path/);
  });

  it("finds a command after flags while skipping their consumed values", () => {
    const args = parseArgs(["--checkout", "/tmp/setup", "setup"]);
    expect(args.command).toBe("setup");
    expect(args.checkoutPath).toBe("/tmp/setup");
  });

  it("reports misplaced positionals and duplicate commands with their cause", () => {
    expect(() => parseArgs(["setup", "extra"])).toThrow(/Unexpected positional argument "extra"/);
    expect(() => parseArgs(["setup", "init"])).toThrow(/Multiple commands supplied/);
    expect(parseArgs(["--checkout", "setup"]).command).toBeNull();
  });

  it("reports unknown commands before any command is set", () => {
    expect(() => parseArgs(["bogus"])).toThrow(/Unknown command "bogus"/);
  });

  it("rejects setup-only flags on other commands", () => {
    expect(() => parseArgs(["init", "--link"])).toThrow(/--link applies to `foreman setup`/);
    expect(() => parseArgs(["doctor", "--link"])).toThrow(/--link applies to `foreman setup`/);
  });

  it("rejects init-only flags on setup", () => {
    expect(() => parseArgs(["setup", "--path", "/tmp"])).toThrow(/--path applies to `foreman init`/);
    expect(() => parseArgs(["setup", "--initiative", "i1"])).toThrow(/--initiative applies to `foreman init`/);
    expect(() => parseArgs(["setup", "--alias", "mine"])).toThrow(/--alias applies to `foreman init`/);
    expect(() => parseArgs(["setup", "--team", "ENG"])).toThrow(/--team applies to `foreman init`/);
  });

  /*
   * The flags several commands share are the ones most likely to be misaimed,
   * so the error has to name every owner rather than just the first.
   */
  it("accepts --checkout on setup, doctor, and update, and rejects it elsewhere", () => {
    expect(parseArgs(["setup", "--checkout", "/tmp/c"]).checkoutPath).toBe("/tmp/c");
    expect(parseArgs(["doctor", "--checkout", "/tmp/c"]).checkoutPath).toBe("/tmp/c");
    expect(parseArgs(["update", "--checkout", "/tmp/c"]).checkoutPath).toBe("/tmp/c");
    expect(() => parseArgs(["init", "--checkout", "/tmp/c"])).toThrow(
      /--checkout applies to `foreman setup` or `foreman doctor` or `foreman update`/,
    );
  });

  it("accepts --skip-plugin on init and update, and rejects it elsewhere", () => {
    expect(parseArgs(["init"]).skipPlugin).toBe(false);
    expect(parseArgs(["init", "--skip-plugin"]).skipPlugin).toBe(true);
    expect(parseArgs(["update", "--skip-plugin"]).skipPlugin).toBe(true);
    expect(() => parseArgs(["deinit", "--skip-plugin"])).toThrow(
      /--skip-plugin applies to `foreman init` or `foreman update`/,
    );
  });

  it("parses --keep-registry for deinit only", () => {
    expect(parseArgs(["deinit"]).keepRegistry).toBe(false);
    expect(parseArgs(["deinit", "--keep-registry"]).keepRegistry).toBe(true);
    expect(() => parseArgs(["init", "--keep-registry"])).toThrow(/--keep-registry applies to `foreman deinit`/);
  });

  it("parses --fix for doctor only", () => {
    expect(parseArgs(["doctor"]).fix).toBe(false);
    expect(parseArgs(["doctor", "--fix"]).fix).toBe(true);
    expect(() => parseArgs(["update", "--fix"])).toThrow(/--fix applies to `foreman doctor`/);
  });

  it("parses --skip-pull for update only", () => {
    expect(parseArgs(["update", "--skip-pull"]).skipPull).toBe(true);
    expect(() => parseArgs(["setup", "--skip-pull"])).toThrow(/--skip-pull applies to `foreman update`/);
  });

  it("parses repeatable --initiative, --alias, and --team for init", () => {
    const args = parseArgs([
      "init",
      "--initiative",
      "i1",
      "--initiative",
      "i2:apps/zero",
      "--alias",
      "plotroom",
      "--team",
      "ENG",
    ]);
    expect(args.initiatives).toEqual(["i1", "i2:apps/zero"]);
    expect(args.alias).toBe("plotroom");
    expect(args.team).toBe("ENG");
  });

  it("parses --link as a standalone flag meaning 'run the foreman CLI from source'", () => {
    expect(parseArgs(["setup"]).link).toBe(false);
    expect(parseArgs(["setup", "--link"]).link).toBe(true);
  });

  it("parses --yes, --checkout, and --home", () => {
    const args = parseArgs(["setup", "--yes", "--checkout", "/tmp/checkout", "--home", "/tmp/home"]);
    expect(args.yes).toBe(true);
    expect(args.checkoutPath).toBe("/tmp/checkout");
    expect(args.home).toBe("/tmp/home");
  });

  /*
   * `--repo-source` named the GitHub repo the omp marketplace catalog was
   * fetched from. There is no marketplace any more — the plugin is linked from
   * the local checkout — so accepting the flag would quietly imply Foreman
   * still installs from somewhere else.
   */
  it("rejects flags from the retired marketplace install path", () => {
    expect(() => parseArgs(["setup", "--repo-source", "someone/fork"])).toThrow(/Unrecognized argument/);
    expect(() => parseArgs(["setup", "--scope", "project"])).toThrow(/Unrecognized argument/);
    expect(() => parseArgs(["setup", "--omp", "install"])).toThrow(/Unrecognized argument/);
    expect(() => parseArgs(["setup", "--skip-build"])).toThrow(/Unrecognized argument/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["setup", "--nope"])).toThrow(/Unrecognized argument/);
  });

  it("recognizes --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });
});

describe("foreman repo delegation", () => {
  /*
   * The reason `main` hands `repo` its argv before calling `parseArgs`: this
   * parser knows neither the subcommand nor the supervisor's flags, and
   * teaching it both vocabularies would put every supervisor flag in two places.
   */
  it("cannot parse the subcommand or the supervisor's flags", () => {
    expect(() => parseArgs(["repo"])).toThrow(/Unknown command "repo"/);
    expect(() => parseArgs(["--once"])).toThrow(/Unrecognized argument: --once/);
    expect(() => parseArgs(["--mode", "yolo"])).toThrow(/Unrecognized argument: --mode/);
  });

  it("routes `repo --help` to the supervisor's help, not the CLI's", async () => {
    const proc = Bun.spawn(["bun", "run", entrypoint(), "repo", "--help"], {
      cwd: checkoutRoot(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("foreman repo — Foreman per-repo supervisor");
    expect(stdout).toContain("--mode <m>");
    expect(stdout).not.toContain("Interactive installer");
  });

  it("still prints the CLI's own help with no arguments", async () => {
    const proc = Bun.spawn(["bun", "run", entrypoint(), "--help"], {
      cwd: checkoutRoot(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("Usage: foreman <command>");
    expect(stdout).toContain("deinit");
    expect(stdout).toContain("doctor");
  });
});
