# Vibe Web

**Supercharge your web development experience and productivity by seamlessly
providing context to Code Agents directly in your browser.**

A monorepo for building in-browser developer tooling around AI coding agents. It enhances vibe coding and web development by combining a chat interface, DOM inspection, and others so the agent has more accurate context (e.g., file, line, component). No MCP or external context‑bridging tools required.

> [!NOTE]
> This project is in active development. Feedback and pull requests are welcome!

## Framework Devtools

A build‑tool plugin that adds an in‑app chat panel and element inspector to your dev server. It connects your running app to an AI coding agent (currently Claude Code). Vite adapter available today; more adapters for other bundlers/dev servers are planned.

https://github.com/user-attachments/assets/fd57a0ad-eb63-46cf-8166-cc3af18b1967

### Features

- In‑app chat panel to work with your AI coding agent (currently Claude Code).
- DOM element inspector that captures and shares precise source context with the agent.
- Streaming chat with live responses and visible tool activity.
- Supports React and Vue projects.

### Requirements

- Node 18+
- Coding agent correctly installed and authorized locally (e.g., Claude Code CLI).
- A Vite-based web app (Vite 3+).
- Frameworks: React, Preact, Vue, or JSX/TSX.

### Install

```bash
npm install --save-dev vibest-devtools
# pnpm add -D vibest-devtools
# yarn add -D vibest-devtools
```

### Config

This example uses the Vite adapter. Register it before other framework plugins:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vibest from "vibest-devtools/vite";

export default defineConfig({
  plugins: [vibest(), react()],
});
```

After you start the dev server and open your app, a chat icon appears in the bottom-right. Click it to open the panel — happy vibing!
