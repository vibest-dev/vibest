export type KeyPayload = {
  readonly key: string
  readonly mods: string
  readonly consumed_mods: string
  readonly text: string
  readonly unshifted_codepoint: number
  readonly composing: boolean
  readonly action: "press" | "release"
}

const NAMED = new Map([
  ["enter", "enter"],
  ["return", "enter"],
  ["esc", "escape"],
  ["escape", "escape"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["up", "arrow_up"],
  ["down", "arrow_down"],
  ["left", "arrow_left"],
  ["right", "arrow_right"],
])

const keyOf = (name: string): Omit<KeyPayload, "action"> | undefined => {
  const lower = name.toLowerCase()
  const named = NAMED.get(lower)

  if (named !== undefined)
    return { key: named, mods: "", consumed_mods: "", text: "", unshifted_codepoint: 0, composing: false }
  const ctrl = /^(?:ctrl|c)[+-]([a-z])$/.exec(lower)?.[1]

  if (ctrl === undefined) return undefined

  return {
    key: `key_${ctrl}`,
    mods: "ctrl",
    consumed_mods: "",
    text: "",
    unshifted_codepoint: ctrl.charCodeAt(0),
    composing: false,
  }
}

export const keyEvents = (name: string): ReadonlyArray<KeyPayload> | undefined => {
  const key = keyOf(name)

  return key === undefined
    ? undefined
    : [
        { ...key, action: "press" },
        { ...key, action: "release" },
      ]
}
