import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createVibestClient, createVibestWsClient } from "@vibest/client";
import { toast } from "sonner";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      toast.error(`Error: ${error.message}`, {
        action: {
          label: "retry",
          onClick: () => {
            queryClient.invalidateQueries();
          },
        },
      });
    },
  }),
});

export const orpcClient = createVibestClient();
export const orpcWsClient = createVibestWsClient();

export const orpc = createTanstackQueryUtils({
  orpcClient,
});
