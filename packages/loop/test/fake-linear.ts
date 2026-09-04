import type {
  Comment,
  CreateIssueInput,
  Initiative,
  InitiativeRef,
  Issue,
  IssueFilter,
  IssueLabel,
  IssueMutation,
  IssueQuery,
  IssueRelationType,
  LinearId,
  LinearWriter,
  Project,
  ProjectRef,
  ProjectRelation,
  ProjectStatus,
  ProjectStatusType,
  TeamRef,
  TeamSettings,
  WorkflowState,
} from "@foreman/core";

/**
 * Evaluates the `IssueFilter` shapes `filters.ts` actually produces —
 * `and`/`or`, `state.name`/`state.type` (`eq`/`nin`), `labels.some`/`none`
 * (matched against this fake's labels, which carry a Linear-shaped
 * `name`/`parentId` pair the same way `filter()` did for the tests seeding
 * them), `assignee` (`null`/`id.eq`), `priority` (`eq`/`neq`), and
 * `project` (`null`/`status.type.nin`/`status.type.neq`) — good enough to
 * keep each invariant's `select` seeing only the issues a real server-side
 * filter would return. An unrecognized key throws rather than silently
 * matching everything, so a filter this fake does not yet understand fails
 * the test that exercises it instead of passing it vacuously.
 */
function matchesFilter(issue: Issue, filter: IssueFilter): boolean {
  const asRecord = filter as Record<string, unknown>;
  for (const key of Object.keys(asRecord)) {
    if (!["and", "or", "state", "labels", "assignee", "priority", "project"].includes(key)) {
      throw new Error(`fake-linear: unhandled filter key "${key}"`);
    }
  }

  if (Array.isArray(asRecord.and)) return (asRecord.and as IssueFilter[]).every((sub) => matchesFilter(issue, sub));
  if (Array.isArray(asRecord.or)) return (asRecord.or as IssueFilter[]).some((sub) => matchesFilter(issue, sub));

  const state = asRecord.state as Record<string, Record<string, unknown>> | undefined;
  if (state?.name?.eq !== undefined && issue.state.name !== state.name.eq) return false;
  if (state?.type?.eq !== undefined && issue.state.type !== state.type.eq) return false;
  if (Array.isArray(state?.type?.nin) && (state.type.nin as string[]).includes(issue.state.type)) return false;

  const labels = asRecord.labels as { some?: Record<string, unknown>; none?: Record<string, unknown> } | undefined;
  if (labels?.some && !issue.labels.some((label) => labelMatches(label, labels.some!))) return false;
  if (labels?.none && issue.labels.some((label) => labelMatches(label, labels.none!))) return false;

  const assignee = asRecord.assignee as { null?: boolean; id?: { eq?: string } } | undefined;
  if (assignee?.null !== undefined && (issue.assignee === null) !== assignee.null) return false;
  if (assignee?.id?.eq !== undefined && issue.assignee?.id !== assignee.id.eq) return false;

  const priority = asRecord.priority as { eq?: number; neq?: number } | undefined;
  if (priority?.eq !== undefined && issue.priority !== priority.eq) return false;
  if (priority?.neq !== undefined && issue.priority === priority.neq) return false;

  const project = asRecord.project as { null?: boolean; status?: { type?: { nin?: string[]; neq?: string } } } | undefined;
  if (project?.null !== undefined && (issue.project === null) !== project.null) return false;
  if (Array.isArray(project?.status?.type?.nin) && issue.project?.status?.type !== undefined) {
    if ((project.status.type.nin as string[]).includes(issue.project.status.type)) return false;
  }
  if (project?.status?.type?.neq !== undefined && issue.project?.status?.type === project.status.type.neq) return false;

  return true;
}

function labelMatches(label: IssueLabel, match: Record<string, unknown>): boolean {
  const idEq = match.id as Record<string, unknown> | undefined;
  const nameEq = match.name as Record<string, unknown> | undefined;
  if (idEq?.eq !== undefined) return label.id === idEq.eq;
  if (nameEq?.eq !== undefined) return label.name === nameEq.eq;
  return false;
}

/**
 * Minimal in-memory `LinearWriter` for `reconcile.test.ts`. `issues()`
 * filters the seeded set through `matchesFilter`; every other read/write
 * method returns a fixture shape or throws `not implemented` when no test
 * exercises it, matching the interface's full surface (SPEC §4 team-per-repo
 * scope).
 */
export class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
  workflowStatesList: WorkflowState[];
  projectsList: ProjectRef[];

  constructor(issues: Issue[] = [], workflowStates?: WorkflowState[], projects: ProjectRef[] = []) {
    for (const issue of issues) this.issuesById.set(issue.id, issue);
    this.workflowStatesList = workflowStates ?? [
      { id: "state-backlog", name: "Backlog", type: "backlog", position: 0 },
      { id: "state-refining", name: "Refining", type: "unstarted", position: 1 },
      { id: "state-needs-input", name: "Needs Input", type: "unstarted", position: 2 },
      { id: "state-ready", name: "Ready", type: "unstarted", position: 3 },
      { id: "state-blocked", name: "Blocked", type: "started", position: 4 },
      { id: "state-in-progress", name: "In Progress", type: "started", position: 5 },
      { id: "state-in-review", name: "In Review", type: "started", position: 6 },
      { id: "state-done", name: "Done", type: "completed", position: 7 },
      { id: "state-canceled", name: "Canceled", type: "canceled", position: 8 },
      { id: "state-duplicate", name: "Duplicate", type: "canceled", position: 9 },
    ];
    this.projectsList = projects;
  }

  async issue(id: string): Promise<Issue | null> {
    return this.issuesById.get(id) ?? [...this.issuesById.values()].find((issue) => issue.identifier === id) ?? null;
  }

  async issues(query: IssueQuery): Promise<Issue[]> {
    const all = [...this.issuesById.values()];
    return query.filter ? all.filter((issue) => matchesFilter(issue, query.filter!)) : all;
  }

  async comments(issueId: string): Promise<Comment[]> {
    return this.issuesById.get(issueId)?.comments ?? [];
  }

  async project(): Promise<Project | null> {
    return null;
  }

  async projectInitiatives(): Promise<InitiativeRef[]> {
    return [];
  }

  async initiative(id: string): Promise<Initiative | null> {
    return { id, name: "Initiative", documents: [] };
  }

  async projectStatus(_projectId?: string): Promise<ProjectStatus | null> {
    return null;
  }

  async projectRelations(_projectId?: string): Promise<ProjectRelation[]> {
    return [];
  }

  async workflowStates(): Promise<WorkflowState[]> {
    return this.workflowStatesList;
  }

  async labels(): Promise<IssueLabel[]> {
    return [];
  }

  /** Defaults to one team keyed "ENG" so tests can resolve `entry.team` without every call site wiring a team fixture. */
  async teams(): Promise<TeamRef[]> {
    return [{ id: "team-1", key: "ENG", name: "Engineering" }];
  }

  async projects(_teamKey: string): Promise<ProjectRef[]> {
    return this.projectsList;
  }

  async teamSettings(teamId: string): Promise<TeamSettings> {
    return { id: teamId, key: "ENG", name: "Engineering", triageEnabled: true, cyclesEnabled: false, triageStateId: null };
  }

  async projectLabels(): Promise<IssueLabel[]> {
    return [];
  }

  async viewerId(): Promise<string> {
    return "viewer-1";
  }

  async userByEmail(): Promise<never> {
    throw new Error("not implemented");
  }

  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = this.issuesById.get(id);
    if (!issue) throw new Error(`unknown issue id ${id}`);
    if (input.stateId) {
      const target = this.workflowStatesList.find((state) => state.id === input.stateId);
      if (target) issue.state = target;
    }
    if (input.removedLabelIds) {
      issue.labels = issue.labels.filter((label) => !input.removedLabelIds!.includes(label.id));
    }
    if (input.addedLabelIds) {
      for (const labelId of input.addedLabelIds) {
        if (!issue.labels.some((label) => label.id === labelId)) issue.labels.push({ id: labelId, name: labelId, parentId: null });
      }
    }
    if (input.assigneeId !== undefined) {
      issue.assignee = input.assigneeId === null ? null : { id: input.assigneeId, name: input.assigneeId, displayName: null };
    }
    return issue;
  }

  async createIssue(): Promise<Issue> {
    throw new Error("not implemented");
  }

  async createProject(): Promise<ProjectRef> {
    throw new Error("not implemented");
  }

  async updateProjectStatus(): Promise<void> {
    throw new Error("not implemented");
  }

  async createComment(input: { issueId: string; body: string; parentId?: LinearId }): Promise<Comment> {
    this.commentCalls.push({ issueId: input.issueId, body: input.body });
    const comment: Comment = {
      id: `comment-${this.commentCalls.length}`,
      body: input.body,
      createdAt: new Date().toISOString(),
      user: { id: "viewer-1", name: "viewer-1", displayName: "viewer-1" },
      parentId: input.parentId ?? null,
    };
    const issue = this.issuesById.get(input.issueId);
    if (issue) issue.comments = [...issue.comments, comment];
    return comment;
  }

  async createRelation(): Promise<void> {
    throw new Error("not implemented");
  }


  async createProjectRelation(): Promise<void> {
    throw new Error("not implemented");
  }


  async createLabel(): Promise<IssueLabel> {
    throw new Error("not implemented");
  }

  async ensureLabel(name: string): Promise<IssueLabel> {
    return { id: name, name, parentId: null };
  }

  async ensureWorkspaceLabel(name: string): Promise<IssueLabel> {
    return { id: name, name, parentId: null };
  }

  async ensureProjectLabel(name: string): Promise<IssueLabel> {
    return { id: name, name, parentId: null };
  }

  async createWorkflowState(input: { teamId: LinearId; name: string; type: string; color: string; description?: string; position?: number }): Promise<WorkflowState> {
    throw new Error(`not implemented: createWorkflowState(${input.name})`);
  }

  async updateWorkflowState(): Promise<WorkflowState> {
    throw new Error("not implemented");
  }

  async archiveWorkflowState(): Promise<void> {
    throw new Error("not implemented");
  }

  async updateTeamSettings(): Promise<void> {
    throw new Error("not implemented");
  }
}

export type { IssueFilter, IssueRelationType, CreateIssueInput, ProjectStatusType };
