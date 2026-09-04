/**
 * Neutralizes text Foreman did not author before it is embedded in a Linear
 * comment or printed to the operator's terminal. Issue content and agent
 * output are untrusted input (README "issue content is untrusted input"), and
 * both sinks parse or interpret what they are handed: `decodeMarker` reads
 * ```json fences back as machine truth, and a terminal interprets escape
 * sequences.
 */

/** Drops C0 (except `\n`/`\t`), DEL, C1, bidi overrides, and zero-width formatting — so ESC/OSC/CSI, and the trojan-source class of bidi/zero-width smuggling (CVE-2021-42574), can never reach a terminal or a log line. */
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
}

/**
 * `stripControlChars`, plus every run of three-or-more backticks rewritten to
 * HTML entities. A fenced block in untrusted prose is what lets a
 * prompt-injected agent smuggle a second ```json fence into a comment the
 * credential itself authors, which `decodeMarker` would otherwise read as a
 * genuine marker. Inline code (one or two backticks) is left intact; Foreman's
 * own renderers emit no fenced blocks, so no tool-authored prose is affected.
 */
export function sanitizeAgentText(text: string): string {
  return stripControlChars(text).replace(/`{3,}/g, (run) => "&#96;".repeat(run.length));
}
