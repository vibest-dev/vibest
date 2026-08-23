import type { PtyInfo, PtyStreamEvent } from "@vibest/contract";
import { Context, Effect } from "effect";

import { PtySpawnFailed } from "../errors";

export type SpawnedPty = {
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly kill: () => void;
  readonly subscribe: (
    onData: (data: string) => void,
    onExit: (exitCode: number) => void,
  ) => () => void;
};

export type PtySpawnOptions = {
  readonly projectId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly shell: string;
};

export type PtySpawnerShape = {
  readonly spawn: (options: PtySpawnOptions) => Effect.Effect<SpawnedPty, PtySpawnFailed>;
};

export class PtySpawner extends Context.Service<PtySpawner, PtySpawnerShape>()("PtySpawner") {}

export const defaultShell = (platform = process.platform, env = process.env): string => {
  if (platform === "win32") return env.ComSpec ?? env.COMSPEC ?? "powershell.exe";
  return env.SHELL ?? "/bin/bash";
};

export const ptyTitle = (shell: string, ptyId: string): string => {
  const base = shell.replace(/\\/g, "/").split("/").at(-1) || "shell";
  return `${base} ${ptyId.slice(0, 4)}`;
};

export type { PtyInfo, PtyStreamEvent };
