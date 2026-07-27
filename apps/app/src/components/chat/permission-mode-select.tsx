import type { PermissionMode } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import { PERMISSION_MODES } from "@/core/harness/permission-modes";

// Presentational permission-mode picker: value/onChange driven so it composes
// both inside a session (ChatPermissionModeSelect binds it to ChatSession
// context) and on the draft surface (URL search params, no session yet).
//
// The modes are vibest's own vocabulary, so everything shown here — label,
// description, the danger tone on `full` — comes from the client-side table,
// never from the wire. The server only says which members this harness
// supports; an empty subset means it has no permission protocol at all (pi) —
// render nothing rather than an empty dropdown.
export function PermissionModeSelect({
  permissionModes,
  value,
  onChange,
}: {
  permissionModes: ReadonlyArray<PermissionMode>;
  value: PermissionMode | undefined;
  onChange: (mode: PermissionMode) => void;
}) {
  if (permissionModes.length === 0) return null;

  const items = permissionModes.map((mode) => ({
    label: PERMISSION_MODES[mode].label,
    value: mode,
  }));

  return (
    <PromptInputModelSelect
      items={items}
      value={value ?? null}
      onValueChange={(next) => {
        const mode = permissionModes.find((candidate) => candidate === next);
        if (mode) onChange(mode);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {permissionModes.map((mode) => {
          const display = PERMISSION_MODES[mode];
          return (
            <PromptInputModelSelectItem key={mode} value={mode}>
              <span className="flex min-w-0 flex-col">
                <span
                  className={display.tone === "danger" ? "text-destructive truncate" : "truncate"}
                >
                  {display.label}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {display.description}
                </span>
              </span>
            </PromptInputModelSelectItem>
          );
        })}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
