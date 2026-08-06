/**
 * The panel vocabulary. Zero React on purpose: everything here is data or a
 * pure function, so the workspace model in `content-panel.ts` can be driven
 * from a plain synchronous test with no renderer.
 */

/**
 * What a panel gets when it is opened: its identity plus the operations every
 * panel needs. Instances are cached by the host and survive navigation, so
 * `payload` is a getter that reads through to the store rather than a value
 * captured at construction — a held handle never goes stale. It is a snapshot
 * read, not a subscription; a panel that must re-render when its own payload
 * changes selects it through `usePanelSnapshot`.
 *
 * A panel needing more than this (its own store, a subscription, a disposer)
 * supplies `create`, which returns only the *extra* members; the host links
 * them onto the handle. Deliberately not "return the whole instance": the
 * obvious way to write that is `{ ...handle, extra }`, and spreading flattens
 * the `payload` getter into a stale snapshot without a word.
 */
export interface PanelHandle<Payload> {
  readonly id: string;
  readonly sessionId: string;
  readonly payload: Payload;
  activate(): void;
  close(): void;
  setPayload(next: Payload | ((current: Payload) => Payload)): void;
  /**
   * Called when an already-open panel is opened again; the new payload has
   * already been written by then. The default handle does nothing — override
   * in `create` to reveal a line, steal focus, or refetch.
   */
  reopen(payload: Payload): void;
  /** Called once, when the panel is really closed. The default handle has none. */
  dispose?(): void;
}

/** What a definition's `create` adds on top of the handle. */
export type PanelInstance<Payload, Extra> = PanelHandle<Payload> & Extra;

export interface PanelDefinition<
  Type extends string,
  Payload,
  Extra extends object = object,
  View = unknown,
> {
  readonly type: Type;
  /**
   * Present = a family: one panel per distinct key, id is `${type}:${key}`.
   * Absent = a singleton: the id *is* the type, so opening it twice lands on
   * the same panel. Nothing else in the system branches on singleton-vs-family
   * — it is only this id function, which is why adding either costs the same.
   */
  readonly key?: (payload: Payload) => string;
  /** Per-instance, so a family's tab reads "foo.ts" rather than "File". */
  readonly label: (payload: Payload) => string;
  /**
   * The panel's own name, for menus. A family needs it because `label` speaks
   * for one member; a singleton falls back to its constant label.
   */
  readonly title?: string;
  /**
   * How to mint a fresh member. Its presence is what puts the panel in the "+"
   * menu — a family that can only be opened from elsewhere (a file needs a
   * path) simply omits it. Singletons are offerable without one.
   */
  readonly newPayload?: () => Payload;
  /**
   * Validates a payload read back from storage. Returning null keeps the
   * record but leaves the panel unresolved, so a payload shape can evolve by
   * editing this one function instead of a global migration.
   */
  readonly parse?: (raw: unknown) => Payload | null;
  /**
   * The extra members this panel's instance carries — its own store, a
   * disposer, an overriding `reopen`. The host links the result onto the
   * handle, so `handle` is here only to be captured, never to be copied.
   */
  readonly create?: (handle: PanelHandle<Payload>) => Extra;
  /** The host never reads this; the React layer narrows it to `PanelView`. */
  readonly view: View;
}

/**
 * The erased form the registry stores. `any` in the payload slot is
 * load-bearing: `key`/`create` consume a payload (contravariant) while `parse`
 * produces one (covariant), so no single concrete type — not `unknown`, not
 * `never` — accepts every definition.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyPanelDefinition<View = unknown> = PanelDefinition<string, any, any, View>;

/** Empty for a singleton, one required argument for a family. */
export type PayloadArgs<Payload> = [Payload] extends [void] ? [] : [payload: Payload];

/**
 * Everything a family takes except `key` — whose absence is the whole
 * difference — and with `label` a constant, since one panel needs only one.
 * `Payload` still defaults to `void` but is no longer forced to it: a singleton
 * that grows a payload later must not have to become a family with a fake
 * `key`, because that would change its persisted id.
 */
export type SingletonPanelInput<Type extends string, Payload, Extra extends object, View> = Omit<
  PanelDefinition<Type, Payload, Extra, View>,
  "key" | "label" | "title"
> & {
  readonly label: string;
};

/** A singleton: no `key`, so the id *is* the type and opening it twice is once. */
export function definePanel<
  const Type extends string,
  View,
  Extra extends object = object,
  Payload = void,
>(
  definition: SingletonPanelInput<Type, Payload, Extra, View>,
): PanelDefinition<Type, Payload, Extra, View> {
  // `title` too, so the "+" menu never has to invent a name for it.
  return { ...definition, label: () => definition.label, title: definition.label };
}

/** A family: `key` is what makes it one, and is the only required extra. */
export function definePanelFamily<
  const Type extends string,
  Payload,
  View,
  Extra extends object = object,
>(
  definition: PanelDefinition<Type, Payload, Extra, View> & {
    readonly key: (payload: Payload) => string;
  },
): PanelDefinition<Type, Payload, Extra, View> {
  return definition;
}

/**
 * The half of every `parse` that is the same everywhere: narrow a value read
 * back from storage to something whose fields can be checked.
 */
export const asRecord = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;

/** Singleton and family collapse to this one line. */
export function panelId<Payload>(
  definition: Pick<PanelDefinition<string, Payload>, "type" | "key">,
  payload: Payload,
): string {
  return definition.key ? `${definition.type}:${definition.key(payload)}` : definition.type;
}
