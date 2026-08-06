import { createJSONStorage, persist } from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  type AnyPanelDefinition,
  type PanelDefinition,
  type PanelHandle,
  type PanelInstance,
  panelId,
  type PayloadArgs,
} from "./panel";

export type PanelPresentation = "hidden" | "docked" | "maximized";

/** What survives a reload: enough to rebuild the tab strip, and nothing else. */
interface PanelRecord {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}

interface SessionPanels {
  readonly presentation: PanelPresentation;
  readonly activeId: string | null;
  readonly panels: readonly PanelRecord[];
}

/**
 * Only what the UI must re-render on — which here is also exactly what is
 * worth persisting. Everything else a panel owns lives on its instance, so a
 * panel loading its content never re-renders the tab strip.
 */
export interface ContentPanelState {
  readonly bySessionId: Readonly<Record<string, SessionPanels>>;
  /**
   * Definitions live in the host's Map: they carry components, they are not UI
   * state. This counter is the only part of the registry the UI reacts to, and
   * it is what makes a late-registering panel's tab appear.
   */
  readonly registryVersion: number;
}

type PersistedState = Pick<ContentPanelState, "bySessionId">;

export interface OpenPanel<View> {
  readonly id: string;
  readonly label: string;
  readonly view: View;
  /**
   * Lazy on purpose: reading it is what materializes the panel, and only the
   * one being rendered ever does. Restoring ten tabs must not spawn ten of
   * whatever they own. A getter, so nobody may spread this object.
   */
  readonly instance: PanelHandle<unknown>;
}

/** A registered panel a "+" menu can offer. Registry-derived, so session-free. */
export interface OpenablePanel<View> {
  readonly type: string;
  readonly title: string;
  readonly view: View;
}

export interface PanelSnapshot<View> {
  readonly presentation: PanelPresentation;
  /**
   * Resolved panels only. A record whose type is not registered *yet*, or
   * whose payload no longer parses, stays in storage but never surfaces — so a
   * code-split or conditionally registered panel restores itself when it
   * arrives instead of having been dropped at hydration.
   */
  readonly panels: readonly OpenPanel<View>[];
  readonly active: OpenPanel<View> | null;
  readonly openable: readonly OpenablePanel<View>[];
}

export interface ContentPanelOptions {
  /** Omit to keep everything in memory — the default in tests. */
  readonly storage?: Storage;
}

const EMPTY_SESSION: SessionPanels = { presentation: "hidden", activeId: null, panels: [] };
/** Shared so an empty strip is `Object.is`-stable without costing a cache entry. */
const NO_PANELS: readonly never[] = [];

// NUL occurs in neither half, so the two never collide and `forget` can match a
// session by prefix. A panel id may well contain a space; a separator may not.
const instanceKey = (sessionId: string, id: string): string => `${sessionId}\0${id}`;

/**
 * The global instance: it owns the registry, the live panel instances, and a
 * small zustand store for the reactive slice. Mirrors `ChatManager` — instances
 * are cached and outlive navigation, and nothing here is torn down by a route
 * change.
 */
export class ContentPanel<View = unknown> {
  readonly store: StoreApi<ContentPanelState>;

  readonly #definitions = new Map<string, AnyPanelDefinition<View>>();
  /** Identifies *which* registration a given unregister belongs to; see `#put`. */
  readonly #tokens = new Map<string, symbol>();
  readonly #instances = new Map<string, PanelHandle<unknown>>();
  /**
   * The two derivations `snapshot` must keep reference-stable, cached against
   * exactly what each depends on. Splitting them is what makes a tab click —
   * which replaces the session object but not its `panels` array — free.
   */
  readonly #tabs = new Map<
    string,
    { records: readonly PanelRecord[]; registryVersion: number; panels: readonly OpenPanel<View>[] }
  >();
  #openable: { registryVersion: number; entries: readonly OpenablePanel<View>[] } | null = null;

  constructor(options: ContentPanelOptions = {}) {
    const initial: ContentPanelState = { bySessionId: {}, registryVersion: 0 };
    const { storage } = options;
    this.store = storage
      ? createStore<ContentPanelState>()(
          persist<ContentPanelState, [], [], PersistedState>(() => initial, {
            name: "vibest:content-panel",
            version: 1,
            storage: createJSONStorage(() => storage),
            partialize: (state) => ({ bySessionId: state.bySessionId }),
          }),
        )
      : createStore<ContentPanelState>(() => initial);
  }

  register(definition: AnyPanelDefinition<View>): () => void {
    const retract = this.#put(definition);
    this.#bumpRegistry();
    return () => {
      retract();
      this.#bumpRegistry();
    };
  }

  /**
   * A batch, in one bump. Registering four panels one at a time would discard
   * every derived tab list four times before the first paint.
   */
  registerAll(definitions: readonly AnyPanelDefinition<View>[]): () => void {
    const retractions = definitions.map((definition) => this.#put(definition));
    this.#bumpRegistry();
    return () => {
      for (const retract of retractions) retract();
      this.#bumpRegistry();
    };
  }

  /**
   * Idempotent: an id already open is activated and handed the new payload
   * (then told via `reopen`) rather than duplicated. Returns the live instance.
   */
  open<Type extends string, Payload, Extra extends object>(
    sessionId: string,
    definition: PanelDefinition<Type, Payload, Extra, View>,
    ...payloadArgs: PayloadArgs<Payload>
  ): PanelInstance<Payload, Extra> {
    return this.#openWith(
      sessionId,
      definition as AnyPanelDefinition<View>,
      payloadArgs[0],
    ) as PanelInstance<Payload, Extra>;
  }

  /**
   * Open a fresh member of a registered type — what a "+" menu entry does. By
   * type rather than by definition so `openable` stays plain data, shareable
   * across sessions instead of one bound closure per session per definition.
   */
  openNew(sessionId: string, type: string): void {
    const definition = this.#definitions.get(type);
    if (!definition) return;
    this.#openWith(sessionId, definition, definition.newPayload?.());
  }

  activate(sessionId: string, id: string): void {
    const session = this.#sessionOf(sessionId);
    if (!session.panels.some((panel) => panel.id === id)) return;
    this.#writeSession(sessionId, {
      ...session,
      presentation: session.presentation === "hidden" ? "docked" : session.presentation,
      activeId: id,
    });
  }

  /**
   * The low-level door. `instance.close()` comes through here, and it is also
   * how an unresolved record left over from a retired panel type gets purged.
   */
  close(sessionId: string, id: string): void {
    const session = this.#sessionOf(sessionId);
    const index = session.panels.findIndex((panel) => panel.id === id);
    if (index < 0) return;
    this.#disposeInstance(sessionId, id);
    const panels = session.panels.filter((panel) => panel.id !== id);
    // Closing the active tab lands on its neighbour, the way an editor does.
    const fallback = panels[Math.min(index, panels.length - 1)] ?? null;
    this.#writeSession(sessionId, {
      presentation: panels.length === 0 ? "hidden" : session.presentation,
      activeId: session.activeId === id ? (fallback?.id ?? null) : session.activeId,
      panels,
    });
  }

  setPresentation(sessionId: string, presentation: PanelPresentation): void {
    const session = this.#sessionOf(sessionId);
    if (session.presentation === presentation) return;
    this.#writeSession(sessionId, { ...session, presentation });
  }

  /** Hidden → docked, anything else → hidden. */
  toggleVisibility(sessionId: string): void {
    const { presentation } = this.#sessionOf(sessionId);
    this.setPresentation(sessionId, presentation === "hidden" ? "docked" : "hidden");
  }

  /**
   * Drops a session's panels and disposes their instances — for a deleted
   * session. No caller yet: nothing in the app hard-deletes a session, and
   * archiving is reversible, so forgetting there would lose a user's tabs.
   */
  forget(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const [key, instance] of this.#instances) {
      if (!key.startsWith(prefix)) continue;
      instance.dispose?.();
      this.#instances.delete(key);
    }
    this.#tabs.delete(sessionId);
    this.store.setState((state) => {
      if (!(sessionId in state.bySessionId)) return state;
      const { [sessionId]: _removed, ...rest } = state.bySessionId;
      return { bySessionId: rest };
    });
  }

  /** The test seam: asserts on instance lifetime without going through a render. */
  instanceFor(sessionId: string, id: string): PanelHandle<unknown> | undefined {
    return this.#instances.get(instanceKey(sessionId, id));
  }

  /**
   * Derives the render-ready view. The two collection-valued fields come from
   * caches keyed on their own inputs, so an unchanged input returns the
   * identical array — which is what lets `useStore` decide, by `Object.is`, not
   * to re-render. Select fields off this; the wrapper itself is cheap and fresh.
   */
  snapshot(state: ContentPanelState, sessionId: string | null): PanelSnapshot<View> {
    const openable = this.#openableFor(state.registryVersion);
    if (sessionId === null) {
      return { presentation: "hidden", panels: NO_PANELS, active: null, openable };
    }
    const session = state.bySessionId[sessionId] ?? EMPTY_SESSION;
    const panels = this.#tabsFor(sessionId, session.panels, state.registryVersion);
    return {
      presentation: session.presentation,
      panels,
      active: panels.find((panel) => panel.id === session.activeId) ?? null,
      openable,
    };
  }

  #tabsFor(
    sessionId: string,
    records: readonly PanelRecord[],
    registryVersion: number,
  ): readonly OpenPanel<View>[] {
    // Sessions merely visited never reach the cache, so it stays the size of
    // what the user actually opened.
    if (records.length === 0) return NO_PANELS;
    const cached = this.#tabs.get(sessionId);
    if (cached && cached.records === records && cached.registryVersion === registryVersion) {
      return cached.panels;
    }
    const panels: OpenPanel<View>[] = [];
    for (const record of records) {
      const definition = this.#definitions.get(record.type);
      if (!definition) continue;
      const payload = definition.parse ? definition.parse(record.payload) : record.payload;
      if (payload === null) continue;
      // Arrow, so `this` is the host without aliasing it into the literal.
      const materialize = () => this.#ensureInstance(sessionId, record.id, definition);
      panels.push({
        id: record.id,
        label: definition.label(payload),
        view: definition.view,
        get instance(): PanelHandle<unknown> {
          return materialize();
        },
      });
    }
    this.#tabs.set(sessionId, { records, registryVersion, panels });
    return panels;
  }

  #openableFor(registryVersion: number): readonly OpenablePanel<View>[] {
    if (this.#openable?.registryVersion === registryVersion) return this.#openable.entries;
    const entries: OpenablePanel<View>[] = [];
    for (const definition of this.#definitions.values()) {
      // A family with no `newPayload` can only be opened from elsewhere.
      if (definition.key && !definition.newPayload) continue;
      // Never `label(undefined)`: a family's label reads its payload, so the
      // fallback would throw. `definePanel` fills `title` in for singletons.
      entries.push({
        type: definition.type,
        title: definition.title ?? definition.type,
        view: definition.view,
      });
    }
    this.#openable = { registryVersion, entries };
    return entries;
  }

  /**
   * The payload-erased body of `open`. Split out because the public signature's
   * variadic payload can't be forwarded once `Payload` is `any`: the tuple
   * conditional collapses to a union and the spread stops type-checking.
   */
  #openWith(
    sessionId: string,
    definition: AnyPanelDefinition<View>,
    payload: unknown,
  ): PanelHandle<unknown> {
    const id = panelId(definition, payload);
    const session = this.#sessionOf(sessionId);
    const isOpen = session.panels.some((panel) => panel.id === id);
    this.#writeSession(sessionId, {
      presentation: session.presentation === "hidden" ? "docked" : session.presentation,
      activeId: id,
      panels: isOpen
        ? session.panels.map((panel) => (panel.id === id ? { ...panel, payload } : panel))
        : [...session.panels, { id, type: definition.type, payload }],
    });
    const instance = this.#ensureInstance(sessionId, id, definition);
    // The payload is written first, so `reopen` sees it on the handle too.
    if (isOpen) instance.reopen(payload);
    return instance;
  }

  #put(definition: AnyPanelDefinition<View>): () => void {
    const token = Symbol(definition.type);
    if (import.meta.env.DEV && this.#definitions.has(definition.type)) {
      console.warn(
        `[content-panel] panel type "${definition.type}" registered twice; the later one wins.`,
      );
    }
    this.#definitions.set(definition.type, definition);
    this.#tokens.set(definition.type, token);
    return () => {
      // StrictMode remounts as register → unregister → register. Retract only
      // our own registration, never the one that has already replaced it.
      if (this.#tokens.get(definition.type) !== token) return;
      this.#definitions.delete(definition.type);
      this.#tokens.delete(definition.type);
    };
  }

  #bumpRegistry(): void {
    this.store.setState((state) => ({ registryVersion: state.registryVersion + 1 }));
  }

  #sessionOf(sessionId: string): SessionPanels {
    return this.store.getState().bySessionId[sessionId] ?? EMPTY_SESSION;
  }

  #writeSession(sessionId: string, session: SessionPanels): void {
    this.store.setState((state) => ({
      bySessionId: { ...state.bySessionId, [sessionId]: session },
    }));
  }

  #setPayload(sessionId: string, id: string, next: unknown): void {
    const session = this.#sessionOf(sessionId);
    this.#writeSession(sessionId, {
      ...session,
      panels: session.panels.map((panel) =>
        panel.id === id
          ? {
              ...panel,
              // A payload that is itself callable can't be set functionally;
              // no panel has one, and the updater form is worth more.
              payload:
                typeof next === "function"
                  ? (next as (p: unknown) => unknown)(panel.payload)
                  : next,
            }
          : panel,
      ),
    });
  }

  #disposeInstance(sessionId: string, id: string): void {
    const key = instanceKey(sessionId, id);
    this.#instances.get(key)?.dispose?.();
    this.#instances.delete(key);
  }

  /**
   * Get-or-create, like `ChatManager.chatFor`. Reached through `OpenPanel`'s
   * lazy `instance`, so a panel restored from storage gets its instance the
   * moment it is rendered — and not before.
   */
  #ensureInstance(
    sessionId: string,
    id: string,
    definition: AnyPanelDefinition<View>,
  ): PanelHandle<unknown> {
    const key = instanceKey(sessionId, id);
    const existing = this.#instances.get(key);
    if (existing) return existing;
    const handle = this.#createHandle(sessionId, id);
    // Prototype-linked, not spread: `payload` is an accessor on the handle, and
    // copying it would freeze the value it had the moment the panel opened.
    const instance: PanelHandle<unknown> = definition.create
      ? Object.assign(Object.create(handle) as PanelHandle<unknown>, definition.create(handle))
      : handle;
    this.#instances.set(key, instance);
    return instance;
  }

  #createHandle(sessionId: string, id: string): PanelHandle<unknown> {
    // Arrows throughout: they close over `this` lexically, so the getter below
    // can reach the host without aliasing it.
    const payloadOf = (): unknown =>
      this.#sessionOf(sessionId).panels.find((panel) => panel.id === id)?.payload;
    return {
      id,
      sessionId,
      get payload(): unknown {
        return payloadOf();
      },
      activate: () => this.activate(sessionId, id),
      close: () => this.close(sessionId, id),
      setPayload: (next) => this.#setPayload(sessionId, id, next),
      reopen: () => {},
    };
  }
}
