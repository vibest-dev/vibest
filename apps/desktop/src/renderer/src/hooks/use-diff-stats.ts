import { skipToken, useQuery } from "@tanstack/react-query";

import { orpc } from "../lib/orpc";

export function useDiffStats(path: string | undefined) {
	return useQuery(
		orpc.git.diffStats.queryOptions({
			input: path ? { path } : skipToken,
		}),
	);
}
