# Terminal Link Support Design

## Overview

Enable clickable links in the desktop terminal, supporting both ANSI hyperlinks (OSC 8) and auto-detected URLs.

## Requirements

- Support ANSI hyperlinks (OSC 8 escape sequences)
- Auto-detect URLs in terminal output (`http://`, `https://`, `file://`)
- Click to open with system default application
- Keep implementation simple with default styling

## Architecture

### Data Flow

```
Terminal Output → XTerm Render → addon-web-links detects URL
                                        ↓
                               User clicks link
                                        ↓
                               Callback triggers IPC
                                        ↓
                               Main process shell.openExternal(url)
                                        ↓
                               System default app opens
```

### Link Types

| Type | Handling |
|------|----------|
| ANSI hyperlinks (OSC 8) | XTerm v6 native support |
| Auto-detected URLs | `@xterm/addon-web-links` |

## Implementation

### Dependencies

```bash
pnpm add @xterm/addon-web-links --filter @vibest/desktop
```

### File Changes

#### 1. `apps/desktop/src/shared/contract/shell.ts` (new file)

```typescript
import { z } from "zod";

export const openExternalInput = z.object({
  url: z.string(),
});

export type OpenExternalInput = z.infer<typeof openExternalInput>;
```

#### 2. `apps/desktop/src/shared/contract/index.ts`

Export shell contract.

#### 3. `apps/desktop/src/main/router.ts`

```typescript
import { shell } from "electron";

// Add to router
shell: {
  openExternal: async ({ url }) => {
    const parsed = new URL(url);
    const allowed = ["http:", "https:", "file:"];

    if (allowed.includes(parsed.protocol)) {
      await shell.openExternal(url);
    }
  },
},
```

#### 4. `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx`

```typescript
import { WebLinksAddon } from "@xterm/addon-web-links";

// After terminal initialization, before WebglAddon
const webLinksAddon = new WebLinksAddon((event, uri) => {
  event.preventDefault();
  client.shell.openExternal({ url: uri });
});

terminal.loadAddon(webLinksAddon);
```

### Addon Load Order

1. FitAddon
2. WebLinksAddon (new)
3. WebglAddon

WebLinksAddon must load before WebglAddon.

### Security

Only allow safe protocols:
- `http:`
- `https:`
- `file:`

Reject dangerous protocols like `javascript:`, `data:`.

## Testing

1. Run `echo "https://github.com"` in terminal
2. Hover to confirm underline appears
3. Ctrl/Cmd + click to confirm browser opens
4. Test `file:///` path opens Finder/file manager

## Decision Log

| Decision | Choice | Reason |
|----------|--------|--------|
| URL detection | `@xterm/addon-web-links` | Official addon, minimal code |
| Click behavior | System default app | Simplest UX |
| Link styling | Default | YAGNI - add customization later if needed |
