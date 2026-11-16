import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

export default (api: ExtensionAPI) => {
  toolGroups(api)
  compactUserMessages(api)
}
