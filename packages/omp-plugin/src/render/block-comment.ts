import type { BlockRecord } from "@foreman/core";

/**
 * SPEC §9 — the Linear comment for a `BlockRecord`. For `type: "dependency"`
 * (Case A) no `blocked:*` label is applied and no options/recommendation are
 * expected — the native `blocks` relation is the state and resolves itself
 * once the blocker completes, so this rendering names the blockers instead.
 */
export function renderBlockComment(record: BlockRecord): string {
  const lines = [
    `**What I was doing:** ${record.whatIWasDoing}`,
    `**What I need:** ${record.whatINeed}`,
  ];

  if (record.type === "dependency") {
    lines.push(
      `**Blocked by:** ${record.blockedByIssues.join(", ")}`,
      "No `blocked:*` label was applied — the native `blocks` relation is the " +
        "state, and it resolves itself once the blocker completes.",
    );
  } else {
    lines.push("**Options:**");
    if (record.options !== null && record.options.length > 0) {
      for (const option of record.options) {
        lines.push(`- ${option.label} — ${option.tradeoff}`);
      }
    } else {
      lines.push("_none_");
    }
    lines.push(
      `**Recommendation:** ${record.recommendation ?? "_none — no clear lean_"}`,
    );
  }

  const state = record.stateLeftBehind;
  lines.push(
    "**State left behind:**",
    `- Worktree: ${state.worktree ?? "_none_"}`,
    `- Branch: ${state.branch ?? "_none_"}`,
    `- Pushed: ${state.pushed ? "yes" : "no"}`,
    `- Commits: ${state.commits.length > 0 ? state.commits.join(", ") : "_none_"}`,
  );
  if (state.notes.length > 0) lines.push(`- Notes: ${state.notes}`);

  lines.push(`**Cost of a wrong guess:** ${record.costOfWrongGuess}`);

  return lines.join("\n");
}
