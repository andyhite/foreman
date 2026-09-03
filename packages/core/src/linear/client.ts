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
  ProjectRelation,
  ProjectRelationAnchor,
  ProjectRelationType,
  ProjectStatus,
  ProjectStatusType,
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
import { LinearApiError, LinearPaginationError } from "./api.ts";
import {
  COMMENT_CREATE_MUTATION,
  COMMENTS_QUERY,
  INITIATIVE_PROJECTS_QUERY,
  INITIATIVE_QUERY_SCALAR_CONTENT,
  INITIATIVE_TO_PROJECT_CREATE_MUTATION,
  INITIATIVES_QUERY,
  ISSUE_BY_ID_QUERY,
  ISSUE_CREATE_MUTATION,
  ISSUE_LABEL_CREATE_MUTATION,
  ISSUE_RELATION_CREATE_MUTATION,
  ISSUE_RELATION_DELETE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  ISSUES_QUERY,
  PROJECT_CREATE_MUTATION,
  PROJECT_INITIATIVES_QUERY,
  PROJECT_QUERY_SCALAR_CONTENT,
  PROJECT_RELATION_CREATE_MUTATION,
  PROJECT_RELATION_DELETE_MUTATION,
  PROJECT_RELATIONS_QUERY,
  PROJECT_STATUS_QUERY,
  PROJECT_STATUSES_QUERY,
  PROJECT_UPDATE_MUTATION,
  PROJECTS_QUERY,
  TEAMS_QUERY,
  WORKFLOW_STATES_QUERY,
  WORKSPACE_LABELS_QUERY,
} from "./queries.ts";
import { groupDisplayName, labelDisplayName, labelIdFromParts, MANAGED_LABEL_GROUPS } from "../domain/labels.ts";

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
  isGroup?: boolean;
  parent: { id: string; name: string } | null;
  team: { id: string } | null;
}
interface WireRelation {
  id: string;
  type: string;
  issue: WireIssueRef;
  relatedIssue: WireIssueRef;
}
interface WireProjectRef {
  id: string;
  name: string;
  startDate: string | null;
  targetDate: string | null;
  status: WireStateRef | null;
}
/**
 * `type`, `anchorType`, and `relatedAnchorType` are all `String` on the wire —
 * Linear declares no enum for any of them (introspected). Only the far side of
 * each connection is selected, so the row shape differs by direction: an
 * outgoing row carries `relatedProject`, an incoming row carries `project`.
 */
interface WireProjectRelationRow {
  id: string;
  type: string;
  anchorType: string;
  relatedAnchorType: string;
}
interface WireOutgoingProjectRelation extends WireProjectRelationRow {
  relatedProject: WireProjectRef;
}
interface WireIncomingProjectRelation extends WireProjectRelationRow {
  project: WireProjectRef;
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
  inverseRelations?: { nodes: WireRelation[] };
  comments?: { nodes: WireComment[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

interface GraphQlErrorEntry {
  message: string;
}

interface GraphQlResponse<T> {
  data: T | null;
  errors?: GraphQlErrorEntry[];
}

/** One GraphQL round-trip's outcome — the verbose loop output's Linear tracing hook subscribes to this. */
export interface LinearRequestEvent {
  /** The document's own `query`/`mutation` name (e.g. `Issues`, `IssueUpdate`), not the field it selects. */
  operation: string;
  /** 0 on the first try, incremented on each retryable-status retry. */
  attempt: number;
  durationMs: number;
  /** `null` when the request never reached a response (e.g. it timed out). */
  status: number | null;
  ok: boolean;
  /** Present only when `ok` is false. */
  error?: string;
}

/** Options accepted by the constructor; `fetch` is the test seam. */
export interface LinearClientOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: FetchLike;
  /*
   * The one team this client is scoped to (SPEC §3.11). Absent means every
   * team the credential reaches. Applied here rather than at each `issues()`
   * call site: there are eighteen of them across the loop, the extension, and
   * the board, and a config key that silently fails to scope one of them would
   * hand another team's Triage queue to the intake batch.
   */
  team?: string | null;
  /**
   * Per-attempt request deadline. Bun's `fetch` imposes no default timeout,
   * so a half-open connection would otherwise freeze the awaiting call —
   * and since a tick awaits these serially, one hung request would silently
   * freeze the whole singleton loop.
   */
  timeoutMs?: number;
  /** Fired after every attempt (success, retry, or terminal failure) — the loop commands' `--verbose` tracing hook. Never called for cache hits. */
  onRequest?: (event: LinearRequestEvent) => void;
}

/** The document's `query Name(...)`/`mutation Name(...)` identifier, or `"anonymous"` for the one inline viewer-id query that has none. */
function operationName(document: string): string {
  const match = /\b(?:query|mutation)\s+(\w+)/.exec(document);
  return match?.[1] ?? "anonymous";
}

/** Hard ceiling on pagination loops — exhausting it with more pages remaining is a hard error, never a silent partial result. */
const MAX_PAGES = 50;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class LinearClient implements LinearWriter {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly teamScope: IssueFilter | null;
  private readonly timeoutMs: number;
  private readonly onRequest: ((event: LinearRequestEvent) => void) | null;
  private static readonly CACHE_TTL_MS = 10 * 60_000;
  private readonly labelIdCache = new Map<string, { value: IssueLabel; at: number }>();
  private readonly labelGroupIdCache = new Map<string, LinearId>();
  private readonly projectInitiativeCache = new Map<string, { value: InitiativeRef; at: number }>();
  /** Every initiative a project belongs to, keyed by project id — same lifetime and invalidation (TTL) as `projectInitiativeCache`. */
  private readonly projectInitiativesCache = new Map<string, { value: InitiativeRef[]; at: number }>();
  /** Resolved once per `type`: the workspace's own statusId for that fixed enum value. */
  private readonly projectStatusIdCache = new Map<ProjectStatusType, LinearId>();
  private viewerIdCache: { value: string; at: number } | null = null;

  constructor(options: LinearClientOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.teamScope = options.team ? { team: { key: { eq: options.team } } } : null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onRequest = options.onRequest ?? null;
  }

  /**
   * One deadline shared across every retry of a logical request: retries
   * back off but never get a fresh clock, so a request that keeps hitting
   * 429s cannot outlive `timeoutMs` by retrying forever.
   */
  private async request<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    return this.requestWithRetry<T>(document, variables, 0, signal);
  }

  private async requestWithRetry<T>(
    document: string,
    variables: Record<string, unknown>,
    attempt: number,
    signal: AbortSignal,
  ): Promise<T> {
    const startedAt = performance.now();
    const trace = (status: number | null, ok: boolean, error?: string): void => {
      if (!this.onRequest) return;
      this.onRequest({
        operation: operationName(document),
        attempt,
        durationMs: performance.now() - startedAt,
        status,
        ok,
        ...(error !== undefined ? { error } : {}),
      });
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query: document, variables }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        const message = `Linear API request timed out after ${this.timeoutMs}ms`;
        trace(null, false, message);
        throw new LinearApiError(message, null, null);
      }
      if (attempt < 2 && !signal.aborted) {
        trace(null, false, `retrying transport failure: ${String(error)}`);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 500 * 2 ** attempt);
        await promise;
        return this.requestWithRetry<T>(document, variables, attempt + 1, signal);
      }
      trace(null, false, String(error));
      throw error;
    }

    if (!response.ok) {
      if (attempt < 2 && RETRYABLE_STATUS.has(response.status)) {
        // Drain the body before backing off: undici keeps the connection's
        // underlying socket pinned to the pool until the body is consumed
        // or GC'd, and every retryable status here is precisely the
        // rate-limit condition that can least afford a leaked connection.
        const body = await response.text();
        trace(response.status, false, `retrying: ${body}`);
        await this.backoff(response, signal);
        return this.requestWithRetry<T>(document, variables, attempt + 1, signal);
      }
      const body = await response.text();
      trace(response.status, false, body);
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

  /**
   * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3);
   * Linear has been observed sending both. A date in the past or an
   * unparseable header falls back to 1s; either form is clamped to 60s so a
   * misbehaving response header can't stall a caller indefinitely. Aborts
   * early against `signal` so the overall request deadline still applies
   * during a backoff sleep.
   */
  private async backoff(response: Response, signal: AbortSignal): Promise<void> {
    const retryAfter = response.headers.get("Retry-After");
    const delayMs = this.retryDelayMs(retryAfter);
    if (signal.aborted) {
      throw new LinearApiError(`Linear API request timed out after ${this.timeoutMs}ms`, null, null);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, delayMs);
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

  private retryDelayMs(retryAfter: string | null): number {
    const MAX_DELAY_MS = 60_000;
    if (!retryAfter) return 1000;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds > 0 ? Math.min(seconds * 1000, MAX_DELAY_MS) : 1000;
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      return delta > 0 ? Math.min(delta, MAX_DELAY_MS) : 1000;
    }
    return 1000;
  }

  /** Pagination must run to completion or fail loudly — partial pages corrupt lock/reconcile decisions. */
  private refusePartialPage(operation: string, pages: number, partialCount: number): never {
    throw new LinearPaginationError(operation, pages, partialCount);
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
   * `direction` is supplied by the caller based on which connection the row
   * came from (`relations` -> outgoing, `inverseRelations` -> incoming)
   * rather than derived by comparing ids, since Linear's bidirectional
   * exposure of `relations` alone is unverified (SPEC §16 assumption 5;
   * `mapIssue` merges both connections defensively).
   */
  private mapRelation(relation: WireRelation, direction: "outgoing" | "incoming"): IssueRelation {
    const other = direction === "outgoing" ? relation.relatedIssue : relation.issue;
    return {
      id: relation.id,
      type: relation.type as IssueRelationType,
      direction,
      other: this.mapIssueRef(other),
    };
  }

  /**
   * Merges `relations` (outgoing) and `inverseRelations` (incoming),
   * de-duplicated by relation id. Correct whether or not Linear exposes a
   * relation row bidirectionally through `relations` alone — if it does,
   * the `inverseRelations` copy shares the same id and is dropped here; if
   * it doesn't, this is the only place the incoming edge is ever seen.
   */
  private mergeRelations(wire: WireIssue): IssueRelation[] {
    const seen = new Set<string>();
    const merged: IssueRelation[] = [];
    for (const relation of wire.relations.nodes) {
      if (seen.has(relation.id)) continue;
      seen.add(relation.id);
      merged.push(this.mapRelation(relation, "outgoing"));
    }
    for (const relation of wire.inverseRelations?.nodes ?? []) {
      if (seen.has(relation.id)) continue;
      seen.add(relation.id);
      merged.push(this.mapRelation(relation, "incoming"));
    }
    return merged;
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
        name: labelIdFromParts(label.name, label.parent?.name ?? null),
        parentId: label.parent?.id ?? null,
      })),
      team: { id: wire.team.id, key: wire.team.key, name: wire.team.name },
      project: wire.project ? { id: wire.project.id, name: wire.project.name } : null,
      parent: wire.parent ? this.mapIssueRef(wire.parent) : null,
      children: wire.children.nodes.map((child) => this.mapIssueRef(child)),
      assignee: wire.assignee
        ? { id: wire.assignee.id, name: wire.assignee.name, displayName: wire.assignee.displayName }
        : null,
      relations: this.mergeRelations(wire),
      comments: wire.comments ? wire.comments.nodes.map((comment) => this.mapComment(comment)) : [],
    };
  }

  async issue(id: string, options?: { includeComments?: boolean }): Promise<Issue | null> {
    const includeComments = options?.includeComments ?? false;
    const data = await this.request<{ issue: WireIssue | null }>(
      ISSUE_BY_ID_QUERY(includeComments),
      { id },
    );
    if (!data.issue) return null;
    const issue = this.mapIssue(data.issue);
    const pageInfo = data.issue.comments?.pageInfo;
    if (includeComments && pageInfo?.hasNextPage && pageInfo.endCursor) {
      issue.comments = issue.comments.concat(await this.paginateComments(issue.id, pageInfo.endCursor));
    }
    return issue;
  }

  /**
   * ANDs the managed-team scope onto a caller's filter. A caller that passes no
   * filter still gets scoped; an unscoped client returns the filter untouched,
   * so an absent `team` keeps the documented "every team" meaning.
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
    let pages = 0;
    for (;;) {
      const data = await this.request<{
        issues: { nodes: WireIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      }>(ISSUES_QUERY(includeComments), {
        filter,
        after,
        first: query.limit !== undefined ? Math.min(pageSize, query.limit - results.length) : pageSize,
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
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
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

  async comments(issueId: string): Promise<Comment[]> {
    return this.paginateComments(issueId, undefined);
  }

  /**
   * Pages the comments connection from `after` (or the start, when
   * undefined) to exhaustion. Every marker the codebase reads — lock,
   * proposal, applied, review, block — lives in a comment, so a truncated
   * page silently loses whichever marker fell past Linear's default 50.
   */
  private async paginateComments(issueId: string, after: string | undefined): Promise<Comment[]> {
    const results: Comment[] = [];
    let cursor = after;
    let pages = 0;
    for (;;) {
      const data = await this.request<{
        issue: {
          comments: { nodes: WireComment[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        } | null;
      }>(COMMENTS_QUERY, { issueId, after: cursor, first: 100 });
      if (!data.issue) break;
      for (const comment of data.issue.comments.nodes) {
        results.push(this.mapComment(comment));
      }
      if (!data.issue.comments.pageInfo.hasNextPage || !data.issue.comments.pageInfo.endCursor) break;
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

  /**
   * `Document.content` is a `String` in Linear's schema - validated by
   * introspection, so there is no second "object" shape to fall back to. An
   * earlier version tried a `content { body }` sub-selection when the scalar
   * form errored; that document is invalid against the live schema and could
   * only ever have turned one error into two.
   */
  async project(projectId: string): Promise<Project | null> {
    const data = await this.request<{
      project: {
        id: string;
        name: string;
        description: string | null;
        content: string | null;
        startDate: string | null;
        targetDate: string | null;
        status: WireStateRef | null;
        documents: {
          nodes: Array<{
            id: string;
            title: string;
            content: string | null;
            updatedAt: string;
          }>;
        };
      } | null;
    }>(PROJECT_QUERY_SCALAR_CONTENT, { projectId });
    if (!data.project) return null;
    return {
      id: data.project.id,
      name: data.project.name,
      description: data.project.description,
      content: data.project.content,
      startDate: data.project.startDate ?? null,
      targetDate: data.project.targetDate ?? null,
      status: this.mapProjectStatus(data.project.status),
      documents: data.project.documents.nodes.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        updatedAt: doc.updatedAt,
      })),
    };
  }

  private mapProjectStatus(status: WireStateRef | null | undefined): ProjectStatus | null {
    if (!status) return null;
    return { id: status.id, name: status.name, type: status.type as ProjectStatusType };
  }

  /**
   * Merges `relations` (outgoing) and `inverseRelations` (incoming),
   * de-duplicated by relation id, and reorients each row's anchor pair onto
   * the queried project — on the wire `anchorType` describes the row's own
   * `project`, which is the *other* side for an incoming edge. Without the
   * swap a blocker would read as a blockee.
   */
  async projectRelations(projectId: string): Promise<ProjectRelation[]> {
    const data = await this.request<{
      project: {
        id: string;
        relations: { nodes: WireOutgoingProjectRelation[] };
        inverseRelations: { nodes: WireIncomingProjectRelation[] };
      } | null;
    }>(PROJECT_RELATIONS_QUERY, { projectId });
    if (!data.project) return [];

    const seen = new Set<string>();
    const merged: ProjectRelation[] = [];
    for (const row of data.project.relations.nodes) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(this.mapProjectRelation(row, row.relatedProject, "outgoing"));
    }
    for (const row of data.project.inverseRelations.nodes) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(this.mapProjectRelation(row, row.project, "incoming"));
    }
    return merged;
  }

  private mapProjectRelation(
    row: WireProjectRelationRow,
    other: WireProjectRef,
    direction: "outgoing" | "incoming",
  ): ProjectRelation {
    const outgoing = direction === "outgoing";
    return {
      id: row.id,
      type: row.type as ProjectRelationType,
      direction,
      anchor: (outgoing ? row.anchorType : row.relatedAnchorType) as ProjectRelationAnchor,
      otherAnchor: (outgoing ? row.relatedAnchorType : row.anchorType) as ProjectRelationAnchor,
      other: {
        id: other.id,
        name: other.name,
        status: this.mapProjectStatus(other.status),
        startDate: other.startDate,
        targetDate: other.targetDate,
      },
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
    const cached = this.projectInitiativesCache.get(projectId);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;
    const { initiatives } = await this.fetchProjectInitiatives(projectId);
    this.projectInitiativesCache.set(projectId, { value: initiatives, at: Date.now() });
    return initiatives;
  }

  async projectInitiative(projectId: string): Promise<InitiativeRef> {
    const cached = this.projectInitiativeCache.get(projectId);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;
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
    this.projectInitiativeCache.set(projectId, { value: ref, at: Date.now() });
    return ref;
  }

  /** A project's current native status. Null when the project itself is absent. */
  async projectStatus(projectId: string): Promise<ProjectStatus | null> {
    const data = await this.request<{
      project: { id: string; status: { id: string; name: string; type: string } } | null;
    }>(PROJECT_STATUS_QUERY, { projectId });
    if (!data.project) return null;
    return {
      id: data.project.status.id,
      name: data.project.status.name,
      type: data.project.status.type as ProjectStatusType,
    };
  }

  /** Resolves `type` to the workspace's matching `ProjectStatus.id`, fetching the list once and caching every type found. */
  private async resolveProjectStatusId(type: ProjectStatusType): Promise<LinearId> {
    const cached = this.projectStatusIdCache.get(type);
    if (cached) return cached;
    const data = await this.request<{ projectStatuses: { nodes: Array<{ id: string; type: string }> } }>(
      PROJECT_STATUSES_QUERY,
      {},
    );
    for (const status of data.projectStatuses.nodes) {
      this.projectStatusIdCache.set(status.type as ProjectStatusType, status.id);
    }
    const resolved = this.projectStatusIdCache.get(type);
    if (!resolved) {
      throw new LinearApiError(`Workspace has no project status of type "${type}"`, null, null);
    }
    return resolved;
  }

  async updateProjectStatus(input: { projectId: LinearId; type: ProjectStatusType }): Promise<void> {
    const statusId = await this.resolveProjectStatusId(input.type);
    const data = await this.request<{ projectUpdate: { success: boolean } }>(PROJECT_UPDATE_MUTATION, {
      id: input.projectId,
      input: { statusId },
    });
    if (!data.projectUpdate.success) {
      throw new LinearApiError(`Failed to update project ${input.projectId} to status "${input.type}"`, null, null);
    }
  }

  /** Every initiative in the workspace — the setup wizard's picker (SPEC §3.10). */
  async initiatives(): Promise<InitiativeRef[]> {
    const results: InitiativeRef[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const data = await this.request<{
        initiatives: { nodes: InitiativeRef[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      }>(INITIATIVES_QUERY, { after });
      results.push(...data.initiatives.nodes);
      if (!data.initiatives.pageInfo.hasNextPage || !data.initiatives.pageInfo.endCursor) break;
      if (data.initiatives.pageInfo.endCursor === after) {
        this.refusePartialPage("initiatives()", pages, results.length);
      }
      after = data.initiatives.pageInfo.endCursor;
      pages += 1;
      if (pages >= MAX_PAGES) {
        this.refusePartialPage("initiatives()", pages, results.length);
      }
    }
    return results;
  }

  /** The Linear user id the API key belongs to, memoized for `CACHE_TTL_MS`. */
  async viewerId(): Promise<string> {
    if (this.viewerIdCache !== null && Date.now() - this.viewerIdCache.at < LinearClient.CACHE_TTL_MS) {
      return this.viewerIdCache.value;
    }
    const data = await this.request<{ viewer: { id: string } }>("query { viewer { id } }", {});
    this.viewerIdCache = { value: data.viewer.id, at: Date.now() };
    return data.viewer.id;
  }

  /** Same as `project()`: `Document.content` is a `String`, so there is one valid shape. */
  async initiative(initiativeId: string): Promise<Initiative | null> {
    const data = await this.request<{
      initiative: {
        id: string;
        name: string;
        documents: {
          nodes: Array<{
            id: string;
            title: string;
            content: string | null;
            updatedAt: string;
          }>;
        };
      } | null;
    }>(INITIATIVE_QUERY_SCALAR_CONTENT, { initiativeId });
    if (!data.initiative) return null;
    return {
      id: data.initiative.id,
      name: data.initiative.name,
      documents: data.initiative.documents.nodes.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        updatedAt: doc.updatedAt,
      })),
    };
  }

  async workflowStates(teamId: string): Promise<WorkflowState[]> {
    const data = await this.request<{
      team: { states: { nodes: Array<WireStateRef & { position: number }> } };
    }>(WORKFLOW_STATES_QUERY, { teamId });
    return data.team.states.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type as WorkflowState["type"],
      position: state.position,
    }));
  }

  /**
   * Raw workspace labels, unmapped — both parent groups (`isGroup: true`)
   * and their members, straight off the wire. `labels()` and `ensureLabel`
   * both need this; `labels()` reconstructs canonical ids from it, and
   * `ensureLabel`/`ensureLabelGroup` match Linear's actual (display-name)
   * labels against it directly.
   *
   * Linear's `issueLabels` query has no verified team-filter argument, so
   * team scoping happens client-side: when `teamId` is given, keep only
   * labels owned by that team plus workspace-level labels (`team: null`) —
   * dropping the rest is what stops `ensureLabel` from matching another
   * team's same-named label and applying it cross-team.
   */
  private async fetchRawLabels(teamId?: string): Promise<WireLabel[]> {
    const results: WireLabel[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const data = await this.request<{
        issueLabels: { nodes: WireLabel[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      }>(WORKSPACE_LABELS_QUERY, { after });
      results.push(...data.issueLabels.nodes);
      if (!data.issueLabels.pageInfo.hasNextPage || !data.issueLabels.pageInfo.endCursor) break;
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

  /**
   * Every label in the workspace, with each nested label's canonical
   * colon-form id (SPEC §4.5) reconstructed from its Linear group + own name
   * (e.g. parent "Type", label "Bug" -> `"type:bug"`) so the rest of the
   * codebase never has to know Linear's native label-group display names.
   */
  async labels(teamId?: string): Promise<IssueLabel[]> {
    const raw = await this.fetchRawLabels(teamId);
    return raw.map((label) => ({
      id: label.id,
      name: labelIdFromParts(label.name, label.parent?.name ?? null),
      parentId: label.parent?.id ?? null,
    }));
  }

  async teams(): Promise<TeamRef[]> {
    const results: TeamRef[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const data = await this.request<{
        teams: { nodes: TeamRef[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      }>(TEAMS_QUERY, { after });
      results.push(...data.teams.nodes);
      if (!data.teams.pageInfo.hasNextPage || !data.teams.pageInfo.endCursor) break;
      if (data.teams.pageInfo.endCursor === after) {
        this.refusePartialPage("teams()", pages, results.length);
      }
      after = data.teams.pageInfo.endCursor;
      pages += 1;
      if (pages >= MAX_PAGES) {
        this.refusePartialPage("teams()", pages, results.length);
      }
    }
    return results;
  }

  async projects(): Promise<ProjectRef[]> {
    const results: ProjectRef[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const data = await this.request<{
        projects: { nodes: ProjectRef[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      }>(PROJECTS_QUERY, { after });
      results.push(...data.projects.nodes);
      if (!data.projects.pageInfo.hasNextPage || !data.projects.pageInfo.endCursor) break;
      if (data.projects.pageInfo.endCursor === after) {
        this.refusePartialPage("projects()", pages, results.length);
      }
      after = data.projects.pageInfo.endCursor;
      pages += 1;
      if (pages >= MAX_PAGES) {
        this.refusePartialPage("projects()", pages, results.length);
      }
    }
    return results;
  }


  /** An initiative's projects — used to check for the standing Maintenance project (SPEC §3.11). */
  async initiativeProjects(initiativeId: string): Promise<ProjectRef[]> {
    const data = await this.request<{
      initiative: { projects: { nodes: ProjectRef[] } } | null;
    }>(INITIATIVE_PROJECTS_QUERY, { initiativeId });
    return data.initiative?.projects.nodes ?? [];
  }

  /**
   * `ProjectCreateInput` has exactly two non-null fields on the live API:
   * `name: String!` and `teamIds: [String!]!` — a project cannot exist
   * without a team, so `teamIds` is required here rather than optional.
   * There is no `initiativeId`/`initiativeIds` field on the input at all
   * (all 23 fields were dumped and checked); attaching a project to an
   * initiative is a separate `initiativeToProjectCreate` mutation (measured
   * against the live API this session; see SPEC §16 item 10), so a caller
   * that needs both must call `addProjectToInitiative` afterward and handle
   * the window between the two calls.
   */
  async createProject(input: {
    name: string;
    teamIds: LinearId[];
    description?: string;
    content?: string;
    startDate?: string;
    targetDate?: string;
  }): Promise<ProjectRef> {
    const data = await this.request<{
      projectCreate: { success: boolean; project: ProjectRef | null };
    }>(PROJECT_CREATE_MUTATION, { input });
    // `success` is non-null but `project` is nullable on `ProjectPayload` —
    // a true `success` with a null `project` is still an error, not a
    // `ProjectRef` with undefined fields.
    if (!data.projectCreate.success || !data.projectCreate.project) {
      throw new LinearApiError(`Failed to create project "${input.name}"`, null, null);
    }
    return data.projectCreate.project;
  }

  async addProjectToInitiative(input: { projectId: LinearId; initiativeId: LinearId }): Promise<void> {
    const data = await this.request<{ initiativeToProjectCreate: { success: boolean } }>(
      INITIATIVE_TO_PROJECT_CREATE_MUTATION,
      { input },
    );
    if (!data.initiativeToProjectCreate.success) {
      throw new LinearApiError(
        `Failed to attach project ${input.projectId} to initiative ${input.initiativeId}`,
        null,
        null,
      );
    }
  }

  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    const data = await this.request<{ issueUpdate: { issue: WireIssue | null } }>(
      ISSUE_UPDATE_MUTATION(false),
      { id, input },
    );
    if (!data.issueUpdate.issue) {
      throw new LinearApiError(`Failed to update issue ${id}: Linear returned no issue`, null, null);
    }
    return this.mapIssue(data.issueUpdate.issue);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const data = await this.request<{ issueCreate: { issue: WireIssue | null } }>(
      ISSUE_CREATE_MUTATION(false),
      { input },
    );
    if (!data.issueCreate.issue) {
      throw new LinearApiError(`Failed to create issue "${input.title}": Linear returned no issue`, null, null);
    }
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
    const data = await this.request<{ issueRelationCreate: { success: boolean } }>(
      ISSUE_RELATION_CREATE_MUTATION,
      { input },
    );
    if (!data.issueRelationCreate.success) {
      throw new LinearApiError(
        `Failed to create ${input.type} relation from ${input.issueId} to ${input.relatedIssueId}`,
        null,
        null,
      );
    }
  }

  async createProjectRelation(input: {
    projectId: LinearId;
    relatedProjectId: LinearId;
    type: ProjectRelationType;
    anchorType: ProjectRelationAnchor;
    relatedAnchorType: ProjectRelationAnchor;
  }): Promise<void> {
    const data = await this.request<{ projectRelationCreate: { success: boolean } }>(
      PROJECT_RELATION_CREATE_MUTATION,
      { input },
    );
    if (!data.projectRelationCreate.success) {
      throw new LinearApiError(
        `Failed to create ${input.type} relation from project ${input.projectId} to ${input.relatedProjectId}`,
        null,
        null,
      );
    }
  }

  async deleteProjectRelation(relationId: LinearId): Promise<void> {
    const data = await this.request<{ projectRelationDelete: { success: boolean } }>(
      PROJECT_RELATION_DELETE_MUTATION,
      { id: relationId },
    );
    if (!data.projectRelationDelete.success) {
      throw new LinearApiError(`Failed to delete project relation ${relationId}`, null, null);
    }
  }

  async deleteRelation(relationId: LinearId): Promise<void> {
    const data = await this.request<{ issueRelationDelete: { success: boolean } }>(
      ISSUE_RELATION_DELETE_MUTATION,
      { id: relationId },
    );
    if (!data.issueRelationDelete.success) {
      throw new LinearApiError(`Failed to delete relation ${relationId}`, null, null);
    }
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

  /**
   * Resolves a canonical colon-form label id (e.g. `"agent:ready"`) to its
   * Linear label, creating the label — and its nested parent group, e.g.
   * "Agent" -> "Ready" (SPEC §4.5) — if either is absent. Ungrouped ids
   * (no colon, e.g. `legacy`) are created flat, unchanged.
   */
  async ensureLabel(name: string, teamId: LinearId): Promise<IssueLabel> {
    const cacheKey = `${teamId}:${name}`;
    const cached = this.labelIdCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;

    const matches = (await this.labels(teamId)).filter((label) => label.name === name);
    if (matches.length > 1) {
      throw new LinearApiError(
        `Label "${name}" matches ${matches.length} labels visible to team ${teamId} (team-owned and workspace-level); cannot resolve unambiguously.`,
        null,
        null,
      );
    }
    const existing = matches[0];
    if (existing) {
      this.labelIdCache.set(cacheKey, { value: existing, at: Date.now() });
      return existing;
    }

    const group = MANAGED_LABEL_GROUPS.find((candidate) => name.startsWith(candidate.prefix));
    const parentId = group ? await this.ensureLabelGroup(group.prefix, teamId) : undefined;
    const childName = group ? labelDisplayName(name.slice(group.prefix.length)) : name;

    const created = await this.createLabel({ name: childName, teamId, parentId });
    const label: IssueLabel = { id: created.id, name, parentId: created.parentId };
    this.labelIdCache.set(cacheKey, { value: label, at: Date.now() });
    return label;
  }

  /** Resolve (creating if absent) the `isGroup: true` parent for a managed label prefix, e.g. `"agent:"` -> "Agent". */
  private async ensureLabelGroup(prefix: string, teamId: LinearId): Promise<LinearId> {
    const cacheKey = `${teamId}:${prefix}`;
    const cached = this.labelGroupIdCache.get(cacheKey);
    if (cached) return cached;

    const displayName = groupDisplayName(prefix);
    const existing = (await this.fetchRawLabels(teamId)).find(
      (label) => label.isGroup === true && label.name === displayName,
    );
    if (existing) {
      this.labelGroupIdCache.set(cacheKey, existing.id);
      return existing.id;
    }

    const created = await this.createLabel({ name: displayName, teamId, isGroup: true });
    this.labelGroupIdCache.set(cacheKey, created.id);
    return created.id;
  }
}
