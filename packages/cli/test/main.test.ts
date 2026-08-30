import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "../src/main.ts";

/*
 * Run the entrypoint from source, not `dist`: CI tests before it builds, so a
 * test that needed the bundle would pass locally and fail there.
 */
const entrypoint = (): string => join(import.meta.dir, "..", "src", "main.ts");
const repoRoot = (): string => join(import.meta.dir, "..", "..", "..");

describe("parseArgs", () => {
  it("treats setup and init as distinct commands, not aliases", () => {
    expect(parseArgs(["setup"]).command).toBe("setup");
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs([]).command).toBeNull();
  });

  it("parses --path for init and defaults it to unset", () => {
    expect(parseArgs(["init"]).path).toBeNull();
    expect(parseArgs(["init", "--path", "/tmp/some-repo"]).path).toBe("/tmp/some-repo");
    expect(() => parseArgs(["init", "--path"])).toThrow(/missing value for --path/);
  });

  it("finds a command after flags while skipping their consumed values", () => {
    const args = parseArgs(["--repo", "/tmp/setup", "--scope", "project", "setup"]);
    expect(args.command).toBe("setup");
    expect(args.repoPath).toBe("/tmp/setup");
    expect(args.scope).toBe("project");
  });

  it("reports misplaced positionals and duplicate commands with their cause", () => {
    expect(() => parseArgs(["setup", "extra"])).toThrow(/Unexpected positional argument "extra"/);
    expect(() => parseArgs(["setup", "init"])).toThrow(/Multiple commands supplied/);
    expect(parseArgs(["--repo", "setup"]).command).toBeNull();
  });

  it("defaults githubRepo and every mode to unset", () => {
    const args = parseArgs(["setup"]);
    expect(args.githubRepo).toBe("andyhite/foreman");
    expect(args.ompMode).toBeNull();
    expect(args.link).toBe(false);
    expect(args.scope).toBeNull();
  });

  it("parses --link as a standalone flag, not nested under --omp", () => {
    const args = parseArgs(["setup", "--link"]);
    expect(args.link).toBe(true);
    expect(args.ompMode).toBeNull();
  });

  it("rejects --link combined with --omp", () => {
    expect(() => parseArgs(["setup", "--link", "--omp", "skip"])).toThrow(/--link and --omp are mutually exclusive/);
  });

  it("parses --yes, --omp, --scope, --repo-source, --repo, --home", () => {
    const args = parseArgs([
      "setup",
      "--yes",
      "--omp",
      "install",
      "--scope",
      "project",
      "--repo-source",
      "someone/fork",
      "--repo",
      "/tmp/checkout",
      "--home",
      "/tmp/home",
    ]);
    expect(args.yes).toBe(true);
    expect(args.ompMode).toBe("install");
    expect(args.scope).toBe("project");
    expect(args.githubRepo).toBe("someone/fork");
    expect(args.repoPath).toBe("/tmp/checkout");
    expect(args.home).toBe("/tmp/home");
  });

  it("rejects an invalid --omp mode", () => {
    expect(() => parseArgs(["setup", "--omp", "bogus"])).toThrow(/--omp must be one of/);
  });

  it("rejects --omp link now that dev mode is --link", () => {
    expect(() => parseArgs(["setup", "--omp", "link"])).toThrow(/--omp must be one of/);
  });

  it("rejects an invalid --scope", () => {
    expect(() => parseArgs(["setup", "--scope", "bogus"])).toThrow(/--scope must be one of/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["setup", "--nope"])).toThrow(/Unrecognized argument/);
  });

  it("recognizes --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });
});

describe("foreman loop delegation", () => {
  /*
   * The reason `main` hands `loop` its argv before calling `parseArgs`: this
   * parser knows neither the subcommand nor the supervisor's flags, and
   * teaching it both vocabularies would put every loop flag in two places.
   */
  it("cannot parse the subcommand or the supervisor's flags", () => {
    expect(() => parseArgs(["loop"])).toThrow(/Unexpected positional argument "loop"/);
    expect(() => parseArgs(["--dry-run"])).toThrow(/Unrecognized argument: --dry-run/);
    expect(() => parseArgs(["--stage", "full"])).toThrow(/Unrecognized argument: --stage/);
  });

  it("routes `loop --help` to the supervisor's help, not the CLI's", async () => {
    const proc = Bun.spawn(["bun", "run", entrypoint(), "loop", "--help"], {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("foreman loop — Foreman supervisor");
    expect(stdout).toContain("--dry-run");
    expect(stdout).not.toContain("Interactive installer");
  });

  it("still prints the CLI's own help with no arguments", async () => {
    const proc = Bun.spawn(["bun", "run", entrypoint(), "--help"], {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("Usage: foreman <command>");
    expect(stdout).toContain("loop  ");
  });
});
