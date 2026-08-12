export interface FileNavigationTracker {
  readonly getSnapshot: () => number;
  readonly subscribe: (listener: () => void) => () => void;
  readonly request: (payload: { readonly line?: number }) => void;
  readonly dispose: () => void;
}

/**
 * Distinguishes repeated explicit jump-to-line requests whose persisted panel
 * payload is otherwise identical. Plain Tab activation does not call request.
 */
export function createFileNavigationTracker(): FileNavigationTracker {
  let version = 0;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => version,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: (payload) => {
      if (payload.line === undefined) return;
      version += 1;
      for (const listener of listeners) listener();
    },
    dispose: () => listeners.clear(),
  };
}
