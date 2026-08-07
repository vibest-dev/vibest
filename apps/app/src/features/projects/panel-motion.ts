/**
 * How both sidebar collapsibles animate — the Projects group and each project
 * inside it. Pair it with `keepMounted` on the same panel; the two fix
 * different halves of the same stutter, and the second one is the load-bearing
 * half once a sidebar holds real session counts.
 *
 * **`keepMounted`.** Without it base-ui unmounts the panel's subtree on close
 * (`shouldRender = mounted || open`), so every expand rebuilds every row. At 10
 * projects / 600 sessions that was a 60–80ms long task on each expand — one
 * blocking chunk, which is what reads as "I clicked and it hung". With it, the
 * rows stay in the DOM behind `hidden` + `display:none` (nothing focusable, so
 * no a11y regression) and the long task disappears: eight runs measured a worst
 * frame of 18.6–32.3ms and no long task at all. The cost is ~4000 nodes kept
 * alive; that trade is worth one less blocking chunk per click.
 *
 * **The transition.** `CollapsiblePanel` ships `transition-[height]
 * duration-200` from the vendored component, and `height` is not compositable:
 * every frame of it costs a style recalc + layout of the subtree. On a 39-row
 * sidebar that made a click take 245ms to settle (31ms of it dead before
 * anything moved); riding `opacity` + `translate` instead puts the layout in one
 * shot and settles in 14ms. At 600 rows this part measures as a wash — mount
 * cost dominates there — so it earns its place on the small-sidebar case, not
 * the large one.
 *
 * `cn()` is tailwind-merge, so `transition-[opacity,translate]` replaces the
 * vendored `transition-[height]` and `duration-150` replaces its `duration-200`.
 * The panel's own `h-(--collapsible-panel-height)` and `data-*-style:h-0` stay —
 * they just no longer interpolate, so the height snaps and the motion is
 * composited. One consequence to know: on close the height zeroes immediately
 * and `overflow-hidden` clips the fade, so collapsing reads as instant while
 * expanding fades in. `ai-elements/reasoning.tsx` makes the same trade.
 *
 * Keep this a transition, never a keyframe animation: base-ui's
 * `getAnimationType` warns when a panel has both, and silently picks one.
 */
export const COLLAPSIBLE_PANEL_MOTION: string =
  "transition-[opacity,translate] duration-150 ease-out " +
  "data-starting-style:-translate-y-1 data-starting-style:opacity-0 " +
  "data-ending-style:-translate-y-1 data-ending-style:opacity-0";
