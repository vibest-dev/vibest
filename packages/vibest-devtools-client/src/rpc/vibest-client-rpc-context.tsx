import { createContext, useContext } from "react";
import { type RPC, useVibestClientRpc } from "./use-vibest-client-rpc";

export type VibestClientRpcContextType = {
	iframeRef: React.RefObject<HTMLIFrameElement | null>;
	rpcRef: React.RefObject<RPC | null>;
	connected: boolean;
};

const VibestClientRpcContext = createContext<VibestClientRpcContextType>(
	{} as VibestClientRpcContextType,
);

export function VibestClientRpcProvider({
	children,
}: {
	children?: React.ReactNode;
}) {
	const context = useVibestClientRpc();

	return (
		<VibestClientRpcContext.Provider value={context}>
			{children}
		</VibestClientRpcContext.Provider>
	);
}

export const useVibestClientRpcContext = () => {
	const context = useContext(VibestClientRpcContext);
	if (!context) {
		throw new Error(
			"useVibestClientRpcContext must be used within a VibestClientRpcProvider",
		);
	}
	return context;
};
