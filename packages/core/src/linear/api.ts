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
  LinearId,
  Project,
  ProjectRef,
  TeamRef,
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
  init: { method: string; headers: Record<string, string>; body: string },
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
   * Every initiative a project belongs to, unfiltered. A gate counts these to
   * report `ambiguous-initiative` instead of throwing (SPEC §10).
   */
  projectInitiatives(projectId: string): Promise<InitiativeRef[]>;
  /** The single initiative a project belongs to. Throws when zero or more than one is found. */
  projectInitiative(projectId: string): Promise<InitiativeRef>;
  /** An initiative and its attached documents, by id. Null when absent. */
  initiative(initiativeId: string): Promise<Initiative | null>;
  /** Every initiative in the workspace — the setup wizard's picker. */
  initiatives(): Promise<InitiativeRef[]>;
  workflowStates(teamId: string): Promise<WorkflowState[]>;
  labels(teamId?: string): Promise<IssueLabel[]>;
  teams(): Promise<TeamRef[]>;
  projects(): Promise<ProjectRef[]>;
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
  deleteRelation(relationId: LinearId): Promise<void>;
  createLabel(input: {
    name: string;
    teamId?: LinearId;
    isGroup?: boolean;
    parentId?: LinearId;
    color?: string;
    description?: string;
  }): Promise<IssueLabel>;
  /** Resolve a label name to its id, creating it when absent. */
  ensureLabel(name: string, teamId: LinearId): Promise<IssueLabel>;
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
