import type { PropsWithChildren, ReactElement } from "react";

import type { Platform } from "./platform";
import { PlatformContext } from "./platform-context";

export function PlatformProvider({
  value,
  children,
}: PropsWithChildren<{ value: Platform }>): ReactElement {
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}
