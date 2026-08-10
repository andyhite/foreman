# Logic Prototype — make the state model tangible

Build a single, self-contained HTML file: a **shareable demo** that lets
anyone drive a state model by clicking buttons. Use this shape when the
question concerns business logic, state transitions, or data shape — the
kind of design that looks reasonable on paper but feels wrong once pushed
through real cases.

One file with nothing to install can go to a designer, product manager, or
domain expert. Write it in their language, not the code's.

## When this is the right shape

- "Does this state machine handle the edge case where X then Y?"
- "Can this data model represent the case where...?"
- "What should this API feel like before we write it?"
- Anything where someone needs to **press buttons and watch state change**.

If the question is "what should this look like?", take the other branch and
read [UI.md](UI.md).

## Process

### 1. State the question

Before writing code, state the model and the one question the prototype
must answer. Put one paragraph in a visible introduction at the top of the
demo, not only in a comment. An explicit question lets the operator check
whether the demo answers the intended problem, whether they are present now
or return to it later.

### 2. Isolate the logic in a portable module

Put the logic that answers the question in one `<script>` block as a small,
pure module. It should lift out of the demo and into the real codebase. The
page around it is throwaway; the module is the validated decision.

Choose the shape that fits the question:

- **A pure reducer** — `(state, action) => state`. Use it when actions are
  discrete events and state is one value.
- **A state machine** — explicit states and transitions. Use it when legal
  actions depend on the current state.
- **A small set of pure functions** over a plain data type. Use them when
  there is no implicit current state, only transformations.
- **A class or module with a clear method surface.** Use it when the logic
  genuinely owns ongoing internal state.

Fit the logic to the question rather than to whichever form is easiest to
wire into a page. Keep it pure: no DOM, no `document`, and no button
handlers reaching inside it. The page calls into the module; nothing flows
back. That boundary makes the logic liftable after the prototype has
answered its question.

### 3. Build the shareable HTML file

Use one file with plain HTML, CSS, and JavaScript. Keep everything inline:
no framework, bundler, or server. The file must open by double-click and
survive being emailed.

Write for a non-developer. Use domain language for every label. Buttons and
state should read like the business rather than a reducer, and the page
should explain what is happening in plain words.

Lay it out in a clear hierarchy from top to bottom:

1. **Title and one-line explanation.** State what the demo lets someone
   explore: the question from step 1.
2. **Current-state panel.** Render the full relevant state as labelled,
   readable fields rather than a raw JSON dump. Re-render it after every
   click so each change is visible. Call out what changed when that helps a
   non-developer follow.
3. **Free-play buttons.** Show one button per action and keep them available,
   so anyone can drive the model in any order. Each click dispatches an
   action and re-renders the state.
4. **Tabbed guided walkthroughs.** Put one scenario in each tab. Give it a
   short plain-language description of the situation and what to watch for,
   followed by ordered buttons for the steps. Each step is a real button:
   clicking performs the action and advances the walkthrough. Starting a
   walkthrough resets to a known initial state, so the scenario repeats the
   same way each time.

Choose scenarios that expose awkward cases: the happy path, a tricky edge
case, and an attempt at something that should be illegal. Prefer cases that
are difficult to reason about on paper.

Keep the page restrained: clean typography, generous spacing, and one
accent colour. Avoid animation and ornament that compete with the state and
the buttons.

### 4. Hand it over

Send the file or open it for the operator. Let them use the walkthroughs and
free-play controls. Reactions such as "that should not be possible" and "I
assumed X would be different" expose bugs in the idea, which is the point.
Add an action or scenario when it helps answer the original question.

### 5. Capture the answer and the prototype

Once the question is answered, record the verdict and follow the capture
rule in [SKILL.md](SKILL.md). Lift the validated reducer, machine, or
function set into the real module. Keep the HTML shell on the throwaway
branch as a primary source. Because it stays one self-contained file, it
remains trivial to rerun there.

## Anti-patterns

- **Do not add tests.** A prototype that needs tests is no longer a
  prototype.
- **Do not wire it to the real database.** Use in-memory state unless the
  question specifically concerns persistence.
- **Do not generalise.** Answer one question; avoid speculative support for
  future cases.
- **Do not blur the logic and the page together.** Keep the page a thin
  shell over the pure module. A module that references the DOM, `document`,
  or button handlers is not liftable.
- **Do not reach for a framework, bundler, or server.** A React app or dev
  server defeats the shareable, double-clickable artifact.
- **Do not ship the HTML shell into production.** Keep the validated logic;
  discard the hand-driven page from main.
