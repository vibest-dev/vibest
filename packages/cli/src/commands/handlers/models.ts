import { Option } from "effect"

import { modelsOf } from "../../catalog.ts"
import * as Runtime from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.models, (o) =>
  modelsOf(Option.getOrUndefined(Option.orElse(o.target, () => o.harness)), o.provider),
)
