import { Mount, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Schema } from "effect"

import { ThemeModeSchema } from "../domain/WebHub.ts"
import { AttachWterm } from "../mounts/DomMounts.ts"
import { IconMaximize, IconRefresh, IconTerminal } from "../ui/icons.ts"
import { buttonClass } from "../ui/primitives.ts"

export function stripAnsiEscapeCodes(input: string): string {
  const esc = String.fromCharCode(27)
  let out = ""
  let idx = 0

  while (idx < input.length) {
    if (input[idx] === esc && input[idx + 1] === "[") {
      idx += 2

      while (idx < input.length && !/[a-zA-Z]/.test(input[idx] ?? "")) {
        idx += 1
      }

      idx += 1
      continue
    }

    out += input[idx] ?? ""
    idx += 1
  }

  return out
}

export const WtermViewMessage = UiSchema.TaggedEnum({
  ChangedWtermStatus: { ready: Schema.Boolean },
  ClickedRefresh: {},
  ClickedExpand: {},
})

export const WtermViewEvents = UiSchema.TaggedEnum({
  RequestedRefresh: {},
  RequestedExpand: {},
})

const WtermViewDef = Html.component({
  name: "WtermView",
  props: Schema.Struct({
    content: Schema.String,
    theme: ThemeModeSchema,
    compact: Schema.Boolean,
    title: Schema.String,
    canExpand: Schema.Boolean,
  }),
  model: Schema.Struct({
    failed: Schema.Boolean,
  }),
  message: WtermViewMessage,
  events: WtermViewEvents,
})

export const WtermView = WtermViewDef.make({
  init: () => ({ failed: false }),
  update: {
    ChangedWtermStatus: ($, { ready }) => $.evolve({ failed: !ready }),
    ClickedRefresh: ($) => $.emit(WtermViewEvents.RequestedRefresh()),
    ClickedExpand: ($) => $.emit(WtermViewEvents.RequestedExpand()),
  },
  view: (h, model) => {
    const { content, theme, compact, title, canExpand } = h.props
    const themeClass = theme === "light" ? "theme-light" : ""

    return h.div
      .attr("data-testid", compact ? "inline-wterm-peek" : "stage-wterm-view")
      .class(
        "flex flex-col overflow-hidden rounded-lg border border-border",
        theme === "light" ? "bg-[#fafafa]" : "bg-[#0c0d10]",
        !compact && "h-full",
      )
      .children(
        h.div
          .class("flex h-7 shrink-0 items-center justify-between border-b border-border bg-muted/40 px-2")
          .children(
            h.span
              .class("inline-flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground")
              .children(IconTerminal(h), h.span.class("truncate").children(title)),
            h.div
              .class("flex items-center gap-0.5")
              .children(
                h.button
                  .attrs({ type: "button", title: "Refresh terminal output", "aria-label": "Refresh terminal output" })
                  .class(buttonClass("ghost", "icon-xs"))
                  .on("click", WtermViewMessage.ClickedRefresh())
                  .children(IconRefresh(h)),
                canExpand &&
                  h.button
                    .attrs({ type: "button", title: "Open in Center Stage", "aria-label": "Open in Center Stage" })
                    .class(buttonClass("ghost", "icon-xs"))
                    .on("click", WtermViewMessage.ClickedExpand())
                    .children(IconMaximize(h)),
              ),
          ),
        model.failed
          ? h.pre
              .class("m-0 overflow-auto p-2.5 font-mono text-xs leading-relaxed text-foreground")
              .children(stripAnsiEscapeCodes(content))
          : h.div
              .class("wterm-host w-full overflow-auto", compact ? "h-48" : "min-h-0 flex-1", themeClass)
              .onMount(
                AttachWterm({ content, compact }).pipe(
                  Mount.map((ready) => WtermViewMessage.ChangedWtermStatus({ ready })),
                ),
              ),
      )
  },
})
