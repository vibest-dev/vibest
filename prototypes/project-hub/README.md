# Vibest Project & Interactive Artifact Hub (Bun Prototype)

Standalone local Bun web studio & companion CLI for managing multi-agent **Projects**, **Workstream Tasks**, **Derived `Needs You` Triage**, **HTML Element/Region Annotation ("元素圈选评论")**, **Excalidraw Whiteboards ("画图")**, and **Markdown Spec / Verify Gates**.

## Quick Start (Single Command)

```bash
cd prototypes/project-hub && bun install && bun run start
```

Opens on **`http://127.0.0.1:4310`** with the pre-seeded `vibest-core` workspace ready to try immediately.

## Companion CLI

```bash
bun prototypes/project-hub/src/cli.ts project ls
bun prototypes/project-hub/src/cli.ts board
bun prototypes/project-hub/src/cli.ts task create --title "Feature X" --branch feat/x
bun prototypes/project-hub/src/cli.ts artifact put html ./option-a.html --title "UI Flow" --request-review
bun prototypes/project-hub/src/cli.ts artifact comments triage-ui-prototype
```

## Automated Tests

```bash
cd prototypes/project-hub && bun test
```
