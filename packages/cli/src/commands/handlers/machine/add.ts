import { shortId } from "@vibest/schema/id"
import type { MachineNote } from "@vibest/schema/machine"
import { Console, Effect } from "effect"

import { userOnly, vibest } from "../../../caller.ts"
import * as Runtime from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

const printNotes = (notes: ReadonlyArray<MachineNote>) =>
  Effect.forEach(
    notes,
    (note) =>
      Console.log(
        `note${note.plugin === undefined ? "" : ` (${note.plugin})`}: ${note.message}${note.fix === undefined ? "" : `; fix: ${note.fix}`}`,
      ),
    { discard: true },
  )

export default Runtime.handler(Commands.commands.machine.commands.add, (o) =>
  userOnly("machine add").pipe(
    Effect.andThen(vibest((client) => client["Machine.Add"]({ name: o.name, target: o.target }))),
    Effect.flatMap((added) =>
      Console.log(
        `added ${added.name}: vibestd ${added.vibestd} (${shortId(added.id)}), vibest ${added.version}; connected`,
      ).pipe(Effect.andThen(printNotes(added.notes))),
    ),
  ),
)
