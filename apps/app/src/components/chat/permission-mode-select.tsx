import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import type { SessionConfigOption } from "@/core/harness/session-config";

// Presentational permission-mode picker: value/onChange driven so it composes
// both inside a session (ChatPermissionModeSelect binds it to ChatSession
// context) and on the draft surface (URL search params, no session yet).
//
// Each id is an outward permission-mode id the harness maps to its own native
// system. An empty list means the harness has no permission protocol at all
// (pi) — render nothing rather than an empty dropdown.
export function PermissionModeSelect({
  permissionModes,
  value,
  onChange,
}: {
  permissionModes: ReadonlyArray<SessionConfigOption>;
  value: string | undefined;
  onChange: (mode: string) => void;
}) {
  if (permissionModes.length === 0) return null;

  const items = permissionModes.map((mode) => ({ label: mode.label, value: mode.id }));

  return (
    <PromptInputModelSelect
      items={items}
      value={value ?? null}
      onValueChange={(next) => {
        if (next) onChange(String(next));
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {permissionModes.map((mode) => (
          <PromptInputModelSelectItem key={mode.id} value={mode.id}>
            {mode.label}
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
