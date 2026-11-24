import type { SessionRef } from "@vibest/schema/terminal"

export const parseSessionRef = (input: string): SessionRef => {
  const at = input.indexOf("/")

  return at <= 0 || at === input.length - 1 ? { id: input } : { id: input.slice(at + 1), machine: input.slice(0, at) }
}
