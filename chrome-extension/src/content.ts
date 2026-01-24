import { VIBEST_EXTENSION_NAMESPACE } from "@vibest/shared/extension";
import { VibestExtensionMessage } from "@vibest/shared/extension/message";
import {
	allowWindowMessaging,
	onMessage,
	sendMessage,
} from "webext-bridge/content-script";

// await injectScript("/content-main-world.js");

console.log("content");

allowWindowMessaging(VIBEST_EXTENSION_NAMESPACE);
// proxy, content-script window -> sidepanel
onMessage(VibestExtensionMessage.WebAppInit, async (event) => {
	return await sendMessage(
		VibestExtensionMessage.WebAppInit,
		event.data,
		"sidepanel",
	);
});
onMessage(VibestExtensionMessage.Inspected, async (event) => {
	return await sendMessage(
		VibestExtensionMessage.Inspected,
		event.data,
		"sidepanel",
	);
});
