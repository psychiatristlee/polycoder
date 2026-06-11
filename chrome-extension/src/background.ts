// Minimal service worker: open the side panel when the toolbar icon is clicked.
// The agent itself runs in the side panel context (which has full chrome.* access),
// so it survives the SW being suspended.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
