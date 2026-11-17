import { type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent"
import { TuiAltScreen } from "@earendil-works/pi-tui"

import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

export default (api: ExtensionAPI) => {
  toolGroups(api)
  compactUserMessages(api, { UserMessageComponent, TuiAltScreen })
}
