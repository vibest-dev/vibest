# Accessibility patterns

Full patterns from the Component Spec (`components.build/accessibility`). The
floor (semantic HTML, keyboard map, accessible names, focus-visible, color
independence, touch targets) is in `.agents/rules/ui-components.md`; this file
holds the per-widget implementations.

## ARIA ground rules

1. Don't use ARIA if semantic HTML can do it.
2. Don't change native semantics unless necessary.
3. Every interactive element is keyboard accessible.
4. Never hide focusable elements from assistive tech.
5. Every interactive element has an accessible name.

Attribute families: **roles** (`role="menu"`, landmark roles with `aria-label`,
`role="alert"`), **states** (`aria-checked`, `aria-expanded` +
`aria-controls`, `aria-selected`), **properties** (`aria-label`,
`aria-describedby`, `aria-required`, `aria-invalid` + `aria-errormessage`).

## Widget keyboard maps

| Widget   | Keys                                                                     |
| -------- | ------------------------------------------------------------------------ |
| Menu     | ArrowDown/ArrowUp move, Home/End jump, Enter/Space activate, Escape close |
| Dropdown | ArrowDown opens + focuses first item; Escape closes and resets selection  |
| Tabs     | ArrowLeft/ArrowRight cycle (wrap), Home/End jump; focus follows selection |
| Dialog   | Escape closes; Tab is trapped inside                                      |

## Dialog / modal

The five obligations, in order:

1. `role="dialog" aria-modal="true" aria-labelledby={titleId}`.
2. On open: save `document.activeElement`, focus the first focusable element
   inside, lock body scroll.
3. Trap Tab: shift+Tab on the first focusable wraps to the last, Tab on the
   last wraps to the first (focusable selector:
   `'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'`).
4. Escape calls `onClose`.
5. On close: restore focus to the saved element, unlock scroll (also in the
   effect cleanup, so unmount restores too).

## Tabs

Roving tabindex: only the active tab has `tabIndex={0}`, the rest `-1`; arrow
keys move `activeTab` **and** call `.focus()` on the new tab. Wire
`role="tab" aria-selected aria-controls={panelId}` on triggers and
`role="tabpanel" aria-labelledby={tabId} hidden={!active} tabIndex={0}` on
panels.

## Forms

- Every input has a persistent `<label htmlFor>`; a placeholder is not a label.
- Errors: `aria-invalid={!!error}` + `aria-describedby` pointing at the error
  element, which has `role="alert"`.
- Group related controls in `<fieldset>` + `<legend>`.
- Prefer `aria-disabled` + explanation over `disabled` on submit buttons —
  `disabled` elements are unfocusable, so screen-reader users can't discover
  *why* they're blocked.

## Live regions

- `role="status" aria-live="polite"` for non-urgent updates (saved, loaded).
- `role="alert"` (assertive) for errors only.
- Loading: `aria-live="polite" aria-busy={isLoading}`.
- Progress: `role="progressbar" aria-valuenow/-min/-max` + an `sr-only`
  percentage text.

## Focus management hooks

- `useFocusTrap(ref, isActive)` — the Tab-wrap listener from the dialog
  pattern, as a reusable hook.
- `useRestoreFocus()` — `saveFocus()` stashes `document.activeElement`,
  `restoreFocus()` returns to it.
- CSS: style `:focus-visible` (keyboard), not `:focus` — but never remove
  outlines without a replacement.

## Contrast and visual

WCAG minimums: 4.5:1 normal text, 3:1 large text (≥18pt / ≥14pt bold) and
non-text elements (icons, borders). Use `rem` font sizes so user preferences
apply. Never block zoom (`maximum-scale=1` / `user-scalable=no` in the viewport
meta is forbidden). Touch targets ≥44×44px — pad small icons with an invisible
`::before` hit area.

## Pitfall quick-list

- Icon-only button → `aria-label` on the button, `aria-hidden="true"` on the icon.
- Color-only error indication → add icon/text + `aria-invalid`.
- `<div onClick>` → `<button>`; if a div is unavoidable: `role="button"
  tabIndex={0}` + Enter/Space key handling.
- Dynamic content appearing without announcement → wrap in a live region.
