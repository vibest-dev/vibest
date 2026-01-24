import { createContext, useContext } from "react";
import { type ClientRpc, useClientRpc } from "./use-client-rpc";

type ClientRpcContextType = {
	rpcRef: React.RefObject<ClientRpc | null>;
	connected: boolean;
};

const ClientRpcContext = createContext<ClientRpcContextType>(
	{} as ClientRpcContextType,
);

export function ClientRpcProvider({
	children,
}: {
	children?: React.ReactNode;
}) {
	const context = useClientRpc();

	return (
		<ClientRpcContext.Provider value={context}>
			{children}
		</ClientRpcContext.Provider>
	);
}

export const useClientRpcContext = () => {
	const context = useContext(ClientRpcContext);
	if (!context) {
		throw new Error(
			"useClientRpcContext must be used within a ClientRpcProvider",
		);
	}
	return context;
};
