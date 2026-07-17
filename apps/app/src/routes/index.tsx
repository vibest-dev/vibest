import { createFileRoute, redirect } from "@tanstack/react-router";

// "/" has no UI of its own — it redirects to the new-session (draft) surface,
// so the root path only decides where to land, not what to render.
//
// Keep the "/" path literal — the router plugin requires a string literal here
// (autoCodeSplitting breaks otherwise).
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/draft" });
  },
});
