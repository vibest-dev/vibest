# UI component design

Distilled from the **Component Spec** (https://www.components.build, Hayden
Bleasel + shadcn). Applies whenever creating or reviewing a React component,
designing a component API, or styling with cn/CVA/data-attributes. Core
principles: composable, accessible by default, themeable, lightweight,
transparent, well-documented.

## Taxonomy — name the artifact before building it

| Artifact      | Test                                                              |
| ------------- | ----------------------------------------------------------------- |
| **Primitive** | Single behavior/a11y concern, zero styling (Radix, Base UI)       |
| **Component** | Styled, reusable, override-friendly; wraps primitives             |
| **Pattern**   | Documented recurring solution, independent of implementation      |
| **Block**     | Opinionated product-use-case composition; copied, never imported  |
| **Page**      | Blocks arranged for one route                                     |
| **Template**  | Multi-page scaffold with routing/providers; fork, don't depend on |
| **Utility**   | Non-visual helper (hooks, class utils); side-effect free          |

Blocks trade generality for adoption speed: strong defaults, domain logic
stubbed via handlers, data via props — never hidden fetches.

## Composition — compound components

Never cram a widget into one component with a `data` prop and a dozen config
props. Split into focused subcomponents sharing state through context:

```tsx
<Accordion.Root open={open} setOpen={setOpen}>
  <Accordion.Item>
    <Accordion.Trigger>Title</Accordion.Trigger>
    <Accordion.Content>Body</Accordion.Content>
  </Accordion.Item>
</Accordion.Root>
```

Standard names — don't invent synonyms: `Root` (container, owns context),
`Trigger` (initiates action), `Content` (shown/hidden body), `Item` (one entry),
`Header`/`Body`/`Footer` (structure), `Title`/`Description` (information).

## Types — one component, one element

Each exported component wraps **a single element**. A component rendering a
header div + title h2 + footer div can't be restyled or re-structured without
prop explosion — make each layer its own component.

- Extend the native attributes of the wrapped element:
  `type CardRootProps = React.ComponentProps<"div"> & { variant?: ... }`
- **Spread props last** so callers can override defaults:
  `<div className="default" {...props} />` — never the reverse. (Exception:
  `className` goes through `cn(...)` with the caller's value last.)
- Export every prop type, named `<ComponentName>Props`.
- Don't shadow HTML attributes: `heading`, not `title`.
- Document custom props with JSDoc (`/** Whether the dialog is open */`).

## State — support controlled AND uncontrolled

Professional components accept the triad `value` / `defaultValue` /
`onValueChange` and merge the two modes with `useControllableState`
(`@radix-ui/react-use-controllable-state` — the hook Radix uses internally):

```tsx
const [value, setValue] = useControllableState({
  prop: controlledValue,
  defaultProp: defaultValue,
  onChange: onValueChange,
});
```

## Styling — cn, ordering, CVA

`cn = twMerge(clsx(...))`: clsx for conditionals, tailwind-merge to resolve
conflicting utilities (last one wins). Class order is fixed:

```tsx
className={cn(
  "base-styles",             // 1. base
  buttonVariants({ variant, size }), // 2. variants (CVA, defined OUTSIDE the component)
  isOpen && "bg-accent",     // 3. state conditionals
  className,                 // 4. caller override — always last
)}
```

Colors and spacing come from semantic design tokens (`--background`,
`--primary`, `--primary-foreground`…), never hardcoded values — tokens name
what something *is*, not how it looks, so themes swap under them. For dynamic
values use CSS variables (`bg-[var(--color)]` + `style={{ "--color": x }}`),
never interpolated class names.

## Data attributes — state and identity, not className props

Never expose per-state className props (`openClassName`, `classes={{...}}`).
Expose state as attributes and let consumers style with selectors:

| Mechanism    | Carries                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `data-state` | Visual/layout state: `open`/`closed`, `active`, loading, `data-orientation`, `data-side`     |
| `data-slot`  | Stable identity for parent/global targeting — kebab-case, purpose-named (`submit-button`, not `blueButton`) |
| props        | Variants (`variant`, `size`), behavior config, event handlers                                 |

```tsx
<div data-slot="dialog" data-state={isOpen ? "open" : "closed"} ... />
// consumer: className="data-[state=open]:animate-in"
// parent:   className="has-[>[data-slot=checkbox-group]]:gap-3"
```

## Polymorphism — asChild and as

`asChild` (Radix `Slot`) merges the component's props/handlers/ref onto its
single child instead of rendering the default element:
`const Comp = asChild ? Slot : "button"`. Rules: exactly one child, never a
fragment; the child must spread received props onto its element. Prefer
`asChild` when composing with components; a typed `as` prop
(`PolymorphicProps<E extends React.ElementType>`) suffices for
element-switching only. Either way: default to the semantic element
(`"button"`, `"nav"`), not `"div"`, and mind HTML nesting (no button-in-button,
no div-in-p). In this repo, `packages/ui` sits on Base UI: the equivalent is
`render={<Button/>}` (see stack.md).

## Accessibility floor

Non-negotiable on every component: semantic HTML first (ARIA only where HTML
can't); a complete keyboard map (Arrows/Home/End/Escape per widget role);
accessible names on icon-only buttons; `:focus-visible` indicators; state via
`aria-expanded`/`aria-checked`/`aria-selected`; never convey information by
color alone; 44px minimum touch targets; labels, not placeholders.

## Review checklist

Every item verified, or named as a deliberate exception:

- [ ] One element per exported component; native attributes extended; props spread last
- [ ] `<Name>Props` types exported; no HTML-attribute name collisions
- [ ] Compound structure with standard subcomponent names; shared state in context
- [ ] Stateful values accept `value`/`defaultValue`/`onValueChange`
- [ ] `cn` ordering: base → variants → conditionals → `className`
- [ ] State on `data-state`, identity on `data-slot`; no per-state className props
- [ ] Colors/spacing from design tokens
- [ ] Keyboard map complete; accessible names present; semantic elements used
