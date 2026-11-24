import type { SessionRef } from "@vibest/schema/terminal"

export const parseSessionRef = (input: string): SessionRef => {
  const at = input.indexOf("/")

  return at <= 0 ? { id: input } : { id: input.slice(at + 1), machine: input.slice(0, at) }
}
