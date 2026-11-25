import { v_flex } from "gpui-base"
import { type AsyncContext, type Context, div, type Element, View } from "gpui-kit"
import { checking } from "herdr"

import { startMain, startRequest } from "../../shared/session-ui.ts"
import { SMALL, TEXT } from "../../shared/text-size.ts"
import { type Theme, themeColors } from "../../shared/theme-colors.ts"
import { LOCAL } from "../../shared/vibest-model.ts"
import { type HarnessChoice, harnesses } from "../../shared/vibest-source.ts"

const WIDTH = 320
const ROW = 32

export default class Start extends View {
  choices: HarnessChoice[]
  starting: string | null
  note: string

  init(_props: Record<string, never>, cx: AsyncContext): void {
    this.choices = []
    this.starting = null
    this.note = ""

    if (checking()) return

    cx.spawn(async (task) => {
      this.choices = await harnesses().catch((): HarnessChoice[] => [])
      task.notify()
    })
  }

  start(harness: string, cx: Context): void {
    const request = startRequest()

    if (!request || this.starting) return

    this.starting = harness
    this.note = ""
    cx.spawn(async (task) => {
      await startMain(request, harness).catch((error: Error) => {
        this.note = error.message
      })
      this.starting = null
      task.notify()
    })
    cx.notify()
  }

  row(t: Theme, choice: HarnessChoice): Element {
    const usable = choice.problem === null && this.starting === null

    return div()
      .id(`harness-${choice.harness}`)
      .h(ROW)
      .px(16)
      .flex()
      .items_center()
      .rounded(8)
      .border(1)
      .border_color(t.border)
      .text_size(TEXT())
      .text_color(usable ? t.foreground : t.dim)
      .when(usable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_, cx) => {
        if (usable) this.start(choice.harness, cx)
      })
      .child(this.starting === choice.harness ? `Starting ${choice.harness}…` : choice.harness)
  }

  render(): Element {
    const t = themeColors()
    const request = startRequest()
    const here = request?.machine === LOCAL

    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .bg(t.background)
      .child(
        v_flex()
          .w(WIDTH)
          .gap(8)
          .child(
            div()
              .text_size(TEXT())
              .font_semibold()
              .text_color(t.foreground)
              .child(request?.label ?? ""),
          )
          .child(
            div()
              .pb(8)
              .text_size(SMALL())
              .text_color(t.muted)
              .child(
                here
                  ? "No main conversation is running. Pick a harness to start one."
                  : `No main conversation is running on ${request?.machine ?? ""}.`,
              ),
          )
          .when(here, (el) => el.children(this.choices.map((c) => this.row(t, c))))
          .when(this.note !== "", (el) => el.child(div().text_size(SMALL()).text_color(t.blocked).child(this.note))),
      )
  }
}
