/**
 * The live config editor (contract §Views/settings.ts).
 *
 * `~/.foreman/config.json` is the only config file (SPEC §3.10), and it is
 * shared by every loop process on the machine. This view edits a local
 * draft — nothing reaches disk until `ctrl-s` — and sends only the leaves
 * that actually changed, because `patchConfig` deep-merges over whatever is
 * already there and a full-object patch would silently clobber a sibling
 * loop's concurrent edit.
 *
 * Two `settingsEdits` keys are reserved for this view's own editing state,
 * not for config: `ui.editingPath` (which field, if any, is mid-edit) and
 * `ui.draft:<path>` (its in-progress typed value). Every other view parks
 * transient UI state the same way (`ui.pipelineFilter`, `ui.logsAllLoops`);
 * this file is the one place that must filter every `ui.*` key back out
 * before it builds a config patch, since it is the only view that writes
 * to real config paths at all.
 */
import type { Canvas, FieldSpec, GlobalConfig, Key, Rect } from "@foreman/core";
import { applyFieldKey, fieldRow, kvRows, matchesKey, panel } from "@foreman/core";
import { focusedPane } from "../store.ts";
import { duration } from "../format.ts";
import type { View, ViewContext } from "../view.ts";

const VIEW_ID = "settings";
const EDITING_PATH_KEY = "ui.editingPath";
const WINDOW_KEY = "HH:MM window";

type FieldKind = "text" | "number" | "boolean" | "select";

interface FieldDescriptor {
  readonly path: string;
  readonly kind: FieldKind;
  readonly label: string;
  readonly hint: string;
  readonly min?: number;
  readonly options?: readonly string[];
}

interface Section {
  readonly title: string;
  readonly fields: readonly FieldDescriptor[];
}

const SECTIONS: readonly Section[] = [
  {
    title: "loop",
    fields: [
      { path: "loop.stage", kind: "select", label: "stage", hint: "autonomy staging (SPEC §17.9)", options: ["dry-run", "read-only", "full"] },
      { path: "loop.wipGlobal", kind: "number", label: "wip global", hint: "global cap on concurrent agents", min: 1 },
      { path: "loop.wip.refine", kind: "number", label: "wip refine", hint: "refine stage concurrency cap", min: 1 },
      { path: "loop.wip.implement", kind: "number", label: "wip implement", hint: "implement stage concurrency cap", min: 1 },
      { path: "loop.wip.review", kind: "number", label: "wip review", hint: "review stage concurrency cap", min: 1 },
      { path: "loop.wip.plan", kind: "number", label: "wip plan", hint: "plan stage concurrency cap", min: 1 },
      { path: "loop.readyBufferTarget", kind: "number", label: "ready buffer", hint: "refine targets this Ready-view depth", min: 1 },
      { path: "loop.backpressureThreshold", kind: "number", label: "backpressure", hint: "blocked depth that halts dispatch, 0 = any block halts", min: 0 },
      { path: "loop.retryCap", kind: "number", label: "retry cap", hint: "attempts before a retry-exhausted decision", min: 1 },
      { path: "loop.reviewCycleCap", kind: "number", label: "review cycle cap", hint: "review cycles before a review-cycle-exhausted decision", min: 1 },
      { path: "loop.cadenceMinutes", kind: "number", label: "cadence", hint: "minutes between poll ticks", min: 1 },
      { path: "loop.mergeDetection", kind: "boolean", label: "merge detection", hint: "poll merged PRs and move issues to Done" },
    ],
  },
  {
    title: "intake",
    fields: [
      { path: "intake.window", kind: "text", label: "window", hint: `local ${WINDOW_KEY} the daily batch may start` },
      { path: "intake.staleLowDays", kind: "number", label: "stale low days", hint: "unactioned Low items older than this get a cancel proposal", min: 1 },
      { path: "intake.batchSize", kind: "number", label: "batch size", hint: "inbox items handed to one triage batch", min: 1 },
    ],
  },
  {
    title: "agent",
    fields: [
      { path: "agent.maxRuntimeMs", kind: "number", label: "max runtime ms", hint: "mirrors omp's task.maxRuntimeMs", min: 60_000 },
      { path: "agent.lockTtlMarginMs", kind: "number", label: "lock ttl margin ms", hint: "lock TTL is 2×maxRuntimeMs + this", min: 0 },
      { path: "agent.approvalMode", kind: "text", label: "approval mode", hint: "passed to every dispatched parent session" },
      { path: "agent.ompBin", kind: "text", label: "omp bin", hint: "absolute path to the omp binary" },
      { path: "agent.herdrBin", kind: "text", label: "herdr bin", hint: "absolute path to the herdr binary" },
    ],
  },
  {
    title: "repo defaults",
    fields: [
      { path: "repoDefaults.baseBranch", kind: "text", label: "base branch", hint: "default base branch for new work" },
      { path: "repoDefaults.pr.required", kind: "boolean", label: "pr required", hint: "require a PR before merge" },
      { path: "repoDefaults.pr.draft", kind: "boolean", label: "pr draft", hint: "open PRs as drafts" },
      { path: "repoDefaults.pr.ciRequired", kind: "boolean", label: "pr ci required", hint: "require green CI before merge" },
      { path: "repoDefaults.merge.strategy", kind: "select", label: "merge strategy", hint: "how PRs land on the base branch", options: ["merge", "squash", "rebase"] },
      { path: "repoDefaults.merge.deleteBranch", kind: "boolean", label: "delete branch", hint: "delete the head branch after merge" },
      { path: "repoDefaults.branchPattern", kind: "text", label: "branch pattern", hint: "tokens: <issue-id> <slug> <ISSUE-ID> <repo>" },
      { path: "repoDefaults.worktreePattern", kind: "text", label: "worktree pattern", hint: "resolved relative to the repo directory" },
    ],
  },
];

const ALL_FIELDS: readonly FieldDescriptor[] = SECTIONS.flatMap((section) => section.fields);

// Input handlers receive no rect. Render records the last panel height only;
// it never dispatches, so changing selection remains the sole source of
// scroll state changes.
let lastInnerHeight = 0;

function fieldRowOffset(index: number): number {
  let fieldIndex = 0;
  let offset = 0;
  for (const section of SECTIONS) {
    offset += 1; // section heading
    if (index < fieldIndex + section.fields.length) return offset + index - fieldIndex;
    fieldIndex += section.fields.length;
    offset += section.fields.length + 1; // fields and the section gap
  }
  return 0;
}

function selectField(ctx: ViewContext, index: number): void {
  const selected = Math.min(Math.max(index, 0), ALL_FIELDS.length - 1);
  ctx.dispatch({ type: "setCursor", view: VIEW_ID, index: selected });

  const visibleRows = Math.max(0, lastInnerHeight - 1);
  if (visibleRows === 0) return;
  const current = ctx.state.scroll[VIEW_ID] ?? 0;
  const row = fieldRowOffset(selected);
  const next = row < current ? row : row >= current + visibleRows ? row - visibleRows + 1 : current;
  if (next !== current) ctx.dispatch({ type: "setScroll", view: VIEW_ID, scroll: next });
}

const WINDOW_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && key in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = node[key];
    if (!next || typeof next !== "object") {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}

function configValue(config: GlobalConfig, path: string): unknown {
  return getPath(config, path);
}

function editedValue(ctx: ViewContext, descriptor: FieldDescriptor): string | number | boolean {
  const draftKey = `ui.draft:${descriptor.path}`;
  if (ctx.state.settingsEdits[EDITING_PATH_KEY] === descriptor.path && draftKey in ctx.state.settingsEdits) {
    return ctx.state.settingsEdits[draftKey] as string | number | boolean;
  }
  if (descriptor.path in ctx.state.settingsEdits) {
    return ctx.state.settingsEdits[descriptor.path] as string | number | boolean;
  }
  return configValue(ctx.state.config, descriptor.path) as string | number | boolean;
}

function isPendingEdit(ctx: ViewContext, descriptor: FieldDescriptor): boolean {
  return descriptor.path in ctx.state.settingsEdits;
}

function pendingEdits(ctx: ViewContext): Array<{ descriptor: FieldDescriptor; value: string | number | boolean }> {
  return ALL_FIELDS.filter((descriptor) => isPendingEdit(ctx, descriptor)).map((descriptor) => ({
    descriptor,
    value: ctx.state.settingsEdits[descriptor.path] as string | number | boolean,
  }));
}

function buildSpec(ctx: ViewContext, descriptor: FieldDescriptor): FieldSpec {
  const value = editedValue(ctx, descriptor);
  switch (descriptor.kind) {
    case "text":
      return { kind: "text", label: descriptor.label, value: String(value), hint: descriptor.hint };
    case "number":
      return { kind: "number", label: descriptor.label, value: Number(value), min: descriptor.min, hint: descriptor.hint };
    case "boolean":
      return { kind: "boolean", label: descriptor.label, value: Boolean(value), hint: descriptor.hint };
    case "select":
      return { kind: "select", label: descriptor.label, value: String(value), options: descriptor.options ?? [], hint: descriptor.hint };
  }
}

function validate(descriptor: FieldDescriptor, value: string | number | boolean): string | null {
  if (descriptor.kind === "number" && typeof value === "number" && descriptor.min !== undefined && value < descriptor.min) {
    return `${descriptor.label} must be at least ${descriptor.min}`;
  }
  if (descriptor.path === "intake.window" && typeof value === "string" && !WINDOW_PATTERN.test(value)) {
    return "window must match HH:MM (24h)";
  }
  return null;
}

function editingPath(ctx: ViewContext): string | null {
  const value = ctx.state.settingsEdits[EDITING_PATH_KEY];
  return typeof value === "string" ? value : null;
}

export const settingsView: View = {
  id: VIEW_ID,
  title: "settings",

  badge(ctx: ViewContext): string | null {
    const count = pendingEdits(ctx).length;
    return count > 0 ? String(count) : null;
  },

  render(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const dirtyCount = pendingEdits(ctx).length;
    const footer = ctx.state.settingsError ?? (dirtyCount > 0 ? `${dirtyCount} unsaved` : undefined);
    const inner = panel(canvas, rect, {
      theme: ctx.theme,
      title: "settings",
      focused: true,
      footer,
      tone: ctx.state.settingsError ? "danger" : undefined,
    });
    lastInnerHeight = inner.height;
    const focusedFieldIndex = ctx.state.cursor[VIEW_ID] ?? 0;
    const focusedDescriptor = ALL_FIELDS[focusedFieldIndex];
    let y = inner.y - (ctx.state.scroll[VIEW_ID] ?? 0);
    const editing = editingPath(ctx) !== null;
    const labelWidth = 20;

    for (const section of SECTIONS) {
      if (y >= inner.y && y < inner.y + inner.height) {
        canvas.text(inner.x, y, section.title, ctx.theme.toneSgr("accent"));
      }
      y += 1;
      for (const descriptor of section.fields) {
        const isFocused = descriptor === focusedDescriptor;
        if (y >= inner.y && y < inner.y + inner.height) {
          fieldRow(canvas, { x: inner.x, y, width: inner.width, height: 1 }, {
            theme: ctx.theme,
            spec: buildSpec(ctx, descriptor),
            focused: isFocused,
            editing: isFocused && editing,
            labelWidth,
            dirty: isPendingEdit(ctx, descriptor),
          });
        }
        y += 1;
      }
      y += 1;
    }

    if (y < inner.y + inner.height) {
      canvas.text(inner.x, y, "read-only", ctx.theme.toneSgr("accent"));
      y += 1;
      const lockTtlMs = 2 * Number(configValue(ctx.state.config, "agent.maxRuntimeMs") ?? 0) + Number(configValue(ctx.state.config, "agent.lockTtlMarginMs") ?? 0);
      kvRows(canvas, { x: inner.x, y, width: inner.width, height: Math.max(0, inner.y + inner.height - y) }, {
        theme: ctx.theme,
        entries: [
          ["linear.endpoint", String(configValue(ctx.state.config, "linear.endpoint") ?? "—")],
          ["linear.apiKeyEnv", String(configValue(ctx.state.config, "linear.apiKeyEnv") ?? "—")],
          ["loop.stateDir", String(configValue(ctx.state.config, "loop.stateDir") ?? "—")],
          ["config path", ctx.state.configPath],
          ["lock ttl", duration(lockTtlMs)],
        ],
        labelWidth,
      });
    }
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    const max = ALL_FIELDS.length - 1;
    const index = ctx.state.cursor[VIEW_ID] ?? 0;
    const descriptor = ALL_FIELDS[index];
    const path = editingPath(ctx);

    if (path !== null && descriptor) {
      const spec = buildSpec(ctx, descriptor);
      const result = applyFieldKey(spec, key, true);
      if (result.cancelled) {
        ctx.dispatch({ type: "editSetting", key: EDITING_PATH_KEY, value: "" });
        ctx.dispatch({ type: "settingsError", message: null });
        return true;
      }
      if (result.changed) {
        ctx.dispatch({ type: "editSetting", key: `ui.draft:${descriptor.path}`, value: result.spec.value });
      }
      if (result.committed) {
        const error = validate(descriptor, result.spec.value);
        ctx.dispatch({ type: "editSetting", key: EDITING_PATH_KEY, value: "" });
        if (error) {
          ctx.dispatch({ type: "settingsError", message: error });
        } else {
          ctx.dispatch({ type: "settingsError", message: null });
          ctx.dispatch({ type: "editSetting", key: descriptor.path, value: result.spec.value });
        }
      }
      return true;
    }

    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      selectField(ctx, index - 1);
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      selectField(ctx, index + 1);
      return true;
    }
    if (matchesKey(key, "pageup")) {
      selectField(ctx, index - 8);
      return true;
    }
    if (matchesKey(key, "pagedown")) {
      selectField(ctx, index + 8);
      return true;
    }
    if (matchesKey(key, "home")) {
      selectField(ctx, 0);
      return true;
    }
    if (matchesKey(key, "end")) {
      selectField(ctx, max);
      return true;
    }
    if (matchesKey(key, "enter") && descriptor) {
      ctx.dispatch({ type: "editSetting", key: EDITING_PATH_KEY, value: descriptor.path });
      return true;
    }
    if (matchesKey(key, "ctrl-s")) {
      const edits = pendingEdits(ctx);
      if (edits.length === 0) return true;
      const patch: Record<string, unknown> = {};
      const changeLines: string[] = [];
      for (const { descriptor: fieldDescriptor, value } of edits) {
        setPath(patch, fieldDescriptor.path, value);
        const oldValue = configValue(ctx.state.config, fieldDescriptor.path);
        changeLines.push(`${fieldDescriptor.path}: ${String(oldValue)} → ${String(value)}`);
      }
      const pane = focusedPane(ctx.state);
      if (!pane) {
        ctx.toast("warn", "no loop to save through");
        return true;
      }
      // The patch rides on the modal's `effect`: it must not be written until
      // the operator has seen the `old → new` list and agreed to it.
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "confirm",
          title: "Save config changes?",
          body: changeLines,
          confirmLabel: "Save",
          effect: { loopId: pane.id, op: "patchConfig", params: { patch } },
          onConfirm: { type: "clearSettingEdits" },
        },
      });
      return true;
    }
    if (matchesKey(key, "escape")) {
      if (pendingEdits(ctx).length === 0) return false;
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "confirm",
          title: "Discard unsaved changes?",
          body: ["Every edited field reverts to the current config."],
          confirmLabel: "Discard",
          onConfirm: { type: "clearSettingEdits" },
        },
      });
      return true;
    }
    return false;
  },

  hints(): ReadonlyArray<readonly [string, string]> {
    return [
      ["enter", "edit"],
      ["←/→", "adjust"],
      ["space", "toggle"],
      ["ctrl-s", "save"],
      ["esc", "discard"],
    ];
  },
};
