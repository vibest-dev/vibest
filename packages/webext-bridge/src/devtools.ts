import browser from "webextension-polyfill";

import { createEndpointRuntime } from "./internal/endpoint-runtime";
import { createPersistentPort } from "./internal/persistent-port";
import { createStreamWirings } from "./internal/stream";

const port = createPersistentPort(`devtools@${browser.devtools.inspectedWindow.tabId}`);
const endpointRuntime = createEndpointRuntime("devtools", (message) => port.postMessage(message));

port.onMessage(endpointRuntime.handleMessage);

export const { sendMessage, onMessage } = endpointRuntime;
export const { openStream, onOpenStreamChannel } = createStreamWirings(endpointRuntime);
