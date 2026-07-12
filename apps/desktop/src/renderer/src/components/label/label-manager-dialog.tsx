import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@vibest/ui/components/button";
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
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { useEffect, useReducer } from "react";

import { orpc } from "../../lib/orpc";
import { cn } from "../../lib/utils";
import type { Label as LabelType, Repository } from "../../types";

// Preset colors for the color picker
const PRESET_COLORS = [
  "e4e669", // yellow
  "0075ca", // blue
  "a2eeef", // cyan
  "0e8a16", // green
  "6e7681", // gray
  "d73a4a", // red
  "7057ff", // purple
  "d4c5f9", // lavender
  "fbca04", // gold
  "c2e0c6", // mint
  "f9d0c4", // salmon
  "ffffff", // white
];

interface LabelManagerDialogProps {
  isOpen: boolean;
  repository: Repository | null;
  onClose: () => void;
}

type EditMode = "list" | "create" | "edit";

/**
 * The list/create/edit views and the form fields always change together, so a
 * single reducer describes each transition as one action instead of a burst of
 * setState calls.
 */
interface FormState {
  mode: EditMode;
  editingLabelId: string | null;
  name: string;
  color: string;
  description: string;
  error: string | null;
}

type FormAction =
  | { type: "backToList" }
  | { type: "createClicked" }
  | { type: "editClicked"; label: LabelType }
  | { type: "nameChanged"; value: string }
  | { type: "colorChanged"; value: string }
  | { type: "descriptionChanged"; value: string }
  | { type: "failed"; error: string };

const initialFormState: FormState = {
  mode: "list",
  editingLabelId: null,
  name: "",
  color: "0075ca",
  description: "",
  error: null,
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "backToList":
      return initialFormState;
    case "createClicked":
      return { ...initialFormState, mode: "create" };
    case "editClicked":
      return {
        mode: "edit",
        editingLabelId: action.label.id,
        name: action.label.name,
        color: action.label.color,
        description: action.label.description ?? "",
        error: null,
      };
    case "nameChanged":
      return { ...state, name: action.value };
    case "colorChanged":
      return { ...state, color: action.value };
    case "descriptionChanged":
      return { ...state, description: action.value };
    case "failed":
      return { ...state, error: action.error };
  }
}

export function LabelManagerDialog({ isOpen, repository, onClose }: LabelManagerDialogProps) {
  const queryClient = useQueryClient();

  const [form, dispatch] = useReducer(formReducer, initialFormState);
  const { mode, editingLabelId, name, color, description, error } = form;

  // Get labels from repository
  const labels = repository?.labels ?? [];

  // Create label mutation
  const createLabelMutation = useMutation({
    mutationFn: async (params: {
      repositoryId: string;
      name: string;
      color: string;
      description?: string;
    }) => {
      const { client } = await import("../../lib/client");
      return client.label.create(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      dispatch({ type: "backToList" });
    },
    onError: (err) => {
      dispatch({ type: "failed", error: String(err) });
    },
  });

  // Update label mutation
  const updateLabelMutation = useMutation({
    mutationFn: async (params: {
      repositoryId: string;
      labelId: string;
      name?: string;
      color?: string;
      description?: string;
    }) => {
      const { client } = await import("../../lib/client");
      return client.label.update(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      dispatch({ type: "backToList" });
    },
    onError: (err) => {
      dispatch({ type: "failed", error: String(err) });
    },
  });

  // Delete label mutation
  const deleteLabelMutation = useMutation({
    mutationFn: async (params: { repositoryId: string; labelId: string; force?: boolean }) => {
      const { client } = await import("../../lib/client");
      return client.label.delete(params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
    onError: (err) => {
      dispatch({ type: "failed", error: String(err) });
    },
  });

  // Start from the list view every time the dialog opens
  useEffect(() => {
    if (isOpen) {
      dispatch({ type: "backToList" });
    }
  }, [isOpen]);

  if (!repository) return null;

  const handleDeleteClick = (label: LabelType) => {
    if (
      window.confirm(
        `Delete label "${label.name}"? This will remove it from all tasks that use it.`,
      )
    ) {
      deleteLabelMutation.mutate({
        repositoryId: repository.id,
        labelId: label.id,
        force: true,
      });
    }
  };

  const handleSubmitCreate = () => {
    if (!name.trim()) {
      dispatch({ type: "failed", error: "Label name is required" });
      return;
    }

    // Check for duplicate name
    if (labels.some((l) => l.name.toLowerCase() === name.trim().toLowerCase())) {
      dispatch({ type: "failed", error: "A label with this name already exists" });
      return;
    }

    createLabelMutation.mutate({
      repositoryId: repository.id,
      name: name.trim(),
      color,
      description: description.trim() || undefined,
    });
  };

  const handleSubmitEdit = () => {
    if (!editingLabelId) return;

    if (!name.trim()) {
      dispatch({ type: "failed", error: "Label name is required" });
      return;
    }

    // Check for duplicate name (excluding current label)
    if (
      labels.some(
        (l) => l.id !== editingLabelId && l.name.toLowerCase() === name.trim().toLowerCase(),
      )
    ) {
      dispatch({ type: "failed", error: "A label with this name already exists" });
      return;
    }

    updateLabelMutation.mutate({
      repositoryId: repository.id,
      labelId: editingLabelId,
      name: name.trim(),
      color,
      description: description.trim() || undefined,
    });
  };

  const isLoading =
    createLabelMutation.isPending || updateLabelMutation.isPending || deleteLabelMutation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
              <Tags className="text-muted-foreground h-4.5 w-4.5" />
            </div>
            <div>
              <DialogTitle className="text-[15px]">
                {mode === "list" && "Manage Labels"}
                {mode === "create" && "Create Label"}
                {mode === "edit" && "Edit Label"}
              </DialogTitle>
              <DialogDescription className="text-[13px]">{repository.name}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogPanel scrollFade={false} className="py-4">
          {mode === "list" && (
            <div className="space-y-3">
              {labels.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-[13px]">
                  No labels yet. Create one to get started.
                </p>
              ) : (
                <div className="space-y-2">
                  {labels.map((label) => (
                    <div
                      key={label.id}
                      className="bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2"
                    >
                      <span
                        className="size-3.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `#${label.color}` }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{label.name}</p>
                        {label.description && (
                          <p className="text-muted-foreground truncate text-[12px]">
                            {label.description}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => dispatch({ type: "editClicked", label })}
                          className="hover:bg-foreground/10 flex size-6 items-center justify-center rounded"
                          title="Edit label"
                          aria-label={`Edit label ${label.name}`}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteClick(label)}
                          disabled={isLoading}
                          className="hover:bg-destructive/10 text-destructive flex size-6 items-center justify-center rounded"
                          title="Delete label"
                          aria-label={`Delete label ${label.name}`}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Button
                onClick={() => dispatch({ type: "createClicked" })}
                variant="outline"
                className="w-full text-[13px]"
              >
                <Plus className="size-4" />
                Create Label
              </Button>
            </div>
          )}

          {(mode === "create" || mode === "edit") && (
            <div className="space-y-4">
              {/* Name */}
              <div className="space-y-2">
                <Label className="text-[13px]">Name</Label>
                <Input
                  value={name}
                  onChange={(e) => dispatch({ type: "nameChanged", value: e.target.value })}
                  placeholder="bug, feature, enhancement..."
                  className="h-9 text-[13px]"
                  autoFocus
                />
              </div>

              {/* Color picker */}
              <div className="space-y-2">
                <Label className="text-[13px]">Color</Label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color #${c}`}
                      aria-pressed={color === c}
                      onClick={() => dispatch({ type: "colorChanged", value: c })}
                      className={cn(
                        "size-7 rounded-full border-2 transition-all",
                        color === c
                          ? "border-foreground scale-110"
                          : "border-transparent hover:scale-105",
                      )}
                      style={{ backgroundColor: `#${c}` }}
                      title={`#${c}`}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-[12px]">#</span>
                  <Input
                    value={color}
                    onChange={(e) => {
                      const value = e.target.value.replace(/[^0-9A-Fa-f]/g, "").slice(0, 6);
                      dispatch({ type: "colorChanged", value });
                    }}
                    placeholder="0075ca"
                    className="h-8 w-24 font-mono text-[12px]"
                    maxLength={6}
                  />
                  <span
                    className="size-6 rounded-full border"
                    style={{ backgroundColor: `#${color}` }}
                  />
                </div>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label className="text-[13px]">Description (optional)</Label>
                <Input
                  value={description}
                  onChange={(e) => dispatch({ type: "descriptionChanged", value: e.target.value })}
                  placeholder="Short description of this label"
                  className="h-9 text-[13px]"
                />
              </div>

              {/* Preview */}
              <div className="space-y-2">
                <Label className="text-[13px]">Preview</Label>
                <div className="flex items-center gap-2">
                  <span
                    className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium"
                    style={{
                      backgroundColor: `#${color}20`,
                      color: `#${color}`,
                    }}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: `#${color}` }}
                    />
                    {name || "label"}
                  </span>
                </div>
              </div>

              {error && <p className="text-destructive-foreground text-[12px]">{error}</p>}
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          {mode === "list" ? (
            <DialogClose className={buttonVariants({ variant: "ghost", className: "text-[13px]" })}>
              Close
            </DialogClose>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => dispatch({ type: "backToList" })}
                className="text-[13px]"
              >
                Back
              </Button>
              <Button
                onClick={mode === "create" ? handleSubmitCreate : handleSubmitEdit}
                disabled={isLoading}
                className="text-[13px]"
              >
                {isLoading && <Spinner className="h-3.5 w-3.5" />}
                {mode === "create" ? "Create Label" : "Save Changes"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
