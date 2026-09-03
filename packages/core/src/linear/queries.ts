/**
 * GraphQL documents for the Linear API (verified against `agent://LinearApiScout`).
 *
 * Kept as plain string constants rather than a codegen artifact: this client
 * has no build-time schema dependency, so the documents themselves are the
 * only source of truth for what fields the client relies on.
 */

/** Field selection shared by every query that returns a full `Issue`. */
const ISSUE_FIELDS = `
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

const ISSUE_FIELDS_WITH_COMMENTS = `${ISSUE_FIELDS}
  comments(first: 100) {
    nodes { id body createdAt user { id name displayName } parent { id } }
    pageInfo { hasNextPage endCursor }
  }
`;

export function issueQueryFields(includeComments: boolean): string {
  return includeComments ? ISSUE_FIELDS_WITH_COMMENTS : ISSUE_FIELDS;
}

export const ISSUE_BY_ID_QUERY = (includeComments: boolean): string => `
  query IssueByIdentifier($id: String!) {
    issue(id: $id) {
      ${issueQueryFields(includeComments)}
    }
  }
`;

export const ISSUES_QUERY = (includeComments: boolean): string => `
  query Issues($filter: IssueFilter, $after: String, $first: Int) {
    issues(filter: $filter, after: $after, first: $first) {
      nodes {
        ${issueQueryFields(includeComments)}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const COMMENTS_QUERY = `
  query IssueComments($issueId: String!, $after: String, $first: Int) {
    issue(id: $issueId) {
      comments(first: $first, after: $after) {
        nodes { id body createdAt user { id name displayName } parent { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/**
 * Project overview plus its documents. `content` is a `String` on both
 * (schema-validated). Dates are `TimelessDate` (`YYYY-MM-DD`) — read for the
 * roadmap surface, never gated on.
 */
export const PROJECT_QUERY_SCALAR_CONTENT = `
  query ProjectDocuments($projectId: String!) {
    project(id: $projectId) {
      id
      name
      description
      content
      startDate
      targetDate
      status { id name type }
      documents {
        nodes { id title content updatedAt }
      }
    }
  }
`;

/** A project's initiatives — used to resolve the single initiative a project must belong to. */
export const PROJECT_INITIATIVES_QUERY = `
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

/** Initiative documents. `content` is a `String` (schema-validated). */
export const INITIATIVE_QUERY_SCALAR_CONTENT = `
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

/**
 * `Team.states`, not `Team.workflowStates`: the latter does not exist on
 * Linear's `Team` and the API rejects the whole document with a 400
 * (`Cannot query field "workflowStates" on type "Team"`). Measured against
 * the live API - every `moveToState` call failed until this was corrected.
 */
export const WORKFLOW_STATES_QUERY = `
  query TeamWorkflowStates($teamId: String!) {
    team(id: $teamId) {
      states {
        nodes { id name type position }
      }
    }
  }
`;

export const WORKSPACE_LABELS_QUERY = `
  query WorkspaceLabels($after: String) {
    issueLabels(first: 250, after: $after) {
      nodes { id name isGroup parent { id name } team { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const TEAMS_QUERY = `
  query Teams {
    teams {
      nodes { id key name }
    }
  }
`;

export const PROJECTS_QUERY = `
  query Projects {
    projects(first: 250) {
      nodes { id name }
    }
  }
`;

export const INITIATIVES_QUERY = `
  query Initiatives {
    initiatives(first: 250) {
      nodes { id name }
    }
  }
`;

/**
 * An initiative's projects — used to check for the standing Maintenance
 * project (SPEC §3.11) and, via the embedded `status`, to let the
 * project-status worker skip a separate per-project status round trip.
 */
export const INITIATIVE_PROJECTS_QUERY = `
  query InitiativeProjects($initiativeId: String!) {
    initiative(id: $initiativeId) {
      projects(first: 250) {
        nodes { id name startDate targetDate status { id name type } }
      }
    }
  }
`;

export const ISSUE_UPDATE_MUTATION = (includeComments: boolean): string => `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        ${issueQueryFields(includeComments)}
      }
    }
  }
`;

export const ISSUE_CREATE_MUTATION = (includeComments: boolean): string => `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        ${issueQueryFields(includeComments)}
      }
    }
  }
`;

export const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body createdAt user { id name displayName } parent { id } }
    }
  }
`;

export const ISSUE_RELATION_CREATE_MUTATION = `
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id }
    }
  }
`;

export const ISSUE_RELATION_DELETE_MUTATION = `
  mutation IssueRelationDelete($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`;

export const ISSUE_LABEL_CREATE_MUTATION = `
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name parent { id } }
    }
  }
`;

export const PROJECT_CREATE_MUTATION = `
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project { id name }
    }
  }
`;

/** A project's own native status — `projectStatus` worker's read (SPEC §7.6a). */
export const PROJECT_STATUS_QUERY = `
  query ProjectStatus($projectId: String!) {
    project(id: $projectId) {
      id
      status { id name type }
    }
  }
`;

/** The workspace's configured project statuses — used once per unseen `type` to resolve a `statusId`. */
export const PROJECT_STATUSES_QUERY = `
  query ProjectStatuses {
    projectStatuses {
      nodes { id name type }
    }
  }
`;

export const PROJECT_UPDATE_MUTATION = `
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
    }
  }
`;

export const INITIATIVE_TO_PROJECT_CREATE_MUTATION = `
  mutation InitiativeToProjectCreate($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) {
      success
    }
  }
`;

/**
 * A project's dependency edges, both directions.
 *
 * Split from `INITIATIVE_PROJECTS_QUERY` rather than nested inside it: two
 * connections under `initiative.projects(first: 250)` puts the document over
 * Linear's complexity ceiling (measured — the API rejects it outright with
 * `Query too complex`), and the only caller narrows to bare projects first,
 * so the fan-out is bounded by however many projects have no issues at all.
 *
 * `anchorType`/`relatedAnchorType` are `String` on the wire and relative to
 * the row's own `project`/`relatedProject`, which is why the client reorients
 * them per connection instead of trusting the raw pair.
 */
export const PROJECT_RELATIONS_QUERY = `
  query ProjectRelations($projectId: String!) {
    project(id: $projectId) {
      id
      relations(first: 100) {
        nodes {
          id
          type
          anchorType
          relatedAnchorType
          relatedProject { id name startDate targetDate status { id name type } }
        }
      }
      inverseRelations(first: 100) {
        nodes {
          id
          type
          anchorType
          relatedAnchorType
          project { id name startDate targetDate status { id name type } }
        }
      }
    }
  }
`;

export const PROJECT_RELATION_CREATE_MUTATION = `
  mutation ProjectRelationCreate($input: ProjectRelationCreateInput!) {
    projectRelationCreate(input: $input) {
      success
      projectRelation { id }
    }
  }
`;

export const PROJECT_RELATION_DELETE_MUTATION = `
  mutation ProjectRelationDelete($id: String!) {
    projectRelationDelete(id: $id) { success }
  }
`;
