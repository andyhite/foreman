import type { GlobalConfig } from "./config/schema.ts";
import { ConfigError, repoForInitiative } from "./config/load.ts";
import type { LinearReader } from "./linear/api.ts";
import type { Issue } from "./linear/types.ts";

/**
 * Resolves the repo path for `issue`: issue → project → its single product
 * initiative → `config.repos` map entry (SPEC §3.5 item 6, §4.0). An issue
 * with no project cannot resolve a repo — project membership is mandatory
 * for Foreman-touched issues (SPEC §4.0).
 */
export async function repoForIssue(
  deps: { linear: Pick<LinearReader, "projectInitiative">; config: GlobalConfig; home?: string },
  issue: Issue,
): Promise<string> {
  if (issue.project === null) {
    throw new ConfigError(`Issue "${issue.identifier}" has no project; cannot resolve a repo`, [
      `${issue.identifier}.project is unset`,
    ]);
  }
  const initiative = await deps.linear.projectInitiative(issue.project.id);
  return repoForInitiative(deps.config, initiative.id, deps.home);
}
