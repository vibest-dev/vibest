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
import { Blocks, FolderPlus, Search, SquarePen } from "lucide-react";
import { useState } from "react";

import { ImportProjectDialog } from "@/components/projects/import-project-dialog";
import { ProjectList } from "@/components/projects/project-list";

export function AppSidebar({ onNewChat }: { onNewChat: () => void }) {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="md:p-1.5">
      {/* Reserves the traffic-light / pinned-toggle row (see __root.tsx). */}
      <SidebarHeader className="h-10 [-webkit-app-region:drag]" />

      <SidebarContent className="[-webkit-app-region:no-drag]">
        {/* New chat and Import project are wired; the rest are placeholders. */}
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
                <SidebarMenuButton onClick={() => setImportOpen(true)}>
                  <FolderPlus />
                  <span>Import project</span>
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

        <ProjectList />
      </SidebarContent>

      {importOpen && <ImportProjectDialog onClose={() => setImportOpen(false)} />}
    </Sidebar>
  );
}
