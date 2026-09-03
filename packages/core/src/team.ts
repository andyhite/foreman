import { ConfigError } from "./config/load.ts";
import type { LinearReader } from "./linear/api.ts";

/**
 * Resolves the Linear team key an instance operates in (SPEC §3.11):
 * an explicit flag, then the registry entry's `team`, then the sole team
 * the credential can reach, then fail loudly.
 *
 * Shared by `foreman build`, `foreman plan`, and `foreman reconcile` — all
 * three resolve a registry entry first and pass its `team` through, so
 * `flagTeam` is currently always null; the parameter exists so a future
 * `--team` override has one place to land instead of three.
 *
 * The API call happens only when neither the flag nor the entry supplies a
 * key, so a fully configured instance starts without it.
 */
export async function resolveTeamKey(deps: {
  linear: Pick<LinearReader, "teams">;
  flagTeam?: string | null;
  entryTeam?: string | null;
}): Promise<string> {
  const explicit = deps.flagTeam ?? deps.entryTeam;
  if (explicit) return explicit;

  const teams = await deps.linear.teams();
  if (teams.length === 1) return teams[0]!.key;

  if (teams.length === 0) {
    throw new ConfigError("The Linear credential can reach no teams", [
      "check the API key's permissions",
    ]);
  }
  throw new ConfigError(
    `The Linear credential reaches ${teams.length} teams, so the team cannot be inferred`,
    [
      `pass --team <KEY>, or set the entry's "team"`,
      `available: ${teams.map((team) => team.key).join(", ")}`,
    ],
  );
}
