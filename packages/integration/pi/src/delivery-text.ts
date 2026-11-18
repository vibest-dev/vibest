import type { DisplayEntry } from "@vibest/schema/session"

const titled = (agent: string) => (agent === "" ? "" : `${agent.charAt(0).toUpperCase()}${agent.slice(1)}`)

const block = (entry: DisplayEntry) =>
  entry.sender === "vibest"
    ? `Message from Vibest\n${entry.preview}`
    : `Message from @${titled(entry.sender.agent)} · ${entry.sender.title} (${entry.sender.session.slice(0, 8)})\n${entry.preview}`

export const deliveryText = (display: ReadonlyArray<DisplayEntry>) => display.map(block).join("\n\n")
