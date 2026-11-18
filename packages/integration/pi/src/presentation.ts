import { type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent"
import { Text, TuiAltScreen } from "@earendil-works/pi-tui"
import { DisplayEntry } from "@vibest/schema/session"
import { Option, Predicate, Schema } from "effect"

import { deliveryText } from "./delivery-text.ts"
import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

const decodeDisplay = Schema.decodeUnknownOption(Schema.Array(DisplayEntry))

export default (api: ExtensionAPI) => {
  toolGroups(api)
  compactUserMessages(api, { UserMessageComponent, TuiAltScreen })
  api.registerMessageRenderer("vibest", (message) => {
    const details = message.details

    if (!Predicate.isObjectOrArray(details) || !Predicate.hasProperty(details, "display")) return undefined
    const display = decodeDisplay(details.display)

    return Option.isNone(display) ? undefined : new Text(deliveryText(display.value))
  })
}
