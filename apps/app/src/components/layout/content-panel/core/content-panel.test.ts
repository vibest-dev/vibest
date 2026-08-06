import { describe, expect, it } from "vitest";

import { ContentPanel } from "./content-panel";
import { definePanel, definePanelFamily, type PanelHandle } from "./panel";

const diff = definePanel({ type: "diff", label: "Diff", view: null });

const file = definePanelFamily({
  type: "file",
  key: (payload: { path: string }) => payload.path,
  label: (payload) => payload.path,
  parse: (raw) =>
    typeof raw === "object" && raw !== null && typeof (raw as { path?: unknown }).path === "string"
      ? { path: (raw as { path: string }).path }
      : null,
  view: null,
});

const S = "session-1";

const snapshotOf = (host: ContentPanel<null>, sessionId: string | null = S) =>
  host.snapshot(host.store.getState(), sessionId);

const withPanels = (...definitions: Parameters<ContentPanel<null>["register"]>[0][]) => {
  const host = new ContentPanel<null>();
  for (const definition of definitions) host.register(definition);
  return host;
};

/** A read-only `Storage` standing in for a reload with these panels persisted. */
const storageHolding = (bySessionId: unknown): Storage => {
  const value = JSON.stringify({ state: { bySessionId }, version: 1 });
  return {
    length: 1,
    getItem: (key) => (key === "vibest:content-panel" ? value : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
  };
};

describe("ContentPanel", () => {
  it("opens a singleton and docks the panel", () => {
    const host = withPanels(diff);
    host.open(S, diff);

    const snapshot = snapshotOf(host);
    expect(snapshot.presentation).toBe("docked");
    expect(snapshot.panels.map((panel) => panel.id)).toEqual(["diff"]);
    expect(snapshot.active?.id).toBe("diff");
  });

  it("reopening a singleton lands on the same panel", () => {
    const host = withPanels(diff);
    const first = host.open(S, diff);
    const second = host.open(S, diff);

    expect(second).toBe(first);
    expect(snapshotOf(host).panels).toHaveLength(1);
  });

  it("gives a family one panel per key", () => {
    const host = withPanels(file);
    host.open(S, file, { path: "a.ts" });
    host.open(S, file, { path: "b.ts" });

    expect(snapshotOf(host).panels.map((panel) => panel.id)).toEqual(["file:a.ts", "file:b.ts"]);
  });

  it("reopening a family member reuses its instance and tells it so", () => {
    const reopened: unknown[] = [];
    const tracked = definePanelFamily({
      type: "tracked",
      key: (payload: { path: string; line?: number }) => payload.path,
      label: (payload) => payload.path,
      create: () => ({ reopen: (payload: unknown) => void reopened.push(payload) }),
      view: null,
    });
    const host = withPanels(tracked);

    const first = host.open(S, tracked, { path: "a.ts" });
    const second = host.open(S, tracked, { path: "a.ts", line: 12 });

    expect(second).toBe(first);
    expect(reopened).toEqual([{ path: "a.ts", line: 12 }]);
    // The payload is written before `reopen` fires, so the handle already sees it.
    expect(first.payload).toEqual({ path: "a.ts", line: 12 });
  });

  it("closing the active panel lands on its neighbour", () => {
    const host = withPanels(file);
    host.open(S, file, { path: "a.ts" });
    host.open(S, file, { path: "b.ts" });
    host.open(S, file, { path: "c.ts" });
    host.activate(S, "file:b.ts");

    host.close(S, "file:b.ts");

    expect(snapshotOf(host).active?.id).toBe("file:c.ts");
  });

  it("closing the last panel hides the container", () => {
    const host = withPanels(diff);
    host.open(S, diff);

    host.close(S, "diff");

    const snapshot = snapshotOf(host);
    expect(snapshot.presentation).toBe("hidden");
    expect(snapshot.active).toBeNull();
  });

  it("closing disposes the instance", () => {
    let disposed = 0;
    const disposable = definePanel({
      type: "disposable",
      label: "Disposable",
      create: () => ({ dispose: () => void disposed++ }),
      view: null,
    });
    const host = withPanels(disposable);
    host.open(S, disposable);

    host.close(S, "disposable");

    expect(disposed).toBe(1);
  });

  it("toggling visibility keeps the panels and their instances", () => {
    const host = withPanels(diff);
    const instance = host.open(S, diff);

    host.toggleVisibility(S);
    expect(snapshotOf(host).presentation).toBe("hidden");

    host.toggleVisibility(S);
    expect(snapshotOf(host).presentation).toBe("docked");
    expect(snapshotOf(host).panels).toHaveLength(1);
    expect(host.instanceFor(S, "diff")).toBe(instance);
  });

  it("opens a fresh member by type, and shrugs at an unknown one", () => {
    let next = 0;
    const numbered = definePanelFamily({
      type: "numbered",
      key: (payload: { n: number }) => String(payload.n),
      label: (payload) => `#${payload.n}`,
      title: "Numbered",
      newPayload: () => ({ n: ++next }),
      view: null,
    });
    const host = withPanels(numbered);

    host.openNew(S, "numbered");
    host.openNew(S, "numbered");
    expect(snapshotOf(host).panels.map((panel) => panel.id)).toEqual(["numbered:1", "numbered:2"]);

    // A keyboard map or link handler can name a panel that is not registered
    // here; that is a no-op, not a throw.
    host.openNew(S, "nope");
    expect(snapshotOf(host).panels).toHaveLength(2);
  });

  it("names a menu entry without ever calling a family's label", () => {
    const host = withPanels(diff, file);

    // `file` is a family with no `newPayload`, so it can only be opened from
    // elsewhere; `diff`'s title came from its constant label, and nothing had to
    // call `label(undefined)` to find it.
    expect(snapshotOf(host).openable.map((entry) => entry.title)).toEqual(["Diff"]);
  });

  it("registers a batch in one registry bump", () => {
    const host = new ContentPanel<null>();
    const before = host.store.getState().registryVersion;

    const retract = host.registerAll([diff, file]);
    expect(host.store.getState().registryVersion).toBe(before + 1);
    host.open(S, diff);
    expect(snapshotOf(host).panels).toHaveLength(1);

    retract();
    expect(host.store.getState().registryVersion).toBe(before + 2);
    expect(snapshotOf(host).panels).toHaveLength(0);
  });

  it("keeps an unregistered panel's record and resolves it once it registers", () => {
    const host = new ContentPanel<null>();
    host.register(file);
    host.open(S, file, { path: "a.ts" });

    const unregister = host.register(diff);
    host.open(S, diff);
    expect(snapshotOf(host).panels).toHaveLength(2);

    // A panel going away — code split not loaded, capability withdrawn — must
    // not delete what the user had open.
    unregister();
    expect(snapshotOf(host).panels.map((panel) => panel.id)).toEqual(["file:a.ts"]);

    host.register(diff);
    expect(snapshotOf(host).panels.map((panel) => panel.id)).toEqual(["file:a.ts", "diff"]);
  });

  it("hides a panel whose stored payload no longer parses", () => {
    const host = withPanels(file);
    host.open(S, file, { path: "a.ts" });
    // Simulate a payload shape that has moved on since it was written.
    (host.instanceFor(S, "file:a.ts") as PanelHandle<unknown>).setPayload({ oldPath: "a.ts" });

    expect(snapshotOf(host).panels).toHaveLength(0);
  });

  it("keeps each derived collection identical until its own inputs change", () => {
    const host = withPanels(diff, file);
    host.open(S, diff);
    host.open(S, file, { path: "a.ts" });
    const { panels, openable } = snapshotOf(host);

    expect(snapshotOf(host).panels).toBe(panels);
    expect(snapshotOf(host).openable).toBe(openable);

    // A tab click and a resize replace the session object but not its records.
    // If the strip were rebuilt here, every click would re-render the subtree.
    host.activate(S, "diff");
    host.setPresentation(S, "maximized");
    expect(snapshotOf(host).panels).toBe(panels);
    expect(snapshotOf(host).openable).toBe(openable);

    // Opening one does change the records — but not the registry, so the menu
    // is left alone.
    host.open(S, file, { path: "b.ts" });
    expect(snapshotOf(host).panels).not.toBe(panels);
    expect(snapshotOf(host).openable).toBe(openable);

    host.register(definePanel({ type: "other", label: "Other", view: null }));
    expect(snapshotOf(host).openable).not.toBe(openable);
  });

  it("materializes a restored panel's instance only when it is read", () => {
    let created = 0;
    const counted = definePanelFamily({
      type: "counted",
      key: (payload: { n: number }) => String(payload.n),
      label: (payload) => `#${payload.n}`,
      create: () => ({ ordinal: ++created }),
      view: null,
    });
    const host = new ContentPanel<null>({
      storage: storageHolding({
        [S]: {
          presentation: "docked",
          activeId: "counted:1",
          panels: [
            { id: "counted:1", type: "counted", payload: { n: 1 } },
            { id: "counted:2", type: "counted", payload: { n: 2 } },
          ],
        },
      }),
    });
    host.register(counted);

    const snapshot = snapshotOf(host);
    // Both tabs are drawn, and neither panel exists yet: a reload with ten tabs
    // open must not spawn ten of whatever they own.
    expect(snapshot.panels.map((panel) => panel.label)).toEqual(["#1", "#2"]);
    expect(created).toBe(0);

    expect(snapshot.active?.instance).toBeDefined();
    expect(created).toBe(1);
  });

  it("scopes panels per session", () => {
    const host = withPanels(diff);
    host.open(S, diff);
    host.open("session-2", diff);
    host.close("session-2", "diff");

    expect(snapshotOf(host).panels).toHaveLength(1);
    expect(snapshotOf(host, "session-2").panels).toHaveLength(0);
  });

  it("forget drops a session and disposes its instances", () => {
    let disposed = 0;
    const disposable = definePanel({
      type: "disposable",
      label: "Disposable",
      create: () => ({ dispose: () => void disposed++ }),
      view: null,
    });
    const host = withPanels(disposable);
    host.open(S, disposable);

    host.forget(S);

    expect(disposed).toBe(1);
    expect(snapshotOf(host).panels).toHaveLength(0);
    expect(host.instanceFor(S, "disposable")).toBeUndefined();
  });

  it("no session means no panels", () => {
    const host = withPanels(diff);
    host.open(S, diff);

    expect(snapshotOf(host, null).panels).toHaveLength(0);
  });

  it("a duplicate registration's unregister does not retract the one that replaced it", () => {
    const host = new ContentPanel<null>();
    const retractFirst = host.register(diff);
    host.register(diff);

    retractFirst();

    host.open(S, diff);
    expect(snapshotOf(host).panels).toHaveLength(1);
  });
});
