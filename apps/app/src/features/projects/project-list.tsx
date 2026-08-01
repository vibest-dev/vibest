import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@vibest/ui/components/sidebar";
import { ChevronRight, FolderPlus } from "lucide-react";

import { ProjectSessionsGroup } from "@/features/projects/project-sessions-group";
import { useProjects } from "@/features/projects/use-projects";

/** Every imported project, each rendering its own session list. */
export function ProjectList({ onImport }: { onImport: () => void }) {
  const projects = useProjects();

  return (
    <Collapsible defaultOpen>
      <SidebarGroup>
        <SidebarGroupLabel
          className="text-sidebar-foreground/70 tracking-wider"
          render={
            <CollapsibleTrigger className="group/projects-trigger hover:bg-sidebar-accent/70 cursor-pointer gap-1.5 pe-8" />
          }
        >
          <span>Projects</span>
          <ChevronRight className="transition-transform group-data-[panel-open]/projects-trigger:rotate-90" />
        </SidebarGroupLabel>
        <SidebarGroupAction onClick={onImport} title="Import project">
          <FolderPlus />
          <span className="sr-only">Import project</span>
        </SidebarGroupAction>
        <CollapsiblePanel>
          <SidebarGroupContent className="flex flex-col gap-2">
            {(projects.data ?? []).map((project) => (
              <ProjectSessionsGroup key={project.id} project={project} />
            ))}
          </SidebarGroupContent>
        </CollapsiblePanel>
      </SidebarGroup>
    </Collapsible>
  );
}
