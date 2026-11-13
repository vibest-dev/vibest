import { modelsOf } from "../../../catalog.ts"
import * as Runtime from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.harness.commands.models, (o) => modelsOf(o.harness, o.provider))
