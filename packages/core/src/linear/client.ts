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
import type {
  CreateIssueInput,
  FetchLike,
  IssueFilter,
  IssueMutation,
  IssueQuery,
  LinearWriter,
} from "./api.ts";
import { LinearApiError, LinearPaginationError } from "./api.ts";
import {
  COMMENT_CREATE_MUTATION,
  COMMENTS_QUERY,
  DOCUMENT_CREATE_MUTATION,
  DOCUMENT_UPDATE_MUTATION,
  INITIATIVE_QUERY_SCALAR_CONTENT,
  ISSUE_BY_ID_QUERY,
  ISSUE_CREATE_MUTATION,
  ISSUE_LABEL_CREATE_MUTATION,
  ISSUE_RELATION_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  ISSUES_QUERY,
  PROJECT_CREATE_MUTATION,
  PROJECT_INITIATIVES_QUERY,
  PROJECT_LABEL_CREATE_MUTATION,
  PROJECT_LABELS_QUERY,
  PROJECT_QUERY_SCALAR_CONTENT,
  PROJECT_RELATION_CREATE_MUTATION,
  PROJECT_RELATIONS_QUERY,
  PROJECT_STATUS_QUERY,
  PROJECT_STATUSES_QUERY,
  PROJECT_UPDATE_MUTATION,
  PROJECTS_QUERY,
  TEAM_DOCUMENTS_QUERY,
  TEAM_SETTINGS_QUERY,
  TEAM_UPDATE_MUTATION,
  TEAMS_QUERY,
  USER_BY_EMAIL_QUERY,
  WORKFLOW_STATE_ARCHIVE_MUTATION,
  WORKFLOW_STATE_CREATE_MUTATION,
  WORKFLOW_STATE_UPDATE_MUTATION,
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
 * `PROJECTS_QUERY`'s row shape. Deliberately just `WireProjectRef` — an
 * earlier revision also fetched each project's `labels` connection here,
 * but nothing downstream reads `ProjectRef.labels` from a team-scoped read,
 * and the unbounded nested `labels`/`parent` connection under a
 * `first: 250` project page is exactly the shape Linear's complexity
 * ceiling rejects with `Query too complex` (measured against the live API).
 */
type WireTeamProjectRef = WireProjectRef;
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
  labels: { nodes: WireLabel[]; pageInfo?: { hasNextPage: boolean } };
  project: { id: string; name: string } | null;
  team: { id: string; key: string; name: string };
  assignee: WireUser | null;
  parent: WireIssueRef | null;
  children: { nodes: WireIssueRef[]; pageInfo?: { hasNextPage: boolean } };
  relations: { nodes: WireRelation[]; pageInfo?: { hasNextPage: boolean } };
  inverseRelations?: { nodes: WireRelation[]; pageInfo?: { hasNextPage: boolean } };
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
  private readonly teamKeyOption: string | null;
  private readonly timeoutMs: number;
  private readonly onRequest: ((event: LinearRequestEvent) => void) | null;
  private static readonly CACHE_TTL_MS = 10 * 60_000;
  private readonly labelIdCache = new Map<string, { value: IssueLabel; at: number }>();
  private readonly labelGroupIdCache = new Map<string, { value: LinearId; at: number }>();
  private readonly projectLabelIdCache = new Map<string, { value: IssueLabel; at: number }>();
  private readonly projectLabelGroupIdCache = new Map<string, { value: LinearId; at: number }>();
  /** The team's documents, keyed by team key — TTL-invalidated. Holds the product `Context` doc (SPEC §4.7). */
  private readonly teamDocumentsCache = new Map<string, { value: LinearDocument[]; at: number }>();
  /** Every initiative a project belongs to, keyed by project id — TTL-invalidated. Usually an empty array. */
  private readonly projectInitiativesCache = new Map<string, { value: InitiativeRef[]; at: number }>();
  /** Resolved once per `type`: the workspace's own statusId for that fixed enum value. */
  private readonly projectStatusIdCache = new Map<ProjectStatusType, { value: LinearId; at: number }>();
  private viewerIdCache: { value: string; at: number } | null = null;

  constructor(options: LinearClientOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.teamScope = options.team ? { team: { key: { eq: options.team } } } : null;
    this.teamKeyOption = options.team ?? null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onRequest = options.onRequest ?? null;
  }

  /** The single team this client is scoped to, when configured (`LinearClientOptions.team`). */
  get teamKey(): string | null {
    return this.teamKeyOption;
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
    // A dropped response for an already-committed mutation must never be
    // replayed — retrying `IssueCreate`/`CommentCreate`/etc. on a transport
    // blip risks a duplicate write. Only queries, which are safe to repeat,
    // get the retry loop below.
    const retryable = /^\s*query\b/.test(document);
    return this.requestWithRetry<T>(document, variables, 0, signal, retryable);
  }

  private async requestWithRetry<T>(
    document: string,
    variables: Record<string, unknown>,
    attempt: number,
    signal: AbortSignal,
    retryable: boolean,
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
      if (retryable && attempt < 2 && !signal.aborted) {
        trace(null, false, `retrying transport failure: ${String(error)}`);
        await this.sleepUntil(500 * 2 ** attempt, signal);
        return this.requestWithRetry<T>(document, variables, attempt + 1, signal, retryable);
      }
      trace(null, false, String(error));
      throw error;
    }

    // Body reads (`text()`/`json()`) live inside this try too: a mid-body
    // abort must surface as a `LinearApiError` like every other failure
    // here, not escape as a raw `AbortError`/`TypeError` that skips the
    // retry logic above and the `instanceof LinearApiError` branches
    // `init.ts`/`wizard.ts` use to fall back to manual entry.
    try {
      if (!response.ok) {
        if (retryable && attempt < 2 && RETRYABLE_STATUS.has(response.status)) {
          // Drain the body before backing off: undici keeps the connection's
          // underlying socket pinned to the pool until the body is consumed
          // or GC'd, and every retryable status here is precisely the
          // rate-limit condition that can least afford a leaked connection.
          const body = await response.text();
          trace(response.status, false, `retrying: ${body}`);
          await this.backoff(response, signal);
          return this.requestWithRetry<T>(document, variables, attempt + 1, signal, retryable);
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
    } catch (error) {
      if (error instanceof LinearApiError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      trace(response.status, false, message);
      throw new LinearApiError(
        `Linear API request failed while reading the response: ${message}`,
        response.status,
        null,
      );
    }
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
    await this.sleepUntil(delayMs, signal);
  }

  /**
   * Sleeps `delayMs`, or rejects early if `signal` aborts first — so a retry
   * sleep (transport-error backoff or `Retry-After`) can never let the total
   * request outlive `timeoutMs`, which is exactly the deadline `signal`
   * already encodes.
   */
  private async sleepUntil(delayMs: number, signal: AbortSignal): Promise<void> {
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

  /**
   * Shared stepper for the five list queries whose pagination tail is
   * otherwise byte-identical: push nodes, stop when the connection reports
   * no next page, refuse a stalled `endCursor` or a page beyond `MAX_PAGES`
   * as a partial result. `pick` reaches into the response for this query's
   * one connection; a `null` return tolerates a first-page miss (the only
   * caller that needs this is `paginateComments`, whose root `issue` can be
   * absent) and is refused on every later page instead. `issues()` is not
   * routed through this: its per-node early exit on `query.limit` and
   * `first` shrinking as results accumulate don't fit this shape.
   */
  private async paginate<TNode, TData>(
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    pick: (data: TData) => { nodes: TNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null,
    initialAfter?: string,
  ): Promise<TNode[]> {
    const results: TNode[] = [];
    let after = initialAfter;
    let pages = 0;
    for (;;) {
      const data = await this.request<TData>(document, { ...variables, after });
      const page = pick(data);
      if (page === null) {
        if (pages === 0 && initialAfter === undefined) return results;
        this.refusePartialPage(operation, pages, results.length);
      }
      results.push(...page.nodes);
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
      if (page.pageInfo.endCursor === after) {
        this.refusePartialPage(operation, pages, results.length);
      }
      after = page.pageInfo.endCursor;
      pages += 1;
      if (pages >= MAX_PAGES) {
        this.refusePartialPage(operation, pages, results.length);
      }
    }
    return results;
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

  /**
   * `children`, `relations`, `inverseRelations`, and `labels` are selected
   * with no `first:` — Linear's default page size applies. A truncated page
   * here reads as "no children" (letting a re-applied refine duplicate
   * every child past the default) or "unblocked" (a dropped `blocks` edge),
   * so a page beyond the default must fail loudly rather than silently.
   */
  private assertIssueConnectionsComplete(wire: WireIssue): void {
    const connections: Array<[string, { pageInfo?: { hasNextPage: boolean } } | undefined]> = [
      ["children", wire.children],
      ["relations", wire.relations],
      ["inverseRelations", wire.inverseRelations],
      ["labels", wire.labels],
    ];
    for (const [name, connection] of connections) {
      if (connection?.pageInfo?.hasNextPage) {
        this.refusePartialPage(`issue(${wire.identifier}).${name}`, 0, 0);
      }
    }
  }

  private mapIssue(wire: WireIssue): Issue {
    this.assertIssueConnectionsComplete(wire);
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
    const wireComments = await this.paginate<
      WireComment,
      { issue: { comments: { nodes: WireComment[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }
    >(
      `paginateComments(${issueId})`,
      COMMENTS_QUERY,
      { issueId, first: 100 },
      (data) => data.issue?.comments ?? null,
      after,
    );
    return wireComments.map((comment) => this.mapComment(comment));
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
    };
  }

  private mapProjectStatus(status: WireStateRef | null | undefined): ProjectStatus | null {
    if (!status) return null;
    return { id: status.id, name: status.name, type: status.type as ProjectStatusType };
  }

  /** Reconstructs canonical colon-form label ids (SPEC §4.5) from Linear's group + own name. */
  private mapLabels(labels: readonly WireLabel[]): IssueLabel[] {
    return labels.map((label) => ({
      id: label.id,
      name: labelIdFromParts(label.name, label.parent?.name ?? null),
      parentId: label.parent?.id ?? null,
    }));
  }

  private mapProjectRef(project: WireTeamProjectRef): ProjectRef {
    return {
      id: project.id,
      name: project.name,
      status: this.mapProjectStatus(project.status),
      startDate: project.startDate,
      targetDate: project.targetDate,
    };
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
        relations: { nodes: WireOutgoingProjectRelation[]; pageInfo?: { hasNextPage: boolean } };
        inverseRelations: { nodes: WireIncomingProjectRelation[]; pageInfo?: { hasNextPage: boolean } };
      } | null;
    }>(PROJECT_RELATIONS_QUERY, { projectId });
    if (!data.project) return [];
    if (data.project.relations.pageInfo?.hasNextPage || data.project.inverseRelations.pageInfo?.hasNextPage) {
      this.refusePartialPage(`projectRelations(${projectId})`, 0, 0);
    }

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
   * The team's documents — the product `Context` doc among them (SPEC §4.7).
   * Cached on the same TTL as the rest: the doc changes when the operator
   * edits it, which is rare, and every dispatch in a poll asks for it.
   */
  async teamDocuments(teamKey: string): Promise<LinearDocument[]> {
    const cached = this.teamDocumentsCache.get(teamKey);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;
    const documents = await this.paginate<
      LinearDocument,
      { documents: { nodes: LinearDocument[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    >("teamDocuments()", TEAM_DOCUMENTS_QUERY, { filter: { team: { key: { eq: teamKey } } }, first: 50 }, (data) => data.documents);
    this.teamDocumentsCache.set(teamKey, { value: documents, at: Date.now() });
    return documents;
  }

  /** The wire row behind `projectInitiatives`. */
  private async fetchProjectInitiatives(projectId: string): Promise<InitiativeRef[]> {
    const data = await this.request<{
      project: { id: string; initiatives: { nodes: InitiativeRef[] } } | null;
    }>(PROJECT_INITIATIVES_QUERY, { projectId });
    return data.project?.initiatives.nodes ?? [];
  }

  /**
   * Every initiative a project belongs to, unfiltered. Foreman never creates
   * or requires one; this exists so the context digest can fold in an
   * operator-maintained initiative brief when a project happens to have one
   * (SPEC §4.7). An empty array is the ordinary case.
   */
  async projectInitiatives(projectId: string): Promise<InitiativeRef[]> {
    const cached = this.projectInitiativesCache.get(projectId);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;
    const initiatives = await this.fetchProjectInitiatives(projectId);
    this.projectInitiativesCache.set(projectId, { value: initiatives, at: Date.now() });
    return initiatives;
  }

  /** Same shape rule as `project()`: `Document.content` is a `String`, so there is one valid shape. */
  async initiative(initiativeId: string): Promise<Initiative | null> {
    const data = await this.request<{
      initiative: {
        id: string;
        name: string;
        documents: { nodes: Array<{ id: string; title: string; content: string | null; updatedAt: string }> };
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

  /** A project's current native status. Null when the project itself is absent. */
  async projectStatus(projectId: string): Promise<ProjectStatus | null> {
    const data = await this.request<{
      project: { id: string; status: WireStateRef | null } | null;
    }>(PROJECT_STATUS_QUERY, { projectId });
    if (!data.project) return null;
    return this.mapProjectStatus(data.project.status);
  }

  /** Resolves `type` to the workspace's matching `ProjectStatus.id`, fetching the list once and caching every type found. */
  private async resolveProjectStatusId(type: ProjectStatusType): Promise<LinearId> {
    const cached = this.projectStatusIdCache.get(type);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;
    const data = await this.request<{ projectStatuses: { nodes: Array<{ id: string; type: string }> } }>(
      PROJECT_STATUSES_QUERY,
      {},
    );
    for (const status of data.projectStatuses.nodes) {
      this.projectStatusIdCache.set(status.type as ProjectStatusType, { value: status.id, at: Date.now() });
    }
    const resolved = this.projectStatusIdCache.get(type);
    if (!resolved) {
      throw new LinearApiError(`Workspace has no project status of type "${type}"`, null, null);
    }
    return resolved.value;
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

  /** The Linear user id the API key belongs to, memoized for `CACHE_TTL_MS`. */
  async viewerId(): Promise<string> {
    if (this.viewerIdCache !== null && Date.now() - this.viewerIdCache.at < LinearClient.CACHE_TTL_MS) {
      return this.viewerIdCache.value;
    }
    const data = await this.request<{ viewer: { id: string } }>("query { viewer { id } }", {});
    this.viewerIdCache = { value: data.viewer.id, at: Date.now() };
    return data.viewer.id;
  }

  /** Resolves an operator's account by email for `foreman setup`'s `linear.operatorUserId` prompt. Null when no workspace user has that email. */
  async userByEmail(email: string): Promise<UserRef | null> {
    const data = await this.request<{ users: { nodes: Array<UserRef & { email: string }> } }>(USER_BY_EMAIL_QUERY, {
      email,
    });
    const user = data.users.nodes[0];
    return user ? { id: user.id, name: user.name, displayName: user.displayName } : null;
  }

  async workflowStates(teamId: string): Promise<WorkflowState[]> {
    const data = await this.request<{
      team: { states: { nodes: Array<WireStateRef & { position: number; color: string; description: string | null }> } };
    }>(WORKFLOW_STATES_QUERY, { teamId });
    return data.team.states.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type as WorkflowState["type"],
      position: state.position,
      color: state.color,
      description: state.description,
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
    const results = await this.paginate<WireLabel, { issueLabels: { nodes: WireLabel[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      "fetchRawLabels()",
      WORKSPACE_LABELS_QUERY,
      {},
      (data) => data.issueLabels,
    );
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
    return this.mapLabels(raw);
  }

  async teams(): Promise<TeamRef[]> {
    return this.paginate<TeamRef, { teams: { nodes: TeamRef[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      "teams()",
      TEAMS_QUERY,
      {},
      (data) => data.teams,
    );
  }

  async projects(teamKey: string): Promise<ProjectRef[]> {
    const nodes = await this.paginate<WireTeamProjectRef, { projects: { nodes: WireTeamProjectRef[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      "projects()",
      PROJECTS_QUERY,
      { teamKey },
      (data) => data.projects,
    );
    return nodes.map((node) => this.mapProjectRef(node));
  }

  /**
   * `ProjectCreateInput` has exactly two non-null required fields on the live
   * API: `name: String!` and `teamIds: [String!]!` (measured). There is no
   * `initiativeId`/`initiativeIds` field on the input at all (SPEC §16 item
   * 10, measured) — a project's optional initiative membership is out of
   * this client's write surface entirely.
   */
  async createProject(input: {
    name: string;
    teamIds: LinearId[];
    description?: string;
    content?: string;
    startDate?: string;
    targetDate?: string;
    labelIds?: LinearId[];
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
   * Shared "resolve or create" logic behind `ensureLabel`/`ensureWorkspaceLabel`
   * and `ensureProjectLabel`: resolve a canonical colon-form label id
   * (e.g. `"foreman:hands-off"`) against every label `fetchRaw` returns,
   * creating the label — and its nested parent group, e.g. "Foreman" ->
   * "Hands Off" (SPEC §4.5) — if either is absent. An ungrouped id (no
   * colon) is created flat, unchanged. `scope` composes the cache key so
   * distinct label surfaces (team-scoped, workspace-scoped, project-level)
   * sharing this logic never collide.
   */
  private async ensureLabelUsing(config: {
    name: string;
    scope: string;
    opts: { color?: string; description?: string } | undefined;
    idCache: Map<string, { value: IssueLabel; at: number }>;
    groupIdCache: Map<string, { value: LinearId; at: number }>;
    fetchRaw: () => Promise<WireLabel[]>;
    create: (input: {
      name: string;
      isGroup?: boolean;
      parentId?: LinearId;
      color?: string;
      description?: string;
    }) => Promise<IssueLabel>;
    ambiguousMessage: (count: number) => string;
  }): Promise<IssueLabel> {
    const { name, scope, opts, idCache, groupIdCache, fetchRaw, create, ambiguousMessage } = config;
    const cacheKey = `${scope}:${name}`;
    const cached = idCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;

    const matches = this.mapLabels(await fetchRaw()).filter((label) => label.name === name);
    if (matches.length > 1) {
      throw new LinearApiError(ambiguousMessage(matches.length), null, null);
    }
    const existing = matches[0];
    if (existing) {
      idCache.set(cacheKey, { value: existing, at: Date.now() });
      return existing;
    }

    const group = MANAGED_LABEL_GROUPS.find((candidate) => name.startsWith(candidate.prefix));
    const parentId = group
      ? await this.ensureLabelGroupUsing({ prefix: group.prefix, scope, groupIdCache, fetchRaw, create })
      : undefined;
    const childName = group ? labelDisplayName(name.slice(group.prefix.length)) : name;

    const created = await create({ name: childName, parentId, color: opts?.color, description: opts?.description });
    const label: IssueLabel = { id: created.id, name, parentId: created.parentId };
    idCache.set(cacheKey, { value: label, at: Date.now() });
    return label;
  }

  /** Resolve (creating if absent) the `isGroup: true` parent for a managed label prefix, shared by every `ensureLabelUsing` caller. */
  private async ensureLabelGroupUsing(config: {
    prefix: string;
    scope: string;
    groupIdCache: Map<string, { value: LinearId; at: number }>;
    fetchRaw: () => Promise<WireLabel[]>;
    create: (input: { name: string; isGroup?: boolean; parentId?: LinearId }) => Promise<IssueLabel>;
  }): Promise<LinearId> {
    const { prefix, scope, groupIdCache, fetchRaw, create } = config;
    const cacheKey = `${scope}:${prefix}`;
    const cached = groupIdCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LinearClient.CACHE_TTL_MS) return cached.value;

    const displayName = groupDisplayName(prefix);
    const existing = (await fetchRaw()).find((label) => label.isGroup === true && label.name === displayName);
    if (existing) {
      groupIdCache.set(cacheKey, { value: existing.id, at: Date.now() });
      return existing.id;
    }

    const created = await create({ name: displayName, isGroup: true });
    groupIdCache.set(cacheKey, { value: created.id, at: Date.now() });
    return created.id;
  }

  async ensureLabel(name: string, teamId: LinearId, opts?: { color?: string; description?: string }): Promise<IssueLabel> {
    return this.ensureLabelUsing({
      name,
      scope: teamId,
      opts,
      idCache: this.labelIdCache,
      groupIdCache: this.labelGroupIdCache,
      fetchRaw: () => this.fetchRawLabels(teamId),
      create: (input) => this.createLabel({ ...input, teamId }),
      ambiguousMessage: (count) =>
        `Label "${name}" matches ${count} labels visible to team ${teamId} (team-owned and workspace-level); cannot resolve unambiguously.`,
    });
  }

  async ensureWorkspaceLabel(name: string, opts?: { color?: string; description?: string }): Promise<IssueLabel> {
    return this.ensureLabelUsing({
      name,
      scope: "workspace",
      opts,
      idCache: this.labelIdCache,
      groupIdCache: this.labelGroupIdCache,
      fetchRaw: () => this.fetchRawLabels(undefined),
      create: (input) => this.createLabel(input),
      ambiguousMessage: (count) =>
        `Label "${name}" matches ${count} labels visible workspace-wide (team-owned and workspace-level); cannot resolve unambiguously.`,
    });
  }

  /** Raw workspace `ProjectLabel`s, unmapped, paged to exhaustion — mirrors `fetchRawLabels` for the project-label surface. */
  private async fetchRawProjectLabels(): Promise<WireLabel[]> {
    return this.paginate<WireLabel, { projectLabels: { nodes: WireLabel[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      "fetchRawProjectLabels()",
      PROJECT_LABELS_QUERY,
      {},
      (data) => data.projectLabels,
    );
  }

  /** Every workspace `ProjectLabel`, canonical colon-form ids reconstructed the same way `labels()` does for issue labels. */
  async projectLabels(): Promise<IssueLabel[]> {
    return this.mapLabels(await this.fetchRawProjectLabels());
  }

  private async createProjectLabel(input: {
    name: string;
    isGroup?: boolean;
    parentId?: LinearId;
    color?: string;
    description?: string;
  }): Promise<IssueLabel> {
    const data = await this.request<{
      projectLabelCreate: { success: boolean; projectLabel: { id: string; name: string; parent: { id: string } | null } | null };
    }>(PROJECT_LABEL_CREATE_MUTATION, { input });
    if (!data.projectLabelCreate.success || !data.projectLabelCreate.projectLabel) {
      throw new LinearApiError(`Failed to create project label "${input.name}"`, null, null);
    }
    const label = data.projectLabelCreate.projectLabel;
    return { id: label.id, name: label.name, parentId: label.parent?.id ?? null };
  }

  /** Workspace-level project label; creates the parent group on demand, mirroring `ensureWorkspaceLabel`. */
  async ensureProjectLabel(name: string, opts?: { color?: string; description?: string }): Promise<IssueLabel> {
    return this.ensureLabelUsing({
      name,
      scope: "project",
      opts,
      idCache: this.projectLabelIdCache,
      groupIdCache: this.projectLabelGroupIdCache,
      fetchRaw: () => this.fetchRawProjectLabels(),
      create: (input) => this.createProjectLabel(input),
      ambiguousMessage: (count) => `Project label "${name}" matches ${count} labels; cannot resolve unambiguously.`,
    });
  }

  async createWorkflowState(input: {
    teamId: LinearId;
    name: string;
    type: string;
    color: string;
    description?: string;
    position?: number;
  }): Promise<WorkflowState> {
    const data = await this.request<{
      workflowStateCreate: {
        success: boolean;
        workflowState: { id: string; name: string; type: string; position: number } | null;
      };
    }>(WORKFLOW_STATE_CREATE_MUTATION, { input });
    if (!data.workflowStateCreate.success || !data.workflowStateCreate.workflowState) {
      throw new LinearApiError(`Failed to create workflow state "${input.name}"`, null, null);
    }
    const state = data.workflowStateCreate.workflowState;
    return { id: state.id, name: state.name, type: state.type as WorkflowState["type"], position: state.position };
  }

  async updateWorkflowState(
    id: LinearId,
    input: { name?: string; color?: string; description?: string; position?: number },
  ): Promise<WorkflowState> {
    const data = await this.request<{
      workflowStateUpdate: {
        success: boolean;
        workflowState: { id: string; name: string; type: string; position: number } | null;
      };
    }>(WORKFLOW_STATE_UPDATE_MUTATION, { id, input });
    if (!data.workflowStateUpdate.success || !data.workflowStateUpdate.workflowState) {
      throw new LinearApiError(`Failed to update workflow state ${id}`, null, null);
    }
    const state = data.workflowStateUpdate.workflowState;
    return { id: state.id, name: state.name, type: state.type as WorkflowState["type"], position: state.position };
  }

  async archiveWorkflowState(id: LinearId): Promise<void> {
    const data = await this.request<{ workflowStateArchive: { success: boolean } }>(WORKFLOW_STATE_ARCHIVE_MUTATION, {
      id,
    });
    if (!data.workflowStateArchive.success) {
      throw new LinearApiError(`Failed to archive workflow state ${id}`, null, null);
    }
  }

  async teamSettings(teamId: string): Promise<TeamSettings> {
    const data = await this.request<{
      team: {
        id: string;
        key: string;
        name: string;
        triageEnabled: boolean;
        cyclesEnabled: boolean;
        triageIssueState: { id: string } | null;
      } | null;
    }>(TEAM_SETTINGS_QUERY, { teamId });
    if (!data.team) {
      throw new LinearApiError(`Team ${teamId} not found`, null, null);
    }
    return {
      id: data.team.id,
      key: data.team.key,
      name: data.team.name,
      triageEnabled: data.team.triageEnabled,
      cyclesEnabled: data.team.cyclesEnabled,
      triageStateId: data.team.triageIssueState?.id ?? null,
    };
  }

  async updateTeamSettings(
    teamId: LinearId,
    input: { triageEnabled?: boolean; cyclesEnabled?: boolean },
  ): Promise<void> {
    const data = await this.request<{ teamUpdate: { success: boolean } }>(TEAM_UPDATE_MUTATION, {
      id: teamId,
      input,
    });
    if (!data.teamUpdate.success) {
      throw new LinearApiError(`Failed to update team ${teamId} settings`, null, null);
    }
  }

  /** Seeds a team-scoped document (only `provisionTeam`'s Context-doc seed calls this — SPEC §4.7). */
  async createDocument(input: { teamId: LinearId; title: string; content: string }): Promise<LinearDocument> {
    const data = await this.request<{
      documentCreate: { success: boolean; document: LinearDocument | null };
    }>(DOCUMENT_CREATE_MUTATION, { input });
    if (!data.documentCreate.success || !data.documentCreate.document) {
      throw new LinearApiError(`Failed to create document "${input.title}"`, null, null);
    }
    // The team's document list is TTL-cached by key; a `doctor --fix` that
    // just seeded the doc must not keep serving the stale empty list for
    // up to `CACHE_TTL_MS` (SPEC §4.7's degradation is exactly this).
    const { key } = await this.teamSettings(input.teamId);
    this.teamDocumentsCache.delete(key);
    return data.documentCreate.document;
  }

  /** Updates the product `Context` doc (SPEC §4.7); the caller carries the live Definition-of-Done section through verbatim. */
  async updateDocument(input: { documentId: LinearId; content: string }): Promise<void> {
    const data = await this.request<{ documentUpdate: { success: boolean } }>(DOCUMENT_UPDATE_MUTATION, {
      id: input.documentId,
      input: { content: input.content },
    });
    if (!data.documentUpdate.success) {
      throw new LinearApiError(`Failed to update document ${input.documentId}`, null, null);
    }
    // Same cache-invalidation rationale as `createDocument`: a doctor or
    // dispatch reading right after an update must not see the stale body
    // for up to `CACHE_TTL_MS` (SPEC §4.7).
    for (const [key, cached] of this.teamDocumentsCache) {
      if (cached.value.some((doc) => doc.id === input.documentId)) {
        this.teamDocumentsCache.delete(key);
      }
    }
  }
}
