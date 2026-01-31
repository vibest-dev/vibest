// App store (combined slices with persistence)
export { appStore, useAppStore, type AppStore } from "./app-store";

// Legacy export for gradual migration
export { appStore as uiStore, useAppStore as useUIStore } from "./app-store";
