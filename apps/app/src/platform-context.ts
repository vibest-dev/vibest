import { createContext, useContext } from "react";

import type { Platform } from "./platform";

export const PlatformContext = createContext<Platform | undefined>(undefined);

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (!platform) throw new Error("AppInterface must be rendered inside PlatformProvider");
  return platform;
}
