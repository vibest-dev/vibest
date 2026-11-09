import { div, type Element, View } from "gpui-kit"

export default class Gap extends View {
  render(): Element {
    return div().size_full()
  }
}
