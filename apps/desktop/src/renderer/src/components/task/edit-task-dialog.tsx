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
import { Textarea } from "@vibest/ui/components/textarea";
import { Pencil } from "lucide-react";
import { useMemo, useState } from "react";

import { orpc } from "../../lib/orpc";
import { cn } from "../../lib/utils";
import type { Repository, Task } from "../../types";

interface EditTaskDialogProps {
  isOpen: boolean;
  task: Task | null;
  repository: Repository | null;
  onClose: () => void;
}

export function EditTaskDialog({ isOpen, task, repository, onClose }: EditTaskDialogProps) {
  if (!task || !repository) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {/* The popup content only mounts while the dialog is open, and `key` remounts
          it when a different task is edited, so the form always starts from the
          task's current values — no initialization effect needed. */}
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
              <Pencil className="text-muted-foreground h-4.5 w-4.5" />
            </div>
            <div>
              <DialogTitle className="text-[15px]">Edit Task</DialogTitle>
              <DialogDescription className="text-[13px]">{repository.name}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <EditTaskForm key={task.id} task={task} repository={repository} onClose={onClose} />
      </DialogPopup>
    </Dialog>
  );
}

interface EditTaskFormProps {
  task: Task;
  repository: Repository;
  onClose: () => void;
}

function EditTaskForm({ task, repository, onClose }: EditTaskFormProps) {
  const queryClient = useQueryClient();

  // Form state, initialized from the task being edited
  const [name, setName] = useState(task.name);
  const [description, setDescription] = useState(task.description ?? "");
  const [selectedLabels, setSelectedLabels] = useState<string[]>(task.labels ?? []);
  const [error, setError] = useState<string | null>(null);

  // Constant-time membership checks while rendering the label list
  const selectedLabelIds = useMemo(() => new Set(selectedLabels), [selectedLabels]);

  // Get labels from repository
  const repositoryLabels = repository.labels ?? [];

  // Update task mutation
  const updateTaskMutation = useMutation({
    mutationFn: async (params: {
      taskId: string;
      name?: string;
      description?: string;
      labels?: string[];
    }) => {
      const { client } = await import("../../lib/client");
      return client.task.update(params);
    },
    onSuccess: () => {
      // Invalidate task list for this repository
      queryClient.invalidateQueries({
        queryKey: orpc.task.list.queryOptions({ input: { repositoryId: repository.id } }).queryKey,
      });
      onClose();
    },
    onError: (err) => {
      setError(String(err));
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError("Task name is required");
      return;
    }

    setError(null);

    updateTaskMutation.mutate({
      taskId: task.id,
      name: name.trim(),
      description: description.trim() || undefined,
      labels: selectedLabels,
    });
  };

  const toggleLabel = (labelId: string) => {
    setSelectedLabels((prev) =>
      prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId],
    );
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogPanel scrollFade={false} className="py-4">
        <div className="space-y-4">
          {/* Task name */}
          <div className="space-y-2">
            <Label className="text-[13px]">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Task name"
              className="h-9 text-[13px]"
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label className="text-[13px]">Description (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description..."
              className="text-[13px]"
              size="sm"
            />
          </div>

          {/* Labels */}
          {repositoryLabels.length > 0 && (
            <div className="space-y-2">
              <Label className="text-[13px]">Labels</Label>
              <div className="flex flex-wrap gap-2">
                {repositoryLabels.map((label) => (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => toggleLabel(label.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
                      selectedLabelIds.has(label.id)
                        ? "ring-2 ring-offset-1"
                        : "opacity-60 hover:opacity-100",
                    )}
                    style={{
                      backgroundColor: `#${label.color}20`,
                      color: `#${label.color}`,
                      ...(selectedLabelIds.has(label.id) ? { ringColor: `#${label.color}` } : {}),
                    }}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: `#${label.color}` }}
                    />
                    {label.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-destructive-foreground text-[12px]">{error}</p>}
        </div>
      </DialogPanel>

      <DialogFooter>
        <DialogClose className={buttonVariants({ variant: "ghost", className: "text-[13px]" })}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={updateTaskMutation.isPending} className="text-[13px]">
          {updateTaskMutation.isPending && <Spinner className="h-3.5 w-3.5" />}
          Save Changes
        </Button>
      </DialogFooter>
    </form>
  );
}
