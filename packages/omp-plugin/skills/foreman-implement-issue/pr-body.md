# PR body template

The one artifact the extension never renders: the PR MUST exist before you
yield, so you author the body from the same data you put in
`ImplementResult`. No second pass.

## Template

```markdown
Closes <ISSUE-ID>

## Approach

<one paragraph: what you did and why, not a commit-by-commit narration>

## Acceptance criteria

- [x] <criterion 1, as written in the issue>
- [x] <criterion 2>

## Test coverage

<one or two sentences: which tests cover which criteria, and what kind (unit,
integration, smoke)>

## Definition of Done

- [x] Tests written and passing
- [x] Lint and typecheck clean
- [x] No new <whatever the product Context doc's Definition of Done actually names>

## Discovered work

- <title> — <one line, and why it's out of scope for this issue>

(omit this section entirely if nothing was discovered)
```

## Worked example

```markdown
Closes ENG-142

## Approach

Triage dedupe compared titles verbatim, so near-duplicate reports with
different wording never matched. Added a semantic similarity pass ahead of
the literal-title check, using the same embedding client triage already
imports.

## Acceptance criteria

- [x] Two issues with the same underlying bug but different titles are
      flagged as duplicates during triage
- [x] Similarity threshold is configurable via `.foreman/config.json`

## Test coverage

`dedupe.test.ts` covers exact-title matches (existing), near-duplicate
titles above threshold, and unrelated titles below threshold — each would
fail if the similarity pass were reverted.

## Definition of Done

- [x] Tests written and passing
- [x] Lint and typecheck clean
- [x] No new `any` types

## Discovered work

- Dedupe threshold has no lower bound check — a misconfigured `0` matches
  everything. Out of scope here; this issue is about adding the pass, not
  hardening its config.
```

Definition of Done checklist MUST carry the product `Context` doc's actual
items, not the placeholders above.
