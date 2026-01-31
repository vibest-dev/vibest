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
import { Spinner } from "@vibest/ui/components/spinner";
import { Download, Folder } from "lucide-react";
import { useState } from "react";
import { client } from "../../lib/client";

interface CloneRepositoryDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onClone: (url: string, targetPath: string) => Promise<void>;
}

export function CloneRepositoryDialog({
	isOpen,
	onClose,
	onClone,
}: CloneRepositoryDialogProps) {
	const [url, setUrl] = useState("");
	const [targetPath, setTargetPath] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSelectDir = async () => {
		try {
			const selectedPath = await client.fs.selectDir();
			if (selectedPath) {
				setTargetPath(selectedPath);
				setError(null);
			}
		} catch (err) {
			console.error("Failed to select directory:", err);
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!url.trim()) {
			setError("Enter a repository URL");
			return;
		}
		if (!targetPath.trim()) {
			setError("Select a target directory");
			return;
		}

		setIsLoading(true);
		setError(null);

		try {
			await onClone(url, targetPath);
			setUrl("");
			setTargetPath("");
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
			setUrl("");
			setTargetPath("");
			setError(null);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogPopup className="sm:max-w-md">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted">
							<Download className="w-4.5 h-4.5 text-muted-foreground" />
						</div>
						<div>
							<DialogTitle className="text-[15px]">
								Clone Repository
							</DialogTitle>
							<DialogDescription className="text-[13px]">
								Clone a repository from a remote URL
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<form onSubmit={handleSubmit}>
					<DialogPanel scrollFade={false} className="py-4">
						<div className="space-y-4">
							<div className="space-y-2">
								<Label className="text-[13px]">Repository URL</Label>
								<Input
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									placeholder="https://github.com/user/repo.git"
									className="text-[13px] font-mono h-9"
									autoComplete="url"
									spellCheck={false}
								/>
							</div>

							<div className="space-y-2">
								<Label className="text-[13px]">Clone to</Label>
								<div className="flex gap-2">
									<Input
										value={targetPath}
										onChange={(e) => setTargetPath(e.target.value)}
										placeholder="/path/to/clone"
										className="flex-1 text-[13px] font-mono h-9"
									/>
									<Button
										type="button"
										variant="outline"
										size="icon"
										className="h-9 w-9 shrink-0"
										onClick={handleSelectDir}
										aria-label="Browse folders"
									>
										<Folder className="h-4 w-4" />
									</Button>
								</div>
							</div>

							{error && (
								<p className="text-[12px] text-destructive-foreground">
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
							Clone Repository
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}
