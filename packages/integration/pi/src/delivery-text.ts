import type { Detail } from "@vibest/schema/session"

const PREVIEW = 120

const titled = (agent: string) => (agent === "" ? "" : `${agent.charAt(0).toUpperCase()}${agent.slice(1)}`)

const clip = (s: string) => {
  const cps = [...s]

  return cps.length <= PREVIEW ? s : `${cps.slice(0, PREVIEW - 1).join("")}…`
}

const remote = (address: string) => {
  const slash = address.indexOf("/")

  if (slash <= 0) return `Message from @${titled(address)}`

  const machine = address.slice(0, slash)
  const id = address.slice(slash + 1, slash + 9)

  return `Message from @${titled(machine)} · (${machine}/${id})`
}

const head = (sender: Detail["sender"]) => {
  if (sender === "vibest") return "Message from Vibest"

  if (sender === "user") return "Message from You"

  if ("machine" in sender)
    return `Message from @${titled(sender.agent)} · ${sender.title} (${sender.machine}/${sender.session.slice(0, 8)})`

  if ("address" in sender) return remote(sender.address)

  return `Message from @${titled(sender.agent)} · ${sender.title} (${sender.session.slice(0, 8)})`
}

const firstLine = (message: string) => message.trim().split("\n")[0] ?? ""

export const deliveryText = (detail: ReadonlyArray<Detail>) =>
  detail.map((entry) => `${head(entry.sender)}\n${clip(firstLine(entry.message))}`).join("\n\n")
