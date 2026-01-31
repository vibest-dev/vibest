import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 1000 * 60, // 1 minute - data considered fresh
			gcTime: 1000 * 60 * 5, // 5 minutes - garbage collection time
			retry: 1, // Retry failed requests once
			refetchOnWindowFocus: false, // Electron doesn't need window focus refetch
		},
	},
});
