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
      {/*
        Borderless, because it sits in the draft composer's CardFrame header and
        should read as the frame's own label rather than a control stacked above
        it. `select.tsx` is vendored (ADR 0001) and its CVA has no ghost variant,
        so this is a class override — `before:hidden` included, since the base
        draws a 1px inner shadow with that pseudo-element and dropping the border
        alone still leaves a line. focus-visible ring and border stay.
        `justify-self-start` is load-bearing: CardFrameHeader is a grid, and a
        lone child would otherwise stretch and push the chevron to the far right.
        The negative inset lines the label up with the composer text below it.

        The name is only the folder's basename, so two projects can share one —
        the path (on the trigger's title) is what actually tells them apart.
      */}
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
