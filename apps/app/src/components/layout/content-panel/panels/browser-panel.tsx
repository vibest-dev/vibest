import { Button } from "@vibest/ui/components/button";
import { Input } from "@vibest/ui/components/input";
import { GlobeIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { asRecord, type PanelInstance } from "../core/panel";
import { definePanelFamily } from "../react/view";

interface BrowserPayload {
  readonly tabId: string;
  /** Persisted so a reload lands back where the tab was. */
  readonly url: string;
}

interface BrowserState {
  readonly loading: boolean;
  readonly title: string;
}

/**
 * What this instance adds on top of the handle. Loading and title are
 * per-instance and worthless across a reload, so they live in the instance's
 * own store rather than the host's — a tab finishing its load re-renders
 * itself and nothing else.
 */
interface BrowserExtra {
  readonly store: StoreApi<BrowserState>;
  navigate(url: string): void;
}

type BrowserInstance = PanelInstance<BrowserPayload, BrowserExtra>;

let nextTab = 0;

export const browserPanel = definePanelFamily({
  type: "browser",
  key: (payload: BrowserPayload) => payload.tabId,
  label: (payload) => hostOf(payload.url),
  title: "Browser",
  newPayload: () => ({ tabId: `tab-${++nextTab}`, url: "http://localhost:5173" }),
  parse: (raw) => {
    const { tabId, url } = asRecord(raw) ?? {};
    return typeof tabId === "string" && typeof url === "string" ? { tabId, url } : null;
  },
  create: (handle) => {
    const store = createStore<BrowserState>(() => ({
      loading: false,
      title: hostOf(handle.payload.url),
    }));
    const navigate = (url: string) => {
      // The URL is persisted state, so it goes to the host; the spinner is not,
      // so it stays here.
      handle.setPayload((current) => ({ ...current, url }));
      store.setState({ loading: true });
      setTimeout(() => store.setState({ loading: false, title: hostOf(url) }), 400);
    };
    return { store, navigate };
  },
  view: {
    icon: GlobeIcon,
    render: (instance) => <BrowserPanelView instance={instance} />,
  },
});

function hostOf(url: string): string {
  try {
    return new URL(url).host || "Browser";
  } catch {
    return "Browser";
  }
}

function BrowserPanelView({ instance }: { instance: BrowserInstance }) {
  const { loading, title } = useStore(instance.store);
  const [draft, setDraft] = useState(instance.payload.url);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex shrink-0 items-center gap-1 border-b p-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          instance.navigate(draft);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="h-7 text-xs"
          aria-label="Address"
        />
        <Button type="submit" variant="ghost" size="icon-xs" aria-label="Reload">
          <RotateCwIcon className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </form>
      <div className="bg-muted/30 text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-xs">
        {loading ? "Loading…" : `Rendered ${title}`}
      </div>
    </div>
  );
}
