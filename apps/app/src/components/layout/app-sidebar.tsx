import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@vibest/ui/components/sidebar";
import { Blocks, FolderCode, MessageSquare, Pin, Search, SquarePen } from "lucide-react";

// Placeholder mock data — no session.list endpoint yet.
const PINNED = [
  "Refactor auth module",
  "Fix flaky integration tests",
  "API pagination design",
  "Release checklist",
];
const PROJECT_CHATS = ["Set up CI pipeline", "Add dark mode support", "Improve search performance"];
const SAMPLE_CHATS = ["Landing page redesign", "Database migration plan", "Onboarding flow copy"];

export function AppSidebar({ onNewChat }: { onNewChat: () => void }) {
  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="md:p-1.5">
      {/* Reserves the traffic-light / pinned-toggle row (see __root.tsx). */}
      <SidebarHeader className="h-10 [-webkit-app-region:drag]" />

      <SidebarContent className="[-webkit-app-region:no-drag]">
        {/* Only New chat is wired; the rest are placeholders. */}
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
                  <FolderCode />
                  <span>Project info</span>
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

        <SidebarGroup>
          <SidebarGroupLabel>Pinned</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {PINNED.map((title) => (
                <SidebarMenuItem key={title}>
                  <SidebarMenuButton className="text-muted-foreground">
                    <Pin />
                    <span>{title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Project</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {PROJECT_CHATS.map((title) => (
                <SidebarMenuItem key={title}>
                  <SidebarMenuButton className="text-muted-foreground">
                    <MessageSquare />
                    <span>{title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>sample-project</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SAMPLE_CHATS.map((title) => (
                <SidebarMenuItem key={title}>
                  <SidebarMenuButton className="text-muted-foreground">
                    <MessageSquare />
                    <span>{title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
