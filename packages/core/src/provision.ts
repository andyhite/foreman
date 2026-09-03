/**
 * Provisioning (SPEC §4 team-per-repo rework): the only place Foreman creates
 * Linear structure. Two entry points, matching the two install scopes —
 * `provisionWorkspaceLabels` for `foreman setup` (workspace-level label
 * groups and members), `provisionTeam` for `foreman init`/`foreman doctor
 * --fix` (a team's triage/cycles settings, its managed workflow states, and
 * its `app:*` labels).
 *
 * Each function asks the operator to confirm at most once, covering every
 * write it is about to make — never once per label or per state. `Confirmer`
 * accepts an itemized `detail` list precisely so a single yes/no can still
 * name everything it is about to change (SPEC §17.9).
 *
 * Replaces the old `ensureMaintenanceProjects` pass: a project is optional on
 * an issue now, so there is no standing per-initiative project to guarantee
 * at session start.
 */

import type { Confirmer } from "./confirm.ts";
import {
  appLabelId,
  APP_LABEL_COLOR,
  groupDisplayName,
  labelIdFromParts,
  MANAGED_LABEL_GROUP_PREFIXES,
  MANAGED_LABELS,
  TYPE_LABEL_COLOR,
  type TypeLabel,
} from "./domain/labels.ts";
import { MANAGED_STATES } from "./domain/states.ts";
import type { LinearWriter } from "./linear/api.ts";
import type { LinearId, WorkflowState } from "./linear/types.ts";

export interface ProvisionAction {
  kind: "label" | "project-label" | "state" | "team-setting";
  name: string;
  /** What kind of write this is (or would be) — drives how the CLI prints it. */
  op: "create" | "update" | "archive" | "enable" | "disable" | "none";
  /** true when this call created or changed something, false when it was already correct. */
  changed: boolean;
  detail: string | null;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}



/**
 * Workspace scope — `foreman setup`. Creates the `Type` label group and
 * every `type:` member, workspace-level so all teams inherit them, each
 * with a fixed color. The `App` group is deliberately not created here: it
 * has no members until a repo configures apps, so `provisionTeam` creates
 * it on demand, same as it does for project labels. Idempotent: an existing
 * label is reported unchanged. Asks once, for every create together, not
 * once per label.
 */
export async function provisionWorkspaceLabels(
  linear: LinearWriter,
  input: { confirmer: Confirmer },
): Promise<ProvisionAction[]> {
  const actions: ProvisionAction[] = [];
  const existing = new Set((await linear.labels()).map((label) => label.name));

  const missingGroups = MANAGED_LABEL_GROUP_PREFIXES.map((prefix) => groupDisplayName(prefix)).filter(
    (groupName) => !existing.has(labelIdFromParts(groupName, null)),
  );
  const missingLabels = MANAGED_LABELS.filter((id) => !existing.has(id));

  for (const prefix of MANAGED_LABEL_GROUP_PREFIXES) {
    const groupName = groupDisplayName(prefix);
    if (!missingGroups.includes(groupName)) actions.push({ kind: "label", name: groupName, op: "none", changed: false, detail: null });
  }
  for (const id of MANAGED_LABELS) {
    if (!missingLabels.includes(id)) actions.push({ kind: "label", name: id, op: "none", changed: false, detail: null });
  }

  if (missingGroups.length === 0 && missingLabels.length === 0) return actions;

  const proceed = await input.confirmer.confirm({
    kind: "linear-write",
    summary: `Create ${missingGroups.length + missingLabels.length} Linear label(s) in this workspace`,
    detail: [...missingGroups.map((name) => `+ ${name} (group)`), ...missingLabels.map((id) => `+ ${id}`)],
  });

  for (const groupName of missingGroups) {
    if (!proceed) {
      actions.push({ kind: "label", name: groupName, op: "create", changed: false, detail: "declined" });
      continue;
    }
    try {
      await linear.createLabel({ name: groupName, isGroup: true });
      actions.push({ kind: "label", name: groupName, op: "create", changed: true, detail: null });
    } catch (error) {
      actions.push({ kind: "label", name: groupName, op: "create", changed: false, detail: errorDetail(error) });
    }
  }

  for (const id of missingLabels) {
    if (!proceed) {
      actions.push({ kind: "label", name: id, op: "create", changed: false, detail: "declined" });
      continue;
    }
    try {
      await linear.ensureWorkspaceLabel(id, { color: TYPE_LABEL_COLOR[id as TypeLabel] });
      actions.push({ kind: "label", name: id, op: "create", changed: true, detail: null });
    } catch (error) {
      actions.push({ kind: "label", name: id, op: "create", changed: false, detail: errorDetail(error) });
    }
  }

  return actions;
}



/**
 * Team scope — `foreman init` and `foreman doctor --fix`. Turns triage on,
 * cycles off, creates any missing `MANAGED_STATES` entry (with its color and
 * icon-determining `type`), keeps every managed state's color and
 * description in sync even when it already existed, offers to archive any
 * workflow state that is neither managed nor system-owned (Triage,
 * Duplicate), and creates the `app:<name>` issue and project labels for the
 * repo's configured apps (plus `app:all` when two or more are configured).
 * Asks once, for everything this call would change together.
 */
export async function provisionTeam(
  linear: LinearWriter,
  input: { teamId: LinearId; apps: readonly string[]; confirmer: Confirmer },
): Promise<ProvisionAction[]> {
  const actions: ProvisionAction[] = [];
  const settings = await linear.teamSettings(input.teamId);

  const settingsChanges: Array<{ name: "triageEnabled" | "cyclesEnabled"; op: "enable" | "disable" }> = [];
  if (!settings.triageEnabled) settingsChanges.push({ name: "triageEnabled", op: "enable" });
  if (settings.cyclesEnabled) settingsChanges.push({ name: "cyclesEnabled", op: "disable" });

  const existingStates = await linear.workflowStates(input.teamId);
  const toCreate = MANAGED_STATES.filter(
    (spec) => !existingStates.some((state) => state.name.trim().toLowerCase() === spec.name.toLowerCase()),
  );
  const toUpdate: Array<{ found: WorkflowState; spec: (typeof MANAGED_STATES)[number] }> = [];
  const typeMismatches: Array<{ found: WorkflowState; spec: (typeof MANAGED_STATES)[number] }> = [];
  for (const spec of MANAGED_STATES) {
    const found = existingStates.find((state) => state.name.trim().toLowerCase() === spec.name.toLowerCase());
    if (!found) continue;
    if (found.type !== spec.type) {
      typeMismatches.push({ found, spec });
    } else if (found.color !== spec.color || (found.description ?? "") !== spec.description) {
      toUpdate.push({ found, spec });
    }
  }

  const managedNames = new Set(MANAGED_STATES.map((spec) => spec.name.toLowerCase()));
  const extraStates = existingStates.filter(
    (state) =>
      state.type !== "triage" && state.type !== "duplicate" && !managedNames.has(state.name.trim().toLowerCase()),
  );

  const appNames = input.apps.length >= 2 ? [...input.apps, "all"] : [...input.apps];
  const existingWorkspaceLabels = new Set((await linear.labels()).map((label) => label.name));
  const existingProjectLabels = new Set((await linear.projectLabels()).map((label) => label.name));
  const missingIssueLabels = appNames.filter((name) => !existingWorkspaceLabels.has(appLabelId(name)));
  const missingProjectLabels = appNames.filter((name) => !existingProjectLabels.has(appLabelId(name)));

  const nothingToDo =
    settingsChanges.length === 0 &&
    toCreate.length === 0 &&
    toUpdate.length === 0 &&
    extraStates.length === 0 &&
    missingIssueLabels.length === 0 &&
    missingProjectLabels.length === 0;

  let proceed = true;
  if (!nothingToDo) {
    const summaryParts: string[] = [];
    if (settingsChanges.length > 0) {
      summaryParts.push(settingsChanges.map((change) => `${change.op} ${change.name}`).join(", "));
    }
    if (toCreate.length > 0) summaryParts.push(`create ${toCreate.length} workflow state(s)`);
    if (toUpdate.length > 0) summaryParts.push(`update ${toUpdate.length} state color/description`);
    if (extraStates.length > 0) summaryParts.push(`remove ${extraStates.length} extra workflow state(s)`);
    const labelCount = missingIssueLabels.length + missingProjectLabels.length;
    if (labelCount > 0) summaryParts.push(`create ${labelCount} app label(s)`);

    const detail = [
      ...settingsChanges.map((change) => `${change.op === "enable" ? "+" : "-"} ${change.name}`),
      ...toCreate.map((spec) => `+ ${spec.name} (create, type ${spec.type})`),
      ...toUpdate.map((entry) => `~ ${entry.spec.name} (update color/description)`),
      ...extraStates.map((state) => `- ${state.name} (remove; only succeeds with no active issues)`),
      ...missingIssueLabels.map((name) => `+ ${appLabelId(name)} (issue label)`),
      ...missingProjectLabels.map((name) => `+ ${appLabelId(name)} (project label)`),
    ];

    proceed = await input.confirmer.confirm({
      kind: "linear-write",
      summary: `Provision Linear team ${settings.key}: ${summaryParts.join("; ")}`,
      detail,
    });
  }

  let triageJustEnabled = false;
  for (const change of settingsChanges) {
    if (!proceed) {
      actions.push({ kind: "team-setting", name: change.name, op: change.op, changed: false, detail: "declined" });
      continue;
    }
    try {
      await linear.updateTeamSettings(input.teamId, { [change.name]: change.op === "enable" }); // eslint-disable-line @typescript-eslint/no-explicit-any -- keyed by the discriminated `name` above
      actions.push({ kind: "team-setting", name: change.name, op: change.op, changed: true, detail: null });
      if (change.name === "triageEnabled") triageJustEnabled = true;
    } catch (error) {
      actions.push({ kind: "team-setting", name: change.name, op: change.op, changed: false, detail: errorDetail(error) });
    }
  }
  for (const name of ["triageEnabled", "cyclesEnabled"] as const) {
    if (!settingsChanges.some((change) => change.name === name)) {
      actions.push({ kind: "team-setting", name, op: "none", changed: false, detail: null });
    }
  }

  if (triageJustEnabled) {
    const refreshed = await linear.teamSettings(input.teamId);
    if (refreshed.triageStateId === null) {
      actions.push({
        kind: "state",
        name: "Triage",
        op: "none",
        changed: false,
        detail: "Linear did not create a triage state; enable Triage in team settings by hand",
      });
    }
  }

  for (const spec of MANAGED_STATES) {
    const created = toCreate.includes(spec);
    const updated = toUpdate.find((entry) => entry.spec === spec);
    const mismatch = typeMismatches.find((entry) => entry.spec === spec);
    if (mismatch) {
      actions.push({
        kind: "state",
        name: spec.name,
        op: "none",
        changed: false,
        detail: `exists with type "${mismatch.found.type}", expected "${spec.type}"`,
      });
    } else if (created) {
      if (!proceed) {
        actions.push({ kind: "state", name: spec.name, op: "create", changed: false, detail: "declined" });
        continue;
      }
      try {
        await linear.createWorkflowState({
          teamId: input.teamId,
          name: spec.name,
          type: spec.type,
          color: spec.color,
          description: spec.description,
          position: spec.position,
        });
        actions.push({ kind: "state", name: spec.name, op: "create", changed: true, detail: null });
      } catch (error) {
        actions.push({ kind: "state", name: spec.name, op: "create", changed: false, detail: errorDetail(error) });
      }
    } else if (updated) {
      if (!proceed) {
        actions.push({ kind: "state", name: spec.name, op: "update", changed: false, detail: "declined" });
        continue;
      }
      try {
        await linear.updateWorkflowState(updated.found.id, { color: spec.color, description: spec.description });
        actions.push({ kind: "state", name: spec.name, op: "update", changed: true, detail: null });
      } catch (error) {
        actions.push({ kind: "state", name: spec.name, op: "update", changed: false, detail: errorDetail(error) });
      }
    } else {
      actions.push({ kind: "state", name: spec.name, op: "none", changed: false, detail: null });
    }
  }

  const duplicateState = existingStates.find((state) => state.type === "duplicate");
  if (!duplicateState) {
    actions.push({
      kind: "state",
      name: "Duplicate",
      op: "none",
      changed: false,
      detail: "no native Duplicate-type state found on this team; Linear manages it automatically and it cannot be created via the API",
    });
  }

  for (const state of extraStates) {
    if (!proceed) {
      actions.push({ kind: "state", name: state.name, op: "archive", changed: false, detail: "declined" });
      continue;
    }
    try {
      await linear.archiveWorkflowState(state.id);
      actions.push({ kind: "state", name: state.name, op: "archive", changed: true, detail: null });
    } catch (error) {
      actions.push({ kind: "state", name: state.name, op: "archive", changed: false, detail: errorDetail(error) });
    }
  }

  for (const name of appNames) {
    const id = appLabelId(name);
    if (!missingIssueLabels.includes(name)) {
      actions.push({ kind: "label", name: id, op: "none", changed: false, detail: null });
    } else if (!proceed) {
      actions.push({ kind: "label", name: id, op: "create", changed: false, detail: "declined" });
    } else {
      try {
        await linear.ensureWorkspaceLabel(id, { color: APP_LABEL_COLOR });
        actions.push({ kind: "label", name: id, op: "create", changed: true, detail: null });
      } catch (error) {
        actions.push({ kind: "label", name: id, op: "create", changed: false, detail: errorDetail(error) });
      }
    }

    if (!missingProjectLabels.includes(name)) {
      actions.push({ kind: "project-label", name: id, op: "none", changed: false, detail: null });
    } else if (!proceed) {
      actions.push({ kind: "project-label", name: id, op: "create", changed: false, detail: "declined" });
    } else {
      try {
        await linear.ensureProjectLabel(id, { color: APP_LABEL_COLOR });
        actions.push({ kind: "project-label", name: id, op: "create", changed: true, detail: null });
      } catch (error) {
        actions.push({ kind: "project-label", name: id, op: "create", changed: false, detail: errorDetail(error) });
      }
    }
  }

  return actions;
}
