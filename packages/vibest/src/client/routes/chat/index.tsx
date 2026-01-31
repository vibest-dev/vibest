import { Navigate } from "@tanstack/react-router";

export const Route = createFileRoute({
  component: Component,
});

function Component() {
  // Redirect to home page - sessions now require sessionId in URL
  return <Navigate to="/" />;
}
