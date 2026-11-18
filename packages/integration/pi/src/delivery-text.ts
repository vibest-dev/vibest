import type { Detail } from "@vibest/schema/session"

const PREVIEW = 120

const titled = (agent: string) => (agent === "" ? "" : `${agent.charAt(0).toUpperCase()}${agent.slice(1)}`)

const clip = (s: string) => {
  const cps = [...s]

  return cps.length <= PREVIEW ? s : `${cps.slice(0, PREVIEW - 1).join("")}…`
}

const head = (sender: Detail["sender"]) => {
  if (sender === "vibest") return "Message from Vibest"

  if (sender === "user") return "Message from You"

  return `Message from @${titled(sender.agent)} · ${sender.title} (${sender.session.slice(0, 8)})`
}

const firstLine = (message: string) => message.trim().split("\n")[0] ?? ""

export const deliveryText = (detail: ReadonlyArray<Detail>) =>
  detail.map((entry) => `${head(entry.sender)}\n${clip(firstLine(entry.message))}`).join("\n\n")
