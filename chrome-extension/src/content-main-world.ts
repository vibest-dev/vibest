import type { InspectedTargetData } from "@vibest/code-inspector-web";
import { VIBEST_EXTENSION_NAMESPACE } from "@vibest/shared/extension";
import { VibestExtensionMessage } from "@vibest/shared/extension/message";
import { sendMessage, setNamespace } from "webext-bridge/window";

declare global {
	interface Window {
		VIBEST_LOCAL_URL: string;
		VIBEST_BROWSER_EXTENSION_API: {
			inspected: (data: { targets: InspectedTargetData[] }) => void;
		};
	}
}

setNamespace(VIBEST_EXTENSION_NAMESPACE);

console.log("content-main-world", window.VIBEST_LOCAL_URL);

if (window.VIBEST_LOCAL_URL) {
	sendMessage(
		VibestExtensionMessage.WebAppInit,
		{ url: window.VIBEST_LOCAL_URL },
		"content-script",
	);
}

window.VIBEST_BROWSER_EXTENSION_API = {
	inspected: (data: { targets: InspectedTargetData[] }) => {
		sendMessage(VibestExtensionMessage.Inspected, data, "content-script");
	},
};
