import { describe, expect, it } from "bun:test";
import { InteractivePrompter } from "../src/prompt.ts";

describe("InteractivePrompter", () => {
  it("re-prompts on an out-of-range select answer", async () => {
    const prompter = new InteractivePrompter({ log: () => {} });
    const answers = ["9", "banana", "2"];
    const originalQuestion = prompter["ask"].bind(prompter);
    prompter["ask"] = async () => answers.shift() ?? "";

    const value = await prompter.select(
      "Pick one",
      [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
        { value: "c", label: "Gamma" },
      ],
      "a",
    );

    expect(value).toBe("b");
    prompter["ask"] = originalQuestion;
    prompter.close();
  });

  it("renders a scrolling viewport when choices overflow the terminal", async () => {
    const stdout = process.stdout;
    const stdin = process.stdin;
    const originalRows = stdout.rows;
    const originalColumns = stdout.columns;
    const originalIsTTY = stdin.isTTY;
    const originalSetRawMode = stdin.setRawMode?.bind(stdin);
    const originalResume = stdin.resume.bind(stdin);
    const writes: string[] = [];
    const originalWrite = stdout.write.bind(stdout);

    Object.defineProperty(stdout, "rows", { value: 8, configurable: true });
    Object.defineProperty(stdout, "columns", { value: 24, configurable: true });
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    stdin.setRawMode = ((mode: boolean) => {
      Object.defineProperty(stdin, "isRaw", { value: mode, configurable: true });
      return stdin;
    }) as typeof stdin.setRawMode;
    stdin.resume = () => stdin;
    stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof stdout.write;

    const choices = Array.from({ length: 12 }, (_, index) => ({
      value: `id-${index}`,
      label: `Initiative ${index}`,
      checked: false,
    }));

    const prompter = new InteractivePrompter({ log: () => {} });
    const pending = prompter.multiSelect("Which initiatives?", choices);

    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.emit("keypress", "", { name: "return" });
    const selected = await pending;

    expect(selected).toEqual([]);
    expect(writes.join("")).toMatch(/↓ \d+ more/);

    stdout.write = originalWrite;
    if (originalSetRawMode) stdin.setRawMode = originalSetRawMode;
    stdin.resume = originalResume;
    Object.defineProperty(stdout, "rows", { value: originalRows, configurable: true });
    Object.defineProperty(stdout, "columns", { value: originalColumns, configurable: true });
    Object.defineProperty(stdin, "isTTY", { value: originalIsTTY, configurable: true });
    prompter.close();
  });
});
