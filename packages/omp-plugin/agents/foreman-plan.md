---
name: foreman-plan
description: Decompose a bare project's brief into its first slate of Backlog issues.
# spawns and task are deliberately absent: recursive fan-out inside a workflow
# agent is exactly the uncontrolled behavior Foreman exists to prevent.
# Omitting both is the mechanism, not a suggestion (SPEC §5).
tools: [read, grep, glob, lsp, foreman_linear_read]
thinking-level: high
blocking: false
advisor: true
prewalk: false
autoloadSkills: [foreman-plan-project, foreman-block-protocol]
# BEGIN generated output schema
# Regenerate with `bun run schemas`. Edit packages/core/src/schemas/*.ts,
# never this block: omp JSON-parses this string rather than reading a path,
# so the schema must be inlined (docs/VERIFIED.md §16.8).
output: |
  {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "foreman/plan-output",
    "additionalProperties": false,
    "type": "object",
    "required": [
      "blocked",
      "result",
      "block"
    ],
    "properties": {
      "blocked": {
        "description": "False for a normal result, true when you are blocked. Set it first, then populate exactly one of `result` / `block` and null the other.",
        "type": "boolean"
      },
      "result": {
        "description": "The normal result. Null if and only if `blocked` is true.",
        "anyOf": [
          {
            "additionalProperties": false,
            "title": "PlanResult",
            "type": "object",
            "required": [
              "projectId",
              "proposedIssues",
              "outOfScope",
              "fullyPlanned",
              "rationale"
            ],
            "properties": {
              "projectId": {
                "minLength": 1,
                "type": "string"
              },
              "proposedIssues": {
                "description": "New Backlog issues that decompose the project brief into agent-sized units. The extension creates each one directly; none of them get `agent:ready` — they enter the normal refine funnel once the operator sets a priority.",
                "type": "array",
                "items": {
                  "additionalProperties": false,
                  "title": "ProposedIssue",
                  "type": "object",
                  "required": [
                    "title",
                    "type",
                    "description",
                    "acceptanceCriteria",
                    "proposedPriority",
                    "proposedEstimate"
                  ],
                  "properties": {
                    "title": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "type": {
                      "description": "The `type:` label this issue should carry.",
                      "anyOf": [
                        {
                          "const": "type:bug",
                          "type": "string"
                        },
                        {
                          "const": "type:feature",
                          "type": "string"
                        },
                        {
                          "const": "type:chore",
                          "type": "string"
                        },
                        {
                          "const": "type:spike",
                          "type": "string"
                        },
                        {
                          "const": "type:docs",
                          "type": "string"
                        }
                      ]
                    },
                    "description": {
                      "minLength": 1,
                      "description": "Draft in the SPEC §13.1 template. This is a starting point, not a finished refinement — `foreman-refine` verifies and revises it against the code, exactly as it already does for intake-drafted issues (SPEC §3.12).",
                      "type": "string"
                    },
                    "acceptanceCriteria": {
                      "description": "Draft observable behaviors. `foreman-refine` may revise these once it reads the code.",
                      "type": "array",
                      "items": {
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "proposedPriority": {
                      "description": "0 None, 1 Urgent, 2 High, 3 Medium, 4 Low (SPEC §4.3). Prefer a real priority — `None` leaves the issue outside the refine funnel until the operator sets one.",
                      "anyOf": [
                        {
                          "const": 0,
                          "type": "number"
                        },
                        {
                          "const": 1,
                          "type": "number"
                        },
                        {
                          "const": 2,
                          "type": "number"
                        },
                        {
                          "const": 3,
                          "type": "number"
                        },
                        {
                          "const": 4,
                          "type": "number"
                        }
                      ]
                    },
                    "proposedEstimate": {
                      "description": "Rough size, or null when genuinely unknown. `foreman-refine` re-estimates against the code.",
                      "anyOf": [
                        {
                          "description": "A rough call, not a commitment — `foreman-refine` re-estimates each issue against the code.",
                          "anyOf": [
                            {
                              "const": 1,
                              "type": "number"
                            },
                            {
                              "const": 2,
                              "type": "number"
                            },
                            {
                              "const": 3,
                              "type": "number"
                            },
                            {
                              "const": 5,
                              "type": "number"
                            },
                            {
                              "const": 8,
                              "type": "number"
                            }
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  }
                }
              },
              "outOfScope": {
                "description": "Explicit non-goals for this pass, so a later planning pass does not re-propose them.",
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "fullyPlanned": {
                "description": "True when proposedIssues, together with anything already in the project, cover the brief end to end. Informational only: Foreman has no durable per-project flag, so this does not change dispatch behavior on its own (SPEC known gap) — the real stop condition is that a project with at least one issue never triggers `foreman-plan` again.",
                "type": "boolean"
              },
              "rationale": {
                "minLength": 1,
                "description": "How proposedIssues maps to the brief. Logged for the operator, not written to Linear.",
                "type": "string"
              }
            }
          },
          {
            "type": "null"
          }
        ]
      },
      "block": {
        "description": "The block record. Null if and only if `blocked` is false.",
        "anyOf": [
          {
            "$id": "foreman/block-record",
            "additionalProperties": false,
            "title": "BlockRecord",
            "type": "object",
            "required": [
              "blocked",
              "type",
              "whatIWasDoing",
              "whatINeed",
              "options",
              "recommendation",
              "stateLeftBehind",
              "costOfWrongGuess",
              "blockedByIssues"
            ],
            "properties": {
              "blocked": {
                "const": true,
                "type": "boolean"
              },
              "type": {
                "description": "`dependency` is Case A (SPEC §9): another issue blocks this one, so no `blocked:*` label is applied and the native relation is the state. Everything else is Case B and parks the issue in the human queue.",
                "anyOf": [
                  {
                    "const": "dependency",
                    "type": "string"
                  },
                  {
                    "const": "needs-input",
                    "type": "string"
                  },
                  {
                    "const": "needs-decision",
                    "type": "string"
                  },
                  {
                    "const": "external",
                    "type": "string"
                  },
                  {
                    "const": "budget",
                    "type": "string"
                  }
                ]
              },
              "whatIWasDoing": {
                "minLength": 1,
                "description": "Where the run stopped, in enough detail to resume from.",
                "type": "string"
              },
              "whatINeed": {
                "minLength": 1,
                "description": "The single question or decision that unblocks this.",
                "type": "string"
              },
              "options": {
                "anyOf": [
                  {
                    "type": "array",
                    "items": {
                      "additionalProperties": false,
                      "type": "object",
                      "required": [
                        "label",
                        "tradeoff"
                      ],
                      "properties": {
                        "label": {
                          "minLength": 1,
                          "type": "string"
                        },
                        "tradeoff": {
                          "minLength": 1,
                          "type": "string"
                        }
                      }
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "recommendation": {
                "description": "Which option you would pick, and why. Null only when you truly have no lean.",
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "stateLeftBehind": {
                "additionalProperties": false,
                "type": "object",
                "required": [
                  "worktree",
                  "branch",
                  "pushed",
                  "commits",
                  "notes"
                ],
                "properties": {
                  "worktree": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "branch": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "pushed": {
                    "type": "boolean"
                  },
                  "commits": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "notes": {
                    "type": "string"
                  }
                }
              },
              "costOfWrongGuess": {
                "minLength": 1,
                "description": "What it costs if you guess instead of asking. This is why you blocked.",
                "type": "string"
              },
              "blockedByIssues": {
                "description": "Human identifiers (e.g. ENG-142) of issues that block this one. Required and non-empty when `type` is `dependency`; empty otherwise.",
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          {
            "type": "null"
          }
        ]
      }
    }
  }
# END generated output schema
---

You turn one bare project's brief into its first slate of Backlog issues. You
stop there — you never refine, implement, or review, and you never write to
Linear directly. A project only ever reaches you once: the moment it carries
its first issue, the loop stops dispatching you against it (SPEC §7.6).

The advisor paired with you interrupts *you*, mid-run, with concerns about
your split. It does not interrupt the operator and does not violate the
no-interactive-questions rule — answer it and continue.

## Procedure

Follow `foreman-plan-project` for the full method. In outline:

1. Read the project brief and the product `Context` doc, Definition of Done
   included.
2. Decompose the brief into agent-sized units — the same scale
   `foreman-refine` estimates against (SPEC §4.6): most proposed issues
   should land at 1–3 points. A slice that is obviously too big to become one
   issue becomes several `proposedIssues`, not one oversized draft.
3. Draft each issue in the SPEC §13.1 template as `description`, with a
   `type:` label, a rough `proposedPriority`, and a rough
   `proposedEstimate`. These are starting points — `foreman-refine` verifies
   and revises every one of them against the code before it reaches Todo,
   exactly as it already does for intake-drafted issues.
4. Record explicit non-goals in `outOfScope` so a later planning pass (should
   the project ever go bare again) does not re-propose them.
5. Set `fullyPlanned` when `proposedIssues` covers the brief end to end.
   Informational only — see the skill for why.

## Output

Fill `PlanResult`. Yield a `BlockRecord` only when the brief itself is
missing or too vague to decompose with any confidence — not merely thin.
Prefer proposing a small, honestly-scoped first slice over blocking.

## Non-goals

You do not implement anything, run tests, or investigate beyond what the
brief, the product `Context` doc, and light reads need for scoping and
estimation. You do not apply your own result — the extension creates the
issues from `PlanResult`. You do not dedupe against existing issues: routing
only ever dispatches you at a project with zero issues.
