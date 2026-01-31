import type { TerminalInfo } from "../../../../shared/contract/terminal";

import { appStore } from "../../stores/app-store";
import { orpc } from "./workspace";
import { queryClient } from "../query-client";

// Terminal query utilities using the shared orpc instance
export const terminalOrpc = orpc.terminal;

// Mutation callbacks for terminal operations
export function createTerminalMutationCallbacks() {
	return {
		onSuccess: (data: TerminalInfo) => {
			// Invalidate terminal list for this worktree
			queryClient.invalidateQueries({
				queryKey: terminalOrpc.list.key({ input: { worktreeId: data.worktreeId } }),
			});
			// Set as active terminal
			appStore.getState().setActiveTerminalId(data.worktreeId, data.id);
		},
	};
}

export function closeTerminalMutationCallbacks(worktreeId: string) {
	return {
		onSuccess: () => {
			// Invalidate terminal list
			queryClient.invalidateQueries({
				queryKey: terminalOrpc.list.key({ input: { worktreeId } }),
			});
		},
	};
}
