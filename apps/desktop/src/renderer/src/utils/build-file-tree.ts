import type { DiffFileInfo } from "../types";

export interface FileTreeNode {
	path: string; // "src/components/auth.tsx" or "src/components"
	isDirectory: boolean;
	status?: DiffFileInfo["status"]; // only for files
	children: FileTreeNode[];
}

export function buildFileTree(files: DiffFileInfo[]): FileTreeNode[] {
	const root: FileTreeNode[] = [];

	for (const file of files) {
		const filename = file.path;
		if (!filename) continue;

		const parts = filename.split("/");
		let currentLevel = root;
		let currentPath = "";

		for (let j = 0; j < parts.length; j++) {
			const part = parts[j];
			const isLast = j === parts.length - 1;
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			let existing = currentLevel.find((n) => n.path === currentPath);

			if (!existing) {
				existing = {
					path: currentPath,
					isDirectory: !isLast,
					children: [],
					...(isLast ? { status: file.status } : {}),
				};
				currentLevel.push(existing);
			}

			if (!isLast) {
				currentLevel = existing.children;
			}
		}
	}

	// Sort: directories first, then alphabetically by name
	const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
		return nodes
			.toSorted((a, b) => {
				if (a.isDirectory !== b.isDirectory) {
					return a.isDirectory ? -1 : 1;
				}
				const nameA = a.path.split("/").pop() ?? "";
				const nameB = b.path.split("/").pop() ?? "";
				return nameA.localeCompare(nameB);
			})
			.map((node) => ({
				...node,
				children: sortNodes(node.children),
			}));
	};

	return sortNodes(root);
}
