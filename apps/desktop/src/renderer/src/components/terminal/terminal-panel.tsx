import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@vibest/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@vibest/ui/components/tabs";

import type { TerminalInfo } from "../../../../shared/contract/terminal";

import { useAppStore } from "../../stores/app-store";
import { orpc } from "../../lib/orpc";
import { queryClient } from "../../lib/query-client";
import { TerminalView } from "./terminal-view";

interface TerminalPanelProps {
	worktreeId: string;
	worktreePath: string;
	worktreeExists: boolean;
	isVisible: boolean;
}

export function TerminalPanel({
	worktreeId,
	worktreePath,
	worktreeExists,
	isVisible,
}: TerminalPanelProps) {
	const storedActiveTerminalId = useAppStore(
		(state) => state.activeTerminalId[worktreeId] ?? null,
	);
	const setActiveTerminalId = useAppStore((state) => state.setActiveTerminalId);

	// Single query for terminals - used by both tabs and view rendering
	const { data: terminals = [], isSuccess } = useQuery(
		orpc.terminal.list.queryOptions({ input: { worktreeId } }),
	);

	// Compute effective activeTerminalId - fallback to first terminal if none selected
	const activeTerminalId =
		storedActiveTerminalId && terminals.some((t) => t.id === storedActiveTerminalId)
			? storedActiveTerminalId
			: terminals[0]?.id ?? null;

	// Track if auto-creation has been initiated
	// This prevents double-creation in React Strict Mode
	const autoCreateInitiated = useRef(false);

	// Create terminal mutation
	const createTerminal = useMutation({
		...orpc.terminal.create.mutationOptions(),
		onSuccess: (data: TerminalInfo) => {
			queryClient.invalidateQueries({
				queryKey: orpc.terminal.list.key({ input: { worktreeId: data.worktreeId } }),
			});
			setActiveTerminalId(data.worktreeId, data.id);
		},
	});

	// Close terminal mutation
	const closeTerminal = useMutation({
		...orpc.terminal.close.mutationOptions(),
	});

	// Auto-create terminal when worktree has no terminals (only if path exists)
	// Uses ref to prevent double-creation in React Strict Mode
	useEffect(() => {
		if (
			worktreeExists &&
			isSuccess &&
			terminals.length === 0 &&
			!autoCreateInitiated.current
		) {
			autoCreateInitiated.current = true;
			createTerminal.mutate({ worktreeId, cwd: worktreePath });
		}
		// Note: createTerminal is excluded from deps as useMutation returns unstable reference
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [worktreeExists, isSuccess, terminals.length, worktreeId, worktreePath]);

	const handleCreateTerminal = () => {
		createTerminal.mutate({ worktreeId, cwd: worktreePath });
	};

	const handleCloseTerminal = (
		e: React.MouseEvent,
		terminalId: string,
	) => {
		e.stopPropagation();
		closeTerminal.mutate(
			{ terminalId },
			{
				onSuccess: () => {
					const closedIndex = terminals.findIndex((t) => t.id === terminalId);
					const remaining = terminals.filter((t) => t.id !== terminalId);

					// Create a new terminal if closing the last one
					if (remaining.length === 0 && worktreeExists) {
						createTerminal.mutate({ worktreeId, cwd: worktreePath });
						return;
					}

					queryClient.invalidateQueries({
						queryKey: orpc.terminal.list.key({ input: { worktreeId } }),
					});

					// Select adjacent terminal if the closed one was active
					if (activeTerminalId === terminalId) {
						// If closing the last tab, select the previous one
						// Otherwise, select the next one (which now has the same index)
						const nextIndex = closedIndex >= remaining.length ? remaining.length - 1 : closedIndex;
						setActiveTerminalId(worktreeId, remaining[nextIndex]?.id ?? null);
					}
				},
			},
		);
	};

	const handleTabChange = (terminalId: string) => {
		setActiveTerminalId(worktreeId, terminalId);
	};

	return (
		<div
			className="flex h-full flex-col bg-zinc-950 absolute inset-0"
			style={{ visibility: isVisible ? "visible" : "hidden" }}
		>
			{/* Tabs header */}
			<div className="flex items-center border-b border-zinc-800 bg-zinc-950">
				<Tabs
					value={activeTerminalId ?? ""}
					onValueChange={handleTabChange}
					className="flex-1"
				>
					<TabsList className="h-9 bg-transparent p-0 rounded-none">
						{terminals.map((terminal, index) => (
							<TabsTrigger
								key={terminal.id}
								value={terminal.id}
								className="relative h-9 rounded-none border-r border-zinc-800 px-3 data-[state=active]:bg-zinc-900 data-[state=active]:shadow-none"
							>
								<span className="mr-2">
									{terminals.length === 1 ? "Terminal" : `Terminal ${index + 1}`}
								</span>
								<button
									type="button"
									onClick={(e) => handleCloseTerminal(e, terminal.id)}
									className="opacity-60 hover:opacity-100"
								>
									<X className="h-3 w-3" />
								</button>
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<Button
					variant="ghost"
					size="icon"
					className="h-9 w-9 rounded-none"
					onClick={handleCreateTerminal}
					disabled={!worktreeExists || createTerminal.isPending}
					title={worktreeExists ? "New terminal" : "Worktree path does not exist"}
				>
					<Plus className="h-4 w-4" />
				</Button>
			</div>

			{/* Terminal views */}
			<div className="relative flex-1">
				{terminals.map((terminal) => (
					<TerminalView
						key={terminal.id}
						terminalId={terminal.id}
						isVisible={isVisible && terminal.id === activeTerminalId}
					/>
				))}
				{terminals.length === 0 && (
					<div className="flex h-full items-center justify-center text-zinc-500">
						{worktreeExists
							? "No terminals. Click + to create one."
							: "Worktree path does not exist on disk."}
					</div>
				)}
			</div>
		</div>
	);
}
