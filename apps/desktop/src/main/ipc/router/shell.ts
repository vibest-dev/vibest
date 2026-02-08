import { implement } from "@orpc/server";
import { shell } from "electron";

import type { AppContext } from "../../app";

import { shellContract } from "../../../shared/contract";

const os = implement(shellContract).$context<AppContext>();

export const openExternal = os.openExternal.handler(async ({ input }) => {
  const { url } = input;

  const parsed = new URL(url);
  const allowed = ["http:", "https:", "file:"];

  if (allowed.includes(parsed.protocol)) {
    await shell.openExternal(url);
  }
});

export const shellRouter = os.router({
  openExternal,
});
