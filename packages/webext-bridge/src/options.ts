import { createEndpointRuntime } from "./internal/endpoint-runtime";
import { createPersistentPort } from "./internal/persistent-port";
import { createStreamWirings } from "./internal/stream";

const port = createPersistentPort("options");
const endpointRuntime = createEndpointRuntime("options", (message) => port.postMessage(message));

port.onMessage(endpointRuntime.handleMessage);

export const { sendMessage, onMessage } = endpointRuntime;
export const { openStream, onOpenStreamChannel } = createStreamWirings(endpointRuntime);
