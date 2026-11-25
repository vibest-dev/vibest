export const PROJECT_SPACE = "vibest-projects"
export const TAB_PREFIX = "vibest-"

export const local = (id: string): string => id.split("/").at(-1) ?? id

export const isProjectSpace = (id: string): boolean => local(id) === PROJECT_SPACE

export const isProjectTab = (tab: string | null | undefined): boolean => local(tab ?? "").startsWith(TAB_PREFIX)
