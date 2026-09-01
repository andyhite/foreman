/**
 * OSC 52 clipboard write — no shell, no extra dependency.
 *
 * Terminals that honor `\x1b]52;c;<base64>\x07` copy the payload to the
 * system clipboard. Unsupported terminals ignore the sequence harmlessly.
 */

export function copyToClipboard(text: string, stdout: NodeJS.WriteStream = process.stdout): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  stdout.write(`\x1b]52;c;${encoded}\x07`);
}
