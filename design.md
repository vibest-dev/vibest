---
name: vibest-interface-guidelines
description: "Design, build, or substantially improve a vibest surface. Use for the app shell, session and project navigation, the chat transcript, per-harness tool renderings, the composer and its pickers, permission and plan requests, dialogs, empty and error states, and any new feature that ships pixels in apps/app, apps/desktop's renderer, or packages/ui."
---

# Design interfaces like vibest

Act as an excellent vibest designer, information architect, interaction
designer, and design engineer. Turn the available material into a surface that
belongs to this product. Shape the information and the interface together; do
not merely restyle a stream of events or assemble generic components around it.

## vibest product context

Treat these as first-party operator surfaces. Help a developer supervising a
coding agent in a repository they own understand what the agent read, what it is
about to write, whether it needs an answer, and where the turn is now.

Make the artifact precise, calm, direct, technically literate, evidence-led, and
restrained. Build confidence through legible state, exact evidence, and command
of the material. Never manufacture confidence through decoration, novelty,
celebration, false progress, or animation that implies work that is not
happening.

Start with the operator's job, not the surface category. Identify what they need
to see or decide, the strongest evidence the runtime actually reports, what is
irreversible, and what changes their interpretation of it.

Treat this as a product surface even when it is conversational. Communicate
unmistakable vibest authorship without resembling a consumer chat app, a generic
SaaS dashboard, or a marketing page.

## Use this priority order

When requirements compete, protect them in this order:

1. Preserve truthfulness of state: the phase, the tool input, the result, the
   diff, the failure. Never render a state the runtime has not reported, never
   hide one it has.
2. Preserve the layering contracts in `.agents/rules/` and
   `apps/desktop/AGENTS.md`, the feature boundaries, and the vendored-component
   contract in `docs/adr/0001`.
3. Make the current turn, the pending request, and the operator's next decision
   immediately clear.
4. Establish unmistakable vibest authorship through the shell, the Inter and
   Geist Mono pairing, the neutral token system, and restraint.
5. Choose a composition specific to this material; avoid both generic model
   defaults and a fixed chat template.
6. Refine responsive behavior, interaction, and details without weakening the
   hierarchy.

Ask one grouped set of questions only when proceeding could change what an
approval grants, what a destructive action removes, which session or project a
control acts on, the meaning of a permission mode, or the wire vocabulary in
`CONTEXT.md`. Otherwise omit the unknown, label it honestly, and proceed.

## Integrate with the caller's project

Preserve the host framework, file structure, routes, component conventions,
build system, and output form. Edit the files that naturally own the experience.
Do not force a new filename, a single-file deliverable, raw CSS modules, or a
new framework.

Feature UI lives in `apps/app/src/features/<feature>/components/`. Features never
import each other; a need that crosses two features travels up as a prop through
a composition root — `routes/`, `app-interface.tsx`, `components/layout/`.
`components/` holds only what no single feature owns. There is no `core/`.

Resolve every visual token from `packages/ui/src/globals.css`. It is imported
once, by `apps/app/src/index.css`, which also owns app-only rules. Use the public
API documented below; do not read component implementations to extract internal
class strings. Never inline a hex value, a bare palette class such as
`text-neutral-500`, a one-off `hsl()`, or a redeclared token at a call site.

Base components in `packages/ui/src/components/` are vendored from the coss
registry and refreshed with `--overwrite`, so edits there are discarded. Fix in
the `ai-elements/` wrappers, in the feature, or upstream. `carousel` and
`splitter` are the local exceptions. Composite components in
`packages/ui/src/ai-elements/` are hand-maintained and are where a chat-shaped
pattern belongs once a second feature needs it.

Import through subpaths only; there is no barrel:

```ts
import { Button } from "@vibest/ui/components/button";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { cn } from "@vibest/ui/lib/utils";
```

`packages/ui` sits on Base UI, not Radix: compose with `render={<Button />}`,
never `asChild`. Compose class names with `cn()`; express component variants with
`cva`, as `button.tsx` does. Integration changes syntax, never composition or the
public API.

The default dependency allowlist is what the workspace already ships: React,
TanStack Router and Query, Tailwind v4, Base UI, `lucide-react`, `sonner`,
TipTap, `use-stick-to-bottom`, `streamdown`, and `shiki`. Do not add a second
icon kit, chart library, animation runtime, CSS framework, or component registry
without authorization.

## Work in four passes

### Frame the operator's job

Inspect all available material before designing. Privately establish:

- Who opens this, in what session state — idle, streaming, waiting on a
  permission or plan request, errored, crashed, or reading history?
- What is the strongest evidence the runtime actually reports?
- What must be true at a glance, and what belongs one disclosure away?
- What is destructive or irreversible, and how does the operator tell before
  acting?
- What should remain available for audit without dominating the first read?

Normalize names, paths, ids, counts, phases, and units against `CONTEXT.md`.
Distinguish what the server owns, what the harness reports, and what the client
is still waiting for. Never invent progress, certainty, completion, ownership, or
a result the transport has not delivered. A value the client cannot know yet is
absent or explicitly pending, never faked.

Order by operator need, not event order. Support two reading speeds:

- **Glance path:** which session, which harness, is it running, does anything
  need me?
- **Audit path:** the exact tool input, the exact output, the exact diff, in
  the order they happened.

Every element must answer a new question. Combine duplicates. Remove ceremony.
Keep one home for each fact: a header, a badge, and a status line all repeating
"running" is one idea rendered three times.

### Choose the composition

The first viewport is the work, not chrome followed by setup. Choose the
composition that exposes the session, its current state, and the operator's next
decision with the least mediation. If they saw only this viewport, they should
remember what the agent is doing, not merely which app this is.

Before designing, privately name the obvious layout the surface category would
suggest. Reject it unless the material earns it. A tool result is not
automatically a card; a choice is not automatically a dropdown; a list of
sessions is not automatically a table.

When the material admits multiple structures, privately compare two materially
different composition hypotheses before coding. Change topology, density, and
placement of evidence, not merely which component you reach for.

Match the composition to the job:

- **A live turn:** the transcript is the dominant object; everything else is
  subordinate and must not compete for width or weight.
- **A decision the agent is blocked on:** put the request and its actions at the
  position in the transcript where it happened, not in a modal.
- **A configuration choice:** put the control at the point of decision — the
  composer toolbar for per-turn config, the draft surface for per-session
  config.
- **A collection (projects, sessions):** rank by recency and make identity
  survive truncation.
- **An empty or unavailable state:** state what is true and what the operator
  can do, in one sentence and at most one action.

Choose geometry before components. Map the material to a visual variable:

- Sequence and causality → vertical order on a shared left edge.
- Grouped work inside one turn → one collapsed row expanding into an indented
  rail.
- Command, path, or raw output → monospace block at full content width.
- A change to a file → a diff, never prose describing a diff.
- Nesting or delegation (a subagent) → indentation and containment, not color.
- Peer alternatives (models, modes, harnesses) → aligned rows with identical
  type roles.

Compose the surface as a field, not a stack of components. Establish one
throughline: the transcript reads top to bottom in one column with the composer
pinned below, and every other affordance orbits it. Pace density deliberately —
tool rows are tight, prose breathes, evidence blocks own their width — while
retaining one visual grammar. Repetition creates rhythm only when the repeated
items are true peers; otherwise it creates template noise.

Give every surface one organizing move that belongs to its material and could
not be transplanted unchanged into an unrelated app. It may be the collapsed
tool batch, the request rendered inline where it happened, or a per-harness tool
line that names the file instead of the tool. It must clarify the work, not
decorate it.

Use a squint test: at a glance, the current turn's state and any pending request
must be the most obvious things on screen. Use a text-mask test: with the words
blurred, the hierarchy should still communicate identity, grouping, and
progression. If every block has equal weight, redesign before coding.

Create presence through commitment, not additional effects. When a surface feels
too safe, strengthen one relationship through proportion, hierarchy, density, or
placement, and make supporting content quieter. When the material feels thin,
improve its selection and explanation; leave unsupported gaps honest. Never fill
a gap with panels, borders, icons, color fields, or effects.

### Authoritative vibest visual system

Treat this section as the design authority for these surfaces. Use
`packages/ui/src/globals.css` for exact tokens and the vendored components for
exact states. Use these instructions for composition, hierarchy, and when a
primitive is appropriate. Do not introduce a parallel visual system.

#### Authorship shell

Every completed surface has the same vibest shell: an inset sidebar on the left,
a bordered card panel on the right with a `h-10` header, and one fixed sidebar
toggle whose only moving property is `left`. Route content fills the card below
the header and owns its own scrolling; the document never scrolls.

The header row and the sidebar header are the window drag region; interactive
children opt out. On macOS the top-left of that row belongs to the native
traffic lights — leave it empty and pad around them. New chrome goes in the card
header or the sidebar, never in a floating overlay.

Preserve this composition:

```tsx
<SidebarProvider className="h-svh overflow-hidden [-webkit-app-region:drag]">
  <AppSidebar />
  <SidebarInset className="flex min-h-0 flex-col overflow-hidden border [-webkit-app-region:no-drag]">
    <header className="flex h-10 shrink-0 items-center gap-2 px-4 shadow-[inset_0_-1px_0_var(--color-border)] [-webkit-app-region:drag]">
      …
    </header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  </SidebarInset>
  <SidebarTrigger className="fixed top-[11px] z-30 [-webkit-app-region:no-drag]" />
</SidebarProvider>
```

The sidebar is `16rem` (`18rem` on mobile, `3rem` collapsed to icons) and
carries, in order: the brand row, global actions, then the project and session
list. Do not substitute a second navigation rail, a tab bar, or a top nav.

#### Layout and alignment

The shell is the outer grid. Inside the card, conversation content is one
centered column capped at `max-w-4xl` with `min-w-80`; the width cap lives
inside the scroller so the scrollbar stays at the panel edge. Composer and
transcript share that column and its horizontal padding, so their left edges
align exactly.

Every object aligns to a shared edge or baseline. Peer rows — sessions, tool
lines, config controls — share type roles, icon sizes, and value positions. A
tool's expanded rail aligns under its own header icon. Do not strand content in
a narrow track while the column stands empty, and do not let a wide evidence
block escape the column.

Give flex and grid children `min-w-0` and every flex ancestor of a scroller
`min-h-0`; reflow before shrinking. Long project names, paths, and commands
truncate rather than wrap the shell out of shape — and truncate so the part that
carries identity survives.

#### Typography and rhythm

Use Inter Variable (`--font-sans`) for everything the operator reads: headings,
labels, controls, prose, counts, session names. Use Geist Mono (`--font-mono`)
only for code, commands, file paths, diffs, and short operational identifiers.
Set only the identifier in mono, not its sentence or its whole row.

The interface baseline is `text-sm`; the transcript reads at `text-sm`, and
`text-xs` is for genuinely subordinate metadata. Emphasis is `font-medium`;
heavier weights belong to a surface-defining title only. Do not create arbitrary
font sizes or numeric weights. Equivalent peers always share role, size, weight,
and line height; never resize one because its string is longer or its number is
larger.

Build vertical rhythm from relationships:

- Label → its control: close.
- Message → message: one transcript rhythm (`py-1.5` per message block).
- Tool header → its expanded rail: close, and visually owned by the rail's left
  border.
- Content group → new group: clearly larger.
- Composer → transcript: a fixed gutter that does not grow with content.

Give every gap one owner. The container sets the gap; children do not add
competing margins. Within-group gaps are normally `gap-1` to `gap-2`,
between-group gaps `gap-4` to `gap-6`, panel insets `p-1.5` to `p-2`, and header
alignment `px-4`. These express relationships, not one universal stack rule.

Keep body text at a comfortable reading size; never use tiny dimmed prose to
make density fit. Rewrite before shrinking.

Establish hierarchy through typography before surfaces or color. Write
sentence-case copy that states the action or the fact: buttons name what they
do, errors say what failed and what to do next, empty states say what is true.
Avoid all-caps eyebrows, decorative section numbers, marketing adjectives,
emoji, and internal vocabulary — no `SessionRef`, no harness session id, no
phase tag in a label.

#### Color, surfaces, and boundaries

Design in monochrome. The system is neutral by construction: surfaces are white
or near-black, and separation comes from alpha-based borders and 4–8% overlays,
not from filled panels. Use color only when it adds meaning to state, action, or
data, and pair it with a non-color cue. Do not color a result green because it
succeeded or a number because it is large.

Use only semantic tokens: `background`, `foreground`, `card`, `popover`,
`primary`, `secondary`, `muted`, `accent`, `border`, `input`, `ring`, the
`sidebar*` family, `code*`, the four states `destructive`, `info`, `success`,
`warning` with their `-foreground` pairs, and `chart-1` through `chart-5` for
series. Both themes are defined in `globals.css`; author every change in `:root`
and `.dark` together.

The card is normally one continuous canvas. Earn a surface or boundary only when
it communicates selection, interaction, a target, or a real grouping that
spacing cannot express. Prefer spacing, alignment, typography, and a change in
density before borders or boxes. Do not wrap every message, tool, or section in
a card, and never nest cards. Radii come from `--radius` and its derived
`--radius-sm` through `--radius-4xl`; do not introduce a new curve.

Diagnose quantity separately from intensity. If a surface feels busy, remove,
combine, or reorder content. If it feels loud, reduce competing color, scale,
weight, borders, and motion. Preserve one deliberate anchor; restraint must not
flatten the surface into neutral sameness.

Hard reject decorative gradients, gradient text, glows, blobs, stripes,
textures, grid backgrounds, glass effects, colored side rails, ornamental
shadows, and fake depth.

#### Transcript and evidence

Make the rendering honest. Show the path, the command, the pattern, the counts,
and the failure exactly as reported, near the thing they qualify. Never
summarize away a destructive detail, and never present a truncated output as
complete.

- A user message is a right-aligned `primary` bubble capped at 80% width. An
  assistant message is unbubbled text on the page. The assistant gets no avatar,
  no name plate, and no role label.
- Markdown renders through `Response`; code, command output, and diffs render
  through `CodeBlock` with a language.
- A tool is a `Tool` / `ToolHeader` / `ToolContent` collapsible: one truncated
  summary line with a lucide icon that swaps to a plus/minus affordance on hover
  or open, expanding into a left-ruled indented rail. Consecutive tool and
  reasoning parts batch into one row; a genuinely standalone long-running tool
  may stand alone.
- The header line says what the tool did to what — the file, the command, the
  pattern — not the tool's wire name. Per-harness renderings live in
  `features/chat/{claude-code,codex}/` and must degrade to the dynamic renderer
  for a tool they do not know.
- Permission, plan, and question requests render inline, at the position they
  occurred, with their actions attached, and stay readable after they are
  answered. Destructive approvals use the destructive variants and name what
  will change.
- History that failed to load says so and says the agent still holds its own
  context; it does not render as an empty conversation.

#### Composer and interaction

Treat the composer as an instrument, not a text box. Typing is never blocked;
sending is blocked while a turn is in flight, and content survives a refused
submit. Enter sends, Shift+Enter breaks the line, IME composition is respected.

Keep the composer, its toolbar, and its submit in one coherent subtree:
`PromptInput` owns the editor, then `PromptInputToolbar` with
`PromptInputTools` on the left and `PromptInputSubmit` on the right. Per-turn
config — harness, model, reasoning effort, permission mode — lives in that
toolbar, collapses to an icon once settled, and cascades: a control that the
selected harness or model does not offer is absent, not disabled-and-mysterious.

One control owns each choice. Defaults come from the harness's own declaration;
the surface adds only what no harness can answer. Pickers state the current
value in full and never depend on hover to reveal it.

Use native and vendored controls with accessible names, visible focus, and
`Button`'s `loading` prop rather than a replaced label. Disabled controls keep
their label at `opacity-64`, and a control disabled by state says why. Transient
outcomes use `sonner` toasts, mounted once in `app-interface.tsx` — never a
toast for something the transcript already shows.

#### Motion and delight

Default to stillness. The sanctioned motion is functional and already defined:
the 200ms `ease-linear` sidebar, toggle, and padding transitions; collapsible
open and close; `Shimmer` on the trailing batch while a turn is genuinely
streaming; `--animate-skeleton` while data loads; `--animate-caret-blink` in the
editor; the toast animations.

Never add auto-scrolling marquees, simulated typing cursors, decorative pulsing
status dots, indeterminate percentages, scroll reveals, parallax, bounce, or
sound. Never gate reading behind animation. Keep the base experience complete
without motion and respect reduced-motion.

Create delight through unusually clear state and unusually low friction: a tool
line that answers the question before it is expanded, a request answerable
without leaving the transcript, a session that resumes exactly where it was. Do
not manufacture personality with jokes, celebration, Easter eggs, or effects.

#### Media and icons

Use `lucide-react` and nothing else. An icon must make an action or a tool
faster to recognize; it never replaces a label the operator needs, and it never
sits in a colored tile. Icon sizes come from the component that owns them —
`size-4` in transcript and tool lines, `Button`'s `icon-*` sizes for controls.
Never add stock imagery, illustrations, abstract shapes, or a mandatory hero.

### Inspect and revise privately

Render the actual result. Two processes — the server and the app's Vite dev
server — per `.claude/skills/verify`; open the app's port, not the server's.
Inspect the first viewport, a long transcript, and both themes, then verify
reflow at a narrow width.

Review in this order:

1. **First read:** is vibest authorship immediate? Would the operator remember
   what the agent is doing rather than only which app this is?
2. **Composition:** is there one dominant object? Does each element advance the
   operator's job? Is any empty space accidental?
3. **Typography:** are roles consistent, peer values equal, edges aligned, and
   is vertical rhythm relational rather than uniform? Does each gap have one
   owner?
4. **Evidence:** does the rendering prove what happened? Are paths, commands,
   and diffs exact? Is anything repeated without a new question?
5. **States:** idle, streaming, pending request, error, crashed, empty, and
   history-unavailable all render deliberately — not just the happy path.
6. **Restraint:** can any surface, border, badge, icon, label, or line be
   removed without losing meaning, affordance, or rhythm? If yes, remove it.
7. **Trust and access:** semantics, focus, accessible names, keyboard reach, and
   truncation that preserves identity.

Then run the gates: `pnpm check` for lint, format, and typecheck, and `pnpm
doctor` in `apps/app` for React health.

Fix the highest-impact systemic defect, render again, and repeat until no known
material visual or usability issue remains. Keep this work internal. Deliver the
requested implementation, not a score, process diary, or self-critique.

## Reject generated-design reflexes

Do not ship any of these recognizable defaults:

- A card around every message, tool, or section; cards nested inside cards.
- Avatars, name plates, or role labels on assistant turns.
- Badges, pills, or rounded capsules for ordinary metadata such as model, path,
  count, or timestamp.
- A colored status dot as the only signal of state.
- All-caps or tracked eyebrows, kickers, overlines, and decorative section
  numbers.
- Emoji in UI copy, headings, or in place of icons; icons from a second kit.
- Icon tiles, oversized icons, or an icon standing in for a needed label.
- Decorative gradients, glows, blobs, stripes, textures, glass, or ornamental
  shadows.
- A generic centered hero followed by a card grid.
- Repeated metric boxes where one composed relationship would be clearer.
- A modal for anything that belongs in the transcript or the composer.
- Fake progress bars, indeterminate percentages, or a thinking animation while
  nothing is streaming.
- Tiny dimmed prose, arbitrary font sizes, inconsistent peer values, or
  misaligned edges.
- Raw hex values, bare palette classes, or a token redeclared at a call site.
- Truncation that discards the identifying end of a path or command.
- A cross-feature import dressed up as reuse, or a new component that duplicates
  a vendored one.
- Authoring-process narration in the UI: how the view was organized, why a
  representation was chosen, or what the code does internally.

Do not compensate for avoiding these defaults by producing a sterile anti-design
template. vibest restraint is precise hierarchy, excellent typography, honest
state, tight alignment, and deliberate density. It is not merely grey text,
thin rules, and empty margins.

## Use the published component and token API

Use semantic HTML and only the primitives the material earns.

The base components (`@vibest/ui/components/*`) are:

`accordion`, `alert`, `alert-dialog`, `autocomplete`, `avatar`, `badge`,
`breadcrumb`, `button`, `calendar`, `card`, `carousel`, `checkbox`,
`checkbox-group`, `collapsible`, `combobox`, `command`, `context-menu`,
`dialog`, `drawer`, `empty`, `field`, `fieldset`, `form`, `frame`, `group`,
`input`, `input-group`, `kbd`, `label`, `menu`, `meter`, `number-field`,
`otp-field`, `pagination`, `popover`, `preview-card`, `progress`, `radio-group`,
`scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`,
`spinner`, `splitter`, `switch`, `table`, `tabs`, `textarea`, `toast`, `toggle`,
`toggle-group`, `toolbar`, `tooltip`, `tiptap/*`.

The composite components (`@vibest/ui/ai-elements/*`) are:

`actions`, `branch`, `code-block`, `collapsible-user-text`, `image`,
`inline-citation`, `loader`, `message`, `prompt-input`, `reasoning`, `response`,
`shimmer`, `sources`, `suggestion`, `task`, `tool`, `web-preview`.

Use these primitives according to their semantic names. A `Tool` owns its
`ToolHeader` and `ToolContent`. A `Message` owns one `MessageContent`. A
`PromptInput` owns its editor, `PromptInputToolbar`, `PromptInputTools`, and
`PromptInputSubmit`. A `Conversation` owns its `ConversationContent` and
`ConversationScrollButton`. Do not interpose decorative wrappers, restyle a
vendored control inline to fake a new variant, or reimplement a primitive that
already exists.

`Button` variants are `default`, `secondary`, `outline`, `ghost`, `link`,
`destructive`, and `destructive-outline`; sizes are `xs`, `sm`, `default`, `lg`,
`xl` with matching `icon-xs`, `icon-sm`, `icon`, `icon-lg`, `icon-xl`. Use
`default` for the single primary action in a region, `ghost` for icon and
toolbar actions, and the destructive pair only for irreversible ones.

If no primitive fits, build it in the feature that owns it and promote it to
`ai-elements/` only when a second feature needs it. Never extract an internal
class string from a vendored component or extrapolate a variant name from
another one.

Surface CSS may read only these public token families:

- Surfaces and text: `--color-background`, `--color-foreground`, `--color-card`,
  `--color-card-foreground`, `--color-popover`, `--color-popover-foreground`,
  `--color-muted`, `--color-muted-foreground`, `--color-accent`,
  `--color-accent-foreground`, `--color-code`, `--color-code-foreground`,
  `--color-code-highlight`.
- Actions: `--color-primary`, `--color-primary-foreground`,
  `--color-secondary`, `--color-secondary-foreground`, `--color-destructive`,
  `--color-destructive-foreground`.
- Status: `--color-info`, `--color-info-foreground`, `--color-success`,
  `--color-success-foreground`, `--color-warning`, `--color-warning-foreground`.
- Borders and state: `--color-border`, `--color-input`, `--color-ring`.
- Navigation: `--color-sidebar`, `--color-sidebar-foreground`,
  `--color-sidebar-primary`, `--color-sidebar-primary-foreground`,
  `--color-sidebar-accent`, `--color-sidebar-accent-foreground`,
  `--color-sidebar-border`, `--color-sidebar-ring`, `--sidebar-width`,
  `--sidebar-width-icon`.
- Data: `--color-chart-1` through `--color-chart-5`.
- Shape: `--radius`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`,
  `--radius-2xl`, `--radius-3xl`, `--radius-4xl`.
- Type: `--font-sans`, `--font-mono`, `--font-heading`.
- Motion: `--animate-skeleton`, `--animate-caret-blink`, and the toast
  animations.

Prefer the Tailwind classes these tokens generate — `bg-background`,
`text-muted-foreground`, `border-border`, `ring-ring`, `rounded-lg`,
`font-mono` — and reach for `var()` only where a class cannot express it, as the
shell's header shadow does. Never invent, alias, or redeclare a token. Prefer
`currentColor`, `inherit`, or `transparent` when a mark needs no semantic role.
Rhythm uses Tailwind's spacing scale; there is no separate space token family.

## Accessibility and responsive behavior

Use landmarks, one descriptive heading per surface, ordered headings, native
controls, accessible names on every icon-only button, `aria-disabled` alongside
`disabled` while a control is busy, visible focus, and text alternatives. Meet
WCAG AA and never rely on color alone. Treat source order as reading order.
Keyboard must reach every action in the composer, every pending request, and
every item in the sidebar; `Escape` closes what it opened.

Do not conceal overflow. Give flex and grid children `min-width: 0` and every
scroller's ancestors `min-height: 0`; reflow before shrinking, and never
introduce a horizontal document scroll — code, tables, and command output scroll
locally. The sidebar collapses offcanvas on narrow screens and the shell must
stay usable without it. Preserve readable type and control sizes; coarse
pointers get the larger step the vendored controls already define.

Both themes are authored in `globals.css` and must have equivalent hierarchy and
contrast. No visible theme switcher is part of this system today: nothing sets
the `dark` class, so keep authoring both sets and do not add a switcher as a side
effect of another feature.

The target is vibest judgment, not vibest decoration.
