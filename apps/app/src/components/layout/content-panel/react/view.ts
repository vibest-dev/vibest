import type { ComponentType, ReactNode } from "react";

import {
  definePanel as defineCorePanel,
  definePanelFamily as defineCorePanelFamily,
  type PanelDefinition,
  type PanelHandle,
  type PanelInstance,
  type SingletonPanelInput,
} from "../model/panel";

/**
 * The half of a panel the core deliberately doesn't understand. It reaches the
 * host as an opaque `View` and comes back out through the snapshot.
 */
export interface PanelView<Instance = PanelHandle<unknown>> {
  readonly icon: ComponentType<{ className?: string }>;
  render(instance: Instance): ReactNode;
}

/**
 * The erased form the registry stores, so `PanelView<FileInstance>` and
 * `PanelView<TerminalInstance>` can sit in one list. Same reason
 * `AnyPanelDefinition` needs it: `render` consumes an instance, and no concrete
 * type is assignable from every panel's. Unreachable in practice — the host
 * only ever hands `render` the instance it took from that same definition.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyPanelView = PanelView<any>;

/**
 * The core's constructors with `view` narrowed, so `render` receives the
 * instance this definition actually produces. Features import from here.
 *
 * Both derive their input from `PanelDefinition` rather than restating its
 * fields: a field added to the core would otherwise be silently unreachable
 * from every feature, since this is the only door they come through.
 */
export function definePanel<
  const Type extends string,
  Extra extends object = object,
  Payload = void,
>(
  definition: SingletonPanelInput<Type, Payload, Extra, View<Payload, Extra>>,
): PanelDefinition<Type, Payload, Extra, View<Payload, Extra>> {
  return defineCorePanel(definition);
}

export function definePanelFamily<
  const Type extends string,
  Payload,
  Extra extends object = object,
>(
  definition: PanelDefinition<Type, Payload, Extra, View<Payload, Extra>> & {
    readonly key: (payload: Payload) => string;
  },
): PanelDefinition<Type, Payload, Extra, View<Payload, Extra>> {
  return defineCorePanelFamily(definition);
}

/** The view a definition with this payload and these extras must supply. */
type View<Payload, Extra> = PanelView<PanelInstance<Payload, Extra>>;
