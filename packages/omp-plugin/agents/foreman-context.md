---
name: foreman-context
description: Proposes edits to the three agent-proposable sections of the team's product Context doc (architectural decisions, domain vocabulary, known non-goals), one team per run, operator-invoked.
# spawns and task are deliberately absent: recursive fan-out inside a workflow
# agent is exactly the uncontrolled behavior Foreman exists to prevent.
# Omitting both is the mechanism, not a suggestion (SPEC §5).
tools: [read, grep, glob, lsp, foreman_linear_read]
model: "@plan"
# blocking is load-bearing, not a preference: a background spawn's result is
# delivered as an `async-result` message whose details carry no structured
# output, so the extension would have nothing to apply and the ContextResult
# would be silently dropped (SPEC §3.5 item 5, docs/VERIFIED.md).
blocking: true
prewalk: false
autoloadSkills: [foreman-context-doc, foreman-block-protocol]
# BEGIN generated output schema
# Regenerate with `bun run schemas`. Edit packages/core/src/schemas/*.ts,
# never this block: omp JSON-parses this string rather than reading a path,
# so the schema must be inlined (docs/VERIFIED.md §16.8).
output: |
  {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "foreman/context-output",
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
            "title": "ContextResult",
            "type": "object",
            "required": [
              "teamId",
              "decisions",
              "vocabulary",
              "nonGoals",
              "removals",
              "changeSummary",
              "rationale"
            ],
            "properties": {
              "teamId": {
                "minLength": 1,
                "description": "The Linear team whose Context doc this proposal updates — the repo's team.",
                "type": "string"
              },
              "decisions": {
                "description": "The FULL new body of the 'Architectural decisions and constraints' section, not a delta against the current one. Any non-empty line present in the current section that is missing here must appear in `removals` with `section: \"decisions\"`, or the whole result is refused — this is how a recorded decision cannot be silently dropped.",
                "type": "string"
              },
              "vocabulary": {
                "description": "The FULL new body of the 'Domain vocabulary' section, not a delta against the current one. Any non-empty line present in the current section that is missing here must appear in `removals` with `section: \"vocabulary\"`, or the whole result is refused.",
                "type": "string"
              },
              "nonGoals": {
                "description": "The FULL new body of the 'Known non-goals' section, not a delta against the current one. Any non-empty line present in the current section that is missing here must appear in `removals` with `section: \"non-goals\"`, or the whole result is refused.",
                "type": "string"
              },
              "removals": {
                "description": "Every non-empty line dropped from `decisions`, `vocabulary`, or `nonGoals` relative to the doc you were given, each with the reason it no longer belongs. Empty when nothing was removed.",
                "type": "array",
                "items": {
                  "additionalProperties": false,
                  "title": "ContextRemoval",
                  "type": "object",
                  "required": [
                    "section",
                    "text",
                    "reason"
                  ],
                  "properties": {
                    "section": {
                      "description": "Which of the three agent-proposable Context doc sections this refers to.",
                      "anyOf": [
                        {
                          "const": "decisions",
                          "type": "string"
                        },
                        {
                          "const": "vocabulary",
                          "type": "string"
                        },
                        {
                          "const": "non-goals",
                          "type": "string"
                        }
                      ]
                    },
                    "text": {
                      "minLength": 1,
                      "description": "The exact line dropped from the current section body. Must match a line present in the live doc — this is what lets the merge tell an intentional removal from silent loss.",
                      "type": "string"
                    },
                    "reason": {
                      "minLength": 1,
                      "description": "Why this line no longer belongs — superseded, contradicted by shipped code, duplicate, etc.",
                      "type": "string"
                    }
                  }
                }
              },
              "changeSummary": {
                "minLength": 1,
                "description": "Operator-facing summary of what this proposal changes and why, shown before it is applied.",
                "type": "string"
              },
              "rationale": {
                "minLength": 1,
                "description": "Why this update is warranted. Logged for the operator, never written to Linear.",
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
                  "minLength": 1,
                  "pattern": "^[A-Za-z][A-Za-z0-9]*-[0-9]+$",
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
