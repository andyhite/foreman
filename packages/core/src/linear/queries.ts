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
`;

const ISSUE_FIELDS_WITH_COMMENTS = `${ISSUE_FIELDS}
  comments {
    nodes { id body createdAt user { id name displayName } parent { id } }
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
  query IssueComments($issueId: String!) {
    issue(id: $issueId) {
      comments {
        nodes { id body createdAt user { id name displayName } parent { id } }
      }
    }
  }
`;

/** Document content as a scalar `String`. Tried first; see `client.ts` for the fallback. */
export const PROJECT_QUERY_SCALAR_CONTENT = `
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

/** Document content as a sub-selection. Used only when the scalar form errors. */
export const PROJECT_QUERY_OBJECT_CONTENT = `
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

/** Initiative documents as a scalar `String`. Tried first; see `client.ts` for the fallback. */
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

/** Initiative documents as a sub-selection. Used only when the scalar form errors. */
export const INITIATIVE_QUERY_OBJECT_CONTENT = `
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

export const WORKFLOW_STATES_QUERY = `
  query TeamWorkflowStates($teamId: String!) {
    team(id: $teamId) {
      workflowStates {
        nodes { id name type position }
      }
    }
  }
`;

export const LABELS_QUERY = `
  query TeamLabels($teamId: String) {
    issueLabels(filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name isGroup parent { id name } }
    }
  }
`;

export const WORKSPACE_LABELS_QUERY = `
  query WorkspaceLabels {
    issueLabels {
      nodes { id name isGroup parent { id name } }
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

/** An initiative's projects — used to check for the standing Maintenance project (SPEC §3.11). */
export const INITIATIVE_PROJECTS_QUERY = `
  query InitiativeProjects($initiativeId: String!) {
    initiative(id: $initiativeId) {
      projects(first: 250) {
        nodes { id name }
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

export const INITIATIVE_TO_PROJECT_CREATE_MUTATION = `
  mutation InitiativeToProjectCreate($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) {
      success
    }
  }
`;
