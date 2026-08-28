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
  | "canceled";

export interface WorkflowState {
  id: LinearId;
  name: string;
  type: WorkflowStateType;
  position: number;
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
