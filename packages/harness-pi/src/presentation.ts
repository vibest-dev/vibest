import { type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent"
import { Text, TuiAltScreen } from "@earendil-works/pi-tui"
import { Detail } from "@vibest/schema/session"
import { Option, Predicate, Schema } from "effect"

import { deliveryText } from "./delivery-text.ts"
import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

const decodeDetail = Schema.decodeUnknownOption(Schema.Array(Detail))

export default (api: ExtensionAPI) => {
  toolGroups(api)
  compactUserMessages(api, { UserMessageComponent, TuiAltScreen })
  api.registerMessageRenderer("vibest", (message) => {
    const details = message.details

    if (!Predicate.isObjectOrArray(details) || !Predicate.hasProperty(details, "detail")) return undefined
    const detail = decodeDetail(details.detail)

    return Option.isNone(detail) ? undefined : new Text(deliveryText(detail.value))
  })
}
