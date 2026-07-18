import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Button } from "@vibest/ui/components/button";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@vibest/ui/components/command";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

interface Entry {
  value: string;
  label: string;
  kind: "up" | "dir";
}

/**
 * Command-palette folder browser: drill into a folder, then import it.
 * Mount only while open — browsing state resets by unmounting on close.
 */
export function ImportProjectDialog({
  onClose,
  onImport,
  importing,
}: {
  onClose: () => void;
  onImport: (path: string) => void;
  importing: boolean;
}) {
  // null = the server's default starting point (the home directory).
  const [path, setPath] = useState<string | null>(null);
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });

  const listing = useQuery({
    ...orpcQueryUtils.project.listDirectories.queryOptions({
      input: path === null ? {} : { path },
    }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const current = listing.data;

  const entries: Entry[] = [
    ...(current?.parent != null
      ? [{ value: current.parent, label: "..", kind: "up" as const }]
      : []),
    ...(current?.directories ?? []).map((d) => ({
      value: d.path,
      label: d.name,
      kind: "dir" as const,
    })),
  ];

  return (
    <CommandDialog open onOpenChange={(open) => !open && onClose()}>
      <CommandDialogPopup>
        {/* Remount on navigation so the search text and highlight reset. */}
        <Command items={entries} key={current?.path ?? "loading"}>
          <CommandInput placeholder="Search folders..." />
          <CommandPanel>
            <CommandEmpty>{listing.isPending ? "Loading..." : "No folders found."}</CommandEmpty>
            <CommandList>
              {(item: Entry) => (
                <CommandItem
                  className="gap-2"
                  key={item.value}
                  onClick={() => setPath(item.value)}
                  value={item.value}
                >
                  {item.kind === "up" ? (
                    <CornerLeftUpIcon className="text-muted-foreground size-4" />
                  ) : (
                    <FolderIcon className="text-muted-foreground size-4" />
                  )}
                  <span className="truncate">{item.label}</span>
                </CommandItem>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span className="min-w-0 flex-1 truncate" title={current?.path}>
              {current?.path}
            </span>
            <Button
              disabled={current === undefined || importing}
              onClick={() => current && onImport(current.path)}
              size="sm"
            >
              Import this folder
            </Button>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
