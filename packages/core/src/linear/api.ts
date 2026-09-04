/**
 * The Linear surface, split by authority.
 *
 * `LinearReader` is everything the agent-facing `foreman_linear_read` tool can
 * reach. `LinearWriter` exists only inside the extension and the loop and is
 * never exposed as an agent tool — principle 9 is structural, not policy: there
 * is no allowlist mistake that can hand an agent write access, because no write
 * tool exists to grant.
 */

import type {
  Comment,
  Initiative,
  InitiativeRef,
  Issue,
  IssueLabel,
  IssueRelationType,
  LinearDocument,
  LinearId,
  Project,
  ProjectRef,
  ProjectRelation,
  ProjectRelationAnchor,
  ProjectRelationType,
  ProjectStatus,
  ProjectStatusType,
  TeamRef,
  TeamSettings,
  UserRef,
  WorkflowState,
} from "./types.ts";

/**
 * The slice of `fetch` the client actually calls.
 *
 * Narrower than `typeof globalThis.fetch` on purpose: that type carries
 * `preconnect` under Bun's lib, so a plain stub function in a test would fail to
 * satisfy it and the seam would only be usable from production code.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<Response>;

/** A Linear `IssueFilter`, passed through to GraphQL untouched. */
export type IssueFilter = Record<string, unknown>;

export interface IssueQuery {
  filter?: IssueFilter;
  /** Page size. Linear caps this; the client pages until `limit` is reached. */
  first?: number;
  /** Hard ceiling on total issues returned. */
  limit?: number;
  /** Comments cost an extra selection set; ask only when a marker must be read. */
  includeComments?: boolean;
}

export interface LinearReader {
  /** One issue by human identifier (`ENG-142`) or UUID. Null when absent. */
  issue(id: string, options?: { includeComments?: boolean }): Promise<Issue | null>;
  issues(query: IssueQuery): Promise<Issue[]>;
  comments(issueId: string): Promise<Comment[]>;
  /** The project and its attached documents, including `Context`. */
  project(projectId: string): Promise<Project | null>;
  /**
   * The team's documents — the product `Context` doc among them (SPEC §4.7).
   * The product layer of the context digest resolves through the team, never
   * an initiative: a repo binds exactly one team, and Foreman neither
   * creates initiatives nor requires a project to have one.
   */
  teamDocuments(teamKey: string): Promise<LinearDocument[]>;
  /**
   * Every initiative a project belongs to — usually none. Read for exactly
   * one purpose: folding an optional extra context layer into the digest
   * when a project happens to sit under an initiative the operator maintains
   * by hand (SPEC §4.7). No scope check, gate, or routing decision may
   * consult this; an empty array is the ordinary case, never an error.
   */
  projectInitiatives(projectId: string): Promise<InitiativeRef[]>;
  /** An initiative and its attached documents, by id. Null when absent — which callers treat as "no extra context", not a failure. */
  initiative(initiativeId: string): Promise<Initiative | null>;
  /**
   * A project's dependency edges (SPEC §4.10a), both directions, merged and
   * reoriented so `anchor`/`otherAnchor` read from the queried project.
   * Empty when the project is absent or carries none.
   */
  projectRelations(projectId: string): Promise<ProjectRelation[]>;
  /** A project's current native status (`backlog`/`planned`/.../`canceled`). Null when the project itself is absent. */
  projectStatus(projectId: string): Promise<ProjectStatus | null>;
  workflowStates(teamId: string): Promise<WorkflowState[]>;
  labels(teamId?: string): Promise<IssueLabel[]>;
  teams(): Promise<TeamRef[]>;
  /** A team's projects (SPEC §4 team-per-repo scope). */
  projects(teamKey: string): Promise<ProjectRef[]>;
  /** Team settings that provisioning reads and asserts. */
  teamSettings(teamId: string): Promise<TeamSettings>;
  /** Workspace project labels, canonical colon-form ids. */
  projectLabels(): Promise<IssueLabel[]>;
  /** The Linear user id the API key belongs to. Used to bind marker trust to the credential's own authorship. */
  viewerId(): Promise<string>;
  /** Resolves an operator's account by email — the setup wizard's `linear.operatorUserId` lookup. Null when no user has that email. */
  userByEmail(email: string): Promise<UserRef | null>;
}

export interface IssueMutation {
  stateId?: LinearId;
  priority?: number;
  estimate?: number | null;
  description?: string;
  title?: string;
  parentId?: LinearId | null;
  projectId?: LinearId | null;
  /** Incremental, so two workers touching different label groups cannot clobber. */
  addedLabelIds?: LinearId[];
  removedLabelIds?: LinearId[];
  /** Reassigns the issue; `null` clears the assignee. Foreman uses this to make ownership visible in Linear's UI (SPEC §11, §9 Case B). */
  assigneeId?: LinearId | null;
}

export interface CreateIssueInput {
  teamId: LinearId;
  title: string;
  description?: string;
  stateId?: LinearId;
  priority?: number;
  estimate?: number;
  parentId?: LinearId;
  projectId?: LinearId;
  labelIds?: LinearId[];
}

export interface LinearWriter extends LinearReader {
  updateIssue(id: string, input: IssueMutation): Promise<Issue>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  /**
   * `teamIds` is required, not optional: Linear's `ProjectCreateInput` declares
   * exactly two non-null fields, `name` and `teamIds` (measured). `labelIds`
   * carries the project's `app:` label, resolved by the caller.
   */
  createProject(input: {
    name: string;
    teamIds: LinearId[];
    description?: string;
    content?: string;
    /** `TimelessDate` (`YYYY-MM-DD`). Linear rejects a timestamp here. */
    startDate?: string;
    targetDate?: string;
    labelIds?: LinearId[];
  }): Promise<ProjectRef>;
  /**
   * Advances a project's native status by semantic `type`, not a raw id —
   * callers never see `statusId`s, which are workspace-specific and would
   * otherwise leak into every gate and worker that wants to set one. The
   * implementation resolves `type` to the workspace's matching status.
   */
  updateProjectStatus(input: { projectId: LinearId; type: ProjectStatusType }): Promise<void>;
  createComment(input: {
    issueId: string;
    body: string;
    parentId?: LinearId;
  }): Promise<Comment>;
  createRelation(input: {
    issueId: string;
    relatedIssueId: string;
    type: IssueRelationType;
  }): Promise<void>;
  /**
   * Creates a project dependency edge. `anchorType`/`relatedAnchorType` are
   * required by `ProjectRelationCreateInput` (measured) and carry the
   * direction's meaning: `end` -> `start` is "`projectId` must finish before
   * `relatedProjectId` starts".
   */
  createProjectRelation(input: {
    projectId: LinearId;
    relatedProjectId: LinearId;
    type: ProjectRelationType;
    anchorType: ProjectRelationAnchor;
    relatedAnchorType: ProjectRelationAnchor;
  }): Promise<void>;
  createLabel(input: {
    name: string;
    teamId?: LinearId;
    isGroup?: boolean;
    parentId?: LinearId;
    color?: string;
    description?: string;
  }): Promise<IssueLabel>;
  /** Resolve a team-scoped label name to its id, creating it (with `opts`, when given) when absent. */
  ensureLabel(name: string, teamId: LinearId, opts?: { color?: string; description?: string }): Promise<IssueLabel>;
  /** Workspace-level issue label (`teamId` omitted), creating its parent group on demand. */
  ensureWorkspaceLabel(name: string, opts?: { color?: string; description?: string }): Promise<IssueLabel>;
  /** Workspace-level project label; creates the parent group on demand, like `ensureLabel`. */
  ensureProjectLabel(name: string, opts?: { color?: string; description?: string }): Promise<IssueLabel>;
  createWorkflowState(input: {
    teamId: LinearId;
    name: string;
    type: string;
    color: string;
    description?: string;
    position?: number;
  }): Promise<WorkflowState>;
  /** `type` is immutable after creation and cannot be updated (SPEC: `WorkflowStateUpdateInput` has no `type`). */
  updateWorkflowState(
    id: LinearId,
    input: { name?: string; color?: string; description?: string; position?: number },
  ): Promise<WorkflowState>;
  /** Only succeeds when every issue in the state has already been archived. */
  archiveWorkflowState(id: LinearId): Promise<void>;
  updateTeamSettings(teamId: LinearId, input: { triageEnabled?: boolean; cyclesEnabled?: boolean }): Promise<void>;
  /** Creates a team-scoped document (SPEC §4.7). Used only by `provisionTeam` to seed the product `Context` doc. */
  createDocument(input: { teamId: LinearId; title: string; content: string }): Promise<LinearDocument>;
  /**
   * Updates the product `Context` doc — the only document Foreman ever
   * updates (SPEC §4.7). Callers pass the full new body; the caller is
   * responsible for carrying the live Definition-of-Done section through
   * unchanged, since this method rewrites `content` wholesale and has no
   * notion of the doc's section structure.
   */
  updateDocument(input: { documentId: LinearId; content: string }): Promise<void>;
}

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly errors: unknown,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

/**
 * One operator-readable line for a Linear failure. `LinearApiError.message`
 * carries the entire response body, which for a 401 is a GraphQL envelope no
 * operator should have to read — Linear's own `userPresentableMessage` is
 * buried inside it. Every render of a Linear failure to a human MUST go
 * through this.
 */
export function describeLinearError(error: unknown): string {
  if (!(error instanceof LinearApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const { status } = error;
  if (status === 401 || status === 403) {
    return `Linear rejected the API key (HTTP ${status}). Run \`foreman setup\` and paste a current key.`;
  }
  if (status === 429) {
    return "Linear rate-limited the request (HTTP 429). Try again shortly.";
  }
  if (status !== null && status >= 500) {
    return `Linear is unavailable (HTTP ${status}). Try again shortly.`;
  }
  try {
    const body: unknown = typeof error.errors === "string" ? JSON.parse(error.errors) : error.errors;
    const presentable = firstPresentableMessage(body);
    if (presentable !== null) return presentable;
  } catch {
    // fall through to the raw message below
  }
  return error.message;
}

/** Digs `errors[0].extensions.userPresentableMessage` out of a parsed GraphQL error envelope, or `null` when the shape doesn't hold it. */
function firstPresentableMessage(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("errors" in body)) return null;
  const { errors } = body;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const [first] = errors;
  if (first === null || typeof first !== "object" || !("extensions" in first)) return null;
  const { extensions } = first;
  if (extensions === null || typeof extensions !== "object" || !("userPresentableMessage" in extensions)) return null;
  const { userPresentableMessage } = extensions;
  return typeof userPresentableMessage === "string" && userPresentableMessage.length > 0
    ? userPresentableMessage
    : null;
}

/** True when Linear refused the credential itself — a state no retry and no `--fix` can clear. */
export function isLinearAuthFailure(error: unknown): boolean {
  return error instanceof LinearApiError && (error.status === 401 || error.status === 403);
}

/** Raised when a paginated query still has a next page after the safety cap — partial data is never returned. */
export class LinearPaginationError extends LinearApiError {
  constructor(
    readonly operation: string,
    readonly pages: number,
    readonly partialCount: number,
  ) {
    super(
      `${operation}: pagination incomplete after ${pages} pages (${partialCount} items); refusing partial results`,
      null,
      null,
    );
    this.name = "LinearPaginationError";
  }
}
