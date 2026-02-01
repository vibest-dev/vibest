# Codebase Overview: vibest

The `vibest` repository is a monorepo dedicated to enhancing the web development experience and productivity by integrating AI coding agents directly into the browser. Its primary purpose is to provide AI agents with rich, accurate context from a developer's running web application, facilitating tasks like code generation, debugging, and code reviews. This project stands out by offering in-browser developer tooling that combines a chat interface with DOM inspection, eliminating the need for external context-bridging tools. It is currently in active development, with a focus on React and Vue projects, primarily leveraging Vite for its build process.

## Architectural Overview

The codebase employs a monorepo architecture, managed with `pnpm` and `Turborepo`, to efficiently organize and build multiple interconnected applications and packages. The core architecture is client-server based, with a local Node.js server (`packages/cli`) acting as the backend for AI agent interactions, and several frontend applications (web app, Chrome side panel, devtools client) serving as the user interfaces.

Key architectural patterns include:

- **Monorepo:** Facilitates code sharing, consistent tooling, and streamlined development across related projects.
- **Client-Server Communication:** Utilizes a custom RPC (Remote Procedure Call) layer (`@orpc`) for type-safe communication between frontend clients and the local backend server.
- **Browser Extension Integration:** A Chrome extension acts as a bridge, injecting content scripts into web pages and providing a side panel UI to interact with the local server and inspect the running application.
- **Modular Design:** Functionality is broken down into distinct packages (e.g., `agents`, `ui`, `code-inspector-web`, `server-rpc`), promoting reusability and maintainability.
- **AI-first Approach:** Deep integration with AI models (specifically Anthropic's Claude Code) is central, with dedicated packages defining AI tools and message handling.

## Components and Modules

The repository is structured into several key applications (`apps`) and shared packages (`packages`):

### Applications (`apps/`)

- **`apps/web`**: The main web application, built with React and TanStack Router. It serves as a standalone interface for interacting with the Claude Code AI. It consumes shared UI components from `@vibest/ui` and communicates with the local CLI server via `@orpc/client`.
- **`apps/chrome-side-panel`**: The user interface for the Chrome browser extension's side panel. This React application is built with Vite and uses `webext-bridge` for communication with other parts of the extension and the inspected web page. It provides a chat interface similar to the main web app but within the browser's context.

### Packages (`packages/`)

- **`packages/agents`**: Contains the core logic for AI agents.
  - **`claude-code`**: Implements the specific logic for interacting with the Anthropic Claude Code AI, handling session management and prompt processing.
- **`packages/ai-sdk-agents`**: Defines the tools and types for AI agent SDKs. This package is crucial as it enumerates the capabilities of AI agents, such as `Bash`, `Read`, `Edit`, `Grep`, `Task`, `Web-Fetch`, and `Web-Search`, allowing the AI to interact with the development environment.
- **`packages/cli`**: The local Node.js server that acts as the backend for the entire system.
  - It uses Express.js to serve static files (the built `apps/web` application) and handles RPC requests from clients via `@orpc/server`.
  - It instantiates and manages the `ClaudeCodeAgent` to process AI prompts.
- **`packages/code-inspector-node`**: The Node.js-side component of the code inspector, likely responsible for processing code on the server or build pipeline to extract metadata for inspection.
- **`packages/code-inspector-web`**: The client-side component of the code inspector. It provides React components and hooks for DOM inspection, capturing file, line, column, and component information from the running web application. It communicates this inspection data through a dedicated messaging layer.
- **`packages/server-rpc`**: Defines the RPC routes and types for the backend server. This ensures type-safe communication between clients and the `cli` server, particularly for Claude Code-related operations.
- **`packages/shared`**: A utility package for common types and constants, especially for inter-extension messaging. This ensures consistent message formats across different parts of the browser extension.
- **`packages/ui`**: A comprehensive UI component library, built with React, Radix UI, and Tailwind CSS. It includes:
  - **`ai-elements`**: Specialized components for building AI chat interfaces (e.g., `Conversation`, `Message`, `PromptInput`).
  - **`claude-code`**: Components for rendering Claude Code-specific outputs, such as detailed visualizations of AI tool invocations (`ClaudeCodeBashTool`, `ClaudeCodeReadTool`, etc.).
  - **`components`**: General-purpose UI components (e.g., `Avatar`, `Button`, `Collapsible`, `DropdownMenu`) that are reused across all frontend applications.
- **`packages/vibest-devtools`**: A Vite plugin designed to inject the in-app chat panel and element inspector into a developer's web server. This package transforms the web application's code to enable the devtools functionality.
- **`packages/vibest-devtools-client`**: The client-side UI for the framework devtools, providing the actual chat panel and inspector that appears within the developer's web app.
- **`packages/webext-bridge`**: A library for robust cross-context messaging within Web Extensions, used to facilitate communication between content scripts, background scripts, and the side panel.

### Examples (`examples/`)

- **`examples/vite-react`**: A fully-featured example React application that demonstrates the integration and usage of the `vibest-devtools` plugin, showcasing various UI components and features.

## High-Level Functionality

The repository provides a suite of tools that collectively offer:

1.  **AI-Powered Coding Assistance:** Enables developers to interact with AI agents (specifically Claude Code) to get help with coding tasks, code reviews, debugging, and general development queries.
2.  **Contextual AI Interaction:** By integrating directly into the browser and development environment, the AI receives highly accurate context (e.g., specific file, line number, component name) of the code being worked on, leading to more relevant and useful responses.
3.  **In-Browser Developer Tools:** Offers an in-app chat panel and a DOM element inspector that operates directly within the running web application.
4.  **Live Code Inspection:** The DOM element inspector allows developers to select UI elements and automatically extract their source code location (file, line, component), which can then be fed to the AI.
5.  **Streaming AI Responses:** Supports real-time streaming of AI chat responses, including intermediate steps and tool invocations, providing a dynamic and transparent interaction experience.
6.  **Visualization of AI Tool Activity:** Displays the actions taken by the AI agent (e.g., running bash commands, reading files, performing edits, or executing tasks) in a structured and understandable format within the chat interface.
7.  **Extensible Framework DevTools:** Designed with a plugin architecture (currently a Vite adapter) to support various frontend frameworks and build tools, with future plans for broader compatibility.

## Data Flow and Interactions

Data flow in the `vibest` system is orchestrated across several layers:

1.  **User Interaction (Client-side):**
    - A developer interacts with the UI, either through the main `apps/web` application, the `apps/chrome-side-panel`, or the `vibest-devtools-client` injected into their web app.
    - **Text Input:** User types a prompt into the chat interface.
    - **DOM Inspection:** User clicks on an element in their running web application. The `code-inspector-web` package captures metadata (file path, line, column, component name) associated with that element. This data is then sent to the `chrome-extension`.

2.  **Browser Extension Messaging:**
    - The `chrome-extension` acts as an intermediary.
    - `content-main-world.ts` (injected script) and `content.ts` (content script) communicate with the inspected web page to capture DOM inspection data and pass it to the `sidepanel`.
    - `webext-bridge` is used for secure and structured messaging between content scripts, the background script, and the side panel. It also relays the local server URL to the side panel.

3.  **Client-Server Communication (RPC):**
    - The `apps/web` or `apps/chrome-side-panel` (acting as RPC clients) send user prompts and collected inspection data to the local `packages/cli` server.
    - This communication uses `@orpc/client` over HTTP, targeting endpoints defined in `packages/server-rpc`.
    - Requests include the user's message and potentially contextual data like `sessionId` and `InspectedTargetData`.

4.  **Server-side Processing (Backend):**
    - The `packages/cli` server, built with Express.js, receives RPC requests via `@orpc/server`.
    - It uses `packages/agents/claude-code` to interact with the Claude Code AI.
    - The AI processes the prompt, potentially utilizing tools defined in `packages/ai-sdk-agents` (e.g., `bash`, `read`, `edit`, `grep`, `task`) based on the context provided.

5.  **AI Response and Streaming:**
    - The Claude Code AI generates a response, which can include text, code blocks, or instructions for tool invocations.
    - The `cli` server streams these responses back to the client using `eventIteratorToStream`, allowing for real-time updates in the UI.

6.  **UI Rendering:**
    - The client (web app or side panel) receives the streamed AI response.
    - Components from `@vibest/ui` (specifically `ai-elements` and `claude-code/message-parts`) parse and render the AI's output, including markdown text, code blocks, and visual representations of executed tools (e.g., `ClaudeCodeBashTool`, `ClaudeCodeReadTool`).
    - Inspector data is also rendered, allowing the user to see which elements were focused.

## State Management Best Practices

When using TanStack Query (server state) with Zustand (client state):

- **Don't Sync State. Derive It!** - Never use `useEffect` to synchronize state between different sources. Instead, derive values at render time using `useMemo`.
- **Server state stays in TanStack Query** - Don't duplicate server data in Zustand. TanStack Query handles caching, refetching, and invalidation.
- **Client state stays in Zustand** - Use Zustand for UI state like selections, form inputs, and local preferences.
- **Store IDs, not objects** - For selections, store `selectedId` in Zustand and derive `selectedItem` from server data.
- **Avoid localStorage persistence for ephemeral UI state** - Desktop apps don't need to persist UI selections across restarts; terminal sessions don't survive anyway.

## Engineering Practices

The `vibest` project adheres to several modern engineering practices to ensure code quality, maintainability, and efficient development:

- **Monorepo Management:** `pnpm` and `Turborepo` are used for dependency management and build orchestration across multiple packages, enabling faster builds and consistent environments.
- **TypeScript:** The entire codebase is written in TypeScript, providing static type checking for improved code reliability, readability, and developer experience.
- **Code Quality & Formatting:** `biome.jsonc` indicates the use of Biome for linting and formatting, enforcing consistent coding styles and identifying potential issues early in the development cycle.
- **Automated Testing:** Unit and integration tests are present (e.g., `vitest.config.ts`, `test` directories), ensuring the correctness of individual modules and their interactions.
- **CI/CD:** A GitHub Actions workflow (`.github/workflows/quality.yml`) automatically runs `test`, `lint`, and `typecheck` checks on every push and pull request to the `main` branch, maintaining code quality standards.
- **Version Management:** `@changesets/cli` is used for managing package versions and generating changelogs, streamlining the release process for the monorepo.
- **Component-Based UI Development:** React is used for building modular and reusable UI components, particularly evident in the `@vibest/ui` package.

## Dependencies and Integrations

The project integrates with several critical technologies and third-party tools:

- **AI/LLM:**
  - `@anthropic-ai/claude-agent-sdk`: The primary AI SDK for building agents and coding assistance.
  - `ai` (Vercel AI SDK): Provides a robust framework for building AI-powered applications, handling chat message formats and streaming.
- **Frontend Development:**
  - **React.js:** The core library for building user interfaces across web apps and browser extensions.
  - **Vite.js:** A fast build tool and development server used for all frontend applications.
  - **TanStack Router:** A type-safe routing library used in the main web application for navigation.
  - **TanStack Query:** Used for data fetching, caching, and state management in the web application.
- **UI Framework:**
  - **Shadcn UI:** A collection of reusable components built with Radix UI and Tailwind CSS, providing a consistent and accessible design system (heavily used in `packages/ui`).
  - `lucide-react`: Icon library.
  - `react-markdown`: For rendering markdown content in chat messages.
- **RPC Communication:**
  - `@orpc/client`, `@orpc/server`, `@orpc/tanstack-query`: A custom RPC solution enabling type-safe communication between clients and the local backend server, and integration with TanStack Query.
- **Backend (Local Server):**
  - `express`: A fast, unopinionated, minimalist web framework for Node.js, used to build the local CLI server.
  - `cors`: Middleware for enabling Cross-Origin Resource Sharing.
  - `ws`: WebSocket library for potential real-time communication.
- **Browser Extension Development:**
  - `webext-bridge`: A specialized library for facilitating secure and efficient message passing between different contexts (content scripts, background scripts, UI pages) within a Web Extension.
- **Monorepo Tooling:**
  - `pnpm`: A fast, disk space efficient package manager.
  - `Turborepo`: A high-performance build system for JavaScript and TypeScript monorepos.
  - `tsdown`: A TypeScript bundler.
  - `biomejs`: A web frontend toolchain for linting, formatting, and more.
- **Other Utilities:**
  - `zod`: TypeScript-first schema declaration and validation library, used for data validation.
  - `date-fns`: A modern JavaScript date utility library.

```

## Core Repository Files

The files listed below are important for code generation and running terminal commands.
*	**Viewing Files**: Use the description provided for the files to determine if you should view relevant files at the given paths before completing certain tasks. For example, look at the linting rules defined in a file before generating code, or view predefined scripts before running test or lint terminal commands.

[
  {
    "description": "Defines project metadata, global dependencies, and scripts, essential for overall project setup and understanding of the development environment.",
    "path": "package.json"
  },
  {
    "description": "Monorepo configuration for Turbo, orchestrating builds, tests, and other tasks across packages and applications.",
    "path": "turbo.json"
  },
  {
    "description": "Defines the workspace structure for pnpm, indicating the packages included in the monorepo.",
    "path": "pnpm-workspace.yaml"
  },
  {
    "description": "Configuration for Biome, providing global linting, formatting rules, and coding standards for the repository.",
    "path": "biome.jsonc"
  },
  {
    "description": "A custom tool configuration file, indicating a specific process or automation setup for the project.",
    "path": "conductor.json"
  },
  {
    "description": "Configuration for Changesets, used for release management, versioning, and changelog generation.",
    "path": ".changeset/config.json"
  },
  {
    "description": "Configuration file for the Cursor AI tool, specifically for managing MCP (Managed Code Provider) servers.",
    "path": ".cursor/mcp.json"
  },
  {
    "description": "Provides a high-level overview of the project, its purpose, features, and initial setup instructions.",
    "path": "README.md"
  },
  {
    "description": "Specific metadata, dependencies, and development scripts for the 'web' frontend application.",
    "path": "apps/web/package.json"
  },
  {
    "description": "TypeScript compiler configuration for the 'web' application, extending a base configuration for consistent type-checking.",
    "path": "apps/web/tsconfig.json"
  },
  {
    "description": "Vite build and development server configuration for the 'web' application, defining how the project is bundled and served.",
    "path": "apps/web/vite.config.ts"
  },
  {
    "description": "Specific metadata, dependencies, and development scripts for the 'cli' package.",
    "path": "packages/cli/package.json"
  },
  {
    "description": "TypeScript compiler configuration for the 'cli' package, ensuring type safety and code quality.",
    "path": "packages/cli/tsconfig.json"
  },
  {
    "description": "Manifest file for the Chrome extension, detailing its permissions, content scripts, and side panel configuration.",
    "path": "chrome-extension/manifest.json"
  },
  {
    "description": "Base TypeScript configuration used by other `tsconfig.json` files across the monorepo, ensuring consistent compiler options and type-checking standards.",
    "path": "tools/typescript/base.json"
  }
]


## Directory Structure

.
├── .changeset/
├── .cursor/
├── .github/
├── .gitignore
├── .node-version
├── .npmrc
├── README.md
├── apps/
│   ├── chrome-side-panel/
│   └── web/
├── biome.jsonc
├── chrome-extension/
├── conductor.json
├── examples/
│   ├── vite-react/
│   └── vite-vue/
├── package.json
├── packages/
│   ├── agents/
│   ├── ai-sdk-agents/
│   ├── cli/
│   ├── code-inspector-node/
│   ├── code-inspector-web/
│   ├── server-rpc/
│   ├── shared/
│   ├── ui/
│   ├── vibest-devtools/
│   ├── vibest-devtools-client/
│   └── webext-bridge/
├── pnpm-workspace.yaml
├── tools/
│   └── typescript/
├── turbo.json
└── vitest.config.ts
```
