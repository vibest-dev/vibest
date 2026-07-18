import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@vibest/ui/components/sidebar";
import { FolderCode, FolderPlus } from "lucide-react";
import { useState } from "react";

import { ImportProjectDialog } from "@/components/projects/import-project-dialog";

/** The Projects sidebar section: lists imported projects and drives the import flow. */
export function ProjectsSidebarGroup() {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const [importOpen, setImportOpen] = useState(false);

  // The only writer is the import dialog's create mutation, which invalidates on success.
  const projects = useQuery({
    ...orpcQueryUtils.project.list.queryOptions(),
    staleTime: Infinity,
  });

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <SidebarGroupAction title="Import project" onClick={() => setImportOpen(true)}>
        <FolderPlus />
        <span className="sr-only">Import project</span>
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {(projects.data ?? []).map((project) => (
            <SidebarMenuItem key={project.id}>
              <SidebarMenuButton title={project.path}>
                <FolderCode />
                <span>{project.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>

      {importOpen && <ImportProjectDialog onClose={() => setImportOpen(false)} />}
    </SidebarGroup>
  );
}
