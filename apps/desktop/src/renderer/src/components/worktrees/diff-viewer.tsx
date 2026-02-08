import { Badge } from "@vibest/ui/components/badge";
import { Button } from "@vibest/ui/components/button";
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
import { ArrowLeft, FileDiff as FileDiffIcon, RefreshCw } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useDiff } from "../../hooks/use-diff";
import type { FileDiff, Worktree } from "../../types";

const LazyMultiFileDiff = lazy(() =>
	import("@pierre/diffs/react").then((mod) => ({ default: mod.MultiFileDiff })),
);

interface DiffViewerProps {
	worktree: Worktree;
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

export function DiffViewer({ worktree, onClose }: DiffViewerProps) {
	const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
	const [showStaged, setShowStaged] = useState(false);

	const { diff, isLoading, error, refresh } = useDiff({
		path: worktree.path,
		staged: showStaged,
	});

	const files = diff?.files ?? [];
	const selectedFile = files[selectedFileIndex];

	return (
		<div className="flex h-full flex-col">
			<div className="border-border flex items-center justify-between border-b px-4 py-3">
				<div className="flex items-center gap-3">
					<Button variant="ghost" size="icon" onClick={onClose}>
						<ArrowLeft />
					</Button>
					<div>
						<h2 className="text-sm font-semibold">Changes</h2>
						<p className="text-muted-foreground text-xs">
							{worktree.branch} · {diff?.stats.filesChanged ?? 0} files changed
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
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
			</div>

			<div className="flex min-h-0 flex-1">
				{isLoading && files.length === 0 ? (
					<Empty className="flex-1">
						<Spinner />
						<EmptyDescription>Loading...</EmptyDescription>
					</Empty>
				) : error ? (
					<Empty className="flex-1">
						<EmptyTitle>Error</EmptyTitle>
						<EmptyDescription>{error}</EmptyDescription>
					</Empty>
				) : files.length === 0 ? (
					<Empty className="flex-1">
						<EmptyMedia variant="icon">
							<FileDiffIcon />
						</EmptyMedia>
						<EmptyTitle>No changes</EmptyTitle>
						<EmptyDescription>Working tree is clean</EmptyDescription>
					</Empty>
				) : (
					<>
						<ScrollArea className="border-border w-56 shrink-0 border-r">
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
											className={index === selectedFileIndex ? "bg-accent" : ""}
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

						<ScrollArea className="flex-1">
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
		</div>
	);
}
