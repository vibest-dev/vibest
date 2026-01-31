import { createContext, type RefObject, useContext, useRef, useState } from "react";
import invariant from "tiny-invariant";

interface ToolbarContextType {
  toolbarRef: RefObject<HTMLDivElement>;
  sessionId: RefObject<string | undefined>;
  open: boolean;
  setOpen: (open: boolean) => void;
}
const ToolbarContext = createContext<ToolbarContextType>({} as ToolbarContextType);

interface ToolbarProvidersProps {
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export const ToolbarProviders = ({ defaultOpen, children }: ToolbarProvidersProps) => {
  const sessionId = useRef<string | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement>({} as HTMLDivElement);
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <ToolbarContext.Provider value={{ toolbarRef, sessionId, open, setOpen }}>
      {children}
    </ToolbarContext.Provider>
  );
};

export const useToolbarContext = () => {
  const context = useContext(ToolbarContext);
  invariant(context, "useToolbarContext must be used within a ToolbarContextProvider");
  return context;
};
