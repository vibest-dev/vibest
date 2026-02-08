import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@vibest/ui/components/sheet";

import { PrimarySidebar, type PrimarySidebarProps } from "./sidebar";

interface PrimarySidebarOverlayProps extends PrimarySidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PrimarySidebarOverlay({
  open,
  onOpenChange,
  ...sidebarProps
}: PrimarySidebarOverlayProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="left" className="h-full w-[320px] max-w-[85vw] p-0" showCloseButton>
        <SheetHeader className="sr-only">
          <SheetTitle>Primary sidebar</SheetTitle>
          <SheetDescription>Task and repository navigation</SheetDescription>
        </SheetHeader>
        <div className="h-full">
          <PrimarySidebar {...sidebarProps} />
        </div>
      </SheetPopup>
    </Sheet>
  );
}
