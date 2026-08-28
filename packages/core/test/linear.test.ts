import { describe, expect, it } from "bun:test";
import { LinearClient } from "../src/linear/client.ts";
import { LinearApiError, type FetchLike } from "../src/linear/api.ts";
import { inState } from "../src/linear/filters.ts";
import {
  acceptanceCriteria,
  hasAcceptanceCriteria,
  incompleteBlockers,
} from "../src/linear/issue.ts";
import type { Issue } from "../src/linear/types.ts";

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

describe("LinearClient projects", () => {
  it("maps the projects connection into ProjectRef[]", async () => {
    const fetchStub: FetchLike = async () =>
      jsonResponse(200, {
        data: { projects: { nodes: [{ id: "p1", name: "Plotroom" }, { id: "p2", name: "Herdr" }] } },
      });
    const client = new LinearClient({ apiKey: "lin_api_secret", fetch: fetchStub });
    expect(await client.projects()).toEqual([
      { id: "p1", name: "Plotroom" },
      { id: "p2", name: "Herdr" },
    ]);
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
});

describe("LinearClient pagination", () => {
  it("follows endCursor and stops at the requested limit", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body) as { variables: { after?: string } };
      const page = body.variables.after ? "2" : "1";
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
});

describe("LinearClient team scope", () => {
  /*
   * Asserted on the wire, not on a return value: the whole point of scoping in
   * the client is that eighteen call sites cannot forget it, and only the
   * outgoing `filter` variable proves it was applied.
   */
  const captureFilter = async (
    teamKeys: readonly string[] | undefined,
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
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub, teamKeys });
    await client.issues(query);
    return captured;
  };

  it("scopes an unfiltered read to the managed teams", async () => {
    expect(await captureFilter(["ENG", "PLT"], {})).toEqual({
      team: { key: { in: ["ENG", "PLT"] } },
    });
  });

  it("ANDs the scope onto a caller's filter instead of replacing it", async () => {
    expect(await captureFilter(["ENG"], { filter: inState("Todo") })).toEqual({
      and: [{ state: { name: { eq: "Todo" } } }, { team: { key: { in: ["ENG"] } } }],
    });
  });

  it("leaves the filter untouched when no teams are configured", async () => {
    expect(await captureFilter([], { filter: inState("Todo") })).toEqual(inState("Todo"));
    expect(await captureFilter(undefined, {})).toBeUndefined();
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
      relations: {
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

describe("LinearClient project document content fallback", () => {
  it("retries with the object content selection when the scalar selection errors", async () => {
    let calls = 0;
    const fetchStub: FetchLike = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body) as { query: string };
      if (body.query.includes("content {")) {
        return jsonResponse(200, {
          data: {
            project: {
              id: "proj-1",
              name: "Project",
              description: null,
              documents: {
                nodes: [{ id: "doc-1", title: "Context", content: { body: "hello" }, updatedAt: "" }],
              },
            },
          },
        });
      }
      return jsonResponse(200, { data: null, errors: [{ message: "Field 'content' must have a selection of subfields" }] });
    };
    const client = new LinearClient({ apiKey: "key", fetch: fetchStub });
    const project = await client.project("proj-1");
    expect(calls).toBe(2);
    expect(project?.documents[0]?.content).toBe("hello");

    calls = 0;
    const project2 = await client.project("proj-1");
    expect(calls).toBe(1);
    expect(project2?.documents[0]?.content).toBe("hello");
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
        return jsonResponse(200, { data: { issueLabels: { nodes: [] } } });
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
    expect(createdLabels[0]).toMatchObject({ name: "type", isGroup: true });
    expect(createdLabels[1]).toMatchObject({ name: "type:bug", parentId: "label-1" });
    expect(label.name).toBe("type:bug");

    const cachedCallsBefore = labelQueryCalls;
    await client.ensureLabel("type:bug", "team-1");
    expect(labelQueryCalls).toBe(cachedCallsBefore);
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
