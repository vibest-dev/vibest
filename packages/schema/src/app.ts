import { Context } from "effect"

export class App extends Context.Service<App, { readonly version: string }>()("vibest/App") {}
