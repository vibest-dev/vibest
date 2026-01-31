import "webext-bridge/background";

/** open the side panel when click the action icon */
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
