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
import { GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useBranches } from "../../hooks/use-branches";
import { cn } from "../../lib/utils";
import type { Repository } from "../../types";

interface CreateWorktreeDialogProps {
	isOpen: boolean;
	repository: Repository | null;
	onClose: () => void;
	onCreate: (params: {
		repositoryId: string;
		branch: string;
		isNewBranch: boolean;
		baseBranch?: string;
	}) => Promise<void>;
}

export function CreateWorktreeDialog({
	isOpen,
	repository,
	onClose,
	onCreate,
}: CreateWorktreeDialogProps) {
	const [isNewBranch, setIsNewBranch] = useState(false);
	const [selectedBranch, setSelectedBranch] = useState("");
	const [newBranchName, setNewBranchName] = useState("");
	const [baseBranch, setBaseBranch] = useState("main");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const {
		branches,
		isLoading: isLoadingBranches,
		refresh: refreshBranches,
	} = useBranches(repository?.path ?? null);

	useEffect(() => {
		if (isOpen) {
			setIsNewBranch(false);
			setSelectedBranch("");
			setNewBranchName("");
			setBaseBranch("main");
			setError(null);
		}
	}, [isOpen]);

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
		const branch = isNewBranch ? newBranchName.trim() : selectedBranch;

		if (!branch) {
			setError(isNewBranch ? "Enter a branch name" : "Select a branch");
			return;
		}

		if (isNewBranch && !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
			setError("Invalid branch name");
			return;
		}

		setIsLoading(true);
		setError(null);

		try {
			await onCreate({
				repositoryId: repository.id,
				branch,
				isNewBranch,
				baseBranch: isNewBranch ? baseBranch : undefined,
			});
			onClose();
		} catch (err) {
			setError(String(err));
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogPopup className="sm:max-w-md">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<div className="bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
							<GitBranch className="text-muted-foreground h-4.5 w-4.5" />
						</div>
						<div>
							<DialogTitle className="text-[15px]">Create Worktree</DialogTitle>
							<DialogDescription className="text-[13px]">
								{repository.name}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<form onSubmit={handleSubmit}>
					<DialogPanel scrollFade={false} className="py-4">
						<div className="space-y-4">
							{/* Branch type toggle */}
							<div className="bg-muted flex gap-1 rounded-lg p-1">
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
							</div>

							{!isNewBranch ? (
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
											<SelectValue placeholder="Select a branch…" />
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
							) : (
								<>
									<div className="space-y-2">
										<Label className="text-[13px]">Branch Name</Label>
										<Input
											value={newBranchName}
											onChange={(e) => setNewBranchName(e.target.value)}
											placeholder="feat/my-feature"
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
						<Button type="submit" disabled={isLoading} className="text-[13px]">
							{isLoading && <Spinner className="h-3.5 w-3.5" />}
							Create Worktree
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}
