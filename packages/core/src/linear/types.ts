/**
 * Linear domain types.
 *
 * These are the shapes the hand-rolled GraphQL client returns. They are
 * deliberately flatter than Linear's own graph: every field Foreman's gate
 * validators read is eagerly present, because a gate that has to `await` a
 * lazy relation is a gate that can be evaluated inconsistently.
 */

export type LinearId = string;

/** Linear's workflow state categories. `name` is workspace-defined; `type` is not. */
export type WorkflowStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "duplicate";

export interface WorkflowState {
  id: LinearId;
  name: string;
  type: WorkflowStateType;
  position: number;
  /** Present only on reads that ask for it (`workflowStates()`) — provisioning's own diff needs it, nothing else does. */
  color?: string;
  description?: string | null;
}

/**
 * Linear's project-level status (distinct from `WorkflowStateType`, which is
 * per-issue). `type` is the fixed enum every workspace shares; `name` is the
 * workspace's label for it, customizable but irrelevant to Foreman logic.
 */
export type ProjectStatusType = "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";

export interface ProjectStatus {
  id: LinearId;
  name: string;
  type: ProjectStatusType;
}

export interface IssueLabel {
  id: LinearId;
  name: string;
  /** Set when the label belongs to a mutually-exclusive label group. */
  parentId: LinearId | null;
}

export interface UserRef {
  id: LinearId;
  name: string;
  displayName: string | null;
}

export interface TeamRef {
  id: LinearId;
  key: string;
  name: string;
}

export interface ProjectRef {
  id: LinearId;
  name: string;
  /** Present when fetched via `projects(teamKey)`, folding a per-project status read into that one query. */
  status?: ProjectStatus | null;
  /** `TimelessDate` (`YYYY-MM-DD`), not a timestamp. Present on the same reads that carry `status`. */
  startDate?: string | null;
  targetDate?: string | null;
  /** Canonical colon-form ids (e.g. `app:fleet`), present on the same reads that carry `status`. */
  labels?: IssueLabel[];
}

/**
 * `ProjectRelation.type` is a `String` on both read and write — Linear
 * declares no `ProjectRelationType` enum (introspected against the live API).
 * `dependency` is the only value the product writes, and the only one Foreman
 * reads as a scheduling constraint.
 */
export type ProjectRelationType = "dependency";

/**
 * Which end of a project's timeline an edge anchors to. Linear's UI writes a
 * "blocks" dependency as the blocker's `end` anchored to the blocked
 * project's `start`; the other combinations express softer alignment
 * (start-together, finish-together) and are not blockers.
 */
export type ProjectRelationAnchor = "start" | "end";

/**
 * One project dependency edge, oriented from the perspective of the project
 * that was queried — the same convention `IssueRelation` uses, and for the
 * same reason: `anchorType`/`relatedAnchorType` on the wire are relative to
 * the row's own `project`/`relatedProject`, which flips between the
 * `relations` and `inverseRelations` connections.
 */
export interface ProjectRelation {
  id: LinearId;
  type: ProjectRelationType;
  /** `outgoing`: the queried project is the row's `project`. `incoming`: it is the `relatedProject`. */
  direction: "outgoing" | "incoming";
  /** The anchor on the queried project's own timeline. */
  anchor: ProjectRelationAnchor;
  /** The anchor on `other`'s timeline. */
  otherAnchor: ProjectRelationAnchor;
  other: ProjectRef;
}

/** Enough of a related issue to evaluate a gate against it without a second fetch. */
export interface IssueRef {
  id: LinearId;
  identifier: string;
  title: string;
  state: { id: LinearId; name: string; type: WorkflowStateType };
}

export type IssueRelationType = "blocks" | "duplicate" | "related" | "similar";

/**
 * One edge, oriented from the perspective of the issue that was queried.
 *
 * Linear stores a single row per relation and exposes it from both ends, so
 * `blocked by` is not its own type: it is a `blocks` edge seen from the other
 * side. Collapsing that into an explicit `direction` here means callers never
 * have to remember which end of the row they are holding.
 */
export interface IssueRelation {
  id: LinearId;
  type: IssueRelationType;
  /** `outgoing`: this issue `type`s `other`. `incoming`: `other` `type`s this issue. */
  direction: "outgoing" | "incoming";
  other: IssueRef;
}

export interface Comment {
  id: LinearId;
  body: string;
  createdAt: string;
  user: UserRef | null;
  parentId: LinearId | null;
}

export interface Issue {
  id: LinearId;
  /** Human identifier, e.g. `ENG-142`. The only issue key that appears in a command. */
  identifier: string;
  title: string;
  description: string | null;
  /** 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. See `domain/priority.ts`. */
  priority: number;
  estimate: number | null;
  url: string;
  /** Linear's suggested branch name. Foreman does not use it; `branchPattern` wins. */
  branchName: string;
  createdAt: string;
  updatedAt: string;
  state: WorkflowState;
  labels: IssueLabel[];
  team: TeamRef;
  project: ProjectRef | null;
  parent: IssueRef | null;
  children: IssueRef[];
  assignee: UserRef | null;
  relations: IssueRelation[];
  /** Populated only by reads that ask for comments; otherwise empty. */
  comments: Comment[];
}

export interface LinearDocument {
  id: LinearId;
  title: string;
  content: string | null;
  updatedAt: string;
}

export interface Project {
  id: LinearId;
  name: string;
  /** Linear's one-line summary. Orientation, not the brief. */
  description: string | null;
  /**
   * The project's own document body — where Linear's UI puts the overview an
   * operator actually writes. This is the project brief of SPEC §4.7; measured
   * against the live workspace, `description` holds one truncated sentence
   * while `content` holds the real `## Overview` / `## Context` markdown.
   */
  content: string | null;
  /**
   * `TimelessDate` (`YYYY-MM-DD`). Foreman never gates on these — dependency
   * edges are the machine-readable sequence (SPEC §4.10a) — but the roadmap
   * surface reads them to place a new project's dates relative to the
   * projects it depends on.
   */
  startDate: string | null;
  targetDate: string | null;
  status: ProjectStatus | null;
  /** Canonical colon-form ids (e.g. `app:fleet`). */
  labels?: IssueLabel[];
  documents: LinearDocument[];
}

export interface InitiativeRef {
  id: LinearId;
  name: string;
}

export interface Initiative {
  id: LinearId;
  name: string;
  documents: LinearDocument[];
}

/** `Team.triageEnabled`/`cyclesEnabled` plus the triage state id, when Linear has created one. */
export interface TeamSettings {
  id: LinearId;
  key: string;
  name: string;
  triageEnabled: boolean;
  cyclesEnabled: boolean;
  triageStateId: LinearId | null;
}
