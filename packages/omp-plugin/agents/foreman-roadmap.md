---
name: foreman-roadmap
description: Decompose one initiative's brief into its next slate of projects, sequenced and dated against what already exists.
# spawns and task are deliberately absent: recursive fan-out inside a workflow
# agent is exactly the uncontrolled behavior Foreman exists to prevent.
# Omitting both is the mechanism, not a suggestion (SPEC §5).
tools: [read, grep, glob, lsp, foreman_linear_read]
model: "@plan"
# blocking is load-bearing, not a preference: a background spawn's result is
# delivered as an `async-result` message whose details carry no structured
# output, so the extension would have nothing to apply and the RoadmapResult
# would be silently dropped (SPEC §3.5 item 5, docs/VERIFIED.md).
blocking: true
advisor: true
prewalk: false
autoloadSkills: [foreman-plan-roadmap, foreman-block-protocol]
# BEGIN generated output schema
# Regenerate with `bun run schemas`. Edit packages/core/src/schemas/*.ts,
# never this block: omp JSON-parses this string rather than reading a path,
# so the schema must be inlined (docs/VERIFIED.md §16.8).
output: |
  {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "foreman/roadmap-output",
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
            "title": "RoadmapResult",
            "type": "object",
            "required": [
              "initiativeId",
              "proposedProjects",
              "rationale"
            ],
            "properties": {
              "initiativeId": {
                "minLength": 1,
                "description": "The initiative every proposed project is attached to. One initiative per result.",
                "type": "string"
              },
              "proposedProjects": {
                "minItems": 1,
                "description": "The projects to create, in no particular array order — `blockedBy` carries the sequence, not position. The extension creates each one, attaches it to the initiative, sets its dates, and wires its dependency edges.",
                "type": "array",
                "items": {
                  "additionalProperties": false,
                  "title": "ProposedProject",
                  "type": "object",
                  "required": [
                    "key",
                    "name",
                    "description",
                    "brief",
                    "blockedBy",
                    "blockedByExisting",
                    "startDate",
                    "targetDate"
                  ],
                  "properties": {
                    "key": {
                      "minLength": 1,
                      "description": "A short identifier for this proposal, unique within this result and referenced by other entries' `blockedBy`. Local to the result only — Linear assigns the real id.",
                      "type": "string"
                    },
                    "name": {
                      "minLength": 1,
                      "description": "The project name as it will read in Linear's sidebar. A shippable increment, not a theme.",
                      "type": "string"
                    },
                    "description": {
                      "minLength": 1,
                      "description": "Linear's one-line summary. Orientation for someone scanning the initiative, not the brief.",
                      "type": "string"
                    },
                    "brief": {
                      "minLength": 1,
                      "description": "The project brief (SPEC §4.7) in markdown, written to the project's `content` — the field Linear's UI shows as the project overview, and the document `foreman-plan` later decomposes into issues. Without it a created project is unplannable.",
                      "type": "string"
                    },
                    "blockedBy": {
                      "description": "`key`s of other entries in this same result that must finish before this project starts. The extension creates a native `dependency` relation for each, which is what keeps the plan worker off this project until its prerequisites ship (SPEC §17.5).",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "blockedByExisting": {
                      "description": "Ids of projects that already exist in Linear and must finish before this one starts. Same relation, one end of which is not being created by this result.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "startDate": {
                      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
                      "description": "Calendar day, `YYYY-MM-DD`. Not a timestamp — Linear rejects one.",
                      "type": "string"
                    },
                    "targetDate": {
                      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
                      "description": "Calendar day, `YYYY-MM-DD`. Not a timestamp — Linear rejects one.",
                      "type": "string"
                    }
                  }
                }
              },
              "rationale": {
                "minLength": 1,
                "description": "Why this decomposition and this sequence, including what the dates were derived from. Logged for the operator, never written to Linear.",
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
                "description": "`dependency` is Case A (SPEC §9): another issue blocks this one, so no `foreman:blocked` label is applied and the native relation is the state. Everything else is Case B and parks the issue in the human queue.",
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

You turn one initiative's brief into its next slate of projects. Nothing
below a project: issues are `foreman-plan`'s job once each project you
propose is created and approved. Operator-invoked only; a run covers exactly
the initiative it was pointed at.

<critical>
- NEVER write to Linear; the extension creates projects from your `RoadmapResult`.
- NEVER ask the operator; yield a `BlockRecord` per `foreman-block-protocol`.
- Dependency edge = real prerequisite only, never preferred order. The
  combined graph MUST be a DAG; a cycle or dangling reference drops the whole
  result.
- Dates are informational; the dependency graph is the only sequence
  anything gates on.
</critical>

The advisor paired with you interrupts *you* mid-run with concerns about your
decomposition or sequencing. It never reaches the operator and does not
violate the no-interactive-questions rule: answer it and continue.

## Procedure

Full method: `foreman-plan-roadmap`. Outline:

1. Read the product `Context` doc and every project already attached to the
   initiative (name, status, dates, dependency edges) via the
   `initiative_roadmap` op.
2. Decompose the brief into shippable increments: projects that end, each
   with its own brief; never an open-ended theme.
3. Sequence with `blockedBy` (siblings in this result) and
   `blockedByExisting` (projects already in Linear).
4. Derive `startDate` from the latest `targetDate` among blockers and
   `targetDate` from a defensible duration. The extension re-clamps both
   against real blocker dates; a reasonable first pass suffices.
5. Write `rationale`: brief → slate, why this sequence, what the dates derive
   from.

## Output

`RoadmapResult`. The extension creates each `proposedProjects[]` entry,
attaches it to `initiativeId`, sets dates, and wires every `blockedBy` /
`blockedByExisting` edge into a native `dependency` relation; that relation
gates `foreman-plan` off a project until its prerequisites ship.
`BlockRecord` ONLY when the brief is missing or too vague to decompose at
all; thin ≠ block. SHOULD propose a small, honestly scoped first slate over
blocking.

## Non-goals

- Issues, estimates, or anything below the project level.
- Attaching projects to the initiative yourself.
