import { describe, expect, it, spyOn } from "bun:test";
import { LinearClient } from "../src/linear/client.ts";
import { describeLinearError, LinearApiError, type FetchLike } from "../src/linear/api.ts";
import {
  INBOX_FILTER,
  NEEDS_INPUT_FILTER,
  RUNNING_FILTER,
  all,
  inState,
  inStateType,
  notInPausedProject,
  notInTerminalProject,
  notTerminalState,
  parseIdentifiers,
  withIdentifiers,
} from "../src/linear/filters.ts";
import { FOREMAN_STATE, isPausedProjectStatus, isTerminal, isTerminalProjectStatus } from "../src/domain/states.ts";
import {
  acceptanceCriteria,
  hasAcceptanceCriteria,
  incompleteBlockers,
} from "../src/linear/issue.ts";
import {
  blockingProjectRelations,
  incompleteProjectBlockers,
  latestTargetDate,
} from "../src/linear/project.ts";
import type {
  Issue,
  ProjectRelation,
  ProjectRelationAnchor,
  ProjectStatusType,
} from "../src/linear/types.ts";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const WIRE_STATE = { id: "state-1", name: "Todo", type: "unstarted" };

function wireIssueRef(id: string, stateType = "started") {
  return { id, identifier: `ENG-${id}`, title: `Issue ${id}`, state: { id: `s-${id}`, name: stateType, type: stateType } };
}

function baseWireIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test issue",
    description: null,
    priority: 1,
    estimate: 2,
    url: "https://linear.app/x/issue/ENG-1",
    branchName: "eng-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    state: WIRE_STATE,
    labels: { nodes: [] },
    project: null,
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    assignee: null,
    parent: null,
    children: { nodes: [] },
    relations: { nodes: [] },
    ...overrides,
  };
}

describe("LinearClient auth", () => {
  it("sends the bare API key with no Bearer prefix", async () => {
    let capturedAuth: string | undefined;
    const fetchStub: FetchLike = async (_url, init) => {
      capturedAuth = init.headers.Authorization;
      return jsonResponse(200, { data: { issue: null } });
    };
    const client = new LinearClient({ apiKey: "lin_api_secret", fetch: fetchStub });
    await client.issue("ENG-1");
    expect(capturedAuth).toBe("lin_api_secret");
  });
});

describe("LinearClient workflowStates", () => {
  // Linear's `Team` has `states`, not `workflowStates`. Asking for the latter
  // makes the API reject the whole document with a 400, so every
  // `moveToState` - refine to Todo, review back to Todo - failed outright.
  // The query text is the contract here, which is why it is asserted.
  it("reads the team's states connection, the field Linear actually exposes", async () => {
    let document = "";
    const fetchStub: FetchLike = async (_url, init) => {
      document = JSON.parse(String(init.body)).query;
      return jsonResponse(200, {
        data: {
          team: {
            states: {
              nodes: [
                { id: "s-backlog", name: "Backlog", type: "backlog", position: 1 },
                { id: "s-todo", name: "Todo", type: "unstarted", position: 2 },
              ],
            },
          },
        },
      });
    };
    const client = new LinearClient({ apiKey: "k", fetch: fetchStub });
    const states = await client.workflowStates("team-1");

    expect(document).toContain("states {");
    expect(document).not.toContain("workflowStates {");
    expect(states.map((state) => state.name)).toEqual(["Backlog", "Todo"]);
    expect(states[0]?.type).toBe("backlog");
  });
});

describe("LinearClient projects", () => {
  it("maps a team's projects connection into ProjectRef[]", async () => {
    let capturedBody: { query: string; variables: Record<string, unknown> } | undefined;
    const fetchStub: FetchLike = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse(200, {
        data: {
          projects: {
            nodes: [
              { id: "p1", name: "Plotroom" },
              { id: "p2", name: "Herdr" },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    };
    const client = new LinearClient({ apiKey: "lin_api_secret", fetch: fetchStub });
    expect(await client.projects("ENG")).toEqual([
      { id: "p1", name: "Plotroom", startDate: undefined, targetDate: undefined, status: null },
      { id: "p2", name: "Herdr", startDate: undefined, targetDate: undefined, status: null },
    ]);
    expect(capturedBody?.variables).toMatchObject({ teamKey: "ENG" });
  });
});

describe("LinearClient teamDocuments", () => {
  it("maps the wire rows into LinearDocument[]", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, {
        data: {
          documents: {
            nodes: [{ id: "doc-1", title: "Context", content: "product context", updatedAt: "2026-09-01T00:00:00Z" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    expect(await client.teamDocuments("PLT")).toEqual([
      { id: "doc-1", title: "Context", content: "product context", updatedAt: "2026-09-01T00:00:00Z" },
    ]);
  });

  it("filters by team key", async () => {
    let filter: unknown;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { variables: { filter?: unknown } };
      filter = body.variables.filter;
      return jsonResponse(200, {
        data: { documents: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await client.teamDocuments("PLT");

    expect(filter).toEqual({ team: { key: { eq: "PLT" } } });
  });

  it("returns [] when the team has no documents", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, {
        data: { documents: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    expect(await client.teamDocuments("PLT")).toEqual([]);
  });

  it("serves the second call from the TTL cache", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, {
        data: { documents: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await client.teamDocuments("PLT");
    await client.teamDocuments("PLT");

    expect(calls).toBe(1);
  });

  it("posts DocumentCreate with teamId, title, content and maps the response into a LinearDocument", async () => {
    let variables: unknown;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
      if (body.query.includes("DocumentCreate")) {
        variables = body.variables;
        return jsonResponse(200, {
          data: {
            documentCreate: {
              success: true,
              document: { id: "doc-2", title: "Context", content: "seed body", updatedAt: "2026-09-01T00:00:00Z" },
            },
          },
        });
      }
      return jsonResponse(200, {
        data: { team: { id: "team-1", key: "PLT", name: "Platform", triageEnabled: true, cyclesEnabled: false, triageIssueState: null } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    const created = await client.createDocument({ teamId: "team-1", title: "Context", content: "seed body" });

    expect(variables).toEqual({ input: { teamId: "team-1", title: "Context", content: "seed body" } });
    expect(created).toEqual({ id: "doc-2", title: "Context", content: "seed body", updatedAt: "2026-09-01T00:00:00Z" });
  });

  it("re-fetches teamDocuments after createDocument instead of serving the pre-create cached list", async () => {
    let documentsCalls = 0;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("TeamDocuments")) {
        documentsCalls += 1;
        return jsonResponse(200, {
          data: { documents: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      if (body.query.includes("DocumentCreate")) {
        return jsonResponse(200, {
          data: {
            documentCreate: {
              success: true,
              document: { id: "doc-3", title: "Context", content: "seed body", updatedAt: "2026-09-01T00:00:00Z" },
            },
          },
        });
      }
      return jsonResponse(200, {
        data: { team: { id: "team-1", key: "PLT", name: "Platform", triageEnabled: true, cyclesEnabled: false, triageIssueState: null } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    await client.teamDocuments("PLT");
    await client.createDocument({ teamId: "team-1", title: "Context", content: "seed body" });
    await client.teamDocuments("PLT");

    expect(documentsCalls).toBe(2);
  });

  it("posts DocumentUpdate with id and content", async () => {
    let variables: unknown;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
      if (body.query.includes("DocumentUpdate")) {
        variables = body.variables;
        return jsonResponse(200, { data: { documentUpdate: { success: true } } });
      }
      return jsonResponse(200, { data: {} });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    await client.updateDocument({ documentId: "doc-3", content: "revised body" });

    expect(variables).toEqual({ id: "doc-3", input: { content: "revised body" } });
  });

  it("re-fetches teamDocuments after updateDocument instead of serving the pre-update cached body", async () => {
    let documentsCalls = 0;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("TeamDocuments")) {
        documentsCalls += 1;
        return jsonResponse(200, {
          data: {
            documents: {
              nodes: [{ id: "doc-3", title: "Context", content: "stale body", updatedAt: "2026-09-01T00:00:00Z" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (body.query.includes("DocumentUpdate")) {
        return jsonResponse(200, { data: { documentUpdate: { success: true } } });
      }
      return jsonResponse(200, { data: {} });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    await client.teamDocuments("PLT");
    await client.updateDocument({ documentId: "doc-3", content: "revised body" });
    await client.teamDocuments("PLT");

    expect(documentsCalls).toBe(2);
  });
});

describe("LinearClient errors", () => {
  it("throws LinearApiError carrying joined GraphQL error messages", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, { data: null, errors: [{ message: "Entity not found" }, { message: "Bad input" }] });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(client.issue("ENG-1")).rejects.toThrow(LinearApiError);
    try {
      await client.issue("ENG-1");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(LinearApiError);
      expect((error as LinearApiError).message).toBe("Entity not found; Bad input");
    }
  });
});

describe("describeLinearError", () => {
  it("names a 401 without dumping the GraphQL envelope", () => {
    const body = JSON.stringify({
      errors: [
        {
          message: "Authentication required, not authenticated",
          extensions: {
            type: "authentication error",
            code: "AUTHENTICATION_ERROR",
            statusCode: 401,
            userPresentableMessage: "You need to authenticate to access this operation.",
          },
        },
      ],
    });
    const error = new LinearApiError(`Linear API request failed with status 401: ${body}`, 401, body);

    const message = describeLinearError(error);

    expect(message).toBe("Linear rejected the API key (HTTP 401). Run `foreman setup` and paste a current key.");
    expect(message).not.toContain("{");
  });

  it("names a 500 as unavailable rather than surfacing the body", () => {
    const error = new LinearApiError("Linear API request failed with status 500: oops", 500, "oops");
    expect(describeLinearError(error)).toBe("Linear is unavailable (HTTP 500). Try again shortly.");
  });

  it("falls back to the plain message for a non-Linear error", () => {
    expect(describeLinearError(new Error("boom"))).toBe("boom");
  });
});

describe("LinearClient mutation payload guards", () => {
  it("names the operation when updateIssue returns no issue", async () => {
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { issueUpdate: { issue: null } } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(client.updateIssue("issue-1", { title: "Updated" })).rejects.toThrow(
      /Failed to update issue issue-1/,
    );
  });

  it("names the operation when createIssue returns no issue", async () => {
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { issueCreate: { issue: null } } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(client.createIssue({ title: "New issue", teamId: "team-1" })).rejects.toThrow(
      /Failed to create issue "New issue"/,
    );
  });

  it("rejects relation mutations when Linear reports failure", async () => {
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { issueRelationCreate: { success: false } } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(
      client.createRelation({ issueId: "issue-1", relatedIssueId: "issue-2", type: "blocks" }),
    ).rejects.toThrow(LinearApiError);
  });
});

describe("LinearClient retry", () => {
  it("retries once after a 429 and succeeds", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, { errors: [{ message: "rate limited" }] }, { "Retry-After": "0" });
      }
      return jsonResponse(200, { data: { issue: baseWireIssue() } });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const issue = await client.issue("ENG-1");
    expect(calls).toBe(2);
    expect(issue?.identifier).toBe("ENG-1");
  });

  it("attempts a mutation exactly once when the response is a retryable status", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async () => {
      calls += 1;
      return jsonResponse(500, { errors: [{ message: "internal error" }] });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(
      client.createRelation({ issueId: "issue-1", relatedIssueId: "issue-2", type: "blocks" }),
    ).rejects.toThrow(LinearApiError);
    expect(calls).toBe(1);
  });

  it("honours the request deadline during a transport-error retry sleep, not the full backoff delay", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async () => {
      calls += 1;
      const error = new TypeError("fetch failed");
      throw error;
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub, timeoutMs: 20 });
    const startedAt = Date.now();
    await expect(client.issue("ENG-1")).rejects.toThrow(/timed out/);
    // The transport-error retry backs off 500ms on the first attempt; the
    // 20ms deadline must cut that sleep short rather than let it run to
    // completion, so the whole call resolves in well under 500ms.
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(calls).toBe(1);
  });
});

describe("LinearClient onRequest tracing", () => {
  it("fires with the operation name, attempt, and ok=true on success", async () => {
    const events: Array<{ operation: string; attempt: number; ok: boolean; status: number | null }> = [];
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { issue: baseWireIssue() } });
    const client = new LinearClient({
      apiKey: "key",
      fetch: fetchStub,
      onRequest: (event) => events.push(event),
    });
    await client.issue("ENG-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "IssueByIdentifier", attempt: 0, ok: true, status: 200 });
  });

  it("fires once per attempt, including retries, with the retryable status and an error message", async () => {
    const events: Array<{ operation: string; attempt: number; ok: boolean; status: number | null; error?: string }> = [];
    let calls = 0;
    const fetchStub: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, { errors: [{ message: "rate limited" }] }, { "Retry-After": "0" });
      }
      return jsonResponse(200, { data: { issue: baseWireIssue() } });
    };
    const client = new LinearClient({
      apiKey: "key",
      fetch: fetchStub,
      onRequest: (event) => events.push(event),
    });
    await client.issue("ENG-1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ operation: "IssueByIdentifier", attempt: 0, ok: false, status: 429 });
    expect(events[0]?.error).toBeDefined();
    expect(events[1]).toMatchObject({ operation: "IssueByIdentifier", attempt: 1, ok: true, status: 200 });
  });

  it("fires with ok=false and the GraphQL error message on a terminal failure", async () => {
    const events: Array<{ ok: boolean; error?: string }> = [];
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: null, errors: [{ message: "Entity not found" }] });
    const client = new LinearClient({
      apiKey: "key",
      fetch: fetchStub,
      onRequest: (event) => events.push(event),
    });
    await expect(client.issue("ENG-1")).rejects.toThrow(LinearApiError);
    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(false);
    expect(events[0]?.error).toBe("Entity not found");
  });
});

describe("LinearClient timeout", () => {
  it("rejects with LinearApiError when the request deadline elapses", async () => {
    const fetchStub: FetchLike = async (_url, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => {
        const abortError = new Error("The operation was aborted");
        abortError.name = "AbortError";
        reject(abortError);
      });
      return promise;
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub, timeoutMs: 5 });
    await expect(client.issue("ENG-1")).rejects.toThrow(/timed out/);
  });
});

describe("LinearClient pagination", () => {
  it("follows endCursor and stops at the requested limit", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body) as { variables: { after?: string; first?: number } };
      const page = body.variables.after ? "2" : "1";
      expect(body.variables.first).toBe(page === "1" ? 3 : 1);
      return jsonResponse(200, {
        data: {
          issues: {
            nodes: [
              baseWireIssue({ id: `issue-${page}-a`, identifier: `ENG-${page}a` }),
              baseWireIssue({ id: `issue-${page}-b`, identifier: `ENG-${page}b` }),
            ],
            pageInfo: { hasNextPage: page === "1", endCursor: page === "1" ? "cursor-2" : null },
          },
        },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const issues = await client.issues({ limit: 3 });
    expect(issues.length).toBe(3);
    expect(calls).toBe(2);
    expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1a", "ENG-1b", "ENG-2a"]);
  });

  it("pages all comments after the inline issue page is exhausted", async () => {
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { query: string; variables: { after?: string } };
      if (body.query.includes("query IssueByIdentifier")) {
        return jsonResponse(200, {
          data: {
            issue: baseWireIssue({
              comments: {
                nodes: [{ id: "comment-1", body: "first", createdAt: "2026-01-01T00:00:00Z", user: null, parent: null }],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            }),
          },
        });
      }
      expect(body.query).toContain("query IssueComments");
      expect(body.variables.after).toBe("cursor-1");
      return jsonResponse(200, {
        data: {
          issue: {
            comments: {
              nodes: [{ id: "comment-2", body: "second", createdAt: "2026-01-02T00:00:00Z", user: null, parent: null }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    const issue = await client.issue("ENG-1", { includeComments: true });

    expect(issue?.comments.map((comment) => comment.id)).toEqual(["comment-1", "comment-2"]);
  });

  it("throws LinearPaginationError when the page cap is exhausted with more pages remaining", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, {
        data: {
          issues: {
            nodes: [baseWireIssue({ id: `issue-${calls}`, identifier: `ENG-${calls}` })],
            pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` },
          },
        },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(client.issues({ limit: 10_000 })).rejects.toThrow(/refusing partial results/);
    expect(calls).toBeGreaterThanOrEqual(50);
  });
});

describe("LinearClient team scope", () => {
  /*
   * Asserted on the wire, not on a return value: the whole point of scoping in
   * the client is that eighteen call sites cannot forget it, and only the
   * outgoing `filter` variable proves it was applied.
   */
  const captureFilter = async (
    team: string | null | undefined,
    query: Parameters<LinearClient["issues"]>[0],
  ): Promise<unknown> => {
    let captured: unknown;
    const fetchStub: FetchLike = async (_url, init) => {
      // Our own outgoing request body, shaped by `request()` one call away.
      const body = JSON.parse(init.body) as { variables: { filter?: unknown } };
      captured = body.variables.filter;
      return jsonResponse(200, {
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub, team });
    await client.issues(query);
    return captured;
  };

  it("scopes an unfiltered read to the managed team", async () => {
    expect(await captureFilter("ENG", {})).toEqual({
      team: { key: { eq: "ENG" } },
    });
  });

  it("ANDs the scope onto a caller's filter instead of replacing it", async () => {
    expect(await captureFilter("ENG", { filter: inState("Todo") })).toEqual({
      and: [{ state: { name: { eq: "Todo" } } }, { team: { key: { eq: "ENG" } } }],
    });
  });

  it("leaves the filter untouched when no team is configured", async () => {
    expect(await captureFilter(null, { filter: inState("Todo") })).toEqual(inState("Todo"));
    expect(await captureFilter(undefined, {})).toBeUndefined();
  });
});

describe("terminal exclusion", () => {
  const TERMINAL_STATES = ["completed", "canceled", "duplicate"];
  const TERMINAL_PROJECT_STATUSES = ["completed", "canceled"];

  // The predicate every gate reads. `paused` is the interesting case: it is a
  // reversible operator hold, so treating it as terminal would make
  // un-pausing a project silently indistinguishable from abandoning it.
  it("counts completed and canceled as terminal, and nothing else", () => {
    expect(isTerminal({ type: "completed" })).toBe(true);
    expect(isTerminal({ type: "canceled" })).toBe(true);
    expect(isTerminal({ type: "started" })).toBe(false);
    expect(isTerminal({ type: "backlog" })).toBe(false);

    expect(isTerminalProjectStatus({ type: "completed" })).toBe(true);
    expect(isTerminalProjectStatus({ type: "canceled" })).toBe(true);
    expect(isTerminalProjectStatus({ type: "paused" })).toBe(false);
    expect(isTerminalProjectStatus({ type: "started" })).toBe(false);
  });

  // An unset status means the operator never picked one, which is the
  // opposite of a decision to stop — so it must not read as terminal.
  it("does not treat an absent project status as terminal", () => {
    expect(isTerminalProjectStatus(null)).toBe(false);
    expect(isTerminalProjectStatus(undefined)).toBe(false);
  });

  it("excludes terminal issues by state type", () => {
    expect(notTerminalState()).toEqual({ state: { type: { nin: TERMINAL_STATES } } });
  });

  // Project-less issues must survive: they are out of scope for a more
  // specific reason (`issueScope`'s `no-project`), and that is the verdict
  // the operator needs to see instead of the issue silently vanishing.
  it("excludes terminal projects while keeping project-less issues", () => {
    expect(notInTerminalProject()).toEqual({
      or: [{ project: { null: true } }, { project: { status: { type: { nin: TERMINAL_PROJECT_STATUSES } } } }],
    });
  });

  // The human queue's *count* is the loop's backpressure signal (SPEC
  // §17.7). A `Needs Input` state stranded on a canceled issue used to hold
  // every worker stopped forever, with no operator remedy.
  it("guards the needs-input view against a terminal project", () => {
    expect(NEEDS_INPUT_FILTER.and).toContainEqual(notInTerminalProject());
  });

  // A lock still held on an issue completed since it was taken is exactly
  // the stale lock the reaper exists to release (SPEC §11) — filtering it
  // out would strand the lock and hide it from the operator.
  it("leaves the running and inbox views unguarded on purpose", () => {
    expect(RUNNING_FILTER).toEqual({
      or: [inState(FOREMAN_STATE.refining), inState(FOREMAN_STATE.inProgress)],
    });
    expect(INBOX_FILTER).toEqual(inStateType("triage"));
  });
});

describe("paused hold", () => {
  // Narrower than terminal by design: a pause withholds the commitment a
  // refinement makes, and recalls nothing already committed (SPEC §4.2b).
  it("recognizes only paused, and never confuses it with terminal", () => {
    expect(isPausedProjectStatus({ type: "paused" })).toBe(true);
    expect(isPausedProjectStatus({ type: "completed" })).toBe(false);
    expect(isPausedProjectStatus({ type: "canceled" })).toBe(false);
    expect(isPausedProjectStatus({ type: "backlog" })).toBe(false);
    expect(isPausedProjectStatus({ type: "started" })).toBe(false);
    expect(isPausedProjectStatus(null)).toBe(false);
    expect(isPausedProjectStatus(undefined)).toBe(false);

    // The two predicates partition, rather than nest: neither implies the
    // other, so a paused project is held but not closed out.
    expect(isTerminalProjectStatus({ type: "paused" })).toBe(false);
  });

  it("excludes paused projects while keeping project-less issues", () => {
    expect(notInPausedProject()).toEqual({
      or: [{ project: { null: true } }, { project: { status: { type: { neq: "paused" } } } }],
    });
  });

  // The Ready buffer counts what implement will actually do, and implement
  // is not held by a pause — so a paused project's ready issues stay in the
  // count. Guarding it here would make refine chase a target it can never
  // reach, dispatching against projects it is allowed to touch forever.
  it("leaves the needs-input view unguarded against paused", () => {
    expect(NEEDS_INPUT_FILTER.and).not.toContainEqual(notInPausedProject());
  });
});

describe("identifier dispatch", () => {
  it("splits on a single space, the real dispatch shape", () => {
    expect(parseIdentifiers("PLT-183 PLT-143 PLT-142")).toEqual(["PLT-183", "PLT-143", "PLT-142"]);
  });

  it("splits on commas and comma-plus-space, tolerating runs of whitespace, tabs, and newlines", () => {
    expect(parseIdentifiers("PLT-183,PLT-143, PLT-142")).toEqual(["PLT-183", "PLT-143", "PLT-142"]);
    expect(parseIdentifiers("PLT-183,\t PLT-143\n\nPLT-142")).toEqual(["PLT-183", "PLT-143", "PLT-142"]);
  });

  // This boundary decides whether a malformed id list errors out or, if a
  // future caller ever let it fall through to `issues` unfiltered, silently
  // dumps the whole team.
  it("drops empty segments from stray separators and returns [] for blank input", () => {
    expect(parseIdentifiers(" ,PLT-183,, PLT-143, ")).toEqual(["PLT-183", "PLT-143"]);
    expect(parseIdentifiers("")).toEqual([]);
    expect(parseIdentifiers("   \t\n  ")).toEqual([]);
  });

  it("removes duplicates while preserving first-seen order", () => {
    expect(parseIdentifiers("PLT-183 PLT-143 PLT-183 PLT-142 PLT-143")).toEqual(["PLT-183", "PLT-143", "PLT-142"]);
  });

  it("builds an id-in filter for one or many identifiers, preserving order", () => {
    expect(withIdentifiers(["PLT-183"])).toEqual({ id: { in: ["PLT-183"] } });
    expect(withIdentifiers(["PLT-183", "PLT-143", "PLT-142"])).toEqual({
      id: { in: ["PLT-183", "PLT-143", "PLT-142"] },
    });
  });

  it("composes with other filter builders under `all`", () => {
    expect(all(withIdentifiers(["PLT-183", "PLT-143"]), notTerminalState())).toEqual({
      and: [{ id: { in: ["PLT-183", "PLT-143"] } }, { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }],
    });
  });
});

describe("LinearClient relation normalization", () => {
  it("marks an edge this issue owns as outgoing with the related issue as other", async () => {
    const wire = baseWireIssue({
      relations: {
        nodes: [
          {
            id: "rel-1",
            type: "blocks",
            issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", state: WIRE_STATE },
            relatedIssue: wireIssueRef("2", "started"),
          },
        ],
      },
    });
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { issue: wire } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const issue = await client.issue("ENG-1");
    expect(issue?.relations[0]?.direction).toBe("outgoing");
    expect(issue?.relations[0]?.other.id).toBe("2");
  });

  it("marks an edge pointing at this issue as incoming with the owning issue as other", async () => {
    const wire = baseWireIssue({
      relations: { nodes: [] },
      inverseRelations: {
        nodes: [
          {
            id: "rel-2",
            type: "blocks",
            issue: wireIssueRef("3", "started"),
            relatedIssue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", state: WIRE_STATE },
          },
        ],
      },
    });
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { issue: wire } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const issue = await client.issue("ENG-1");
    expect(issue?.relations[0]?.direction).toBe("incoming");
    expect(issue?.relations[0]?.other.id).toBe("3");
  });

  it("de-duplicates a relation id present in both relations and inverseRelations, preferring the outgoing tag", async () => {
    const wire = baseWireIssue({
      relations: {
        nodes: [
          {
            id: "rel-3",
            type: "blocks",
            issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", state: WIRE_STATE },
            relatedIssue: wireIssueRef("4", "started"),
          },
        ],
      },
      inverseRelations: {
        nodes: [
          {
            id: "rel-3",
            type: "blocks",
            issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", state: WIRE_STATE },
            relatedIssue: wireIssueRef("4", "started"),
          },
        ],
      },
    });
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { issue: wire } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const issue = await client.issue("ENG-1");
    expect(issue?.relations).toHaveLength(1);
    expect(issue?.relations[0]?.direction).toBe("outgoing");
  });
});

describe("incompleteBlockers", () => {
  function issueWithBlocker(stateType: string): Issue {
    return {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test",
      description: null,
      priority: 1,
      estimate: 1,
      url: "https://x",
      branchName: "eng-1",
      createdAt: "",
      updatedAt: "",
      state: { id: "s", name: "Todo", type: "unstarted", position: 0 },
      labels: [],
      team: { id: "t", key: "ENG", name: "Engineering" },
      project: null,
      parent: null,
      children: [],
      assignee: null,
      relations: [
        {
          id: "rel-1",
          type: "blocks",
          direction: "incoming",
          other: {
            id: "blocker-1",
            identifier: "ENG-2",
            title: "Blocker",
            state: { id: "s2", name: "X", type: stateType as never },
          },
        },
      ],
      comments: [],
    };
  }

  it("excludes blockers in completed and canceled states", () => {
    expect(incompleteBlockers(issueWithBlocker("completed"))).toHaveLength(0);
    expect(incompleteBlockers(issueWithBlocker("canceled"))).toHaveLength(0);
  });

  it("includes blockers in started state", () => {
    expect(incompleteBlockers(issueWithBlocker("started"))).toHaveLength(1);
  });
});

describe("LinearClient project relation normalization", () => {
  function wireProjectRef(id: string, statusType: string, dates: { startDate?: string | null; targetDate?: string | null } = {}) {
    return {
      id,
      name: `Project ${id}`,
      startDate: dates.startDate ?? null,
      targetDate: dates.targetDate ?? null,
      status: { id: `ps-${id}`, name: statusType, type: statusType },
    };
  }

  function relationsResponse(
    outgoing: unknown[],
    incoming: unknown[],
  ): FetchLike {
    return async () =>
      jsonResponse(200, {
        data: {
          project: {
            id: "proj-1",
            relations: { nodes: outgoing },
            inverseRelations: { nodes: incoming },
          },
        },
      });
  }

  const DEPENDENCY = { type: "dependency", anchorType: "end", relatedAnchorType: "start" };

  it("keeps an outgoing edge's anchors as sent, with the related project as other", async () => {
    const client = new LinearClient({
      apiKey: "key",
      fetch: relationsResponse([{ id: "rel-1", ...DEPENDENCY, relatedProject: wireProjectRef("2", "backlog") }], []),
    });
    const [relation] = await client.projectRelations("proj-1");
    expect(relation?.direction).toBe("outgoing");
    expect(relation?.anchor).toBe("end");
    expect(relation?.otherAnchor).toBe("start");
    expect(relation?.other.id).toBe("2");
  });

  // The wire pair is relative to the row's own `project`, which is the far
  // side of an incoming edge. Without the swap, a blocker would read as a
  // blockee and `incompleteProjectBlockers` would gate the wrong project.
  it("swaps an incoming edge's anchors onto the queried project", async () => {
    const client = new LinearClient({
      apiKey: "key",
      fetch: relationsResponse([], [{ id: "rel-2", ...DEPENDENCY, project: wireProjectRef("3", "backlog") }]),
    });
    const [relation] = await client.projectRelations("proj-1");
    expect(relation?.direction).toBe("incoming");
    expect(relation?.anchor).toBe("start");
    expect(relation?.otherAnchor).toBe("end");
    expect(relation?.other.id).toBe("3");
  });

  it("de-duplicates a relation id present in both connections", async () => {
    const client = new LinearClient({
      apiKey: "key",
      fetch: relationsResponse(
        [{ id: "rel-3", ...DEPENDENCY, relatedProject: wireProjectRef("4", "backlog") }],
        [{ id: "rel-3", ...DEPENDENCY, project: wireProjectRef("4", "backlog") }],
      ),
    });
    const relations = await client.projectRelations("proj-1");
    expect(relations).toHaveLength(1);
    expect(relations[0]?.direction).toBe("outgoing");
  });

  it("returns no relations for a project that does not resolve", async () => {
    const fetchStub: FetchLike = async () => jsonResponse(200, { data: { project: null } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    expect(await client.projectRelations("missing")).toEqual([]);
  });
});

describe("incompleteProjectBlockers", () => {
  function blocker(statusType: ProjectStatusType, anchors: { anchor: ProjectRelationAnchor; otherAnchor: ProjectRelationAnchor }): ProjectRelation {
    return {
      id: "rel-1",
      type: "dependency",
      direction: "incoming",
      anchor: anchors.anchor,
      otherAnchor: anchors.otherAnchor,
      other: {
        id: "proj-2",
        name: "Blocker",
        status: { id: "ps-1", name: statusType, type: statusType },
      },
    };
  }

  const GATING = { anchor: "start", otherAnchor: "end" } as const;

  it("counts a blocker that has not shipped", () => {
    expect(incompleteProjectBlockers([blocker("backlog", GATING)])).toHaveLength(1);
    expect(incompleteProjectBlockers([blocker("started", GATING)])).toHaveLength(1);
    expect(incompleteProjectBlockers([blocker("paused", GATING)])).toHaveLength(1);
  });

  it("excludes a blocker that completed or was canceled", () => {
    expect(incompleteProjectBlockers([blocker("completed", GATING)])).toHaveLength(0);
    expect(incompleteProjectBlockers([blocker("canceled", GATING)])).toHaveLength(0);
  });

  // `start` -> `start` and `end` -> `end` are Linear's alignment edges: they
  // say two projects share a boundary, not that one waits on the other.
  it("ignores anchor pairs that are alignment rather than prerequisite", () => {
    expect(incompleteProjectBlockers([blocker("backlog", { anchor: "start", otherAnchor: "start" })])).toHaveLength(0);
    expect(incompleteProjectBlockers([blocker("backlog", { anchor: "end", otherAnchor: "end" })])).toHaveLength(0);
  });

  it("ignores an outgoing edge, which blocks the other project rather than this one", () => {
    const outgoing: ProjectRelation = { ...blocker("backlog", { anchor: "end", otherAnchor: "start" }), direction: "outgoing" };
    expect(incompleteProjectBlockers([outgoing])).toHaveLength(0);
    expect(blockingProjectRelations([outgoing])).toHaveLength(1);
  });

  it("treats a missing status as unresolved rather than assuming it shipped", () => {
    const noStatus: ProjectRelation = {
      ...blocker("backlog", GATING),
      other: { id: "proj-3", name: "Unknown" },
    };
    expect(incompleteProjectBlockers([noStatus])).toHaveLength(1);
  });
});

describe("latestTargetDate", () => {
  it("returns the last target date, ignoring projects without one", () => {
    expect(
      latestTargetDate([
        { id: "a", name: "A", targetDate: "2026-12-31" },
        { id: "b", name: "B", targetDate: null },
        { id: "c", name: "C", targetDate: "2027-06-30" },
      ]),
    ).toBe("2027-06-30");
  });

  it("returns null when no project carries a target date", () => {
    expect(latestTargetDate([{ id: "a", name: "A" }])).toBeNull();
  });
});

describe("LinearClient project documents", () => {
  // `Document.content` is a `String` in Linear's schema (introspection-
  // validated, docs/VERIFIED.md). An earlier version selected `content` as a
  // scalar, and on error retried with `content { body }` - a document the API
  // rejects too, so the retry could only ever turn one error into two. There
  // is one valid shape, and a content error is terminal.
  it("reads document content as a scalar string in one request", async () => {
    let calls = 0;
    let document = "";
    const fetchStub: FetchLike = async (_url, init) => {
      calls += 1;
      document = JSON.parse(String(init.body)).query;
      return jsonResponse(200, {
        data: {
          project: {
            id: "proj-1",
            name: "Project",
            description: null,
            content: "overview",
            startDate: "2026-09-01",
            targetDate: "2026-12-31",
            status: { id: "ps-1", name: "Backlog", type: "backlog" },
          },
        },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const project = await client.project("proj-1");

    expect(calls).toBe(1);
    expect(document).not.toContain("content {");
    expect(document).not.toContain("labels");
    expect(document).not.toContain("documents");
    expect(project?.content).toBe("overview");
    expect(project?.startDate).toBe("2026-09-01");
    expect(project?.status?.type).toBe("backlog");
  });

  it("propagates a content error instead of retrying an invalid selection", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, {
        data: null,
        errors: [{ message: "Field 'content' must have a selection of subfields" }],
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    await expect(client.project("proj-1")).rejects.toThrow("must have a selection of subfields");
    expect(calls).toBe(1);
  });
});

describe("LinearClient ensureLabel", () => {
  it("creates a group parent before a prefixed child and caches results", async () => {
    const createdLabels: Array<{ name: string; parentId?: string; isGroup?: boolean }> = [];
    let labelQueryCalls = 0;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { query: string; variables: { input?: { name: string; parentId?: string; isGroup?: boolean } } };
      if (body.query.includes("issueLabels")) {
        labelQueryCalls += 1;
        return jsonResponse(200, {
          data: { issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      if (body.query.includes("issueLabelCreate")) {
        const input = body.variables.input!;
        createdLabels.push(input);
        return jsonResponse(200, {
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: {
                id: `label-${createdLabels.length}`,
                name: input.name,
                parent: input.parentId ? { id: input.parentId } : null,
              },
            },
          },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const label = await client.ensureLabel("type:bug", "team-1");

    expect(createdLabels).toHaveLength(2);
    expect(createdLabels[0]).toMatchObject({ name: "Type", isGroup: true });
    expect(createdLabels[1]).toMatchObject({ name: "Bug", parentId: "label-1" });
    expect(label.name).toBe("type:bug");

    const cachedCallsBefore = labelQueryCalls;
    const cached = await client.ensureLabel("type:bug", "team-1");

    expect(labelQueryCalls).toBe(cachedCallsBefore);
    expect(cached).toEqual(label);
  });
  it("scopes matches to the requested team plus workspace-level labels", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, {
        data: {
          issueLabels: {
            nodes: [
              { id: "label-team-a", name: "Ready", isGroup: false, parent: null, team: { id: "team-a" } },
              { id: "label-team-b", name: "Ready-B", isGroup: false, parent: null, team: { id: "team-b" } },
              { id: "label-workspace", name: "Workspace", isGroup: false, parent: null, team: null },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const teamALabels = await client.labels("team-a");
    expect(teamALabels.map((label) => label.id).sort()).toEqual(["label-team-a", "label-workspace"]);
  });

  it("rejects an ambiguous match across a team-owned and a workspace-level label with the same name", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, {
        data: {
          issueLabels: {
            nodes: [
              { id: "label-1", name: "agent:ready", isGroup: false, parent: null, team: { id: "team-a" } },
              { id: "label-2", name: "agent:ready", isGroup: false, parent: null, team: null },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(client.ensureLabel("agent:ready", "team-a")).rejects.toThrow(/ambiguously/);
  });
});
describe("LinearClient workspace label pagination", () => {
  it("pages workspace labels before mapping them", async () => {
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { variables: { after?: string } };
      if (body.variables.after === undefined) {
        return jsonResponse(200, {
          data: {
            issueLabels: {
              nodes: [{ id: "label-1", name: "Bug", isGroup: false, parent: { id: "group-1", name: "Type" } }],
              pageInfo: { hasNextPage: true, endCursor: "labels-1" },
            },
          },
        });
      }
      expect(body.variables.after).toBe("labels-1");
      return jsonResponse(200, {
        data: {
          issueLabels: {
            nodes: [{ id: "label-2", name: "Feature", isGroup: false, parent: { id: "group-1", name: "Type" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    expect((await client.labels()).map((label) => label.name)).toEqual(["type:bug", "type:feature"]);
  });
});

describe("LinearClient teams pagination", () => {
  it("pages teams before returning them, concatenating both pages' nodes", async () => {
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { variables: { after?: string } };
      if (body.variables.after === undefined) {
        return jsonResponse(200, {
          data: { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: true, endCursor: "teams-1" } } },
        });
      }
      expect(body.variables.after).toBe("teams-1");
      return jsonResponse(200, {
        data: { teams: { nodes: [{ id: "team-2", key: "OPS", name: "Operations" }], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    expect(await client.teams()).toEqual([
      { id: "team-1", key: "ENG", name: "Engineering" },
      { id: "team-2", key: "OPS", name: "Operations" },
    ]);
  });
});

describe("LinearClient createProject", () => {
  it("sends teamIds and maps the created project into a ProjectRef", async () => {
    let capturedBody: { query: string; variables: Record<string, unknown> } | undefined;
    const fetchStub: FetchLike = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(200, {
        data: { projectCreate: { success: true, project: { id: "p1", name: "Maintenance" } } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const result = await client.createProject({ name: "Maintenance", teamIds: ["team-1"] });
    expect(result).toEqual({ id: "p1", name: "Maintenance" });
    expect(capturedBody?.query).toContain("mutation ProjectCreate");
    expect(capturedBody?.variables).toEqual({
      input: { name: "Maintenance", teamIds: ["team-1"] },
    });
  });

  it("throws when success is false", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, { data: { projectCreate: { success: false, project: null } } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(
      client.createProject({ name: "Maintenance", teamIds: ["team-1"] }),
    ).rejects.toThrow(LinearApiError);
  });

  it("throws when success is true but project is null", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, { data: { projectCreate: { success: true, project: null } } });
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    await expect(
      client.createProject({ name: "Maintenance", teamIds: ["team-1"] }),
    ).rejects.toThrow(/Failed to create project/);
  });
});

describe("LinearClient updateProjectStatus cache", () => {
  it("refetches the status id once the cached entry is past CACHE_TTL_MS", async () => {
    let statusQueryCalls = 0;
    const fetchStub: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { query: string };
      if (body.query.includes("mutation ProjectUpdate")) {
        return jsonResponse(200, { data: { projectUpdate: { success: true } } });
      }
      statusQueryCalls += 1;
      return jsonResponse(200, {
        data: { projectStatuses: { nodes: [{ id: `status-${statusQueryCalls}`, type: "started" }] } },
      });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });

    const nowSpy = spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(0);
      await client.updateProjectStatus({ projectId: "p1", type: "started" });
      expect(statusQueryCalls).toBe(1);

      // Within the TTL: the cached id is reused, no refetch.
      nowSpy.mockReturnValue(60_000);
      await client.updateProjectStatus({ projectId: "p1", type: "started" });
      expect(statusQueryCalls).toBe(1);

      // Past CACHE_TTL_MS (10 minutes): a workspace status recreated with a
      // new id must not keep serving the stale one.
      nowSpy.mockReturnValue(10 * 60_000 + 1);
      await client.updateProjectStatus({ projectId: "p1", type: "started" });
      expect(statusQueryCalls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
describe("acceptance criteria parsing", () => {

  it("returns no criteria when the description is missing entirely", () => {
    expect(hasAcceptanceCriteria(null)).toBe(false);
    expect(acceptanceCriteria(null)).toEqual([]);
  });

  it("returns no criteria when the section is absent", () => {
    const description = "## Summary\nSome text\n\n## Affected Areas\n- foo\n";
    expect(hasAcceptanceCriteria(description)).toBe(false);
  });

  it("parses both checked and unchecked boxes", () => {
    const description = [
      "## Acceptance Criteria",
      "- [ ] First behavior",
      "- [x] Second behavior",
      "",
      "## Affected Areas",
      "- some/path",
    ].join("\n");
    expect(acceptanceCriteria(description)).toEqual(["First behavior", "Second behavior"]);
    expect(hasAcceptanceCriteria(description)).toBe(true);
  });
});
