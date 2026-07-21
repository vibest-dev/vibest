import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
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
import { toast } from "sonner";

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
  onImported,
}: {
  onClose: () => void;
  /** Fires after a successful import, with the created (or deduped) project. */
  onImported?: (project: Project) => void;
}) {
  // null = the server's default starting point (the home directory).
  const [path, setPath] = useState<string | null>(null);
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();

  const listing = useQuery({
    ...orpcQueryUtils.fs.browse.queryOptions({
      input: path === null ? {} : { path },
    }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    select: (data) => ({
      path: data.path,
      entries: [
        ...(data.parent != null ? [{ value: data.parent, label: "..", kind: "up" as const }] : []),
        ...data.directories.map((d) => ({
          value: d.path,
          label: d.name,
          kind: "dir" as const,
        })),
      ] satisfies Entry[],
    }),
  });
  const current = listing.data;

  const importProject = useMutation({
    mutationFn: (target: string) => orpcQueryUtils.project.create.call({ path: target }),
    onSuccess: (project) => {
      onClose();
      onImported?.(project);
      return queryClient.invalidateQueries({ queryKey: orpcQueryUtils.project.list.key() });
    },
    onError: (error) => {
      toast.error(`Failed to import project: ${error.message}`);
    },
  });

  return (
    <CommandDialog open onOpenChange={(open) => !open && onClose()}>
      <CommandDialogPopup>
        {/* Remount on navigation so the search text and highlight reset. */}
        <Command items={current?.entries ?? []} key={current?.path ?? "loading"}>
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
              // While navigating, keepPreviousData shows the prior listing (isPlaceholderData);
              // block importing until current.path matches the folder actually loaded.
              disabled={
                current === undefined || listing.isPlaceholderData || importProject.isPending
              }
              onClick={() => current && importProject.mutate(current.path)}
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
