import {
	type InspectorRpcClientFunctions,
	type InspectorRpcServerFunctions,
	useInspectorRpcServer,
} from "@vibest/code-inspector-web";
import { type BirpcReturn, createBirpc } from "birpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createServerBirpcOption } from "@/lib/rpc/server";
import type { BuiltinFunctions } from "@/lib/rpc/type";

type RemoteFunctions = BuiltinFunctions & InspectorRpcClientFunctions;
type LocalFunctions = BuiltinFunctions & InspectorRpcServerFunctions;
export type ClientRpc = BirpcReturn<RemoteFunctions, LocalFunctions>;

export function useClientRpc() {
	const rpcRef = useRef<ClientRpc | null>(null);
	const [connected, setConnected] = useState(false);

	const inspectorHandler = useInspectorRpcServer(
		useCallback(() => {
			if (!rpcRef.current) {
				throw new Error("RPC client not initialized");
			}
			return rpcRef.current;
		}, []),
	);

	useEffect(() => {
		const rpc = createBirpc<RemoteFunctions, LocalFunctions>(
			{
				...inspectorHandler,
				connect: async () => true,
			},
			createServerBirpcOption(),
		);

		rpc.connect().then((result) => {
			console.log("client rpc connection", result);
			if (result) {
				rpcRef.current = rpc;
				setConnected(result);
			}
		});

		return () => {
			rpc.$close();
			rpcRef.current = null;
		};
	}, [inspectorHandler]);

	return useMemo(
		() => ({
			rpcRef,
			connected,
		}),
		[connected],
	);
}
