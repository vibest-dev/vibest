import { createEndpointRuntime } from "./internal/endpoint-runtime";
import { createPersistentPort } from "./internal/persistent-port";
import { createStreamWirings } from "./internal/stream";

const port = createPersistentPort("popup");
const endpointRuntime = createEndpointRuntime("popup", (message) => port.postMessage(message));

port.onMessage(endpointRuntime.handleMessage);

export const { sendMessage, onMessage } = endpointRuntime;
export const { openStream, onOpenStreamChannel } = createStreamWirings(endpointRuntime);
