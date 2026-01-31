import { Button } from "@vibest/ui/components/button";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "@vibest/ui/components/menu";
import {
	ExternalLink,
	FolderGit2,
	MoreHorizontal,
	RefreshCw,
	Terminal,
	Trash2,
} from "lucide-react";
import { client } from "../../lib/client";
import type { Repository } from "../../types";

interface HeaderProps {
	repo: Repository | null;
	onRemoveRepo: (repositoryId: string) => void;
	onRefresh: () => void;
}

export function Header({ repo, onRemoveRepo, onRefresh }: HeaderProps) {
	if (!repo) {
		return (
			<header className="h-12 border-b border-border bg-background/50 backdrop-blur-sm flex items-center px-5 app-drag-region">
				<span className="text-[13px] text-muted-foreground">
					Select a repository to view worktrees
				</span>
			</header>
		);
	}

	const handleOpenFinder = () => {
		client.fs.openFinder({ path: repo.path });
	};

	const handleOpenTerminal = () => {
		client.fs.openTerminal({ path: repo.path });
	};

	return (
		<header className="h-12 border-b border-border bg-background/50 backdrop-blur-sm flex items-center justify-between px-5 app-drag-region">
			<div className="flex items-center gap-3 min-w-0 app-no-drag">
				<div className="flex items-center justify-center w-7 h-7 rounded-md bg-accent">
					<FolderGit2 className="w-4 h-4 text-accent-foreground" />
				</div>
				<div className="min-w-0">
					<h1 className="text-[13px] font-semibold text-foreground truncate leading-tight">
						{repo.name}
					</h1>
					<p className="text-[11px] text-muted-foreground truncate max-w-sm font-mono leading-tight">
						{repo.path.replace(/^\/Users\/[^/]+/, "~")}
					</p>
				</div>
			</div>

			<div className="flex items-center gap-0.5 app-no-drag">
				<Button
					variant="ghost"
					size="icon-sm"
					className="h-7 w-7 text-muted-foreground hover:text-foreground"
					onClick={onRefresh}
					aria-label="Refresh"
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</Button>

				<Button
					variant="ghost"
					size="icon-sm"
					className="h-7 w-7 text-muted-foreground hover:text-foreground"
					onClick={handleOpenFinder}
					aria-label="Open in Finder"
				>
					<ExternalLink className="h-3.5 w-3.5" />
				</Button>

				<Menu>
					<MenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								className="h-7 w-7 text-muted-foreground hover:text-foreground"
								aria-label="More options"
							>
								<MoreHorizontal className="h-3.5 w-3.5" />
							</Button>
						}
					/>
					<MenuPopup side="bottom" align="end">
						<MenuItem onClick={handleOpenFinder}>
							<ExternalLink className="h-4 w-4" />
							Open in Finder
						</MenuItem>
						<MenuItem onClick={handleOpenTerminal}>
							<Terminal className="h-4 w-4" />
							Open Terminal
						</MenuItem>
						<MenuSeparator />
						<MenuItem
							variant="destructive"
							onClick={() => onRemoveRepo(repo.id)}
						>
							<Trash2 className="h-4 w-4" />
							Remove Repository
						</MenuItem>
					</MenuPopup>
				</Menu>
			</div>
		</header>
	);
}
