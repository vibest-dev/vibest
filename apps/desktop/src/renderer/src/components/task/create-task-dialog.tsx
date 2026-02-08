import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
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
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@vibest/ui/components/select";
import { Spinner } from "@vibest/ui/components/spinner";
import { Textarea } from "@vibest/ui/components/textarea";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useBranches } from "../../hooks/use-branches";
import { orpc } from "../../lib/orpc";
import { cn } from "../../lib/utils";
import type { Repository } from "../../types";

interface CreateTaskDialogProps {
	isOpen: boolean;
	repository: Repository | null;
	onClose: () => void;
}

export function CreateTaskDialog({
	isOpen,
	repository,
	onClose,
}: CreateTaskDialogProps) {
	const queryClient = useQueryClient();

	// Form state
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
	const [isNewBranch, setIsNewBranch] = useState(true);
	const [selectedBranch, setSelectedBranch] = useState("");
	const [newBranchName, setNewBranchName] = useState("");
	const [baseBranch, setBaseBranch] = useState("main");
	const [error, setError] = useState<string | null>(null);

	// Fetch branches for the repository
	const {
		branches,
		isLoading: isLoadingBranches,
		refresh: refreshBranches,
	} = useBranches(repository?.path ?? null);

	// Get labels from repository
	const repositoryLabels = repository?.labels ?? [];

	// Create task mutation
	const createTaskMutation = useMutation({
		mutationFn: async (params: {
			repositoryId: string;
			name: string;
			description?: string;
			labels?: string[];
			branchName?: string;
		}) => {
			const { client } = await import("../../lib/client");
			return client.task.create(params);
		},
		onSuccess: () => {
			// Invalidate task list for this repository
			queryClient.invalidateQueries({
				queryKey: orpc.task.list.queryOptions({
					input: { repositoryId: repository?.id ?? "" },
				}).queryKey,
			});
			// Also invalidate workspace list to refresh worktreesByRepository
			queryClient.invalidateQueries({
				queryKey: orpc.workspace.key(),
			});
			onClose();
		},
		onError: (err) => {
			setError(String(err));
		},
	});

	// Reset form when dialog opens
	useEffect(() => {
		if (isOpen) {
			setName("");
			setDescription("");
			setSelectedLabels([]);
			setIsNewBranch(true);
			setSelectedBranch("");
			setNewBranchName("");
			setBaseBranch("main");
			setError(null);
		}
	}, [isOpen]);

	// Set default base branch when branches load
	useEffect(() => {
		if (branches.length > 0) {
			const mainBranch = branches.find(
				(b) => b.name === "main" || b.name === "master",
			);
			if (mainBranch) {
				setBaseBranch(mainBranch.name);
			}
		}
	}, [branches]);

	if (!repository) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!name.trim()) {
			setError("Task name is required");
			return;
		}

		// Determine branch name
		let branchName: string | undefined;
		if (isNewBranch) {
			branchName = newBranchName.trim() || undefined;
			if (branchName && !/^[a-zA-Z0-9._/-]+$/.test(branchName)) {
				setError("Invalid branch name");
				return;
			}
		} else {
			branchName = selectedBranch || undefined;
		}

		setError(null);

		createTaskMutation.mutate({
			repositoryId: repository.id,
			name: name.trim(),
			description: description.trim() || undefined,
			labels: selectedLabels.length > 0 ? selectedLabels : undefined,
			branchName,
		});
	};

	const toggleLabel = (labelId: string) => {
		setSelectedLabels((prev) =>
			prev.includes(labelId)
				? prev.filter((id) => id !== labelId)
				: [...prev, labelId],
		);
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogPopup className="sm:max-w-lg">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<div className="bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
							<CheckCircle2 className="text-muted-foreground h-4.5 w-4.5" />
						</div>
						<div>
							<DialogTitle className="text-[15px]">Create Task</DialogTitle>
							<DialogDescription className="text-[13px]">
								{repository.name}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<form onSubmit={handleSubmit}>
					<DialogPanel scrollFade={false} className="py-4">
						<div className="space-y-4">
							{/* Task name */}
							<div className="space-y-2">
								<Label className="text-[13px]">Name</Label>
								<Input
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Implement user authentication"
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
									placeholder="Add JWT-based authentication with refresh tokens..."
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
													selectedLabels.includes(label.id)
														? "ring-2 ring-offset-1"
														: "opacity-60 hover:opacity-100",
												)}
												style={{
													backgroundColor: `#${label.color}20`,
													color: `#${label.color}`,
													...(selectedLabels.includes(label.id)
														? { ringColor: `#${label.color}` }
														: {}),
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

							{/* Branch type toggle */}
							<div className="space-y-2">
								<Label className="text-[13px]">Branch</Label>
								<div className="bg-muted flex gap-1 rounded-lg p-1">
									<button
										type="button"
										onClick={() => setIsNewBranch(true)}
										className={cn(
											"flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all",
											isNewBranch
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										New Branch
									</button>
									<button
										type="button"
										onClick={() => setIsNewBranch(false)}
										className={cn(
											"flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all",
											!isNewBranch
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										Existing Branch
									</button>
								</div>
							</div>

							{isNewBranch ? (
								<>
									<div className="space-y-2">
										<Label className="text-[13px]">
											Branch Name (optional)
										</Label>
										<Input
											value={newBranchName}
											onChange={(e) => setNewBranchName(e.target.value)}
											placeholder="feat/my-feature (auto-generated if empty)"
											className="h-9 font-mono text-[13px]"
											spellCheck={false}
										/>
									</div>
									<div className="space-y-2">
										<Label className="text-[13px]">Based on</Label>
										<Select
											value={baseBranch}
											onValueChange={(v) => setBaseBranch(v ?? "main")}
										>
											<SelectTrigger className="h-9 text-[13px]">
												<SelectValue />
											</SelectTrigger>
											<SelectPopup>
												{branches.map((b) => (
													<SelectItem
														key={b.name}
														value={b.name}
														className="text-[13px]"
													>
														{b.name}
													</SelectItem>
												))}
											</SelectPopup>
										</Select>
									</div>
								</>
							) : (
								<div className="space-y-2">
									<div className="flex items-center justify-between">
										<Label className="text-[13px]">Branch</Label>
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											className="text-muted-foreground hover:text-foreground h-5 w-5"
											onClick={refreshBranches}
											disabled={isLoadingBranches}
											aria-label="Refresh branches"
										>
											<RefreshCw
												className={cn(
													"h-3 w-3",
													isLoadingBranches && "animate-spin",
												)}
											/>
										</Button>
									</div>
									<Select
										value={selectedBranch}
										onValueChange={(v) => setSelectedBranch(v ?? "")}
									>
										<SelectTrigger className="h-9 text-[13px]">
											<SelectValue placeholder="Select a branch..." />
										</SelectTrigger>
										<SelectPopup>
											{branches.map((b) => (
												<SelectItem
													key={b.name}
													value={b.name}
													className="text-[13px]"
												>
													{b.name}
													{b.current ? " (current)" : ""}
												</SelectItem>
											))}
										</SelectPopup>
									</Select>
								</div>
							)}

							{error && (
								<p className="text-destructive-foreground text-[12px]">
									{error}
								</p>
							)}
						</div>
					</DialogPanel>

					<DialogFooter>
						<DialogClose
							render={<Button variant="ghost" className="text-[13px]" />}
						>
							Cancel
						</DialogClose>
						<Button
							type="submit"
							disabled={createTaskMutation.isPending}
							className="text-[13px]"
						>
							{createTaskMutation.isPending && (
								<Spinner className="h-3.5 w-3.5" />
							)}
							Create Task
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}
