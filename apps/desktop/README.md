# desktop

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

Run from the repository root so Turborepo builds the CLI before starting Desktop:

```bash
pnpm dev --filter=desktop
```

### Build

Run from the repository root so Turborepo builds all workspace dependencies first:

```bash
# Build the Electron application
pnpm build --filter=desktop

# Create an unpacked application
pnpm turbo run build:unpack --filter=desktop

# Create a macOS package
pnpm turbo run build:mac --filter=desktop
```

### End-to-end tests

```bash
pnpm turbo run e2e --filter=desktop
```
