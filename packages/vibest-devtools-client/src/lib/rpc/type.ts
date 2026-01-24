export interface Message {
	event: "vibest-rpc-message";
	data: unknown;
}

export interface BuiltinFunctions {
	connect(): Promise<boolean>;
}
