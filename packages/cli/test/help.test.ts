import { describe, expect, it } from "bun:test";
import { renderCommandHelp, renderGlobalHelp } from "../src/main.ts";

describe("renderCommandHelp", () => {
  it("prints only the named command's options, not another command's", () => {
    const text = renderCommandHelp("doctor");

    expect(text).toContain("--fix");
    expect(text).not.toContain("--skip-pull");
  });

  it("names the command and its usage line", () => {
    const text = renderCommandHelp("init");

    expect(text).toContain("foreman init —");
    expect(text).toContain("Usage: foreman init [options]");
    expect(text).toContain("--team <KEY>");
  });
});

describe("renderGlobalHelp", () => {
  it("lists every command by name", () => {
    const text = renderGlobalHelp();

    for (const command of ["setup", "init", "deinit", "doctor", "update", "plan", "build", "reconcile"]) {
      expect(text).toContain(command);
    }
  });

  it("includes --version among the shared options", () => {
    expect(renderGlobalHelp()).toContain("--version");
  });
});
