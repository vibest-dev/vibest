import { Scheduler } from "effect"

export const interruptOnceReady = (ready: () => boolean): Scheduler.Scheduler => {
  const base = new Scheduler.MixedScheduler()
  const state = { fired: false }
  return {
    executionMode: base.executionMode,
    makeDispatcher: () => base.makeDispatcher(),
    shouldYield: (fiber) => {
      if (state.fired || !ready()) return false
      state.fired = true
      queueMicrotask(() => fiber.interruptUnsafe())
      return true
    },
  }
}
