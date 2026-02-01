import { useQuery } from "@tanstack/react-query";
import { skipToken } from "@tanstack/react-query";

import { orpc } from "../lib/orpc";

interface UseFileDiffOptions {
  path: string | undefined;
  filePath: string | undefined;
  staged?: boolean;
  enabled?: boolean;
}

export function useFileDiff({
  path,
  filePath,
  staged = false,
  enabled = true,
}: UseFileDiffOptions) {
  return useQuery(
    orpc.git.fileDiff.queryOptions({
      input: path && filePath && enabled ? { path, filePath, staged } : skipToken,
    }),
  );
}
