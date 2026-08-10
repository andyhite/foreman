# UI Prototype — compare structures in context

Generate **several radically different UI variants** on one route,
switchable from a floating bottom bar. The operator flips between variants
in the browser, picks one or combines parts, and throws the rest away.

If the question concerns logic or state rather than appearance, take the
other branch and read [LOGIC.md](LOGIC.md).

## When this is the right shape

- "What should this page look like?"
- "Show a few options for this dashboard before we commit."
- "Try a different layout for the settings screen."
- Any case where seeing alternatives will settle a visual or interaction
  decision faster than discussing imagined mockups.

## Two sub-shapes — strongly prefer A

A UI prototype is easier to judge when it sits against the real app: its
header, sidebar, data, and density. A throwaway route in a vacuum hides the
constraints that distinguish good variants. Default to sub-shape A whenever
there is a plausible existing page. Use sub-shape B only when the prototype
has no nearby home.

### Sub-shape A — adjust an existing page (preferred)

Keep the existing route. Render variants on that route, gated by a
`?variant=` URL search parameter. Preserve its data fetching, parameters,
and authentication; swap only the rendered subtree.

A new section, card, or flow step that would naturally live inside an
existing page still belongs to sub-shape A. Mount the variants inside that
host page, because its real surroundings are part of the decision.

### Sub-shape B — add a new page (last resort)

Use this only when the prototype has no existing page where it belongs, such
as a new top-level surface or a flow that cannot be embedded sensibly.

Create a **throwaway route** using the project's routing convention. Do not
invent a new top-level structure. Put `prototype` in the route or filename
so its status is obvious, and use the same `?variant=` pattern.

Before choosing B, check again whether an existing page can host the idea.
An empty route conceals design problems that a populated page would expose.

Use the same floating switcher in both sub-shapes.

## Process

### 1. State the question and pick the count

Default to **3 variants**. Cap the set at **5**: beyond that, the differences
usually become noise rather than distinct answers.

Write the plan in one line at the prototype's location or in a top-of-file
comment:

> "Three variants of the settings page, switchable via `?variant=`, on the
  existing `/settings` route."

This preserves the question even when the operator reviews the prototype
later.

### 2. Generate structurally different variants

Draft each variant against:

- The page's purpose and the data it can access.
- The project's component library or styling system: Tailwind CSS, shadcn,
  MUI, plain CSS, or the local equivalent.
- A clear exported component name such as `VariantA`, `VariantB`, or
  `VariantC`.

Make the variants **structurally different**: change the layout, information
hierarchy, and primary affordance, not only the colours or copy. Three
slightly altered card grids answer no design question. If two drafts become
too similar, redo one under an explicit structural constraint, such as "do
not use a card grid."

### 3. Wire them together on one route

Create a single switcher on the route:

```tsx
// Pseudocode — adapt to the project's framework.
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A', 'B', 'C']} current={variant} />
  </>
);
```

For sub-shape A, keep all existing data fetching above this switcher; only
the rendered subtree changes. For sub-shape B, mount the same switcher on
the throwaway route under `/prototype/<name>`.

### 4. Build the floating switcher

Build a small fixed-position bar at the bottom centre of the screen with
three pieces:

- **Left arrow** — cycle to the previous variant, wrapping at the start.
- **Variant label** — show the current key and, when available, its name,
  such as `B — Sidebar layout`.
- **Right arrow** — cycle forward, wrapping at the end.

Make it behave predictably:

- Update the URL search parameter through the framework's router — for
  example, `router.replace` in Next or `navigate` in React Router — so a
  variant is shareable and survives reloads.
- Bind the left and right arrow keys. Do not intercept them while an
  `<input>`, `<textarea>`, or `[contenteditable]` element has focus.
- Make the control visually distinct from the proposed page, with a
  high-contrast pill or subtle shadow, so nobody mistakes it for part of a
  variant.
- **Gate it on a non-production environment check**, such as
  `process.env.NODE_ENV !== 'production'` or the framework's equivalent. A
  stray prototype merge must not expose the switcher to users.

Keep the switcher in one shared component so either sub-shape can use it.
Follow the project's existing location for shared UI.

### 5. Hand it over

Give the operator the route and the `?variant=` keys. Useful feedback often
combines elements — for example, the header from B and the sidebar from C.
That combination is an answer, not a compromise the prototype failed to
anticipate.

### 6. Capture the answer and clean up

Record which variant won and why, then follow the capture rule in
[SKILL.md](SKILL.md). Fold the winner into real code and keep the full set
of variants on the throwaway branch as the primary source:

- **Sub-shape A** — fold the winner into the existing page; remove the losing
  variants and switcher from main.
- **Sub-shape B** — promote the winner to a real route; remove the throwaway
  route and switcher from main.

Variant components and the switcher rot quickly when left in main. The
throwaway branch preserves the alternatives without confusing the next
reader about what production supports.

## Anti-patterns

- **Variants that differ only in colour or copy.** Those are tweaks, not
  competing structural answers.
- **Sharing too much code between variants.** A shared `<Header>` is fine; a
  shared `<Layout>` defeats the experiment. Let each variant replace the
  layout.
- **Wiring variants to real mutations.** Read-only variants are enough. If a
  variant must mutate, point it at a stub; this prototype answers what the
  UI should look like, not whether the backend works.
- **Promoting prototype code directly to production.** Rewrite the chosen
  design under production constraints, including its proper tests and error
  handling, when folding it in.
