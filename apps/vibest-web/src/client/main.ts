import { BrowserHost } from "@effect/ui/html"
import { Effect, Layer } from "effect"

import { App } from "./App.ts"

const root = document.getElementById("root")

if (root) {
  const Main = BrowserHost.mount(App, {}, root)
  Layer.launch(Main).pipe(Effect.runFork)
}
