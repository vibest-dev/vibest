import type { Registration, Transform } from "@vibest/plugin"
import { Context, Effect, Exit, Scope } from "effect"

export type { Registration, Transform }

export interface Failure {
  readonly state: string
  readonly cause: unknown
}

type Grouped = {
  readonly remove: () => boolean
  readonly notify: Effect.Effect<void>
}

type Group = {
  failed: boolean
  readonly registrations: Set<Grouped>
  readonly report: (failure: Failure, refresh: Effect.Effect<void>) => void
}

const CurrentGroup = Context.Reference<Group | undefined>("vibest/Registry/CurrentGroup", {
  defaultValue: () => undefined,
})

type Batch = {
  active: boolean
  readonly shutdown: boolean
  readonly notifications: Set<Effect.Effect<void>>
}

const CurrentBatch = Context.Reference<Batch | undefined>("vibest/Registry/CurrentBatch", {
  defaultValue: () => undefined,
})

export const group = (report: Group["report"]) => {
  const current: Group = { failed: false, registrations: new Set(), report }
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentGroup, current)
}

const disable = (current: Group, failure: Failure) => {
  if (current.failed) return
  current.failed = true
  const notifications = new Set<Effect.Effect<void>>()
  for (const registration of current.registrations) {
    registration.remove()
    notifications.add(registration.notify)
  }
  current.report(
    failure,
    Effect.forEach(notifications, (notify) => notify, { discard: true }),
  )
}

const runBatch = <A, E, R>(effect: Effect.Effect<A, E, R>, shutdown: boolean) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const current = yield* CurrentBatch
      if (current?.active && !shutdown) return yield* restore(effect)
      const batch: Batch = { active: true, shutdown, notifications: new Set() }
      const exit = yield* restore(effect.pipe(Effect.provideService(CurrentBatch, batch))).pipe(Effect.exit)
      batch.active = false
      const notified = yield* Effect.forEach(batch.notifications, (notify) => restore(notify).pipe(Effect.exit))
      yield* Exit.asVoidAll([exit, ...notified])
      return yield* exit
    }),
  )

export const batch = <A, E, R>(effect: Effect.Effect<A, E, R>) => runBatch(effect, false)

export const shutdown = <A, E, R>(effect: Effect.Effect<A, E, R>) => runBatch(effect, true)

export interface Options<State, Editor> {
  readonly name: string
  readonly initial: () => State
  readonly editor: (state: State) => Editor
  readonly notify?: (state: State) => Effect.Effect<void>
}

export interface Registry<State, Editor> {
  readonly get: () => State
  readonly transform: Transform<Editor>
  readonly reload: () => Effect.Effect<void>
}

class RegistryMisuse extends Error {}

export const make = <State, Editor>(options: Options<State, Editor>): Registry<State, Editor> => {
  let state = options.initial()
  const transforms = new Set<{ readonly run: (editor: Editor) => void; readonly group: Group | undefined }>()
  let dirty = false
  let closed = false
  let building = false
  let version = 0

  const invalidate = () => {
    dirty = true
    version++
  }

  const refuseWhileBuilding = (what: string) => {
    if (building) throw new RegistryMisuse(`${options.name}: ${what} inside a transform of the same registry`)
  }

  const get = () => {
    if (closed || !dirty) return state
    for (;;) {
      const started = version
      const next = options.initial()
      const editor = options.editor(next)
      building = true
      try {
        for (const transform of transforms) {
          try {
            transform.run(editor)
          } catch (cause) {
            if (!transform.group || cause instanceof RegistryMisuse) throw cause
            disable(transform.group, { state: options.name, cause })
          }
          if (version !== started) break
        }
      } finally {
        building = false
      }
      if (version !== started) continue
      state = next
      dirty = false
      return state
    }
  }

  const notify: Effect.Effect<void> = Effect.suspend(() => {
    if (closed) return Effect.void
    const value = get()
    return options.notify ? options.notify(value) : Effect.void
  })

  const changed = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (closed) return
      invalidate()
      const current = yield* CurrentBatch
      if (current?.active) {
        if (current.shutdown) {
          closed = true
          return
        }
        current.notifications.add(notify)
        return
      }
      yield* restore(notify)
    }),
  )

  const transform: Transform<Editor> = (run) =>
    Effect.gen(function* () {
      refuseWhileBuilding("transform registered")
      const scope = yield* Scope.Scope
      const current = yield* CurrentGroup
      if (current?.failed) return { dispose: Effect.void } satisfies Registration
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const entry = { run, group: current }
          const registration: Grouped = {
            remove: () => {
              if (!transforms.delete(entry)) return false
              current?.registrations.delete(registration)
              invalidate()
              return true
            },
            notify: changed,
          }
          const dispose = Effect.uninterruptible(
            Effect.suspend(() => {
              refuseWhileBuilding("transform disposed")
              return registration.remove() ? changed : Effect.void
            }),
          )
          transforms.add(entry)
          current?.registrations.add(registration)
          yield* Scope.addFinalizer(scope, dispose)
          yield* changed
          return { dispose } satisfies Registration
        }),
      )
    })

  return {
    get,
    transform,
    reload: () =>
      Effect.suspend(() => {
        refuseWhileBuilding("reload")
        return changed
      }),
  }
}

export interface Keyed {
  readonly id: string
}

export interface ListEditor<D extends Keyed> {
  list(): ReadonlyArray<D>
  get(id: string): D | undefined
  add(definition: D): void
  update(id: string, update: (definition: { -readonly [K in keyof D]: D[K] }) => void): void
  remove(id: string): void
}

export const listEditor = <D extends Keyed>(state: Array<D>): ListEditor<D> => ({
  list: () => [...state],
  get: (id) => state.find((definition) => definition.id === id),
  add: (definition) => {
    const at = state.findIndex((existing) => existing.id === definition.id)
    if (at >= 0) state[at] = definition
    else state.push(definition)
  },
  update: (id, update) => {
    const at = state.findIndex((existing) => existing.id === id)
    if (at < 0) return
    const copy = { ...state[at]! }
    update(copy)
    state[at] = copy
  },
  remove: (id) => {
    const at = state.findIndex((existing) => existing.id === id)
    if (at >= 0) state.splice(at, 1)
  },
})

export const definitions = <D extends Keyed>(name: string, notify?: (list: ReadonlyArray<D>) => Effect.Effect<void>) =>
  make<Array<D>, ListEditor<D>>({
    name,
    initial: () => [],
    editor: listEditor,
    ...(notify === undefined ? {} : { notify }),
  })
