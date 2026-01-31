import { Badge } from "@vibest/ui/components/badge";
import { Button } from "@vibest/ui/components/button";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "@vibest/ui/components/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@vibest/ui/components/empty";
import { Menu, MenuItem } from "@vibest/ui/components/menu";
import { ScrollArea } from "@vibest/ui/components/scroll-area";
import { Spinner } from "@vibest/ui/components/spinner";
import { Tabs, TabsList, TabsTab } from "@vibest/ui/components/tabs";
import { FileDiff as FileDiffIcon, RefreshCw } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useDiff } from "../../hooks/use-diff";
import type { FileDiff, Worktree } from "../../types";

const LazyMultiFileDiff = lazy(() =>
	import("@pierre/diffs/react").then((mod) => ({ default: mod.MultiFileDiff })),
);

interface DiffViewerDialogProps {
	isOpen: boolean;
	worktree: Worktree | null;
	onClose: () => void;
}

const statusVariants: Record<
	FileDiff["status"],
	"warning" | "success" | "error" | "info"
> = {
	modified: "warning",
	added: "success",
	deleted: "error",
	renamed: "info",
};

const statusLabels: Record<FileDiff["status"], string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
};

export function DiffViewerDialog({
	isOpen,
	worktree,
	onClose,
}: DiffViewerDialogProps) {
	const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
	const [showStaged, setShowStaged] = useState(false);

	const { diff, isLoading, error, refresh } = useDiff({
		path: worktree?.path ?? "",
		staged: showStaged,
	});

	useEffect(() => {
		if (isOpen && worktree) {
			refresh();
			setSelectedFileIndex(0);
			setShowStaged(false);
		}
	}, [isOpen, worktree, refresh]);

	const files = diff?.files ?? [];
	const selectedFile = files[selectedFileIndex];

	if (!worktree) return null;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogPopup className="sm:max-w-5xl h-[80vh]">
				<DialogHeader>
					<DialogTitle>Changes</DialogTitle>
					<DialogDescription>
						{worktree.branch} · {diff?.stats.filesChanged ?? 0} files changed
					</DialogDescription>
				</DialogHeader>

				<div className="flex gap-2 px-6 pb-4">
					<Tabs
						value={showStaged ? "staged" : "all"}
						onValueChange={(v) => {
							setShowStaged(v === "staged");
							setSelectedFileIndex(0);
						}}
					>
						<TabsList>
							<TabsTab value="all">All</TabsTab>
							<TabsTab value="staged">Staged</TabsTab>
						</TabsList>
					</Tabs>
					<Button
						variant="ghost"
						size="icon"
						onClick={refresh}
						disabled={isLoading}
					>
						<RefreshCw className={isLoading ? "animate-spin" : ""} />
					</Button>
				</div>

				<div className="flex-1 flex min-h-0 px-6 pb-6 gap-4">
					{isLoading && files.length === 0 ? (
						<Empty>
							<Spinner />
							<EmptyDescription>Loading...</EmptyDescription>
						</Empty>
					) : error ? (
						<Empty>
							<EmptyTitle>Error</EmptyTitle>
							<EmptyDescription>{error}</EmptyDescription>
						</Empty>
					) : files.length === 0 ? (
						<Empty>
							<EmptyMedia variant="icon">
								<FileDiffIcon />
							</EmptyMedia>
							<EmptyTitle>No changes</EmptyTitle>
							<EmptyDescription>Working tree is clean</EmptyDescription>
						</Empty>
					) : (
						<>
							<ScrollArea className="w-48 shrink-0">
								<Menu>
									{files.map((file, index) => {
										const filename =
											file.newFile?.filename ??
											file.oldFile?.filename ??
											"unknown";
										const shortName = filename.split("/").pop() ?? filename;

										return (
											<MenuItem
												key={filename}
												onClick={() => setSelectedFileIndex(index)}
												className={
													index === selectedFileIndex ? "bg-accent" : ""
												}
											>
												<Badge variant={statusVariants[file.status]} size="sm">
													{statusLabels[file.status]}
												</Badge>
												<span className="truncate text-sm">{shortName}</span>
											</MenuItem>
										);
									})}
								</Menu>
							</ScrollArea>

							<ScrollArea className="flex-1 border rounded-lg">
								{selectedFile && (
									<Suspense fallback={<Spinner />}>
										<LazyMultiFileDiff
											oldFile={
												selectedFile.oldFile
													? {
															name: selectedFile.oldFile.filename,
															contents: selectedFile.oldFile.contents,
														}
													: { name: "", contents: "" }
											}
											newFile={
												selectedFile.newFile
													? {
															name: selectedFile.newFile.filename,
															contents: selectedFile.newFile.contents,
														}
													: { name: "", contents: "" }
											}
											options={{
												themeType: "dark",
												diffStyle: "unified",
											}}
										/>
									</Suspense>
								)}
							</ScrollArea>
						</>
					)}
				</div>
			</DialogPopup>
		</Dialog>
	);
}
