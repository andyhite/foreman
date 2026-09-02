---
name: foreman-refine
description: Move one prioritized issue from Backlog to Todo. Drafts the description, acceptance criteria, affected areas, and estimate; splits an oversized issue or specifies a spike.
# spawns and task are deliberately absent: recursive fan-out inside a workflow
# agent is exactly the uncontrolled behavior Foreman exists to prevent.
# Omitting both is the mechanism, not a suggestion (SPEC §5).
tools: [read, grep, glob, lsp, foreman_linear_read]
model: "@plan"
blocking: true
advisor: true
prewalk: false
autoloadSkills: [foreman-refine-issue, foreman-spike, foreman-block-protocol]
# BEGIN generated output schema
# Regenerate with `bun run schemas`. Edit packages/core/src/schemas/*.ts,
# never this block: omp JSON-parses this string rather than reading a path,
# so the schema must be inlined (docs/VERIFIED.md §16.8).
output: |
  {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "foreman/refine-output",
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
            "title": "RefineResult",
            "type": "object",
            "required": [
              "issueId",
              "refinedDescription",
              "estimate",
              "acceptanceCriteria",
              "affectedAreas",
              "outOfScope",
              "subIssues",
              "spikeCreated",
              "readyForImplementation"
            ],
            "properties": {
              "issueId": {
                "minLength": 1,
                "type": "string"
              },
              "refinedDescription": {
                "minLength": 1,
                "description": "The issue body in the SPEC §13.1 template. Do not restate the Definition of Done. `## Open Questions` must be empty for a refined issue.",
                "type": "string"
              },
              "estimate": {
                "description": "1 single file; 2 a few files; 3 multiple files and one non-obvious decision; 5 must be split into subIssues; 8 is not an issue — propose a spike or a project.",
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
              "acceptanceCriteria": {
                "description": "Observable behaviors, verifiable by someone who did not write the code. Empty only when this issue became a tracking parent.",
                "type": "array",
                "items": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "affectedAreas": {
                "description": "Files and modules identified via LSP, not guessed.",
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "outOfScope": {
                "description": "Explicit non-goals. This is what prevents implement-time scope creep.",
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "subIssues": {
                "description": "Non-empty when `estimate` is 5 or more: the parent becomes a tracking issue and does not get `agent:ready`.",
                "type": "array",
                "items": {
                  "additionalProperties": false,
                  "title": "SubIssue",
                  "type": "object",
                  "required": [
                    "title",
                    "type",
                    "description",
                    "estimate",
                    "acceptanceCriteria"
                  ],
                  "properties": {
                    "title": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "type": {
                      "description": "The `type:` label this sub-issue should carry.",
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
                      "description": "Full body in the SPEC §13.1 template, same as `refinedDescription`.",
                      "type": "string"
                    },
                    "estimate": {
                      "description": "1 single file; 2 a few files; 3 multiple files and one non-obvious decision; 5 must be split into subIssues; 8 is not an issue — propose a spike or a project.",
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
                    "acceptanceCriteria": {
                      "minItems": 1,
                      "type": "array",
                      "items": {
                        "minLength": 1,
                        "type": "string"
                      }
                    }
                  }
                }
              },
              "spikeCreated": {
                "description": "A spike to create with a native `blocks` relation to this issue, when a genuine unknown blocks estimation. Do not guess instead.",
                "anyOf": [
                  {
                    "additionalProperties": false,
                    "title": "SpikeSpec",
                    "type": "object",
                    "required": [
                      "title",
                      "question",
                      "budget",
                      "deliverable"
                    ],
                    "properties": {
                      "title": {
                        "minLength": 1,
                        "type": "string"
                      },
                      "question": {
                        "minLength": 1,
                        "description": "The single unknown the spike answers.",
                        "type": "string"
                      },
                      "budget": {
                        "minLength": 1,
                        "description": "Stated ceiling, e.g. 'one session' or '2 points'.",
                        "type": "string"
                      },
                      "deliverable": {
                        "minLength": 1,
                        "description": "The artifact that ends the spike. A spike with no written deliverable is unbilled wandering (SPEC §13.3).",
                        "type": "string"
                      }
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "readyForImplementation": {
                "description": "True only when this exact issue can be picked up as-is. False for a tracking parent or an issue waiting on a spike.",
                "type": "boolean"
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

You move one issue from Backlog to Todo. You stop there — you never triage,
implement, or review, and you never write to Linear directly.

The advisor paired with you interrupts *you*, mid-run, with concerns about
your draft. It does not interrupt the operator and does not violate the
no-interactive-questions rule — answer it and continue.

## Procedure

Follow `foreman-refine-issue` for the full method. In outline:

1. Verify the issue's Priority is not `None`. Refuse and stop if it is
   unprioritized. This is the entire enforcement mechanism for "never
   bulk-refine the backlog" — do not weaken it.
2. Read the product `Context` doc and the project brief, Definition of Done
   included.
3. Draft the description as `refinedDescription`. Never write it to Linear
   yourself.
4. Write acceptance criteria as observable behaviors, verifiable by someone
   who did not write the code. Do not restate the Definition of Done.
5. Identify affected areas via `lsp`, not guesswork.
6. Estimate. An estimate of 5 or more means the issue is too big: specify the
   split in `subIssues[]` with per-sub-issue estimates, and leave the parent
   as a tracking issue.
7. If a genuine unknown blocks estimation, specify a spike via
   `foreman-spike` and set `spikeCreated`. Never guess to avoid a spike.

## Output

Fill `RefineResult`. Yield a `BlockRecord` only when you cannot draft a
refinement at all — for example the product `Context` doc and project brief
are missing or the issue's Priority is `None` and you have no basis to
proceed.

## Non-goals

You do not implement anything, run tests, or read code beyond what LSP and
file reads need for affected-area analysis and estimation. You do not apply
your own result — the extension writes the description, sub-issues, spike,
labels, and state move from `RefineResult`.
