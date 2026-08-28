/**
 * Hand-rolled GraphQL client for Linear. No `@linear/sdk` dependency: this is
 * the only package in the monorepo that talks to Linear, so a thin client
 * with the exact fields Foreman reads is cheaper to keep correct than a
 * generated SDK the type-checker can't hold accountable to `types.ts`.
 */

import type {
  Comment,
  Initiative,
  InitiativeRef,
  Issue,
  IssueLabel,
  IssueRef,
  IssueRelation,
  IssueRelationType,
  LinearId,
  Project,
  ProjectRef,
  TeamRef,
  WorkflowState,
} from "./types.ts";
import type {
  CreateIssueInput,
  FetchLike,
  IssueFilter,
  IssueMutation,
  IssueQuery,
  LinearReader,
  LinearWriter,
} from "./api.ts";
import { LinearApiError } from "./api.ts";
import {
  COMMENT_CREATE_MUTATION,
  COMMENTS_QUERY,
  INITIATIVE_QUERY_OBJECT_CONTENT,
  INITIATIVE_QUERY_SCALAR_CONTENT,
  INITIATIVES_QUERY,
  ISSUE_BY_ID_QUERY,
  ISSUE_CREATE_MUTATION,
  ISSUE_LABEL_CREATE_MUTATION,
  ISSUE_RELATION_CREATE_MUTATION,
  ISSUE_RELATION_DELETE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  ISSUES_QUERY,
  PROJECT_INITIATIVES_QUERY,
  PROJECT_QUERY_OBJECT_CONTENT,
  PROJECT_QUERY_SCALAR_CONTENT,
  PROJECTS_QUERY,
  TEAMS_QUERY,
  WORKFLOW_STATES_QUERY,
  WORKSPACE_LABELS_QUERY,
} from "./queries.ts";
import { MANAGED_LABEL_GROUPS } from "../domain/labels.ts";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

/** GraphQL nodes as they come off the wire, before mapping into `types.ts` shapes. */
interface WireStateRef {
  id: string;
  name: string;
  type: string;
}
interface WireIssueRef {
  id: string;
  identifier: string;
  title: string;
  state: WireStateRef;
}
interface WireLabel {
  id: string;
  name: string;
  parent: { id: string } | null;
}
interface WireRelation {
  id: string;
  type: string;
  issue: WireIssueRef;
  relatedIssue: WireIssueRef;
}
interface WireUser {
  id: string;
  name: string;
  displayName: string | null;
}
interface WireComment {
  id: string;
  body: string;
  createdAt: string;
  user: WireUser | null;
  parent: { id: string } | null;
}
interface WireIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  url: string;
  branchName: string;
  createdAt: string;
  updatedAt: string;
  state: WireStateRef;
  labels: { nodes: WireLabel[] };
  project: { id: string; name: string } | null;
  team: { id: string; key: string; name: string };
  assignee: WireUser | null;
  parent: WireIssueRef | null;
  children: { nodes: WireIssueRef[] };
  relations: { nodes: WireRelation[] };
  comments?: { nodes: WireComment[] };
}

interface GraphQlErrorEntry {
  message: string;
}

interface GraphQlResponse<T> {
  data: T | null;
  errors?: GraphQlErrorEntry[];
}

/** Options accepted by the constructor; `fetch` is the test seam. */
export interface LinearClientOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: FetchLike;
  /*
   * Teams Foreman manages (`linear.teamKeys`). Empty or absent means every
   * team. Applied here rather than at each `issues()` call site: there are
   * eighteen of them across the loop, the extension, and the board, and a
   * config key that silently fails to scope one of them would hand another
   * team's Triage queue to the triage batch.
   */
  teamKeys?: readonly string[];
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class LinearClient implements LinearWriter {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly teamScope: IssueFilter | null;
  private readonly labelIdCache = new Map<string, LinearId>();
  private readonly labelGroupIdCache = new Map<string, LinearId>();
  private readonly projectInitiativeCache = new Map<string, InitiativeRef>();
  /** Once the working project-document content shape is discovered, reuse it. */
  private projectContentShape: "scalar" | "object" | null = null;
  /** Once the working initiative-document content shape is discovered, reuse it. */
  private initiativeContentShape: "scalar" | "object" | null = null;

  constructor(options: LinearClientOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.teamScope =
      options.teamKeys && options.teamKeys.length > 0
        ? { team: { key: { in: [...options.teamKeys] } } }
        : null;
  }

  private async request<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    return this.requestWithRetry<T>(document, variables, 0);
  }

  private async requestWithRetry<T>(
    document: string,
    variables: Record<string, unknown>,
    attempt: number,
  ): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query: document, variables }),
    });

    if (!response.ok) {
      if (attempt === 0 && RETRYABLE_STATUS.has(response.status)) {
        await this.backoff(response);
        return this.requestWithRetry<T>(document, variables, attempt + 1);
      }
      const body = await response.text();
      throw new LinearApiError(
        `Linear API request failed with status ${response.status}: ${body}`,
        response.status,
        body,
      );
    }

    const payload = (await response.json()) as GraphQlResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      // A 200 with a GraphQL errors array is still a rate-limit/transient
      // failure in Linear's implementation for some resolvers; only the HTTP
      // status is documented as retryable, so errors here are terminal.
      throw new LinearApiError(
        payload.errors.map((entry) => entry.message).join("; "),
        response.status,
        payload.errors,
      );
    }
    if (payload.data === null || payload.data === undefined) {
      throw new LinearApiError("Linear API returned no data", response.status, payload.errors);
    }
    return payload.data;
  }

  private async backoff(response: Response): Promise<void> {
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter ? Number(retryAfter) : 1;
    const delayMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, delayMs);
    await promise;
  }

  private mapStateRef(state: WireStateRef): { id: LinearId; name: string; type: WorkflowState["type"] } {
    return { id: state.id, name: state.name, type: state.type as WorkflowState["type"] };
  }

  private mapIssueRef(ref: WireIssueRef): IssueRef {
    return {
      id: ref.id,
      identifier: ref.identifier,
      title: ref.title,
      state: this.mapStateRef(ref.state),
    };
  }

  /**
   * Normalize a relation row into the contract's `direction`/`other` shape.
   * `issue.relations` is the single connection Linear exposes a relation row
   * through from either endpoint (per `types.ts`'s `IssueRelation` doc), so
   * this issue's own id decides which side is "this" and which is `other` —
   * no second `inverseRelations` selection is needed.
   */
  private mapRelation(relation: WireRelation, queriedIssueId: string): IssueRelation {
    const outgoing = relation.issue.id === queriedIssueId;
    const other = outgoing ? relation.relatedIssue : relation.issue;
    return {
      id: relation.id,
      type: relation.type as IssueRelationType,
      direction: outgoing ? "outgoing" : "incoming",
      other: this.mapIssueRef(other),
    };
  }

  private mapComment(comment: WireComment): Comment {
    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      user: comment.user
        ? { id: comment.user.id, name: comment.user.name, displayName: comment.user.displayName }
        : null,
      parentId: comment.parent?.id ?? null,
    };
  }

  private mapIssue(wire: WireIssue): Issue {
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
        position: 0,
      },
      labels: wire.labels.nodes.map((label) => ({
        id: label.id,
        name: label.name,
        parentId: label.parent?.id ?? null,
      })),
      team: { id: wire.team.id, key: wire.team.key, name: wire.team.name },
      project: wire.project ? { id: wire.project.id, name: wire.project.name } : null,
      parent: wire.parent ? this.mapIssueRef(wire.parent) : null,
      children: wire.children.nodes.map((child) => this.mapIssueRef(child)),
      assignee: wire.assignee
        ? { id: wire.assignee.id, name: wire.assignee.name, displayName: wire.assignee.displayName }
        : null,
      relations: wire.relations.nodes.map((relation) => this.mapRelation(relation, wire.id)),
      comments: wire.comments ? wire.comments.nodes.map((comment) => this.mapComment(comment)) : [],
    };
  }

  async issue(id: string, options?: { includeComments?: boolean }): Promise<Issue | null> {
    const includeComments = options?.includeComments ?? false;
    const data = await this.request<{ issue: WireIssue | null }>(
      ISSUE_BY_ID_QUERY(includeComments),
      { id },
    );
    return data.issue ? this.mapIssue(data.issue) : null;
  }

  /**
   * ANDs the managed-team scope onto a caller's filter. A caller that passes no
   * filter still gets scoped; an unscoped client returns the filter untouched,
   * so `teamKeys: []` keeps the documented "every team" meaning.
   */
  private scoped(filter: IssueFilter | undefined): IssueFilter | undefined {
    if (!this.teamScope) return filter;
    return filter ? { and: [filter, this.teamScope] } : this.teamScope;
  }

  async issues(query: IssueQuery): Promise<Issue[]> {
    const includeComments = query.includeComments ?? false;
    const pageSize = query.first ?? 50;
    const filter = this.scoped(query.filter);
    const results: Issue[] = [];
    let after: string | undefined;
    for (;;) {
      const data = await this.request<{
        issues: { nodes: WireIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      }>(ISSUES_QUERY(includeComments), {
        filter,
        after,
        first: pageSize,
      });
      for (const node of data.issues.nodes) {
        results.push(this.mapIssue(node));
        if (query.limit !== undefined && results.length >= query.limit) {
          return results;
        }
      }
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
      after = data.issues.pageInfo.endCursor;
    }
    return results;
  }

  async comments(issueId: string): Promise<Comment[]> {
    const data = await this.request<{ issue: { comments: { nodes: WireComment[] } } | null }>(
      COMMENTS_QUERY,
      { issueId },
    );
    return data.issue ? data.issue.comments.nodes.map((comment) => this.mapComment(comment)) : [];
  }

  async project(projectId: string): Promise<Project | null> {
    const shape = this.projectContentShape ?? "scalar";
    try {
      return await this.fetchProject(projectId, shape);
    } catch (error) {
      if (shape === "object" || !(error instanceof LinearApiError)) throw error;
      // Scalar `content` selection errored — Linear wants the object
      // sub-selection instead (documents/content shape is unverified per the
      // scout report). Retry once with the alternate shape and cache it.
      const result = await this.fetchProject(projectId, "object");
      this.projectContentShape = "object";
      return result;
    }
  }

  private async fetchProject(
    projectId: string,
    shape: "scalar" | "object",
  ): Promise<Project | null> {
    const document = shape === "scalar" ? PROJECT_QUERY_SCALAR_CONTENT : PROJECT_QUERY_OBJECT_CONTENT;
    const data = await this.request<{
      project: {
        id: string;
        name: string;
        description: string | null;
        content: string | null;
        documents: {
          nodes: Array<{
            id: string;
            title: string;
            content: string | { body: string } | null;
            updatedAt: string;
          }>;
        };
      } | null;
    }>(document, { projectId });
    if (!data.project) return null;
    this.projectContentShape = shape;
    return {
      id: data.project.id,
      name: data.project.name,
      description: data.project.description,
      content: data.project.content,
      documents: data.project.documents.nodes.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content:
          doc.content === null
            ? null
            : typeof doc.content === "string"
              ? doc.content
              : doc.content.body,
        updatedAt: doc.updatedAt,
      })),
    };
  }

  /**
   * The wire row behind both public initiative lookups. Keeping the project's
   * name here is what lets the exactly-one error name the project the operator
   * has to go fix, rather than echoing a UUID back at them.
   */
  private async fetchProjectInitiatives(
    projectId: string,
  ): Promise<{ name: string; initiatives: InitiativeRef[] }> {
    const data = await this.request<{
      project: { id: string; name: string; initiatives: { nodes: InitiativeRef[] } } | null;
    }>(PROJECT_INITIATIVES_QUERY, { projectId });
    return {
      name: data.project?.name ?? projectId,
      initiatives: data.project?.initiatives.nodes ?? [],
    };
  }

  /**
   * Every initiative a project belongs to. Linear permits several (SPEC §4.0);
   * this reports the raw truth so a gate can count without a rejection, while
   * `projectInitiative` enforces the exactly-one rule for repo resolution.
   */
  async projectInitiatives(projectId: string): Promise<InitiativeRef[]> {
    return (await this.fetchProjectInitiatives(projectId)).initiatives;
  }

  async projectInitiative(projectId: string): Promise<InitiativeRef> {
    const cached = this.projectInitiativeCache.get(projectId);
    if (cached) return cached;
    const { name, initiatives } = await this.fetchProjectInitiatives(projectId);
    const first = initiatives[0];
    if (first === undefined) {
      throw new LinearApiError(
        `Project "${name}" has no initiative; a project must belong to exactly one initiative.`,
        null,
        null,
      );
    }
    if (initiatives.length > 1) {
      const names = initiatives.map((node) => node.name).join(", ");
      throw new LinearApiError(
        `Project "${name}" belongs to more than one initiative (${names}); a project must belong to exactly one initiative.`,
        null,
        null,
      );
    }
    const ref: InitiativeRef = { id: first.id, name: first.name };
    this.projectInitiativeCache.set(projectId, ref);
    return ref;
  }

  /** Every initiative in the workspace — the setup wizard's picker (SPEC §3.10). */
  async initiatives(): Promise<InitiativeRef[]> {
    const data = await this.request<{ initiatives: { nodes: InitiativeRef[] } }>(INITIATIVES_QUERY, {});
    return data.initiatives.nodes;
  }

  async initiative(initiativeId: string): Promise<Initiative | null> {
    const shape = this.initiativeContentShape ?? "scalar";
    try {
      return await this.fetchInitiative(initiativeId, shape);
    } catch (error) {
      if (shape === "object" || !(error instanceof LinearApiError)) throw error;
      // Scalar `content` selection errored — Linear wants the object
      // sub-selection instead, mirroring the project-document fallback.
      const result = await this.fetchInitiative(initiativeId, "object");
      this.initiativeContentShape = "object";
      return result;
    }
  }

  private async fetchInitiative(
    initiativeId: string,
    shape: "scalar" | "object",
  ): Promise<Initiative | null> {
    const document = shape === "scalar" ? INITIATIVE_QUERY_SCALAR_CONTENT : INITIATIVE_QUERY_OBJECT_CONTENT;
    const data = await this.request<{
      initiative: {
        id: string;
        name: string;
        documents: {
          nodes: Array<{
            id: string;
            title: string;
            content: string | { body: string } | null;
            updatedAt: string;
          }>;
        };
      } | null;
    }>(document, { initiativeId });
    if (!data.initiative) return null;
    this.initiativeContentShape = shape;
    return {
      id: data.initiative.id,
      name: data.initiative.name,
      documents: data.initiative.documents.nodes.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content:
          doc.content === null
            ? null
            : typeof doc.content === "string"
              ? doc.content
              : doc.content.body,
        updatedAt: doc.updatedAt,
      })),
    };
  }

  async workflowStates(teamId: string): Promise<WorkflowState[]> {
    const data = await this.request<{
      team: { workflowStates: { nodes: Array<WireStateRef & { position: number }> } };
    }>(WORKFLOW_STATES_QUERY, { teamId });
    return data.team.workflowStates.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type as WorkflowState["type"],
      position: state.position,
    }));
  }

  /**
   * Linear's `issueLabels` query has no verified team-filter argument, so
   * team scoping happens client-side; team-scoped labels are a subset of
   * the workspace result. `teamId` is accepted for API symmetry with
   * `LinearReader` and reserved for a server-side filter once verified.
   */
  async labels(_teamId?: string): Promise<IssueLabel[]> {
    const data = await this.request<{ issueLabels: { nodes: WireLabel[] } }>(
      WORKSPACE_LABELS_QUERY,
      {},
    );
    return data.issueLabels.nodes.map((label) => ({
      id: label.id,
      name: label.name,
      parentId: label.parent?.id ?? null,
    }));
  }

  async teams(): Promise<TeamRef[]> {
    const data = await this.request<{ teams: { nodes: TeamRef[] } }>(TEAMS_QUERY, {});
    return data.teams.nodes;
  }

  async projects(): Promise<ProjectRef[]> {
    const data = await this.request<{ projects: { nodes: ProjectRef[] } }>(PROJECTS_QUERY, {});
    return data.projects.nodes;
  }

  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    const data = await this.request<{ issueUpdate: { issue: WireIssue } }>(
      ISSUE_UPDATE_MUTATION(false),
      { id, input },
    );
    return this.mapIssue(data.issueUpdate.issue);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const data = await this.request<{ issueCreate: { issue: WireIssue } }>(
      ISSUE_CREATE_MUTATION(false),
      { input },
    );
    return this.mapIssue(data.issueCreate.issue);
  }

  async createComment(input: { issueId: string; body: string; parentId?: LinearId }): Promise<Comment> {
    const data = await this.request<{ commentCreate: { comment: WireComment } }>(
      COMMENT_CREATE_MUTATION,
      { input },
    );
    return this.mapComment(data.commentCreate.comment);
  }

  async createRelation(input: {
    issueId: string;
    relatedIssueId: string;
    type: IssueRelationType;
  }): Promise<void> {
    await this.request<{ issueRelationCreate: { success: boolean } }>(
      ISSUE_RELATION_CREATE_MUTATION,
      { input },
    );
  }

  async deleteRelation(relationId: LinearId): Promise<void> {
    await this.request<{ issueRelationDelete: { success: boolean } }>(
      ISSUE_RELATION_DELETE_MUTATION,
      { id: relationId },
    );
  }

  async createLabel(input: {
    name: string;
    teamId?: LinearId;
    isGroup?: boolean;
    parentId?: LinearId;
    color?: string;
    description?: string;
  }): Promise<IssueLabel> {
    const data = await this.request<{ issueLabelCreate: { issueLabel: WireLabel } }>(
      ISSUE_LABEL_CREATE_MUTATION,
      { input },
    );
    const label = data.issueLabelCreate.issueLabel;
    return { id: label.id, name: label.name, parentId: label.parent?.id ?? null };
  }

  async ensureLabel(name: string, teamId: LinearId): Promise<IssueLabel> {
    const cacheKey = `${teamId}:${name}`;
    const cached = this.labelIdCache.get(cacheKey);
    if (cached) return { id: cached, name, parentId: null };

    const existing = (await this.labels(teamId)).find((label) => label.name === name);
    if (existing) {
      this.labelIdCache.set(cacheKey, existing.id);
      return existing;
    }

    const group = MANAGED_LABEL_GROUPS.find((candidate) => name.startsWith(candidate.prefix));
    const parentId = group ? await this.ensureLabelGroup(group.prefix, teamId) : undefined;

    const created = await this.createLabel({ name, teamId, parentId });
    this.labelIdCache.set(cacheKey, created.id);
    return created;
  }

  /** Resolve (creating if absent) the `isGroup: true` parent for a managed label prefix. */
  private async ensureLabelGroup(prefix: string, teamId: LinearId): Promise<LinearId> {
    const cacheKey = `${teamId}:${prefix}`;
    const cached = this.labelGroupIdCache.get(cacheKey);
    if (cached) return cached;

    const groupName = prefix.endsWith(":") ? prefix.slice(0, -1) : prefix;
    const existing = (await this.labels(teamId)).find((label) => label.name === groupName);
    if (existing) {
      this.labelGroupIdCache.set(cacheKey, existing.id);
      return existing.id;
    }

    const created = await this.createLabel({ name: groupName, teamId, isGroup: true });
    this.labelGroupIdCache.set(cacheKey, created.id);
    return created.id;
  }
}
