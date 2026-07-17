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

// Static placeholder lists — this is a layout shell with sample mock data.
// Real conversation data needs a `session.list` endpoint that doesn't exist yet.
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
      {/*
       * Empty top band, same height as the card header (routes/__root.tsx, h-10).
       * The pinned collapse toggle (rendered in __root.tsx) floats over its
       * top-left, beside the macOS traffic lights; this band just reserves the
       * space. Kept on web too for a consistent top edge across hosts.
       */}
      <SidebarHeader className="h-10" />

      <SidebarContent>
        {/* Primary nav — only New chat is wired; the rest are placeholders. */}
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

        {/* Pinned — placeholder rows. */}
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

        {/* Projects — placeholder groups and rows. */}
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
