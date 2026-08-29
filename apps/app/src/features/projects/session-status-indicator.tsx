import type { SessionPhase } from "@vibest/contract";
import { Spinner } from "@vibest/ui/components/spinner";

const SLOT_CLASS = "ms-auto inline-flex size-3 shrink-0 items-center justify-center";

/** Server-derived session phase after the title. Idle rows omit the slot. */
export function SessionStatusIndicator({ phase }: { readonly phase: SessionPhase | undefined }) {
  switch (phase) {
    case "running":
      return (
        <span
          className={SLOT_CLASS}
          data-slot="session-status"
          data-state="loading"
          title="A turn is running in this session"
        >
          <Spinner className="size-3" aria-label="A turn is running in this session" />
        </span>
      );
    case "requires_action":
      return (
        <span
          className={SLOT_CLASS}
          aria-hidden
          data-slot="session-status"
          data-state="requires-action"
        >
          <span className="bg-warning size-2 rounded-full" title="Waiting for your action" />
        </span>
      );
    case "recovery_required":
      return (
        <span
          className={SLOT_CLASS}
          aria-hidden
          data-slot="session-status"
          data-state="recovery-required"
        >
          <span className="bg-warning size-2 rounded-full" title="This session needs recovery" />
        </span>
      );
    case "crashed":
      return (
        <span className={SLOT_CLASS} aria-hidden data-slot="session-status" data-state="crashed">
          <span className="bg-destructive size-2 rounded-full" title="Session crashed" />
        </span>
      );
    case "idle":
    case undefined:
      return null;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}
