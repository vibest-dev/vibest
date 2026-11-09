export interface ViewerFile {
  readonly path: string
  readonly on: string | null
}

export interface ViewerTabs {
  readonly files: readonly ViewerFile[]
  readonly active: string | null
}

export const EMPTY_TABS: ViewerTabs = { files: [], active: null }

export const openFile = (tabs: ViewerTabs, file: ViewerFile): ViewerTabs => ({
  files: tabs.files.some((f) => f.path === file.path) ? tabs.files : [...tabs.files, file],
  active: file.path,
})

export const selectFile = (tabs: ViewerTabs, path: string): ViewerTabs =>
  tabs.files.some((f) => f.path === path) ? { ...tabs, active: path } : tabs

export const closeFile = (tabs: ViewerTabs, path: string): ViewerTabs => {
  const index = tabs.files.findIndex((f) => f.path === path)
  const files = tabs.files.filter((f) => f.path !== path)
  if (tabs.active !== path) return { files, active: tabs.active }
  return { files, active: files[Math.min(index, files.length - 1)]?.path ?? null }
}

export const fileName = (path: string): string => path.split("/").pop() || path
