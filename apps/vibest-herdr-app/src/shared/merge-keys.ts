interface KeyCommand {
  readonly command: string
  readonly args?: unknown
}

type Action = string | KeyCommand

export type Keys = Record<string, Record<string, Action>>

export interface MergedKeys {
  readonly keys: Keys
  readonly kept: readonly string[]
}

export const mergeKeys = (mine: Keys, shipped: Keys): MergedKeys => {
  const keys: Keys = Object.fromEntries(Object.entries(mine).map(([section, bindings]) => [section, { ...bindings }]))
  const kept: string[] = []

  for (const [section, bindings] of Object.entries(shipped)) {
    const into = (keys[section] ??= {})

    for (const [key, action] of Object.entries(bindings)) {
      if (into[key] === undefined) into[key] = action
      else if (JSON.stringify(into[key]) !== JSON.stringify(action)) kept.push(`${section} ${key}`)
    }
  }

  return { keys, kept }
}
