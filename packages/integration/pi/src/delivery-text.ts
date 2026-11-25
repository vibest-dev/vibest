import type { Detail } from "@vibest/schema/session"

const PREVIEW = 120

const titled = (agent: string) => (agent === "" ? "" : `${agent.charAt(0).toUpperCase()}${agent.slice(1)}`)

const clip = (s: string) => {
  const cps = [...s]

  return cps.length <= PREVIEW ? s : `${cps.slice(0, PREVIEW - 1).join("")}…`
}

const agentHead = (sender: Extract<Detail["sender"], { readonly type: "agent" }>) => {
  const id = sender.session.slice(0, 8)

  if (sender.agent !== undefined)
    return `Message from @${titled(sender.agent)} · ${sender.title ?? ""} (${sender.machine === undefined ? id : `${id} on ${sender.machine}`})`

  return sender.machine === undefined
    ? `Message from @${titled(id)}`
    : `Message from @${titled(sender.machine)} · (${id} on ${sender.machine})`
}

const head = (sender: Detail["sender"]) => {
  switch (sender.type) {
    case "vibest":
      return "Message from Vibest"
    case "user":
      return "Message from You"
    case "plugin":
      return `Message from Vibest · ${sender.plugin}`
    case "agent":
      return agentHead(sender)
  }
}

const firstLine = (message: string) => message.trim().split("\n")[0] ?? ""

export const deliveryText = (detail: ReadonlyArray<Detail>) =>
  detail.map((entry) => `${head(entry.sender)}\n${clip(firstLine(entry.message))}`).join("\n\n")
