import type { Project } from "@vibest/contract";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vibest/ui/components/select";

// Project picker for the draft surface. There is no default: a new session must
// name its project explicitly, so `null` is a real state the composer blocks on.
export function ProjectSelect({
  projects,
  value,
  onChange,
}: {
  projects: ReadonlyArray<Project>;
  value: string | null;
  onChange: (projectId: string) => void;
}) {
  const selected = projects.find((project) => project.id === value);

  return (
    <Select
      items={projects.map((project) => ({ label: project.name, value: project.id }))}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      value={value}
    >
      {/* The name is only the folder's basename, so two projects can share one —
          the path is what actually tells them apart. */}
      <SelectTrigger
        className="hover:bg-accent -mx-5.5 w-auto min-w-0 justify-self-start border-transparent bg-transparent shadow-none before:hidden dark:bg-transparent"
        size="sm"
        title={selected?.path}
      >
        <SelectValue placeholder="Select a project" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{project.name}</span>
              <span className="text-muted-foreground truncate text-xs">{project.path}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
