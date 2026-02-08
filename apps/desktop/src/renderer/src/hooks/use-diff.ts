import { useCallback, useEffect, useState } from "react";
import { client } from "../lib/client";
import type { DiffResult } from "../types";

interface UseDiffOptions {
	path: string;
	staged?: boolean;
}

interface UseDiffReturn {
	diff: DiffResult | null;
	isLoading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
}

export function useDiff({
	path,
	staged = false,
}: UseDiffOptions): UseDiffReturn {
	const [diff, setDiff] = useState<DiffResult | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		if (!path) return;

		setIsLoading(true);
		setError(null);

		try {
			const result = await client.git.diff({ path, staged });
			setDiff(result);
		} catch (err) {
			setError(String(err));
		} finally {
			setIsLoading(false);
		}
	}, [path, staged]);

	// Auto-fetch on mount and when path/staged changes
	useEffect(() => {
		refresh();
	}, [refresh]);

	return {
		diff,
		isLoading,
		error,
		refresh,
	};
}
