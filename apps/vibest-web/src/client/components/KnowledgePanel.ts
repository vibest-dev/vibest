import { UiSchema } from "@effect/ui"
import { Tabs } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Schema } from "effect"

import {
  KnowledgeTabSchema,
  ProjectFileEntrySchema,
  type KnowledgeTab,
  type ProjectFileEntry,
} from "../../domain/WebHub.ts"
import {
  IconAtSign,
  IconBookOpen,
  IconBrain,
  IconFileCode,
  IconFileImage,
  IconFileText,
  IconFilm,
  IconPackage,
  IconSearch,
  IconSliders,
} from "../ui/icons.ts"
import {
  Badge,
  buttonClass,
  EmptyState,
  Frame,
  FrameHeader,
  FramePanel,
  TabsListClass,
  TabsTabClass,
} from "../ui/primitives.ts"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileKindIcon<M>(h: Html.H<M>, kind: ProjectFileEntry["kind"]) {
  switch (kind) {
    case "html":
      return IconFileCode(h, "size-3.5 shrink-0 text-warning-foreground")
    case "excalidraw":
      return IconPackage(h, "size-3.5 shrink-0 text-info-foreground")
    case "image":
      return IconFileImage(h, "size-3.5 shrink-0 text-muted-foreground")
    case "video":
      return IconFilm(h, "size-3.5 shrink-0 text-muted-foreground")
    default:
      return IconFileText(h, "size-3.5 shrink-0 text-success-foreground")
  }
}

export const KnowledgePanelMessage = UiSchema.TaggedEnum({
  SelectedTab: { tab: KnowledgeTabSchema },
  UpdatedQuery: { query: Schema.String },
  ClickedOpenFile: { file: ProjectFileEntrySchema },
  ClickedAttachFile: { relativePath: Schema.String },
})

export const KnowledgePanelEvents = UiSchema.TaggedEnum({
  OpenedFile: { file: ProjectFileEntrySchema },
  AttachedFile: { relativePath: Schema.String },
})

const KnowledgePanelDef = Html.component({
  name: "KnowledgePanel",
  props: Schema.Struct({
    files: Schema.Array(ProjectFileEntrySchema),
    activeFileId: Schema.NullOr(Schema.String),
  }),
  model: Schema.Struct({
    tab: KnowledgeTabSchema,
    query: Schema.String,
  }),
  message: KnowledgePanelMessage,
  events: KnowledgePanelEvents,
})

const isKnowledgeTab = Schema.is(KnowledgeTabSchema)

function toKnowledgeTab(value: string): KnowledgeTab {
  return isKnowledgeTab(value) ? value : "artifacts"
}

export const KnowledgePanel = KnowledgePanelDef.make({
  init: () => ({ tab: "artifacts", query: "" }),
  update: {
    SelectedTab: ($, { tab }) => $.evolve({ tab }),
    UpdatedQuery: ($, { query }) => $.evolve({ query }),
    ClickedOpenFile: ($, { file }) => $.emit(KnowledgePanelEvents.OpenedFile({ file })),
    ClickedAttachFile: ($, { relativePath }) => $.emit(KnowledgePanelEvents.AttachedFile({ relativePath })),
  },
  view: (h, model) => {
    const { files, activeFileId } = h.props
    const preferencesFile = files.find((f) => f.category === "preferences")
    let artifactsCount = 0
    let docsCount = 0
    let memoriesCount = 0

    for (const f of files) {
      if (f.category === "artifacts") artifactsCount += 1
      else if (f.category === "docs") docsCount += 1
      else if (f.category === "memories") memoriesCount += 1
    }

    const q = model.query.trim().toLowerCase()

    const filtered = files.filter(
      (f) =>
        f.category === model.tab &&
        (q.length === 0 || f.name.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q)),
    )

    return Frame(h)
      .attr("data-testid", "knowledge-panel")
      .children(
        FrameHeader(h, "px-2.5").children(
          Tabs(h, {
            props: {
              value: model.tab,
              tabs: [{ value: "artifacts" }, { value: "docs" }, { value: "memories" }],
            },
            onEmit: {
              Selected: ({ value }) => KnowledgePanelMessage.SelectedTab({ tab: toKnowledgeTab(value) }),
            },
            view: (tabs) =>
              tabs.root(h.div).children(
                tabs.list(h.div.class(TabsListClass)).children(
                  tabs
                    .tab({
                      element: h.button.class(TabsTabClass).attr("data-testid", "tab-artifacts"),
                      value: "artifacts",
                    })
                    .children(
                      IconPackage(h),
                      "Artifacts",
                      h.span.class("tabular-nums opacity-70").children(String(artifactsCount)),
                    ),
                  tabs
                    .tab({
                      element: h.button.class(TabsTabClass).attr("data-testid", "tab-docs"),
                      value: "docs",
                    })
                    .children(
                      IconBookOpen(h),
                      "Docs",
                      h.span.class("tabular-nums opacity-70").children(String(docsCount)),
                    ),
                  tabs
                    .tab({
                      element: h.button.class(TabsTabClass).attr("data-testid", "tab-memories"),
                      value: "memories",
                    })
                    .children(
                      IconBrain(h),
                      "Memories",
                      h.span.class("tabular-nums opacity-70").children(String(memoriesCount)),
                    ),
                ),
              ),
          }),
          preferencesFile !== undefined &&
            h.button
              .attrs({
                type: "button",
                "data-testid": "open-preferences-btn",
                "aria-label": "Open preferences.md",
                title: "Open preferences.md",
              })
              .class(buttonClass(activeFileId === preferencesFile.id ? "secondary" : "ghost", "icon-xs"))
              .on("click", KnowledgePanelMessage.ClickedOpenFile({ file: preferencesFile }))
              .children(IconSliders(h)),
        ),
        FramePanel(h).children(
          h.div.class("border-b border-border p-2").children(
            h.div
              .class(
                "flex h-7 items-center gap-1.5 rounded-lg border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring/40",
              )
              .children(
                IconSearch(h, "size-3.5 shrink-0 text-muted-foreground"),
                h.input
                  .attrs({
                    type: "text",
                    "data-testid": "knowledge-search-input",
                    placeholder: `Filter ${model.tab}...`,
                    "aria-label": `Filter ${model.tab}`,
                  })
                  .class(
                    "min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground",
                  )
                  .value(model.query)
                  .on("input", ({ value }) => KnowledgePanelMessage.UpdatedQuery({ query: value })),
              ),
          ),
          h.div.class("min-h-0 flex-1 overflow-y-auto").children(
            h.div.class("flex flex-col gap-1 p-2").children(
              filtered.map((file) => {
                const active = file.id === activeFileId

                return h.div
                  .key(file.id)
                  .attr("data-testid", `knowledge-file-${file.name}`)
                  .class(
                    "flex items-center gap-1 rounded-lg border pr-1 transition-colors",
                    active
                      ? "border-border bg-accent text-accent-foreground shadow-xs/5"
                      : "border-transparent hover:bg-accent/60",
                  )
                  .children(
                    h.button
                      .attr("type", "button")
                      .class(
                        "file-row-main flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left",
                      )
                      .on("click", KnowledgePanelMessage.ClickedOpenFile({ file }))
                      .children(
                        fileKindIcon(h, file.kind),
                        h.div
                          .class("flex min-w-0 flex-1 flex-col")
                          .children(
                            h.span.class("truncate text-xs font-medium text-foreground").children(file.name),
                            h.span
                              .class("truncate font-mono text-[10px] text-muted-foreground")
                              .children(
                                `${file.relativePath} · `,
                                h.span.class("tabular-nums").children(formatSize(file.size)),
                              ),
                          ),
                        Badge(h, "outline", "shrink-0 font-mono text-[10px]").children(file.extension),
                      ),
                    h.button
                      .attrs({
                        type: "button",
                        "data-testid": `attach-file-${file.name}`,
                        "aria-label": `Attach @${file.relativePath}`,
                        title: `Attach @${file.relativePath} to Composer`,
                      })
                      .class(buttonClass("ghost", "icon-xs"))
                      .on("click", KnowledgePanelMessage.ClickedAttachFile({ relativePath: file.relativePath }))
                      .children(IconAtSign(h)),
                  )
              }),
              filtered.length === 0 && EmptyState(h, `No files in ${model.tab}/`, "Agent outputs appear here live."),
            ),
          ),
        ),
      )
  },
})
