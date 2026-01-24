import type {
	InspectorRpcClientFunctions,
	InspectorRpcServerFunctions,
} from "@vibest/code-inspector-web";
import { useInspectorRpcClient } from "@vibest/code-inspector-web";
import { type BirpcReturn, createBirpc } from "birpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClientBirpcOption } from "@/lib/rpc/client";
import type { BuiltinFunctions } from "@/lib/rpc/type";

/** for vibe client, treat host as client, iframe as server */
type RemoteFunctions = BuiltinFunctions & InspectorRpcServerFunctions;
type LocalFunctions = BuiltinFunctions & InspectorRpcClientFunctions;
export type RPC = BirpcReturn<RemoteFunctions, LocalFunctions>;

export function useVibestClientRpc() {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const rpcRef = useRef<RPC | null>(null);
	const [connected, setConnected] = useState(false);

	const inspectorHandler = useInspectorRpcClient(
		useCallback(() => {
			if (!rpcRef.current) {
				throw new Error("RPC client not initialized");
			}
			return rpcRef.current;
		}, []),
	);

	useEffect(() => {
		if (!iframeRef.current || !iframeRef.current.contentWindow) return;
		// Create RPC connection
		const rpc = createBirpc<RemoteFunctions, LocalFunctions>(
			{
				connect: async () => {
					rpcRef.current = rpc;
					setConnected(true);
					console.log("host connected");
					return true;
				},
				...inspectorHandler,
			},
			createClientBirpcOption(iframeRef.current),
		);

		return () => {
			rpc.$close();
			rpcRef.current = null;
		};
	}, [inspectorHandler]);

	return useMemo(
		() => ({
			rpcRef,
			iframeRef,
			connected,
		}),
		[connected],
	);
}
