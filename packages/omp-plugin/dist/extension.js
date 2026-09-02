var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/extension.ts
import { existsSync as existsSync8, mkdtempSync, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";
import { fileURLToPath } from "node:url";

// ../core/src/apply/cleanup.ts
import { existsSync as existsSync2 } from "node:fs";

// ../core/src/git/exec.ts
import { execFile } from "node:child_process";

class CommandFailed extends Error {
  argv;
  code;
  stderr;
  constructor(argv, code, stderr) {
    super(`command failed (${code}): ${argv.join(" ")}
${stderr}`);
    this.name = "CommandFailed";
    this.argv = argv;
    this.code = code;
    this.stderr = stderr;
  }
}
var nodeRunner = {
  run(argv, options) {
    const [command, ...args] = argv;
    if (!command) {
      return Promise.reject(new CommandFailed(argv, -1, "empty argv"));
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: 64 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(new CommandFailed(argv, -1, error.message));
        return;
      }
      const code = error ? error.code ?? 1 : 0;
      if (code !== 0) {
        reject(new CommandFailed(argv, code, stderr));
        return;
      }
      resolve({ stdout, stderr, code });
    });
    return promise;
  }
};

// ../core/src/git/worktree.ts
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
var MAX_SLUG_LENGTH = 48;
function slugify(title) {
  const normalized = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const ascii = normalized.replace(/[^\x00-\x7F]/g, "");
  const hyphenated = ascii.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  const truncated = hyphenated.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  return truncated.length > 0 ? truncated : "issue";
}
var IDENTIFIER_RE = /^[A-Za-z0-9]+-\d+$/;
function assertSafeIdentifier(identifier) {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`refusing to build a worktree path/branch name from issue identifier "${identifier}": ` + `expected Linear's <TEAM>-<number> grammar`);
  }
}
function assertSafeRef(ref, label) {
  if (ref.startsWith("-")) {
    throw new Error(`refusing to pass "${label}" starting with "-" to git: ${ref}`);
  }
}
function branchNameFor(pattern, issue, repoPath) {
  assertSafeIdentifier(issue.identifier);
  return pattern.replace(/<issue-id>/g, issue.identifier.toLowerCase()).replace(/<ISSUE-ID>/g, issue.identifier).replace(/<slug>/g, slugify(issue.title)).replace(/<repo>/g, basename(repoPath));
}
function worktreePathFor(pattern, repoPath, issue) {
  assertSafeIdentifier(issue.identifier);
  const expanded = pattern.replace(/<repo>/g, basename(repoPath)).replace(/<issue-id>/g, issue.identifier.toLowerCase()).replace(/<ISSUE-ID>/g, issue.identifier).replace(/<slug>/g, issue.title !== undefined ? slugify(issue.title) : "<slug>");
  return resolvePath(repoPath, expanded);
}
function parsePorcelain(output) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        prunable: current.prunable ?? false
      });
    }
    current = null;
  };
  for (const line of output.split(`
`)) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    if (current === null)
      continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}
async function listWorktrees(repoPath, runner = nodeRunner) {
  const { stdout } = await runner.run(["git", "worktree", "list", "--porcelain"], {
    cwd: repoPath
  });
  return parsePorcelain(stdout);
}
async function remoteName(repoPath, runner) {
  const { stdout } = await runner.run(["git", "remote"], { cwd: repoPath });
  const name = stdout.split(`
`)[0]?.trim();
  return name && name.length > 0 ? name : null;
}
async function refExists(repoPath, ref, runner) {
  try {
    await runner.run(["git", "rev-parse", "--verify", ref], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}
async function ensureWorktree(input) {
  const { repoPath, worktreePath, branch, baseBranch } = input;
  const runner = input.runner ?? nodeRunner;
  const log = input.log ?? (() => {});
  assertSafeRef(branch, "branch");
  assertSafeRef(baseBranch, "baseBranch");
  const existing = await listWorktrees(repoPath, runner);
  const target = existsSync(worktreePath) ? realpathSync(worktreePath) : worktreePath;
  const registered = existing.find((entry) => entry.path === target || entry.path === worktreePath);
  if (registered) {
    if (registered.branch !== branch) {
      throw new Error(`worktree at ${worktreePath} is registered for branch ` + `${registered.branch ?? "(detached)"}, not ${branch}`);
    }
    return { created: false, branchExisted: true, worktreePath };
  }
  if (existsSync(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a registered git worktree; refusing to clobber it`);
  }
  const remote = await remoteName(repoPath, runner);
  let baseRef = baseBranch;
  if (remote !== null) {
    try {
      await runner.run(["git", "fetch", remote, baseBranch], { cwd: repoPath });
      baseRef = `${remote}/${baseBranch}`;
    } catch (error) {
      if (!await refExists(repoPath, `refs/heads/${baseBranch}`, runner))
        throw error;
      log(`git fetch ${remote} ${baseBranch} failed (${String(error)}); using the local ` + `${baseBranch} ref instead`);
    }
  }
  const branchExisted = await refExists(repoPath, `refs/heads/${branch}`, runner);
  if (branchExisted) {
    await runner.run(["git", "worktree", "add", worktreePath, branch], { cwd: repoPath });
  } else {
    await runner.run(["git", "worktree", "add", "-b", branch, worktreePath, baseRef], { cwd: repoPath });
  }
  return { created: true, branchExisted, worktreePath };
}
async function removeWorktree(repoPath, worktreePath, runner = nodeRunner) {
  await runner.run(["git", "worktree", "remove", worktreePath], { cwd: repoPath });
}
async function worktreeStatus(worktreePath, baseBranch, runner = nodeRunner) {
  const remote = await remoteName(worktreePath, runner);
  const remoteBase = remote !== null ? `${remote}/${baseBranch}` : null;
  const base = remoteBase !== null && await refExists(worktreePath, remoteBase, runner) ? remoteBase : baseBranch;
  const [logResult, statusResult, headResult] = await Promise.all([
    runner.run(["git", "log", `${base}..HEAD`, "--format=%H %s"], { cwd: worktreePath }).catch(() => null),
    runner.run(["git", "status", "--porcelain"], { cwd: worktreePath }).catch(() => null),
    runner.run(["git", "rev-parse", "HEAD"], { cwd: worktreePath }).catch(() => null)
  ]);
  const commits = logResult ? logResult.stdout.split(`
`).map((line) => line.trim()).filter((line) => line.length > 0) : [];
  const dirty = statusResult !== null && statusResult.stdout.trim().length > 0;
  const headSha = headResult ? headResult.stdout.trim() : null;
  let pushed = false;
  if (remote !== null) {
    try {
      const branchName = (await runner.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })).stdout.trim();
      const upstream = await runner.run(["git", "rev-parse", `${remote}/${branchName}`], { cwd: worktreePath });
      pushed = headSha !== null && upstream.stdout.trim() === headSha;
    } catch {
      pushed = false;
    }
  }
  return { commits, dirty, ahead: commits.length, pushed, headSha };
}
async function diffRange(repoPath, base, head, runner = nodeRunner) {
  const { stdout } = await runner.run(["git", "diff", `${base}..${head}`], {
    cwd: repoPath
  });
  return stdout;
}

// ../core/src/apply/cleanup.ts
async function cleanupMergedWork(input) {
  const runner = input.runner ?? nodeRunner;
  const notes = [];
  const worktreePath = worktreePathFor(input.worktreePattern, input.repoPath, input.issue);
  if (existsSync2(worktreePath)) {
    try {
      const status = await worktreeStatus(worktreePath, input.baseBranch, runner);
      if (status.dirty) {
        notes.push(`left ${input.issue.identifier}'s worktree (${worktreePath}) in place — it has uncommitted changes.`);
      } else {
        await removeWorktree(input.repoPath, worktreePath, runner);
      }
    } catch (error) {
      notes.push(`failed to remove ${input.issue.identifier}'s worktree (${worktreePath}): ${String(error)}`);
    }
  }
  if (input.dispatcher?.cleanup) {
    try {
      await input.dispatcher.cleanup(input.issue.identifier, input.repoPath, worktreePath);
    } catch (error) {
      notes.push(`failed to close ${input.issue.identifier}'s dispatcher tab: ${String(error)}`);
    }
  }
  return notes;
}
// ../core/src/markers.ts
var MARKER_KIND = {
  lock: "lock",
  proposal: "proposal",
  applied: "applied",
  block: "block",
  unblock: "unblock",
  review: "review",
  implement: "implement",
  failure: "failure",
  dispatchApplied: "dispatch-applied",
  merged: "merged"
};
var MARKER_FIELD = "foreman";
var MARKER_VERSION = 1;
var FENCE = /```json\s*\n([\s\S]*?)\n```/g;
function encodeMarker(kind, data, human) {
  const envelope = {
    [MARKER_FIELD]: kind,
    version: MARKER_VERSION,
    data
  };
  return `${human.trimEnd()}

\`\`\`json
${JSON.stringify(envelope, null, 2)}
\`\`\``;
}
function decodeMarker(kind, body) {
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(body);match !== null; match = FENCE.exec(body)) {
    const raw = match[1];
    if (raw === undefined)
      continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && parsed[MARKER_FIELD] === kind && parsed.version === MARKER_VERSION) {
      return parsed.data;
    }
  }
  return null;
}
function findMarkers(kind, comments, options) {
  const found = [];
  for (const comment of comments) {
    if (options?.authoredBy !== undefined && comment.user?.id !== options.authoredBy)
      continue;
    const data = decodeMarker(kind, comment.body);
    if (data !== null) {
      found.push({ commentId: comment.id, createdAt: comment.createdAt, data });
    }
  }
  found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return found;
}
function latestMarker(kind, comments, options) {
  const all = findMarkers(kind, comments, options);
  return all.length === 0 ? null : all[all.length - 1];
}

// ../core/src/domain/labels.ts
var LABEL_GROUP = {
  type: "type:",
  agent: "agent:",
  blocked: "blocked:",
  triage: "triage:",
  area: "area:"
};
var TYPE_LABEL = {
  bug: "type:bug",
  feature: "type:feature",
  chore: "type:chore",
  spike: "type:spike",
  docs: "type:docs"
};
var TYPE_LABELS = Object.values(TYPE_LABEL);
var AGENT_LABEL = {
  ready: "agent:ready",
  running: "agent:running",
  proposed: "agent:proposed",
  handsOff: "agent:hands-off"
};
var AGENT_LABELS = Object.values(AGENT_LABEL);
var BLOCKED_LABEL = {
  needsInput: "blocked:needs-input",
  needsDecision: "blocked:needs-decision",
  external: "blocked:external"
};
var BLOCKED_LABELS = Object.values(BLOCKED_LABEL);
var TRIAGE_LABEL = {
  cannotReproduce: "triage:cannot-reproduce",
  duplicate: "triage:duplicate",
  needsInfo: "triage:needs-info",
  wontFix: "triage:wont-fix"
};
var TRIAGE_LABELS = Object.values(TRIAGE_LABEL);
var LEGACY_LABEL = "legacy";
var MANAGED_LABELS = [
  ...TYPE_LABELS,
  ...AGENT_LABELS,
  ...BLOCKED_LABELS,
  ...TRIAGE_LABELS,
  LEGACY_LABEL
];
var MANAGED_LABEL_GROUPS = [
  { prefix: LABEL_GROUP.type, members: TYPE_LABELS },
  { prefix: LABEL_GROUP.agent, members: AGENT_LABELS },
  { prefix: LABEL_GROUP.blocked, members: BLOCKED_LABELS },
  { prefix: LABEL_GROUP.triage, members: TRIAGE_LABELS }
];
function hasLabel(target, name) {
  return target.labels.some((label) => label.name === name);
}
function labelsInGroup(target, prefix) {
  return target.labels.map((label) => label.name).filter((name) => name.startsWith(prefix));
}
function typeLabel(target) {
  return labelsInGroup(target, LABEL_GROUP.type)[0] ?? null;
}
function blockedLabel(target) {
  return labelsInGroup(target, LABEL_GROUP.blocked)[0] ?? null;
}
function labelDisplayName(kebab) {
  return kebab.split("-").filter((word) => word.length > 0).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}
function groupDisplayName(prefix) {
  const key = prefix.endsWith(":") ? prefix.slice(0, -1) : prefix;
  return labelDisplayName(key);
}
function labelIdFromParts(name, parentName) {
  const kebab = (value) => value.trim().toLowerCase().replace(/['’]/g, "").replace(/\s+/g, "-");
  return parentName ? `${kebab(parentName)}:${kebab(name)}` : kebab(name);
}

// ../core/src/domain/states.ts
var FOREMAN_STATE = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  inProgress: "In Progress",
  inReview: "In Review",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate"
};
var STATE_SPEC = {
  triage: { category: "triage", fallback: null },
  backlog: { category: "backlog", fallback: null },
  todo: { category: "unstarted", fallback: null },
  inProgress: { category: "started", fallback: null },
  inReview: { category: "started", fallback: "inProgress" },
  done: { category: "completed", fallback: null },
  canceled: { category: "canceled", fallback: null },
  duplicate: { category: "canceled", fallback: "canceled" }
};

class StateResolutionError extends Error {
  constructor(key, available) {
    super(`No Linear workflow state matches Foreman state "${FOREMAN_STATE[key]}" ` + `(category "${STATE_SPEC[key].category}"). Available: ` + available.map((s) => `${s.name} [${s.type}]`).join(", "));
    this.name = "StateResolutionError";
  }
}
function resolveState(key, states) {
  const spec = STATE_SPEC[key];
  const wanted = FOREMAN_STATE[key];
  const byName = states.find((state) => state.name.toLowerCase() === wanted.toLowerCase());
  if (byName)
    return byName;
  const byCategory = states.filter((state) => state.type === spec.category).sort((a, b) => a.position - b.position)[0];
  if (byCategory)
    return byCategory;
  if (spec.fallback)
    return resolveState(spec.fallback, states);
  throw new StateResolutionError(key, states);
}
function isTerminal(state) {
  return state.type === "completed" || state.type === "canceled";
}
function blockerIsResolved(state) {
  return isTerminal(state);
}

// ../core/src/apply/proposals.ts
function latestProposal(issue, authoredBy) {
  const markers = findMarkers(MARKER_KIND.proposal, issue.comments, authoredBy !== undefined ? { authoredBy } : undefined);
  return markers[markers.length - 1] ?? null;
}
function hasLaterApplied(issue, afterCreatedAt, authoredBy) {
  return findMarkers(MARKER_KIND.applied, issue.comments, authoredBy !== undefined ? { authoredBy } : undefined).some((marker) => marker.createdAt > afterCreatedAt && marker.data.appliedProposalAt !== undefined);
}
function hasLaterReject(issue, afterCreatedAt, authoredBy) {
  return issue.comments.some((comment) => {
    if (comment.createdAt <= afterCreatedAt)
      return false;
    if (authoredBy !== undefined && comment.user?.id !== authoredBy)
      return false;
    const start = comment.body.trim().toLowerCase();
    return start.startsWith("reject:") || start.startsWith("rejected:");
  });
}
function isCurrentlyProposed(issue) {
  return issue.labels.some((label) => label.name === AGENT_LABEL.proposed);
}
function proposalCandidates(issues, authoredBy) {
  const candidates = [];
  for (const issue of issues) {
    const found = latestProposal(issue, authoredBy);
    if (!found)
      continue;
    if (isCurrentlyProposed(issue))
      continue;
    if (hasLaterApplied(issue, found.createdAt, authoredBy))
      continue;
    if (hasLaterReject(issue, found.createdAt, authoredBy))
      continue;
    candidates.push({ issue, item: found.data, proposedAt: found.createdAt });
  }
  return candidates;
}
async function findApprovedUnapplied(linear, options) {
  const issues = await linear.issues({
    filter: options?.filter,
    includeComments: true,
    limit: options?.limit ?? 500
  });
  return proposalCandidates(issues, options?.authoredBy);
}
async function applyProposal(linear, candidate) {
  const { issue, item, proposedAt } = candidate;
  const destinationKey = item.destination === "Backlog" ? "backlog" : item.destination === "Canceled" ? "canceled" : "duplicate";
  const teamStates = await linear.workflowStates(issue.team.id);
  const targetState = resolveState(destinationKey, teamStates);
  const typeLabel2 = await linear.ensureLabel(item.type, issue.team.id);
  const addedLabelIds = [typeLabel2.id];
  if (item.triageLabel) {
    const triageLabel = await linear.ensureLabel(item.triageLabel, issue.team.id);
    addedLabelIds.push(triageLabel.id);
  }
  const mutation = {
    stateId: targetState.id,
    priority: item.proposedPriority,
    addedLabelIds
  };
  if (item.draftDescription)
    mutation.description = item.draftDescription;
  if (item.proposedEstimate !== null)
    mutation.estimate = item.proposedEstimate;
  let projectNote = null;
  if (item.destinationProjectId) {
    mutation.projectId = item.destinationProjectId;
  } else if (item.destinationProject) {
    const projects = await linear.projects();
    const destinationProject = item.destinationProject;
    const matches = projects.filter((candidate2) => candidate2.name.toLowerCase() === destinationProject.toLowerCase());
    if (matches.length === 1 && matches[0]) {
      mutation.projectId = matches[0].id;
    } else if (matches.length === 0) {
      throw new Error(`Proposed project "${destinationProject}" not found for issue ${issue.identifier}.`);
    } else {
      throw new Error(`Proposed project "${destinationProject}" is ambiguous (${matches.length} projects share that name) for issue ${issue.identifier}.`);
    }
  }
  await linear.updateIssue(issue.id, mutation);
  if (item.duplicateOf) {
    const duplicate = await linear.issue(item.duplicateOf);
    if (duplicate) {
      const alreadyRelated = issue.relations.some((relation) => relation.type === "duplicate" && relation.direction === "outgoing" && relation.other.id === duplicate.id);
      if (!alreadyRelated) {
        await linear.createRelation({ issueId: issue.id, relatedIssueId: duplicate.id, type: "duplicate" });
      }
    }
  }
  for (const blockerId of item.proposedBlockedBy) {
    const blocker = await linear.issue(blockerId);
    if (blocker) {
      const alreadyRelated = issue.relations.some((relation) => relation.type === "blocks" && relation.direction === "incoming" && relation.other.id === blocker.id);
      if (!alreadyRelated) {
        await linear.createRelation({ issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
      }
    }
  }
  const body = encodeMarker(MARKER_KIND.applied, { issueId: issue.identifier, appliedProposalAt: proposedAt }, `Applied the \`${item.type}\` proposal: moved to ${item.destination}, priority set.${projectNote ? ` ${projectNote}` : ""}`);
  await linear.createComment({ issueId: issue.id, body });
  return { issueId: issue.id, identifier: issue.identifier, destination: item.destination, note: projectNote };
}
async function runApplyPass(linear, options) {
  const candidates = await findApprovedUnapplied(linear, options);
  const applied = [];
  const failures = [];
  for (const candidate of candidates) {
    try {
      applied.push(await applyProposal(linear, candidate));
    } catch (error) {
      failures.push({
        issueId: candidate.issue.id,
        identifier: candidate.issue.identifier,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { applied, failures };
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/guard/value.mjs
var exports_value = {};
__export(exports_value, {
  IsUndefined: () => IsUndefined,
  IsUint8Array: () => IsUint8Array,
  IsSymbol: () => IsSymbol,
  IsString: () => IsString,
  IsRegExp: () => IsRegExp,
  IsObject: () => IsObject,
  IsNumber: () => IsNumber,
  IsNull: () => IsNull,
  IsIterator: () => IsIterator,
  IsFunction: () => IsFunction,
  IsDate: () => IsDate,
  IsBoolean: () => IsBoolean,
  IsBigInt: () => IsBigInt,
  IsAsyncIterator: () => IsAsyncIterator,
  IsArray: () => IsArray,
  HasPropertyKey: () => HasPropertyKey
});
function HasPropertyKey(value, key) {
  return key in value;
}
function IsAsyncIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.asyncIterator in value;
}
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return typeof value === "bigint";
}
function IsBoolean(value) {
  return typeof value === "boolean";
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsFunction(value) {
  return typeof value === "function";
}
function IsIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.iterator in value;
}
function IsNull(value) {
  return value === null;
}
function IsNumber(value) {
  return typeof value === "number";
}
function IsObject(value) {
  return typeof value === "object" && value !== null;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsString(value) {
  return typeof value === "string";
}
function IsSymbol(value) {
  return typeof value === "symbol";
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUndefined(value) {
  return value === undefined;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/clone/value.mjs
function ArrayType(value) {
  return value.map((value2) => Visit(value2));
}
function DateType(value) {
  return new Date(value.getTime());
}
function Uint8ArrayType(value) {
  return new Uint8Array(value);
}
function RegExpType(value) {
  return new RegExp(value.source, value.flags);
}
function ObjectType(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Visit(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Visit(value[key]);
  }
  return result;
}
function Visit(value) {
  return IsArray(value) ? ArrayType(value) : IsDate(value) ? DateType(value) : IsUint8Array(value) ? Uint8ArrayType(value) : IsRegExp(value) ? RegExpType(value) : IsObject(value) ? ObjectType(value) : value;
}
function Clone(value) {
  return Visit(value);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/clone/type.mjs
function CloneType(schema, options) {
  return options === undefined ? Clone(schema) : Clone({ ...options, ...schema });
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/guard/guard.mjs
function IsAsyncIterator2(value) {
  return IsObject2(value) && globalThis.Symbol.asyncIterator in value;
}
function IsIterator2(value) {
  return IsObject2(value) && globalThis.Symbol.iterator in value;
}
function IsStandardObject(value) {
  return IsObject2(value) && (globalThis.Object.getPrototypeOf(value) === Object.prototype || globalThis.Object.getPrototypeOf(value) === null);
}
function IsPromise(value) {
  return value instanceof globalThis.Promise;
}
function IsDate2(value) {
  return value instanceof Date && globalThis.Number.isFinite(value.getTime());
}
function IsMap(value) {
  return value instanceof globalThis.Map;
}
function IsSet(value) {
  return value instanceof globalThis.Set;
}
function IsTypedArray(value) {
  return globalThis.ArrayBuffer.isView(value);
}
function IsUint8Array2(value) {
  return value instanceof globalThis.Uint8Array;
}
function HasPropertyKey2(value, key) {
  return key in value;
}
function IsObject2(value) {
  return value !== null && typeof value === "object";
}
function IsArray2(value) {
  return globalThis.Array.isArray(value) && !globalThis.ArrayBuffer.isView(value);
}
function IsUndefined2(value) {
  return value === undefined;
}
function IsNull2(value) {
  return value === null;
}
function IsBoolean2(value) {
  return typeof value === "boolean";
}
function IsNumber2(value) {
  return typeof value === "number";
}
function IsInteger(value) {
  return globalThis.Number.isInteger(value);
}
function IsBigInt2(value) {
  return typeof value === "bigint";
}
function IsString2(value) {
  return typeof value === "string";
}
function IsFunction2(value) {
  return typeof value === "function";
}
function IsSymbol2(value) {
  return typeof value === "symbol";
}
function IsValueType(value) {
  return IsBigInt2(value) || IsBoolean2(value) || IsNull2(value) || IsNumber2(value) || IsString2(value) || IsSymbol2(value) || IsUndefined2(value);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/system/policy.mjs
var TypeSystemPolicy;
(function(TypeSystemPolicy2) {
  TypeSystemPolicy2.InstanceMode = "default";
  TypeSystemPolicy2.ExactOptionalPropertyTypes = false;
  TypeSystemPolicy2.AllowArrayObject = false;
  TypeSystemPolicy2.AllowNaN = false;
  TypeSystemPolicy2.AllowNullVoid = false;
  function IsExactOptionalProperty(value, key) {
    return TypeSystemPolicy2.ExactOptionalPropertyTypes ? key in value : value[key] !== undefined;
  }
  TypeSystemPolicy2.IsExactOptionalProperty = IsExactOptionalProperty;
  function IsObjectLike(value) {
    const isObject = IsObject2(value);
    return TypeSystemPolicy2.AllowArrayObject ? isObject : isObject && !IsArray2(value);
  }
  TypeSystemPolicy2.IsObjectLike = IsObjectLike;
  function IsRecordLike(value) {
    return IsObjectLike(value) && !(value instanceof Date) && !(value instanceof Uint8Array);
  }
  TypeSystemPolicy2.IsRecordLike = IsRecordLike;
  function IsNumberLike(value) {
    return TypeSystemPolicy2.AllowNaN ? IsNumber2(value) : Number.isFinite(value);
  }
  TypeSystemPolicy2.IsNumberLike = IsNumberLike;
  function IsVoidLike(value) {
    const isUndefined = IsUndefined2(value);
    return TypeSystemPolicy2.AllowNullVoid ? isUndefined || value === null : isUndefined;
  }
  TypeSystemPolicy2.IsVoidLike = IsVoidLike;
})(TypeSystemPolicy || (TypeSystemPolicy = {}));

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/create/immutable.mjs
function ImmutableArray(value) {
  return globalThis.Object.freeze(value).map((value2) => Immutable(value2));
}
function ImmutableDate(value) {
  return value;
}
function ImmutableUint8Array(value) {
  return value;
}
function ImmutableRegExp(value) {
  return value;
}
function ImmutableObject(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Immutable(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Immutable(value[key]);
  }
  return globalThis.Object.freeze(result);
}
function Immutable(value) {
  return IsArray(value) ? ImmutableArray(value) : IsDate(value) ? ImmutableDate(value) : IsUint8Array(value) ? ImmutableUint8Array(value) : IsRegExp(value) ? ImmutableRegExp(value) : IsObject(value) ? ImmutableObject(value) : value;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/create/type.mjs
function CreateType(schema, options) {
  const result = options !== undefined ? { ...options, ...schema } : schema;
  switch (TypeSystemPolicy.InstanceMode) {
    case "freeze":
      return Immutable(result);
    case "clone":
      return Clone(result);
    default:
      return result;
  }
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/error/error.mjs
class TypeBoxError extends Error {
  constructor(message) {
    super(message);
  }
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/symbols/symbols.mjs
var TransformKind = Symbol.for("TypeBox.Transform");
var ReadonlyKind = Symbol.for("TypeBox.Readonly");
var OptionalKind = Symbol.for("TypeBox.Optional");
var Hint = Symbol.for("TypeBox.Hint");
var Kind = Symbol.for("TypeBox.Kind");

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/guard/kind.mjs
function IsReadonly(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny(value) {
  return IsKindOf(value, "Any");
}
function IsArgument(value) {
  return IsKindOf(value, "Argument");
}
function IsArray3(value) {
  return IsKindOf(value, "Array");
}
function IsAsyncIterator3(value) {
  return IsKindOf(value, "AsyncIterator");
}
function IsBigInt3(value) {
  return IsKindOf(value, "BigInt");
}
function IsBoolean3(value) {
  return IsKindOf(value, "Boolean");
}
function IsComputed(value) {
  return IsKindOf(value, "Computed");
}
function IsConstructor(value) {
  return IsKindOf(value, "Constructor");
}
function IsDate3(value) {
  return IsKindOf(value, "Date");
}
function IsFunction3(value) {
  return IsKindOf(value, "Function");
}
function IsInteger2(value) {
  return IsKindOf(value, "Integer");
}
function IsIntersect(value) {
  return IsKindOf(value, "Intersect");
}
function IsIterator3(value) {
  return IsKindOf(value, "Iterator");
}
function IsKindOf(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralValue(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsLiteral(value) {
  return IsKindOf(value, "Literal");
}
function IsMappedKey(value) {
  return IsKindOf(value, "MappedKey");
}
function IsMappedResult(value) {
  return IsKindOf(value, "MappedResult");
}
function IsNever(value) {
  return IsKindOf(value, "Never");
}
function IsNot(value) {
  return IsKindOf(value, "Not");
}
function IsNull3(value) {
  return IsKindOf(value, "Null");
}
function IsNumber3(value) {
  return IsKindOf(value, "Number");
}
function IsObject3(value) {
  return IsKindOf(value, "Object");
}
function IsPromise2(value) {
  return IsKindOf(value, "Promise");
}
function IsRecord(value) {
  return IsKindOf(value, "Record");
}
function IsRef(value) {
  return IsKindOf(value, "Ref");
}
function IsRegExp2(value) {
  return IsKindOf(value, "RegExp");
}
function IsString3(value) {
  return IsKindOf(value, "String");
}
function IsSymbol3(value) {
  return IsKindOf(value, "Symbol");
}
function IsTemplateLiteral(value) {
  return IsKindOf(value, "TemplateLiteral");
}
function IsThis(value) {
  return IsKindOf(value, "This");
}
function IsTransform(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple(value) {
  return IsKindOf(value, "Tuple");
}
function IsUndefined3(value) {
  return IsKindOf(value, "Undefined");
}
function IsUnion(value) {
  return IsKindOf(value, "Union");
}
function IsUint8Array3(value) {
  return IsKindOf(value, "Uint8Array");
}
function IsUnknown(value) {
  return IsKindOf(value, "Unknown");
}
function IsUnsafe(value) {
  return IsKindOf(value, "Unsafe");
}
function IsVoid(value) {
  return IsKindOf(value, "Void");
}
function IsKind(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]);
}
function IsSchema(value) {
  return IsAny(value) || IsArgument(value) || IsArray3(value) || IsBoolean3(value) || IsBigInt3(value) || IsAsyncIterator3(value) || IsComputed(value) || IsConstructor(value) || IsDate3(value) || IsFunction3(value) || IsInteger2(value) || IsIntersect(value) || IsIterator3(value) || IsLiteral(value) || IsMappedKey(value) || IsMappedResult(value) || IsNever(value) || IsNot(value) || IsNull3(value) || IsNumber3(value) || IsObject3(value) || IsPromise2(value) || IsRecord(value) || IsRef(value) || IsRegExp2(value) || IsString3(value) || IsSymbol3(value) || IsTemplateLiteral(value) || IsThis(value) || IsTuple(value) || IsUndefined3(value) || IsUnion(value) || IsUint8Array3(value) || IsUnknown(value) || IsUnsafe(value) || IsVoid(value) || IsKind(value);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/guard/type.mjs
var exports_type = {};
__export(exports_type, {
  TypeGuardUnknownTypeError: () => TypeGuardUnknownTypeError,
  IsVoid: () => IsVoid2,
  IsUnsafe: () => IsUnsafe2,
  IsUnknown: () => IsUnknown2,
  IsUnionLiteral: () => IsUnionLiteral,
  IsUnion: () => IsUnion2,
  IsUndefined: () => IsUndefined4,
  IsUint8Array: () => IsUint8Array4,
  IsTuple: () => IsTuple2,
  IsTransform: () => IsTransform2,
  IsThis: () => IsThis2,
  IsTemplateLiteral: () => IsTemplateLiteral2,
  IsSymbol: () => IsSymbol4,
  IsString: () => IsString4,
  IsSchema: () => IsSchema2,
  IsRegExp: () => IsRegExp3,
  IsRef: () => IsRef2,
  IsRecursive: () => IsRecursive,
  IsRecord: () => IsRecord2,
  IsReadonly: () => IsReadonly2,
  IsProperties: () => IsProperties,
  IsPromise: () => IsPromise3,
  IsOptional: () => IsOptional2,
  IsObject: () => IsObject4,
  IsNumber: () => IsNumber4,
  IsNull: () => IsNull4,
  IsNot: () => IsNot2,
  IsNever: () => IsNever2,
  IsMappedResult: () => IsMappedResult2,
  IsMappedKey: () => IsMappedKey2,
  IsLiteralValue: () => IsLiteralValue2,
  IsLiteralString: () => IsLiteralString,
  IsLiteralNumber: () => IsLiteralNumber,
  IsLiteralBoolean: () => IsLiteralBoolean,
  IsLiteral: () => IsLiteral2,
  IsKindOf: () => IsKindOf2,
  IsKind: () => IsKind2,
  IsIterator: () => IsIterator4,
  IsIntersect: () => IsIntersect2,
  IsInteger: () => IsInteger3,
  IsImport: () => IsImport,
  IsFunction: () => IsFunction4,
  IsDate: () => IsDate4,
  IsConstructor: () => IsConstructor2,
  IsComputed: () => IsComputed2,
  IsBoolean: () => IsBoolean4,
  IsBigInt: () => IsBigInt4,
  IsAsyncIterator: () => IsAsyncIterator4,
  IsArray: () => IsArray4,
  IsArgument: () => IsArgument2,
  IsAny: () => IsAny2
});
class TypeGuardUnknownTypeError extends TypeBoxError {
}
var KnownTypes = [
  "Argument",
  "Any",
  "Array",
  "AsyncIterator",
  "BigInt",
  "Boolean",
  "Computed",
  "Constructor",
  "Date",
  "Enum",
  "Function",
  "Integer",
  "Intersect",
  "Iterator",
  "Literal",
  "MappedKey",
  "MappedResult",
  "Not",
  "Null",
  "Number",
  "Object",
  "Promise",
  "Record",
  "Ref",
  "RegExp",
  "String",
  "Symbol",
  "TemplateLiteral",
  "This",
  "Tuple",
  "Undefined",
  "Union",
  "Uint8Array",
  "Unknown",
  "Void"
];
function IsPattern(value) {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
function IsControlCharacterFree(value) {
  if (!IsString(value))
    return false;
  for (let i = 0;i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 7 && code <= 13 || code === 27 || code === 127) {
      return false;
    }
  }
  return true;
}
function IsAdditionalProperties(value) {
  return IsOptionalBoolean(value) || IsSchema2(value);
}
function IsOptionalBigInt(value) {
  return IsUndefined(value) || IsBigInt(value);
}
function IsOptionalNumber(value) {
  return IsUndefined(value) || IsNumber(value);
}
function IsOptionalBoolean(value) {
  return IsUndefined(value) || IsBoolean(value);
}
function IsOptionalString(value) {
  return IsUndefined(value) || IsString(value);
}
function IsOptionalPattern(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value) && IsPattern(value);
}
function IsOptionalFormat(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value);
}
function IsOptionalSchema(value) {
  return IsUndefined(value) || IsSchema2(value);
}
function IsReadonly2(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional2(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny2(value) {
  return IsKindOf2(value, "Any") && IsOptionalString(value.$id);
}
function IsArgument2(value) {
  return IsKindOf2(value, "Argument") && IsNumber(value.index);
}
function IsArray4(value) {
  return IsKindOf2(value, "Array") && value.type === "array" && IsOptionalString(value.$id) && IsSchema2(value.items) && IsOptionalNumber(value.minItems) && IsOptionalNumber(value.maxItems) && IsOptionalBoolean(value.uniqueItems) && IsOptionalSchema(value.contains) && IsOptionalNumber(value.minContains) && IsOptionalNumber(value.maxContains);
}
function IsAsyncIterator4(value) {
  return IsKindOf2(value, "AsyncIterator") && value.type === "AsyncIterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsBigInt4(value) {
  return IsKindOf2(value, "BigInt") && value.type === "bigint" && IsOptionalString(value.$id) && IsOptionalBigInt(value.exclusiveMaximum) && IsOptionalBigInt(value.exclusiveMinimum) && IsOptionalBigInt(value.maximum) && IsOptionalBigInt(value.minimum) && IsOptionalBigInt(value.multipleOf);
}
function IsBoolean4(value) {
  return IsKindOf2(value, "Boolean") && value.type === "boolean" && IsOptionalString(value.$id);
}
function IsComputed2(value) {
  return IsKindOf2(value, "Computed") && IsString(value.target) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema));
}
function IsConstructor2(value) {
  return IsKindOf2(value, "Constructor") && value.type === "Constructor" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsDate4(value) {
  return IsKindOf2(value, "Date") && value.type === "Date" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximumTimestamp) && IsOptionalNumber(value.exclusiveMinimumTimestamp) && IsOptionalNumber(value.maximumTimestamp) && IsOptionalNumber(value.minimumTimestamp) && IsOptionalNumber(value.multipleOfTimestamp);
}
function IsFunction4(value) {
  return IsKindOf2(value, "Function") && value.type === "Function" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsImport(value) {
  return IsKindOf2(value, "Import") && HasPropertyKey(value, "$defs") && IsObject(value.$defs) && IsProperties(value.$defs) && HasPropertyKey(value, "$ref") && IsString(value.$ref) && value.$ref in value.$defs;
}
function IsInteger3(value) {
  return IsKindOf2(value, "Integer") && value.type === "integer" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsProperties(value) {
  return IsObject(value) && Object.entries(value).every(([key, schema]) => IsControlCharacterFree(key) && IsSchema2(schema));
}
function IsIntersect2(value) {
  return IsKindOf2(value, "Intersect") && (IsString(value.type) && value.type !== "object" ? false : true) && IsArray(value.allOf) && value.allOf.every((schema) => IsSchema2(schema) && !IsTransform2(schema)) && IsOptionalString(value.type) && (IsOptionalBoolean(value.unevaluatedProperties) || IsOptionalSchema(value.unevaluatedProperties)) && IsOptionalString(value.$id);
}
function IsIterator4(value) {
  return IsKindOf2(value, "Iterator") && value.type === "Iterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsKindOf2(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralString(value) {
  return IsLiteral2(value) && IsString(value.const);
}
function IsLiteralNumber(value) {
  return IsLiteral2(value) && IsNumber(value.const);
}
function IsLiteralBoolean(value) {
  return IsLiteral2(value) && IsBoolean(value.const);
}
function IsLiteral2(value) {
  return IsKindOf2(value, "Literal") && IsOptionalString(value.$id) && IsLiteralValue2(value.const);
}
function IsLiteralValue2(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsMappedKey2(value) {
  return IsKindOf2(value, "MappedKey") && IsArray(value.keys) && value.keys.every((key) => IsNumber(key) || IsString(key));
}
function IsMappedResult2(value) {
  return IsKindOf2(value, "MappedResult") && IsProperties(value.properties);
}
function IsNever2(value) {
  return IsKindOf2(value, "Never") && IsObject(value.not) && Object.getOwnPropertyNames(value.not).length === 0;
}
function IsNot2(value) {
  return IsKindOf2(value, "Not") && IsSchema2(value.not);
}
function IsNull4(value) {
  return IsKindOf2(value, "Null") && value.type === "null" && IsOptionalString(value.$id);
}
function IsNumber4(value) {
  return IsKindOf2(value, "Number") && value.type === "number" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsObject4(value) {
  return IsKindOf2(value, "Object") && value.type === "object" && IsOptionalString(value.$id) && IsProperties(value.properties) && IsAdditionalProperties(value.additionalProperties) && IsOptionalNumber(value.minProperties) && IsOptionalNumber(value.maxProperties);
}
function IsPromise3(value) {
  return IsKindOf2(value, "Promise") && value.type === "Promise" && IsOptionalString(value.$id) && IsSchema2(value.item);
}
function IsRecord2(value) {
  return IsKindOf2(value, "Record") && value.type === "object" && IsOptionalString(value.$id) && IsAdditionalProperties(value.additionalProperties) && IsObject(value.patternProperties) && ((schema) => {
    const keys = Object.getOwnPropertyNames(schema.patternProperties);
    return keys.length === 1 && IsPattern(keys[0]) && IsObject(schema.patternProperties) && IsSchema2(schema.patternProperties[keys[0]]);
  })(value);
}
function IsRecursive(value) {
  return IsObject(value) && Hint in value && value[Hint] === "Recursive";
}
function IsRef2(value) {
  return IsKindOf2(value, "Ref") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsRegExp3(value) {
  return IsKindOf2(value, "RegExp") && IsOptionalString(value.$id) && IsString(value.source) && IsString(value.flags) && IsOptionalNumber(value.maxLength) && IsOptionalNumber(value.minLength);
}
function IsString4(value) {
  return IsKindOf2(value, "String") && value.type === "string" && IsOptionalString(value.$id) && IsOptionalNumber(value.minLength) && IsOptionalNumber(value.maxLength) && IsOptionalPattern(value.pattern) && IsOptionalFormat(value.format);
}
function IsSymbol4(value) {
  return IsKindOf2(value, "Symbol") && value.type === "symbol" && IsOptionalString(value.$id);
}
function IsTemplateLiteral2(value) {
  return IsKindOf2(value, "TemplateLiteral") && value.type === "string" && IsString(value.pattern) && value.pattern[0] === "^" && value.pattern[value.pattern.length - 1] === "$";
}
function IsThis2(value) {
  return IsKindOf2(value, "This") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsTransform2(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple2(value) {
  return IsKindOf2(value, "Tuple") && value.type === "array" && IsOptionalString(value.$id) && IsNumber(value.minItems) && IsNumber(value.maxItems) && value.minItems === value.maxItems && (IsUndefined(value.items) && IsUndefined(value.additionalItems) && value.minItems === 0 || IsArray(value.items) && value.items.every((schema) => IsSchema2(schema)));
}
function IsUndefined4(value) {
  return IsKindOf2(value, "Undefined") && value.type === "undefined" && IsOptionalString(value.$id);
}
function IsUnionLiteral(value) {
  return IsUnion2(value) && value.anyOf.every((schema) => IsLiteralString(schema) || IsLiteralNumber(schema));
}
function IsUnion2(value) {
  return IsKindOf2(value, "Union") && IsOptionalString(value.$id) && IsObject(value) && IsArray(value.anyOf) && value.anyOf.every((schema) => IsSchema2(schema));
}
function IsUint8Array4(value) {
  return IsKindOf2(value, "Uint8Array") && value.type === "Uint8Array" && IsOptionalString(value.$id) && IsOptionalNumber(value.minByteLength) && IsOptionalNumber(value.maxByteLength);
}
function IsUnknown2(value) {
  return IsKindOf2(value, "Unknown") && IsOptionalString(value.$id);
}
function IsUnsafe2(value) {
  return IsKindOf2(value, "Unsafe");
}
function IsVoid2(value) {
  return IsKindOf2(value, "Void") && value.type === "void" && IsOptionalString(value.$id);
}
function IsKind2(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]) && !KnownTypes.includes(value[Kind]);
}
function IsSchema2(value) {
  return IsObject(value) && (IsAny2(value) || IsArgument2(value) || IsArray4(value) || IsBoolean4(value) || IsBigInt4(value) || IsAsyncIterator4(value) || IsComputed2(value) || IsConstructor2(value) || IsDate4(value) || IsFunction4(value) || IsInteger3(value) || IsIntersect2(value) || IsIterator4(value) || IsLiteral2(value) || IsMappedKey2(value) || IsMappedResult2(value) || IsNever2(value) || IsNot2(value) || IsNull4(value) || IsNumber4(value) || IsObject4(value) || IsPromise3(value) || IsRecord2(value) || IsRef2(value) || IsRegExp3(value) || IsString4(value) || IsSymbol4(value) || IsTemplateLiteral2(value) || IsThis2(value) || IsTuple2(value) || IsUndefined4(value) || IsUnion2(value) || IsUint8Array4(value) || IsUnknown2(value) || IsUnsafe2(value) || IsVoid2(value) || IsKind2(value));
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/patterns/patterns.mjs
var PatternBoolean = "(true|false)";
var PatternNumber = "(0|[1-9][0-9]*)";
var PatternString = "(.*)";
var PatternNever = "(?!.*)";
var PatternBooleanExact = `^${PatternBoolean}$`;
var PatternNumberExact = `^${PatternNumber}$`;
var PatternStringExact = `^${PatternString}$`;
var PatternNeverExact = `^${PatternNever}$`;

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/registry/format.mjs
var exports_format = {};
__export(exports_format, {
  Set: () => Set2,
  Has: () => Has,
  Get: () => Get,
  Entries: () => Entries,
  Delete: () => Delete,
  Clear: () => Clear
});
var map = new Map;
function Entries() {
  return new Map(map);
}
function Clear() {
  return map.clear();
}
function Delete(format) {
  return map.delete(format);
}
function Has(format) {
  return map.has(format);
}
function Set2(format, func) {
  map.set(format, func);
}
function Get(format) {
  return map.get(format);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/registry/type.mjs
var exports_type2 = {};
__export(exports_type2, {
  Set: () => Set3,
  Has: () => Has2,
  Get: () => Get2,
  Entries: () => Entries2,
  Delete: () => Delete2,
  Clear: () => Clear2
});
var map2 = new Map;
function Entries2() {
  return new Map(map2);
}
function Clear2() {
  return map2.clear();
}
function Delete2(kind) {
  return map2.delete(kind);
}
function Has2(kind) {
  return map2.has(kind);
}
function Set3(kind, func) {
  map2.set(kind, func);
}
function Get2(kind) {
  return map2.get(kind);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/sets/set.mjs
function SetIncludes(T, S) {
  return T.includes(S);
}
function SetDistinct(T) {
  return [...new Set(T)];
}
function SetIntersect(T, S) {
  return T.filter((L) => S.includes(L));
}
function SetIntersectManyResolve(T, Init) {
  return T.reduce((Acc, L) => {
    return SetIntersect(Acc, L);
  }, Init);
}
function SetIntersectMany(T) {
  return T.length === 1 ? T[0] : T.length > 1 ? SetIntersectManyResolve(T.slice(1), T[0]) : [];
}
function SetUnionMany(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...L);
  return Acc;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/any/any.mjs
function Any(options) {
  return CreateType({ [Kind]: "Any" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/array/array.mjs
function Array2(items, options) {
  return CreateType({ [Kind]: "Array", type: "array", items }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/argument/argument.mjs
function Argument(index) {
  return CreateType({ [Kind]: "Argument", index });
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/async-iterator/async-iterator.mjs
function AsyncIterator(items, options) {
  return CreateType({ [Kind]: "AsyncIterator", type: "AsyncIterator", items }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/computed/computed.mjs
function Computed(target, parameters, options) {
  return CreateType({ [Kind]: "Computed", target, parameters }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/discard/discard.mjs
function DiscardKey(value, key) {
  const { [key]: _, ...rest } = value;
  return rest;
}
function Discard(value, keys) {
  return keys.reduce((acc, key) => DiscardKey(acc, key), value);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/never/never.mjs
function Never(options) {
  return CreateType({ [Kind]: "Never", not: {} }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/mapped/mapped-result.mjs
function MappedResult(properties) {
  return CreateType({
    [Kind]: "MappedResult",
    properties
  });
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/constructor/constructor.mjs
function Constructor(parameters, returns, options) {
  return CreateType({ [Kind]: "Constructor", type: "Constructor", parameters, returns }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/function/function.mjs
function Function(parameters, returns, options) {
  return CreateType({ [Kind]: "Function", type: "Function", parameters, returns }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/union/union-create.mjs
function UnionCreate(T, options) {
  return CreateType({ [Kind]: "Union", anyOf: T }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/union/union-evaluated.mjs
function IsUnionOptional(types) {
  return types.some((type) => IsOptional(type));
}
function RemoveOptionalFromRest(types) {
  return types.map((left) => IsOptional(left) ? RemoveOptionalFromType(left) : left);
}
function RemoveOptionalFromType(T) {
  return Discard(T, [OptionalKind]);
}
function ResolveUnion(types, options) {
  const isOptional = IsUnionOptional(types);
  return isOptional ? Optional(UnionCreate(RemoveOptionalFromRest(types), options)) : UnionCreate(RemoveOptionalFromRest(types), options);
}
function UnionEvaluated(T, options) {
  return T.length === 1 ? CreateType(T[0], options) : T.length === 0 ? Never(options) : ResolveUnion(T, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/union/union.mjs
function Union(types, options) {
  return types.length === 0 ? Never(options) : types.length === 1 ? CreateType(types[0], options) : UnionCreate(types, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/parse.mjs
class TemplateLiteralParserError extends TypeBoxError {
}
function Unescape(pattern) {
  return pattern.replace(/\\\$/g, "$").replace(/\\\*/g, "*").replace(/\\\^/g, "^").replace(/\\\|/g, "|").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
}
function IsNonEscaped(pattern, index, char) {
  return pattern[index] === char && pattern.charCodeAt(index - 1) !== 92;
}
function IsOpenParen(pattern, index) {
  return IsNonEscaped(pattern, index, "(");
}
function IsCloseParen(pattern, index) {
  return IsNonEscaped(pattern, index, ")");
}
function IsSeparator(pattern, index) {
  return IsNonEscaped(pattern, index, "|");
}
function IsGroup(pattern) {
  if (!(IsOpenParen(pattern, 0) && IsCloseParen(pattern, pattern.length - 1)))
    return false;
  let count = 0;
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (count === 0 && index !== pattern.length - 1)
      return false;
  }
  return true;
}
function InGroup(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function IsPrecedenceOr(pattern) {
  let count = 0;
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0)
      return true;
  }
  return false;
}
function IsPrecedenceAnd(pattern) {
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      return true;
  }
  return false;
}
function Or(pattern) {
  let [count, start] = [0, 0];
  const expressions = [];
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0) {
      const range2 = pattern.slice(start, index);
      if (range2.length > 0)
        expressions.push(TemplateLiteralParse(range2));
      start = index + 1;
    }
  }
  const range = pattern.slice(start);
  if (range.length > 0)
    expressions.push(TemplateLiteralParse(range));
  if (expressions.length === 0)
    return { type: "const", const: "" };
  if (expressions.length === 1)
    return expressions[0];
  return { type: "or", expr: expressions };
}
function And(pattern) {
  function Group(value, index) {
    if (!IsOpenParen(value, index))
      throw new TemplateLiteralParserError(`TemplateLiteralParser: Index must point to open parens`);
    let count = 0;
    for (let scan = index;scan < value.length; scan++) {
      if (IsOpenParen(value, scan))
        count += 1;
      if (IsCloseParen(value, scan))
        count -= 1;
      if (count === 0)
        return [index, scan];
    }
    throw new TemplateLiteralParserError(`TemplateLiteralParser: Unclosed group parens in expression`);
  }
  function Range(pattern2, index) {
    for (let scan = index;scan < pattern2.length; scan++) {
      if (IsOpenParen(pattern2, scan))
        return [index, scan];
    }
    return [index, pattern2.length];
  }
  const expressions = [];
  for (let index = 0;index < pattern.length; index++) {
    if (IsOpenParen(pattern, index)) {
      const [start, end] = Group(pattern, index);
      const range = pattern.slice(start, end + 1);
      expressions.push(TemplateLiteralParse(range));
      index = end;
    } else {
      const [start, end] = Range(pattern, index);
      const range = pattern.slice(start, end);
      if (range.length > 0)
        expressions.push(TemplateLiteralParse(range));
      index = end - 1;
    }
  }
  return expressions.length === 0 ? { type: "const", const: "" } : expressions.length === 1 ? expressions[0] : { type: "and", expr: expressions };
}
function TemplateLiteralParse(pattern) {
  return IsGroup(pattern) ? TemplateLiteralParse(InGroup(pattern)) : IsPrecedenceOr(pattern) ? Or(pattern) : IsPrecedenceAnd(pattern) ? And(pattern) : { type: "const", const: Unescape(pattern) };
}
function TemplateLiteralParseExact(pattern) {
  return TemplateLiteralParse(pattern.slice(1, pattern.length - 1));
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/finite.mjs
class TemplateLiteralFiniteError extends TypeBoxError {
}
function IsNumberExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "0" && expression.expr[1].type === "const" && expression.expr[1].const === "[1-9][0-9]*";
}
function IsBooleanExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "true" && expression.expr[1].type === "const" && expression.expr[1].const === "false";
}
function IsStringExpression(expression) {
  return expression.type === "const" && expression.const === ".*";
}
function IsTemplateLiteralExpressionFinite(expression) {
  return IsNumberExpression(expression) || IsStringExpression(expression) ? false : IsBooleanExpression(expression) ? true : expression.type === "and" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "or" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "const" ? true : (() => {
    throw new TemplateLiteralFiniteError(`Unknown expression type`);
  })();
}
function IsTemplateLiteralFinite(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/generate.mjs
class TemplateLiteralGenerateError extends TypeBoxError {
}
function* GenerateReduce(buffer) {
  if (buffer.length === 1)
    return yield* buffer[0];
  for (const left of buffer[0]) {
    for (const right of GenerateReduce(buffer.slice(1))) {
      yield `${left}${right}`;
    }
  }
}
function* GenerateAnd(expression) {
  return yield* GenerateReduce(expression.expr.map((expr) => [...TemplateLiteralExpressionGenerate(expr)]));
}
function* GenerateOr(expression) {
  for (const expr of expression.expr)
    yield* TemplateLiteralExpressionGenerate(expr);
}
function* GenerateConst(expression) {
  return yield expression.const;
}
function* TemplateLiteralExpressionGenerate(expression) {
  return expression.type === "and" ? yield* GenerateAnd(expression) : expression.type === "or" ? yield* GenerateOr(expression) : expression.type === "const" ? yield* GenerateConst(expression) : (() => {
    throw new TemplateLiteralGenerateError("Unknown expression");
  })();
}
function TemplateLiteralGenerate(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression) ? [...TemplateLiteralExpressionGenerate(expression)] : [];
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/literal/literal.mjs
function Literal(value, options) {
  return CreateType({
    [Kind]: "Literal",
    const: value,
    type: typeof value
  }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/boolean/boolean.mjs
function Boolean2(options) {
  return CreateType({ [Kind]: "Boolean", type: "boolean" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/bigint/bigint.mjs
function BigInt2(options) {
  return CreateType({ [Kind]: "BigInt", type: "bigint" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/number/number.mjs
function Number2(options) {
  return CreateType({ [Kind]: "Number", type: "number" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/string/string.mjs
function String2(options) {
  return CreateType({ [Kind]: "String", type: "string" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/syntax.mjs
function* FromUnion(syntax) {
  const trim = syntax.trim().replace(/"|'/g, "");
  return trim === "boolean" ? yield Boolean2() : trim === "number" ? yield Number2() : trim === "bigint" ? yield BigInt2() : trim === "string" ? yield String2() : yield (() => {
    const literals = trim.split("|").map((literal) => Literal(literal.trim()));
    return literals.length === 0 ? Never() : literals.length === 1 ? literals[0] : UnionEvaluated(literals);
  })();
}
function* FromTerminal(syntax) {
  if (syntax[1] !== "{") {
    const L = Literal("$");
    const R = FromSyntax(syntax.slice(1));
    return yield* [L, ...R];
  }
  for (let i = 2;i < syntax.length; i++) {
    if (syntax[i] === "}") {
      const L = FromUnion(syntax.slice(2, i));
      const R = FromSyntax(syntax.slice(i + 1));
      return yield* [...L, ...R];
    }
  }
  yield Literal(syntax);
}
function* FromSyntax(syntax) {
  for (let i = 0;i < syntax.length; i++) {
    if (syntax[i] === "$") {
      const L = Literal(syntax.slice(0, i));
      const R = FromTerminal(syntax.slice(i));
      return yield* [L, ...R];
    }
  }
  yield Literal(syntax);
}
function TemplateLiteralSyntax(syntax) {
  return [...FromSyntax(syntax)];
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/pattern.mjs
class TemplateLiteralPatternError extends TypeBoxError {
}
function Escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function Visit2(schema, acc) {
  return IsTemplateLiteral(schema) ? schema.pattern.slice(1, schema.pattern.length - 1) : IsUnion(schema) ? `(${schema.anyOf.map((schema2) => Visit2(schema2, acc)).join("|")})` : IsNumber3(schema) ? `${acc}${PatternNumber}` : IsInteger2(schema) ? `${acc}${PatternNumber}` : IsBigInt3(schema) ? `${acc}${PatternNumber}` : IsString3(schema) ? `${acc}${PatternString}` : IsLiteral(schema) ? `${acc}${Escape(schema.const.toString())}` : IsBoolean3(schema) ? `${acc}${PatternBoolean}` : (() => {
    throw new TemplateLiteralPatternError(`Unexpected Kind '${schema[Kind]}'`);
  })();
}
function TemplateLiteralPattern(kinds) {
  return `^${kinds.map((schema) => Visit2(schema, "")).join("")}$`;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/union.mjs
function TemplateLiteralToUnion(schema) {
  const R = TemplateLiteralGenerate(schema);
  const L = R.map((S) => Literal(S));
  return UnionEvaluated(L);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/template-literal/template-literal.mjs
function TemplateLiteral(unresolved, options) {
  const pattern = IsString(unresolved) ? TemplateLiteralPattern(TemplateLiteralSyntax(unresolved)) : TemplateLiteralPattern(unresolved);
  return CreateType({ [Kind]: "TemplateLiteral", type: "string", pattern }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-property-keys.mjs
function FromTemplateLiteral(templateLiteral) {
  const keys = TemplateLiteralGenerate(templateLiteral);
  return keys.map((key) => key.toString());
}
function FromUnion2(types) {
  const result = [];
  for (const type of types)
    result.push(...IndexPropertyKeys(type));
  return result;
}
function FromLiteral(literalValue) {
  return [literalValue.toString()];
}
function IndexPropertyKeys(type) {
  return [...new Set(IsTemplateLiteral(type) ? FromTemplateLiteral(type) : IsUnion(type) ? FromUnion2(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : IsNumber3(type) ? ["[number]"] : IsInteger2(type) ? ["[number]"] : [])];
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-result.mjs
function FromProperties(type, properties, options) {
  const result = {};
  for (const K2 of Object.getOwnPropertyNames(properties)) {
    result[K2] = Index(type, IndexPropertyKeys(properties[K2]), options);
  }
  return result;
}
function FromMappedResult(type, mappedResult, options) {
  return FromProperties(type, mappedResult.properties, options);
}
function IndexFromMappedResult(type, mappedResult, options) {
  const properties = FromMappedResult(type, mappedResult, options);
  return MappedResult(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed.mjs
function FromRest(types, key) {
  return types.map((type) => IndexFromPropertyKey(type, key));
}
function FromIntersectRest(types) {
  return types.filter((type) => !IsNever(type));
}
function FromIntersect(types, key) {
  return IntersectEvaluated(FromIntersectRest(FromRest(types, key)));
}
function FromUnionRest(types) {
  return types.some((L) => IsNever(L)) ? [] : types;
}
function FromUnion3(types, key) {
  return UnionEvaluated(FromUnionRest(FromRest(types, key)));
}
function FromTuple(types, key) {
  return key in types ? types[key] : key === "[number]" ? UnionEvaluated(types) : Never();
}
function FromArray(type, key) {
  return key === "[number]" ? type : Never();
}
function FromProperty(properties, propertyKey) {
  return propertyKey in properties ? properties[propertyKey] : Never();
}
function IndexFromPropertyKey(type, propertyKey) {
  return IsIntersect(type) ? FromIntersect(type.allOf, propertyKey) : IsUnion(type) ? FromUnion3(type.anyOf, propertyKey) : IsTuple(type) ? FromTuple(type.items ?? [], propertyKey) : IsArray3(type) ? FromArray(type.items, propertyKey) : IsObject3(type) ? FromProperty(type.properties, propertyKey) : Never();
}
function IndexFromPropertyKeys(type, propertyKeys) {
  return propertyKeys.map((propertyKey) => IndexFromPropertyKey(type, propertyKey));
}
function FromSchema(type, propertyKeys) {
  return UnionEvaluated(IndexFromPropertyKeys(type, propertyKeys));
}
function Index(type, key, options) {
  if (IsRef(type) || IsRef(key)) {
    const error = `Index types using Ref parameters require both Type and Key to be of TSchema`;
    if (!IsSchema(type) || !IsSchema(key))
      throw new TypeBoxError(error);
    return Computed("Index", [type, key]);
  }
  if (IsMappedResult(key))
    return IndexFromMappedResult(type, key, options);
  if (IsMappedKey(key))
    return IndexFromMappedKey(type, key, options);
  return CreateType(IsSchema(key) ? FromSchema(type, IndexPropertyKeys(key)) : FromSchema(type, key), options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-key.mjs
function MappedIndexPropertyKey(type, key, options) {
  return { [key]: Index(type, [key], Clone(options)) };
}
function MappedIndexPropertyKeys(type, propertyKeys, options) {
  return propertyKeys.reduce((result, left) => {
    return { ...result, ...MappedIndexPropertyKey(type, left, options) };
  }, {});
}
function MappedIndexProperties(type, mappedKey, options) {
  return MappedIndexPropertyKeys(type, mappedKey.keys, options);
}
function IndexFromMappedKey(type, mappedKey, options) {
  const properties = MappedIndexProperties(type, mappedKey, options);
  return MappedResult(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/iterator/iterator.mjs
function Iterator(items, options) {
  return CreateType({ [Kind]: "Iterator", type: "Iterator", items }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/object/object.mjs
function RequiredArray(properties) {
  return globalThis.Object.keys(properties).filter((key) => !IsOptional(properties[key]));
}
function _Object_(properties, options) {
  const required = RequiredArray(properties);
  const schema = required.length > 0 ? { [Kind]: "Object", type: "object", required, properties } : { [Kind]: "Object", type: "object", properties };
  return CreateType(schema, options);
}
var Object2 = _Object_;

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/promise/promise.mjs
function Promise2(item, options) {
  return CreateType({ [Kind]: "Promise", type: "Promise", item }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/readonly/readonly.mjs
function RemoveReadonly(schema) {
  return CreateType(Discard(schema, [ReadonlyKind]));
}
function AddReadonly(schema) {
  return CreateType({ ...schema, [ReadonlyKind]: "Readonly" });
}
function ReadonlyWithFlag(schema, F) {
  return F === false ? RemoveReadonly(schema) : AddReadonly(schema);
}
function Readonly(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? ReadonlyFromMappedResult(schema, F) : ReadonlyWithFlag(schema, F);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/readonly/readonly-from-mapped-result.mjs
function FromProperties2(K, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Readonly(K[K2], F);
  return Acc;
}
function FromMappedResult2(R, F) {
  return FromProperties2(R.properties, F);
}
function ReadonlyFromMappedResult(R, F) {
  const P = FromMappedResult2(R, F);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/tuple/tuple.mjs
function Tuple(types, options) {
  return CreateType(types.length > 0 ? { [Kind]: "Tuple", type: "array", items: types, additionalItems: false, minItems: types.length, maxItems: types.length } : { [Kind]: "Tuple", type: "array", minItems: types.length, maxItems: types.length }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/mapped/mapped.mjs
function FromMappedResult3(K, P) {
  return K in P ? FromSchemaType(K, P[K]) : MappedResult(P);
}
function MappedKeyToKnownMappedResultProperties(K) {
  return { [K]: Literal(K) };
}
function MappedKeyToUnknownMappedResultProperties(P) {
  const Acc = {};
  for (const L of P)
    Acc[L] = Literal(L);
  return Acc;
}
function MappedKeyToMappedResultProperties(K, P) {
  return SetIncludes(P, K) ? MappedKeyToKnownMappedResultProperties(K) : MappedKeyToUnknownMappedResultProperties(P);
}
function FromMappedKey(K, P) {
  const R = MappedKeyToMappedResultProperties(K, P);
  return FromMappedResult3(K, R);
}
function FromRest2(K, T) {
  return T.map((L) => FromSchemaType(K, L));
}
function FromProperties3(K, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(T))
    Acc[K2] = FromSchemaType(K, T[K2]);
  return Acc;
}
function FromSchemaType(K, T) {
  const options = { ...T };
  return IsOptional(T) ? Optional(FromSchemaType(K, Discard(T, [OptionalKind]))) : IsReadonly(T) ? Readonly(FromSchemaType(K, Discard(T, [ReadonlyKind]))) : IsMappedResult(T) ? FromMappedResult3(K, T.properties) : IsMappedKey(T) ? FromMappedKey(K, T.keys) : IsConstructor(T) ? Constructor(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsFunction3(T) ? Function(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsAsyncIterator3(T) ? AsyncIterator(FromSchemaType(K, T.items), options) : IsIterator3(T) ? Iterator(FromSchemaType(K, T.items), options) : IsIntersect(T) ? Intersect(FromRest2(K, T.allOf), options) : IsUnion(T) ? Union(FromRest2(K, T.anyOf), options) : IsTuple(T) ? Tuple(FromRest2(K, T.items ?? []), options) : IsObject3(T) ? Object2(FromProperties3(K, T.properties), options) : IsArray3(T) ? Array2(FromSchemaType(K, T.items), options) : IsPromise2(T) ? Promise2(FromSchemaType(K, T.item), options) : T;
}
function MappedFunctionReturnType(K, T) {
  const Acc = {};
  for (const L of K)
    Acc[L] = FromSchemaType(L, T);
  return Acc;
}
function Mapped(key, map3, options) {
  const K = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const RT = map3({ [Kind]: "MappedKey", keys: K });
  const R = MappedFunctionReturnType(K, RT);
  return Object2(R, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/optional/optional.mjs
function RemoveOptional(schema) {
  return CreateType(Discard(schema, [OptionalKind]));
}
function AddOptional(schema) {
  return CreateType({ ...schema, [OptionalKind]: "Optional" });
}
function OptionalWithFlag(schema, F) {
  return F === false ? RemoveOptional(schema) : AddOptional(schema);
}
function Optional(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? OptionalFromMappedResult(schema, F) : OptionalWithFlag(schema, F);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/optional/optional-from-mapped-result.mjs
function FromProperties4(P, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Optional(P[K2], F);
  return Acc;
}
function FromMappedResult4(R, F) {
  return FromProperties4(R.properties, F);
}
function OptionalFromMappedResult(R, F) {
  const P = FromMappedResult4(R, F);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-create.mjs
function IntersectCreate(T, options = {}) {
  const allObjects = T.every((schema) => IsObject3(schema));
  const clonedUnevaluatedProperties = IsSchema(options.unevaluatedProperties) ? { unevaluatedProperties: options.unevaluatedProperties } : {};
  return CreateType(options.unevaluatedProperties === false || IsSchema(options.unevaluatedProperties) || allObjects ? { ...clonedUnevaluatedProperties, [Kind]: "Intersect", type: "object", allOf: T } : { ...clonedUnevaluatedProperties, [Kind]: "Intersect", allOf: T }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-evaluated.mjs
function IsIntersectOptional(types) {
  return types.every((left) => IsOptional(left));
}
function RemoveOptionalFromType2(type) {
  return Discard(type, [OptionalKind]);
}
function RemoveOptionalFromRest2(types) {
  return types.map((left) => IsOptional(left) ? RemoveOptionalFromType2(left) : left);
}
function ResolveIntersect(types, options) {
  return IsIntersectOptional(types) ? Optional(IntersectCreate(RemoveOptionalFromRest2(types), options)) : IntersectCreate(RemoveOptionalFromRest2(types), options);
}
function IntersectEvaluated(types, options = {}) {
  if (types.length === 1)
    return CreateType(types[0], options);
  if (types.length === 0)
    return Never(options);
  if (types.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return ResolveIntersect(types, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intersect/intersect.mjs
function Intersect(types, options) {
  if (types.length === 1)
    return CreateType(types[0], options);
  if (types.length === 0)
    return Never(options);
  if (types.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return IntersectCreate(types, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/ref/ref.mjs
function Ref(...args) {
  const [$ref, options] = typeof args[0] === "string" ? [args[0], args[1]] : [args[0].$id, args[1]];
  if (typeof $ref !== "string")
    throw new TypeBoxError("Ref: $ref must be a string");
  return CreateType({ [Kind]: "Ref", $ref }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/awaited/awaited.mjs
function FromComputed(target, parameters) {
  return Computed("Awaited", [Computed(target, parameters)]);
}
function FromRef($ref) {
  return Computed("Awaited", [Ref($ref)]);
}
function FromIntersect2(types) {
  return Intersect(FromRest3(types));
}
function FromUnion4(types) {
  return Union(FromRest3(types));
}
function FromPromise(type) {
  return Awaited(type);
}
function FromRest3(types) {
  return types.map((type) => Awaited(type));
}
function Awaited(type, options) {
  return CreateType(IsComputed(type) ? FromComputed(type.target, type.parameters) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsUnion(type) ? FromUnion4(type.anyOf) : IsPromise2(type) ? FromPromise(type.item) : IsRef(type) ? FromRef(type.$ref) : type, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-property-keys.mjs
function FromRest4(types) {
  const result = [];
  for (const L of types)
    result.push(KeyOfPropertyKeys(L));
  return result;
}
function FromIntersect3(types) {
  const propertyKeysArray = FromRest4(types);
  const propertyKeys = SetUnionMany(propertyKeysArray);
  return propertyKeys;
}
function FromUnion5(types) {
  const propertyKeysArray = FromRest4(types);
  const propertyKeys = SetIntersectMany(propertyKeysArray);
  return propertyKeys;
}
function FromTuple2(types) {
  return types.map((_, indexer) => indexer.toString());
}
function FromArray2(_) {
  return ["[number]"];
}
function FromProperties5(T) {
  return globalThis.Object.getOwnPropertyNames(T);
}
function FromPatternProperties(patternProperties) {
  if (!includePatternProperties)
    return [];
  const patternPropertyKeys = globalThis.Object.getOwnPropertyNames(patternProperties);
  return patternPropertyKeys.map((key) => {
    return key[0] === "^" && key[key.length - 1] === "$" ? key.slice(1, key.length - 1) : key;
  });
}
function KeyOfPropertyKeys(type) {
  return IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion5(type.anyOf) : IsTuple(type) ? FromTuple2(type.items ?? []) : IsArray3(type) ? FromArray2(type.items) : IsObject3(type) ? FromProperties5(type.properties) : IsRecord(type) ? FromPatternProperties(type.patternProperties) : [];
}
var includePatternProperties = false;
function KeyOfPattern(schema) {
  includePatternProperties = true;
  const keys = KeyOfPropertyKeys(schema);
  includePatternProperties = false;
  const pattern = keys.map((key) => `(${key})`);
  return `^(${pattern.join("|")})$`;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof.mjs
function FromComputed2(target, parameters) {
  return Computed("KeyOf", [Computed(target, parameters)]);
}
function FromRef2($ref) {
  return Computed("KeyOf", [Ref($ref)]);
}
function KeyOfFromType(type, options) {
  const propertyKeys = KeyOfPropertyKeys(type);
  const propertyKeyTypes = KeyOfPropertyKeysToRest(propertyKeys);
  const result = UnionEvaluated(propertyKeyTypes);
  return CreateType(result, options);
}
function KeyOfPropertyKeysToRest(propertyKeys) {
  return propertyKeys.map((L) => L === "[number]" ? Number2() : Literal(L));
}
function KeyOf(type, options) {
  return IsComputed(type) ? FromComputed2(type.target, type.parameters) : IsRef(type) ? FromRef2(type.$ref) : IsMappedResult(type) ? KeyOfFromMappedResult(type, options) : KeyOfFromType(type, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-from-mapped-result.mjs
function FromProperties6(properties, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = KeyOf(properties[K2], Clone(options));
  return result;
}
function FromMappedResult5(mappedResult, options) {
  return FromProperties6(mappedResult.properties, options);
}
function KeyOfFromMappedResult(mappedResult, options) {
  const properties = FromMappedResult5(mappedResult, options);
  return MappedResult(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-property-entries.mjs
function KeyOfPropertyEntries(schema) {
  const keys = KeyOfPropertyKeys(schema);
  const schemas = IndexFromPropertyKeys(schema, keys);
  return keys.map((_, index) => [keys[index], schemas[index]]);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/composite/composite.mjs
function CompositeKeys(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...KeyOfPropertyKeys(L));
  return SetDistinct(Acc);
}
function FilterNever(T) {
  return T.filter((L) => !IsNever(L));
}
function CompositeProperty(T, K) {
  const Acc = [];
  for (const L of T)
    Acc.push(...IndexFromPropertyKeys(L, [K]));
  return FilterNever(Acc);
}
function CompositeProperties(T, K) {
  const Acc = {};
  for (const L of K) {
    Acc[L] = IntersectEvaluated(CompositeProperty(T, L));
  }
  return Acc;
}
function Composite(T, options) {
  const K = CompositeKeys(T);
  const P = CompositeProperties(T, K);
  const R = Object2(P, options);
  return R;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/date/date.mjs
function Date2(options) {
  return CreateType({ [Kind]: "Date", type: "Date" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/null/null.mjs
function Null(options) {
  return CreateType({ [Kind]: "Null", type: "null" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/symbol/symbol.mjs
function Symbol2(options) {
  return CreateType({ [Kind]: "Symbol", type: "symbol" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/undefined/undefined.mjs
function Undefined(options) {
  return CreateType({ [Kind]: "Undefined", type: "undefined" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/uint8array/uint8array.mjs
function Uint8Array2(options) {
  return CreateType({ [Kind]: "Uint8Array", type: "Uint8Array" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/unknown/unknown.mjs
function Unknown(options) {
  return CreateType({ [Kind]: "Unknown" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/const/const.mjs
function FromArray3(T) {
  return T.map((L) => FromValue(L, false));
}
function FromProperties7(value) {
  const Acc = {};
  for (const K of globalThis.Object.getOwnPropertyNames(value))
    Acc[K] = Readonly(FromValue(value[K], false));
  return Acc;
}
function ConditionalReadonly(T, root) {
  return root === true ? T : Readonly(T);
}
function FromValue(value, root) {
  return IsAsyncIterator(value) ? ConditionalReadonly(Any(), root) : IsIterator(value) ? ConditionalReadonly(Any(), root) : IsArray(value) ? Readonly(Tuple(FromArray3(value))) : IsUint8Array(value) ? Uint8Array2() : IsDate(value) ? Date2() : IsObject(value) ? ConditionalReadonly(Object2(FromProperties7(value)), root) : IsFunction(value) ? ConditionalReadonly(Function([], Unknown()), root) : IsUndefined(value) ? Undefined() : IsNull(value) ? Null() : IsSymbol(value) ? Symbol2() : IsBigInt(value) ? BigInt2() : IsNumber(value) ? Literal(value) : IsBoolean(value) ? Literal(value) : IsString(value) ? Literal(value) : Object2({});
}
function Const(T, options) {
  return CreateType(FromValue(T, true), options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/constructor-parameters/constructor-parameters.mjs
function ConstructorParameters(schema, options) {
  return IsConstructor(schema) ? Tuple(schema.parameters, options) : Never(options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/enum/enum.mjs
function Enum(item, options) {
  if (IsUndefined(item))
    throw new Error("Enum undefined or empty");
  const values1 = globalThis.Object.getOwnPropertyNames(item).filter((key) => isNaN(key)).map((key) => item[key]);
  const values2 = [...new Set(values1)];
  const anyOf = values2.map((value) => Literal(value));
  return Union(anyOf, { ...options, [Hint]: "Enum" });
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-check.mjs
class ExtendsResolverError extends TypeBoxError {
}
var ExtendsResult;
(function(ExtendsResult2) {
  ExtendsResult2[ExtendsResult2["Union"] = 0] = "Union";
  ExtendsResult2[ExtendsResult2["True"] = 1] = "True";
  ExtendsResult2[ExtendsResult2["False"] = 2] = "False";
})(ExtendsResult || (ExtendsResult = {}));
function IntoBooleanResult(result) {
  return result === ExtendsResult.False ? result : ExtendsResult.True;
}
function Throw(message) {
  throw new ExtendsResolverError(message);
}
function IsStructuralRight(right) {
  return exports_type.IsNever(right) || exports_type.IsIntersect(right) || exports_type.IsUnion(right) || exports_type.IsUnknown(right) || exports_type.IsAny(right);
}
function StructuralRight(left, right) {
  return exports_type.IsNever(right) ? FromNeverRight(left, right) : exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) ? FromUnionRight(left, right) : exports_type.IsUnknown(right) ? FromUnknownRight(left, right) : exports_type.IsAny(right) ? FromAnyRight(left, right) : Throw("StructuralRight");
}
function FromAnyRight(left, right) {
  return ExtendsResult.True;
}
function FromAny(left, right) {
  return exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) && right.anyOf.some((schema) => exports_type.IsAny(schema) || exports_type.IsUnknown(schema)) ? ExtendsResult.True : exports_type.IsUnion(right) ? ExtendsResult.Union : exports_type.IsUnknown(right) ? ExtendsResult.True : exports_type.IsAny(right) ? ExtendsResult.True : ExtendsResult.Union;
}
function FromArrayRight(left, right) {
  return exports_type.IsUnknown(left) ? ExtendsResult.False : exports_type.IsAny(left) ? ExtendsResult.Union : exports_type.IsNever(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromArray4(left, right) {
  return exports_type.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : !exports_type.IsArray(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromAsyncIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !exports_type.IsAsyncIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromBigInt(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsBigInt(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBooleanRight(left, right) {
  return exports_type.IsLiteralBoolean(left) ? ExtendsResult.True : exports_type.IsBoolean(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBoolean(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsBoolean(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromConstructor(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : !exports_type.IsConstructor(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromDate(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsDate(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromFunction(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : !exports_type.IsFunction(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromIntegerRight(left, right) {
  return exports_type.IsLiteral(left) && exports_value.IsNumber(left.const) ? ExtendsResult.True : exports_type.IsNumber(left) || exports_type.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromInteger(left, right) {
  return exports_type.IsInteger(right) || exports_type.IsNumber(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : ExtendsResult.False;
}
function FromIntersectRight(left, right) {
  return right.allOf.every((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIntersect4(left, right) {
  return left.allOf.some((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !exports_type.IsIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromLiteral2(left, right) {
  return exports_type.IsLiteral(right) && right.const === left.const ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsString(right) ? FromStringRight(left, right) : exports_type.IsNumber(right) ? FromNumberRight(left, right) : exports_type.IsInteger(right) ? FromIntegerRight(left, right) : exports_type.IsBoolean(right) ? FromBooleanRight(left, right) : ExtendsResult.False;
}
function FromNeverRight(left, right) {
  return ExtendsResult.False;
}
function FromNever(left, right) {
  return ExtendsResult.True;
}
function UnwrapTNot(schema) {
  let [current, depth] = [schema, 0];
  while (true) {
    if (!exports_type.IsNot(current))
      break;
    current = current.not;
    depth += 1;
  }
  return depth % 2 === 0 ? current : Unknown();
}
function FromNot(left, right) {
  return exports_type.IsNot(left) ? Visit3(UnwrapTNot(left), right) : exports_type.IsNot(right) ? Visit3(left, UnwrapTNot(right)) : Throw("Invalid fallthrough for Not");
}
function FromNull(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsNull(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumberRight(left, right) {
  return exports_type.IsLiteralNumber(left) ? ExtendsResult.True : exports_type.IsNumber(left) || exports_type.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumber(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsInteger(right) || exports_type.IsNumber(right) ? ExtendsResult.True : ExtendsResult.False;
}
function IsObjectPropertyCount(schema, count) {
  return Object.getOwnPropertyNames(schema.properties).length === count;
}
function IsObjectStringLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectSymbolLike(schema) {
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "description" in schema.properties && exports_type.IsUnion(schema.properties.description) && schema.properties.description.anyOf.length === 2 && (exports_type.IsString(schema.properties.description.anyOf[0]) && exports_type.IsUndefined(schema.properties.description.anyOf[1]) || exports_type.IsString(schema.properties.description.anyOf[1]) && exports_type.IsUndefined(schema.properties.description.anyOf[0]));
}
function IsObjectNumberLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBooleanLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBigIntLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectDateLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectUint8ArrayLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectFunctionLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectConstructorLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectArrayLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectPromiseLike(schema) {
  const then = Function([Any()], Any());
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "then" in schema.properties && IntoBooleanResult(Visit3(schema.properties["then"], then)) === ExtendsResult.True;
}
function Property(left, right) {
  return Visit3(left, right) === ExtendsResult.False ? ExtendsResult.False : exports_type.IsOptional(left) && !exports_type.IsOptional(right) ? ExtendsResult.False : ExtendsResult.True;
}
function FromObjectRight(left, right) {
  return exports_type.IsUnknown(left) ? ExtendsResult.False : exports_type.IsAny(left) ? ExtendsResult.Union : exports_type.IsNever(left) || exports_type.IsLiteralString(left) && IsObjectStringLike(right) || exports_type.IsLiteralNumber(left) && IsObjectNumberLike(right) || exports_type.IsLiteralBoolean(left) && IsObjectBooleanLike(right) || exports_type.IsSymbol(left) && IsObjectSymbolLike(right) || exports_type.IsBigInt(left) && IsObjectBigIntLike(right) || exports_type.IsString(left) && IsObjectStringLike(right) || exports_type.IsSymbol(left) && IsObjectSymbolLike(right) || exports_type.IsNumber(left) && IsObjectNumberLike(right) || exports_type.IsInteger(left) && IsObjectNumberLike(right) || exports_type.IsBoolean(left) && IsObjectBooleanLike(right) || exports_type.IsUint8Array(left) && IsObjectUint8ArrayLike(right) || exports_type.IsDate(left) && IsObjectDateLike(right) || exports_type.IsConstructor(left) && IsObjectConstructorLike(right) || exports_type.IsFunction(left) && IsObjectFunctionLike(right) ? ExtendsResult.True : exports_type.IsRecord(left) && exports_type.IsString(RecordKey(left)) ? (() => {
    return right[Hint] === "Record" ? ExtendsResult.True : ExtendsResult.False;
  })() : exports_type.IsRecord(left) && exports_type.IsNumber(RecordKey(left)) ? (() => {
    return IsObjectPropertyCount(right, 0) ? ExtendsResult.True : ExtendsResult.False;
  })() : ExtendsResult.False;
}
function FromObject(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : !exports_type.IsObject(right) ? ExtendsResult.False : (() => {
    for (const key of Object.getOwnPropertyNames(right.properties)) {
      if (!(key in left.properties) && !exports_type.IsOptional(right.properties[key])) {
        return ExtendsResult.False;
      }
      if (exports_type.IsOptional(right.properties[key])) {
        return ExtendsResult.True;
      }
      if (Property(left.properties[key], right.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })();
}
function FromPromise2(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) && IsObjectPromiseLike(right) ? ExtendsResult.True : !exports_type.IsPromise(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.item, right.item));
}
function RecordKey(schema) {
  return PatternNumberExact in schema.patternProperties ? Number2() : (PatternStringExact in schema.patternProperties) ? String2() : Throw("Unknown record key pattern");
}
function RecordValue(schema) {
  return PatternNumberExact in schema.patternProperties ? schema.patternProperties[PatternNumberExact] : (PatternStringExact in schema.patternProperties) ? schema.patternProperties[PatternStringExact] : Throw("Unable to get record value schema");
}
function FromRecordRight(left, right) {
  const [Key, Value] = [RecordKey(right), RecordValue(right)];
  return exports_type.IsLiteralString(left) && exports_type.IsNumber(Key) && IntoBooleanResult(Visit3(left, Value)) === ExtendsResult.True ? ExtendsResult.True : exports_type.IsUint8Array(left) && exports_type.IsNumber(Key) ? Visit3(left, Value) : exports_type.IsString(left) && exports_type.IsNumber(Key) ? Visit3(left, Value) : exports_type.IsArray(left) && exports_type.IsNumber(Key) ? Visit3(left, Value) : exports_type.IsObject(left) ? (() => {
    for (const key of Object.getOwnPropertyNames(left.properties)) {
      if (Property(Value, left.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })() : ExtendsResult.False;
}
function FromRecord(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : !exports_type.IsRecord(right) ? ExtendsResult.False : Visit3(RecordValue(left), RecordValue(right));
}
function FromRegExp(left, right) {
  const L = exports_type.IsRegExp(left) ? String2() : left;
  const R = exports_type.IsRegExp(right) ? String2() : right;
  return Visit3(L, R);
}
function FromStringRight(left, right) {
  return exports_type.IsLiteral(left) && exports_value.IsString(left.const) ? ExtendsResult.True : exports_type.IsString(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromString(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsString(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromSymbol(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsSymbol(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromTemplateLiteral2(left, right) {
  return exports_type.IsTemplateLiteral(left) ? Visit3(TemplateLiteralToUnion(left), right) : exports_type.IsTemplateLiteral(right) ? Visit3(left, TemplateLiteralToUnion(right)) : Throw("Invalid fallthrough for TemplateLiteral");
}
function IsArrayOfTuple(left, right) {
  return exports_type.IsArray(right) && left.items !== undefined && left.items.every((schema) => Visit3(schema, right.items) === ExtendsResult.True);
}
function FromTupleRight(left, right) {
  return exports_type.IsNever(left) ? ExtendsResult.True : exports_type.IsUnknown(left) ? ExtendsResult.False : exports_type.IsAny(left) ? ExtendsResult.Union : ExtendsResult.False;
}
function FromTuple3(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : exports_type.IsArray(right) && IsArrayOfTuple(left, right) ? ExtendsResult.True : !exports_type.IsTuple(right) ? ExtendsResult.False : exports_value.IsUndefined(left.items) && !exports_value.IsUndefined(right.items) || !exports_value.IsUndefined(left.items) && exports_value.IsUndefined(right.items) ? ExtendsResult.False : exports_value.IsUndefined(left.items) && !exports_value.IsUndefined(right.items) ? ExtendsResult.True : left.items.every((schema, index) => Visit3(schema, right.items[index]) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUint8Array(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsUint8Array(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUndefined(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsRecord(right) ? FromRecordRight(left, right) : exports_type.IsVoid(right) ? FromVoidRight(left, right) : exports_type.IsUndefined(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnionRight(left, right) {
  return right.anyOf.some((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnion6(left, right) {
  return left.anyOf.every((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnknownRight(left, right) {
  return ExtendsResult.True;
}
function FromUnknown(left, right) {
  return exports_type.IsNever(right) ? FromNeverRight(left, right) : exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) ? FromUnionRight(left, right) : exports_type.IsAny(right) ? FromAnyRight(left, right) : exports_type.IsString(right) ? FromStringRight(left, right) : exports_type.IsNumber(right) ? FromNumberRight(left, right) : exports_type.IsInteger(right) ? FromIntegerRight(left, right) : exports_type.IsBoolean(right) ? FromBooleanRight(left, right) : exports_type.IsArray(right) ? FromArrayRight(left, right) : exports_type.IsTuple(right) ? FromTupleRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsUnknown(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoidRight(left, right) {
  return exports_type.IsUndefined(left) ? ExtendsResult.True : exports_type.IsUndefined(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoid(left, right) {
  return exports_type.IsIntersect(right) ? FromIntersectRight(left, right) : exports_type.IsUnion(right) ? FromUnionRight(left, right) : exports_type.IsUnknown(right) ? FromUnknownRight(left, right) : exports_type.IsAny(right) ? FromAnyRight(left, right) : exports_type.IsObject(right) ? FromObjectRight(left, right) : exports_type.IsVoid(right) ? ExtendsResult.True : ExtendsResult.False;
}
function Visit3(left, right) {
  return exports_type.IsTemplateLiteral(left) || exports_type.IsTemplateLiteral(right) ? FromTemplateLiteral2(left, right) : exports_type.IsRegExp(left) || exports_type.IsRegExp(right) ? FromRegExp(left, right) : exports_type.IsNot(left) || exports_type.IsNot(right) ? FromNot(left, right) : exports_type.IsAny(left) ? FromAny(left, right) : exports_type.IsArray(left) ? FromArray4(left, right) : exports_type.IsBigInt(left) ? FromBigInt(left, right) : exports_type.IsBoolean(left) ? FromBoolean(left, right) : exports_type.IsAsyncIterator(left) ? FromAsyncIterator(left, right) : exports_type.IsConstructor(left) ? FromConstructor(left, right) : exports_type.IsDate(left) ? FromDate(left, right) : exports_type.IsFunction(left) ? FromFunction(left, right) : exports_type.IsInteger(left) ? FromInteger(left, right) : exports_type.IsIntersect(left) ? FromIntersect4(left, right) : exports_type.IsIterator(left) ? FromIterator(left, right) : exports_type.IsLiteral(left) ? FromLiteral2(left, right) : exports_type.IsNever(left) ? FromNever(left, right) : exports_type.IsNull(left) ? FromNull(left, right) : exports_type.IsNumber(left) ? FromNumber(left, right) : exports_type.IsObject(left) ? FromObject(left, right) : exports_type.IsRecord(left) ? FromRecord(left, right) : exports_type.IsString(left) ? FromString(left, right) : exports_type.IsSymbol(left) ? FromSymbol(left, right) : exports_type.IsTuple(left) ? FromTuple3(left, right) : exports_type.IsPromise(left) ? FromPromise2(left, right) : exports_type.IsUint8Array(left) ? FromUint8Array(left, right) : exports_type.IsUndefined(left) ? FromUndefined(left, right) : exports_type.IsUnion(left) ? FromUnion6(left, right) : exports_type.IsUnknown(left) ? FromUnknown(left, right) : exports_type.IsVoid(left) ? FromVoid(left, right) : Throw(`Unknown left type operand '${left[Kind]}'`);
}
function ExtendsCheck(left, right) {
  return Visit3(left, right);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-result.mjs
function FromProperties8(P, Right, True, False, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extends(P[K2], Right, True, False, Clone(options));
  return Acc;
}
function FromMappedResult6(Left, Right, True, False, options) {
  return FromProperties8(Left.properties, Right, True, False, options);
}
function ExtendsFromMappedResult(Left, Right, True, False, options) {
  const P = FromMappedResult6(Left, Right, True, False, options);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends.mjs
function ExtendsResolve(left, right, trueType, falseType) {
  const R = ExtendsCheck(left, right);
  return R === ExtendsResult.Union ? Union([trueType, falseType]) : R === ExtendsResult.True ? trueType : falseType;
}
function Extends(L, R, T, F, options) {
  return IsMappedResult(L) ? ExtendsFromMappedResult(L, R, T, F, options) : IsMappedKey(L) ? CreateType(ExtendsFromMappedKey(L, R, T, F, options)) : CreateType(ExtendsResolve(L, R, T, F), options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-key.mjs
function FromPropertyKey(K, U, L, R, options) {
  return {
    [K]: Extends(Literal(K), U, L, R, Clone(options))
  };
}
function FromPropertyKeys(K, U, L, R, options) {
  return K.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey(LK, U, L, R, options) };
  }, {});
}
function FromMappedKey2(K, U, L, R, options) {
  return FromPropertyKeys(K.keys, U, L, R, options);
}
function ExtendsFromMappedKey(T, U, L, R, options) {
  const P = FromMappedKey2(T, U, L, R, options);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extends/extends-undefined.mjs
function Intersect2(schema) {
  return schema.allOf.every((schema2) => ExtendsUndefinedCheck(schema2));
}
function Union2(schema) {
  return schema.anyOf.some((schema2) => ExtendsUndefinedCheck(schema2));
}
function Not(schema) {
  return !ExtendsUndefinedCheck(schema.not);
}
function ExtendsUndefinedCheck(schema) {
  return schema[Kind] === "Intersect" ? Intersect2(schema) : schema[Kind] === "Union" ? Union2(schema) : schema[Kind] === "Not" ? Not(schema) : schema[Kind] === "Undefined" ? true : false;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-template-literal.mjs
function ExcludeFromTemplateLiteral(L, R) {
  return Exclude(TemplateLiteralToUnion(L), R);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude.mjs
function ExcludeRest(L, R) {
  const excluded = L.filter((inner) => ExtendsCheck(inner, R) === ExtendsResult.False);
  return excluded.length === 1 ? excluded[0] : Union(excluded);
}
function Exclude(L, R, options = {}) {
  if (IsTemplateLiteral(L))
    return CreateType(ExcludeFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExcludeFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExcludeRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? Never() : L, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-mapped-result.mjs
function FromProperties9(P, U) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Exclude(P[K2], U);
  return Acc;
}
function FromMappedResult7(R, T) {
  return FromProperties9(R.properties, T);
}
function ExcludeFromMappedResult(R, T) {
  const P = FromMappedResult7(R, T);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-template-literal.mjs
function ExtractFromTemplateLiteral(L, R) {
  return Extract(TemplateLiteralToUnion(L), R);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extract/extract.mjs
function ExtractRest(L, R) {
  const extracted = L.filter((inner) => ExtendsCheck(inner, R) !== ExtendsResult.False);
  return extracted.length === 1 ? extracted[0] : Union(extracted);
}
function Extract(L, R, options) {
  if (IsTemplateLiteral(L))
    return CreateType(ExtractFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExtractFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExtractRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? L : Never(), options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-mapped-result.mjs
function FromProperties10(P, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extract(P[K2], T);
  return Acc;
}
function FromMappedResult8(R, T) {
  return FromProperties10(R.properties, T);
}
function ExtractFromMappedResult(R, T) {
  const P = FromMappedResult8(R, T);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/instance-type/instance-type.mjs
function InstanceType(schema, options) {
  return IsConstructor(schema) ? CreateType(schema.returns, options) : Never(options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/readonly-optional/readonly-optional.mjs
function ReadonlyOptional(schema) {
  return Readonly(Optional(schema));
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/record/record.mjs
function RecordCreateFromPattern(pattern, T, options) {
  return CreateType({ [Kind]: "Record", type: "object", patternProperties: { [pattern]: T } }, options);
}
function RecordCreateFromKeys(K, T, options) {
  const result = {};
  for (const K2 of K)
    result[K2] = T;
  return Object2(result, { ...options, [Hint]: "Record" });
}
function FromTemplateLiteralKey(K, T, options) {
  return IsTemplateLiteralFinite(K) ? RecordCreateFromKeys(IndexPropertyKeys(K), T, options) : RecordCreateFromPattern(K.pattern, T, options);
}
function FromUnionKey(key, type, options) {
  return RecordCreateFromKeys(IndexPropertyKeys(Union(key)), type, options);
}
function FromLiteralKey(key, type, options) {
  return RecordCreateFromKeys([key.toString()], type, options);
}
function FromRegExpKey(key, type, options) {
  return RecordCreateFromPattern(key.source, type, options);
}
function FromStringKey(key, type, options) {
  const pattern = IsUndefined(key.pattern) ? PatternStringExact : key.pattern;
  return RecordCreateFromPattern(pattern, type, options);
}
function FromAnyKey(_, type, options) {
  return RecordCreateFromPattern(PatternStringExact, type, options);
}
function FromNeverKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNeverExact, type, options);
}
function FromBooleanKey(_key, type, options) {
  return Object2({ true: type, false: type }, options);
}
function FromIntegerKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function FromNumberKey(_, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function Record(key, type, options = {}) {
  return IsUnion(key) ? FromUnionKey(key.anyOf, type, options) : IsTemplateLiteral(key) ? FromTemplateLiteralKey(key, type, options) : IsLiteral(key) ? FromLiteralKey(key.const, type, options) : IsBoolean3(key) ? FromBooleanKey(key, type, options) : IsInteger2(key) ? FromIntegerKey(key, type, options) : IsNumber3(key) ? FromNumberKey(key, type, options) : IsRegExp2(key) ? FromRegExpKey(key, type, options) : IsString3(key) ? FromStringKey(key, type, options) : IsAny(key) ? FromAnyKey(key, type, options) : IsNever(key) ? FromNeverKey(key, type, options) : Never(options);
}
function RecordPattern(record) {
  return globalThis.Object.getOwnPropertyNames(record.patternProperties)[0];
}
function RecordKey2(type) {
  const pattern = RecordPattern(type);
  return pattern === PatternStringExact ? String2() : pattern === PatternNumberExact ? Number2() : String2({ pattern });
}
function RecordValue2(type) {
  return type.patternProperties[RecordPattern(type)];
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/instantiate/instantiate.mjs
function FromConstructor2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromFunction2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromIntersect5(args, type) {
  type.allOf = FromTypes(args, type.allOf);
  return type;
}
function FromUnion7(args, type) {
  type.anyOf = FromTypes(args, type.anyOf);
  return type;
}
function FromTuple4(args, type) {
  if (IsUndefined(type.items))
    return type;
  type.items = FromTypes(args, type.items);
  return type;
}
function FromArray5(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromAsyncIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromPromise3(args, type) {
  type.item = FromType(args, type.item);
  return type;
}
function FromObject2(args, type) {
  const mappedProperties = FromProperties11(args, type.properties);
  return { ...type, ...Object2(mappedProperties) };
}
function FromRecord2(args, type) {
  const mappedKey = FromType(args, RecordKey2(type));
  const mappedValue = FromType(args, RecordValue2(type));
  const result = Record(mappedKey, mappedValue);
  return { ...type, ...result };
}
function FromArgument(args, argument) {
  return argument.index in args ? args[argument.index] : Unknown();
}
function FromProperty2(args, type) {
  const isReadonly = IsReadonly(type);
  const isOptional = IsOptional(type);
  const mapped = FromType(args, type);
  return isReadonly && isOptional ? ReadonlyOptional(mapped) : isReadonly && !isOptional ? Readonly(mapped) : !isReadonly && isOptional ? Optional(mapped) : mapped;
}
function FromProperties11(args, properties) {
  return globalThis.Object.getOwnPropertyNames(properties).reduce((result, key) => {
    return { ...result, [key]: FromProperty2(args, properties[key]) };
  }, {});
}
function FromTypes(args, types) {
  return types.map((type) => FromType(args, type));
}
function FromType(args, type) {
  return IsConstructor(type) ? FromConstructor2(args, type) : IsFunction3(type) ? FromFunction2(args, type) : IsIntersect(type) ? FromIntersect5(args, type) : IsUnion(type) ? FromUnion7(args, type) : IsTuple(type) ? FromTuple4(args, type) : IsArray3(type) ? FromArray5(args, type) : IsAsyncIterator3(type) ? FromAsyncIterator2(args, type) : IsIterator3(type) ? FromIterator2(args, type) : IsPromise2(type) ? FromPromise3(args, type) : IsObject3(type) ? FromObject2(args, type) : IsRecord(type) ? FromRecord2(args, type) : IsArgument(type) ? FromArgument(args, type) : type;
}
function Instantiate(type, args) {
  return FromType(args, CloneType(type));
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/integer/integer.mjs
function Integer(options) {
  return CreateType({ [Kind]: "Integer", type: "integer" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic-from-mapped-key.mjs
function MappedIntrinsicPropertyKey(K, M, options) {
  return {
    [K]: Intrinsic(Literal(K), M, Clone(options))
  };
}
function MappedIntrinsicPropertyKeys(K, M, options) {
  const result = K.reduce((Acc, L) => {
    return { ...Acc, ...MappedIntrinsicPropertyKey(L, M, options) };
  }, {});
  return result;
}
function MappedIntrinsicProperties(T, M, options) {
  return MappedIntrinsicPropertyKeys(T["keys"], M, options);
}
function IntrinsicFromMappedKey(T, M, options) {
  const P = MappedIntrinsicProperties(T, M, options);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic.mjs
function ApplyUncapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toLowerCase(), rest].join("");
}
function ApplyCapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toUpperCase(), rest].join("");
}
function ApplyUppercase(value) {
  return value.toUpperCase();
}
function ApplyLowercase(value) {
  return value.toLowerCase();
}
function FromTemplateLiteral3(schema, mode, options) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  const finite = IsTemplateLiteralExpressionFinite(expression);
  if (!finite)
    return { ...schema, pattern: FromLiteralValue(schema.pattern, mode) };
  const strings = [...TemplateLiteralExpressionGenerate(expression)];
  const literals = strings.map((value) => Literal(value));
  const mapped = FromRest5(literals, mode);
  const union = Union(mapped);
  return TemplateLiteral([union], options);
}
function FromLiteralValue(value, mode) {
  return typeof value === "string" ? mode === "Uncapitalize" ? ApplyUncapitalize(value) : mode === "Capitalize" ? ApplyCapitalize(value) : mode === "Uppercase" ? ApplyUppercase(value) : mode === "Lowercase" ? ApplyLowercase(value) : value : value.toString();
}
function FromRest5(T, M) {
  return T.map((L) => Intrinsic(L, M));
}
function Intrinsic(schema, mode, options = {}) {
  return IsMappedKey(schema) ? IntrinsicFromMappedKey(schema, mode, options) : IsTemplateLiteral(schema) ? FromTemplateLiteral3(schema, mode, options) : IsUnion(schema) ? Union(FromRest5(schema.anyOf, mode), options) : IsLiteral(schema) ? Literal(FromLiteralValue(schema.const, mode), options) : CreateType(schema, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/capitalize.mjs
function Capitalize(T, options = {}) {
  return Intrinsic(T, "Capitalize", options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/lowercase.mjs
function Lowercase(T, options = {}) {
  return Intrinsic(T, "Lowercase", options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/uncapitalize.mjs
function Uncapitalize(T, options = {}) {
  return Intrinsic(T, "Uncapitalize", options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/intrinsic/uppercase.mjs
function Uppercase(T, options = {}) {
  return Intrinsic(T, "Uppercase", options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-result.mjs
function FromProperties12(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Omit(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult9(mappedResult, propertyKeys, options) {
  return FromProperties12(mappedResult.properties, propertyKeys, options);
}
function OmitFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult9(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/omit/omit.mjs
function FromIntersect6(types, propertyKeys) {
  return types.map((type) => OmitResolve(type, propertyKeys));
}
function FromUnion8(types, propertyKeys) {
  return types.map((type) => OmitResolve(type, propertyKeys));
}
function FromProperty3(properties, key) {
  const { [key]: _, ...R } = properties;
  return R;
}
function FromProperties13(properties, propertyKeys) {
  return propertyKeys.reduce((T, K2) => FromProperty3(T, K2), properties);
}
function FromObject3(type, propertyKeys, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties13(properties, propertyKeys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function OmitResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect6(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion8(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject3(type, propertyKeys, type.properties) : Object2({});
}
function Omit(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? OmitFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? OmitFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Omit", [type, typeKey], options) : CreateType({ ...OmitResolve(type, propertyKeys), ...options });
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-key.mjs
function FromPropertyKey2(type, key, options) {
  return { [key]: Omit(type, [key], Clone(options)) };
}
function FromPropertyKeys2(type, propertyKeys, options) {
  return propertyKeys.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey2(type, LK, options) };
  }, {});
}
function FromMappedKey3(type, mappedKey, options) {
  return FromPropertyKeys2(type, mappedKey.keys, options);
}
function OmitFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey3(type, mappedKey, options);
  return MappedResult(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-result.mjs
function FromProperties14(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Pick(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult10(mappedResult, propertyKeys, options) {
  return FromProperties14(mappedResult.properties, propertyKeys, options);
}
function PickFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult10(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/pick/pick.mjs
function FromIntersect7(types, propertyKeys) {
  return types.map((type) => PickResolve(type, propertyKeys));
}
function FromUnion9(types, propertyKeys) {
  return types.map((type) => PickResolve(type, propertyKeys));
}
function FromProperties15(properties, propertyKeys) {
  const result = {};
  for (const K2 of propertyKeys)
    if (K2 in properties)
      result[K2] = properties[K2];
  return result;
}
function FromObject4(Type, keys, properties) {
  const options = Discard(Type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties15(properties, keys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys2(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function PickResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect7(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion9(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject4(type, propertyKeys, type.properties) : Object2({});
}
function Pick(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys2(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? PickFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? PickFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Pick", [type, typeKey], options) : CreateType({ ...PickResolve(type, propertyKeys), ...options });
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-key.mjs
function FromPropertyKey3(type, key, options) {
  return {
    [key]: Pick(type, [key], Clone(options))
  };
}
function FromPropertyKeys3(type, propertyKeys, options) {
  return propertyKeys.reduce((result, leftKey) => {
    return { ...result, ...FromPropertyKey3(type, leftKey, options) };
  }, {});
}
function FromMappedKey4(type, mappedKey, options) {
  return FromPropertyKeys3(type, mappedKey.keys, options);
}
function PickFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey4(type, mappedKey, options);
  return MappedResult(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/partial/partial.mjs
function FromComputed3(target, parameters) {
  return Computed("Partial", [Computed(target, parameters)]);
}
function FromRef3($ref) {
  return Computed("Partial", [Ref($ref)]);
}
function FromProperties16(properties) {
  const partialProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    partialProperties[K] = Optional(properties[K]);
  return partialProperties;
}
function FromObject5(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties16(properties);
  return Object2(mappedProperties, options);
}
function FromRest6(types) {
  return types.map((type) => PartialResolve(type));
}
function PartialResolve(type) {
  return IsComputed(type) ? FromComputed3(type.target, type.parameters) : IsRef(type) ? FromRef3(type.$ref) : IsIntersect(type) ? Intersect(FromRest6(type.allOf)) : IsUnion(type) ? Union(FromRest6(type.anyOf)) : IsObject3(type) ? FromObject5(type, type.properties) : IsBigInt3(type) ? type : IsBoolean3(type) ? type : IsInteger2(type) ? type : IsLiteral(type) ? type : IsNull3(type) ? type : IsNumber3(type) ? type : IsString3(type) ? type : IsSymbol3(type) ? type : IsUndefined3(type) ? type : Object2({});
}
function Partial(type, options) {
  if (IsMappedResult(type)) {
    return PartialFromMappedResult(type, options);
  } else {
    return CreateType({ ...PartialResolve(type), ...options });
  }
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/partial/partial-from-mapped-result.mjs
function FromProperties17(K, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Partial(K[K2], Clone(options));
  return Acc;
}
function FromMappedResult11(R, options) {
  return FromProperties17(R.properties, options);
}
function PartialFromMappedResult(R, options) {
  const P = FromMappedResult11(R, options);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/required/required.mjs
function FromComputed4(target, parameters) {
  return Computed("Required", [Computed(target, parameters)]);
}
function FromRef4($ref) {
  return Computed("Required", [Ref($ref)]);
}
function FromProperties18(properties) {
  const requiredProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    requiredProperties[K] = Discard(properties[K], [OptionalKind]);
  return requiredProperties;
}
function FromObject6(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties18(properties);
  return Object2(mappedProperties, options);
}
function FromRest7(types) {
  return types.map((type) => RequiredResolve(type));
}
function RequiredResolve(type) {
  return IsComputed(type) ? FromComputed4(type.target, type.parameters) : IsRef(type) ? FromRef4(type.$ref) : IsIntersect(type) ? Intersect(FromRest7(type.allOf)) : IsUnion(type) ? Union(FromRest7(type.anyOf)) : IsObject3(type) ? FromObject6(type, type.properties) : IsBigInt3(type) ? type : IsBoolean3(type) ? type : IsInteger2(type) ? type : IsLiteral(type) ? type : IsNull3(type) ? type : IsNumber3(type) ? type : IsString3(type) ? type : IsSymbol3(type) ? type : IsUndefined3(type) ? type : Object2({});
}
function Required(type, options) {
  if (IsMappedResult(type)) {
    return RequiredFromMappedResult(type, options);
  } else {
    return CreateType({ ...RequiredResolve(type), ...options });
  }
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/required/required-from-mapped-result.mjs
function FromProperties19(P, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Required(P[K2], options);
  return Acc;
}
function FromMappedResult12(R, options) {
  return FromProperties19(R.properties, options);
}
function RequiredFromMappedResult(R, options) {
  const P = FromMappedResult12(R, options);
  return MappedResult(P);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/module/compute.mjs
function DereferenceParameters(moduleProperties, types) {
  return types.map((type) => {
    return IsRef(type) ? Dereference(moduleProperties, type.$ref) : FromType2(moduleProperties, type);
  });
}
function Dereference(moduleProperties, ref) {
  return ref in moduleProperties ? IsRef(moduleProperties[ref]) ? Dereference(moduleProperties, moduleProperties[ref].$ref) : FromType2(moduleProperties, moduleProperties[ref]) : Never();
}
function FromAwaited(parameters) {
  return Awaited(parameters[0]);
}
function FromIndex(parameters) {
  return Index(parameters[0], parameters[1]);
}
function FromKeyOf(parameters) {
  return KeyOf(parameters[0]);
}
function FromPartial(parameters) {
  return Partial(parameters[0]);
}
function FromOmit(parameters) {
  return Omit(parameters[0], parameters[1]);
}
function FromPick(parameters) {
  return Pick(parameters[0], parameters[1]);
}
function FromRequired(parameters) {
  return Required(parameters[0]);
}
function FromComputed5(moduleProperties, target, parameters) {
  const dereferenced = DereferenceParameters(moduleProperties, parameters);
  return target === "Awaited" ? FromAwaited(dereferenced) : target === "Index" ? FromIndex(dereferenced) : target === "KeyOf" ? FromKeyOf(dereferenced) : target === "Partial" ? FromPartial(dereferenced) : target === "Omit" ? FromOmit(dereferenced) : target === "Pick" ? FromPick(dereferenced) : target === "Required" ? FromRequired(dereferenced) : Never();
}
function FromArray6(moduleProperties, type) {
  return Array2(FromType2(moduleProperties, type));
}
function FromAsyncIterator3(moduleProperties, type) {
  return AsyncIterator(FromType2(moduleProperties, type));
}
function FromConstructor3(moduleProperties, parameters, instanceType) {
  return Constructor(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, instanceType));
}
function FromFunction3(moduleProperties, parameters, returnType) {
  return Function(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, returnType));
}
function FromIntersect8(moduleProperties, types) {
  return Intersect(FromTypes2(moduleProperties, types));
}
function FromIterator3(moduleProperties, type) {
  return Iterator(FromType2(moduleProperties, type));
}
function FromObject7(moduleProperties, properties) {
  return Object2(globalThis.Object.keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType2(moduleProperties, properties[key]) };
  }, {}));
}
function FromRecord3(moduleProperties, type) {
  const [value, pattern] = [FromType2(moduleProperties, RecordValue2(type)), RecordPattern(type)];
  const result = CloneType(type);
  result.patternProperties[pattern] = value;
  return result;
}
function FromTransform(moduleProperties, transform) {
  return IsRef(transform) ? { ...Dereference(moduleProperties, transform.$ref), [TransformKind]: transform[TransformKind] } : transform;
}
function FromTuple5(moduleProperties, types) {
  return Tuple(FromTypes2(moduleProperties, types));
}
function FromUnion10(moduleProperties, types) {
  return Union(FromTypes2(moduleProperties, types));
}
function FromTypes2(moduleProperties, types) {
  return types.map((type) => FromType2(moduleProperties, type));
}
function FromType2(moduleProperties, type) {
  return IsOptional(type) ? CreateType(FromType2(moduleProperties, Discard(type, [OptionalKind])), type) : IsReadonly(type) ? CreateType(FromType2(moduleProperties, Discard(type, [ReadonlyKind])), type) : IsTransform(type) ? CreateType(FromTransform(moduleProperties, type), type) : IsArray3(type) ? CreateType(FromArray6(moduleProperties, type.items), type) : IsAsyncIterator3(type) ? CreateType(FromAsyncIterator3(moduleProperties, type.items), type) : IsComputed(type) ? CreateType(FromComputed5(moduleProperties, type.target, type.parameters)) : IsConstructor(type) ? CreateType(FromConstructor3(moduleProperties, type.parameters, type.returns), type) : IsFunction3(type) ? CreateType(FromFunction3(moduleProperties, type.parameters, type.returns), type) : IsIntersect(type) ? CreateType(FromIntersect8(moduleProperties, type.allOf), type) : IsIterator3(type) ? CreateType(FromIterator3(moduleProperties, type.items), type) : IsObject3(type) ? CreateType(FromObject7(moduleProperties, type.properties), type) : IsRecord(type) ? CreateType(FromRecord3(moduleProperties, type)) : IsTuple(type) ? CreateType(FromTuple5(moduleProperties, type.items || []), type) : IsUnion(type) ? CreateType(FromUnion10(moduleProperties, type.anyOf), type) : type;
}
function ComputeType(moduleProperties, key) {
  return key in moduleProperties ? FromType2(moduleProperties, moduleProperties[key]) : Never();
}
function ComputeModuleProperties(moduleProperties) {
  return globalThis.Object.getOwnPropertyNames(moduleProperties).reduce((result, key) => {
    return { ...result, [key]: ComputeType(moduleProperties, key) };
  }, {});
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/module/module.mjs
class TModule {
  constructor($defs) {
    const computed = ComputeModuleProperties($defs);
    const identified = this.WithIdentifiers(computed);
    this.$defs = identified;
  }
  Import(key, options) {
    const $defs = { ...this.$defs, [key]: CreateType(this.$defs[key], options) };
    return CreateType({ [Kind]: "Import", $defs, $ref: key });
  }
  WithIdentifiers($defs) {
    return globalThis.Object.getOwnPropertyNames($defs).reduce((result, key) => {
      return { ...result, [key]: { ...$defs[key], $id: key } };
    }, {});
  }
}
function Module(properties) {
  return new TModule(properties);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/not/not.mjs
function Not2(type, options) {
  return CreateType({ [Kind]: "Not", not: type }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/parameters/parameters.mjs
function Parameters(schema, options) {
  return IsFunction3(schema) ? Tuple(schema.parameters, options) : Never();
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/recursive/recursive.mjs
var Ordinal = 0;
function Recursive(callback, options = {}) {
  if (IsUndefined(options.$id))
    options.$id = `T${Ordinal++}`;
  const thisType = CloneType(callback({ [Kind]: "This", $ref: `${options.$id}` }));
  thisType.$id = options.$id;
  return CreateType({ [Hint]: "Recursive", ...thisType }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/regexp/regexp.mjs
function RegExp2(unresolved, options) {
  const expr = IsString(unresolved) ? new globalThis.RegExp(unresolved) : unresolved;
  return CreateType({ [Kind]: "RegExp", type: "RegExp", source: expr.source, flags: expr.flags }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/rest/rest.mjs
function RestResolve(T) {
  return IsIntersect(T) ? T.allOf : IsUnion(T) ? T.anyOf : IsTuple(T) ? T.items ?? [] : [];
}
function Rest(T) {
  return RestResolve(T);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/return-type/return-type.mjs
function ReturnType(schema, options) {
  return IsFunction3(schema) ? CreateType(schema.returns, options) : Never(options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/transform/transform.mjs
class TransformDecodeBuilder {
  constructor(schema) {
    this.schema = schema;
  }
  Decode(decode) {
    return new TransformEncodeBuilder(this.schema, decode);
  }
}

class TransformEncodeBuilder {
  constructor(schema, decode) {
    this.schema = schema;
    this.decode = decode;
  }
  EncodeTransform(encode, schema) {
    const Encode = (value) => schema[TransformKind].Encode(encode(value));
    const Decode = (value) => this.decode(schema[TransformKind].Decode(value));
    const Codec = { Encode, Decode };
    return { ...schema, [TransformKind]: Codec };
  }
  EncodeSchema(encode, schema) {
    const Codec = { Decode: this.decode, Encode: encode };
    return { ...schema, [TransformKind]: Codec };
  }
  Encode(encode) {
    return IsTransform(this.schema) ? this.EncodeTransform(encode, this.schema) : this.EncodeSchema(encode, this.schema);
  }
}
function Transform(schema) {
  return new TransformDecodeBuilder(schema);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/unsafe/unsafe.mjs
function Unsafe(options = {}) {
  return CreateType({ [Kind]: options[Kind] ?? "Unsafe" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/void/void.mjs
function Void(options) {
  return CreateType({ [Kind]: "Void", type: "void" }, options);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/type/type.mjs
var exports_type3 = {};
__export(exports_type3, {
  Void: () => Void,
  Uppercase: () => Uppercase,
  Unsafe: () => Unsafe,
  Unknown: () => Unknown,
  Union: () => Union,
  Undefined: () => Undefined,
  Uncapitalize: () => Uncapitalize,
  Uint8Array: () => Uint8Array2,
  Tuple: () => Tuple,
  Transform: () => Transform,
  TemplateLiteral: () => TemplateLiteral,
  Symbol: () => Symbol2,
  String: () => String2,
  ReturnType: () => ReturnType,
  Rest: () => Rest,
  Required: () => Required,
  RegExp: () => RegExp2,
  Ref: () => Ref,
  Recursive: () => Recursive,
  Record: () => Record,
  ReadonlyOptional: () => ReadonlyOptional,
  Readonly: () => Readonly,
  Promise: () => Promise2,
  Pick: () => Pick,
  Partial: () => Partial,
  Parameters: () => Parameters,
  Optional: () => Optional,
  Omit: () => Omit,
  Object: () => Object2,
  Number: () => Number2,
  Null: () => Null,
  Not: () => Not2,
  Never: () => Never,
  Module: () => Module,
  Mapped: () => Mapped,
  Lowercase: () => Lowercase,
  Literal: () => Literal,
  KeyOf: () => KeyOf,
  Iterator: () => Iterator,
  Intersect: () => Intersect,
  Integer: () => Integer,
  Instantiate: () => Instantiate,
  InstanceType: () => InstanceType,
  Index: () => Index,
  Function: () => Function,
  Extract: () => Extract,
  Extends: () => Extends,
  Exclude: () => Exclude,
  Enum: () => Enum,
  Date: () => Date2,
  ConstructorParameters: () => ConstructorParameters,
  Constructor: () => Constructor,
  Const: () => Const,
  Composite: () => Composite,
  Capitalize: () => Capitalize,
  Boolean: () => Boolean2,
  BigInt: () => BigInt2,
  Awaited: () => Awaited,
  AsyncIterator: () => AsyncIterator,
  Array: () => Array2,
  Argument: () => Argument,
  Any: () => Any
});

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/type/type/index.mjs
var Type = exports_type3;

// ../core/src/config/schema.ts
var PrSettingsSchema = Type.Object({
  required: Type.Boolean({ default: true }),
  draft: Type.Boolean({ default: false }),
  ciRequired: Type.Boolean({ default: true })
}, { additionalProperties: false, default: {} });
var MergeSettingsSchema = Type.Object({
  strategy: Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")], { default: "squash" }),
  deleteBranch: Type.Boolean({ default: true })
}, { additionalProperties: false, default: {} });
var RepoSettingsSchema = Type.Object({
  baseBranch: Type.String({ default: "main", minLength: 1 }),
  pr: PrSettingsSchema,
  merge: MergeSettingsSchema,
  branchPattern: Type.String({ default: "<issue-id>-<slug>", minLength: 1 }),
  worktreePattern: Type.String({ default: "../<repo>-<ISSUE-ID>", minLength: 1 })
}, { additionalProperties: false, default: {} });
var RepoSettingsOverrideSchema = Type.Object({
  baseBranch: Type.Optional(Type.String({ minLength: 1 })),
  pr: Type.Optional(Type.Partial(PrSettingsSchema, { additionalProperties: false })),
  merge: Type.Optional(Type.Partial(MergeSettingsSchema, { additionalProperties: false })),
  branchPattern: Type.Optional(Type.String({ minLength: 1 })),
  worktreePattern: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
var LoopModeSchema = Type.Union([Type.Literal("confirm"), Type.Literal("yolo")], {
  default: "confirm"
});
var LoopModeValueSchema = Type.Union([Type.Literal("confirm"), Type.Literal("yolo")]);
var WorkerModesSchema = Type.Partial(Type.Object({
  plan: LoopModeValueSchema,
  refine: LoopModeValueSchema,
  implement: LoopModeValueSchema,
  review: LoopModeValueSchema
}, { additionalProperties: false }), { additionalProperties: false, default: {} });
var LoopSettingsSchema = Type.Object({
  wipGlobal: Type.Integer({ default: 3, minimum: 1 }),
  wip: Type.Object({
    refine: Type.Integer({ default: 2, minimum: 1 }),
    implement: Type.Integer({ default: 3, minimum: 1 }),
    review: Type.Integer({ default: 2, minimum: 1 }),
    plan: Type.Integer({ default: 1, minimum: 1 })
  }, { additionalProperties: false, default: {} }),
  readyBufferTarget: Type.Integer({ default: 5, minimum: 1 }),
  backpressureThreshold: Type.Integer({ default: 5, minimum: 0 }),
  retryCap: Type.Integer({ default: 2, minimum: 1 }),
  reviewCycleCap: Type.Integer({ default: 2, minimum: 1 }),
  cadenceMinutes: Type.Integer({ default: 5, minimum: 1 }),
  mode: LoopModeSchema,
  workerModes: WorkerModesSchema,
  mergeDetection: Type.Boolean({ default: true }),
  cleanupMergedWorktrees: Type.Boolean({ default: true }),
  stateDir: Type.String({ default: "~/.foreman/state", minLength: 1 })
}, { additionalProperties: false, default: {} });
var IntakeSettingsSchema = Type.Object({
  window: Type.String({ default: "06:00", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
  staleLowDays: Type.Integer({ default: 90, minimum: 1 }),
  batchSize: Type.Integer({ default: 20, minimum: 1 }),
  timezone: Type.String({ default: Intl.DateTimeFormat().resolvedOptions().timeZone, minLength: 1 })
}, { additionalProperties: false, default: {} });
var LinearSettingsSchema = Type.Object({
  apiKeyEnv: Type.String({ default: "LINEAR_API_KEY", minLength: 1 }),
  apiKeyFile: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
    default: null
  }),
  endpoint: Type.String({ default: "https://api.linear.app/graphql", minLength: 1 })
}, { additionalProperties: false, default: {} });
var AgentSettingsSchema = Type.Object({
  maxRuntimeMs: Type.Integer({ default: 7200000, minimum: 60000 }),
  lockTtlMarginMs: Type.Integer({ default: 1800000, minimum: 0 }),
  ompBin: Type.String({ default: "omp", minLength: 1 }),
  approvalMode: Type.Union([Type.Literal("always-ask"), Type.Literal("write"), Type.Literal("yolo")], { default: "yolo" }),
  herdrBin: Type.String({ default: "herdr", minLength: 1 })
}, { additionalProperties: false, default: {} });
var InitiativeBindingSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 })
  }, { additionalProperties: false })
]);
var RepoEntrySchema = Type.Composite([
  Type.Object({
    path: Type.String({ minLength: 1 }),
    team: Type.Optional(Type.String({ minLength: 1 })),
    initiatives: Type.Array(InitiativeBindingSchema, { minItems: 1 })
  }, { additionalProperties: false }),
  RepoSettingsOverrideSchema
], { additionalProperties: false });
var GlobalConfigSchema = Type.Object({
  loop: LoopSettingsSchema,
  intake: IntakeSettingsSchema,
  linear: LinearSettingsSchema,
  agent: AgentSettingsSchema,
  repoDefaults: RepoSettingsSchema,
  repos: Type.Record(Type.String({ minLength: 1 }), RepoEntrySchema, {
    default: {}
  })
}, { additionalProperties: false, default: {} });
// ../core/src/config/load.ts
import { existsSync as existsSync3, readFileSync, realpathSync as realpathSync2 } from "node:fs";
import { homedir } from "node:os";
import { basename as basename2, dirname, join, resolve, sep } from "node:path";
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/errors/function.mjs
function DefaultErrorFunction(error) {
  switch (error.errorType) {
    case ValueErrorType.ArrayContains:
      return "Expected array to contain at least one matching value";
    case ValueErrorType.ArrayMaxContains:
      return `Expected array to contain no more than ${error.schema.maxContains} matching values`;
    case ValueErrorType.ArrayMinContains:
      return `Expected array to contain at least ${error.schema.minContains} matching values`;
    case ValueErrorType.ArrayMaxItems:
      return `Expected array length to be less or equal to ${error.schema.maxItems}`;
    case ValueErrorType.ArrayMinItems:
      return `Expected array length to be greater or equal to ${error.schema.minItems}`;
    case ValueErrorType.ArrayUniqueItems:
      return "Expected array elements to be unique";
    case ValueErrorType.Array:
      return "Expected array";
    case ValueErrorType.AsyncIterator:
      return "Expected AsyncIterator";
    case ValueErrorType.BigIntExclusiveMaximum:
      return `Expected bigint to be less than ${error.schema.exclusiveMaximum}`;
    case ValueErrorType.BigIntExclusiveMinimum:
      return `Expected bigint to be greater than ${error.schema.exclusiveMinimum}`;
    case ValueErrorType.BigIntMaximum:
      return `Expected bigint to be less or equal to ${error.schema.maximum}`;
    case ValueErrorType.BigIntMinimum:
      return `Expected bigint to be greater or equal to ${error.schema.minimum}`;
    case ValueErrorType.BigIntMultipleOf:
      return `Expected bigint to be a multiple of ${error.schema.multipleOf}`;
    case ValueErrorType.BigInt:
      return "Expected bigint";
    case ValueErrorType.Boolean:
      return "Expected boolean";
    case ValueErrorType.DateExclusiveMinimumTimestamp:
      return `Expected Date timestamp to be greater than ${error.schema.exclusiveMinimumTimestamp}`;
    case ValueErrorType.DateExclusiveMaximumTimestamp:
      return `Expected Date timestamp to be less than ${error.schema.exclusiveMaximumTimestamp}`;
    case ValueErrorType.DateMinimumTimestamp:
      return `Expected Date timestamp to be greater or equal to ${error.schema.minimumTimestamp}`;
    case ValueErrorType.DateMaximumTimestamp:
      return `Expected Date timestamp to be less or equal to ${error.schema.maximumTimestamp}`;
    case ValueErrorType.DateMultipleOfTimestamp:
      return `Expected Date timestamp to be a multiple of ${error.schema.multipleOfTimestamp}`;
    case ValueErrorType.Date:
      return "Expected Date";
    case ValueErrorType.Function:
      return "Expected function";
    case ValueErrorType.IntegerExclusiveMaximum:
      return `Expected integer to be less than ${error.schema.exclusiveMaximum}`;
    case ValueErrorType.IntegerExclusiveMinimum:
      return `Expected integer to be greater than ${error.schema.exclusiveMinimum}`;
    case ValueErrorType.IntegerMaximum:
      return `Expected integer to be less or equal to ${error.schema.maximum}`;
    case ValueErrorType.IntegerMinimum:
      return `Expected integer to be greater or equal to ${error.schema.minimum}`;
    case ValueErrorType.IntegerMultipleOf:
      return `Expected integer to be a multiple of ${error.schema.multipleOf}`;
    case ValueErrorType.Integer:
      return "Expected integer";
    case ValueErrorType.IntersectUnevaluatedProperties:
      return "Unexpected property";
    case ValueErrorType.Intersect:
      return "Expected all values to match";
    case ValueErrorType.Iterator:
      return "Expected Iterator";
    case ValueErrorType.Literal:
      return `Expected ${typeof error.schema.const === "string" ? `'${error.schema.const}'` : error.schema.const}`;
    case ValueErrorType.Never:
      return "Never";
    case ValueErrorType.Not:
      return "Value should not match";
    case ValueErrorType.Null:
      return "Expected null";
    case ValueErrorType.NumberExclusiveMaximum:
      return `Expected number to be less than ${error.schema.exclusiveMaximum}`;
    case ValueErrorType.NumberExclusiveMinimum:
      return `Expected number to be greater than ${error.schema.exclusiveMinimum}`;
    case ValueErrorType.NumberMaximum:
      return `Expected number to be less or equal to ${error.schema.maximum}`;
    case ValueErrorType.NumberMinimum:
      return `Expected number to be greater or equal to ${error.schema.minimum}`;
    case ValueErrorType.NumberMultipleOf:
      return `Expected number to be a multiple of ${error.schema.multipleOf}`;
    case ValueErrorType.Number:
      return "Expected number";
    case ValueErrorType.Object:
      return "Expected object";
    case ValueErrorType.ObjectAdditionalProperties:
      return "Unexpected property";
    case ValueErrorType.ObjectMaxProperties:
      return `Expected object to have no more than ${error.schema.maxProperties} properties`;
    case ValueErrorType.ObjectMinProperties:
      return `Expected object to have at least ${error.schema.minProperties} properties`;
    case ValueErrorType.ObjectRequiredProperty:
      return "Expected required property";
    case ValueErrorType.Promise:
      return "Expected Promise";
    case ValueErrorType.RegExp:
      return "Expected string to match regular expression";
    case ValueErrorType.StringFormatUnknown:
      return `Unknown format '${error.schema.format}'`;
    case ValueErrorType.StringFormat:
      return `Expected string to match '${error.schema.format}' format`;
    case ValueErrorType.StringMaxLength:
      return `Expected string length less or equal to ${error.schema.maxLength}`;
    case ValueErrorType.StringMinLength:
      return `Expected string length greater or equal to ${error.schema.minLength}`;
    case ValueErrorType.StringPattern:
      return `Expected string to match '${error.schema.pattern}'`;
    case ValueErrorType.String:
      return "Expected string";
    case ValueErrorType.Symbol:
      return "Expected symbol";
    case ValueErrorType.TupleLength:
      return `Expected tuple to have ${error.schema.maxItems || 0} elements`;
    case ValueErrorType.Tuple:
      return "Expected tuple";
    case ValueErrorType.Uint8ArrayMaxByteLength:
      return `Expected byte length less or equal to ${error.schema.maxByteLength}`;
    case ValueErrorType.Uint8ArrayMinByteLength:
      return `Expected byte length greater or equal to ${error.schema.minByteLength}`;
    case ValueErrorType.Uint8Array:
      return "Expected Uint8Array";
    case ValueErrorType.Undefined:
      return "Expected undefined";
    case ValueErrorType.Union:
      return "Expected union value";
    case ValueErrorType.Void:
      return "Expected void";
    case ValueErrorType.Kind:
      return `Expected kind '${error.schema[Kind]}'`;
    default:
      return "Unknown error type";
  }
}
var errorFunction = DefaultErrorFunction;
function GetErrorFunction() {
  return errorFunction;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/deref/deref.mjs
class TypeDereferenceError extends TypeBoxError {
  constructor(schema) {
    super(`Unable to dereference schema with $id '${schema.$ref}'`);
    this.schema = schema;
  }
}
function Resolve(schema, references) {
  const target = references.find((target2) => target2.$id === schema.$ref);
  if (target === undefined)
    throw new TypeDereferenceError(schema);
  return Deref(target, references);
}
function Pushref(schema, references) {
  if (!IsString2(schema.$id) || references.some((target) => target.$id === schema.$id))
    return references;
  references.push(schema);
  return references;
}
function Deref(schema, references) {
  return schema[Kind] === "This" || schema[Kind] === "Ref" ? Resolve(schema, references) : schema;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/hash/hash.mjs
class ValueHashError extends TypeBoxError {
  constructor(value) {
    super(`Unable to hash value`);
    this.value = value;
  }
}
var ByteMarker;
(function(ByteMarker2) {
  ByteMarker2[ByteMarker2["Undefined"] = 0] = "Undefined";
  ByteMarker2[ByteMarker2["Null"] = 1] = "Null";
  ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
  ByteMarker2[ByteMarker2["Number"] = 3] = "Number";
  ByteMarker2[ByteMarker2["String"] = 4] = "String";
  ByteMarker2[ByteMarker2["Object"] = 5] = "Object";
  ByteMarker2[ByteMarker2["Array"] = 6] = "Array";
  ByteMarker2[ByteMarker2["Date"] = 7] = "Date";
  ByteMarker2[ByteMarker2["Uint8Array"] = 8] = "Uint8Array";
  ByteMarker2[ByteMarker2["Symbol"] = 9] = "Symbol";
  ByteMarker2[ByteMarker2["BigInt"] = 10] = "BigInt";
})(ByteMarker || (ByteMarker = {}));
var Accumulator = BigInt("14695981039346656037");
var [Prime, Size] = [BigInt("1099511628211"), BigInt("18446744073709551616")];
var Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
var F64 = new Float64Array(1);
var F64In = new DataView(F64.buffer);
var F64Out = new Uint8Array(F64.buffer);
function* NumberToBytes(value) {
  const byteCount = value === 0 ? 1 : Math.ceil(Math.floor(Math.log2(value) + 1) / 8);
  for (let i = 0;i < byteCount; i++) {
    yield value >> 8 * (byteCount - 1 - i) & 255;
  }
}
function ArrayType2(value) {
  FNV1A64(ByteMarker.Array);
  for (const item of value) {
    Visit4(item);
  }
}
function BooleanType(value) {
  FNV1A64(ByteMarker.Boolean);
  FNV1A64(value ? 1 : 0);
}
function BigIntType(value) {
  FNV1A64(ByteMarker.BigInt);
  F64In.setBigInt64(0, value);
  for (const byte of F64Out) {
    FNV1A64(byte);
  }
}
function DateType2(value) {
  FNV1A64(ByteMarker.Date);
  Visit4(value.getTime());
}
function NullType(value) {
  FNV1A64(ByteMarker.Null);
}
function NumberType(value) {
  FNV1A64(ByteMarker.Number);
  F64In.setFloat64(0, value);
  for (const byte of F64Out) {
    FNV1A64(byte);
  }
}
function ObjectType2(value) {
  FNV1A64(ByteMarker.Object);
  for (const key of globalThis.Object.getOwnPropertyNames(value).sort()) {
    Visit4(key);
    Visit4(value[key]);
  }
}
function StringType(value) {
  FNV1A64(ByteMarker.String);
  for (let i = 0;i < value.length; i++) {
    for (const byte of NumberToBytes(value.charCodeAt(i))) {
      FNV1A64(byte);
    }
  }
}
function SymbolType(value) {
  FNV1A64(ByteMarker.Symbol);
  Visit4(value.description);
}
function Uint8ArrayType2(value) {
  FNV1A64(ByteMarker.Uint8Array);
  for (let i = 0;i < value.length; i++) {
    FNV1A64(value[i]);
  }
}
function UndefinedType(value) {
  return FNV1A64(ByteMarker.Undefined);
}
function Visit4(value) {
  if (IsArray2(value))
    return ArrayType2(value);
  if (IsBoolean2(value))
    return BooleanType(value);
  if (IsBigInt2(value))
    return BigIntType(value);
  if (IsDate2(value))
    return DateType2(value);
  if (IsNull2(value))
    return NullType(value);
  if (IsNumber2(value))
    return NumberType(value);
  if (IsObject2(value))
    return ObjectType2(value);
  if (IsString2(value))
    return StringType(value);
  if (IsSymbol2(value))
    return SymbolType(value);
  if (IsUint8Array2(value))
    return Uint8ArrayType2(value);
  if (IsUndefined2(value))
    return UndefinedType(value);
  throw new ValueHashError(value);
}
function FNV1A64(byte) {
  Accumulator = Accumulator ^ Bytes[byte];
  Accumulator = Accumulator * Prime % Size;
}
function Hash(value) {
  Accumulator = BigInt("14695981039346656037");
  Visit4(value);
  return Accumulator;
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/check/check.mjs
class ValueCheckUnknownTypeError extends TypeBoxError {
  constructor(schema) {
    super(`Unknown type`);
    this.schema = schema;
  }
}
function IsAnyOrUnknown(schema) {
  return schema[Kind] === "Any" || schema[Kind] === "Unknown";
}
function IsDefined(value) {
  return value !== undefined;
}
function FromAny2(schema, references, value) {
  return true;
}
function FromArgument2(schema, references, value) {
  return true;
}
function FromArray7(schema, references, value) {
  if (!IsArray2(value))
    return false;
  if (IsDefined(schema.minItems) && !(value.length >= schema.minItems)) {
    return false;
  }
  if (IsDefined(schema.maxItems) && !(value.length <= schema.maxItems)) {
    return false;
  }
  for (const element of value) {
    if (!Visit5(schema.items, references, element))
      return false;
  }
  if (schema.uniqueItems === true && !function() {
    const set = new Set;
    for (const element of value) {
      const hashed = Hash(element);
      if (set.has(hashed)) {
        return false;
      } else {
        set.add(hashed);
      }
    }
    return true;
  }()) {
    return false;
  }
  if (!(IsDefined(schema.contains) || IsNumber2(schema.minContains) || IsNumber2(schema.maxContains))) {
    return true;
  }
  const containsSchema = IsDefined(schema.contains) ? schema.contains : Never();
  const containsCount = value.reduce((acc, value2) => Visit5(containsSchema, references, value2) ? acc + 1 : acc, 0);
  if (containsCount === 0) {
    return false;
  }
  if (IsNumber2(schema.minContains) && containsCount < schema.minContains) {
    return false;
  }
  if (IsNumber2(schema.maxContains) && containsCount > schema.maxContains) {
    return false;
  }
  return true;
}
function FromAsyncIterator4(schema, references, value) {
  return IsAsyncIterator2(value);
}
function FromBigInt2(schema, references, value) {
  if (!IsBigInt2(value))
    return false;
  if (IsDefined(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    return false;
  }
  if (IsDefined(schema.maximum) && !(value <= schema.maximum)) {
    return false;
  }
  if (IsDefined(schema.minimum) && !(value >= schema.minimum)) {
    return false;
  }
  if (IsDefined(schema.multipleOf) && !(value % schema.multipleOf === BigInt(0))) {
    return false;
  }
  return true;
}
function FromBoolean2(schema, references, value) {
  return IsBoolean2(value);
}
function FromConstructor4(schema, references, value) {
  return Visit5(schema.returns, references, value.prototype);
}
function FromDate2(schema, references, value) {
  if (!IsDate2(value))
    return false;
  if (IsDefined(schema.exclusiveMaximumTimestamp) && !(value.getTime() < schema.exclusiveMaximumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimumTimestamp) && !(value.getTime() > schema.exclusiveMinimumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.maximumTimestamp) && !(value.getTime() <= schema.maximumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.minimumTimestamp) && !(value.getTime() >= schema.minimumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.multipleOfTimestamp) && !(value.getTime() % schema.multipleOfTimestamp === 0)) {
    return false;
  }
  return true;
}
function FromFunction4(schema, references, value) {
  return IsFunction2(value);
}
function FromImport(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit5(target, [...references, ...definitions], value);
}
function FromInteger2(schema, references, value) {
  if (!IsInteger(value)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    return false;
  }
  if (IsDefined(schema.maximum) && !(value <= schema.maximum)) {
    return false;
  }
  if (IsDefined(schema.minimum) && !(value >= schema.minimum)) {
    return false;
  }
  if (IsDefined(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    return false;
  }
  return true;
}
function FromIntersect9(schema, references, value) {
  const check1 = schema.allOf.every((schema2) => Visit5(schema2, references, value));
  if (schema.unevaluatedProperties === false) {
    const keyPattern = new RegExp(KeyOfPattern(schema));
    const check2 = Object.getOwnPropertyNames(value).every((key) => keyPattern.test(key));
    return check1 && check2;
  } else if (IsSchema(schema.unevaluatedProperties)) {
    const keyCheck = new RegExp(KeyOfPattern(schema));
    const check2 = Object.getOwnPropertyNames(value).every((key) => keyCheck.test(key) || Visit5(schema.unevaluatedProperties, references, value[key]));
    return check1 && check2;
  } else {
    return check1;
  }
}
function FromIterator4(schema, references, value) {
  return IsIterator2(value);
}
function FromLiteral3(schema, references, value) {
  return value === schema.const;
}
function FromNever2(schema, references, value) {
  return false;
}
function FromNot2(schema, references, value) {
  return !Visit5(schema.not, references, value);
}
function FromNull2(schema, references, value) {
  return IsNull2(value);
}
function FromNumber2(schema, references, value) {
  if (!TypeSystemPolicy.IsNumberLike(value))
    return false;
  if (IsDefined(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    return false;
  }
  if (IsDefined(schema.minimum) && !(value >= schema.minimum)) {
    return false;
  }
  if (IsDefined(schema.maximum) && !(value <= schema.maximum)) {
    return false;
  }
  if (IsDefined(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    return false;
  }
  return true;
}
function FromObject8(schema, references, value) {
  if (!TypeSystemPolicy.IsObjectLike(value))
    return false;
  if (IsDefined(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    return false;
  }
  if (IsDefined(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    return false;
  }
  const knownKeys = Object.getOwnPropertyNames(schema.properties);
  for (const knownKey of knownKeys) {
    const property = schema.properties[knownKey];
    if (schema.required && schema.required.includes(knownKey)) {
      if (!Visit5(property, references, value[knownKey])) {
        return false;
      }
      if ((ExtendsUndefinedCheck(property) || IsAnyOrUnknown(property)) && !(knownKey in value)) {
        return false;
      }
    } else {
      if (TypeSystemPolicy.IsExactOptionalProperty(value, knownKey) && !Visit5(property, references, value[knownKey])) {
        return false;
      }
    }
  }
  if (schema.additionalProperties === false) {
    const valueKeys = Object.getOwnPropertyNames(value);
    if (schema.required && schema.required.length === knownKeys.length && valueKeys.length === knownKeys.length) {
      return true;
    } else {
      return valueKeys.every((valueKey) => knownKeys.includes(valueKey));
    }
  } else if (typeof schema.additionalProperties === "object") {
    const valueKeys = Object.getOwnPropertyNames(value);
    return valueKeys.every((key) => knownKeys.includes(key) || Visit5(schema.additionalProperties, references, value[key]));
  } else {
    return true;
  }
}
function FromPromise4(schema, references, value) {
  return IsPromise(value);
}
function FromRecord4(schema, references, value) {
  if (!TypeSystemPolicy.IsRecordLike(value)) {
    return false;
  }
  if (IsDefined(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    return false;
  }
  if (IsDefined(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    return false;
  }
  const [patternKey, patternSchema] = Object.entries(schema.patternProperties)[0];
  const regex = new RegExp(patternKey);
  const check1 = Object.entries(value).every(([key, value2]) => {
    return regex.test(key) ? Visit5(patternSchema, references, value2) : true;
  });
  const check2 = typeof schema.additionalProperties === "object" ? Object.entries(value).every(([key, value2]) => {
    return !regex.test(key) ? Visit5(schema.additionalProperties, references, value2) : true;
  }) : true;
  const check3 = schema.additionalProperties === false ? Object.getOwnPropertyNames(value).every((key) => {
    return regex.test(key);
  }) : true;
  return check1 && check2 && check3;
}
function FromRef5(schema, references, value) {
  return Visit5(Deref(schema, references), references, value);
}
function FromRegExp2(schema, references, value) {
  const regex = new RegExp(schema.source, schema.flags);
  if (IsDefined(schema.minLength)) {
    if (!(value.length >= schema.minLength))
      return false;
  }
  if (IsDefined(schema.maxLength)) {
    if (!(value.length <= schema.maxLength))
      return false;
  }
  return regex.test(value);
}
function FromString2(schema, references, value) {
  if (!IsString2(value)) {
    return false;
  }
  if (IsDefined(schema.minLength)) {
    if (!(value.length >= schema.minLength))
      return false;
  }
  if (IsDefined(schema.maxLength)) {
    if (!(value.length <= schema.maxLength))
      return false;
  }
  if (IsDefined(schema.pattern)) {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value))
      return false;
  }
  if (IsDefined(schema.format)) {
    if (!exports_format.Has(schema.format))
      return false;
    const func = exports_format.Get(schema.format);
    return func(value);
  }
  return true;
}
function FromSymbol2(schema, references, value) {
  return IsSymbol2(value);
}
function FromTemplateLiteral4(schema, references, value) {
  return IsString2(value) && new RegExp(schema.pattern).test(value);
}
function FromThis(schema, references, value) {
  return Visit5(Deref(schema, references), references, value);
}
function FromTuple6(schema, references, value) {
  if (!IsArray2(value)) {
    return false;
  }
  if (schema.items === undefined && !(value.length === 0)) {
    return false;
  }
  if (!(value.length === schema.maxItems)) {
    return false;
  }
  if (!schema.items) {
    return true;
  }
  for (let i = 0;i < schema.items.length; i++) {
    if (!Visit5(schema.items[i], references, value[i]))
      return false;
  }
  return true;
}
function FromUndefined2(schema, references, value) {
  return IsUndefined2(value);
}
function FromUnion11(schema, references, value) {
  return schema.anyOf.some((inner) => Visit5(inner, references, value));
}
function FromUint8Array2(schema, references, value) {
  if (!IsUint8Array2(value)) {
    return false;
  }
  if (IsDefined(schema.maxByteLength) && !(value.length <= schema.maxByteLength)) {
    return false;
  }
  if (IsDefined(schema.minByteLength) && !(value.length >= schema.minByteLength)) {
    return false;
  }
  return true;
}
function FromUnknown2(schema, references, value) {
  return true;
}
function FromVoid2(schema, references, value) {
  return TypeSystemPolicy.IsVoidLike(value);
}
function FromKind(schema, references, value) {
  if (!exports_type2.Has(schema[Kind]))
    return false;
  const func = exports_type2.Get(schema[Kind]);
  return func(schema, value);
}
function Visit5(schema, references, value) {
  const references_ = IsDefined(schema.$id) ? Pushref(schema, references) : references;
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Any":
      return FromAny2(schema_, references_, value);
    case "Argument":
      return FromArgument2(schema_, references_, value);
    case "Array":
      return FromArray7(schema_, references_, value);
    case "AsyncIterator":
      return FromAsyncIterator4(schema_, references_, value);
    case "BigInt":
      return FromBigInt2(schema_, references_, value);
    case "Boolean":
      return FromBoolean2(schema_, references_, value);
    case "Constructor":
      return FromConstructor4(schema_, references_, value);
    case "Date":
      return FromDate2(schema_, references_, value);
    case "Function":
      return FromFunction4(schema_, references_, value);
    case "Import":
      return FromImport(schema_, references_, value);
    case "Integer":
      return FromInteger2(schema_, references_, value);
    case "Intersect":
      return FromIntersect9(schema_, references_, value);
    case "Iterator":
      return FromIterator4(schema_, references_, value);
    case "Literal":
      return FromLiteral3(schema_, references_, value);
    case "Never":
      return FromNever2(schema_, references_, value);
    case "Not":
      return FromNot2(schema_, references_, value);
    case "Null":
      return FromNull2(schema_, references_, value);
    case "Number":
      return FromNumber2(schema_, references_, value);
    case "Object":
      return FromObject8(schema_, references_, value);
    case "Promise":
      return FromPromise4(schema_, references_, value);
    case "Record":
      return FromRecord4(schema_, references_, value);
    case "Ref":
      return FromRef5(schema_, references_, value);
    case "RegExp":
      return FromRegExp2(schema_, references_, value);
    case "String":
      return FromString2(schema_, references_, value);
    case "Symbol":
      return FromSymbol2(schema_, references_, value);
    case "TemplateLiteral":
      return FromTemplateLiteral4(schema_, references_, value);
    case "This":
      return FromThis(schema_, references_, value);
    case "Tuple":
      return FromTuple6(schema_, references_, value);
    case "Undefined":
      return FromUndefined2(schema_, references_, value);
    case "Union":
      return FromUnion11(schema_, references_, value);
    case "Uint8Array":
      return FromUint8Array2(schema_, references_, value);
    case "Unknown":
      return FromUnknown2(schema_, references_, value);
    case "Void":
      return FromVoid2(schema_, references_, value);
    default:
      if (!exports_type2.Has(schema_[Kind]))
        throw new ValueCheckUnknownTypeError(schema_);
      return FromKind(schema_, references_, value);
  }
}
function Check(...args) {
  return args.length === 3 ? Visit5(args[0], args[1], args[2]) : Visit5(args[0], [], args[1]);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/errors/errors.mjs
var ValueErrorType;
(function(ValueErrorType2) {
  ValueErrorType2[ValueErrorType2["ArrayContains"] = 0] = "ArrayContains";
  ValueErrorType2[ValueErrorType2["ArrayMaxContains"] = 1] = "ArrayMaxContains";
  ValueErrorType2[ValueErrorType2["ArrayMaxItems"] = 2] = "ArrayMaxItems";
  ValueErrorType2[ValueErrorType2["ArrayMinContains"] = 3] = "ArrayMinContains";
  ValueErrorType2[ValueErrorType2["ArrayMinItems"] = 4] = "ArrayMinItems";
  ValueErrorType2[ValueErrorType2["ArrayUniqueItems"] = 5] = "ArrayUniqueItems";
  ValueErrorType2[ValueErrorType2["Array"] = 6] = "Array";
  ValueErrorType2[ValueErrorType2["AsyncIterator"] = 7] = "AsyncIterator";
  ValueErrorType2[ValueErrorType2["BigIntExclusiveMaximum"] = 8] = "BigIntExclusiveMaximum";
  ValueErrorType2[ValueErrorType2["BigIntExclusiveMinimum"] = 9] = "BigIntExclusiveMinimum";
  ValueErrorType2[ValueErrorType2["BigIntMaximum"] = 10] = "BigIntMaximum";
  ValueErrorType2[ValueErrorType2["BigIntMinimum"] = 11] = "BigIntMinimum";
  ValueErrorType2[ValueErrorType2["BigIntMultipleOf"] = 12] = "BigIntMultipleOf";
  ValueErrorType2[ValueErrorType2["BigInt"] = 13] = "BigInt";
  ValueErrorType2[ValueErrorType2["Boolean"] = 14] = "Boolean";
  ValueErrorType2[ValueErrorType2["DateExclusiveMaximumTimestamp"] = 15] = "DateExclusiveMaximumTimestamp";
  ValueErrorType2[ValueErrorType2["DateExclusiveMinimumTimestamp"] = 16] = "DateExclusiveMinimumTimestamp";
  ValueErrorType2[ValueErrorType2["DateMaximumTimestamp"] = 17] = "DateMaximumTimestamp";
  ValueErrorType2[ValueErrorType2["DateMinimumTimestamp"] = 18] = "DateMinimumTimestamp";
  ValueErrorType2[ValueErrorType2["DateMultipleOfTimestamp"] = 19] = "DateMultipleOfTimestamp";
  ValueErrorType2[ValueErrorType2["Date"] = 20] = "Date";
  ValueErrorType2[ValueErrorType2["Function"] = 21] = "Function";
  ValueErrorType2[ValueErrorType2["IntegerExclusiveMaximum"] = 22] = "IntegerExclusiveMaximum";
  ValueErrorType2[ValueErrorType2["IntegerExclusiveMinimum"] = 23] = "IntegerExclusiveMinimum";
  ValueErrorType2[ValueErrorType2["IntegerMaximum"] = 24] = "IntegerMaximum";
  ValueErrorType2[ValueErrorType2["IntegerMinimum"] = 25] = "IntegerMinimum";
  ValueErrorType2[ValueErrorType2["IntegerMultipleOf"] = 26] = "IntegerMultipleOf";
  ValueErrorType2[ValueErrorType2["Integer"] = 27] = "Integer";
  ValueErrorType2[ValueErrorType2["IntersectUnevaluatedProperties"] = 28] = "IntersectUnevaluatedProperties";
  ValueErrorType2[ValueErrorType2["Intersect"] = 29] = "Intersect";
  ValueErrorType2[ValueErrorType2["Iterator"] = 30] = "Iterator";
  ValueErrorType2[ValueErrorType2["Kind"] = 31] = "Kind";
  ValueErrorType2[ValueErrorType2["Literal"] = 32] = "Literal";
  ValueErrorType2[ValueErrorType2["Never"] = 33] = "Never";
  ValueErrorType2[ValueErrorType2["Not"] = 34] = "Not";
  ValueErrorType2[ValueErrorType2["Null"] = 35] = "Null";
  ValueErrorType2[ValueErrorType2["NumberExclusiveMaximum"] = 36] = "NumberExclusiveMaximum";
  ValueErrorType2[ValueErrorType2["NumberExclusiveMinimum"] = 37] = "NumberExclusiveMinimum";
  ValueErrorType2[ValueErrorType2["NumberMaximum"] = 38] = "NumberMaximum";
  ValueErrorType2[ValueErrorType2["NumberMinimum"] = 39] = "NumberMinimum";
  ValueErrorType2[ValueErrorType2["NumberMultipleOf"] = 40] = "NumberMultipleOf";
  ValueErrorType2[ValueErrorType2["Number"] = 41] = "Number";
  ValueErrorType2[ValueErrorType2["ObjectAdditionalProperties"] = 42] = "ObjectAdditionalProperties";
  ValueErrorType2[ValueErrorType2["ObjectMaxProperties"] = 43] = "ObjectMaxProperties";
  ValueErrorType2[ValueErrorType2["ObjectMinProperties"] = 44] = "ObjectMinProperties";
  ValueErrorType2[ValueErrorType2["ObjectRequiredProperty"] = 45] = "ObjectRequiredProperty";
  ValueErrorType2[ValueErrorType2["Object"] = 46] = "Object";
  ValueErrorType2[ValueErrorType2["Promise"] = 47] = "Promise";
  ValueErrorType2[ValueErrorType2["RegExp"] = 48] = "RegExp";
  ValueErrorType2[ValueErrorType2["StringFormatUnknown"] = 49] = "StringFormatUnknown";
  ValueErrorType2[ValueErrorType2["StringFormat"] = 50] = "StringFormat";
  ValueErrorType2[ValueErrorType2["StringMaxLength"] = 51] = "StringMaxLength";
  ValueErrorType2[ValueErrorType2["StringMinLength"] = 52] = "StringMinLength";
  ValueErrorType2[ValueErrorType2["StringPattern"] = 53] = "StringPattern";
  ValueErrorType2[ValueErrorType2["String"] = 54] = "String";
  ValueErrorType2[ValueErrorType2["Symbol"] = 55] = "Symbol";
  ValueErrorType2[ValueErrorType2["TupleLength"] = 56] = "TupleLength";
  ValueErrorType2[ValueErrorType2["Tuple"] = 57] = "Tuple";
  ValueErrorType2[ValueErrorType2["Uint8ArrayMaxByteLength"] = 58] = "Uint8ArrayMaxByteLength";
  ValueErrorType2[ValueErrorType2["Uint8ArrayMinByteLength"] = 59] = "Uint8ArrayMinByteLength";
  ValueErrorType2[ValueErrorType2["Uint8Array"] = 60] = "Uint8Array";
  ValueErrorType2[ValueErrorType2["Undefined"] = 61] = "Undefined";
  ValueErrorType2[ValueErrorType2["Union"] = 62] = "Union";
  ValueErrorType2[ValueErrorType2["Void"] = 63] = "Void";
})(ValueErrorType || (ValueErrorType = {}));

class ValueErrorsUnknownTypeError extends TypeBoxError {
  constructor(schema) {
    super("Unknown type");
    this.schema = schema;
  }
}
function EscapeKey(key) {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}
function IsDefined2(value) {
  return value !== undefined;
}

class ValueErrorIterator {
  constructor(iterator) {
    this.iterator = iterator;
  }
  [Symbol.iterator]() {
    return this.iterator;
  }
  First() {
    const next = this.iterator.next();
    return next.done ? undefined : next.value;
  }
}
function Create(errorType, schema, path, value, errors = []) {
  return {
    type: errorType,
    schema,
    path,
    value,
    message: GetErrorFunction()({ errorType, path, schema, value, errors }),
    errors
  };
}
function* FromAny3(schema, references, path, value) {}
function* FromArgument3(schema, references, path, value) {}
function* FromArray8(schema, references, path, value) {
  if (!IsArray2(value)) {
    return yield Create(ValueErrorType.Array, schema, path, value);
  }
  if (IsDefined2(schema.minItems) && !(value.length >= schema.minItems)) {
    yield Create(ValueErrorType.ArrayMinItems, schema, path, value);
  }
  if (IsDefined2(schema.maxItems) && !(value.length <= schema.maxItems)) {
    yield Create(ValueErrorType.ArrayMaxItems, schema, path, value);
  }
  for (let i = 0;i < value.length; i++) {
    yield* Visit6(schema.items, references, `${path}/${i}`, value[i]);
  }
  if (schema.uniqueItems === true && !function() {
    const set = new Set;
    for (const element of value) {
      const hashed = Hash(element);
      if (set.has(hashed)) {
        return false;
      } else {
        set.add(hashed);
      }
    }
    return true;
  }()) {
    yield Create(ValueErrorType.ArrayUniqueItems, schema, path, value);
  }
  if (!(IsDefined2(schema.contains) || IsDefined2(schema.minContains) || IsDefined2(schema.maxContains))) {
    return;
  }
  const containsSchema = IsDefined2(schema.contains) ? schema.contains : Never();
  const containsCount = value.reduce((acc, value2, index) => Visit6(containsSchema, references, `${path}${index}`, value2).next().done === true ? acc + 1 : acc, 0);
  if (containsCount === 0) {
    yield Create(ValueErrorType.ArrayContains, schema, path, value);
  }
  if (IsNumber2(schema.minContains) && containsCount < schema.minContains) {
    yield Create(ValueErrorType.ArrayMinContains, schema, path, value);
  }
  if (IsNumber2(schema.maxContains) && containsCount > schema.maxContains) {
    yield Create(ValueErrorType.ArrayMaxContains, schema, path, value);
  }
}
function* FromAsyncIterator5(schema, references, path, value) {
  if (!IsAsyncIterator2(value))
    yield Create(ValueErrorType.AsyncIterator, schema, path, value);
}
function* FromBigInt3(schema, references, path, value) {
  if (!IsBigInt2(value))
    return yield Create(ValueErrorType.BigInt, schema, path, value);
  if (IsDefined2(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    yield Create(ValueErrorType.BigIntExclusiveMaximum, schema, path, value);
  }
  if (IsDefined2(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    yield Create(ValueErrorType.BigIntExclusiveMinimum, schema, path, value);
  }
  if (IsDefined2(schema.maximum) && !(value <= schema.maximum)) {
    yield Create(ValueErrorType.BigIntMaximum, schema, path, value);
  }
  if (IsDefined2(schema.minimum) && !(value >= schema.minimum)) {
    yield Create(ValueErrorType.BigIntMinimum, schema, path, value);
  }
  if (IsDefined2(schema.multipleOf) && !(value % schema.multipleOf === BigInt(0))) {
    yield Create(ValueErrorType.BigIntMultipleOf, schema, path, value);
  }
}
function* FromBoolean3(schema, references, path, value) {
  if (!IsBoolean2(value))
    yield Create(ValueErrorType.Boolean, schema, path, value);
}
function* FromConstructor5(schema, references, path, value) {
  yield* Visit6(schema.returns, references, path, value.prototype);
}
function* FromDate3(schema, references, path, value) {
  if (!IsDate2(value))
    return yield Create(ValueErrorType.Date, schema, path, value);
  if (IsDefined2(schema.exclusiveMaximumTimestamp) && !(value.getTime() < schema.exclusiveMaximumTimestamp)) {
    yield Create(ValueErrorType.DateExclusiveMaximumTimestamp, schema, path, value);
  }
  if (IsDefined2(schema.exclusiveMinimumTimestamp) && !(value.getTime() > schema.exclusiveMinimumTimestamp)) {
    yield Create(ValueErrorType.DateExclusiveMinimumTimestamp, schema, path, value);
  }
  if (IsDefined2(schema.maximumTimestamp) && !(value.getTime() <= schema.maximumTimestamp)) {
    yield Create(ValueErrorType.DateMaximumTimestamp, schema, path, value);
  }
  if (IsDefined2(schema.minimumTimestamp) && !(value.getTime() >= schema.minimumTimestamp)) {
    yield Create(ValueErrorType.DateMinimumTimestamp, schema, path, value);
  }
  if (IsDefined2(schema.multipleOfTimestamp) && !(value.getTime() % schema.multipleOfTimestamp === 0)) {
    yield Create(ValueErrorType.DateMultipleOfTimestamp, schema, path, value);
  }
}
function* FromFunction5(schema, references, path, value) {
  if (!IsFunction2(value))
    yield Create(ValueErrorType.Function, schema, path, value);
}
function* FromImport2(schema, references, path, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  yield* Visit6(target, [...references, ...definitions], path, value);
}
function* FromInteger3(schema, references, path, value) {
  if (!IsInteger(value))
    return yield Create(ValueErrorType.Integer, schema, path, value);
  if (IsDefined2(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    yield Create(ValueErrorType.IntegerExclusiveMaximum, schema, path, value);
  }
  if (IsDefined2(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    yield Create(ValueErrorType.IntegerExclusiveMinimum, schema, path, value);
  }
  if (IsDefined2(schema.maximum) && !(value <= schema.maximum)) {
    yield Create(ValueErrorType.IntegerMaximum, schema, path, value);
  }
  if (IsDefined2(schema.minimum) && !(value >= schema.minimum)) {
    yield Create(ValueErrorType.IntegerMinimum, schema, path, value);
  }
  if (IsDefined2(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    yield Create(ValueErrorType.IntegerMultipleOf, schema, path, value);
  }
}
function* FromIntersect10(schema, references, path, value) {
  let hasError = false;
  for (const inner of schema.allOf) {
    for (const error of Visit6(inner, references, path, value)) {
      hasError = true;
      yield error;
    }
  }
  if (hasError) {
    return yield Create(ValueErrorType.Intersect, schema, path, value);
  }
  if (schema.unevaluatedProperties === false) {
    const keyCheck = new RegExp(KeyOfPattern(schema));
    for (const valueKey of Object.getOwnPropertyNames(value)) {
      if (!keyCheck.test(valueKey)) {
        yield Create(ValueErrorType.IntersectUnevaluatedProperties, schema, `${path}/${valueKey}`, value);
      }
    }
  }
  if (typeof schema.unevaluatedProperties === "object") {
    const keyCheck = new RegExp(KeyOfPattern(schema));
    for (const valueKey of Object.getOwnPropertyNames(value)) {
      if (!keyCheck.test(valueKey)) {
        const next = Visit6(schema.unevaluatedProperties, references, `${path}/${valueKey}`, value[valueKey]).next();
        if (!next.done)
          yield next.value;
      }
    }
  }
}
function* FromIterator5(schema, references, path, value) {
  if (!IsIterator2(value))
    yield Create(ValueErrorType.Iterator, schema, path, value);
}
function* FromLiteral4(schema, references, path, value) {
  if (!(value === schema.const))
    yield Create(ValueErrorType.Literal, schema, path, value);
}
function* FromNever3(schema, references, path, value) {
  yield Create(ValueErrorType.Never, schema, path, value);
}
function* FromNot3(schema, references, path, value) {
  if (Visit6(schema.not, references, path, value).next().done === true)
    yield Create(ValueErrorType.Not, schema, path, value);
}
function* FromNull3(schema, references, path, value) {
  if (!IsNull2(value))
    yield Create(ValueErrorType.Null, schema, path, value);
}
function* FromNumber3(schema, references, path, value) {
  if (!TypeSystemPolicy.IsNumberLike(value))
    return yield Create(ValueErrorType.Number, schema, path, value);
  if (IsDefined2(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    yield Create(ValueErrorType.NumberExclusiveMaximum, schema, path, value);
  }
  if (IsDefined2(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    yield Create(ValueErrorType.NumberExclusiveMinimum, schema, path, value);
  }
  if (IsDefined2(schema.maximum) && !(value <= schema.maximum)) {
    yield Create(ValueErrorType.NumberMaximum, schema, path, value);
  }
  if (IsDefined2(schema.minimum) && !(value >= schema.minimum)) {
    yield Create(ValueErrorType.NumberMinimum, schema, path, value);
  }
  if (IsDefined2(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    yield Create(ValueErrorType.NumberMultipleOf, schema, path, value);
  }
}
function* FromObject9(schema, references, path, value) {
  if (!TypeSystemPolicy.IsObjectLike(value))
    return yield Create(ValueErrorType.Object, schema, path, value);
  if (IsDefined2(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    yield Create(ValueErrorType.ObjectMinProperties, schema, path, value);
  }
  if (IsDefined2(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    yield Create(ValueErrorType.ObjectMaxProperties, schema, path, value);
  }
  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  const knownKeys = Object.getOwnPropertyNames(schema.properties);
  const unknownKeys = Object.getOwnPropertyNames(value);
  for (const requiredKey of requiredKeys) {
    if (unknownKeys.includes(requiredKey))
      continue;
    yield Create(ValueErrorType.ObjectRequiredProperty, schema.properties[requiredKey], `${path}/${EscapeKey(requiredKey)}`, undefined);
  }
  if (schema.additionalProperties === false) {
    for (const valueKey of unknownKeys) {
      if (!knownKeys.includes(valueKey)) {
        yield Create(ValueErrorType.ObjectAdditionalProperties, schema, `${path}/${EscapeKey(valueKey)}`, value[valueKey]);
      }
    }
  }
  if (typeof schema.additionalProperties === "object") {
    for (const valueKey of unknownKeys) {
      if (knownKeys.includes(valueKey))
        continue;
      yield* Visit6(schema.additionalProperties, references, `${path}/${EscapeKey(valueKey)}`, value[valueKey]);
    }
  }
  for (const knownKey of knownKeys) {
    const property = schema.properties[knownKey];
    if (schema.required && schema.required.includes(knownKey)) {
      yield* Visit6(property, references, `${path}/${EscapeKey(knownKey)}`, value[knownKey]);
      if (ExtendsUndefinedCheck(schema) && !(knownKey in value)) {
        yield Create(ValueErrorType.ObjectRequiredProperty, property, `${path}/${EscapeKey(knownKey)}`, undefined);
      }
    } else {
      if (TypeSystemPolicy.IsExactOptionalProperty(value, knownKey)) {
        yield* Visit6(property, references, `${path}/${EscapeKey(knownKey)}`, value[knownKey]);
      }
    }
  }
}
function* FromPromise5(schema, references, path, value) {
  if (!IsPromise(value))
    yield Create(ValueErrorType.Promise, schema, path, value);
}
function* FromRecord5(schema, references, path, value) {
  if (!TypeSystemPolicy.IsRecordLike(value))
    return yield Create(ValueErrorType.Object, schema, path, value);
  if (IsDefined2(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    yield Create(ValueErrorType.ObjectMinProperties, schema, path, value);
  }
  if (IsDefined2(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    yield Create(ValueErrorType.ObjectMaxProperties, schema, path, value);
  }
  const [patternKey, patternSchema] = Object.entries(schema.patternProperties)[0];
  const regex = new RegExp(patternKey);
  for (const [propertyKey, propertyValue] of Object.entries(value)) {
    if (regex.test(propertyKey))
      yield* Visit6(patternSchema, references, `${path}/${EscapeKey(propertyKey)}`, propertyValue);
  }
  if (typeof schema.additionalProperties === "object") {
    for (const [propertyKey, propertyValue] of Object.entries(value)) {
      if (!regex.test(propertyKey))
        yield* Visit6(schema.additionalProperties, references, `${path}/${EscapeKey(propertyKey)}`, propertyValue);
    }
  }
  if (schema.additionalProperties === false) {
    for (const [propertyKey, propertyValue] of Object.entries(value)) {
      if (regex.test(propertyKey))
        continue;
      return yield Create(ValueErrorType.ObjectAdditionalProperties, schema, `${path}/${EscapeKey(propertyKey)}`, propertyValue);
    }
  }
}
function* FromRef6(schema, references, path, value) {
  yield* Visit6(Deref(schema, references), references, path, value);
}
function* FromRegExp3(schema, references, path, value) {
  if (!IsString2(value))
    return yield Create(ValueErrorType.String, schema, path, value);
  if (IsDefined2(schema.minLength) && !(value.length >= schema.minLength)) {
    yield Create(ValueErrorType.StringMinLength, schema, path, value);
  }
  if (IsDefined2(schema.maxLength) && !(value.length <= schema.maxLength)) {
    yield Create(ValueErrorType.StringMaxLength, schema, path, value);
  }
  const regex = new RegExp(schema.source, schema.flags);
  if (!regex.test(value)) {
    return yield Create(ValueErrorType.RegExp, schema, path, value);
  }
}
function* FromString3(schema, references, path, value) {
  if (!IsString2(value))
    return yield Create(ValueErrorType.String, schema, path, value);
  if (IsDefined2(schema.minLength) && !(value.length >= schema.minLength)) {
    yield Create(ValueErrorType.StringMinLength, schema, path, value);
  }
  if (IsDefined2(schema.maxLength) && !(value.length <= schema.maxLength)) {
    yield Create(ValueErrorType.StringMaxLength, schema, path, value);
  }
  if (IsString2(schema.pattern)) {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value)) {
      yield Create(ValueErrorType.StringPattern, schema, path, value);
    }
  }
  if (IsString2(schema.format)) {
    if (!exports_format.Has(schema.format)) {
      yield Create(ValueErrorType.StringFormatUnknown, schema, path, value);
    } else {
      const format = exports_format.Get(schema.format);
      if (!format(value)) {
        yield Create(ValueErrorType.StringFormat, schema, path, value);
      }
    }
  }
}
function* FromSymbol3(schema, references, path, value) {
  if (!IsSymbol2(value))
    yield Create(ValueErrorType.Symbol, schema, path, value);
}
function* FromTemplateLiteral5(schema, references, path, value) {
  if (!IsString2(value))
    return yield Create(ValueErrorType.String, schema, path, value);
  const regex = new RegExp(schema.pattern);
  if (!regex.test(value)) {
    yield Create(ValueErrorType.StringPattern, schema, path, value);
  }
}
function* FromThis2(schema, references, path, value) {
  yield* Visit6(Deref(schema, references), references, path, value);
}
function* FromTuple7(schema, references, path, value) {
  if (!IsArray2(value))
    return yield Create(ValueErrorType.Tuple, schema, path, value);
  if (schema.items === undefined && !(value.length === 0)) {
    return yield Create(ValueErrorType.TupleLength, schema, path, value);
  }
  if (!(value.length === schema.maxItems)) {
    return yield Create(ValueErrorType.TupleLength, schema, path, value);
  }
  if (!schema.items) {
    return;
  }
  for (let i = 0;i < schema.items.length; i++) {
    yield* Visit6(schema.items[i], references, `${path}/${i}`, value[i]);
  }
}
function* FromUndefined3(schema, references, path, value) {
  if (!IsUndefined2(value))
    yield Create(ValueErrorType.Undefined, schema, path, value);
}
function* FromUnion12(schema, references, path, value) {
  if (Check(schema, references, value))
    return;
  const errors = schema.anyOf.map((variant) => new ValueErrorIterator(Visit6(variant, references, path, value)));
  yield Create(ValueErrorType.Union, schema, path, value, errors);
}
function* FromUint8Array3(schema, references, path, value) {
  if (!IsUint8Array2(value))
    return yield Create(ValueErrorType.Uint8Array, schema, path, value);
  if (IsDefined2(schema.maxByteLength) && !(value.length <= schema.maxByteLength)) {
    yield Create(ValueErrorType.Uint8ArrayMaxByteLength, schema, path, value);
  }
  if (IsDefined2(schema.minByteLength) && !(value.length >= schema.minByteLength)) {
    yield Create(ValueErrorType.Uint8ArrayMinByteLength, schema, path, value);
  }
}
function* FromUnknown3(schema, references, path, value) {}
function* FromVoid3(schema, references, path, value) {
  if (!TypeSystemPolicy.IsVoidLike(value))
    yield Create(ValueErrorType.Void, schema, path, value);
}
function* FromKind2(schema, references, path, value) {
  const check = exports_type2.Get(schema[Kind]);
  if (!check(schema, value))
    yield Create(ValueErrorType.Kind, schema, path, value);
}
function* Visit6(schema, references, path, value) {
  const references_ = IsDefined2(schema.$id) ? [...references, schema] : references;
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Any":
      return yield* FromAny3(schema_, references_, path, value);
    case "Argument":
      return yield* FromArgument3(schema_, references_, path, value);
    case "Array":
      return yield* FromArray8(schema_, references_, path, value);
    case "AsyncIterator":
      return yield* FromAsyncIterator5(schema_, references_, path, value);
    case "BigInt":
      return yield* FromBigInt3(schema_, references_, path, value);
    case "Boolean":
      return yield* FromBoolean3(schema_, references_, path, value);
    case "Constructor":
      return yield* FromConstructor5(schema_, references_, path, value);
    case "Date":
      return yield* FromDate3(schema_, references_, path, value);
    case "Function":
      return yield* FromFunction5(schema_, references_, path, value);
    case "Import":
      return yield* FromImport2(schema_, references_, path, value);
    case "Integer":
      return yield* FromInteger3(schema_, references_, path, value);
    case "Intersect":
      return yield* FromIntersect10(schema_, references_, path, value);
    case "Iterator":
      return yield* FromIterator5(schema_, references_, path, value);
    case "Literal":
      return yield* FromLiteral4(schema_, references_, path, value);
    case "Never":
      return yield* FromNever3(schema_, references_, path, value);
    case "Not":
      return yield* FromNot3(schema_, references_, path, value);
    case "Null":
      return yield* FromNull3(schema_, references_, path, value);
    case "Number":
      return yield* FromNumber3(schema_, references_, path, value);
    case "Object":
      return yield* FromObject9(schema_, references_, path, value);
    case "Promise":
      return yield* FromPromise5(schema_, references_, path, value);
    case "Record":
      return yield* FromRecord5(schema_, references_, path, value);
    case "Ref":
      return yield* FromRef6(schema_, references_, path, value);
    case "RegExp":
      return yield* FromRegExp3(schema_, references_, path, value);
    case "String":
      return yield* FromString3(schema_, references_, path, value);
    case "Symbol":
      return yield* FromSymbol3(schema_, references_, path, value);
    case "TemplateLiteral":
      return yield* FromTemplateLiteral5(schema_, references_, path, value);
    case "This":
      return yield* FromThis2(schema_, references_, path, value);
    case "Tuple":
      return yield* FromTuple7(schema_, references_, path, value);
    case "Undefined":
      return yield* FromUndefined3(schema_, references_, path, value);
    case "Union":
      return yield* FromUnion12(schema_, references_, path, value);
    case "Uint8Array":
      return yield* FromUint8Array3(schema_, references_, path, value);
    case "Unknown":
      return yield* FromUnknown3(schema_, references_, path, value);
    case "Void":
      return yield* FromVoid3(schema_, references_, path, value);
    default:
      if (!exports_type2.Has(schema_[Kind]))
        throw new ValueErrorsUnknownTypeError(schema);
      return yield* FromKind2(schema_, references_, path, value);
  }
}
function Errors(...args) {
  const iterator = args.length === 3 ? Visit6(args[0], args[1], "", args[2]) : Visit6(args[0], [], "", args[1]);
  return new ValueErrorIterator(iterator);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/assert/assert.mjs
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _AssertError_instances;
var _AssertError_iterator;
var _AssertError_Iterator;

class AssertError extends TypeBoxError {
  constructor(iterator) {
    const error = iterator.First();
    super(error === undefined ? "Invalid Value" : error.message);
    _AssertError_instances.add(this);
    _AssertError_iterator.set(this, undefined);
    __classPrivateFieldSet(this, _AssertError_iterator, iterator, "f");
    this.error = error;
  }
  Errors() {
    return new ValueErrorIterator(__classPrivateFieldGet(this, _AssertError_instances, "m", _AssertError_Iterator).call(this));
  }
}
_AssertError_iterator = new WeakMap, _AssertError_instances = new WeakSet, _AssertError_Iterator = function* _AssertError_Iterator2() {
  if (this.error)
    yield this.error;
  yield* __classPrivateFieldGet(this, _AssertError_iterator, "f");
};
function AssertValue(schema, references, value) {
  if (Check(schema, references, value))
    return;
  throw new AssertError(Errors(schema, references, value));
}
function Assert(...args) {
  return args.length === 3 ? AssertValue(args[0], args[1], args[2]) : AssertValue(args[0], [], args[1]);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/clone/clone.mjs
function FromObject10(value) {
  const Acc = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    Acc[key] = Clone2(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    Acc[key] = Clone2(value[key]);
  }
  return Acc;
}
function FromArray9(value) {
  return value.map((element) => Clone2(element));
}
function FromTypedArray(value) {
  return value.slice();
}
function FromMap(value) {
  return new Map(Clone2([...value.entries()]));
}
function FromSet(value) {
  return new Set(Clone2([...value.entries()]));
}
function FromDate4(value) {
  return new Date(value.toISOString());
}
function FromValue2(value) {
  return value;
}
function Clone2(value) {
  if (IsArray2(value))
    return FromArray9(value);
  if (IsDate2(value))
    return FromDate4(value);
  if (IsTypedArray(value))
    return FromTypedArray(value);
  if (IsMap(value))
    return FromMap(value);
  if (IsSet(value))
    return FromSet(value);
  if (IsObject2(value))
    return FromObject10(value);
  if (IsValueType(value))
    return FromValue2(value);
  throw new Error("ValueClone: Unable to clone value");
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/create/create.mjs
class ValueCreateError extends TypeBoxError {
  constructor(schema, message) {
    super(message);
    this.schema = schema;
  }
}
function FromDefault(value) {
  return IsFunction2(value) ? value() : Clone2(value);
}
function FromAny4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return {};
  }
}
function FromArgument4(schema, references) {
  return {};
}
function FromArray10(schema, references) {
  if (schema.uniqueItems === true && !HasPropertyKey2(schema, "default")) {
    throw new ValueCreateError(schema, "Array with the uniqueItems constraint requires a default value");
  } else if ("contains" in schema && !HasPropertyKey2(schema, "default")) {
    throw new ValueCreateError(schema, "Array with the contains constraint requires a default value");
  } else if ("default" in schema) {
    return FromDefault(schema.default);
  } else if (schema.minItems !== undefined) {
    return Array.from({ length: schema.minItems }).map((item) => {
      return Visit7(schema.items, references);
    });
  } else {
    return [];
  }
}
function FromAsyncIterator6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return async function* () {}();
  }
}
function FromBigInt4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return BigInt(0);
  }
}
function FromBoolean4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return false;
  }
}
function FromConstructor6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    const value = Visit7(schema.returns, references);
    if (typeof value === "object" && !Array.isArray(value)) {
      return class {
        constructor() {
          for (const [key, val] of Object.entries(value)) {
            const self = this;
            self[key] = val;
          }
        }
      };
    } else {
      return class {
      };
    }
  }
}
function FromDate5(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minimumTimestamp !== undefined) {
    return new Date(schema.minimumTimestamp);
  } else {
    return new Date;
  }
}
function FromFunction6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return () => Visit7(schema.returns, references);
  }
}
function FromImport3(schema, references) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit7(target, [...references, ...definitions]);
}
function FromInteger4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minimum !== undefined) {
    return schema.minimum;
  } else {
    return 0;
  }
}
function FromIntersect11(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    const value = schema.allOf.reduce((acc, schema2) => {
      const next = Visit7(schema2, references);
      return typeof next === "object" ? { ...acc, ...next } : next;
    }, {});
    if (!Check(schema, references, value))
      throw new ValueCreateError(schema, "Intersect produced invalid value. Consider using a default value.");
    return value;
  }
}
function FromIterator6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return function* () {}();
  }
}
function FromLiteral5(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return schema.const;
  }
}
function FromNever4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new ValueCreateError(schema, "Never types cannot be created. Consider using a default value.");
  }
}
function FromNot4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new ValueCreateError(schema, "Not types must have a default value");
  }
}
function FromNull4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return null;
  }
}
function FromNumber4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minimum !== undefined) {
    return schema.minimum;
  } else {
    return 0;
  }
}
function FromObject11(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    const required = new Set(schema.required);
    const Acc = {};
    for (const [key, subschema] of Object.entries(schema.properties)) {
      if (!required.has(key))
        continue;
      Acc[key] = Visit7(subschema, references);
    }
    return Acc;
  }
}
function FromPromise6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return Promise.resolve(Visit7(schema.item, references));
  }
}
function FromRecord6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return {};
  }
}
function FromRef7(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return Visit7(Deref(schema, references), references);
  }
}
function FromRegExp4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new ValueCreateError(schema, "RegExp types cannot be created. Consider using a default value.");
  }
}
function FromString4(schema, references) {
  if (schema.pattern !== undefined) {
    if (!HasPropertyKey2(schema, "default")) {
      throw new ValueCreateError(schema, "String types with patterns must specify a default value");
    } else {
      return FromDefault(schema.default);
    }
  } else if (schema.format !== undefined) {
    if (!HasPropertyKey2(schema, "default")) {
      throw new ValueCreateError(schema, "String types with formats must specify a default value");
    } else {
      return FromDefault(schema.default);
    }
  } else {
    if (HasPropertyKey2(schema, "default")) {
      return FromDefault(schema.default);
    } else if (schema.minLength !== undefined) {
      return Array.from({ length: schema.minLength }).map(() => " ").join("");
    } else {
      return "";
    }
  }
}
function FromSymbol4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if ("value" in schema) {
    return Symbol.for(schema.value);
  } else {
    return Symbol();
  }
}
function FromTemplateLiteral6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  }
  if (!IsTemplateLiteralFinite(schema))
    throw new ValueCreateError(schema, "Can only create template literals that produce a finite variants. Consider using a default value.");
  const generated = TemplateLiteralGenerate(schema);
  return generated[0];
}
function FromThis3(schema, references) {
  if (recursiveDepth++ > recursiveMaxDepth)
    throw new ValueCreateError(schema, "Cannot create recursive type as it appears possibly infinite. Consider using a default.");
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return Visit7(Deref(schema, references), references);
  }
}
function FromTuple8(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  }
  if (schema.items === undefined) {
    return [];
  } else {
    return Array.from({ length: schema.minItems }).map((_, index) => Visit7(schema.items[index], references));
  }
}
function FromUndefined4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return;
  }
}
function FromUnion13(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.anyOf.length === 0) {
    throw new Error("ValueCreate.Union: Cannot create Union with zero variants");
  } else {
    return Visit7(schema.anyOf[0], references);
  }
}
function FromUint8Array4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minByteLength !== undefined) {
    return new Uint8Array(schema.minByteLength);
  } else {
    return new Uint8Array(0);
  }
}
function FromUnknown4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return {};
  }
}
function FromVoid4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return;
  }
}
function FromKind3(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new Error("User defined types must specify a default value");
  }
}
function Visit7(schema, references) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Any":
      return FromAny4(schema_, references_);
    case "Argument":
      return FromArgument4(schema_, references_);
    case "Array":
      return FromArray10(schema_, references_);
    case "AsyncIterator":
      return FromAsyncIterator6(schema_, references_);
    case "BigInt":
      return FromBigInt4(schema_, references_);
    case "Boolean":
      return FromBoolean4(schema_, references_);
    case "Constructor":
      return FromConstructor6(schema_, references_);
    case "Date":
      return FromDate5(schema_, references_);
    case "Function":
      return FromFunction6(schema_, references_);
    case "Import":
      return FromImport3(schema_, references_);
    case "Integer":
      return FromInteger4(schema_, references_);
    case "Intersect":
      return FromIntersect11(schema_, references_);
    case "Iterator":
      return FromIterator6(schema_, references_);
    case "Literal":
      return FromLiteral5(schema_, references_);
    case "Never":
      return FromNever4(schema_, references_);
    case "Not":
      return FromNot4(schema_, references_);
    case "Null":
      return FromNull4(schema_, references_);
    case "Number":
      return FromNumber4(schema_, references_);
    case "Object":
      return FromObject11(schema_, references_);
    case "Promise":
      return FromPromise6(schema_, references_);
    case "Record":
      return FromRecord6(schema_, references_);
    case "Ref":
      return FromRef7(schema_, references_);
    case "RegExp":
      return FromRegExp4(schema_, references_);
    case "String":
      return FromString4(schema_, references_);
    case "Symbol":
      return FromSymbol4(schema_, references_);
    case "TemplateLiteral":
      return FromTemplateLiteral6(schema_, references_);
    case "This":
      return FromThis3(schema_, references_);
    case "Tuple":
      return FromTuple8(schema_, references_);
    case "Undefined":
      return FromUndefined4(schema_, references_);
    case "Union":
      return FromUnion13(schema_, references_);
    case "Uint8Array":
      return FromUint8Array4(schema_, references_);
    case "Unknown":
      return FromUnknown4(schema_, references_);
    case "Void":
      return FromVoid4(schema_, references_);
    default:
      if (!exports_type2.Has(schema_[Kind]))
        throw new ValueCreateError(schema_, "Unknown type");
      return FromKind3(schema_, references_);
  }
}
var recursiveMaxDepth = 512;
var recursiveDepth = 0;
function Create2(...args) {
  recursiveDepth = 0;
  return args.length === 2 ? Visit7(args[0], args[1]) : Visit7(args[0], []);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/cast/cast.mjs
class ValueCastError extends TypeBoxError {
  constructor(schema, message) {
    super(message);
    this.schema = schema;
  }
}
function ScoreUnion(schema, references, value) {
  if (schema[Kind] === "Object" && typeof value === "object" && !IsNull2(value)) {
    const object = schema;
    const keys = Object.getOwnPropertyNames(value);
    const entries = Object.entries(object.properties);
    return entries.reduce((acc, [key, schema2]) => {
      const literal = schema2[Kind] === "Literal" && schema2.const === value[key] ? 100 : 0;
      const checks = Check(schema2, references, value[key]) ? 10 : 0;
      const exists = keys.includes(key) ? 1 : 0;
      return acc + (literal + checks + exists);
    }, 0);
  } else if (schema[Kind] === "Union") {
    const schemas = schema.anyOf.map((schema2) => Deref(schema2, references));
    const scores = schemas.map((schema2) => ScoreUnion(schema2, references, value));
    return Math.max(...scores);
  } else {
    return Check(schema, references, value) ? 1 : 0;
  }
}
function SelectUnion(union, references, value) {
  const schemas = union.anyOf.map((schema) => Deref(schema, references));
  let [select, best] = [schemas[0], 0];
  for (const schema of schemas) {
    const score = ScoreUnion(schema, references, value);
    if (score > best) {
      select = schema;
      best = score;
    }
  }
  return select;
}
function CastUnion(union, references, value) {
  if ("default" in union) {
    return typeof value === "function" ? union.default : Clone2(union.default);
  } else {
    const schema = SelectUnion(union, references, value);
    return Cast(schema, references, value);
  }
}
function DefaultClone(schema, references, value) {
  return Check(schema, references, value) ? Clone2(value) : Create2(schema, references);
}
function Default(schema, references, value) {
  return Check(schema, references, value) ? value : Create2(schema, references);
}
function FromArray11(schema, references, value) {
  if (Check(schema, references, value))
    return Clone2(value);
  const created = IsArray2(value) ? Clone2(value) : Create2(schema, references);
  const minimum = IsNumber2(schema.minItems) && created.length < schema.minItems ? [...created, ...Array.from({ length: schema.minItems - created.length }, () => null)] : created;
  const maximum = IsNumber2(schema.maxItems) && minimum.length > schema.maxItems ? minimum.slice(0, schema.maxItems) : minimum;
  const casted = maximum.map((value2) => Visit8(schema.items, references, value2));
  if (schema.uniqueItems !== true)
    return casted;
  const unique = [...new Set(casted)];
  if (!Check(schema, references, unique))
    throw new ValueCastError(schema, "Array cast produced invalid data due to uniqueItems constraint");
  return unique;
}
function FromConstructor7(schema, references, value) {
  if (Check(schema, references, value))
    return Create2(schema, references);
  const required = new Set(schema.returns.required || []);
  const result = function() {};
  for (const [key, property] of Object.entries(schema.returns.properties)) {
    if (!required.has(key) && value.prototype[key] === undefined)
      continue;
    result.prototype[key] = Visit8(property, references, value.prototype[key]);
  }
  return result;
}
function FromImport4(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit8(target, [...references, ...definitions], value);
}
function IntersectAssign(correct, value) {
  if (IsObject2(correct) && !IsObject2(value) || !IsObject2(correct) && IsObject2(value))
    return correct;
  if (!IsObject2(correct) || !IsObject2(value))
    return value;
  return globalThis.Object.getOwnPropertyNames(correct).reduce((result, key) => {
    const property = key in value ? IntersectAssign(correct[key], value[key]) : correct[key];
    return { ...result, [key]: property };
  }, {});
}
function FromIntersect12(schema, references, value) {
  if (Check(schema, references, value))
    return value;
  const correct = Create2(schema, references);
  const assigned = IntersectAssign(correct, value);
  return Check(schema, references, assigned) ? assigned : correct;
}
function FromNever5(schema, references, value) {
  throw new ValueCastError(schema, "Never types cannot be cast");
}
function FromObject12(schema, references, value) {
  if (Check(schema, references, value))
    return value;
  if (value === null || typeof value !== "object")
    return Create2(schema, references);
  const required = new Set(schema.required || []);
  const result = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!required.has(key) && value[key] === undefined)
      continue;
    result[key] = Visit8(property, references, value[key]);
  }
  if (typeof schema.additionalProperties === "object") {
    const propertyNames = Object.getOwnPropertyNames(schema.properties);
    for (const propertyName of Object.getOwnPropertyNames(value)) {
      if (propertyNames.includes(propertyName))
        continue;
      result[propertyName] = Visit8(schema.additionalProperties, references, value[propertyName]);
    }
  }
  return result;
}
function FromRecord7(schema, references, value) {
  if (Check(schema, references, value))
    return Clone2(value);
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date)
    return Create2(schema, references);
  const subschemaPropertyName = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const subschema = schema.patternProperties[subschemaPropertyName];
  const result = {};
  for (const [propKey, propValue] of Object.entries(value)) {
    result[propKey] = Visit8(subschema, references, propValue);
  }
  return result;
}
function FromRef8(schema, references, value) {
  return Visit8(Deref(schema, references), references, value);
}
function FromThis4(schema, references, value) {
  return Visit8(Deref(schema, references), references, value);
}
function FromTuple9(schema, references, value) {
  if (Check(schema, references, value))
    return Clone2(value);
  if (!IsArray2(value))
    return Create2(schema, references);
  if (schema.items === undefined)
    return [];
  return schema.items.map((schema2, index) => Visit8(schema2, references, value[index]));
}
function FromUnion14(schema, references, value) {
  return Check(schema, references, value) ? Clone2(value) : CastUnion(schema, references, value);
}
function Visit8(schema, references, value) {
  const references_ = IsString2(schema.$id) ? Pushref(schema, references) : references;
  const schema_ = schema;
  switch (schema[Kind]) {
    case "Array":
      return FromArray11(schema_, references_, value);
    case "Constructor":
      return FromConstructor7(schema_, references_, value);
    case "Import":
      return FromImport4(schema_, references_, value);
    case "Intersect":
      return FromIntersect12(schema_, references_, value);
    case "Never":
      return FromNever5(schema_, references_, value);
    case "Object":
      return FromObject12(schema_, references_, value);
    case "Record":
      return FromRecord7(schema_, references_, value);
    case "Ref":
      return FromRef8(schema_, references_, value);
    case "This":
      return FromThis4(schema_, references_, value);
    case "Tuple":
      return FromTuple9(schema_, references_, value);
    case "Union":
      return FromUnion14(schema_, references_, value);
    case "Date":
    case "Symbol":
    case "Uint8Array":
      return DefaultClone(schema, references, value);
    default:
      return Default(schema_, references_, value);
  }
}
function Cast(...args) {
  return args.length === 3 ? Visit8(args[0], args[1], args[2]) : Visit8(args[0], [], args[1]);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/clean/clean.mjs
function IsCheckable(schema) {
  return IsKind(schema) && schema[Kind] !== "Unsafe";
}
function FromArray12(schema, references, value) {
  if (!IsArray2(value))
    return value;
  return value.map((value2) => Visit9(schema.items, references, value2));
}
function FromImport5(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit9(target, [...references, ...definitions], value);
}
function FromIntersect13(schema, references, value) {
  const unevaluatedProperties = schema.unevaluatedProperties;
  const intersections = schema.allOf.map((schema2) => Visit9(schema2, references, Clone2(value)));
  const composite = intersections.reduce((acc, value2) => IsObject2(value2) ? { ...acc, ...value2 } : value2, {});
  if (!IsObject2(value) || !IsObject2(composite) || !IsKind(unevaluatedProperties))
    return composite;
  const knownkeys = KeyOfPropertyKeys(schema);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (knownkeys.includes(key))
      continue;
    if (Check(unevaluatedProperties, references, value[key])) {
      composite[key] = Visit9(unevaluatedProperties, references, value[key]);
    }
  }
  return composite;
}
function FromObject13(schema, references, value) {
  if (!IsObject2(value) || IsArray2(value))
    return value;
  const additionalProperties = schema.additionalProperties;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (HasPropertyKey2(schema.properties, key)) {
      value[key] = Visit9(schema.properties[key], references, value[key]);
      continue;
    }
    if (IsKind(additionalProperties) && Check(additionalProperties, references, value[key])) {
      value[key] = Visit9(additionalProperties, references, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}
function FromRecord8(schema, references, value) {
  if (!IsObject2(value))
    return value;
  const additionalProperties = schema.additionalProperties;
  const propertyKeys = Object.getOwnPropertyNames(value);
  const [propertyKey, propertySchema] = Object.entries(schema.patternProperties)[0];
  const propertyKeyTest = new RegExp(propertyKey);
  for (const key of propertyKeys) {
    if (propertyKeyTest.test(key)) {
      value[key] = Visit9(propertySchema, references, value[key]);
      continue;
    }
    if (IsKind(additionalProperties) && Check(additionalProperties, references, value[key])) {
      value[key] = Visit9(additionalProperties, references, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}
function FromRef9(schema, references, value) {
  return Visit9(Deref(schema, references), references, value);
}
function FromThis5(schema, references, value) {
  return Visit9(Deref(schema, references), references, value);
}
function FromTuple10(schema, references, value) {
  if (!IsArray2(value))
    return value;
  if (IsUndefined2(schema.items))
    return [];
  const length = Math.min(value.length, schema.items.length);
  for (let i = 0;i < length; i++) {
    value[i] = Visit9(schema.items[i], references, value[i]);
  }
  return value.length > length ? value.slice(0, length) : value;
}
function FromUnion15(schema, references, value) {
  for (const inner of schema.anyOf) {
    if (IsCheckable(inner) && Check(inner, references, value)) {
      return Visit9(inner, references, value);
    }
  }
  return value;
}
function Visit9(schema, references, value) {
  const references_ = IsString2(schema.$id) ? Pushref(schema, references) : references;
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Array":
      return FromArray12(schema_, references_, value);
    case "Import":
      return FromImport5(schema_, references_, value);
    case "Intersect":
      return FromIntersect13(schema_, references_, value);
    case "Object":
      return FromObject13(schema_, references_, value);
    case "Record":
      return FromRecord8(schema_, references_, value);
    case "Ref":
      return FromRef9(schema_, references_, value);
    case "This":
      return FromThis5(schema_, references_, value);
    case "Tuple":
      return FromTuple10(schema_, references_, value);
    case "Union":
      return FromUnion15(schema_, references_, value);
    default:
      return value;
  }
}
function Clean(...args) {
  return args.length === 3 ? Visit9(args[0], args[1], args[2]) : Visit9(args[0], [], args[1]);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/convert/convert.mjs
function IsStringNumeric(value) {
  return IsString2(value) && !isNaN(value) && !isNaN(parseFloat(value));
}
function IsValueToString(value) {
  return IsBigInt2(value) || IsBoolean2(value) || IsNumber2(value);
}
function IsValueTrue(value) {
  return value === true || IsNumber2(value) && value === 1 || IsBigInt2(value) && value === BigInt("1") || IsString2(value) && (value.toLowerCase() === "true" || value === "1");
}
function IsValueFalse(value) {
  return value === false || IsNumber2(value) && (value === 0 || Object.is(value, -0)) || IsBigInt2(value) && value === BigInt("0") || IsString2(value) && (value.toLowerCase() === "false" || value === "0" || value === "-0");
}
function IsTimeStringWithTimeZone(value) {
  return IsString2(value) && /^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i.test(value);
}
function IsTimeStringWithoutTimeZone(value) {
  return IsString2(value) && /^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)?$/i.test(value);
}
function IsDateTimeStringWithTimeZone(value) {
  return IsString2(value) && /^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i.test(value);
}
function IsDateTimeStringWithoutTimeZone(value) {
  return IsString2(value) && /^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)?$/i.test(value);
}
function IsDateString(value) {
  return IsString2(value) && /^\d\d\d\d-[0-1]\d-[0-3]\d$/i.test(value);
}
function TryConvertLiteralString(value, target) {
  const conversion = TryConvertString(value);
  return conversion === target ? conversion : value;
}
function TryConvertLiteralNumber(value, target) {
  const conversion = TryConvertNumber(value);
  return conversion === target ? conversion : value;
}
function TryConvertLiteralBoolean(value, target) {
  const conversion = TryConvertBoolean(value);
  return conversion === target ? conversion : value;
}
function TryConvertLiteral(schema, value) {
  return IsString2(schema.const) ? TryConvertLiteralString(value, schema.const) : IsNumber2(schema.const) ? TryConvertLiteralNumber(value, schema.const) : IsBoolean2(schema.const) ? TryConvertLiteralBoolean(value, schema.const) : value;
}
function TryConvertBoolean(value) {
  return IsValueTrue(value) ? true : IsValueFalse(value) ? false : value;
}
function TryConvertBigInt(value) {
  const truncateInteger = (value2) => value2.split(".")[0];
  return IsStringNumeric(value) ? BigInt(truncateInteger(value)) : IsNumber2(value) ? BigInt(Math.trunc(value)) : IsValueFalse(value) ? BigInt(0) : IsValueTrue(value) ? BigInt(1) : value;
}
function TryConvertString(value) {
  return IsSymbol2(value) && value.description !== undefined ? value.description.toString() : IsValueToString(value) ? value.toString() : value;
}
function TryConvertNumber(value) {
  return IsStringNumeric(value) ? parseFloat(value) : IsValueTrue(value) ? 1 : IsValueFalse(value) ? 0 : value;
}
function TryConvertInteger(value) {
  return IsStringNumeric(value) ? parseInt(value) : IsNumber2(value) ? Math.trunc(value) : IsValueTrue(value) ? 1 : IsValueFalse(value) ? 0 : value;
}
function TryConvertNull(value) {
  return IsString2(value) && value.toLowerCase() === "null" ? null : value;
}
function TryConvertUndefined(value) {
  return IsString2(value) && value === "undefined" ? undefined : value;
}
function TryConvertDate(value) {
  return IsDate2(value) ? value : IsNumber2(value) ? new Date(value) : IsValueTrue(value) ? new Date(1) : IsValueFalse(value) ? new Date(0) : IsStringNumeric(value) ? new Date(parseInt(value)) : IsTimeStringWithoutTimeZone(value) ? new Date(`1970-01-01T${value}.000Z`) : IsTimeStringWithTimeZone(value) ? new Date(`1970-01-01T${value}`) : IsDateTimeStringWithoutTimeZone(value) ? new Date(`${value}.000Z`) : IsDateTimeStringWithTimeZone(value) ? new Date(value) : IsDateString(value) ? new Date(`${value}T00:00:00.000Z`) : value;
}
function Default2(value) {
  return value;
}
function FromArray13(schema, references, value) {
  const elements = IsArray2(value) ? value : [value];
  return elements.map((element) => Visit10(schema.items, references, element));
}
function FromBigInt5(schema, references, value) {
  return TryConvertBigInt(value);
}
function FromBoolean5(schema, references, value) {
  return TryConvertBoolean(value);
}
function FromDate6(schema, references, value) {
  return TryConvertDate(value);
}
function FromImport6(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit10(target, [...references, ...definitions], value);
}
function FromInteger5(schema, references, value) {
  return TryConvertInteger(value);
}
function FromIntersect14(schema, references, value) {
  return schema.allOf.reduce((value2, schema2) => Visit10(schema2, references, value2), value);
}
function FromLiteral6(schema, references, value) {
  return TryConvertLiteral(schema, value);
}
function FromNull5(schema, references, value) {
  return TryConvertNull(value);
}
function FromNumber5(schema, references, value) {
  return TryConvertNumber(value);
}
function FromObject14(schema, references, value) {
  if (!IsObject2(value) || IsArray2(value))
    return value;
  for (const propertyKey of Object.getOwnPropertyNames(schema.properties)) {
    if (!HasPropertyKey2(value, propertyKey))
      continue;
    value[propertyKey] = Visit10(schema.properties[propertyKey], references, value[propertyKey]);
  }
  return value;
}
function FromRecord9(schema, references, value) {
  const isConvertable = IsObject2(value) && !IsArray2(value);
  if (!isConvertable)
    return value;
  const propertyKey = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const property = schema.patternProperties[propertyKey];
  for (const [propKey, propValue] of Object.entries(value)) {
    value[propKey] = Visit10(property, references, propValue);
  }
  return value;
}
function FromRef10(schema, references, value) {
  return Visit10(Deref(schema, references), references, value);
}
function FromString5(schema, references, value) {
  return TryConvertString(value);
}
function FromSymbol5(schema, references, value) {
  return IsString2(value) || IsNumber2(value) ? Symbol(value) : value;
}
function FromThis6(schema, references, value) {
  return Visit10(Deref(schema, references), references, value);
}
function FromTuple11(schema, references, value) {
  const isConvertable = IsArray2(value) && !IsUndefined2(schema.items);
  if (!isConvertable)
    return value;
  return value.map((value2, index) => {
    return index < schema.items.length ? Visit10(schema.items[index], references, value2) : value2;
  });
}
function FromUndefined5(schema, references, value) {
  return TryConvertUndefined(value);
}
function FromUnion16(schema, references, value) {
  for (const subschema of schema.anyOf) {
    if (Check(subschema, references, value)) {
      return value;
    }
  }
  for (const subschema of schema.anyOf) {
    const converted = Visit10(subschema, references, Clone2(value));
    if (!Check(subschema, references, converted))
      continue;
    return converted;
  }
  return value;
}
function Visit10(schema, references, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema[Kind]) {
    case "Array":
      return FromArray13(schema_, references_, value);
    case "BigInt":
      return FromBigInt5(schema_, references_, value);
    case "Boolean":
      return FromBoolean5(schema_, references_, value);
    case "Date":
      return FromDate6(schema_, references_, value);
    case "Import":
      return FromImport6(schema_, references_, value);
    case "Integer":
      return FromInteger5(schema_, references_, value);
    case "Intersect":
      return FromIntersect14(schema_, references_, value);
    case "Literal":
      return FromLiteral6(schema_, references_, value);
    case "Null":
      return FromNull5(schema_, references_, value);
    case "Number":
      return FromNumber5(schema_, references_, value);
    case "Object":
      return FromObject14(schema_, references_, value);
    case "Record":
      return FromRecord9(schema_, references_, value);
    case "Ref":
      return FromRef10(schema_, references_, value);
    case "String":
      return FromString5(schema_, references_, value);
    case "Symbol":
      return FromSymbol5(schema_, references_, value);
    case "This":
      return FromThis6(schema_, references_, value);
    case "Tuple":
      return FromTuple11(schema_, references_, value);
    case "Undefined":
      return FromUndefined5(schema_, references_, value);
    case "Union":
      return FromUnion16(schema_, references_, value);
    default:
      return Default2(value);
  }
}
function Convert(...args) {
  return args.length === 3 ? Visit10(args[0], args[1], args[2]) : Visit10(args[0], [], args[1]);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/transform/decode.mjs
class TransformDecodeCheckError extends TypeBoxError {
  constructor(schema, value, error) {
    super(`Unable to decode value as it does not match the expected schema`);
    this.schema = schema;
    this.value = value;
    this.error = error;
  }
}

class TransformDecodeError extends TypeBoxError {
  constructor(schema, path, value, error) {
    super(error instanceof Error ? error.message : "Unknown error");
    this.schema = schema;
    this.path = path;
    this.value = value;
    this.error = error;
  }
}
function Default3(schema, path, value) {
  try {
    return IsTransform(schema) ? schema[TransformKind].Decode(value) : value;
  } catch (error) {
    throw new TransformDecodeError(schema, path, value, error);
  }
}
function FromArray14(schema, references, path, value) {
  return IsArray2(value) ? Default3(schema, path, value.map((value2, index) => Visit11(schema.items, references, `${path}/${index}`, value2))) : Default3(schema, path, value);
}
function FromIntersect15(schema, references, path, value) {
  if (!IsObject2(value) || IsValueType(value))
    return Default3(schema, path, value);
  const knownEntries = KeyOfPropertyEntries(schema);
  const knownKeys = knownEntries.map((entry) => entry[0]);
  const knownProperties = { ...value };
  for (const [knownKey, knownSchema] of knownEntries)
    if (knownKey in knownProperties) {
      knownProperties[knownKey] = Visit11(knownSchema, references, `${path}/${knownKey}`, knownProperties[knownKey]);
    }
  if (!IsTransform(schema.unevaluatedProperties)) {
    return Default3(schema, path, knownProperties);
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const unevaluatedProperties = schema.unevaluatedProperties;
  const unknownProperties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      unknownProperties[key] = Default3(unevaluatedProperties, `${path}/${key}`, unknownProperties[key]);
    }
  return Default3(schema, path, unknownProperties);
}
function FromImport7(schema, references, path, value) {
  const additional = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  const result = Visit11(target, [...references, ...additional], path, value);
  return Default3(schema, path, result);
}
function FromNot5(schema, references, path, value) {
  return Default3(schema, path, Visit11(schema.not, references, path, value));
}
function FromObject15(schema, references, path, value) {
  if (!IsObject2(value))
    return Default3(schema, path, value);
  const knownKeys = KeyOfPropertyKeys(schema);
  const knownProperties = { ...value };
  for (const key of knownKeys) {
    if (!HasPropertyKey2(knownProperties, key))
      continue;
    if (IsUndefined2(knownProperties[key]) && (!IsUndefined3(schema.properties[key]) || TypeSystemPolicy.IsExactOptionalProperty(knownProperties, key)))
      continue;
    knownProperties[key] = Visit11(schema.properties[key], references, `${path}/${key}`, knownProperties[key]);
  }
  if (!IsSchema(schema.additionalProperties)) {
    return Default3(schema, path, knownProperties);
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const unknownProperties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      unknownProperties[key] = Default3(additionalProperties, `${path}/${key}`, unknownProperties[key]);
    }
  return Default3(schema, path, unknownProperties);
}
function FromRecord10(schema, references, path, value) {
  if (!IsObject2(value))
    return Default3(schema, path, value);
  const pattern = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const knownKeys = new RegExp(pattern);
  const knownProperties = { ...value };
  for (const key of Object.getOwnPropertyNames(value))
    if (knownKeys.test(key)) {
      knownProperties[key] = Visit11(schema.patternProperties[pattern], references, `${path}/${key}`, knownProperties[key]);
    }
  if (!IsSchema(schema.additionalProperties)) {
    return Default3(schema, path, knownProperties);
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const unknownProperties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.test(key)) {
      unknownProperties[key] = Default3(additionalProperties, `${path}/${key}`, unknownProperties[key]);
    }
  return Default3(schema, path, unknownProperties);
}
function FromRef11(schema, references, path, value) {
  const target = Deref(schema, references);
  return Default3(schema, path, Visit11(target, references, path, value));
}
function FromThis7(schema, references, path, value) {
  const target = Deref(schema, references);
  return Default3(schema, path, Visit11(target, references, path, value));
}
function FromTuple12(schema, references, path, value) {
  return IsArray2(value) && IsArray2(schema.items) ? Default3(schema, path, schema.items.map((schema2, index) => Visit11(schema2, references, `${path}/${index}`, value[index]))) : Default3(schema, path, value);
}
function FromUnion17(schema, references, path, value) {
  for (const subschema of schema.anyOf) {
    if (!Check(subschema, references, value))
      continue;
    const decoded = Visit11(subschema, references, path, value);
    return Default3(schema, path, decoded);
  }
  return Default3(schema, path, value);
}
function Visit11(schema, references, path, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema[Kind]) {
    case "Array":
      return FromArray14(schema_, references_, path, value);
    case "Import":
      return FromImport7(schema_, references_, path, value);
    case "Intersect":
      return FromIntersect15(schema_, references_, path, value);
    case "Not":
      return FromNot5(schema_, references_, path, value);
    case "Object":
      return FromObject15(schema_, references_, path, value);
    case "Record":
      return FromRecord10(schema_, references_, path, value);
    case "Ref":
      return FromRef11(schema_, references_, path, value);
    case "Symbol":
      return Default3(schema_, path, value);
    case "This":
      return FromThis7(schema_, references_, path, value);
    case "Tuple":
      return FromTuple12(schema_, references_, path, value);
    case "Union":
      return FromUnion17(schema_, references_, path, value);
    default:
      return Default3(schema_, path, value);
  }
}
function TransformDecode(schema, references, value) {
  return Visit11(schema, references, "", value);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/transform/encode.mjs
class TransformEncodeCheckError extends TypeBoxError {
  constructor(schema, value, error) {
    super(`The encoded value does not match the expected schema`);
    this.schema = schema;
    this.value = value;
    this.error = error;
  }
}

class TransformEncodeError extends TypeBoxError {
  constructor(schema, path, value, error) {
    super(`${error instanceof Error ? error.message : "Unknown error"}`);
    this.schema = schema;
    this.path = path;
    this.value = value;
    this.error = error;
  }
}
function Default4(schema, path, value) {
  try {
    return IsTransform(schema) ? schema[TransformKind].Encode(value) : value;
  } catch (error) {
    throw new TransformEncodeError(schema, path, value, error);
  }
}
function FromArray15(schema, references, path, value) {
  const defaulted = Default4(schema, path, value);
  return IsArray2(defaulted) ? defaulted.map((value2, index) => Visit12(schema.items, references, `${path}/${index}`, value2)) : defaulted;
}
function FromImport8(schema, references, path, value) {
  const additional = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  const result = Default4(schema, path, value);
  return Visit12(target, [...references, ...additional], path, result);
}
function FromIntersect16(schema, references, path, value) {
  const defaulted = Default4(schema, path, value);
  if (!IsObject2(value) || IsValueType(value))
    return defaulted;
  const knownEntries = KeyOfPropertyEntries(schema);
  const knownKeys = knownEntries.map((entry) => entry[0]);
  const knownProperties = { ...defaulted };
  for (const [knownKey, knownSchema] of knownEntries)
    if (knownKey in knownProperties) {
      knownProperties[knownKey] = Visit12(knownSchema, references, `${path}/${knownKey}`, knownProperties[knownKey]);
    }
  if (!IsTransform(schema.unevaluatedProperties)) {
    return knownProperties;
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const unevaluatedProperties = schema.unevaluatedProperties;
  const properties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      properties[key] = Default4(unevaluatedProperties, `${path}/${key}`, properties[key]);
    }
  return properties;
}
function FromNot6(schema, references, path, value) {
  return Default4(schema.not, path, Default4(schema, path, value));
}
function FromObject16(schema, references, path, value) {
  const defaulted = Default4(schema, path, value);
  if (!IsObject2(defaulted))
    return defaulted;
  const knownKeys = KeyOfPropertyKeys(schema);
  const knownProperties = { ...defaulted };
  for (const key of knownKeys) {
    if (!HasPropertyKey2(knownProperties, key))
      continue;
    if (IsUndefined2(knownProperties[key]) && (!IsUndefined3(schema.properties[key]) || TypeSystemPolicy.IsExactOptionalProperty(knownProperties, key)))
      continue;
    knownProperties[key] = Visit12(schema.properties[key], references, `${path}/${key}`, knownProperties[key]);
  }
  if (!IsSchema(schema.additionalProperties)) {
    return knownProperties;
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const properties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      properties[key] = Default4(additionalProperties, `${path}/${key}`, properties[key]);
    }
  return properties;
}
function FromRecord11(schema, references, path, value) {
  const defaulted = Default4(schema, path, value);
  if (!IsObject2(value))
    return defaulted;
  const pattern = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const knownKeys = new RegExp(pattern);
  const knownProperties = { ...defaulted };
  for (const key of Object.getOwnPropertyNames(value))
    if (knownKeys.test(key)) {
      knownProperties[key] = Visit12(schema.patternProperties[pattern], references, `${path}/${key}`, knownProperties[key]);
    }
  if (!IsSchema(schema.additionalProperties)) {
    return knownProperties;
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const properties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.test(key)) {
      properties[key] = Default4(additionalProperties, `${path}/${key}`, properties[key]);
    }
  return properties;
}
function FromRef12(schema, references, path, value) {
  const target = Deref(schema, references);
  const resolved = Visit12(target, references, path, value);
  return Default4(schema, path, resolved);
}
function FromThis8(schema, references, path, value) {
  const target = Deref(schema, references);
  const resolved = Visit12(target, references, path, value);
  return Default4(schema, path, resolved);
}
function FromTuple13(schema, references, path, value) {
  const value1 = Default4(schema, path, value);
  return IsArray2(schema.items) ? schema.items.map((schema2, index) => Visit12(schema2, references, `${path}/${index}`, value1[index])) : [];
}
function FromUnion18(schema, references, path, value) {
  for (const subschema of schema.anyOf) {
    if (!Check(subschema, references, value))
      continue;
    const value1 = Visit12(subschema, references, path, value);
    return Default4(schema, path, value1);
  }
  for (const subschema of schema.anyOf) {
    const value1 = Visit12(subschema, references, path, value);
    if (!Check(schema, references, value1))
      continue;
    return Default4(schema, path, value1);
  }
  return Default4(schema, path, value);
}
function Visit12(schema, references, path, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema[Kind]) {
    case "Array":
      return FromArray15(schema_, references_, path, value);
    case "Import":
      return FromImport8(schema_, references_, path, value);
    case "Intersect":
      return FromIntersect16(schema_, references_, path, value);
    case "Not":
      return FromNot6(schema_, references_, path, value);
    case "Object":
      return FromObject16(schema_, references_, path, value);
    case "Record":
      return FromRecord11(schema_, references_, path, value);
    case "Ref":
      return FromRef12(schema_, references_, path, value);
    case "This":
      return FromThis8(schema_, references_, path, value);
    case "Tuple":
      return FromTuple13(schema_, references_, path, value);
    case "Union":
      return FromUnion18(schema_, references_, path, value);
    default:
      return Default4(schema_, path, value);
  }
}
function TransformEncode(schema, references, value) {
  return Visit12(schema, references, "", value);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/transform/has.mjs
function FromArray16(schema, references) {
  return IsTransform(schema) || Visit13(schema.items, references);
}
function FromAsyncIterator7(schema, references) {
  return IsTransform(schema) || Visit13(schema.items, references);
}
function FromConstructor8(schema, references) {
  return IsTransform(schema) || Visit13(schema.returns, references) || schema.parameters.some((schema2) => Visit13(schema2, references));
}
function FromFunction7(schema, references) {
  return IsTransform(schema) || Visit13(schema.returns, references) || schema.parameters.some((schema2) => Visit13(schema2, references));
}
function FromIntersect17(schema, references) {
  return IsTransform(schema) || IsTransform(schema.unevaluatedProperties) || schema.allOf.some((schema2) => Visit13(schema2, references));
}
function FromImport9(schema, references) {
  const additional = globalThis.Object.getOwnPropertyNames(schema.$defs).reduce((result, key) => [...result, schema.$defs[key]], []);
  const target = schema.$defs[schema.$ref];
  return IsTransform(schema) || Visit13(target, [...additional, ...references]);
}
function FromIterator7(schema, references) {
  return IsTransform(schema) || Visit13(schema.items, references);
}
function FromNot7(schema, references) {
  return IsTransform(schema) || Visit13(schema.not, references);
}
function FromObject17(schema, references) {
  return IsTransform(schema) || Object.values(schema.properties).some((schema2) => Visit13(schema2, references)) || IsSchema(schema.additionalProperties) && Visit13(schema.additionalProperties, references);
}
function FromPromise7(schema, references) {
  return IsTransform(schema) || Visit13(schema.item, references);
}
function FromRecord12(schema, references) {
  const pattern = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const property = schema.patternProperties[pattern];
  return IsTransform(schema) || Visit13(property, references) || IsSchema(schema.additionalProperties) && IsTransform(schema.additionalProperties);
}
function FromRef13(schema, references) {
  if (IsTransform(schema))
    return true;
  return Visit13(Deref(schema, references), references);
}
function FromThis9(schema, references) {
  if (IsTransform(schema))
    return true;
  return Visit13(Deref(schema, references), references);
}
function FromTuple14(schema, references) {
  return IsTransform(schema) || !IsUndefined2(schema.items) && schema.items.some((schema2) => Visit13(schema2, references));
}
function FromUnion19(schema, references) {
  return IsTransform(schema) || schema.anyOf.some((schema2) => Visit13(schema2, references));
}
function Visit13(schema, references) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  if (schema.$id && visited.has(schema.$id))
    return false;
  if (schema.$id)
    visited.add(schema.$id);
  switch (schema[Kind]) {
    case "Array":
      return FromArray16(schema_, references_);
    case "AsyncIterator":
      return FromAsyncIterator7(schema_, references_);
    case "Constructor":
      return FromConstructor8(schema_, references_);
    case "Function":
      return FromFunction7(schema_, references_);
    case "Import":
      return FromImport9(schema_, references_);
    case "Intersect":
      return FromIntersect17(schema_, references_);
    case "Iterator":
      return FromIterator7(schema_, references_);
    case "Not":
      return FromNot7(schema_, references_);
    case "Object":
      return FromObject17(schema_, references_);
    case "Promise":
      return FromPromise7(schema_, references_);
    case "Record":
      return FromRecord12(schema_, references_);
    case "Ref":
      return FromRef13(schema_, references_);
    case "This":
      return FromThis9(schema_, references_);
    case "Tuple":
      return FromTuple14(schema_, references_);
    case "Union":
      return FromUnion19(schema_, references_);
    default:
      return IsTransform(schema);
  }
}
var visited = new Set;
function HasTransform(schema, references) {
  visited.clear();
  return Visit13(schema, references);
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/decode/decode.mjs
function Decode(...args) {
  const [schema, references, value] = args.length === 3 ? [args[0], args[1], args[2]] : [args[0], [], args[1]];
  if (!Check(schema, references, value))
    throw new TransformDecodeCheckError(schema, value, Errors(schema, references, value).First());
  return HasTransform(schema, references) ? TransformDecode(schema, references, value) : value;
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/default/default.mjs
function ValueOrDefault(schema, value) {
  const defaultValue = HasPropertyKey2(schema, "default") ? schema.default : undefined;
  const clone = IsFunction2(defaultValue) ? defaultValue() : Clone2(defaultValue);
  return IsUndefined2(value) ? clone : IsObject2(value) && IsObject2(clone) ? Object.assign(clone, value) : value;
}
function HasDefaultProperty(schema) {
  return IsKind(schema) && "default" in schema;
}
function FromArray17(schema, references, value) {
  if (IsArray2(value)) {
    for (let i = 0;i < value.length; i++) {
      value[i] = Visit14(schema.items, references, value[i]);
    }
    return value;
  }
  const defaulted = ValueOrDefault(schema, value);
  if (!IsArray2(defaulted))
    return defaulted;
  for (let i = 0;i < defaulted.length; i++) {
    defaulted[i] = Visit14(schema.items, references, defaulted[i]);
  }
  return defaulted;
}
function FromDate7(schema, references, value) {
  return IsDate2(value) ? value : ValueOrDefault(schema, value);
}
function FromImport10(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit14(target, [...references, ...definitions], value);
}
function FromIntersect18(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  return schema.allOf.reduce((acc, schema2) => {
    const next = Visit14(schema2, references, defaulted);
    return IsObject2(next) ? { ...acc, ...next } : next;
  }, {});
}
function FromObject18(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  if (!IsObject2(defaulted))
    return defaulted;
  const knownPropertyKeys = Object.getOwnPropertyNames(schema.properties);
  for (const key of knownPropertyKeys) {
    const propertyValue = Visit14(schema.properties[key], references, defaulted[key]);
    if (IsUndefined2(propertyValue))
      continue;
    defaulted[key] = Visit14(schema.properties[key], references, defaulted[key]);
  }
  if (!HasDefaultProperty(schema.additionalProperties))
    return defaulted;
  for (const key of Object.getOwnPropertyNames(defaulted)) {
    if (knownPropertyKeys.includes(key))
      continue;
    defaulted[key] = Visit14(schema.additionalProperties, references, defaulted[key]);
  }
  return defaulted;
}
function FromRecord13(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  if (!IsObject2(defaulted))
    return defaulted;
  const additionalPropertiesSchema = schema.additionalProperties;
  const [propertyKeyPattern, propertySchema] = Object.entries(schema.patternProperties)[0];
  const knownPropertyKey = new RegExp(propertyKeyPattern);
  for (const key of Object.getOwnPropertyNames(defaulted)) {
    if (!(knownPropertyKey.test(key) && HasDefaultProperty(propertySchema)))
      continue;
    defaulted[key] = Visit14(propertySchema, references, defaulted[key]);
  }
  if (!HasDefaultProperty(additionalPropertiesSchema))
    return defaulted;
  for (const key of Object.getOwnPropertyNames(defaulted)) {
    if (knownPropertyKey.test(key))
      continue;
    defaulted[key] = Visit14(additionalPropertiesSchema, references, defaulted[key]);
  }
  return defaulted;
}
function FromRef14(schema, references, value) {
  return Visit14(Deref(schema, references), references, ValueOrDefault(schema, value));
}
function FromThis10(schema, references, value) {
  return Visit14(Deref(schema, references), references, value);
}
function FromTuple15(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  if (!IsArray2(defaulted) || IsUndefined2(schema.items))
    return defaulted;
  const [items, max] = [schema.items, Math.max(schema.items.length, defaulted.length)];
  for (let i = 0;i < max; i++) {
    if (i < items.length)
      defaulted[i] = Visit14(items[i], references, defaulted[i]);
  }
  return defaulted;
}
function FromUnion20(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  for (const inner of schema.anyOf) {
    const result = Visit14(inner, references, Clone2(defaulted));
    if (Check(inner, references, result)) {
      return result;
    }
  }
  return defaulted;
}
function Visit14(schema, references, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Array":
      return FromArray17(schema_, references_, value);
    case "Date":
      return FromDate7(schema_, references_, value);
    case "Import":
      return FromImport10(schema_, references_, value);
    case "Intersect":
      return FromIntersect18(schema_, references_, value);
    case "Object":
      return FromObject18(schema_, references_, value);
    case "Record":
      return FromRecord13(schema_, references_, value);
    case "Ref":
      return FromRef14(schema_, references_, value);
    case "This":
      return FromThis10(schema_, references_, value);
    case "Tuple":
      return FromTuple15(schema_, references_, value);
    case "Union":
      return FromUnion20(schema_, references_, value);
    default:
      return ValueOrDefault(schema_, value);
  }
}
function Default5(...args) {
  return args.length === 3 ? Visit14(args[0], args[1], args[2]) : Visit14(args[0], [], args[1]);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/pointer/pointer.mjs
var exports_pointer = {};
__export(exports_pointer, {
  ValuePointerRootSetError: () => ValuePointerRootSetError,
  ValuePointerRootDeleteError: () => ValuePointerRootDeleteError,
  Set: () => Set4,
  Has: () => Has3,
  Get: () => Get3,
  Format: () => Format,
  Delete: () => Delete3
});
class ValuePointerRootSetError extends TypeBoxError {
  constructor(value, path, update) {
    super("Cannot set root value");
    this.value = value;
    this.path = path;
    this.update = update;
  }
}

class ValuePointerRootDeleteError extends TypeBoxError {
  constructor(value, path) {
    super("Cannot delete root value");
    this.value = value;
    this.path = path;
  }
}
function Escape2(component) {
  return component.indexOf("~") === -1 ? component : component.replace(/~1/g, "/").replace(/~0/g, "~");
}
function* Format(pointer) {
  if (pointer === "")
    return;
  let [start, end] = [0, 0];
  for (let i = 0;i < pointer.length; i++) {
    const char = pointer.charAt(i);
    if (char === "/") {
      if (i === 0) {
        start = i + 1;
      } else {
        end = i;
        yield Escape2(pointer.slice(start, end));
        start = i + 1;
      }
    } else {
      end = i;
    }
  }
  yield Escape2(pointer.slice(start));
}
function Set4(value, pointer, update) {
  if (pointer === "")
    throw new ValuePointerRootSetError(value, pointer, update);
  let [owner, next, key] = [null, value, ""];
  for (const component of Format(pointer)) {
    if (next[component] === undefined)
      next[component] = {};
    owner = next;
    next = next[component];
    key = component;
  }
  owner[key] = update;
}
function Delete3(value, pointer) {
  if (pointer === "")
    throw new ValuePointerRootDeleteError(value, pointer);
  let [owner, next, key] = [null, value, ""];
  for (const component of Format(pointer)) {
    if (next[component] === undefined || next[component] === null)
      return;
    owner = next;
    next = next[component];
    key = component;
  }
  if (Array.isArray(owner)) {
    const index = parseInt(key);
    owner.splice(index, 1);
  } else {
    delete owner[key];
  }
}
function Has3(value, pointer) {
  if (pointer === "")
    return true;
  let [owner, next, key] = [null, value, ""];
  for (const component of Format(pointer)) {
    if (next[component] === undefined)
      return false;
    owner = next;
    next = next[component];
    key = component;
  }
  return Object.getOwnPropertyNames(owner).includes(key);
}
function Get3(value, pointer) {
  if (pointer === "")
    return value;
  let current = value;
  for (const component of Format(pointer)) {
    if (current[component] === undefined)
      return;
    current = current[component];
  }
  return current;
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/equal/equal.mjs
function ObjectType3(left, right) {
  if (!IsObject2(right))
    return false;
  const leftKeys = [...Object.keys(left), ...Object.getOwnPropertySymbols(left)];
  const rightKeys = [...Object.keys(right), ...Object.getOwnPropertySymbols(right)];
  if (leftKeys.length !== rightKeys.length)
    return false;
  return leftKeys.every((key) => Equal(left[key], right[key]));
}
function DateType3(left, right) {
  return IsDate2(right) && left.getTime() === right.getTime();
}
function ArrayType3(left, right) {
  if (!IsArray2(right) || left.length !== right.length)
    return false;
  return left.every((value, index) => Equal(value, right[index]));
}
function TypedArrayType(left, right) {
  if (!IsTypedArray(right) || left.length !== right.length || Object.getPrototypeOf(left).constructor.name !== Object.getPrototypeOf(right).constructor.name)
    return false;
  return left.every((value, index) => Equal(value, right[index]));
}
function ValueType(left, right) {
  return left === right;
}
function Equal(left, right) {
  if (IsDate2(left))
    return DateType3(left, right);
  if (IsTypedArray(left))
    return TypedArrayType(left, right);
  if (IsArray2(left))
    return ArrayType3(left, right);
  if (IsObject2(left))
    return ObjectType3(left, right);
  if (IsValueType(left))
    return ValueType(left, right);
  throw new Error("ValueEquals: Unable to compare value");
}

// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/delta/delta.mjs
var Insert = Object2({
  type: Literal("insert"),
  path: String2(),
  value: Unknown()
});
var Update = Object2({
  type: Literal("update"),
  path: String2(),
  value: Unknown()
});
var Delete4 = Object2({
  type: Literal("delete"),
  path: String2()
});
var Edit = Union([Insert, Update, Delete4]);

class ValueDiffError extends TypeBoxError {
  constructor(value, message) {
    super(message);
    this.value = value;
  }
}
function CreateUpdate(path, value) {
  return { type: "update", path, value };
}
function CreateInsert(path, value) {
  return { type: "insert", path, value };
}
function CreateDelete(path) {
  return { type: "delete", path };
}
function AssertDiffable(value) {
  if (globalThis.Object.getOwnPropertySymbols(value).length > 0)
    throw new ValueDiffError(value, "Cannot diff objects with symbols");
}
function* ObjectType4(path, current, next) {
  AssertDiffable(current);
  AssertDiffable(next);
  if (!IsStandardObject(next))
    return yield CreateUpdate(path, next);
  const currentKeys = globalThis.Object.getOwnPropertyNames(current);
  const nextKeys = globalThis.Object.getOwnPropertyNames(next);
  for (const key of nextKeys) {
    if (HasPropertyKey2(current, key))
      continue;
    yield CreateInsert(`${path}/${key}`, next[key]);
  }
  for (const key of currentKeys) {
    if (!HasPropertyKey2(next, key))
      continue;
    if (Equal(current, next))
      continue;
    yield* Visit15(`${path}/${key}`, current[key], next[key]);
  }
  for (const key of currentKeys) {
    if (HasPropertyKey2(next, key))
      continue;
    yield CreateDelete(`${path}/${key}`);
  }
}
function* ArrayType4(path, current, next) {
  if (!IsArray2(next))
    return yield CreateUpdate(path, next);
  for (let i = 0;i < Math.min(current.length, next.length); i++) {
    yield* Visit15(`${path}/${i}`, current[i], next[i]);
  }
  for (let i = 0;i < next.length; i++) {
    if (i < current.length)
      continue;
    yield CreateInsert(`${path}/${i}`, next[i]);
  }
  for (let i = current.length - 1;i >= 0; i--) {
    if (i < next.length)
      continue;
    yield CreateDelete(`${path}/${i}`);
  }
}
function* TypedArrayType2(path, current, next) {
  if (!IsTypedArray(next) || current.length !== next.length || globalThis.Object.getPrototypeOf(current).constructor.name !== globalThis.Object.getPrototypeOf(next).constructor.name)
    return yield CreateUpdate(path, next);
  for (let i = 0;i < Math.min(current.length, next.length); i++) {
    yield* Visit15(`${path}/${i}`, current[i], next[i]);
  }
}
function* ValueType2(path, current, next) {
  if (current === next)
    return;
  yield CreateUpdate(path, next);
}
function* Visit15(path, current, next) {
  if (IsStandardObject(current))
    return yield* ObjectType4(path, current, next);
  if (IsArray2(current))
    return yield* ArrayType4(path, current, next);
  if (IsTypedArray(current))
    return yield* TypedArrayType2(path, current, next);
  if (IsValueType(current))
    return yield* ValueType2(path, current, next);
  throw new ValueDiffError(current, "Unable to diff value");
}
function Diff(current, next) {
  return [...Visit15("", current, next)];
}
function IsRootUpdate(edits) {
  return edits.length > 0 && edits[0].path === "" && edits[0].type === "update";
}
function IsIdentity(edits) {
  return edits.length === 0;
}
function Patch(current, edits) {
  if (IsRootUpdate(edits)) {
    return Clone2(edits[0].value);
  }
  if (IsIdentity(edits)) {
    return Clone2(current);
  }
  const clone = Clone2(current);
  for (const edit of edits) {
    switch (edit.type) {
      case "insert": {
        exports_pointer.Set(clone, edit.path, edit.value);
        break;
      }
      case "update": {
        exports_pointer.Set(clone, edit.path, edit.value);
        break;
      }
      case "delete": {
        exports_pointer.Delete(clone, edit.path);
        break;
      }
    }
  }
  return clone;
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/encode/encode.mjs
function Encode(...args) {
  const [schema, references, value] = args.length === 3 ? [args[0], args[1], args[2]] : [args[0], [], args[1]];
  const encoded = HasTransform(schema, references) ? TransformEncode(schema, references, value) : value;
  if (!Check(schema, references, encoded))
    throw new TransformEncodeCheckError(schema, encoded, Errors(schema, references, encoded).First());
  return encoded;
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/mutate/mutate.mjs
function IsStandardObject2(value) {
  return IsObject2(value) && !IsArray2(value);
}

class ValueMutateError extends TypeBoxError {
  constructor(message) {
    super(message);
  }
}
function ObjectType5(root, path, current, next) {
  if (!IsStandardObject2(current)) {
    exports_pointer.Set(root, path, Clone2(next));
  } else {
    const currentKeys = Object.getOwnPropertyNames(current);
    const nextKeys = Object.getOwnPropertyNames(next);
    for (const currentKey of currentKeys) {
      if (!nextKeys.includes(currentKey)) {
        delete current[currentKey];
      }
    }
    for (const nextKey of nextKeys) {
      if (!currentKeys.includes(nextKey)) {
        current[nextKey] = null;
      }
    }
    for (const nextKey of nextKeys) {
      Visit16(root, `${path}/${nextKey}`, current[nextKey], next[nextKey]);
    }
  }
}
function ArrayType5(root, path, current, next) {
  if (!IsArray2(current)) {
    exports_pointer.Set(root, path, Clone2(next));
  } else {
    for (let index = 0;index < next.length; index++) {
      Visit16(root, `${path}/${index}`, current[index], next[index]);
    }
    current.splice(next.length);
  }
}
function TypedArrayType3(root, path, current, next) {
  if (IsTypedArray(current) && current.length === next.length) {
    for (let i = 0;i < current.length; i++) {
      current[i] = next[i];
    }
  } else {
    exports_pointer.Set(root, path, Clone2(next));
  }
}
function ValueType3(root, path, current, next) {
  if (current === next)
    return;
  exports_pointer.Set(root, path, next);
}
function Visit16(root, path, current, next) {
  if (IsArray2(next))
    return ArrayType5(root, path, current, next);
  if (IsTypedArray(next))
    return TypedArrayType3(root, path, current, next);
  if (IsStandardObject2(next))
    return ObjectType5(root, path, current, next);
  if (IsValueType(next))
    return ValueType3(root, path, current, next);
}
function IsNonMutableValue(value) {
  return IsTypedArray(value) || IsValueType(value);
}
function IsMismatchedValue(current, next) {
  return IsStandardObject2(current) && IsArray2(next) || IsArray2(current) && IsStandardObject2(next);
}
function Mutate(current, next) {
  if (IsNonMutableValue(current) || IsNonMutableValue(next))
    throw new ValueMutateError("Only object and array types can be mutated at the root level");
  if (IsMismatchedValue(current, next))
    throw new ValueMutateError("Cannot assign due type mismatch of assignable values");
  Visit16(current, "", current, next);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/parse/parse.mjs
class ParseError extends TypeBoxError {
  constructor(message) {
    super(message);
  }
}
var ParseRegistry;
(function(ParseRegistry2) {
  const registry = new Map([
    ["Assert", (type, references, value) => {
      Assert(type, references, value);
      return value;
    }],
    ["Cast", (type, references, value) => Cast(type, references, value)],
    ["Clean", (type, references, value) => Clean(type, references, value)],
    ["Clone", (_type, _references, value) => Clone2(value)],
    ["Convert", (type, references, value) => Convert(type, references, value)],
    ["Decode", (type, references, value) => HasTransform(type, references) ? TransformDecode(type, references, value) : value],
    ["Default", (type, references, value) => Default5(type, references, value)],
    ["Encode", (type, references, value) => HasTransform(type, references) ? TransformEncode(type, references, value) : value]
  ]);
  function Delete5(key) {
    registry.delete(key);
  }
  ParseRegistry2.Delete = Delete5;
  function Set5(key, callback) {
    registry.set(key, callback);
  }
  ParseRegistry2.Set = Set5;
  function Get4(key) {
    return registry.get(key);
  }
  ParseRegistry2.Get = Get4;
})(ParseRegistry || (ParseRegistry = {}));
var ParseDefault = [
  "Clone",
  "Clean",
  "Default",
  "Convert",
  "Assert",
  "Decode"
];
function ParseValue(operations, type, references, value) {
  return operations.reduce((value2, operationKey) => {
    const operation = ParseRegistry.Get(operationKey);
    if (IsUndefined2(operation))
      throw new ParseError(`Unable to find Parse operation '${operationKey}'`);
    return operation(type, references, value2);
  }, value);
}
function Parse(...args) {
  const [operations, schema, references, value] = args.length === 4 ? [args[0], args[1], args[2], args[3]] : args.length === 3 ? IsArray2(args[0]) ? [args[0], args[1], [], args[2]] : [ParseDefault, args[0], args[1], args[2]] : args.length === 2 ? [ParseDefault, args[0], [], args[1]] : (() => {
    throw new ParseError("Invalid Arguments");
  })();
  return ParseValue(operations, schema, references, value);
}
// ../../node_modules/.bun/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/value/value.mjs
var exports_value2 = {};
__export(exports_value2, {
  ValueErrorIterator: () => ValueErrorIterator,
  Patch: () => Patch,
  Parse: () => Parse,
  Mutate: () => Mutate,
  Hash: () => Hash,
  Errors: () => Errors,
  Equal: () => Equal,
  Encode: () => Encode,
  Edit: () => Edit,
  Diff: () => Diff,
  Default: () => Default5,
  Decode: () => Decode,
  Create: () => Create2,
  Convert: () => Convert,
  Clone: () => Clone2,
  Clean: () => Clean,
  Check: () => Check,
  Cast: () => Cast,
  Assert: () => Assert
});
// ../core/src/config/load.ts
class ConfigError extends Error {
  problems;
  constructor(message, problems) {
    super(message);
    this.name = "ConfigError";
    this.problems = problems;
  }
}
function canonicalPath(p) {
  const absolute = resolve(p);
  let head = absolute;
  const tail = [];
  for (;; ) {
    try {
      const resolved = realpathSync2(head);
      return tail.length === 0 ? resolved : join(resolved, ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head)
        return absolute;
      tail.unshift(basename2(head));
      head = parent;
    }
  }
}
function assertInitiativesUnique(config, describeFor) {
  const ownerByInitiative = {};
  const problems = [];
  for (const alias of Object.keys(config.repos)) {
    for (const id of boundInitiativeIds(config.repos[alias])) {
      const owner = ownerByInitiative[id];
      if (owner !== undefined) {
        problems.push(`initiative ${id} is bound to both repos.${owner} and repos.${alias}`);
        continue;
      }
      ownerByInitiative[id] = alias;
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid global config at ${describeFor}`, problems);
  }
}
function assertRepoAliasesValid(config, describeFor) {
  const problems = [];
  for (const alias of Object.keys(config.repos)) {
    if (alias.trim().length === 0) {
      problems.push(`repos key ${JSON.stringify(alias)} must not be empty or whitespace-only`);
    } else if (/[:/\\]/.test(alias)) {
      problems.push(`repos key ${JSON.stringify(alias)} must not contain ":", "/", or "\\"`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid global config at ${describeFor}`, problems);
  }
}
function assertMergeDetectionReachable(config, describeFor) {
  if (config.loop.mergeDetection)
    return;
  const problems = [];
  for (const alias of Object.keys(config.repos)) {
    const entry = config.repos[alias];
    const merged = mergeRepoSettings(config.repoDefaults, entry);
    if (!merged.pr.required) {
      problems.push(`repos.${alias} has pr.required=false with loop.mergeDetection=false; there would be no path to Done`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid global config at ${describeFor}`, problems);
  }
}
function expandHome(p, home = homedir()) {
  if (p === "~")
    return home;
  if (p.startsWith("~/"))
    return join(home, p.slice(2));
  return p;
}
function formatValidationErrors(schema, value) {
  const problems = [];
  for (const error of exports_value2.Errors(schema, value)) {
    const pointer2 = error.path === "" ? "/" : error.path;
    problems.push(`${pointer2}: ${error.message}`);
  }
  return problems;
}
function readJsonFile(path, describeFor) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Failed to read ${describeFor} at ${path}: ${error.message}`, [
      error.message
    ]);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Failed to parse ${describeFor} at ${path} as JSON`, [error.message]);
  }
}
function defaultAndValidateGlobalConfig(value, describeFor) {
  const defaulted = exports_value2.Default(GlobalConfigSchema, value);
  if (!exports_value2.Check(GlobalConfigSchema, defaulted)) {
    const problems = formatValidationErrors(GlobalConfigSchema, defaulted);
    throw new ConfigError(`Invalid global config${describeFor ? ` at ${describeFor}` : ""}`, problems);
  }
  const config = defaulted;
  assertRepoAliasesValid(config, describeFor);
  assertInitiativesUnique(config, describeFor);
  assertMergeDetectionReachable(config, describeFor);
  return config;
}
function loadGlobalConfig(options) {
  const home = options?.home ?? homedir();
  const path = join(home, ".foreman", "config.json");
  const warnings = [];
  const sources = [];
  let parsed = {};
  if (existsSync3(path)) {
    parsed = readJsonFile(path, "global config");
    sources.push(path);
  } else {
    warnings.push(`No global config found at ${path}; using defaults.`);
  }
  const config = defaultAndValidateGlobalConfig(parsed, path);
  if (Object.keys(config.repos).length === 0) {
    warnings.push("No entries in config.repos; no repo is Foreman-managed yet.");
  }
  return { config, sources, warnings };
}
function mergeRepoSettings(base, override) {
  return {
    baseBranch: override.baseBranch ?? base.baseBranch,
    pr: { ...base.pr, ...override.pr },
    merge: { ...base.merge, ...override.merge },
    branchPattern: override.branchPattern ?? base.branchPattern,
    worktreePattern: override.worktreePattern ?? base.worktreePattern
  };
}
function boundInitiativeIds(entry) {
  return entry.initiatives.map((binding) => typeof binding === "string" ? binding : binding.id);
}
function resolveRepoEntry(config, alias, home) {
  const entry = config.repos[alias];
  if (entry === undefined) {
    throw new ConfigError(`No repos entry named "${alias}"`, [
      `repos.${alias} is unset; add it to ${join(home ?? homedir(), ".foreman", "config.json")}`
    ]);
  }
  return {
    ...mergeRepoSettings(config.repoDefaults, entry),
    alias,
    repoPath: expandHome(entry.path, home),
    team: entry.team ?? null,
    initiativeIds: boundInitiativeIds(entry)
  };
}
function entryForCwd(config, cwd, home) {
  const target = canonicalPath(cwd);
  let bestAlias = null;
  let bestLength = -1;
  for (const alias of Object.keys(config.repos)) {
    const candidate = canonicalPath(expandHome(config.repos[alias].path, home));
    const inside = target === candidate || target.startsWith(`${candidate}${sep}`);
    if (inside && candidate.length > bestLength) {
      bestAlias = alias;
      bestLength = candidate.length;
    }
  }
  if (bestAlias === null) {
    throw new ConfigError(`No repos entry matches the working directory ${target}`, [
      `add an entry under repos in ${join(home ?? homedir(), ".foreman", "config.json")}, or run foreman repo <alias>`
    ]);
  }
  return resolveRepoEntry(config, bestAlias, home);
}
function resolveLinearApiKey(config, env = process.env) {
  const fromEnv = env[config.linear.apiKeyEnv];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  if (config.linear.apiKeyFile !== null) {
    const path = expandHome(config.linear.apiKeyFile);
    if (existsSync3(path)) {
      const contents = readFileSync(path, "utf8");
      const firstLine = (contents.split(`
`)[0] ?? "").trim();
      if (firstLine.length > 0)
        return firstLine;
    }
  }
  throw new ConfigError(`No Linear API key found. Set the ${config.linear.apiKeyEnv} environment variable, ` + `or point linear.apiKeyFile at a file whose first line is the key.`, [`env.${config.linear.apiKeyEnv} is unset`, `linear.apiKeyFile is ${config.linear.apiKeyFile ?? "unset"}`]);
}
function lockTtlMs(config) {
  return 2 * config.agent.maxRuntimeMs + config.agent.lockTtlMarginMs;
}
// ../core/src/confirm.ts
import * as readline from "node:readline";
var YOLO_CONFIRMER = {
  confirm: () => Promise.resolve(true),
  close: () => {}
};
class TtyConfirmer {
  #input;
  #output;
  #log;
  #rl = null;
  #closed = false;
  constructor(options) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#log = options.log;
  }
  #interface() {
    if (!this.#rl) {
      this.#rl = readline.createInterface({ input: this.#input, output: this.#output });
    }
    return this.#rl;
  }
  async confirm(request) {
    if (this.#closed)
      return false;
    this.#log(`confirm: ${request.summary}`);
    for (const line of request.detail ?? [])
      this.#log(`  ${line}`);
    const answer = await new Promise((resolve2) => {
      let settled = false;
      const finish = (value) => {
        if (settled)
          return;
        settled = true;
        resolve2(value);
      };
      const rl = this.#interface();
      rl.once("close", () => finish(null));
      try {
        rl.question("Proceed? [y/N] ", (line) => finish(line));
      } catch {
        finish(null);
      }
    });
    if (answer === null) {
      this.#log("confirmation channel closed; declining");
      return false;
    }
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  }
  close() {
    this.#closed = true;
    this.#rl?.close();
    this.#rl = null;
  }
}
// ../core/src/control/paths.ts
import { createHash } from "node:crypto";
import { join as join2 } from "node:path";
import { tmpdir } from "node:os";
import { existsSync as existsSync4, lstatSync, mkdirSync, chmodSync } from "node:fs";
var INTAKE_LOOP_ID = "intake";
function parseLoopId(id) {
  if (id === INTAKE_LOOP_ID)
    return { kind: "intake", alias: null };
  if (id.startsWith("repo:") && id.length > "repo:".length) {
    return { kind: "repo", alias: id.slice("repo:".length) };
  }
  throw new Error(`unrecognized loop id: ${id}`);
}
function stateRoot(config, home) {
  return expandHome(config.loop.stateDir, home);
}
function assertPrivateRuntimeDir(dir) {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to use ${dir} for the control socket: it is a symlink`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`refusing to use ${dir} for the control socket: not owned by the current user`);
  }
}
function socketRuntimeDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    assertPrivateRuntimeDir(xdg);
    return xdg;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = join2(tmpdir(), `foreman-${uid}`);
  if (!existsSync4(dir))
    mkdirSync(dir, { recursive: true, mode: 448 });
  assertPrivateRuntimeDir(dir);
  chmodSync(dir, 448);
  return dir;
}
var SOCKET_PATH_SAFE_LIMIT = 100;
function socketPathFor(dir) {
  const candidate = join2(dir, "control.sock");
  if (candidate.length <= SOCKET_PATH_SAFE_LIMIT)
    return candidate;
  const digest = createHash("sha1").update(dir).digest("hex").slice(0, 16);
  return join2(socketRuntimeDir(), `foreman-${digest}.sock`);
}
function loopPaths(config, id, home) {
  const parsed = parseLoopId(id);
  const root = stateRoot(config, home);
  const dir = parsed.kind === "intake" ? join2(root, "intake") : join2(root, parsed.alias);
  return {
    dir,
    lock: join2(dir, "loop.lock"),
    bookkeeping: join2(dir, "bookkeeping.json"),
    status: join2(dir, "status.json"),
    socket: socketPathFor(dir),
    log: join2(dir, "loop.log")
  };
}
// ../core/src/control/protocol.ts
var LoopModeSchema2 = Type.Union([Type.Literal("confirm"), Type.Literal("yolo")]);
var LOOP_MODES = ["confirm", "yolo"];
function isLoopMode(value) {
  return typeof value === "string" && LOOP_MODES.includes(value);
}
var RunStateSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("draining"),
  Type.Literal("stopped")
]);
var AgentStatusSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("settled"),
  Type.Literal("lost"),
  Type.Literal("unknown")
]);
var LoopKindSchema = Type.Union([Type.Literal("repo"), Type.Literal("intake")]);
var WorkerViewSchema = Type.Object({
  name: Type.String(),
  cadenceMs: Type.Number(),
  lastRunAt: Type.Union([Type.String(), Type.Null()]),
  nextRunAt: Type.Union([Type.String(), Type.Null()]),
  running: Type.Boolean(),
  dispatched: Type.Number(),
  skipped: Type.Number(),
  errors: Type.Number(),
  lastSkips: Type.Array(Type.Object({
    issueId: Type.Union([Type.String(), Type.Null()]),
    code: Type.String(),
    message: Type.String()
  }, { additionalProperties: false })),
  lastError: Type.Union([Type.String(), Type.Null()])
}, { additionalProperties: false });
var AgentViewSchema = Type.Object({
  dispatchId: Type.String(),
  agent: Type.String(),
  stage: Type.String(),
  issueId: Type.Union([Type.String(), Type.Null()]),
  projectId: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.String(),
  ageMs: Type.Number(),
  status: AgentStatusSchema,
  herdr: Type.Union([
    Type.Object({ paneId: Type.String(), agentName: Type.String() }, { additionalProperties: false }),
    Type.Null()
  ]),
  pid: Type.Union([Type.Number(), Type.Null()]),
  worktree: Type.Union([Type.String(), Type.Null()]),
  ttlMs: Type.Number(),
  pastTtl: Type.Boolean()
}, { additionalProperties: false });
var BoardCountsSchema = Type.Object({
  backlog: Type.Number(),
  todo: Type.Number(),
  inProgress: Type.Number(),
  inReview: Type.Number(),
  blocked: Type.Number(),
  proposals: Type.Number(),
  readyBuffer: Type.Number(),
  triageInbox: Type.Number()
}, { additionalProperties: false });
var BlockedItemSchema = Type.Object({
  issueId: Type.String(),
  title: Type.String(),
  type: Type.String(),
  question: Type.String(),
  detectedAt: Type.Union([Type.String(), Type.Null()]),
  options: Type.Array(Type.Object({ label: Type.String(), tradeoff: Type.String() }, { additionalProperties: false })),
  recommendation: Type.Union([Type.String(), Type.Null()])
}, { additionalProperties: false });
var ProposalItemSchema = Type.Object({
  issueId: Type.String(),
  title: Type.String(),
  destination: Type.String(),
  proposedPriority: Type.Union([Type.Number(), Type.Null()]),
  duplicateOf: Type.Union([Type.String(), Type.Null()]),
  proposedAt: Type.String()
}, { additionalProperties: false });
var DecisionItemSchema = Type.Object({
  issueId: Type.String(),
  stage: Type.String(),
  kind: Type.String(),
  attempts: Type.Number(),
  detectedAt: Type.String()
}, { additionalProperties: false });
var QueueItemSchema = Type.Object({
  issueId: Type.String(),
  title: Type.String(),
  state: Type.String(),
  priority: Type.Number(),
  estimate: Type.Union([Type.Number(), Type.Null()]),
  labels: Type.Array(Type.String()),
  assignee: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
  url: Type.String()
}, { additionalProperties: false });
var LoopSnapshotSchema = Type.Object({
  loop: Type.Object({
    id: Type.String(),
    kind: LoopKindSchema,
    label: Type.String(),
    alias: Type.Union([Type.String(), Type.Null()]),
    team: Type.Union([Type.String(), Type.Null()]),
    repoPath: Type.Union([Type.String(), Type.Null()]),
    initiativeIds: Type.Array(Type.String()),
    pid: Type.Number(),
    startedAt: Type.String(),
    version: Type.String()
  }, { additionalProperties: false }),
  runtime: Type.Object({
    state: RunStateSchema,
    mode: LoopModeSchema2,
    dispatcher: Type.Union([Type.Literal("herdr"), Type.Literal("print"), Type.Literal("none")]),
    pausedAt: Type.Union([Type.String(), Type.Null()]),
    lastTickAt: Type.Union([Type.String(), Type.Null()]),
    nextTickAt: Type.Union([Type.String(), Type.Null()]),
    ticks: Type.Number(),
    uptimeMs: Type.Number()
  }, { additionalProperties: false }),
  workers: Type.Array(WorkerViewSchema),
  agents: Type.Array(AgentViewSchema),
  wip: Type.Object({
    global: Type.Object({ used: Type.Number(), cap: Type.Number() }, { additionalProperties: false }),
    byStage: Type.Array(Type.Object({ stage: Type.String(), used: Type.Number(), cap: Type.Number() }, { additionalProperties: false }))
  }, { additionalProperties: false }),
  backpressure: Type.Object({
    tripped: Type.Boolean(),
    blockedCount: Type.Number(),
    threshold: Type.Number(),
    reason: Type.Union([Type.String(), Type.Null()])
  }, { additionalProperties: false }),
  board: BoardCountsSchema,
  queues: Type.Object({
    blocked: Type.Array(BlockedItemSchema),
    proposals: Type.Array(ProposalItemSchema),
    decisions: Type.Array(DecisionItemSchema),
    pipeline: Type.Array(QueueItemSchema)
  }, { additionalProperties: false }),
  linear: Type.Object({
    ok: Type.Boolean(),
    lastPollAt: Type.Union([Type.String(), Type.Null()]),
    lastError: Type.Union([Type.String(), Type.Null()]),
    requests: Type.Number()
  }, { additionalProperties: false }),
  history: Type.Object({ dispatchesPerTick: Type.Array(Type.Number()) }, { additionalProperties: false })
}, { additionalProperties: false });
var StatusFileSchema = Type.Object({
  schema: Type.Literal(1),
  writtenAt: Type.String(),
  snapshot: LoopSnapshotSchema
}, { additionalProperties: false });
var ControlOpSchema = Type.Union([
  Type.Literal("hello"),
  Type.Literal("snapshot"),
  Type.Literal("subscribe"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("stop"),
  Type.Literal("tick"),
  Type.Literal("setMode"),
  Type.Literal("patchConfig"),
  Type.Literal("reload"),
  Type.Literal("attachAgent"),
  Type.Literal("killAgent"),
  Type.Literal("logs")
]);
var ControlRequestSchema = Type.Object({
  id: Type.Number(),
  op: ControlOpSchema,
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
var LogEventSchema = Type.Object({
  event: Type.Literal("log"),
  seq: Type.Number(),
  at: Type.String(),
  level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
  line: Type.String()
}, { additionalProperties: false });
var StateEventSchema = Type.Object({
  event: Type.Literal("state"),
  seq: Type.Number(),
  at: Type.String(),
  runtime: LoopSnapshotSchema.properties.runtime
}, { additionalProperties: false });
var TickEventSchema = Type.Object({
  event: Type.Literal("tick"),
  seq: Type.Number(),
  at: Type.String(),
  worker: Type.String(),
  dispatched: Type.Number(),
  skipped: Type.Number(),
  errors: Type.Number()
}, { additionalProperties: false });
var DispatchEventSchema = Type.Object({
  event: Type.Literal("dispatch"),
  seq: Type.Number(),
  at: Type.String(),
  agent: AgentViewSchema
}, { additionalProperties: false });
var SnapshotEventSchema = Type.Object({
  event: Type.Literal("snapshot"),
  seq: Type.Number(),
  at: Type.String(),
  snapshot: LoopSnapshotSchema
}, { additionalProperties: false });
var ControlEventSchema = Type.Union([
  LogEventSchema,
  StateEventSchema,
  TickEventSchema,
  DispatchEventSchema,
  SnapshotEventSchema
]);
function encodeFrame(value) {
  return `${JSON.stringify(value)}
`;
}
var MAX_BUFFER_BYTES = 4 * 1024 * 1024;

class FrameDecoder {
  #buffer = "";
  push(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_BUFFER_BYTES) {
      this.#buffer = "";
      return [];
    }
    const frames = [];
    let newlineIndex = this.#buffer.indexOf(`
`);
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          frames.push(JSON.parse(line));
        } catch {}
      }
      newlineIndex = this.#buffer.indexOf(`
`);
    }
    return frames;
  }
  get pending() {
    return this.#buffer.length;
  }
}
// ../core/src/control/server.ts
import { createServer } from "node:net";
import { chmodSync as chmodSync2, existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync2, unlinkSync } from "node:fs";
import { dirname as dirname2 } from "node:path";

// ../core/src/control/client.ts
import { createConnection } from "node:net";
class ControlClient {
  #socketPath;
  #timeoutMs;
  #decoder = new FrameDecoder;
  #pending = new Map;
  #subscribers = new Set;
  #closeHandlers = new Set;
  #socket = null;
  #nextId = 1;
  #closeNotified = false;
  constructor(options) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs ?? 2000;
  }
  async connect() {
    const socket = await this.#open();
    this.#socket = socket;
    return this.request("hello");
  }
  #open() {
    const { promise, resolve: resolve2, reject } = Promise.withResolvers();
    const socket = createConnection(this.#socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to control socket ${this.#socketPath}`));
    }, this.#timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      this.#closeNotified = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => this.#onData(chunk));
      socket.on("close", () => this.#onClose(null));
      socket.on("error", (error) => {
        clearTimeout(timer);
        this.#onClose(error);
      });
      resolve2(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      const suffix = error.code ? ` (${error.code})` : "";
      reject(new Error(`cannot connect to control socket ${this.#socketPath}${suffix}`));
    });
    return promise;
  }
  #onData(chunk) {
    for (const frame of this.#decoder.push(chunk))
      this.#onFrame(frame);
  }
  #onFrame(frame) {
    const record = frame;
    if (typeof record.id === "number") {
      this.#onResponse(frame);
      return;
    }
    if (typeof record.event === "string") {
      for (const subscriber of this.#subscribers) {
        try {
          subscriber(frame);
        } catch (error) {
          console.error(`control client subscriber threw: ${error.message}`);
        }
      }
    }
  }
  #onResponse(response) {
    const pending = this.#pending.get(response.id);
    if (!pending)
      return;
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.data);
    } else {
      const error = new Error(response.error.message);
      error.code = response.error.code;
      pending.reject(error);
    }
  }
  #onClose(error) {
    if (this.#closeNotified)
      return;
    this.#closeNotified = true;
    this.#socket = null;
    for (const pending of this.#pending.values()) {
      pending.reject(error ?? new Error(`control socket ${this.#socketPath} closed`));
    }
    this.#pending.clear();
    for (const handler of this.#closeHandlers) {
      try {
        handler(error);
      } catch (err) {
        console.error(`control client close handler threw: ${err.message}`);
      }
    }
  }
  request(op, params) {
    const socket = this.#socket;
    if (!socket)
      return Promise.reject(new Error("control client is not connected"));
    const id = this.#nextId++;
    const { promise, resolve: resolve2, reject } = Promise.withResolvers();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`control request "${op}" timed out`));
    }, this.#timeoutMs);
    this.#pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve2(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.write(encodeFrame({ id, op, params }));
    return promise;
  }
  async subscribe(handler, onSubscribed) {
    this.#subscribers.add(handler);
    try {
      const response = await this.request("subscribe");
      if (onSubscribed) {
        try {
          onSubscribed(response);
        } catch (error) {
          console.error(`control client subscription handler threw: ${error.message}`);
        }
      }
      return () => {
        this.#subscribers.delete(handler);
      };
    } catch (error) {
      this.#subscribers.delete(handler);
      throw error;
    }
  }
  onClose(handler) {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }
  get connected() {
    return this.#socket !== null;
  }
  close() {
    this.#socket?.destroy();
    this.#socket = null;
  }
}
async function probeSocket(socketPath, timeoutMs = 500) {
  const client = new ControlClient({ socketPath, timeoutMs });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

// ../core/src/control/server.ts
var MAX_QUEUED_WRITE_BYTES = 8 * 1024 * 1024;
function describeHolder(lockPath) {
  if (!existsSync5(lockPath))
    return "another process";
  try {
    const info = JSON.parse(readFileSync2(lockPath, "utf8"));
    return typeof info.pid === "number" ? `pid ${info.pid}` : "another process";
  } catch {
    return "another process";
  }
}

class ControlServer {
  #socketPath;
  #lockPath;
  #handlers;
  #info;
  #logBufferSize;
  #log;
  #connections = new Set;
  #server = null;
  #bound = false;
  #seq = 0;
  #logRing = [];
  constructor(options) {
    this.#socketPath = options.socketPath;
    this.#lockPath = options.lockPath ?? `${dirname2(options.socketPath)}/loop.lock`;
    this.#handlers = options.handlers;
    this.#info = options.info;
    this.#logBufferSize = options.logBufferSize ?? 500;
    this.#log = options.log ?? (() => {});
  }
  async listen() {
    if (existsSync5(this.#socketPath)) {
      const alive = await probeSocket(this.#socketPath);
      if (alive) {
        throw new Error(`control socket ${this.#socketPath} is already held by ${describeHolder(this.#lockPath)}`);
      }
      unlinkSync(this.#socketPath);
    }
    mkdirSync2(dirname2(this.#socketPath), { recursive: true, mode: 448 });
    const server = createServer((socket) => this.#handleConnection(socket));
    this.#server = server;
    const { promise, resolve: resolve2, reject } = Promise.withResolvers();
    server.once("error", reject);
    const previousUmask = process.umask(63);
    try {
      server.listen(this.#socketPath, () => {
        server.removeListener("error", reject);
        this.#bound = true;
        resolve2();
      });
      await promise;
    } finally {
      process.umask(previousUmask);
    }
    chmodSync2(this.#socketPath, 384);
  }
  async close() {
    for (const connection of this.#connections) {
      connection.socket.destroy();
    }
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    if (server) {
      const { promise, resolve: resolve2 } = Promise.withResolvers();
      server.close(() => resolve2());
      await promise;
    }
    if (this.#bound && existsSync5(this.#socketPath))
      unlinkSync(this.#socketPath);
  }
  broadcast(event) {
    const stamped = { ...event, seq: ++this.#seq, at: new Date().toISOString() };
    const frame = encodeFrame(stamped);
    for (const connection of this.#connections) {
      if (!connection.subscribed)
        continue;
      this.#send(connection, frame);
    }
  }
  publishLog(level, line) {
    const record = { seq: ++this.#seq, at: new Date().toISOString(), level, line };
    this.#logRing.push(record);
    if (this.#logRing.length > this.#logBufferSize)
      this.#logRing.shift();
    const frame = encodeFrame({ event: "log", ...record });
    for (const connection of this.#connections) {
      if (!connection.subscribed)
        continue;
      this.#send(connection, frame);
    }
  }
  recentLogs(sinceSeq = 0, limit = this.#logBufferSize) {
    return this.#logRing.filter((record) => record.seq > sinceSeq).slice(-limit);
  }
  get clientCount() {
    return this.#connections.size;
  }
  get listening() {
    return this.#server !== null;
  }
  #handleConnection(socket) {
    socket.setEncoding("utf8");
    if (typeof socket.setNoDelay === "function")
      socket.setNoDelay(true);
    const connection = {
      socket,
      decoder: new FrameDecoder,
      subscribed: false,
      writeQueue: [],
      queuedBytes: 0,
      paused: false
    };
    this.#connections.add(connection);
    socket.on("data", (chunk) => {
      const frames = connection.decoder.push(chunk);
      for (const frame of frames)
        this.#handleFrame(connection, frame);
    });
    socket.on("error", () => {
      this.#connections.delete(connection);
    });
    socket.on("close", () => {
      this.#connections.delete(connection);
    });
  }
  #send(connection, frame) {
    if (connection.paused) {
      this.#enqueue(connection, frame);
      return;
    }
    const ok = connection.socket.write(frame);
    if (!ok) {
      connection.paused = true;
      connection.socket.once("drain", () => this.#drain(connection));
    }
  }
  #enqueue(connection, frame) {
    connection.writeQueue.push(frame);
    connection.queuedBytes += Buffer.byteLength(frame);
    if (connection.queuedBytes > MAX_QUEUED_WRITE_BYTES) {
      connection.socket.destroy();
    }
  }
  #drain(connection) {
    connection.paused = false;
    while (connection.writeQueue.length > 0) {
      const frame = connection.writeQueue.shift();
      connection.queuedBytes -= Buffer.byteLength(frame);
      const ok = connection.socket.write(frame);
      if (!ok) {
        connection.paused = true;
        connection.socket.once("drain", () => this.#drain(connection));
        return;
      }
    }
  }
  #handleFrame(connection, frame) {
    if (!exports_value2.Check(ControlRequestSchema, frame)) {
      const id = frame?.id;
      if (typeof id === "number") {
        this.#send(connection, encodeFrame({ id, ok: false, error: { code: "invalid-frame", message: "malformed control request" } }));
      }
      return;
    }
    this.#dispatch(connection, frame);
  }
  async#dispatch(connection, request) {
    const response = await this.#run(connection, request.op, request.params);
    const payload = { id: request.id, ...response };
    this.#send(connection, encodeFrame(payload));
    if (request.op === "subscribe" && response.ok) {
      connection.subscribed = true;
    }
  }
  async#run(connection, op, params) {
    try {
      switch (op) {
        case "hello":
          return { ok: true, data: this.#info };
        case "subscribe":
          return { ok: true, data: { recentLogs: this.recentLogs() } };
        case "logs": {
          const sinceSeq = params?.sinceSeq ?? 0;
          if (typeof sinceSeq !== "number" || !Number.isFinite(sinceSeq) || sinceSeq < 0) {
            return {
              ok: false,
              error: { code: "invalid-params", message: `invalid sinceSeq: ${String(sinceSeq)}` }
            };
          }
          return { ok: true, data: { recentLogs: this.recentLogs(sinceSeq) } };
        }
        case "snapshot":
          return { ok: true, data: await this.#handlers.snapshot() };
        case "pause":
          await this.#handlers.pause();
          return { ok: true };
        case "resume":
          await this.#handlers.resume();
          return { ok: true };
        case "stop": {
          const mode = params?.mode ?? "graceful";
          if (mode !== "graceful" && mode !== "now") {
            return { ok: false, error: { code: "invalid-params", message: `invalid stop mode: ${String(mode)}` } };
          }
          await this.#handlers.stop(mode);
          return { ok: true };
        }
        case "tick": {
          const workers = params?.workers;
          if (workers !== undefined && (!Array.isArray(workers) || !workers.every((worker) => typeof worker === "string"))) {
            return {
              ok: false,
              error: { code: "invalid-params", message: `invalid workers: ${JSON.stringify(workers)}` }
            };
          }
          await this.#handlers.tick(workers);
          return { ok: true };
        }
        case "setMode": {
          const mode = params?.mode;
          if (!isLoopMode(mode)) {
            return { ok: false, error: { code: "invalid-params", message: `invalid mode: ${String(mode)}` } };
          }
          await this.#handlers.setMode(mode);
          return { ok: true };
        }
        case "patchConfig":
          await this.#handlers.patchConfig(params?.patch);
          return { ok: true };
        case "reload":
          await this.#handlers.reload();
          return { ok: true };
        case "attachAgent":
          await this.#handlers.attachAgent(String(params?.dispatchId ?? ""));
          return { ok: true };
        case "killAgent":
          await this.#handlers.killAgent(String(params?.dispatchId ?? ""));
          return { ok: true };
        default:
          return { ok: false, error: { code: "unknown-op", message: `unknown op: ${op}` } };
      }
    } catch (error) {
      this.#log(`control handler ${op} threw: ${error.message}`);
      return {
        ok: false,
        error: { code: "handler-error", message: error instanceof Error ? error.message : String(error) }
      };
    }
  }
}
// ../core/src/control/registry.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync, unlinkSync as unlinkSync2, writeFileSync } from "node:fs";
function statusStaleThresholdMs(cadenceMinutes) {
  return cadenceMinutes * 2 * 60000 + 30000;
}
function readStatusFile(path) {
  if (!existsSync6(path))
    return null;
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    return exports_value2.Check(StatusFileSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}
// ../core/src/domain/priority.ts
var PRIORITY = {
  None: 0,
  Urgent: 1,
  High: 2,
  Medium: 3,
  Low: 4
};
var PRIORITY_NAMES = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low"
};
function priorityName(value) {
  return PRIORITY_NAMES[value] ?? `Unknown(${value})`;
}
// ../core/src/ensure.ts
var MAINTENANCE_PROJECT_NAME = "Maintenance";
async function ensureMaintenanceProjects(linear, input) {
  const reports = [];
  for (const initiativeId of input.initiativeIds) {
    const initiative = await linear.initiative(initiativeId);
    if (!initiative) {
      throw new ConfigError(`Bound initiative "${initiativeId}" does not exist in Linear`, [
        "the registry binds initiatives by id (SPEC §3.10) — check the id in the repo's",
        `"initiatives" list against the workspace, or remove the stale binding`
      ]);
    }
    const projects = await linear.initiativeProjects(initiativeId);
    const existing = projects.find((project2) => project2.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase());
    if (existing) {
      reports.push({
        initiativeId,
        initiativeName: initiative.name,
        projectId: existing.id,
        created: false
      });
      continue;
    }
    const proceed = await input.confirmer.confirm({
      kind: "linear-write",
      summary: `create the Maintenance project under initiative ${initiative.name}`
    });
    if (!proceed) {
      reports.push({
        initiativeId,
        initiativeName: initiative.name,
        projectId: null,
        created: false
      });
      continue;
    }
    const project = await linear.createProject({
      name: MAINTENANCE_PROJECT_NAME,
      teamIds: [input.teamId]
    });
    try {
      await linear.addProjectToInitiative({ projectId: project.id, initiativeId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`created Maintenance project ${project.id} for initiative "${initiative.name}" ` + `(${initiativeId}) but failed to attach it: ${reason} — the project exists but is ` + `unattached; link it to the initiative or delete it by hand`);
    }
    reports.push({
      initiativeId,
      initiativeName: initiative.name,
      projectId: project.id,
      created: true
    });
  }
  return reports;
}
// ../core/src/gates/types.ts
function gateSummary(name, result) {
  if (result.ok)
    return `${name} gate: pass`;
  return `${name} gate: fail — ${result.failures.map((f) => f.message).join("; ")}`;
}
// ../core/src/linear/issue.ts
function blockedByRelations(issue) {
  return issue.relations.filter((relation) => relation.type === "blocks" && relation.direction === "incoming");
}
function incompleteBlockers(issue) {
  return blockedByRelations(issue).filter((relation) => !blockerIsResolved(relation.other.state));
}
var ACCEPTANCE_CRITERIA_HEADING = /^##\s+Acceptance Criteria\s*$/m;
var NEXT_HEADING = /^##\s+/m;
var CHECKBOX_LINE = /^-\s*\[[ xX]\]\s*(.+)$/;
function sectionBody(description, heading) {
  const match = heading.exec(description);
  if (!match)
    return null;
  const start = match.index + match[0].length;
  NEXT_HEADING.lastIndex = 0;
  const rest = description.slice(start);
  const next = NEXT_HEADING.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
function acceptanceCriteria(description) {
  if (!description)
    return [];
  const body = sectionBody(description, ACCEPTANCE_CRITERIA_HEADING);
  if (!body)
    return [];
  const criteria = [];
  for (const line of body.split(`
`)) {
    const match = CHECKBOX_LINE.exec(line.trim());
    if (match?.[1])
      criteria.push(match[1].trim());
  }
  return criteria;
}
function hasAcceptanceCriteria(description) {
  return acceptanceCriteria(description).length > 0;
}

// ../core/src/gates/refinement.ts
var MAX_REFINED_ESTIMATE = 3;
function refinementGate(issue, membership) {
  const failures = [];
  if (issue.project === null) {
    failures.push({
      code: "missing-project",
      message: "Issue has no project."
    });
  }
  if (membership !== undefined) {
    if (membership.initiativeCount === 0) {
      failures.push({
        code: "missing-initiative",
        message: "Project belongs to no initiative (SPEC §4.0)."
      });
    } else if (membership.initiativeCount > 1) {
      failures.push({
        code: "ambiguous-initiative",
        message: `Project belongs to ${membership.initiativeCount} initiatives; exactly one is required (SPEC §4.0).`
      });
    }
  }
  if (typeLabel(issue) === null) {
    failures.push({
      code: "missing-type-label",
      message: "No `type:` label."
    });
  }
  if (issue.priority === PRIORITY.None) {
    failures.push({
      code: "priority-none",
      message: "Priority is unset (`None`)."
    });
  }
  if (!hasAcceptanceCriteria(issue.description)) {
    failures.push({
      code: "missing-acceptance-criteria",
      message: "Description has no `## Acceptance Criteria` section with at least one item."
    });
  }
  if (issue.estimate === null) {
    failures.push({
      code: "missing-estimate",
      message: "Estimate is unset."
    });
  } else if (issue.estimate > MAX_REFINED_ESTIMATE) {
    failures.push({
      code: "estimate-too-large",
      message: `Estimate ${issue.estimate} exceeds ${MAX_REFINED_ESTIMATE}; split the issue (SPEC §4.6).`
    });
  }
  const blocked = blockedLabel(issue);
  if (blocked !== null) {
    failures.push({
      code: "blocked-label-present",
      message: `Has \`${blocked}\` label.`
    });
  }
  return { ok: failures.length === 0, failures };
}
// ../core/src/gates/implementation.ts
function implementationGate(issue, membership) {
  const failures = [...refinementGate(issue, membership).failures];
  if (!hasLabel(issue, AGENT_LABEL.ready)) {
    failures.push({
      code: "missing-agent-ready",
      message: `Missing \`${AGENT_LABEL.ready}\` label.`
    });
  }
  if (hasLabel(issue, AGENT_LABEL.running)) {
    failures.push({
      code: "agent-running",
      message: `Has \`${AGENT_LABEL.running}\` label — already dispatched.`
    });
  }
  if (hasLabel(issue, AGENT_LABEL.handsOff)) {
    failures.push({
      code: "agent-hands-off",
      message: `Has \`${AGENT_LABEL.handsOff}\` label.`
    });
  }
  const blockers = incompleteBlockers(issue);
  if (blockers.length > 0) {
    failures.push({
      code: "incomplete-blockers",
      message: `${blockers.length} incomplete blocker(s): ${blockers.map((relation) => relation.other.identifier).join(", ")}.`
    });
  }
  return { ok: failures.length === 0, failures };
}
// ../core/src/gates/review.ts
function reviewGate(input) {
  const { issue, review, headSha, ciStatus, prOpen, prRequired, ciRequired } = input;
  const failures = [];
  if (review === null) {
    failures.push({
      code: "missing-review",
      message: "No ReviewResult on record."
    });
  } else if (headSha === null || review.reviewedSha !== headSha) {
    failures.push({
      code: "stale-review",
      message: `ReviewResult reviewed ${review.reviewedSha}, but head is ${headSha ?? "unknown"}.`
    });
  }
  if (ciRequired && ciStatus !== "success") {
    failures.push({
      code: "ci-not-green",
      message: `CI status is \`${ciStatus}\`, not \`success\`.`
    });
  }
  if (review !== null) {
    const blocking = review.findings.filter((finding) => finding.severity === "blocking");
    if (blocking.length > 0) {
      failures.push({
        code: "blocking-findings",
        message: `${blocking.length} outstanding blocking finding(s).`
      });
    }
    const requiredCriteria = acceptanceCriteria(issue.description);
    const unchecked = review.criteriaVerification.filter((entry) => !entry.satisfied);
    if (unchecked.length > 0 || review.criteriaVerification.length < requiredCriteria.length) {
      failures.push({
        code: "unverified-criteria",
        message: `${unchecked.length} criterion/criteria unchecked or unverified against the issue's list.`
      });
    }
    if (!review.dodSatisfied) {
      failures.push({
        code: "dod-unsatisfied",
        message: "Definition of Done not satisfied."
      });
    }
  }
  if (prRequired && !prOpen) {
    failures.push({
      code: "pr-not-open",
      message: "PR mode requires an open PR."
    });
  }
  return { ok: failures.length === 0, failures };
}
// ../core/src/github/client.ts
class DirtyWorkingTreeError extends Error {
  constructor(repoPath) {
    super(`${repoPath} has uncommitted changes; commit or stash them before merging locally`);
    this.name = "DirtyWorkingTreeError";
  }
}

class GitHubClient {
  #runner;
  constructor(options) {
    this.#runner = options?.runner ?? nodeRunner;
  }
  async prForBranch(repoPath, branch, options) {
    const argv = [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      options?.state ?? "open",
      "--json",
      "number,url,headRefOid,state,isDraft,mergeable,baseRefName",
      "--limit",
      "20"
    ];
    if (options?.base)
      argv.push("--base", options.base);
    const { stdout } = await this.#runner.run(argv, { cwd: repoPath });
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const entries = JSON.parse(trimmed);
    const entry = options?.state === "all" ? entries.find((candidate) => candidate.state === "MERGED") ?? entries[0] : entries[0];
    if (!entry) {
      return null;
    }
    return {
      number: entry.number,
      url: entry.url,
      headSha: entry.headRefOid,
      state: entry.state,
      isDraft: entry.isDraft,
      mergeable: entry.mergeable === "UNKNOWN" ? null : entry.mergeable === "MERGEABLE",
      baseBranch: entry.baseRefName
    };
  }
  async createPr(repoPath, options) {
    const args = [
      "gh",
      "pr",
      "create",
      "--title",
      options.title,
      "--body",
      options.body,
      "--head",
      options.head,
      "--base",
      options.base
    ];
    if (options.draft)
      args.push("--draft");
    await this.#runner.run(args, { cwd: repoPath });
    const info = await this.prForBranch(repoPath, options.head);
    if (!info) {
      throw new Error(`gh pr create reported success but no PR was found for ${options.head}`);
    }
    return { number: info.number, url: info.url, headSha: info.headSha };
  }
  async prDiff(repoPath, number) {
    const { stdout } = await this.#runner.run(["gh", "pr", "diff", String(number)], { cwd: repoPath });
    return stdout;
  }
  async ciStatus(repoPath, ref) {
    const { stdout } = await this.#runner.run([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/{owner}/{repo}/commits/${ref}/check-runs`
    ], { cwd: repoPath });
    const pages = JSON.parse(stdout);
    const runs = pages.flatMap((page) => page.check_runs);
    if (runs.length === 0) {
      return "none";
    }
    if (runs.some((run) => run.status !== "completed")) {
      return "pending";
    }
    if (runs.some((run) => run.conclusion !== "success" && run.conclusion !== "neutral")) {
      return "failure";
    }
    return "success";
  }
  async mergePr(repoPath, number, strategy, deleteBranch) {
    const strategyFlag = strategy === "squash" ? "--squash" : strategy === "rebase" ? "--rebase" : "--merge";
    const argv = ["gh", "pr", "merge", String(number), strategyFlag];
    if (deleteBranch) {
      argv.push("--delete-branch");
    }
    await this.#runner.run(argv, { cwd: repoPath });
  }
  async isMerged(repoPath, number) {
    const { stdout } = await this.#runner.run(["gh", "pr", "view", String(number), "--json", "state"], { cwd: repoPath });
    const parsed = JSON.parse(stdout);
    return parsed.state === "MERGED";
  }
  async mergedBranches(repoPath, base, branches) {
    const merged = [];
    for (const branch of branches) {
      const { stdout } = await this.#runner.run(["git", "branch", "--merged", base, "--list", branch], { cwd: repoPath });
      if (stdout.trim().length > 0) {
        merged.push(branch);
      }
    }
    return merged;
  }
  async mergeBranchLocally(repoPath, branch, baseBranch, strategy, deleteBranch) {
    const status = await this.#runner.run(["git", "status", "--porcelain"], { cwd: repoPath });
    if (status.stdout.trim().length > 0) {
      throw new DirtyWorkingTreeError(repoPath);
    }
    const startingRef = (await this.#runner.run(["git", "symbolic-ref", "--short", "-q", "HEAD"], {
      cwd: repoPath
    }).catch(() => this.#runner.run(["git", "rev-parse", "HEAD"], { cwd: repoPath }))).stdout.trim();
    let mergeCommit;
    try {
      await this.#runner.run(["git", "checkout", baseBranch], { cwd: repoPath });
      await this.#runner.run(["git", "pull", "origin", baseBranch], { cwd: repoPath });
      if (strategy === "squash") {
        await this.#runner.run(["git", "merge", "--squash", branch], { cwd: repoPath });
        await this.#runner.run(["git", "commit", "-m", `Merge branch '${branch}' (squash)`], { cwd: repoPath });
      } else if (strategy === "rebase") {
        await this.#runner.run(["git", "rebase", branch], { cwd: repoPath });
      } else {
        await this.#runner.run(["git", "merge", "--no-ff", branch], { cwd: repoPath });
      }
      await this.#runner.run(["git", "push", "origin", baseBranch], { cwd: repoPath });
      mergeCommit = (await this.#runner.run(["git", "rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
      if (deleteBranch) {
        await this.#runner.run(["git", "branch", "-D", branch], { cwd: repoPath });
        await this.#runner.run(["git", "push", "origin", "--delete", branch], {
          cwd: repoPath
        });
      }
    } finally {
      await this.#runner.run(["git", "checkout", startingRef], { cwd: repoPath });
    }
    return mergeCommit;
  }
}
// ../core/src/linear/api.ts
class LinearApiError extends Error {
  status;
  errors;
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.name = "LinearApiError";
  }
}

class LinearPaginationError extends LinearApiError {
  operation;
  pages;
  partialCount;
  constructor(operation, pages, partialCount) {
    super(`${operation}: pagination incomplete after ${pages} pages (${partialCount} items); refusing partial results`, null, null);
    this.operation = operation;
    this.pages = pages;
    this.partialCount = partialCount;
    this.name = "LinearPaginationError";
  }
}
// ../core/src/linear/queries.ts
var ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  estimate
  url
  branchName
  createdAt
  updatedAt
  state { id name type }
  labels { nodes { id name isGroup parent { id name } } }
  project { id name }
  team { id key name }
  assignee { id name displayName }
  parent { id identifier title state { id name type } }
  children { nodes { id identifier title state { id name type } } }
  relations {
    nodes {
      id
      type
      issue { id identifier title state { id name type } }
      relatedIssue { id identifier title state { id name type } }
    }
  }
  inverseRelations {
    nodes {
      id
      type
      issue { id identifier title state { id name type } }
      relatedIssue { id identifier title state { id name type } }
    }
  }
`;
var ISSUE_FIELDS_WITH_COMMENTS = `${ISSUE_FIELDS}
  comments(first: 100) {
    nodes { id body createdAt user { id name displayName } parent { id } }
    pageInfo { hasNextPage endCursor }
  }
`;
function issueQueryFields(includeComments) {
  return includeComments ? ISSUE_FIELDS_WITH_COMMENTS : ISSUE_FIELDS;
}
var ISSUE_BY_ID_QUERY = (includeComments) => `
  query IssueByIdentifier($id: String!) {
    issue(id: $id) {
      ${issueQueryFields(includeComments)}
    }
  }
`;
var ISSUES_QUERY = (includeComments) => `
  query Issues($filter: IssueFilter, $after: String, $first: Int) {
    issues(filter: $filter, after: $after, first: $first) {
      nodes {
        ${issueQueryFields(includeComments)}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
var COMMENTS_QUERY = `
  query IssueComments($issueId: String!, $after: String, $first: Int) {
    issue(id: $issueId) {
      comments(first: $first, after: $after) {
        nodes { id body createdAt user { id name displayName } parent { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
var PROJECT_QUERY_SCALAR_CONTENT = `
  query ProjectDocuments($projectId: String!) {
    project(id: $projectId) {
      id
      name
      description
      content
      documents {
        nodes { id title content updatedAt }
      }
    }
  }
`;
var PROJECT_QUERY_OBJECT_CONTENT = `
  query ProjectDocuments($projectId: String!) {
    project(id: $projectId) {
      id
      name
      description
      content
      documents {
        nodes { id title content { body } updatedAt }
      }
    }
  }
`;
var PROJECT_INITIATIVES_QUERY = `
  query ProjectInitiatives($projectId: String!) {
    project(id: $projectId) {
      id
      name
      initiatives {
        nodes { id name }
      }
    }
  }
`;
var INITIATIVE_QUERY_SCALAR_CONTENT = `
  query InitiativeDocuments($initiativeId: String!) {
    initiative(id: $initiativeId) {
      id
      name
      documents {
        nodes { id title content updatedAt }
      }
    }
  }
`;
var INITIATIVE_QUERY_OBJECT_CONTENT = `
  query InitiativeDocuments($initiativeId: String!) {
    initiative(id: $initiativeId) {
      id
      name
      documents {
        nodes { id title content { body } updatedAt }
      }
    }
  }
`;
var WORKFLOW_STATES_QUERY = `
  query TeamWorkflowStates($teamId: String!) {
    team(id: $teamId) {
      workflowStates {
        nodes { id name type position }
      }
    }
  }
`;
var WORKSPACE_LABELS_QUERY = `
  query WorkspaceLabels($after: String) {
    issueLabels(first: 250, after: $after) {
      nodes { id name isGroup parent { id name } team { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
var TEAMS_QUERY = `
  query Teams {
    teams {
      nodes { id key name }
    }
  }
`;
var PROJECTS_QUERY = `
  query Projects {
    projects(first: 250) {
      nodes { id name }
    }
  }
`;
var INITIATIVES_QUERY = `
  query Initiatives {
    initiatives(first: 250) {
      nodes { id name }
    }
  }
`;
var INITIATIVE_PROJECTS_QUERY = `
  query InitiativeProjects($initiativeId: String!) {
    initiative(id: $initiativeId) {
      projects(first: 250) {
        nodes { id name status { id name type } }
      }
    }
  }
`;
var ISSUE_UPDATE_MUTATION = (includeComments) => `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        ${issueQueryFields(includeComments)}
      }
    }
  }
`;
var ISSUE_CREATE_MUTATION = (includeComments) => `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        ${issueQueryFields(includeComments)}
      }
    }
  }
`;
var COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body createdAt user { id name displayName } parent { id } }
    }
  }
`;
var ISSUE_RELATION_CREATE_MUTATION = `
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id }
    }
  }
`;
var ISSUE_RELATION_DELETE_MUTATION = `
  mutation IssueRelationDelete($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`;
var ISSUE_LABEL_CREATE_MUTATION = `
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name parent { id } }
    }
  }
`;
var PROJECT_CREATE_MUTATION = `
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project { id name }
    }
  }
`;
var PROJECT_STATUS_QUERY = `
  query ProjectStatus($projectId: String!) {
    project(id: $projectId) {
      id
      status { id name type }
    }
  }
`;
var PROJECT_STATUSES_QUERY = `
  query ProjectStatuses {
    projectStatuses {
      nodes { id name type }
    }
  }
`;
var PROJECT_UPDATE_MUTATION = `
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
    }
  }
`;
var INITIATIVE_TO_PROJECT_CREATE_MUTATION = `
  mutation InitiativeToProjectCreate($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) {
      success
    }
  }
`;

// ../core/src/linear/client.ts
var DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
function operationName(document) {
  const match = /\b(?:query|mutation)\s+(\w+)/.exec(document);
  return match?.[1] ?? "anonymous";
}
var MAX_PAGES = 50;
var RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

class LinearClient {
  apiKey;
  endpoint;
  fetchImpl;
  teamScope;
  timeoutMs;
  onRequest;
  labelIdCache = new Map;
  labelGroupIdCache = new Map;
  projectInitiativeCache = new Map;
  projectInitiativesCache = new Map;
  projectStatusIdCache = new Map;
  projectContentShape = null;
  initiativeContentShape = null;
  viewerIdCache = null;
  constructor(options) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.teamScope = options.team ? { team: { key: { eq: options.team } } } : null;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.onRequest = options.onRequest ?? null;
  }
  async request(document, variables) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    return this.requestWithRetry(document, variables, 0, signal);
  }
  async requestWithRetry(document, variables, attempt, signal) {
    const startedAt = performance.now();
    const trace = (status, ok, error) => {
      if (!this.onRequest)
        return;
      this.onRequest({
        operation: operationName(document),
        attempt,
        durationMs: performance.now() - startedAt,
        status,
        ok,
        ...error !== undefined ? { error } : {}
      });
    };
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.apiKey
        },
        body: JSON.stringify({ query: document, variables }),
        signal
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        const message = `Linear API request timed out after ${this.timeoutMs}ms`;
        trace(null, false, message);
        throw new LinearApiError(message, null, null);
      }
      trace(null, false, String(error));
      throw error;
    }
    if (!response.ok) {
      if (attempt < 2 && RETRYABLE_STATUS.has(response.status)) {
        const body2 = await response.text();
        trace(response.status, false, `retrying: ${body2}`);
        await this.backoff(response, signal);
        return this.requestWithRetry(document, variables, attempt + 1, signal);
      }
      const body = await response.text();
      trace(response.status, false, body);
      throw new LinearApiError(`Linear API request failed with status ${response.status}: ${body}`, response.status, body);
    }
    const payload = await response.json();
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((entry) => entry.message).join("; ");
      trace(response.status, false, message);
      throw new LinearApiError(message, response.status, payload.errors);
    }
    if (payload.data === null || payload.data === undefined) {
      trace(response.status, false, "Linear API returned no data");
      throw new LinearApiError("Linear API returned no data", response.status, payload.errors);
    }
    trace(response.status, true);
    return payload.data;
  }
  async backoff(response, signal) {
    const retryAfter = response.headers.get("Retry-After");
    const delayMs = this.retryDelayMs(retryAfter);
    if (signal.aborted) {
      throw new LinearApiError(`Linear API request timed out after ${this.timeoutMs}ms`, null, null);
    }
    const { promise, resolve: resolve2, reject } = Promise.withResolvers();
    const timer = setTimeout(resolve2, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LinearApiError(`Linear API request timed out after ${this.timeoutMs}ms`, null, null));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  retryDelayMs(retryAfter) {
    const MAX_DELAY_MS = 60000;
    if (!retryAfter)
      return 1000;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds > 0 ? Math.min(seconds * 1000, MAX_DELAY_MS) : 1000;
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const delta2 = dateMs - Date.now();
      return delta2 > 0 ? Math.min(delta2, MAX_DELAY_MS) : 1000;
    }
    return 1000;
  }
  refusePartialPage(operation, pages, partialCount) {
    throw new LinearPaginationError(operation, pages, partialCount);
  }
  mapStateRef(state) {
    return { id: state.id, name: state.name, type: state.type };
  }
  mapIssueRef(ref) {
    return {
      id: ref.id,
      identifier: ref.identifier,
      title: ref.title,
      state: this.mapStateRef(ref.state)
    };
  }
  mapRelation(relation, direction) {
    const other = direction === "outgoing" ? relation.relatedIssue : relation.issue;
    return {
      id: relation.id,
      type: relation.type,
      direction,
      other: this.mapIssueRef(other)
    };
  }
  mergeRelations(wire) {
    const seen = new Set;
    const merged = [];
    for (const relation of wire.relations.nodes) {
      if (seen.has(relation.id))
        continue;
      seen.add(relation.id);
      merged.push(this.mapRelation(relation, "outgoing"));
    }
    for (const relation of wire.inverseRelations?.nodes ?? []) {
      if (seen.has(relation.id))
        continue;
      seen.add(relation.id);
      merged.push(this.mapRelation(relation, "incoming"));
    }
    return merged;
  }
  mapComment(comment) {
    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      user: comment.user ? { id: comment.user.id, name: comment.user.name, displayName: comment.user.displayName } : null,
      parentId: comment.parent?.id ?? null
    };
  }
  mapIssue(wire) {
    return {
      id: wire.id,
      identifier: wire.identifier,
      title: wire.title,
      description: wire.description,
      priority: wire.priority,
      estimate: wire.estimate,
      url: wire.url,
      branchName: wire.branchName,
      createdAt: wire.createdAt,
      updatedAt: wire.updatedAt,
      state: {
        ...this.mapStateRef(wire.state),
        position: 0
      },
      labels: wire.labels.nodes.map((label) => ({
        id: label.id,
        name: labelIdFromParts(label.name, label.parent?.name ?? null),
        parentId: label.parent?.id ?? null
      })),
      team: { id: wire.team.id, key: wire.team.key, name: wire.team.name },
      project: wire.project ? { id: wire.project.id, name: wire.project.name } : null,
      parent: wire.parent ? this.mapIssueRef(wire.parent) : null,
      children: wire.children.nodes.map((child) => this.mapIssueRef(child)),
      assignee: wire.assignee ? { id: wire.assignee.id, name: wire.assignee.name, displayName: wire.assignee.displayName } : null,
      relations: this.mergeRelations(wire),
      comments: wire.comments ? wire.comments.nodes.map((comment) => this.mapComment(comment)) : []
    };
  }
  async issue(id, options) {
    const includeComments = options?.includeComments ?? false;
    const data = await this.request(ISSUE_BY_ID_QUERY(includeComments), { id });
    if (!data.issue)
      return null;
    const issue = this.mapIssue(data.issue);
    const pageInfo = data.issue.comments?.pageInfo;
    if (includeComments && pageInfo?.hasNextPage && pageInfo.endCursor) {
      issue.comments = issue.comments.concat(await this.paginateComments(issue.id, pageInfo.endCursor));
    }
    return issue;
  }
  scoped(filter) {
    if (!this.teamScope)
      return filter;
    return filter ? { and: [filter, this.teamScope] } : this.teamScope;
  }
  async issues(query) {
    const includeComments = query.includeComments ?? false;
    const pageSize = query.first ?? 50;
    const filter = this.scoped(query.filter);
    const results = [];
    let after;
    let pages = 0;
    for (;; ) {
      const data = await this.request(ISSUES_QUERY(includeComments), {
        filter,
        after,
        first: query.limit !== undefined ? Math.min(pageSize, query.limit - results.length) : pageSize
      });
      for (const node of data.issues.nodes) {
        const issue = this.mapIssue(node);
        const pageInfo = node.comments?.pageInfo;
        if (includeComments && pageInfo?.hasNextPage && pageInfo.endCursor) {
          issue.comments = issue.comments.concat(await this.paginateComments(issue.id, pageInfo.endCursor));
        }
        results.push(issue);
        if (query.limit !== undefined && results.length >= query.limit) {
          return results;
        }
      }
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor)
        break;
      if (data.issues.pageInfo.endCursor === after) {
        this.refusePartialPage("issues()", pages, results.length);
      }
      after = data.issues.pageInfo.endCursor;
      pages += 1;
      if (pages >= MAX_PAGES) {
        this.refusePartialPage("issues()", pages, results.length);
      }
    }
    return results;
  }
  async comments(issueId) {
    return this.paginateComments(issueId, undefined);
  }
  async paginateComments(issueId, after) {
    const results = [];
    let cursor = after;
    let pages = 0;
    for (;; ) {
      const data = await this.request(COMMENTS_QUERY, { issueId, after: cursor, first: 100 });
      if (!data.issue)
        break;
      for (const comment of data.issue.comments.nodes) {
        results.push(this.mapComment(comment));
      }
      if (!data.issue.comments.pageInfo.hasNextPage || !data.issue.comments.pageInfo.endCursor)
        break;
      if (data.issue.comments.pageInfo.endCursor === cursor) {
        this.refusePartialPage(`paginateComments(${issueId})`, pages, results.length);
      }
      cursor = data.issue.comments.pageInfo.endCursor;
      pages += 1;
      if (pages >= MAX_PAGES) {
        this.refusePartialPage(`paginateComments(${issueId})`, pages, results.length);
      }
    }
    return results;
  }
  async project(projectId) {
    const shape = this.projectContentShape ?? "scalar";
    try {
      return await this.fetchProject(projectId, shape);
    } catch (error) {
      if (shape === "object" || !(error instanceof LinearApiError))
        throw error;
      const result = await this.fetchProject(projectId, "object");
      this.projectContentShape = "object";
      return result;
    }
  }
  async fetchProject(projectId, shape) {
    const document = shape === "scalar" ? PROJECT_QUERY_SCALAR_CONTENT : PROJECT_QUERY_OBJECT_CONTENT;
    const data = await this.request(document, { projectId });
    if (!data.project)
      return null;
    this.projectContentShape = shape;
    return {
      id: data.project.id,
      name: data.project.name,
      description: data.project.description,
      content: data.project.content,
      documents: data.project.documents.nodes.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content === null ? null : typeof doc.content === "string" ? doc.content : doc.content.body,
        updatedAt: doc.updatedAt
      }))
    };
  }
  async fetchProjectInitiatives(projectId) {
    const data = await this.request(PROJECT_INITIATIVES_QUERY, { projectId });
    return {
      name: data.project?.name ?? projectId,
      initiatives: data.project?.initiatives.nodes ?? []
    };
  }
  async projectInitiatives(projectId) {
    const cached = this.projectInitiativesCache.get(projectId);
    if (cached)
      return cached;
    const { initiatives } = await this.fetchProjectInitiatives(projectId);
    this.projectInitiativesCache.set(projectId, initiatives);
    return initiatives;
  }
  async projectInitiative(projectId) {
    const cached = this.projectInitiativeCache.get(projectId);
    if (cached)
      return cached;
    const { name, initiatives } = await this.fetchProjectInitiatives(projectId);
    const first = initiatives[0];
    if (first === undefined) {
      throw new LinearApiError(`Project "${name}" has no initiative; a project must belong to exactly one initiative.`, null, null);
    }
    if (initiatives.length > 1) {
      const names = initiatives.map((node) => node.name).join(", ");
      throw new LinearApiError(`Project "${name}" belongs to more than one initiative (${names}); a project must belong to exactly one initiative.`, null, null);
    }
    const ref = { id: first.id, name: first.name };
    this.projectInitiativeCache.set(projectId, ref);
    return ref;
  }
  async projectStatus(projectId) {
    const data = await this.request(PROJECT_STATUS_QUERY, { projectId });
    if (!data.project)
      return null;
    return {
      id: data.project.status.id,
      name: data.project.status.name,
      type: data.project.status.type
    };
  }
  async resolveProjectStatusId(type) {
    const cached = this.projectStatusIdCache.get(type);
    if (cached)
      return cached;
    const data = await this.request(PROJECT_STATUSES_QUERY, {});
    for (const status of data.projectStatuses.nodes) {
      this.projectStatusIdCache.set(status.type, status.id);
    }
    const resolved = this.projectStatusIdCache.get(type);
    if (!resolved) {
      throw new LinearApiError(`Workspace has no project status of type "${type}"`, null, null);
    }
    return resolved;
  }
  async updateProjectStatus(input) {
    const statusId = await this.resolveProjectStatusId(input.type);
    const data = await this.request(PROJECT_UPDATE_MUTATION, {
      id: input.projectId,
      input: { statusId }
    });
    if (!data.projectUpdate.success) {
      throw new LinearApiError(`Failed to update project ${input.projectId} to status "${input.type}"`, null, null);
    }
  }
  async initiatives() {
    const data = await this.request(INITIATIVES_QUERY, {});
    return data.initiatives.nodes;
  }
  async viewerId() {
    if (this.viewerIdCache !== null)
      return this.viewerIdCache;
    const data = await this.request("query { viewer { id } }", {});
    this.viewerIdCache = data.viewer.id;
    return data.viewer.id;
  }
  async initiative(initiativeId) {
    const shape = this.initiativeContentShape ?? "scalar";
    try {
      return await this.fetchInitiative(initiativeId, shape);
    } catch (error) {
      if (shape === "object" || !(error instanceof LinearApiError))
        throw error;
      const result = await this.fetchInitiative(initiativeId, "object");
      this.initiativeContentShape = "object";
      return result;
    }
  }
  async fetchInitiative(initiativeId, shape) {
    const document = shape === "scalar" ? INITIATIVE_QUERY_SCALAR_CONTENT : INITIATIVE_QUERY_OBJECT_CONTENT;
    const data = await this.request(document, { initiativeId });
    if (!data.initiative)
      return null;
    this.initiativeContentShape = shape;
    return {
      id: data.initiative.id,
      name: data.initiative.name,
      documents: data.initiative.documents.nodes.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content === null ? null : typeof doc.content === "string" ? doc.content : doc.content.body,
        updatedAt: doc.updatedAt
      }))
    };
  }
  async workflowStates(teamId) {
    const data = await this.request(WORKFLOW_STATES_QUERY, { teamId });
    return data.team.workflowStates.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      position: state.position
    }));
  }
  async fetchRawLabels(teamId) {
    const results = [];
    let after;
    let pages = 0;
    for (;; ) {
      const data = await this.request(WORKSPACE_LABELS_QUERY, { after });
      results.push(...data.issueLabels.nodes);
      if (!data.issueLabels.pageInfo.hasNextPage || !data.issueLabels.pageInfo.endCursor)
        break;
      if (data.issueLabels.pageInfo.endCursor === after) {
        this.refusePartialPage("fetchRawLabels()", pages, results.length);
      }
      after = data.issueLabels.pageInfo.endCursor;
      pages += 1;
      if (pages >= MAX_PAGES) {
        this.refusePartialPage("fetchRawLabels()", pages, results.length);
      }
    }
    return teamId ? results.filter((label) => label.team === null || label.team.id === teamId) : results;
  }
  async labels(teamId) {
    const raw = await this.fetchRawLabels(teamId);
    return raw.map((label) => ({
      id: label.id,
      name: labelIdFromParts(label.name, label.parent?.name ?? null),
      parentId: label.parent?.id ?? null
    }));
  }
  async teams() {
    const data = await this.request(TEAMS_QUERY, {});
    return data.teams.nodes;
  }
  async projects() {
    const data = await this.request(PROJECTS_QUERY, {});
    return data.projects.nodes;
  }
  async initiativeProjects(initiativeId) {
    const data = await this.request(INITIATIVE_PROJECTS_QUERY, { initiativeId });
    return data.initiative?.projects.nodes ?? [];
  }
  async createProject(input) {
    const data = await this.request(PROJECT_CREATE_MUTATION, { input });
    if (!data.projectCreate.success || !data.projectCreate.project) {
      throw new LinearApiError(`Failed to create project "${input.name}"`, null, null);
    }
    return data.projectCreate.project;
  }
  async addProjectToInitiative(input) {
    const data = await this.request(INITIATIVE_TO_PROJECT_CREATE_MUTATION, { input });
    if (!data.initiativeToProjectCreate.success) {
      throw new LinearApiError(`Failed to attach project ${input.projectId} to initiative ${input.initiativeId}`, null, null);
    }
  }
  async updateIssue(id, input) {
    const data = await this.request(ISSUE_UPDATE_MUTATION(false), { id, input });
    if (!data.issueUpdate.issue) {
      throw new LinearApiError(`Failed to update issue ${id}: Linear returned no issue`, null, null);
    }
    return this.mapIssue(data.issueUpdate.issue);
  }
  async createIssue(input) {
    const data = await this.request(ISSUE_CREATE_MUTATION(false), { input });
    if (!data.issueCreate.issue) {
      throw new LinearApiError(`Failed to create issue "${input.title}": Linear returned no issue`, null, null);
    }
    return this.mapIssue(data.issueCreate.issue);
  }
  async createComment(input) {
    const data = await this.request(COMMENT_CREATE_MUTATION, { input });
    return this.mapComment(data.commentCreate.comment);
  }
  async createRelation(input) {
    const data = await this.request(ISSUE_RELATION_CREATE_MUTATION, { input });
    if (!data.issueRelationCreate.success) {
      throw new LinearApiError(`Failed to create ${input.type} relation from ${input.issueId} to ${input.relatedIssueId}`, null, null);
    }
  }
  async deleteRelation(relationId) {
    const data = await this.request(ISSUE_RELATION_DELETE_MUTATION, { id: relationId });
    if (!data.issueRelationDelete.success) {
      throw new LinearApiError(`Failed to delete relation ${relationId}`, null, null);
    }
  }
  async createLabel(input) {
    const data = await this.request(ISSUE_LABEL_CREATE_MUTATION, { input });
    const label = data.issueLabelCreate.issueLabel;
    return { id: label.id, name: label.name, parentId: label.parent?.id ?? null };
  }
  async ensureLabel(name, teamId) {
    const cacheKey = `${teamId}:${name}`;
    const cached = this.labelIdCache.get(cacheKey);
    if (cached)
      return cached;
    const matches = (await this.labels(teamId)).filter((label2) => label2.name === name);
    if (matches.length > 1) {
      throw new LinearApiError(`Label "${name}" matches ${matches.length} labels visible to team ${teamId} (team-owned and workspace-level); cannot resolve unambiguously.`, null, null);
    }
    const existing = matches[0];
    if (existing) {
      this.labelIdCache.set(cacheKey, existing);
      return existing;
    }
    const group = MANAGED_LABEL_GROUPS.find((candidate) => name.startsWith(candidate.prefix));
    const parentId = group ? await this.ensureLabelGroup(group.prefix, teamId) : undefined;
    const childName = group ? labelDisplayName(name.slice(group.prefix.length)) : name;
    const created = await this.createLabel({ name: childName, teamId, parentId });
    const label = { id: created.id, name, parentId: created.parentId };
    this.labelIdCache.set(cacheKey, label);
    return label;
  }
  async ensureLabelGroup(prefix, teamId) {
    const cacheKey = `${teamId}:${prefix}`;
    const cached = this.labelGroupIdCache.get(cacheKey);
    if (cached)
      return cached;
    const displayName = groupDisplayName(prefix);
    const existing = (await this.fetchRawLabels(teamId)).find((label) => label.isGroup === true && label.name === displayName);
    if (existing) {
      this.labelGroupIdCache.set(cacheKey, existing.id);
      return existing.id;
    }
    const created = await this.createLabel({ name: displayName, teamId, isGroup: true });
    this.labelGroupIdCache.set(cacheKey, created.id);
    return created.id;
  }
}
// ../core/src/linear/filters.ts
function inState(name) {
  return { state: { name: { eq: name } } };
}
function inStateType(type) {
  return { state: { type: { eq: type } } };
}
function labelMatch(id) {
  const colon = id.indexOf(":");
  if (colon === -1)
    return { name: { eq: labelDisplayName(id) } };
  return {
    name: { eq: labelDisplayName(id.slice(colon + 1)) },
    parent: { name: { eq: groupDisplayName(id.slice(0, colon)) } }
  };
}
function hasLabelNamed(id) {
  return { labels: { some: labelMatch(id) } };
}
function hasAnyLabelPrefixed(prefix) {
  return { labels: { some: { parent: { name: { eq: groupDisplayName(prefix) } } } } };
}
function prioritized() {
  return { priority: { neq: PRIORITY.None } };
}
function estimateSet() {
  return { estimate: { neq: null } };
}
function hasBlockedByRelations(present) {
  return { hasBlockedByRelations: { eq: present } };
}
function all(...filters) {
  return { and: filters };
}
var INBOX_FILTER = inStateType("triage");
var BLOCKED_HUMAN_FILTER = hasAnyLabelPrefixed(LABEL_GROUP.blocked);
var BLOCKED_DEPS_FILTER = hasBlockedByRelations(true);
var PROPOSALS_FILTER = hasLabelNamed(AGENT_LABEL.proposed);
function readyFilter() {
  return all(inState("Todo"), hasLabelNamed(AGENT_LABEL.ready), estimateSet(), prioritized());
}
var IN_FLIGHT_FILTER = hasLabelNamed(AGENT_LABEL.running);
// ../core/src/lock.ts
function newDispatchId(agent, issueId, now = new Date) {
  const compact = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${agent}-${issueId}-${compact}-${suffix}`;
}
function issueIdFromDispatchId(dispatchId) {
  return /^foreman-[a-z]+-(\S+)-\d{8}T\d{6}Z-\w+$/.exec(dispatchId)?.[1] ?? null;
}
function renderLockComment(record) {
  const expires = new Date(new Date(record.takenAt).getTime() + record.ttlMs).toISOString();
  const human = [
    `Locked by \`${record.agent}\` (dispatch \`${record.dispatchId}\`).`,
    `Taken at ${record.takenAt}, expires ${expires}.`,
    record.worktree ? `Worktree: \`${record.worktree}\`.` : "No worktree."
  ].join(`
`);
  return encodeMarker(MARKER_KIND.lock, record, human);
}
function readLockComment(comments, authoredBy) {
  return latestMarker(MARKER_KIND.lock, comments, authoredBy !== undefined ? { authoredBy } : undefined);
}
function lockState(record, options) {
  if (record === null) {
    return { held: false, expired: false, orphaned: false, reason: "No lock comment found." };
  }
  if (record.released) {
    return { held: false, expired: false, orphaned: false, reason: "Lock was released." };
  }
  const expiresAt = new Date(record.takenAt).getTime() + record.ttlMs;
  const expired = !Number.isFinite(expiresAt) || options.now.getTime() > expiresAt;
  if (!expired) {
    return { held: true, expired: false, orphaned: false, reason: "Lock is held and within TTL." };
  }
  const isLive = options.liveDispatchIds.includes(record.dispatchId);
  if (isLive) {
    return {
      held: true,
      expired: true,
      orphaned: false,
      reason: "Lock is past TTL but its dispatch ID is still live."
    };
  }
  return {
    held: true,
    expired: true,
    orphaned: true,
    reason: "Lock is past TTL and its dispatch ID appears in no liveness source."
  };
}
// ../core/src/repo.ts
async function issueScope(deps, issue2) {
  if (issue2.project === null) {
    return {
      inScope: false,
      reason: "no-project",
      initiativeId: null,
      message: `Issue ${issue2.identifier} has no project, so it belongs to no initiative`
    };
  }
  const initiatives = await deps.linear.projectInitiatives(issue2.project.id);
  if (initiatives.length === 0) {
    return {
      inScope: false,
      reason: "project-no-initiative",
      initiativeId: null,
      message: `Issue ${issue2.identifier}'s project has no initiative; a project must belong to exactly one initiative`
    };
  }
  if (initiatives.length > 1) {
    return {
      inScope: false,
      reason: "project-multiple-initiatives",
      initiativeId: null,
      message: `Issue ${issue2.identifier}'s project belongs to more than one initiative (${initiatives.map((node) => node.name).join(", ")}); a project must belong to exactly one initiative`
    };
  }
  const initiative = initiatives[0];
  if (!initiative || !deps.entry.initiativeIds.includes(initiative.id)) {
    return {
      inScope: false,
      reason: "initiative-unbound",
      initiativeId: initiative?.id ?? null,
      message: `Issue ${issue2.identifier} belongs to initiative "${initiative?.name}" (${initiative?.id}), ` + `which is not bound to repos.${deps.entry.alias}`
    };
  }
  return { inScope: true, reason: null, initiativeId: initiative.id, message: null };
}
async function assertIssueInScope(deps, issue2) {
  const verdict = await issueScope(deps, issue2);
  if (!verdict.inScope) {
    throw new ConfigError(verdict.message ?? `Issue ${issue2.identifier} is out of scope`, [
      `repos.${deps.entry.alias} binds ${deps.entry.initiativeIds.join(", ") || "no initiatives"}`
    ]);
  }
}
// ../core/src/schemas/envelope.ts
var BlockRecord = Type.Object({
  blocked: Type.Literal(true),
  type: Type.Union([
    Type.Literal("dependency"),
    Type.Literal("needs-input"),
    Type.Literal("needs-decision"),
    Type.Literal("external"),
    Type.Literal("budget")
  ], {
    description: "`dependency` is Case A (SPEC §9): another issue blocks this one, so no " + "`blocked:*` label is applied and the native relation is the state. " + "Everything else is Case B and parks the issue in the human queue."
  }),
  whatIWasDoing: Type.String({
    minLength: 1,
    description: "Where the run stopped, in enough detail to resume from."
  }),
  whatINeed: Type.String({
    minLength: 1,
    description: "The single question or decision that unblocks this."
  }),
  options: Type.Union([
    Type.Array(Type.Object({
      label: Type.String({ minLength: 1 }),
      tradeoff: Type.String({ minLength: 1 })
    }, { additionalProperties: false })),
    Type.Null()
  ]),
  recommendation: Type.Union([Type.String(), Type.Null()], {
    description: "Which option you would pick, and why. Null only when you truly have no lean."
  }),
  stateLeftBehind: Type.Object({
    worktree: Type.Union([Type.String(), Type.Null()]),
    branch: Type.Union([Type.String(), Type.Null()]),
    pushed: Type.Boolean(),
    commits: Type.Array(Type.String()),
    notes: Type.String()
  }, { additionalProperties: false }),
  costOfWrongGuess: Type.String({
    minLength: 1,
    description: "What it costs if you guess instead of asking. This is why you blocked."
  }),
  blockedByIssues: Type.Array(Type.String(), {
    description: "Human identifiers (e.g. ENG-142) of issues that block this one. " + "Required and non-empty when `type` is `dependency`; empty otherwise."
  })
}, {
  $id: "foreman/block-record",
  additionalProperties: false,
  title: "BlockRecord"
});
function envelope(result, id) {
  return Type.Object({
    blocked: Type.Boolean({
      description: "False for a normal result, true when you are blocked. Set it first, " + "then populate exactly one of `result` / `block` and null the other."
    }),
    result: Type.Union([result, Type.Null()], {
      description: "The normal result. Null if and only if `blocked` is true."
    }),
    block: Type.Union([BlockRecord, Type.Null()], {
      description: "The block record. Null if and only if `blocked` is false."
    })
  }, { $id: id, additionalProperties: false });
}
// ../core/src/schemas/triage.ts
var TypeLabelSchema = Type.Union(TYPE_LABELS.map((name) => Type.Literal(name)), { description: "The `type:` label this issue should carry when it leaves Triage." });
var TriageItem = Type.Object({
  issueId: Type.String({
    minLength: 1,
    description: "Human identifier, e.g. ENG-142."
  }),
  type: TypeLabelSchema,
  proposedPriority: Type.Integer({
    minimum: 0,
    maximum: 4,
    description: "0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. Propose 0 only when you " + "genuinely cannot tell; 0 makes the issue ineligible for refinement."
  }),
  severityReasoning: Type.String({
    minLength: 1,
    description: "Why that priority. This is the tuning log for the dedupe and severity " + "thresholds — write it for a reader deciding whether you were right."
  }),
  duplicateOf: Type.Union([Type.String(), Type.Null()], {
    description: "Human identifier of the issue this duplicates, or null."
  }),
  proposedBlockedBy: Type.Array(Type.String(), {
    description: "Human identifiers of issues that block this one. Native Linear relations, " + "never labels."
  }),
  destinationProject: Type.Union([Type.String(), Type.Null()], {
    description: "Name of the project this issue belongs to once triaged: a milestone " + "project's name, or the product's standing `Maintenance` project " + "(SPEC §4.0, §7.1). A name, never a UUID. Null only when you genuinely " + "cannot tell."
  }),
  draftDescription: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
    description: "Drafted issue body when the source Inbox item lacks one; applied as the description on approval. Null when the existing description is adequate."
  }),
  proposedEstimate: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
    description: "Estimate to apply on approval, or null when you cannot yet estimate it."
  }),
  destinationProjectId: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
    description: "Linear project id to apply on approval, preferred over `destinationProject` (a name, which can be ambiguous). Null when you don't have the id."
  }),
  destination: Type.Union([
    Type.Literal("Backlog"),
    Type.Literal("Canceled"),
    Type.Literal("Duplicate")
  ], { description: "Where this issue should move once the proposal is approved." }),
  reproConfidence: Type.Union([
    Type.Literal("confirmed"),
    Type.Literal("likely"),
    Type.Literal("cannot-reproduce"),
    Type.Literal("not-attempted")
  ], {
    description: "Repro is attempted by reading only — you hold no exec tool. " + "`not-attempted` is correct for anything that is not a bug."
  }),
  missingInfo: Type.Array(Type.String(), {
    description: "What a human would have to add before this is refinable."
  }),
  triageLabel: Type.Union([
    Type.Literal("triage:cannot-reproduce"),
    Type.Literal("triage:duplicate"),
    Type.Literal("triage:needs-info"),
    Type.Literal("triage:wont-fix"),
    Type.Null()
  ], { description: "Optional triage disposition label, or null." })
}, { additionalProperties: false, title: "TriageItem" });
var TriageProposal = Type.Object({
  items: Type.Array(TriageItem, {
    description: "One entry per issue in the Inbox batch you processed."
  }),
  summary: Type.String({
    minLength: 1,
    description: "One paragraph on the batch as a whole: patterns, surprises, dedupe calls."
  })
}, { additionalProperties: false, title: "TriageProposal" });
var TriageOutput = envelope(TriageProposal, "foreman/triage-output");
// ../core/src/schemas/refine.ts
var TypeLabelSchema2 = Type.Union(TYPE_LABELS.map((name) => Type.Literal(name)), { description: "The `type:` label this sub-issue should carry." });
var EstimateSchema = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(5),
  Type.Literal(8)
], {
  description: "1 single file; 2 a few files; 3 multiple files and one non-obvious decision; " + "5 must be split into subIssues; 8 is not an issue — propose a spike or a project."
});
var SubIssue = Type.Object({
  title: Type.String({ minLength: 1 }),
  type: TypeLabelSchema2,
  description: Type.String({
    minLength: 1,
    description: "Full body in the SPEC §13.1 template, same as `refinedDescription`."
  }),
  estimate: EstimateSchema,
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })
}, { additionalProperties: false, title: "SubIssue" });
var SpikeSpec = Type.Object({
  title: Type.String({ minLength: 1 }),
  question: Type.String({
    minLength: 1,
    description: "The single unknown the spike answers."
  }),
  budget: Type.String({
    minLength: 1,
    description: "Stated ceiling, e.g. 'one session' or '2 points'."
  }),
  deliverable: Type.String({
    minLength: 1,
    description: "The artifact that ends the spike. A spike with no written deliverable " + "is unbilled wandering (SPEC §13.3)."
  })
}, { additionalProperties: false, title: "SpikeSpec" });
var RefineResult = Type.Object({
  issueId: Type.String({ minLength: 1 }),
  refinedDescription: Type.String({
    minLength: 1,
    description: "The issue body in the SPEC §13.1 template. Do not restate the Definition " + "of Done. `## Open Questions` must be empty for a refined issue."
  }),
  estimate: EstimateSchema,
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), {
    description: "Observable behaviors, verifiable by someone who did not write the code. " + "Empty only when this issue became a tracking parent."
  }),
  affectedAreas: Type.Array(Type.String(), {
    description: "Files and modules identified via LSP, not guessed."
  }),
  outOfScope: Type.Array(Type.String(), {
    description: "Explicit non-goals. This is what prevents implement-time scope creep."
  }),
  subIssues: Type.Array(SubIssue, {
    description: "Non-empty when `estimate` is 5 or more: the parent becomes a tracking " + "issue and does not get `agent:ready`."
  }),
  spikeCreated: Type.Union([SpikeSpec, Type.Null()], {
    description: "A spike to create with a native `blocks` relation to this issue, when a " + "genuine unknown blocks estimation. Do not guess instead."
  }),
  readyForImplementation: Type.Boolean({
    description: "True only when this exact issue can be picked up as-is. False for a " + "tracking parent or an issue waiting on a spike."
  })
}, { additionalProperties: false, title: "RefineResult" });
var RefineOutput = envelope(RefineResult, "foreman/refine-output");
// ../core/src/schemas/implement.ts
var CriterionEvidence = Type.Object({
  criterion: Type.String({ minLength: 1 }),
  evidence: Type.String({
    minLength: 1,
    description: "file:line, test name, or command output that shows it holds."
  })
}, { additionalProperties: false, title: "CriterionEvidence" });
var TestAdded = Type.Object({
  path: Type.String({ minLength: 1 }),
  covers: Type.String({
    minLength: 1,
    description: "Which acceptance criterion this test defends."
  })
}, { additionalProperties: false, title: "TestAdded" });
var DiscoveredWork = Type.Object({
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  type: Type.Union(TYPE_LABELS.map((name) => Type.Literal(name))),
  relation: Type.Union([Type.Literal("blocks"), Type.Literal("related")], {
    description: "`blocks` only when this issue's work genuinely cannot ship without it. " + "Otherwise `related`."
  })
}, {
  additionalProperties: false,
  title: "DiscoveredWork",
  description: "Out-of-scope findings. The extension files these as new Backlog issues with " + "native relations — you never create them yourself."
});
var ImplementResult = Type.Object({
  issueId: Type.String({ minLength: 1 }),
  branch: Type.String({
    minLength: 1,
    description: "The branch you pushed. Must match the branch the dispatcher created."
  }),
  prUrl: Type.String({
    description: "The PR you opened. Empty string when the repo sets `pr.required: false` " + "and you pushed the branch without opening a PR."
  }),
  headSha: Type.String({
    minLength: 1,
    description: "The commit you pushed. The review gate pins itself to this."
  }),
  criteriaMet: Type.Array(CriterionEvidence, {
    description: "One entry per acceptance criterion. The criteria are the contract."
  }),
  testsAdded: Type.Array(TestAdded, {
    description: "Tests covering each acceptance criterion."
  }),
  discoveredWork: Type.Array(DiscoveredWork),
  approachSummary: Type.String({
    minLength: 1,
    description: "How you solved it, for the review comment and the PR body."
  })
}, { additionalProperties: false, title: "ImplementResult" });
var ImplementOutput = envelope(ImplementResult, "foreman/implement-output");
// ../core/src/schemas/review.ts
var FindingSeverity = Type.Union([
  Type.Literal("blocking"),
  Type.Literal("should-fix"),
  Type.Literal("nit")
], {
  description: "`blocking` routes back to implement and burns one of the two review→fix " + "cycles. Reserve it for things that must change before merge."
});
var Finding = Type.Object({
  severity: FindingSeverity,
  file: Type.String({ minLength: 1 }),
  line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  description: Type.String({ minLength: 1 })
}, { additionalProperties: false, title: "Finding" });
var CriterionVerification = Type.Object({
  criterion: Type.String({ minLength: 1 }),
  satisfied: Type.Boolean(),
  evidence: Type.String({
    minLength: 1,
    description: "file:line evidence. An assertion with no location is not evidence."
  })
}, { additionalProperties: false, title: "CriterionVerification" });
var DodCheck = Type.Object({
  item: Type.String({ minLength: 1 }),
  satisfied: Type.Boolean(),
  evidence: Type.String({ minLength: 1 })
}, { additionalProperties: false, title: "DodCheck" });
var ReviewResult = Type.Object({
  issueId: Type.String({ minLength: 1 }),
  reviewedSha: Type.String({
    minLength: 1,
    description: "The head SHA you reviewed, taken from the diff you were given. This pins " + "the review: a later push invalidates it and triggers re-review."
  }),
  criteriaVerification: Type.Array(CriterionVerification, {
    description: "One entry per acceptance criterion on the issue."
  }),
  dodSatisfied: Type.Boolean({
    description: "The per-product Definition of Done from the product `Context` doc."
  }),
  dodChecklist: Type.Array(DodCheck, {
    description: "Per-item Definition of Done results, for the rendered checklist."
  }),
  findings: Type.Array(Finding),
  projectOrganization: Type.String({
    minLength: 1,
    description: "Standing field on every review: structure, module boundaries, naming, " + "placement. Say 'no concerns' explicitly rather than leaving it thin."
  }),
  scopeCreep: Type.Array(Type.String(), {
    description: "Changes outside the acceptance criteria and out-of-scope list."
  }),
  testAdequacy: Type.String({
    minLength: 1,
    description: "Answer by inspection: would these tests fail if the change were reverted?"
  }),
  verdict: Type.Union([
    Type.Literal("approve"),
    Type.Literal("request-changes"),
    Type.Literal("comment")
  ], {
    description: "Advisory only — you hold no merge authority. `request-changes` if and " + "only if there is at least one `blocking` finding."
  })
}, { additionalProperties: false, title: "ReviewResult" });
var ReviewOutput = envelope(ReviewResult, "foreman/review-output");
// ../core/src/schemas/plan.ts
var TypeLabelSchema3 = Type.Union(TYPE_LABELS.map((name) => Type.Literal(name)), { description: "The `type:` label this issue should carry." });
var RoughEstimateSchema = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(5),
  Type.Literal(8)
], { description: "A rough call, not a commitment — `foreman-refine` re-estimates each issue against the code." });
var ProposedIssue = Type.Object({
  title: Type.String({ minLength: 1 }),
  type: TypeLabelSchema3,
  description: Type.String({
    minLength: 1,
    description: "Draft in the SPEC §13.1 template. This is a starting point, not a finished refinement — " + "`foreman-refine` verifies and revises it against the code, exactly as it already does for " + "intake-drafted issues (SPEC §3.12)."
  }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), {
    description: "Draft observable behaviors. `foreman-refine` may revise these once it reads the code."
  }),
  proposedPriority: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)], { description: "0 None, 1 Urgent, 2 High, 3 Medium, 4 Low (SPEC §4.3). Prefer a real priority — `None` leaves the issue outside the refine funnel until the operator sets one." }),
  proposedEstimate: Type.Union([RoughEstimateSchema, Type.Null()], {
    description: "Rough size, or null when genuinely unknown. `foreman-refine` re-estimates against the code."
  })
}, { additionalProperties: false, title: "ProposedIssue" });
var PlanResult = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  proposedIssues: Type.Array(ProposedIssue, {
    description: "New Backlog issues that decompose the project brief into agent-sized units. " + "The extension creates each one directly; none of them get `agent:ready` — they enter " + "the normal refine funnel once the operator sets a priority."
  }),
  outOfScope: Type.Array(Type.String(), {
    description: "Explicit non-goals for this pass, so a later planning pass does not re-propose them."
  }),
  fullyPlanned: Type.Boolean({
    description: "True when proposedIssues, together with anything already in the project, cover the brief " + "end to end. Informational only: Foreman has no durable per-project flag, so this does not " + "change dispatch behavior on its own (SPEC known gap) — the real stop condition is that a " + "project with at least one issue never triggers `foreman-plan` again."
  }),
  rationale: Type.String({
    minLength: 1,
    description: "How proposedIssues maps to the brief. Logged for the operator, not written to Linear."
  })
}, { additionalProperties: false, title: "PlanResult" });
var PlanOutput = envelope(PlanResult, "foreman/plan-output");
// ../core/src/schemas/index.ts
var AGENT_OUTPUT_SCHEMAS = {
  "foreman-triage": TriageOutput,
  "foreman-plan": PlanOutput,
  "foreman-refine": RefineOutput,
  "foreman-implement": ImplementOutput,
  "foreman-review": ReviewOutput
};
// ../core/src/schemas/parse.ts
function nonNullMember(union) {
  const member = union.anyOf.find((candidate) => candidate.type !== "null");
  if (!member)
    throw new Error("expected a nullable union with a non-null member");
  return member;
}
function describeErrors(schema2, value, prefix) {
  return [...exports_value2.Errors(schema2, value)].map((error) => `${prefix}${error.path || "/"}: ${error.message}`);
}
function parseAgentOutput(agent, data) {
  const schema2 = AGENT_OUTPUT_SCHEMAS[agent];
  if (!exports_value2.Check(schema2, data)) {
    let problems = describeErrors(schema2, data, "");
    if (data !== null && typeof data === "object") {
      if ("blocked" in data && data.blocked === false && "result" in data) {
        problems = describeErrors(nonNullMember(schema2.properties.result), data.result, "/result");
      } else if ("blocked" in data && data.blocked === true && "block" in data) {
        problems = describeErrors(nonNullMember(schema2.properties.block), data.block, "/block");
      }
    }
    return {
      kind: "invalid",
      problems: problems.length > 0 ? problems : ["/: does not match the expected envelope"]
    };
  }
  const envelope3 = data;
  if (envelope3.blocked) {
    if (envelope3.block === null || envelope3.result !== null) {
      return {
        kind: "invalid",
        problems: [
          "/block: required and non-null when blocked is true",
          "/result: must be null when blocked is true"
        ]
      };
    }
    if (envelope3.block.type === "dependency" && envelope3.block.blockedByIssues.length === 0) {
      return {
        kind: "invalid",
        problems: ['/block/blockedByIssues: must be non-empty when /block/type is "dependency"']
      };
    }
    return { kind: "blocked", block: envelope3.block };
  }
  if (envelope3.result === null || envelope3.block !== null) {
    return {
      kind: "invalid",
      problems: [
        "/result: required and non-null when blocked is false",
        "/block: must be null when blocked is false"
      ]
    };
  }
  const result = envelope3.result;
  if (agent === "foreman-refine") {
    const refineResult = result;
    const refineProblems = [];
    if (refineResult.readyForImplementation && (refineResult.estimate > 3 || refineResult.subIssues.length > 0 || refineResult.spikeCreated !== null)) {
      refineProblems.push("/result/readyForImplementation: must be false when estimate > 3, subIssues is non-empty, or spikeCreated is set");
    }
    if (refineResult.estimate >= 5 && refineResult.subIssues.length === 0) {
      refineProblems.push("/result/subIssues: must be non-empty when estimate >= 5");
    }
    if (refineProblems.length > 0)
      return { kind: "invalid", problems: refineProblems };
  }
  if (agent === "foreman-review") {
    const reviewResult = result;
    const reviewProblems = [];
    const hasBlocking = reviewResult.findings.some((finding) => finding.severity === "blocking");
    if (reviewResult.verdict === "request-changes" !== hasBlocking) {
      reviewProblems.push('/result/verdict: must be "request-changes" if and only if at least one finding is "blocking"');
    }
    const allDodSatisfied = reviewResult.dodChecklist.every((check2) => check2.satisfied);
    if (reviewResult.dodSatisfied && !allDodSatisfied) {
      reviewProblems.push("/result/dodSatisfied: must be false when any dodChecklist entry is not satisfied");
    }
    if (reviewProblems.length > 0)
      return { kind: "invalid", problems: reviewProblems };
  }
  return { kind: "result", result };
}
function isBudgetTruncation(input) {
  return input.aborted && input.problems.length > 0;
}
// ../core/src/style.ts
var enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
// ../core/src/team.ts
async function resolveTeamKey(deps) {
  const explicit = deps.flagTeam ?? deps.entryTeam;
  if (explicit)
    return explicit;
  const teams = await deps.linear.teams();
  if (teams.length === 1)
    return teams[0].key;
  if (teams.length === 0) {
    throw new ConfigError("The Linear credential can reach no teams", [
      "check the API key's permissions"
    ]);
  }
  throw new ConfigError(`The Linear credential reaches ${teams.length} teams, so the team cannot be inferred`, [
    `pass --team <KEY>, or set the entry's "team"`,
    `available: ${teams.map((team) => team.key).join(", ")}`
  ]);
}
// src/enforce/skill-guard.ts
import { existsSync as existsSync7, readdirSync, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
var AUTOLOAD_RE = /^autoloadSkills:\s*\[([^\]]*)\]\s*$/m;
function parseAutoloadSkills(frontmatter) {
  const match = AUTOLOAD_RE.exec(frontmatter);
  if (!match?.[1])
    return [];
  return match[1].split(",").map((name) => name.trim()).filter((name) => name.length > 0);
}
function frontmatterOf(agentFileContent) {
  const parts = agentFileContent.split(/^---\s*$/m);
  return parts[1] ?? "";
}
function skillExistsAt(skillsRoot, skillName) {
  return existsSync7(join3(skillsRoot, skillName, "SKILL.md"));
}
function checkSkillAutoload(options) {
  const home = options.home ?? homedir2();
  const agentsDir = join3(options.pluginRoot, "agents");
  const pluginSkillsRoot = join3(options.pluginRoot, "skills");
  const projectSkillsRoot = join3(options.cwd, ".omp", "skills");
  const userSkillsRoot = join3(home, ".omp", "agent", "skills");
  const problems = [];
  if (!existsSync7(agentsDir))
    return problems;
  const agentFiles = readdirSync(agentsDir).filter((name) => name.startsWith("foreman-") && name.endsWith(".md"));
  for (const fileName of agentFiles) {
    const agentName = fileName.replace(/\.md$/, "");
    const content = readFileSync4(join3(agentsDir, fileName), "utf8");
    const skills = parseAutoloadSkills(frontmatterOf(content));
    for (const skillName of skills) {
      if (skillExistsAt(projectSkillsRoot, skillName)) {
        problems.push({
          agent: agentName,
          skill: skillName,
          reason: "shadowed",
          shadowedBy: join3(projectSkillsRoot, skillName)
        });
        continue;
      }
      if (skillExistsAt(userSkillsRoot, skillName)) {
        problems.push({
          agent: agentName,
          skill: skillName,
          reason: "shadowed",
          shadowedBy: join3(userSkillsRoot, skillName)
        });
        continue;
      }
      if (!skillExistsAt(pluginSkillsRoot, skillName)) {
        problems.push({ agent: agentName, skill: skillName, reason: "missing" });
      }
    }
  }
  return problems;
}
function formatSkillGuardProblem(problem) {
  if (problem.reason === "missing") {
    return `${problem.agent}: autoloaded skill "${problem.skill}" resolves to nothing (silently ignored by omp).`;
  }
  return `${problem.agent}: autoloaded skill "${problem.skill}" is shadowed by ${problem.shadowedBy ?? "a native location"}, naming both paths.`;
}

// src/enforce/task-guard.ts
var FOREMAN_PREFIX = "foreman-";
var ISSUE_MARKER_RE = /^FOREMAN-ISSUE:\s*(\S+)\s*$/m;
var inheritedDispatchId = process.env.FOREMAN_DISPATCH_ID ?? null;
function stageFor(agent) {
  if (agent === "foreman-triage")
    return "triage";
  if (agent === "foreman-plan")
    return "plan";
  if (agent === "foreman-refine")
    return "refine";
  if (agent === "foreman-implement")
    return "implement";
  if (agent === "foreman-review")
    return "review";
  return null;
}
async function evaluateGate(stage, issue2, deps) {
  if (stage !== "refine" && stage !== "implement")
    return null;
  const membership = issue2.project ? { initiativeCount: (await deps.linear.projectInitiatives(issue2.project.id)).length } : undefined;
  return stage === "refine" ? refinementGate(issue2, membership) : implementationGate(issue2, membership);
}
async function fetchIssue(linear2, identifier) {
  const issue2 = await linear2.issue(identifier, { includeComments: true });
  if (!issue2)
    throw new Error(`Unknown issue "${identifier}".`);
  return issue2;
}
async function checkLockFree(deps, issue2) {
  if (!hasLabel(issue2, AGENT_LABEL.running))
    return { ok: true, failures: [] };
  let viewerId;
  try {
    viewerId = await deps.linear.viewerId();
  } catch {
    viewerId = null;
  }
  if (viewerId === null) {
    return {
      ok: false,
      failures: [
        {
          code: "agent-running",
          message: `\`${AGENT_LABEL.running}\` held and lock authorship could not be verified (viewer id unavailable); refusing to dispatch.`
        }
      ]
    };
  }
  const found = readLockComment(issue2.comments, viewerId);
  const state = lockState(found?.data ?? null, {
    now: deps.now(),
    liveDispatchIds: deps.liveDispatchIds()
  });
  if (state.held && !state.orphaned) {
    return {
      ok: false,
      failures: [{ code: "agent-running", message: `\`${AGENT_LABEL.running}\` held: ${state.reason}` }]
    };
  }
  return { ok: true, failures: [] };
}
async function claimLock(linear2, issue2, agent, dispatchId, worktree, now, ttlMs) {
  const runningLabel = await linear2.ensureLabel(AGENT_LABEL.running, issue2.team.id);
  await linear2.updateIssue(issue2.id, { addedLabelIds: [runningLabel.id] });
  const comment = renderLockComment({
    dispatchId,
    agent,
    issueId: issue2.identifier,
    takenAt: now.toISOString(),
    ttlMs,
    worktree,
    released: false,
    releasedAt: null
  });
  await linear2.createComment({ issueId: issue2.id, body: comment });
}
function appendMarkers(task, markers2) {
  const lines = Object.entries(markers2).filter((entry) => entry[1] !== undefined).map(([key, value]) => `${key}: ${value}`);
  return `${task}

${lines.join(`
`)}
`;
}
async function prepareItem(item, deps) {
  const agent = item.agent;
  if (!agent || !agent.startsWith(FOREMAN_PREFIX))
    return { item, contextDigest: null };
  const revised = { ...item, schemaMode: "strict" };
  delete revised.isolated;
  const stage = stageFor(agent);
  if (stage === null || !(agent in AGENT_OUTPUT_SCHEMAS)) {
    throw new Error(`Unknown Foreman agent "${agent}".`);
  }
  if (stage === "triage") {
    return { item: revised, contextDigest: await deps.contextDigest(null) };
  }
  if (stage === "plan") {
    const projectId = /^FOREMAN-PROJECT:\s*(\S+)\s*$/m.exec(item.task)?.[1];
    if (!projectId)
      throw new Error(`Missing "FOREMAN-PROJECT: <PROJECT-ID>" line in the task text for agent "${agent}".`);
    return { item: revised, contextDigest: await deps.contextDigest(projectId) };
  }
  const match = ISSUE_MARKER_RE.exec(item.task);
  const identifier = match?.[1];
  if (!identifier) {
    throw new Error(`Missing "FOREMAN-ISSUE: <IDENTIFIER>" line in the task text for agent "${agent}".`);
  }
  const issue2 = await fetchIssue(deps.linear, identifier);
  if (hasLabel(issue2, AGENT_LABEL.handsOff)) {
    throw new Error(`${identifier} carries \`${AGENT_LABEL.handsOff}\`; dispatch refused.`);
  }
  const blockedLabels = labelsInGroup(issue2, LABEL_GROUP.blocked);
  if (blockedLabels.length > 0) {
    throw new Error(`${identifier} carries \`${blockedLabels.join("`, `")}\`; dispatch refused.`);
  }
  const lockFree = await checkLockFree(deps, issue2);
  if (!lockFree.ok) {
    throw new Error(`${identifier}: ${gateSummary("implementation", lockFree)}`);
  }
  const gate = await evaluateGate(stage, issue2, deps);
  if (gate && !gate.ok) {
    const gateName = stage === "refine" ? "refinement" : "implementation";
    throw new Error(`${identifier}: ${gateSummary(gateName, gate)}`);
  }
  const now = deps.now();
  const dispatchId = inheritedDispatchId ?? deps.newDispatchId(agent, identifier, now);
  inheritedDispatchId = null;
  deps.registerLiveDispatch(dispatchId);
  const ttlMs = lockTtlMs(deps.config);
  let worktreePath = null;
  let branch = null;
  let baseBranch = null;
  let diffPath = null;
  const previousStateId = issue2.state.id;
  if (stage === "implement") {
    await assertIssueInScope({ linear: deps.linear, entry: deps.entry }, issue2);
    const repoPath = deps.entry.repoPath;
    branch = branchNameFor(deps.entry.branchPattern, issue2, repoPath);
    worktreePath = worktreePathFor(deps.entry.worktreePattern, repoPath, issue2);
    baseBranch = deps.entry.baseBranch;
    await deps.ensureWorktree({ repoPath, worktreePath, branch, baseBranch });
    const teamStates = await deps.linear.workflowStates(issue2.team.id);
    const inProgress = resolveState("inProgress", teamStates);
    await deps.linear.updateIssue(issue2.id, { stateId: inProgress.id });
  } else if (stage === "review") {
    await assertIssueInScope({ linear: deps.linear, entry: deps.entry }, issue2);
    const repoPath = deps.entry.repoPath;
    baseBranch = deps.entry.baseBranch;
    branch = issue2.branchName;
    const pr = await deps.github.prForBranch(repoPath, branch);
    const diff = deps.entry.pr.required && pr ? await deps.github.prDiff(repoPath, pr.number) : await diffRange(repoPath, baseBranch, branch);
    diffPath = await deps.writeDiffFile(identifier, diff);
  }
  await claimLock(deps.linear, issue2, agent, dispatchId, worktreePath, now, ttlMs);
  revised.task = appendMarkers(item.task, {
    "FOREMAN-DISPATCH": dispatchId,
    "FOREMAN-WORKTREE": worktreePath ?? undefined,
    "FOREMAN-BRANCH": branch ?? undefined,
    "FOREMAN-DIFF": diffPath ?? undefined,
    "FOREMAN-BASE": baseBranch ?? undefined,
    "FOREMAN-PREV-STATE": stage === "implement" ? previousStateId : undefined
  });
  return {
    item: revised,
    contextDigest: null,
    cleanup: {
      issue: issue2,
      dispatchId,
      agent,
      worktree: worktreePath,
      takenAt: now,
      ttlMs,
      previousStateId: stage === "implement" ? previousStateId : null
    }
  };
}
async function unwindPrepared(cleanups, deps) {
  await Promise.all(cleanups.map(async (cleanup2) => {
    try {
      const running = await deps.linear.ensureLabel(AGENT_LABEL.running, cleanup2.issue.team.id);
      await deps.linear.updateIssue(cleanup2.issue.id, {
        removedLabelIds: [running.id],
        ...cleanup2.previousStateId ? { stateId: cleanup2.previousStateId } : {}
      });
      await deps.linear.createComment({
        issueId: cleanup2.issue.id,
        body: renderLockComment({
          dispatchId: cleanup2.dispatchId,
          agent: cleanup2.agent,
          issueId: cleanup2.issue.identifier,
          takenAt: cleanup2.takenAt.toISOString(),
          ttlMs: cleanup2.ttlMs,
          worktree: cleanup2.worktree,
          released: true,
          releasedAt: deps.now().toISOString()
        })
      });
    } catch {} finally {
      deps.releaseLiveDispatch(cleanup2.dispatchId);
    }
  }));
}
async function prepareTaskCall(input, deps) {
  const cleanups = [];
  try {
    const flat = input.tasks === undefined;
    const items = input.tasks ?? [
      {
        agent: input.agent,
        task: input.task ?? "",
        outputSchema: input.outputSchema,
        schemaMode: input.schemaMode,
        isolated: input.isolated
      }
    ];
    const revisedItems = [];
    let contextAppend = "";
    for (const item of items) {
      const prepared = await prepareItem(item, deps);
      if (prepared.cleanup)
        cleanups.push(prepared.cleanup);
      if (prepared.contextDigest)
        contextAppend += `

${prepared.contextDigest}`;
      revisedItems.push(prepared.item);
    }
    const first = revisedItems[0];
    const revisedInput = flat ? {
      ...input,
      agent: first?.agent,
      task: first?.task,
      schemaMode: first?.schemaMode,
      isolated: first?.isolated
    } : { ...input, tasks: revisedItems };
    if (contextAppend.length > 0) {
      revisedInput.context = `${input.context ?? ""}${contextAppend}`;
    }
    return { input: revisedInput };
  } catch (error) {
    await unwindPrepared(cleanups, deps);
    return { block: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

// src/lock/reaper.ts
async function clearOrphanedLock(linear2, issue2, found, now) {
  const runningLabel = issue2.labels.find((label) => label.name === AGENT_LABEL.running);
  const removedLabelIds = runningLabel ? [runningLabel.id] : [];
  const needsInputLabel = await linear2.ensureLabel(BLOCKED_LABEL.needsInput, issue2.team.id);
  await linear2.updateIssue(issue2.id, {
    addedLabelIds: [needsInputLabel.id],
    removedLabelIds
  });
  const body = encodeMarker(MARKER_KIND.lock, { dispatchId: found.data.dispatchId, reapedAt: now.toISOString() }, [
    `Reaped an orphaned lock: dispatch \`${found.data.dispatchId}\` (\`${found.data.agent}\`), taken at ${found.data.takenAt}.`,
    found.data.worktree ? `Worktree left in place for inspection: \`${found.data.worktree}\`.` : "No worktree was recorded."
  ].join(`
`));
  await linear2.createComment({ issueId: issue2.id, body });
  return {
    issueId: issue2.identifier,
    dispatchId: found.data.dispatchId,
    agent: found.data.agent,
    takenAt: found.data.takenAt,
    worktree: found.data.worktree
  };
}
async function sweep(linear2, now = new Date, liveDispatchIds = []) {
  let viewerId;
  try {
    viewerId = await linear2.viewerId();
  } catch {
    viewerId = null;
  }
  if (viewerId === null)
    return [];
  const issues = await linear2.issues({ filter: IN_FLIGHT_FILTER, includeComments: true });
  const reaped = [];
  for (const issue2 of issues) {
    const found = readLockComment(issue2.comments, viewerId);
    if (!found)
      continue;
    const state = lockState(found.data, { now, liveDispatchIds });
    if (!state.orphaned)
      continue;
    reaped.push(await clearOrphanedLock(linear2, issue2, found, now));
  }
  return reaped;
}

// src/commands/apply.ts
async function runApplyCommand(linear2, argv, entry) {
  const usage = [
    "Usage:",
    "  /foreman:apply",
    "  /foreman:apply --yes",
    "  /foreman:apply ENG-1 --approve",
    "  /foreman:apply ENG-1 --reject <reason>"
  ].join(`
`);
  if (argv.length === 1 && argv[0] === "--help") {
    return { ok: true, mutated: false, message: usage };
  }
  if (argv.length === 0) {
    const candidates = await findApprovedUnapplied(linear2);
    return {
      ok: true,
      mutated: false,
      message: candidates.length > 0 ? `${candidates.length} approved proposal(s) pending apply.` : "Nothing to apply.",
      plan: candidates.map((candidate) => ({ issueId: candidate.issue.identifier, item: candidate.item }))
    };
  }
  if (argv.length === 1 && argv[0] === "--yes") {
    const { applied, failures } = await runApplyPass(linear2);
    const lines = [`Applied ${applied.length} approved proposal(s).`];
    for (const proposal of applied) {
      if (proposal.note)
        lines.push(`- ${proposal.identifier}: ${proposal.note}`);
    }
    for (const failure of failures) {
      lines.push(`- ${failure.identifier}: failed to apply: ${failure.error}`);
    }
    return { ok: failures.length === 0, mutated: applied.length > 0, message: lines.join(`
`) };
  }
  const [issueId, flag, ...rest] = argv;
  if (!issueId || !flag)
    return { ok: false, mutated: false, message: usage };
  const issue2 = await linear2.issue(issueId, { includeComments: true });
  if (!issue2)
    return { ok: false, mutated: false, message: `Unknown issue "${issueId}".` };
  if (entry)
    await assertIssueInScope({ linear: linear2, entry }, issue2);
  if (flag === "--approve" && rest.length === 0) {
    const found = latestProposal(issue2);
    if (!found)
      return { ok: false, mutated: false, message: `${issueId} has no proposal marker.` };
    if (hasLaterApplied(issue2, found.createdAt)) {
      return { ok: false, mutated: false, message: `${issueId} was already applied.` };
    }
    if (hasLaterReject(issue2, found.createdAt)) {
      return { ok: false, mutated: false, message: `${issueId} has a reject: reply; cannot approve.` };
    }
    const proposedLabel = issue2.labels.find((label) => label.name === AGENT_LABEL.proposed);
    try {
      await applyProposal(linear2, { issue: issue2, item: found.data, proposedAt: found.createdAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, mutated: false, message: `Could not apply ${issueId}: ${message}` };
    }
    if (proposedLabel) {
      await linear2.updateIssue(issue2.id, { removedLabelIds: [proposedLabel.id] });
    }
    return { ok: true, mutated: true, message: `Approved and applied ${issueId}.` };
  }
  if (flag === "--reject") {
    const reason = rest.join(" ").trim();
    if (reason.length === 0)
      return { ok: false, mutated: false, message: `${usage} (reason required)` };
    const body = `reject: ${reason}`;
    await linear2.createComment({ issueId: issue2.id, body });
    return { ok: true, mutated: true, message: `Rejected ${issueId}: ${reason}` };
  }
  return { ok: false, mutated: false, message: usage };
}

// src/runtime.ts
class ExtensionRuntimeNotInitializedError extends Error {
  constructor() {
    super("Foreman runtime accessed before initialization. Call initRuntime() from session_start first.");
    this.name = "ExtensionRuntimeNotInitializedError";
  }
}
var activeDispatchIds = new Set;
function registerLiveDispatch(dispatchId) {
  activeDispatchIds.add(dispatchId);
}
function releaseLiveDispatch(dispatchId) {
  activeDispatchIds.delete(dispatchId);
}
function liveDispatchIds() {
  return [...activeDispatchIds];
}
var runtime = null;
function productDigest(initiative) {
  const doc = initiative?.documents.find((entry) => entry.title.trim().toLowerCase() === "context");
  const body = doc?.content?.trim();
  return `## Product Context (${initiative?.name ?? "unknown"})
${body && body.length > 0 ? body : "_none_"}`;
}
function projectBriefDigest(project) {
  const body = project.content?.trim() || project.description?.trim();
  return `## Project Brief (${project.name})
${body && body.length > 0 ? body : "_none_"}`;
}
function initRuntime(options) {
  const { config: config2, warnings } = loadGlobalConfig(options);
  let linear2 = null;
  let missingApiKey = false;
  try {
    const apiKey = resolveLinearApiKey(config2, options?.env ?? process.env);
    let team2 = null;
    try {
      team2 = entryForCwd(config2, process.cwd(), options?.home).team;
    } catch {
      team2 = null;
    }
    linear2 = new LinearClient({
      apiKey,
      endpoint: config2.linear.endpoint,
      team: team2
    });
  } catch {
    missingApiKey = true;
  }
  runtime = {
    config: config2,
    linear: linear2,
    github: new GitHubClient,
    lockTtlMs: lockTtlMs(config2),
    stateCache: new Map,
    contextDigestCache: new Map,
    entry: null
  };
  return { ok: true, missingApiKey, warnings };
}
function requireRuntime() {
  if (!runtime)
    throw new ExtensionRuntimeNotInitializedError;
  return runtime;
}
function getConfig() {
  return requireRuntime().config;
}
function getEntry() {
  const rt = requireRuntime();
  if (!rt.entry) {
    rt.entry = entryForCwd(rt.config, process.cwd());
  }
  return rt.entry;
}
function isRepoRegistered(cwd = process.cwd()) {
  const rt = requireRuntime();
  if (cwd === process.cwd() && rt.entry)
    return true;
  try {
    const entry = entryForCwd(rt.config, cwd);
    if (cwd === process.cwd())
      rt.entry = entry;
    return true;
  } catch (error) {
    if (error instanceof ConfigError)
      return false;
    throw error;
  }
}
function getLinear() {
  const linear2 = requireRuntime().linear;
  if (!linear2) {
    throw new Error("No Linear API key resolved. Set the env var named by linear.apiKeyEnv, or point linear.apiKeyFile at a file whose first line is the key, in ~/.foreman/config.json.");
  }
  return linear2;
}
function getGitHub() {
  return requireRuntime().github;
}
async function getContextDigest(projectId) {
  const rt = requireRuntime();
  const cached = rt.contextDigestCache.get(projectId);
  if (cached)
    return cached;
  const linear2 = getLinear();
  const project = await linear2.project(projectId);
  if (!project) {
    return `## Product Context
_project not found_

## Project Brief
_project not found_`;
  }
  let initiative = null;
  try {
    const ref = await linear2.projectInitiative(projectId);
    initiative = await linear2.initiative(ref.id);
  } catch {
    initiative = null;
  }
  const digest = `${productDigest(initiative)}

${projectBriefDigest(project)}`;
  rt.contextDigestCache.set(projectId, digest);
  return digest;
}
function resetRuntime() {
  runtime = null;
  activeDispatchIds.clear();
}

// src/commands/merge.ts
function latestReview(comments, authoredBy) {
  if (authoredBy === null)
    return null;
  return latestMarker(MARKER_KIND.review, comments, { authoredBy })?.data ?? null;
}
async function runMerge(linear2, github2, issueId, entry = getEntry()) {
  const issue2 = await linear2.issue(issueId, { includeComments: true });
  if (!issue2)
    return { merged: false, message: `Unknown issue "${issueId}".` };
  if (!issue2.project)
    return { merged: false, message: `${issueId} has no project; cannot resolve its repo.` };
  await assertIssueInScope({ linear: linear2, entry }, issue2);
  const repoPath = entry.repoPath;
  const repoSettings = entry;
  const branch = issue2.branchName;
  let viewerId;
  try {
    viewerId = await linear2.viewerId();
  } catch {
    viewerId = null;
  }
  const states2 = await linear2.workflowStates(issue2.team.id);
  const done = resolveState("done", states2);
  if (issue2.state.id === done.id) {
    return { merged: true, message: `${issueId} is already Done.` };
  }
  let pr = await github2.prForBranch(repoPath, branch, { base: repoSettings.baseBranch });
  let gitMergeComplete = false;
  let mergedPrNumber = null;
  if (repoSettings.pr.required) {
    if (pr?.state.toLowerCase() === "merged") {
      gitMergeComplete = true;
      mergedPrNumber = pr.number;
    } else {
      const anyPr = await github2.prForBranch(repoPath, branch, { base: repoSettings.baseBranch, state: "all" });
      if (anyPr?.state.toUpperCase() === "MERGED") {
        gitMergeComplete = true;
        mergedPrNumber = anyPr.number;
      }
    }
  } else {
    const mergedMarker = viewerId !== null ? latestMarker(MARKER_KIND.merged, issue2.comments, { authoredBy: viewerId }) : null;
    gitMergeComplete = mergedMarker !== null;
  }
  if (!gitMergeComplete) {
    const headSha = pr?.headSha ?? null;
    const ciStatus = headSha ? await github2.ciStatus(repoPath, headSha) : "none";
    const review3 = latestReview(issue2.comments, viewerId);
    const gate = reviewGate({
      issue: issue2,
      review: review3,
      headSha,
      ciStatus,
      prOpen: pr !== null && pr.state.toLowerCase() === "open",
      prRequired: repoSettings.pr.required,
      ciRequired: repoSettings.pr.ciRequired
    });
    if (!gate.ok) {
      const bullets = gate.failures.map((failure) => `- ${failure.message}`).join(`
`);
      return { merged: false, message: `review gate: fail
${bullets}` };
    }
    if (repoSettings.pr.required) {
      if (!pr)
        return { merged: false, message: `No open PR found for branch ${branch}.` };
      await github2.mergePr(repoPath, pr.number, repoSettings.merge.strategy, repoSettings.merge.deleteBranch);
      mergedPrNumber = pr.number;
    } else {
      const mergeCommit = await github2.mergeBranchLocally(repoPath, branch, repoSettings.baseBranch, repoSettings.merge.strategy, repoSettings.merge.deleteBranch);
      const body = encodeMarker(MARKER_KIND.merged, {
        issueId: issue2.identifier,
        branch,
        baseBranch: repoSettings.baseBranch,
        mergeCommit,
        strategy: repoSettings.merge.strategy,
        mergedAt: new Date().toISOString()
      }, `Merged \`${branch}\` into \`${repoSettings.baseBranch}\` at \`${mergeCommit}\` via ${repoSettings.merge.strategy}.`);
      await linear2.createComment({ issueId: issue2.id, body });
    }
  }
  try {
    await linear2.updateIssue(issue2.id, { stateId: done.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mergeDesc = mergedPrNumber !== null ? `PR #${mergedPrNumber} merged` : `Branch \`${branch}\` merged into \`${repoSettings.baseBranch}\``;
    return {
      merged: false,
      message: `${mergeDesc}; ${issueId} could NOT be moved to Done: ${message}
` + `Re-run \`/foreman:merge ${issueId}\` to finish the Linear transition.`
    };
  }
  const cleanupNotes = await cleanupMergedWork({
    repoPath,
    worktreePattern: repoSettings.worktreePattern,
    baseBranch: repoSettings.baseBranch,
    issue: issue2
  });
  const cleanupSuffix = cleanupNotes.length > 0 ? ` (${cleanupNotes.join("; ")})` : "";
  if (gitMergeComplete) {
    const via2 = mergedPrNumber !== null ? `PR #${mergedPrNumber}` : `local ${repoSettings.merge.strategy}`;
    return { merged: true, message: `Moved ${issueId} to Done (git merge via ${via2} was already complete).${cleanupSuffix}` };
  }
  const via = mergedPrNumber !== null ? `PR #${mergedPrNumber}` : repoSettings.merge.strategy;
  return { merged: true, message: `Merged ${issueId} (${branch}) via ${via}; moved to Done.${cleanupSuffix}` };
}

// src/commands/unblock.ts
async function runUnblock(linear2, issueId, reply, entry) {
  if (reply.trim().length === 0) {
    return { ok: false, message: "A non-empty reply is required." };
  }
  const issue2 = await linear2.issue(issueId);
  if (!issue2)
    return { ok: false, message: `Unknown issue "${issueId}".` };
  if (entry)
    await assertIssueInScope({ linear: linear2, entry }, issue2);
  const blockedLabelNames = labelsInGroup(issue2, LABEL_GROUP.blocked);
  if (blockedLabelNames.length === 0) {
    return { ok: false, message: `${issueId} carries no blocked:* label; nothing to unblock.` };
  }
  const removedLabelIds = issue2.labels.filter((label) => blockedLabelNames.includes(label.name)).map((label) => label.id);
  const body = encodeMarker(MARKER_KIND.unblock, { reply }, `**Operator reply:** ${reply}`);
  await linear2.createComment({ issueId: issue2.id, body });
  await linear2.updateIssue(issue2.id, { removedLabelIds });
  return { ok: true, message: `${issueId} unblocked; the loop will re-dispatch on its next pass.` };
}

// src/render/issue-description.ts
function renderList(items) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join(`
`) : "_none_";
}
function renderCriteria(items) {
  return items.length > 0 ? items.map((item) => `- [ ] ${item}`).join(`
`) : "_none_";
}
function renderIssueDescription(input) {
  const openQuestions = input.openQuestions ?? [];
  return [
    "## Context",
    input.context.trim().length > 0 ? input.context.trim() : "_none_",
    "",
    "## Acceptance Criteria",
    renderCriteria(input.acceptanceCriteria),
    "",
    "## Affected Areas",
    renderList(input.affectedAreas),
    "",
    "## Out of Scope",
    renderList(input.outOfScope),
    "",
    "## Open Questions",
    renderList(openQuestions)
  ].join(`
`);
}
// src/render/spike.ts
function renderSpikeIssue(spec, blocks) {
  return [
    "## Question",
    spec.question,
    "",
    "## Budget",
    spec.budget,
    "",
    "## Deliverable",
    spec.deliverable,
    "",
    `A native \`blocks\` relation to ${blocks.identifier} is created by the extension — ` + "this spike blocks that issue's estimation until the deliverable lands."
  ].join(`
`);
}
// src/render/review-comment.ts
var SEVERITY_ORDER = ["blocking", "should-fix", "nit"];
function renderFindingLine(finding) {
  const location = finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
  return `- ${location} — ${finding.description}`;
}
function renderFindingsBySeverity(findings) {
  return SEVERITY_ORDER.map((severity) => {
    const inGroup = findings.filter((finding) => finding.severity === severity);
    const body = inGroup.length > 0 ? inGroup.map(renderFindingLine).join(`
`) : "_none_";
    return `### ${severity}
${body}`;
  }).join(`

`);
}
function renderReviewComment(result) {
  const criteriaLines = result.criteriaVerification.map((entry) => `- [${entry.satisfied ? "x" : " "}] ${entry.criterion} — ${entry.evidence}`).join(`
`);
  const dodLines = result.dodChecklist.map((check2) => `- [${check2.satisfied ? "x" : " "}] ${check2.item} — ${check2.evidence}`).join(`
`);
  const scopeCreepBody = result.scopeCreep.length > 0 ? result.scopeCreep.map((item) => `- ${item}`).join(`
`) : "_none_";
  return [
    `Reviewed \`${result.reviewedSha}\`. Verdict: **${result.verdict}**.`,
    "",
    "## Acceptance Criteria",
    criteriaLines.length > 0 ? criteriaLines : "_none_",
    "",
    "## Definition of Done",
    dodLines.length > 0 ? dodLines : "_none_",
    "",
    "## Findings",
    renderFindingsBySeverity(result.findings),
    "",
    "## Project Organization",
    result.projectOrganization,
    "",
    "## Scope Creep",
    scopeCreepBody,
    "",
    "## Test Adequacy",
    result.testAdequacy
  ].join(`
`);
}
// src/render/proposal-comment.ts
function renderProposalComment(item) {
  const dedupeLine = item.duplicateOf !== null ? `Duplicate of ${item.duplicateOf}.` : "No duplicate found.";
  const blockersLine = item.proposedBlockedBy.length > 0 ? item.proposedBlockedBy.join(", ") : "_none_";
  const missingInfoLine = item.missingInfo.length > 0 ? item.missingInfo.map((line) => `- ${line}`).join(`
`) : "_none_";
  return [
    `**Classification:** \`${item.type}\``,
    `**Proposed priority:** ${priorityName(item.proposedPriority)} — ${item.severityReasoning}`,
    `**Dedupe:** ${dedupeLine}`,
    `**Proposed blocked by:** ${blockersLine}`,
    `**Destination:** ${item.destination}`,
    `**Project:** ${item.destinationProject ?? "_none proposed — the refinement gate fails until one is set_"}`,
    `**Repro confidence:** ${item.reproConfidence}`,
    item.triageLabel !== null ? `**Triage disposition:** \`${item.triageLabel}\`` : null,
    "",
    "**Missing info:**",
    missingInfoLine,
    "",
    `To approve, remove the \`${AGENT_LABEL.proposed}\` label. To reject, reply ` + "`reject: <reason>`."
  ].filter((line) => line !== null).join(`
`);
}
// src/render/block-comment.ts
function renderBlockComment(record) {
  const lines = [
    `**What I was doing:** ${record.whatIWasDoing}`,
    `**What I need:** ${record.whatINeed}`
  ];
  if (record.type === "dependency") {
    lines.push(`**Blocked by:** ${record.blockedByIssues.join(", ")}`, "No `blocked:*` label was applied — the native `blocks` relation is the " + "state, and it resolves itself once the blocker completes.");
  } else {
    lines.push("**Options:**");
    if (record.options !== null && record.options.length > 0) {
      for (const option of record.options) {
        lines.push(`- ${option.label} — ${option.tradeoff}`);
      }
    } else {
      lines.push("_none_");
    }
    lines.push(`**Recommendation:** ${record.recommendation ?? "_none — no clear lean_"}`);
  }
  const state = record.stateLeftBehind;
  lines.push("**State left behind:**", `- Worktree: ${state.worktree ?? "_none_"}`, `- Branch: ${state.branch ?? "_none_"}`, `- Pushed: ${state.pushed ? "yes" : "no"}`, `- Commits: ${state.commits.length > 0 ? state.commits.join(", ") : "_none_"}`);
  if (state.notes.length > 0)
    lines.push(`- Notes: ${state.notes}`);
  lines.push(`**Cost of a wrong guess:** ${record.costOfWrongGuess}`);
  return lines.join(`
`);
}
// src/render/status.ts
function formatAge(ageMs) {
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60)
    return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}
function renderStatusConsole(state) {
  const sections = [];
  const pastTtlCount = state.locks.filter((lock2) => lock2.pastTtl).length;
  sections.push(`**${state.blocked.length} blocked · ${state.proposalsAwaiting.count} proposals awaiting · ` + `${state.locks.length} locks (${pastTtlCount} past TTL) · mode ${state.loop.mode}**`);
  sections.push("## Blocked (human)");
  sections.push(state.blocked.length > 0 ? state.blocked.map((entry) => `- ${entry.issueId} [${entry.type}] ${entry.question}`).join(`
`) : "_none — nothing waiting on the operator_");
  sections.push("## Locks");
  sections.push(state.locks.length > 0 ? state.locks.map((lock2) => `- ${lock2.pastTtl ? "⚠ " : ""}${lock2.issueId} held by ${lock2.agent} (dispatch ${lock2.dispatchId}, ` + `age ${formatAge(lock2.ageMs)}${lock2.pastTtl ? ", **PAST TTL**" : ""})`).join(`
`) : "_none_");
  sections.push("## Proposals awaiting approval");
  sections.push(state.proposalsAwaiting.count > 0 ? `${state.proposalsAwaiting.count} pending: ${state.proposalsAwaiting.issueIds.join(", ")}` : "_none_");
  sections.push("## Agent registry");
  sections.push(state.agents.length > 0 ? state.agents.map((entry) => `- ${entry.agent}: ${entry.state}${entry.issueId ? ` (${entry.issueId})` : ""}`).join(`
`) : "_none_");
  sections.push("## Loop");
  const workerLines = state.loop.workers.length > 0 ? state.loop.workers.map((worker) => `- ${worker.worker}: last run ${worker.lastRunAt ?? "never"}, ` + `${worker.dispatchCount} dispatched`).join(`
`) : "_none_";
  const modeLine = `Mode: ${state.loop.mode}${state.loop.mode === "confirm" ? " _(every write needs approval)_" : ""}`;
  sections.push(`${modeLine}
${workerLines}`);
  sections.push("## Backpressure");
  sections.push(state.backpressure.tripped ? `**TRIPPED** — ${state.backpressure.reason ?? "no reason recorded"}` : "clear");
  return sections.join(`

`);
}
// src/commands/status.ts
var AGENT_REGISTRY_STATE = {
  starting: "idle",
  running: "running",
  settled: "parked",
  lost: "aborted",
  unknown: "idle"
};
function readLoopState(statusPath, now, cadenceMinutes = 5) {
  const status = readStatusFile(statusPath);
  if (!status) {
    return { loop: { mode: "unknown (no running loop)", workers: [] }, backpressure: { tripped: false, reason: null }, agents: [] };
  }
  const staleAfterMs = statusStaleThresholdMs(cadenceMinutes);
  const ageMs = now.getTime() - new Date(status.writtenAt).getTime();
  if (ageMs > staleAfterMs) {
    if (status.snapshot.runtime.state === "paused") {
      return {
        loop: { mode: "paused", workers: status.snapshot.workers.map((worker) => ({ worker: worker.name, lastRunAt: worker.lastRunAt, dispatchCount: worker.dispatched })) },
        backpressure: { tripped: status.snapshot.backpressure.tripped, reason: status.snapshot.backpressure.reason },
        agents: status.snapshot.agents.map((agent) => ({ agent: agent.agent, state: AGENT_REGISTRY_STATE[agent.status], issueId: agent.issueId }))
      };
    }
    return {
      loop: { mode: "stopped/stale", workers: [] },
      backpressure: { tripped: false, reason: `Last loop status is older than ${Math.round(staleAfterMs / 1000)} seconds.` },
      agents: []
    };
  }
  const { snapshot } = status;
  const workers = snapshot.workers.map((worker) => ({
    worker: worker.name,
    lastRunAt: worker.lastRunAt,
    dispatchCount: worker.dispatched
  }));
  const agents = snapshot.agents.map((agent) => ({
    agent: agent.agent,
    state: AGENT_REGISTRY_STATE[agent.status],
    issueId: agent.issueId
  }));
  return {
    loop: { mode: snapshot.runtime.mode, workers },
    backpressure: { tripped: snapshot.backpressure.tripped, reason: snapshot.backpressure.reason },
    agents
  };
}
function questionFor(issue2) {
  const found = decodeMarker(MARKER_KIND.block, issue2.description ?? "");
  if (found)
    return found.whatINeed;
  const latestBlockComment = [...issue2.comments].reverse().map((comment) => decodeMarker(MARKER_KIND.block, comment.body)).find((data) => data !== null);
  return latestBlockComment?.whatINeed ?? "(no BlockRecord found on this issue)";
}
async function buildStatusState(linear2, stateDir, now = new Date, cadenceMinutes = 5) {
  const [blockedIssues, inFlightIssues, proposalIssues] = await Promise.all([
    linear2.issues({ filter: BLOCKED_HUMAN_FILTER, includeComments: true }),
    linear2.issues({ filter: IN_FLIGHT_FILTER, includeComments: true }),
    linear2.issues({ filter: PROPOSALS_FILTER })
  ]);
  const blocked = blockedIssues.map((issue2) => ({
    issueId: issue2.identifier,
    type: labelsInGroup(issue2, LABEL_GROUP.blocked)[0] ?? "unknown",
    question: questionFor(issue2)
  }));
  const locks = inFlightIssues.map((issue2) => {
    const found = readLockComment(issue2.comments);
    if (!found)
      return null;
    const state = lockState(found.data, { now, liveDispatchIds: liveDispatchIds() });
    return {
      issueId: issue2.identifier,
      agent: found.data.agent,
      dispatchId: found.data.dispatchId,
      ageMs: now.getTime() - new Date(found.data.takenAt).getTime(),
      pastTtl: state.expired
    };
  }).filter((entry) => entry !== null);
  const { loop, backpressure, agents } = readLoopState(stateDir, now, cadenceMinutes);
  return {
    blocked,
    locks,
    proposalsAwaiting: { count: proposalIssues.length, issueIds: proposalIssues.map((issue2) => issue2.identifier) },
    agents,
    loop,
    backpressure
  };
}
async function renderStatus(linear2) {
  const config2 = getConfig();
  const state = await buildStatusState(linear2, loopPaths(config2, getEntry().alias).status, new Date, config2.loop.cadenceMinutes);
  return renderStatusConsole(state);
}

// src/commands/names.ts
var COMMAND_NAMES = {
  status: "foreman:status",
  apply: "foreman:apply",
  merge: "foreman:merge",
  unblock: "foreman:unblock"
};

// src/tools/github-pr.ts
import { realpathSync as realpathSync3 } from "node:fs";
import { isAbsolute as isAbsolute2, resolve as resolve2 } from "node:path";
var OPS = ["create", "view"];
async function gitCommonDir(repoPath) {
  try {
    const { stdout } = await nodeRunner.run(["git", "rev-parse", "--git-common-dir"], { cwd: repoPath });
    const raw = stdout.trim();
    const absolute = isAbsolute2(raw) ? raw : resolve2(repoPath, raw);
    return realpathSync3(absolute);
  } catch {
    return null;
  }
}
function registerGitHubPrTool(pi) {
  const shape = {
    op: pi.zod.enum(OPS),
    repoPath: pi.zod.string().describe("Absolute path to the repo (the worktree's origin repo, not the worktree itself)."),
    title: pi.zod.string().optional().describe('PR title. Required for op "create".'),
    body: pi.zod.string().optional().describe('PR body. Required for op "create".'),
    head: pi.zod.string().optional().describe("Head branch. Required for both ops."),
    base: pi.zod.string().optional().describe('Base branch. Required for op "create".'),
    draft: pi.zod.boolean().optional().describe("Open as a draft PR.")
  };
  const config2 = {
    name: "foreman_github_pr",
    label: "GitHub PR",
    description: "Create or view the pull request for a branch. The one mutation tool any Foreman agent holds.",
    parameters: pi.zod.object(shape),
    approval: "write",
    loadMode: "essential",
    execute: async (_toolCallId, params) => {
      const entry = getEntry();
      let repoPath;
      try {
        repoPath = realpathSync3(params.repoPath);
      } catch {
        return errorResult(`repoPath "${params.repoPath}" does not exist.`);
      }
      if (repoPath !== realpathSync3(entry.repoPath)) {
        const [worktreeCommonDir, repoCommonDir] = await Promise.all([gitCommonDir(repoPath), gitCommonDir(entry.repoPath)]);
        if (worktreeCommonDir === null || worktreeCommonDir !== repoCommonDir) {
          return errorResult(`repoPath must resolve to Foreman's registered repository (${entry.repoPath}) or one of its worktrees.`);
        }
      }
      const github2 = getGitHub();
      if (params.op === "view") {
        if (!params.head)
          return errorResult('op "view" requires "head".');
        const pr2 = await github2.prForBranch(repoPath, params.head);
        return jsonResult(pr2);
      }
      const repoSettings = entry;
      if (!repoSettings.pr.required) {
        return errorResult("This repo sets pr.required: false (direct-branch mode). Push the branch instead of opening a PR.");
      }
      if (!params.title || !params.body || !params.head || !params.base) {
        return errorResult('op "create" requires "title", "body", "head", and "base".');
      }
      const pr = await github2.createPr(repoPath, {
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        draft: params.draft ?? repoSettings.pr.draft
      });
      return jsonResult(pr);
    }
  };
  pi.registerTool(config2);
}
function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: { data } };
}
function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// src/tools/linear-read.ts
var SAVED_VIEWS = {
  inbox: () => INBOX_FILTER,
  "blocked-human": () => BLOCKED_HUMAN_FILTER,
  "blocked-deps": () => BLOCKED_DEPS_FILTER,
  proposals: () => PROPOSALS_FILTER,
  ready: () => readyFilter(),
  "in-flight": () => IN_FLIGHT_FILTER
};
var OPS2 = ["issue", "issues", "comments", "project_context", "states", "labels", "teams", "view"];
function registerLinearReadTool(pi) {
  const shape = {
    op: pi.zod.enum(OPS2).describe("Which read to perform."),
    id: pi.zod.string().optional().describe("Issue identifier, project id, or team id, depending on op."),
    view: pi.zod.enum(["inbox", "blocked-human", "blocked-deps", "proposals", "ready", "in-flight"]).optional().describe('Saved view name, required when op is "view".'),
    includeComments: pi.zod.boolean().optional().describe("Include comments on the returned issue(s)."),
    limit: pi.zod.number().int().positive().optional().default(50).describe('Max issues to return for "issues" or "view".')
  };
  const config2 = {
    name: "foreman_linear_read",
    label: "Linear (read)",
    description: "Read Linear issues, comments, project context, workflow states, labels, teams, and saved views. Read-only.",
    parameters: pi.zod.object(shape),
    approval: "read",
    loadMode: "essential",
    execute: async (_toolCallId, params) => {
      const linear2 = getLinear();
      if (params.op === "issue") {
        if (!params.id)
          return errorResult2('op "issue" requires "id".');
        const issue2 = await linear2.issue(params.id, { includeComments: params.includeComments });
        return jsonResult2(issue2);
      }
      if (params.op === "issues") {
        const fetched = await linear2.issues({ limit: params.limit + 1, includeComments: params.includeComments });
        const truncated = fetched.length > params.limit;
        const issues = truncated ? fetched.slice(0, params.limit) : fetched;
        return jsonResult2({ issues, truncated, total: issues.length });
      }
      if (params.op === "comments") {
        if (!params.id)
          return errorResult2('op "comments" requires "id".');
        return jsonResult2(await linear2.comments(params.id));
      }
      if (params.op === "project_context") {
        if (!params.id)
          return errorResult2('op "project_context" requires "id" (project id).');
        const digest = await getContextDigest(params.id);
        return jsonResult2({ digest });
      }
      if (params.op === "states") {
        if (!params.id)
          return errorResult2('op "states" requires "id" (team id).');
        return jsonResult2(await linear2.workflowStates(params.id));
      }
      if (params.op === "labels") {
        return jsonResult2(await linear2.labels(params.id));
      }
      if (params.op === "teams") {
        return jsonResult2(await linear2.teams());
      }
      if (!params.view)
        return errorResult2('op "view" requires "view".');
      const buildFilter = SAVED_VIEWS[params.view];
      if (!buildFilter)
        return errorResult2(`Unknown view "${params.view}".`);
      const fetchedView = await linear2.issues({ filter: buildFilter(), limit: params.limit + 1 });
      const viewTruncated = fetchedView.length > params.limit;
      const viewIssues = viewTruncated ? fetchedView.slice(0, params.limit) : fetchedView;
      return jsonResult2({ issues: viewIssues, truncated: viewTruncated, total: viewIssues.length });
    }
  };
  pi.registerTool(config2);
}
function jsonResult2(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: { data } };
}
function errorResult2(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// src/results/apply.ts
async function releaseLock(deps, issue2) {
  if (!issue2.labels.some((label) => label.name === AGENT_LABEL.running))
    return;
  const runningLabel = issue2.labels.find((label) => label.name === AGENT_LABEL.running);
  if (!runningLabel)
    return;
  await deps.linear.updateIssue(issue2.id, { removedLabelIds: [runningLabel.id] });
}
async function moveToState(deps, issue2, stateKey) {
  const states2 = await deps.linear.workflowStates(issue2.team.id);
  const target = resolveState(stateKey, states2);
  await deps.linear.updateIssue(issue2.id, { stateId: target.id });
}
async function applyTriage(deps, result) {
  for (const item of result.items) {
    const issue2 = await deps.linear.issue(item.issueId);
    if (!issue2)
      continue;
    const human = renderProposalComment(item);
    const body = encodeMarker(MARKER_KIND.proposal, item, human);
    await deps.linear.createComment({ issueId: issue2.id, body });
    const proposedLabel = await deps.linear.ensureLabel(AGENT_LABEL.proposed, issue2.team.id);
    await deps.linear.updateIssue(issue2.id, { addedLabelIds: [proposedLabel.id] });
  }
}
async function applyRefine(deps, result) {
  const issue2 = await deps.linear.issue(result.issueId);
  if (!issue2)
    throw new Error(`RefineResult references unknown issue ${result.issueId}.`);
  const description = renderIssueDescription({
    context: result.refinedDescription,
    acceptanceCriteria: result.acceptanceCriteria,
    affectedAreas: result.affectedAreas,
    outOfScope: result.outOfScope
  });
  const mutation = {
    description,
    estimate: result.estimate
  };
  const legacyLabel = issue2.labels.find((label) => label.name === LEGACY_LABEL);
  if (legacyLabel)
    mutation.removedLabelIds = [legacyLabel.id];
  if (result.readyForImplementation) {
    const readyLabel = await deps.linear.ensureLabel(AGENT_LABEL.ready, issue2.team.id);
    mutation.addedLabelIds = [...mutation.addedLabelIds ?? [], readyLabel.id];
  }
  await deps.linear.updateIssue(issue2.id, mutation);
  for (const subIssue of result.subIssues) {
    const subDescription = renderIssueDescription({
      context: subIssue.description,
      acceptanceCriteria: subIssue.acceptanceCriteria,
      affectedAreas: [],
      outOfScope: []
    });
    const subTypeLabel = await deps.linear.ensureLabel(subIssue.type, issue2.team.id);
    await deps.linear.createIssue({
      teamId: issue2.team.id,
      title: subIssue.title,
      description: subDescription,
      estimate: subIssue.estimate,
      parentId: issue2.id,
      projectId: issue2.project?.id,
      labelIds: [subTypeLabel.id]
    });
  }
  if (result.spikeCreated) {
    const spikeBody = renderSpikeIssue(result.spikeCreated, { identifier: issue2.identifier });
    const spike = await deps.linear.createIssue({
      teamId: issue2.team.id,
      title: result.spikeCreated.title,
      description: spikeBody,
      projectId: issue2.project?.id
    });
    await deps.linear.createRelation({
      issueId: spike.id,
      relatedIssueId: issue2.id,
      type: "blocks"
    });
  }
  if (result.readyForImplementation)
    await moveToState(deps, issue2, "todo");
  await releaseLock(deps, issue2);
}
async function applyImplement(deps, result) {
  const issue2 = await deps.linear.issue(result.issueId);
  if (!issue2)
    throw new Error(`ImplementResult references unknown issue ${result.issueId}.`);
  for (const discovered of result.discoveredWork) {
    const discoveredTypeLabel = await deps.linear.ensureLabel(discovered.type, issue2.team.id);
    const created = await deps.linear.createIssue({
      teamId: issue2.team.id,
      title: discovered.title,
      description: discovered.description,
      projectId: issue2.project?.id,
      labelIds: [discoveredTypeLabel.id]
    });
    await deps.linear.createRelation({
      issueId: discovered.relation === "blocks" ? created.id : issue2.id,
      relatedIssueId: discovered.relation === "blocks" ? issue2.id : created.id,
      type: discovered.relation
    });
  }
  const humanSummary = [
    `**Branch:** ${result.branch}`,
    result.prUrl.length > 0 ? `**PR:** ${result.prUrl}` : "**PR:** none (direct-branch mode)",
    `**Approach:** ${result.approachSummary}`
  ].join(`
`);
  const body = encodeMarker(MARKER_KIND.implement, result, humanSummary);
  await deps.linear.createComment({ issueId: issue2.id, body });
  await moveToState(deps, issue2, "inReview");
  await releaseLock(deps, issue2);
}
async function applyPlan(deps, result) {
  const project = await deps.linear.project(result.projectId);
  if (!project)
    throw new Error(`PlanResult references unknown project ${result.projectId}.`);
  if (result.proposedIssues.length === 0)
    return;
  if (!deps.entry)
    throw new Error("applyPlan requires deps.entry to resolve the team.");
  const teams = await deps.linear.teams();
  const teamKey = await resolveTeamKey({ linear: { teams: async () => teams }, entryTeam: deps.entry.team });
  const teamRef = teams.find((candidate) => candidate.key === teamKey);
  if (!teamRef)
    throw new Error(`Team "${teamKey}" was not found while applying a plan result.`);
  for (const proposed of result.proposedIssues) {
    const description = renderIssueDescription({
      context: proposed.description,
      acceptanceCriteria: proposed.acceptanceCriteria,
      affectedAreas: [],
      outOfScope: result.outOfScope
    });
    const typeLabel2 = await deps.linear.ensureLabel(proposed.type, teamRef.id);
    await deps.linear.createIssue({
      teamId: teamRef.id,
      title: proposed.title,
      description,
      priority: proposed.proposedPriority,
      estimate: proposed.proposedEstimate ?? undefined,
      projectId: result.projectId,
      labelIds: [typeLabel2.id]
    });
  }
  await deps.linear.updateProjectStatus({ projectId: result.projectId, type: "planned" });
}
async function applyReview(deps, result) {
  const issue2 = await deps.linear.issue(result.issueId);
  if (!issue2)
    throw new Error(`ReviewResult references unknown issue ${result.issueId}.`);
  const human = renderReviewComment(result);
  const body = encodeMarker(MARKER_KIND.review, result, human);
  await deps.linear.createComment({ issueId: issue2.id, body });
  const blocking = result.findings.filter((finding) => finding.severity === "blocking");
  if (blocking.length > 0)
    await moveToState(deps, issue2, "todo");
  await releaseLock(deps, issue2);
}
async function applyDependencyBlock(deps, issue2, block) {
  for (const blockerId of block.blockedByIssues) {
    const blocker = await deps.linear.issue(blockerId);
    if (!blocker)
      continue;
    const alreadyRelated = issue2.relations.some((relation) => relation.type === "blocks" && relation.direction === "incoming" && relation.other.id === blocker.id);
    if (!alreadyRelated) {
      await deps.linear.createRelation({
        issueId: blocker.id,
        relatedIssueId: issue2.id,
        type: "blocks"
      });
    }
  }
  const body = renderBlockComment(block);
  await deps.linear.createComment({ issueId: issue2.id, body });
  await releaseLock(deps, issue2);
  await moveToState(deps, issue2, "todo");
}
var BLOCK_TYPE_LABEL = {
  "needs-input": BLOCKED_LABEL.needsInput,
  "needs-decision": BLOCKED_LABEL.needsDecision,
  external: BLOCKED_LABEL.external,
  budget: BLOCKED_LABEL.needsInput
};
async function applyHumanBlock(deps, issue2, block) {
  const labelName = BLOCK_TYPE_LABEL[block.type];
  const label = await deps.linear.ensureLabel(labelName, issue2.team.id);
  await deps.linear.updateIssue(issue2.id, { addedLabelIds: [label.id] });
  const body = encodeMarker(MARKER_KIND.block, block, renderBlockComment(block));
  await deps.linear.createComment({ issueId: issue2.id, body });
  await releaseLock(deps, issue2);
  await moveToState(deps, issue2, "todo");
}
async function applyBlock(deps, issueId, block) {
  const issue2 = await deps.linear.issue(issueId);
  if (!issue2)
    throw new Error(`Block references unknown issue ${issueId}.`);
  if (block.type === "dependency") {
    await applyDependencyBlock(deps, issue2, block);
  } else {
    await applyHumanBlock(deps, issue2, block);
  }
}
async function markApplied(deps, issueId, dispatchId) {
  const issue2 = await deps.linear.issue(issueId);
  if (!issue2)
    return;
  const body = encodeMarker(MARKER_KIND.dispatchApplied, { dispatchId }, `Applied dispatch \`${dispatchId}\`.`);
  await deps.linear.createComment({ issueId: issue2.id, body });
}
async function applyOutcome(deps, outcome) {
  if (outcome.kind === "blocked") {
    if (!outcome.issueId)
      return;
    await applyBlock(deps, outcome.issueId, outcome.block);
    return;
  }
  if (outcome.agent === "foreman-triage") {
    await applyTriage(deps, outcome.result);
  } else if (outcome.agent === "foreman-plan") {
    await applyPlan(deps, outcome.result);
  } else if (outcome.agent === "foreman-refine") {
    await applyRefine(deps, outcome.result);
  } else if (outcome.agent === "foreman-implement") {
    await applyImplement(deps, outcome.result);
  } else {
    await applyReview(deps, outcome.result);
  }
}

// src/util/guards.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStructuredOutput(value) {
  if (!isRecord(value))
    return false;
  if (!("valid" in value) || !("data" in value))
    return false;
  return typeof value.valid === "boolean";
}

// src/results/sink.ts
function extractDispatchInfo(taskText) {
  const agentMatch = /^FOREMAN-AGENT:\s*(\S+)\s*$/m.exec(taskText);
  const dispatchMatch = /^FOREMAN-DISPATCH:\s*(\S+)\s*$/m.exec(taskText);
  const issueMatch = /^FOREMAN-ISSUE:\s*(\S+)\s*$/m.exec(taskText);
  const prevStateMatch = /^FOREMAN-PREV-STATE:\s*(\S+)\s*$/m.exec(taskText);
  return {
    agent: agentMatch?.[1] ?? null,
    dispatchId: dispatchMatch?.[1] ?? null,
    issueId: issueMatch?.[1] ?? null,
    previousStateId: prevStateMatch?.[1] ?? null
  };
}
function taskTextOf(entry) {
  if (!isRecord(entry))
    return "";
  return typeof entry.task === "string" ? entry.task : "";
}
function agentOf(entry) {
  if (!isRecord(entry))
    return null;
  return typeof entry.agent === "string" ? entry.agent : null;
}
function abortedOf(entry) {
  if (!isRecord(entry))
    return false;
  return entry.aborted === true;
}
function extractFromToolResult(payload) {
  if (!isRecord(payload) || payload.toolName !== "task")
    return [];
  const input = isRecord(payload.input) ? payload.input : {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : ("task" in input) ? [input] : [];
  const result = isRecord(payload.result) ? payload.result : {};
  const details = isRecord(result.details) ? result.details : {};
  const results = Array.isArray(details.results) ? details.results : [];
  const captured = [];
  for (let index = 0;index < results.length; index += 1) {
    const single = results[index];
    if (!isRecord(single))
      continue;
    const structuredOutput = single.structuredOutput;
    if (!isStructuredOutput(structuredOutput))
      continue;
    const agent = agentOf(tasks[index]);
    const { dispatchId, issueId, previousStateId } = extractDispatchInfo(taskTextOf(tasks[index]));
    if (!agent || !dispatchId)
      continue;
    captured.push({
      dispatchId,
      agent,
      data: structuredOutput.data,
      aborted: abortedOf(single) || abortedOf(payload.result),
      issueId,
      previousStateId
    });
  }
  return captured;
}
function extractFromLifecycle(payload) {
  if (!isRecord(payload))
    return null;
  const structuredOutput = payload.structuredOutput;
  if (!isStructuredOutput(structuredOutput))
    return null;
  const agent = typeof payload.agent === "string" ? payload.agent : null;
  const taskText = typeof payload.task === "string" ? payload.task : taskTextOf(payload.input);
  const { dispatchId, issueId, previousStateId } = extractDispatchInfo(taskText);
  const explicitDispatchId = typeof payload.dispatchId === "string" ? payload.dispatchId : null;
  const finalDispatchId = explicitDispatchId ?? dispatchId;
  if (!agent || !finalDispatchId)
    return null;
  return {
    dispatchId: finalDispatchId,
    agent,
    data: structuredOutput.data,
    aborted: abortedOf(payload),
    issueId,
    previousStateId
  };
}
async function sink(captured, tracker, apply2) {
  if (await tracker.wasApplied(captured.dispatchId))
    return;
  await apply2(captured);
}

// src/extension.ts
var REAPER_INTERVAL_MS = 5 * 60 * 1000;
var appliedDispatchIds = new Set;
var inFlightCaptures = new Map;
var reviewDiffDirs = new Map;
function __resetAppliedDispatchIdsForTest() {
  appliedDispatchIds.clear();
}
function __resetInFlightCapturesForTest() {
  inFlightCaptures.clear();
}
function toApplyDeps() {
  return { linear: getLinear(), github: getGitHub(), now: () => new Date, entry: getEntry() };
}
function toGuardDeps() {
  return {
    linear: getLinear(),
    github: getGitHub(),
    config: getConfig(),
    entry: getEntry(),
    now: () => new Date,
    newDispatchId: (agent, issueId, now) => newDispatchId(agent, issueId, now),
    registerLiveDispatch,
    ensureWorktree: (input) => ensureWorktree(input),
    writeDiffFile: async (issueId, diff) => {
      const prior = reviewDiffDirs.get(issueId);
      if (prior)
        rmSync(prior, { recursive: true, force: true });
      const dir = mkdtempSync(join4(tmpdir2(), `foreman-review-${issueId}-`));
      reviewDiffDirs.set(issueId, dir);
      const path = join4(dir, "diff.patch");
      writeFileSync2(path, diff);
      return path;
    },
    liveDispatchIds,
    releaseLiveDispatch,
    contextDigest: async (projectId) => projectId ? getContextDigest(projectId) : ""
  };
}
function markerAppliedTracker() {
  return {
    wasApplied: async (dispatchId) => {
      const issueId = issueIdFromDispatchId(dispatchId);
      if (!issueId)
        return false;
      const issue2 = await getLinear().issue(issueId, { includeComments: true });
      if (!issue2)
        return false;
      let viewerId;
      try {
        viewerId = await getLinear().viewerId();
      } catch {
        viewerId = null;
      }
      if (viewerId === null)
        return false;
      return findMarkers(MARKER_KIND.dispatchApplied, issue2.comments, {
        authoredBy: viewerId
      }).some((marker) => marker.data.dispatchId === dispatchId);
    }
  };
}
function blockedOutcome(agentName, block, target) {
  return { kind: "blocked", agent: agentName, block, issueId: target ?? "" };
}
function issueIdOf(outcome) {
  if (outcome.kind === "blocked")
    return outcome.issueId;
  if (outcome.agent === "foreman-triage")
    return outcome.result.items[0]?.issueId ?? "";
  if (outcome.agent === "foreman-plan")
    return "";
  return outcome.result.issueId;
}
function isForemanAgentName(agent) {
  return agent in AGENT_OUTPUT_SCHEMAS;
}
async function applyBoundResult(deps, agent, outcome, target, dispatchId, notify) {
  if (outcome.kind === "result" && target && agent !== "foreman-plan" && agent !== "foreman-triage" && "issueId" in outcome.result && outcome.result.issueId !== target) {
    const reported = outcome.result.issueId;
    await deps.linear.createComment({
      issueId: target,
      body: `Foreman rejected this dispatch result: it reported issue ${reported}, but this dispatch locked ${target}.`
    });
    const lockedIssue = await deps.linear.issue(target);
    const running = lockedIssue?.labels.find((label) => label.name === "agent:running");
    if (running)
      await deps.linear.updateIssue(lockedIssue.id, { removedLabelIds: [running.id] });
    notify(`Foreman rejected ${agent}'s result: it reported issue ${reported}, but this dispatch locked ${target}.`, "error");
    return;
  }
  await applyOutcome(deps, outcome);
  const issueId = issueIdOf(outcome);
  if (issueId)
    await markApplied(deps, issueId, dispatchId);
}
async function handleCaptured(dispatchId, agent, data, aborted, lockedIssueId, previousStateId, notify, deps = toApplyDeps(), tracker = markerAppliedTracker()) {
  if (!isForemanAgentName(agent))
    return;
  if (appliedDispatchIds.has(dispatchId))
    return;
  const existing = inFlightCaptures.get(dispatchId);
  if (existing) {
    await existing;
    return;
  }
  const work = (async () => {
    if (appliedDispatchIds.has(dispatchId))
      return;
    const target = lockedIssueId ?? issueIdFromDispatchId(dispatchId);
    try {
      const parsed = parseAgentOutput(agent, data);
      if (parsed.kind === "invalid") {
        if (isBudgetTruncation({ aborted, problems: parsed.problems })) {
          if (target) {
            await applyOutcome(deps, blockedOutcome(agent, {
              blocked: true,
              type: "budget",
              whatIWasDoing: "Producing a validated agent result",
              whatINeed: "Increase the dispatch budget or narrow the task before retrying.",
              options: null,
              recommendation: null,
              stateLeftBehind: { worktree: null, branch: null, pushed: false, commits: [], notes: "Output was truncated before validation." },
              costOfWrongGuess: "Applying an incomplete result could corrupt the issue state.",
              blockedByIssues: [target]
            }, target));
          }
        } else {
          const issue2 = target ? await deps.linear.issue(target, { includeComments: true }) : null;
          if (issue2) {
            await deps.linear.createComment({ issueId: issue2.id, body: `Foreman could not validate this dispatch result:
${parsed.problems.map((problem) => `- ${problem}`).join(`
`)}` });
            const running = issue2.labels.find((label) => label.name === "agent:running");
            const mutation = {};
            if (running)
              mutation.removedLabelIds = [running.id];
            if (previousStateId && issue2.state.id !== previousStateId)
              mutation.stateId = previousStateId;
            if (Object.keys(mutation).length > 0)
              await deps.linear.updateIssue(issue2.id, mutation);
          }
          notify(`Foreman rejected ${agent}'s invalid result: ${parsed.problems.join("; ")}`, "error");
        }
        appliedDispatchIds.add(dispatchId);
        return;
      }
      await sink({ dispatchId, agent, data, aborted, issueId: lockedIssueId, previousStateId }, tracker, async (captured) => {
        const outcome = parsed.kind === "blocked" ? blockedOutcome(agent, parsed.block, target) : { kind: "result", agent, result: parsed.result };
        await applyBoundResult(deps, agent, outcome, target, captured.dispatchId, notify);
      });
      appliedDispatchIds.add(dispatchId);
    } catch (error) {
      appliedDispatchIds.delete(dispatchId);
      throw error;
    } finally {
      releaseLiveDispatch(dispatchId);
      const dir = target ? reviewDiffDirs.get(target) : undefined;
      if (dir && target) {
        rmSync(dir, { recursive: true, force: true });
        reviewDiffDirs.delete(target);
      }
    }
  })();
  inFlightCaptures.set(dispatchId, work);
  try {
    await work;
  } finally {
    if (inFlightCaptures.get(dispatchId) === work) {
      inFlightCaptures.delete(dispatchId);
    }
  }
}
var PLUGIN_ROOT = dirname3(dirname3(fileURLToPath(import.meta.url)));
function createForemanExtension(pi) {
  pi.setLabel("Foreman");
  registerLinearReadTool(pi);
  registerGitHubPrTool(pi);
  const commandName = (key) => COMMAND_NAMES[key];
  const runCommand = async (customType, work) => {
    try {
      if (!isRepoRegistered()) {
        await pi.sendMessage({
          customType,
          content: "This repository is not registered with Foreman. Run `foreman init` here first.",
          display: true,
          attribution: "assistant"
        }, { triggerTurn: false });
        return;
      }
      const content = await work(getLinear());
      await pi.sendMessage({ customType, content, display: true, attribution: "assistant" }, { triggerTurn: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const content = message.startsWith("No Linear API key resolved") ? "No Linear API key resolved for this repo. Foreman's Linear tools and commands will fail until one is configured." : `Foreman command failed: ${message}`;
      await pi.sendMessage({ customType, content, display: true, attribution: "assistant" }, { triggerTurn: false });
    }
  };
  pi.registerCommand(commandName("status"), {
    description: "Foreman operator console: blocked queue, locks, proposals, agents, loop state.",
    handler: async () => runCommand("foreman.status", async (linear2) => renderStatus(linear2))
  });
  pi.registerCommand(commandName("apply"), {
    description: "Apply approved triage proposals, or approve/reject one by issue id.",
    handler: async (args) => runCommand("foreman.apply", async (linear2) => {
      const argv = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
      const result = await runApplyCommand(linear2, argv, getEntry());
      const lines = [result.message];
      if (result.plan) {
        for (const entry of result.plan)
          lines.push(`- ${entry.issueId}: ${entry.item.type} → ${entry.item.destination}`);
      }
      return lines.join(`
`);
    })
  });
  pi.registerCommand(commandName("merge"), {
    description: "Merge one issue's PR (or branch) once the review gate passes. Operator-invoked only.",
    handler: async (args) => runCommand("foreman.merge", async (linear2) => {
      const issueId = args.trim();
      return (await runMerge(linear2, getGitHub(), issueId)).message;
    })
  });
  pi.registerCommand(commandName("unblock"), {
    description: "Record the operator's reply to a blocked issue and clear its blocked:* label.",
    handler: async (args) => runCommand("foreman.unblock", async (linear2) => {
      const [issueId, ...replyParts] = args.trim().split(/\s+/);
      const reply = replyParts.join(" ");
      if (!issueId)
        return "Usage: /foreman:unblock <ISSUE-ID> <reply>";
      return (await runUnblock(linear2, issueId, reply, getEntry())).message;
    })
  });
  let reaperTimer = null;
  pi.on("session_start", async (_event, ctx) => {
    resetRuntime();
    const init = initRuntime();
    if (init.missingApiKey) {
      ctx.ui.notify("No Linear API key resolved for this repo. Foreman's Linear tools and commands will fail until one is configured.", "warn");
    }
    for (const warning of init.warnings)
      ctx.ui.notify(warning, "warn");
    try {
      getConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        ctx.ui.notify(`Invalid Foreman config: ${error.message}`, "error");
      }
      return;
    }
    if (existsSync8(join4(PLUGIN_ROOT, "agents"))) {
      const problems = checkSkillAutoload({ pluginRoot: PLUGIN_ROOT, cwd: ctx.cwd });
      for (const problem of problems)
        ctx.ui.notify(formatSkillGuardProblem(problem), "error");
    }
    if (!init.missingApiKey && isRepoRegistered()) {
      try {
        const entry = getEntry();
        const linear2 = getLinear();
        const teams = await linear2.teams();
        const teamKey = await resolveTeamKey({ linear: { teams: async () => teams }, entryTeam: entry.team });
        const teamRef = teams.find((candidate) => candidate.key === teamKey);
        if (!teamRef) {
          throw new ConfigError(`Team "${teamKey}" was not found for the ensure pass`, [
            "the resolved team key no longer matches a team the credential can reach"
          ]);
        }
        const reports = await ensureMaintenanceProjects(linear2, {
          initiativeIds: entry.initiativeIds,
          teamId: teamRef.id,
          confirmer: YOLO_CONFIRMER
        });
        for (const report of reports) {
          if (report.created) {
            ctx.ui.notify(`Foreman: created the Maintenance project for initiative "${report.initiativeName}".`, "info");
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Foreman ensure pass failed: ${message}`, "error");
      }
    }
    if (!init.missingApiKey) {
      try {
        await sweep(getLinear(), new Date, liveDispatchIds());
      } catch (error) {
        console.error(`[foreman] reaper sweep failed: ${String(error)}`);
      }
    }
    reaperTimer = ctx.setInterval(async () => {
      try {
        await sweep(getLinear(), new Date, liveDispatchIds());
      } catch (error) {
        console.error(`[foreman] reaper sweep failed: ${String(error)}`);
      }
    }, REAPER_INTERVAL_MS);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (reaperTimer !== null) {
      ctx.clearTimer(reaperTimer);
      reaperTimer = null;
    }
  });
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "task")
      return;
    if (!isRepoRegistered())
      return;
    const guardDeps = toGuardDeps();
    const decision = await prepareTaskCall(event.input, guardDeps);
    if (decision.block)
      return { block: true, reason: decision.reason };
    return { input: decision.input };
  });
  const reportFailure = (ctx) => (error) => {
    const message = `Foreman could not apply an agent result: ${String(error)}`;
    pi.logger.error(message);
    ctx.ui.notify(message, "error");
  };
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "task")
      return;
    for (const item of extractFromToolResult(event)) {
      try {
        await handleCaptured(item.dispatchId, item.agent, item.data, item.aborted, item.issueId, item.previousStateId, ctx.ui.notify);
      } catch (error) {
        reportFailure(ctx)(error);
      }
    }
  });
  const lifecycleHandler = async (payload, ctx) => {
    const captured = extractFromLifecycle(payload);
    if (!captured)
      return;
    try {
      await handleCaptured(captured.dispatchId, captured.agent, captured.data, captured.aborted, captured.issueId, captured.previousStateId, ctx.ui.notify);
    } catch (error) {
      reportFailure(ctx)(error);
    }
  };
  pi.on("task:subagent:lifecycle", lifecycleHandler);
  pi.on("task:subagent:progress", lifecycleHandler);
  pi.on("task:subagent:event", lifecycleHandler);
  return {};
}
export {
  handleCaptured,
  createForemanExtension as default,
  blockedOutcome,
  applyBoundResult,
  __resetInFlightCapturesForTest,
  __resetAppliedDispatchIdsForTest
};
