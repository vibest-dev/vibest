import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@vibest/ui/components/sidebar";
import { Blocks, Search, SquarePen } from "lucide-react";
import { useState } from "react";

import { BrandMark } from "@/components/layout/brand-mark";
import { ImportProjectDialog } from "@/features/projects/import-project-dialog";
import { ProjectList } from "@/features/projects/project-list";
import { usePlatform } from "@/platform-context";

export function AppSidebar({ onNewChat }: { onNewChat: () => void }) {
  const [importOpen, setImportOpen] = useState(false);
  const { os } = usePlatform();
  const { isMobile, state } = useSidebar();

  return (
    <Sidebar
      variant="inset"
      // The panel group owns desktop width; mobile remains an overlay sheet.
      collapsible={isMobile ? "offcanvas" : "none"}
      className="w-full [&_[data-slot=scroll-area-scrollbar][data-orientation=vertical]]:mx-0"
    >
      <SidebarHeader className="h-10 flex-row items-center px-4 [-webkit-app-region:drag]">
        {os !== "macos" && <BrandMark />}
        {!isMobile && state === "expanded" && (
          <SidebarTrigger className="ms-auto -me-2 [-webkit-app-region:no-drag]" />
        )}
      </SidebarHeader>

      <SidebarContent className="[-webkit-app-region:no-drag]">
        {/* New chat is wired; the rest are placeholders. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={onNewChat}>
                  <SquarePen />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <Search />
                  <span>Search</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <Blocks />
                  <span>Skills &amp; plugins</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <ProjectList onImport={() => setImportOpen(true)} />
      </SidebarContent>

      {importOpen && <ImportProjectDialog onClose={() => setImportOpen(false)} />}
    </Sidebar>
  );
}
