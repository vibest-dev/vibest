import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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

  return (
    <Sidebar
      variant="inset"
      collapsible="offcanvas"
      // `pe-0` closes the gutter to the inset (which already has `ms-0`), and
      // `mx-0` undoes the scrollbar's own `m-1`, so both land on one seam.
      className="md:p-1.5 md:pe-0 [&_[data-slot=scroll-area-scrollbar][data-orientation=vertical]]:mx-0"
    >
      {/*
       * Reserves the traffic-light / pinned-toggle row (see __root.tsx). On
       * macOS the row belongs to the native traffic lights; everywhere else it
       * carries the brand mark, which collapses away with the sidebar. `px-4`
       * lines its icon up with the menu icons below (this padding + the group's
       * p-2 + the menu button's p-2).
       */}
      <SidebarHeader className="h-10 flex-row items-center px-4 [-webkit-app-region:drag]">
        {os !== "macos" && <BrandMark />}
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
