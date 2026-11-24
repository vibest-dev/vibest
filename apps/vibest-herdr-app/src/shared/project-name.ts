export const VIBEST_PREFIX = "Vibest/"

export const projectName = (name: string): string => {
  if (!name.startsWith(VIBEST_PREFIX)) return name

  const stripped = name.slice(VIBEST_PREFIX.length).trim()

  return stripped === "" ? name : stripped
}
