import { createRoot } from "react-dom/client";

import { createApp } from "./app";

import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(createApp({ host: "web" }));
