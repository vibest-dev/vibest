import { UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Schema } from "effect"

import {
  DaemonStatusSchema,
  ProjectSummarySchema,
  ThemeModeSchema,
  type DaemonStatus,
  type ProjectSummary,
} from "../domain/WebHub.ts"
import { IconCpu, IconFolderGit, IconMoon, IconSearch, IconServer, IconSun } from "../ui/icons.ts"
import { Badge, buttonClass, EmptyState, Frame, FrameHeader, FramePanel, FrameTitle } from "../ui/primitives.ts"

function shortenHomePath(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+/, "~").replace(/^\/Volumes\/SSD\/GitHub\//, "SSD/GitHub/")
}

function formatLoadLabel(daemon: DaemonStatus): string {
  if (!daemon.load) return daemon.connected ? "online" : "offline"

  const cpuText =
    daemon.load.cpuUtilization !== null
      ? `${Math.round(daemon.load.cpuUtilization * 100)}%`
      : `${daemon.load.cpuCount}c`

  const usedGb = Math.max(0, daemon.load.memoryTotalBytes - daemon.load.memoryAvailableBytes) / 1024 ** 3
  const totalGb = Math.max(1, daemon.load.memoryTotalBytes) / 1024 ** 3

  return `${cpuText} · ${usedGb.toFixed(1)}/${totalGb.toFixed(0)}G`
}

function activityDotClass(activity: ProjectSummary["activity"]): string {
  switch (activity) {
    case "blocked":
      return "bg-warning shadow-[0_0_0_2px_color-mix(in_srgb,var(--warning)_24%,transparent)]"
    case "working":
      return "bg-info shadow-[0_0_0_2px_color-mix(in_srgb,var(--info)_24%,transparent)] animate-pulse"
    case "done":
      return "bg-success"
    case "idle":
      return "bg-muted-foreground/50"
  }
}

export const ProjectsPanelMessage = UiSchema.TaggedEnum({
  UpdatedQuery: { query: Schema.String },
  ClickedProject: { projectId: Schema.String },
  ClickedThemeToggle: {},
})

export const ProjectsPanelEvents = UiSchema.TaggedEnum({
  SelectedProject: { projectId: Schema.String },
  ToggledTheme: {},
})

const ProjectsPanelDef = Html.component({
  name: "ProjectsPanel",
  props: Schema.Struct({
    projects: Schema.Array(ProjectSummarySchema),
    selectedProjectId: Schema.NullOr(Schema.String),
    daemon: DaemonStatusSchema,
    theme: ThemeModeSchema,
  }),
  model: Schema.Struct({
    query: Schema.String,
  }),
  message: ProjectsPanelMessage,
  events: ProjectsPanelEvents,
})

export const ProjectsPanel = ProjectsPanelDef.make({
  init: () => ({ query: "" }),
  update: {
    UpdatedQuery: ($, { query }) => $.evolve({ query }),
    ClickedProject: ($, { projectId }) => $.emit(ProjectsPanelEvents.SelectedProject({ projectId })),
    ClickedThemeToggle: ($) => $.emit(ProjectsPanelEvents.ToggledTheme()),
  },
  view: (h, model) => {
    const { projects, selectedProjectId, daemon, theme } = h.props
    const q = model.query.trim().toLowerCase()

    const filtered =
      q.length === 0
        ? projects
        : projects.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.directory.toLowerCase().includes(q) ||
              p.machine.toLowerCase().includes(q),
          )

    return Frame(h)
      .attr("data-testid", "projects-panel")
      .children(
        FrameHeader(h, "py-2").children(
          h.div
            .class("flex min-w-0 items-center gap-1.5")
            .children(
              IconFolderGit(h, "size-3.5 shrink-0 text-muted-foreground"),
              FrameTitle(h).children("Projects"),
              Badge(h, "outline", "tabular-nums").children(String(projects.length)),
            ),
          h.button
            .attrs({
              type: "button",
              "data-testid": "theme-toggle-btn",
              "aria-label": theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
              title: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
            })
            .class(buttonClass("ghost", "icon-xs"))
            .on("click", ProjectsPanelMessage.ClickedThemeToggle())
            .children(theme === "dark" ? IconSun(h) : IconMoon(h)),
        ),
        FramePanel(h).children(
          h.div.class("flex flex-col gap-2 border-b border-border p-2.5").children(
            h.div
              .class(
                "flex h-7 items-center gap-1.5 rounded-lg border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring/40",
              )
              .children(
                IconSearch(h, "size-3.5 shrink-0 text-muted-foreground"),
                h.input
                  .attrs({
                    type: "text",
                    "data-testid": "project-filter-input",
                    placeholder: "Filter projects...",
                    "aria-label": "Filter projects",
                  })
                  .class(
                    "min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground",
                  )
                  .value(model.query)
                  .on("input", ({ value }) => ProjectsPanelMessage.UpdatedQuery({ query: value })),
                h.kbd
                  .class(
                    "rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground",
                  )
                  .children("⌘K"),
              ),
            h.div
              .attrs({ "data-testid": "daemon-status-pill", title: daemon.socket })
              .class("flex items-center justify-between gap-1.5")
              .children(
                Badge(h, daemon.connected ? "success" : "error", "gap-1.5").children(
                  h.span.class("size-1.5 rounded-full", daemon.connected ? "bg-success" : "bg-destructive"),
                  "vibestd",
                ),
                Badge(h, "outline", "gap-1 font-mono text-[10.5px] tabular-nums").children(
                  IconCpu(h, "size-3 text-muted-foreground"),
                  formatLoadLabel(daemon),
                ),
              ),
          ),
          h.div.class("min-h-0 flex-1 overflow-y-auto").children(
            h.div
              .attr("role", "list")
              .class("flex flex-col gap-1 p-2")
              .children(
                filtered.map((project) => {
                  const active = project.id === selectedProjectId

                  return h.button
                    .key(project.id)
                    .attrs({
                      type: "button",
                      role: "listitem",
                      "data-testid": `project-item-${project.name}`,
                    })
                    .class(
                      "group flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                      active
                        ? "border-border bg-accent text-accent-foreground shadow-xs/5"
                        : "border-transparent bg-transparent hover:bg-accent/60",
                    )
                    .on("click", ProjectsPanelMessage.ClickedProject({ projectId: project.id }))
                    .children(
                      h.div
                        .class("flex items-center gap-2")
                        .children(
                          h.span.class("size-2 shrink-0 rounded-full", activityDotClass(project.activity)),
                          h.span
                            .class("min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-foreground")
                            .children(project.name),
                          project.needsYouCount > 0
                            ? Badge(h, "warning", "tabular-nums").children(`Needs You · ${project.needsYouCount}`)
                            : project.activeSubagents > 0
                              ? Badge(h, "info", "tabular-nums").children(`${project.activeSubagents} active`)
                              : false,
                        ),
                      h.div
                        .attr("title", project.directory)
                        .class("truncate font-mono text-[10.5px] text-muted-foreground")
                        .children(shortenHomePath(project.directory)),
                      h.div
                        .class("flex flex-wrap items-center gap-1")
                        .children(
                          Badge(h, "outline", "gap-1 font-normal text-muted-foreground").children(
                            IconServer(h),
                            project.machine,
                          ),
                          Badge(h, "secondary", "max-w-36 truncate font-mono text-[10px]").children(project.branch),
                        ),
                    )
                }),
                filtered.length === 0 && EmptyState(h, "No matching projects", `Try clearing "${model.query}".`),
              ),
          ),
        ),
      )
  },
})
