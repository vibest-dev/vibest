import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/chat/")({
  component: Component,
});

function Component() {
  // Redirect to home page - sessions now require sessionId in URL
  return <Navigate to="/" />;
}
