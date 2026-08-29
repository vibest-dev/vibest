import { Alert, AlertDescription, AlertTitle } from "@vibest/ui/components/alert";
import { CircleAlertIcon } from "lucide-react";

import { describeModelError } from "./model-error";

export function ModelErrorCard({ error }: { error: Error }) {
  const details = describeModelError(error.message);
  return (
    <Alert variant="error" className="my-2 max-w-2xl">
      <CircleAlertIcon />
      <AlertTitle>{details.title}</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap">{details.message}</AlertDescription>
    </Alert>
  );
}
