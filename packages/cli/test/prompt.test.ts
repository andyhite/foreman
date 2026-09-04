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

  it("secret() reads a bracketed-paste PEM key whole, not truncated at the first embedded newline", async () => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const originalIsTTY = stdin.isTTY;
    const originalIsRaw = stdin.isRaw;
    const originalSetRawMode = stdin.setRawMode?.bind(stdin);
    const originalResume = stdin.resume.bind(stdin);
    const originalWrite = stdout.write.bind(stdout);
    const writes: string[] = [];

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

    const pem = "-----BEGIN RSA PRIVATE KEY-----\nline one\nline two\n-----END RSA PRIVATE KEY-----";
    const prompter = new InteractivePrompter({ log: () => {} });
    const pending = prompter.secret("Paste the App's private key (.pem, input hidden): ");

    // A pasting terminal wraps the whole multi-line blob in bracketed-paste
    // markers as one write; the trailing real Enter arrives as a separate,
    // unmarked keystroke.
    stdin.emit("data", Buffer.from(`\x1b[200~${pem}\x1b[201~`));
    stdin.emit("data", Buffer.from("\r"));

    const answer = await pending;
    expect(answer).toBe(pem);
    // Every pasted byte was masked, never echoed in the clear, and as one
    // fixed-width mask rather than growing with (and revealing) the length.
    const output = writes.join("");
    expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(output).toContain("****");
    expect(output.split("****").length - 1).toBe(1);

    stdout.write = originalWrite;
    if (originalSetRawMode) stdin.setRawMode = originalSetRawMode;
    stdin.resume = originalResume;
    Object.defineProperty(stdin, "isTTY", { value: originalIsTTY, configurable: true });
    Object.defineProperty(stdin, "isRaw", { value: originalIsRaw, configurable: true });
    prompter.close();
  });

  it("secret() discards an arrow-key escape sequence instead of leaking it into the secret", async () => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const originalIsTTY = stdin.isTTY;
    const originalIsRaw = stdin.isRaw;
    const originalSetRawMode = stdin.setRawMode?.bind(stdin);
    const originalResume = stdin.resume.bind(stdin);
    const originalWrite = stdout.write.bind(stdout);

    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    stdin.setRawMode = ((mode: boolean) => {
      Object.defineProperty(stdin, "isRaw", { value: mode, configurable: true });
      return stdin;
    }) as typeof stdin.setRawMode;
    stdin.resume = () => stdin;
    stdout.write = (() => true) as typeof stdout.write;

    const prompter = new InteractivePrompter({ log: () => {} });
    const pending = prompter.secret("Linear API key: ");

    stdin.emit("data", Buffer.from("lin_api_"));
    stdin.emit("data", Buffer.from("\x1b[A"));
    stdin.emit("data", Buffer.from("key\n"));

    const answer = await pending;
    expect(answer).toBe("lin_api_key");

    stdout.write = originalWrite;
    if (originalSetRawMode) stdin.setRawMode = originalSetRawMode;
    stdin.resume = originalResume;
    Object.defineProperty(stdin, "isTTY", { value: originalIsTTY, configurable: true });
    Object.defineProperty(stdin, "isRaw", { value: originalIsRaw, configurable: true });
    prompter.close();
  });

  it("secret() detaches readline's own keypress echo for the duration of the prompt, and restores it after", async () => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const originalIsTTY = stdin.isTTY;
    const originalIsRaw = stdin.isRaw;
    const originalSetRawMode = stdin.setRawMode?.bind(stdin);
    const originalResume = stdin.resume.bind(stdin);
    const originalWrite = stdout.write.bind(stdout);

    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    stdin.setRawMode = ((mode: boolean) => {
      Object.defineProperty(stdin, "isRaw", { value: mode, configurable: true });
      return stdin;
    }) as typeof stdin.setRawMode;
    stdin.resume = () => stdin;
    stdout.write = (() => true) as typeof stdout.write;

    // Stands in for readline.Interface's own keypress listener, which
    // echoes every byte it sees (including stray focus-report escapes) —
    // the thing that was double-echoing pasted text and clobbering the
    // prompt line on a tab switch.
    let echoed = 0;
    const readlineEcho = () => {
      echoed += 1;
    };
    stdin.on("keypress", readlineEcho);

    const prompter = new InteractivePrompter({ log: () => {} });
    const pending = prompter.secret("Paste your Linear API key (input hidden): ");
    expect(stdin.listeners("keypress")).not.toContain(readlineEcho);

    for (const ch of "lin_api_abc123") stdin.emit("data", Buffer.from(ch));
    stdin.emit("data", Buffer.from("\r"));
    await pending;

    expect(echoed).toBe(0);
    expect(stdin.listeners("keypress")).toContain(readlineEcho);

    stdin.removeListener("keypress", readlineEcho);
    stdout.write = originalWrite;
    if (originalSetRawMode) stdin.setRawMode = originalSetRawMode;
    stdin.resume = originalResume;
    Object.defineProperty(stdin, "isTTY", { value: originalIsTTY, configurable: true });
    Object.defineProperty(stdin, "isRaw", { value: originalIsRaw, configurable: true });
    prompter.close();
  });

  it("secret() still finishes on a plain typed Enter with no paste markers involved", async () => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const originalIsTTY = stdin.isTTY;
    const originalIsRaw = stdin.isRaw;
    const originalSetRawMode = stdin.setRawMode?.bind(stdin);
    const originalResume = stdin.resume.bind(stdin);
    const originalWrite = stdout.write.bind(stdout);

    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    stdin.setRawMode = ((mode: boolean) => {
      Object.defineProperty(stdin, "isRaw", { value: mode, configurable: true });
      return stdin;
    }) as typeof stdin.setRawMode;
    stdin.resume = () => stdin;
    stdout.write = (() => true) as typeof stdout.write;

    const prompter = new InteractivePrompter({ log: () => {} });
    const pending = prompter.secret("Paste your Linear API key (input hidden): ");

    for (const ch of "lin_api_abc123") stdin.emit("data", Buffer.from(ch));
    stdin.emit("data", Buffer.from("\r"));

    expect(await pending).toBe("lin_api_abc123");

    stdout.write = originalWrite;
    if (originalSetRawMode) stdin.setRawMode = originalSetRawMode;
    stdin.resume = originalResume;
    Object.defineProperty(stdin, "isTTY", { value: originalIsTTY, configurable: true });
    Object.defineProperty(stdin, "isRaw", { value: originalIsRaw, configurable: true });
    prompter.close();
  });
});
