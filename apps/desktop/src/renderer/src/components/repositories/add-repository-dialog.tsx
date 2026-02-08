import { Button, buttonVariants } from "@vibest/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@vibest/ui/components/combobox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@vibest/ui/components/dialog";
import { Input } from "@vibest/ui/components/input";
import { Label } from "@vibest/ui/components/label";
import { Spinner } from "@vibest/ui/components/spinner";
import { FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Branch } from "../../types";

import { client } from "../../lib/client";
import { cn } from "../../lib/utils";

interface AddRepositoryDialogProps {
  isOpen: boolean;
  path: string | null;
  onClose: () => void;
  onAdd: (path: string, defaultBranch: string) => Promise<void>;
}

interface BranchItem {
  label: string;
  value: string;
}

export function AddRepositoryDialog({ isOpen, path, onClose, onAdd }: AddRepositoryDialogProps) {
  const [selectedBranch, setSelectedBranch] = useState<BranchItem | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [detectedDefault, setDetectedDefault] = useState<string | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branchItems = useMemo<BranchItem[]>(
    () =>
      branches.map((b) => ({
        label: b.current ? `${b.name} (current)` : b.name,
        value: b.name,
      })),
    [branches],
  );

  // Set default selection when branchItems and detectedDefault are both available
  useEffect(() => {
    if (detectedDefault && branchItems.length > 0 && !selectedBranch) {
      const defaultItem = branchItems.find((b) => b.value === detectedDefault);
      if (defaultItem) {
        setSelectedBranch(defaultItem);
      }
    }
  }, [detectedDefault, branchItems, selectedBranch]);

  const loadBranches = useCallback(async (repositoryPath: string, isRefresh = false) => {
    setIsLoadingBranches(true);
    try {
      const [branchList, defaultBranch] = await Promise.all([
        client.workspace.getBranches({ path: repositoryPath }),
        client.workspace.getDefaultBranch({ path: repositoryPath }),
      ]);
      setBranches(branchList);
      if (!isRefresh) {
        setDetectedDefault(defaultBranch);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoadingBranches(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && path) {
      setError(null);
      loadBranches(path);
    }
  }, [isOpen, path, loadBranches]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path) return;

    if (!selectedBranch) {
      setError("Select a default branch");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await onAdd(path, selectedBranch.value);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
      setSelectedBranch(null);
      setDetectedDefault(null);
      setBranches([]);
      setError(null);
    }
  };

  if (!path) return null;

  const displayPath = path.replace(/^\/Users\/[^/]+/, "~");

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
              <FolderGit2 className="text-muted-foreground h-4.5 w-4.5" />
            </div>
            <div>
              <DialogTitle className="text-[15px]">Add Repository</DialogTitle>
              <DialogDescription className="text-[13px]">
                Confirm repository settings
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogPanel scrollFade={false} className="py-4">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-[13px]">Repository Path</Label>
                <Input value={displayPath} disabled readOnly className="font-mono" />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[13px]">Default Branch</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "text-muted-foreground hover:text-foreground h-5 w-5",
                      isLoadingBranches && "pointer-events-none",
                    )}
                    onClick={() => path && loadBranches(path, true)}
                    aria-label="Refresh branches"
                  >
                    <RefreshCw className={cn("h-3 w-3", isLoadingBranches && "animate-spin")} />
                  </Button>
                </div>
                <Combobox
                  items={branchItems}
                  value={selectedBranch}
                  onValueChange={setSelectedBranch}
                  disabled={branchItems.length === 0 && isLoadingBranches}
                >
                  <ComboboxInput
                    placeholder={
                      branchItems.length === 0 && isLoadingBranches
                        ? "Loading..."
                        : "Search branch..."
                    }
                    startAddon={<GitBranch />}
                  />
                  <ComboboxPopup>
                    <ComboboxEmpty>No branches found</ComboboxEmpty>
                    <ComboboxList>
                      {(item) => (
                        <ComboboxItem key={item.value} value={item}>
                          {item.label}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxPopup>
                </Combobox>
                <p className="text-muted-foreground text-[11px]">
                  New worktrees will be based on this branch
                </p>
              </div>

              {error && <p className="text-destructive-foreground text-[12px]">{error}</p>}
            </div>
          </DialogPanel>

          <DialogFooter>
            <DialogClose className={buttonVariants({ variant: "ghost", className: "text-[13px]" })}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={isLoading || (branchItems.length === 0 && isLoadingBranches)}
              className="text-[13px]"
            >
              {isLoading && <Spinner className="h-3.5 w-3.5" />}
              Add Repository
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
