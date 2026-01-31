import { useCallback, useEffect, useState } from "react";
import { client } from "../lib/client";
import type { Branch } from "../types";

export function useBranches(repositoryPath: string | null) {
	const [branches, setBranches] = useState<Branch[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadBranches = useCallback(async () => {
		if (!repositoryPath) {
			setBranches([]);
			return;
		}

		setIsLoading(true);
		setError(null);

		try {
			const branches = await client.git.branches({ path: repositoryPath });
			setBranches(branches);
		} catch (err) {
			setError(String(err));
		} finally {
			setIsLoading(false);
		}
	}, [repositoryPath]);

	useEffect(() => {
		loadBranches();
	}, [loadBranches]);

	return {
		branches,
		isLoading,
		error,
		refresh: loadBranches,
	};
}
