import { describe, expect, it } from "vitest"

interface ViteImportMeta {
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>
}

const sources = (import.meta as unknown as ViteImportMeta).glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
})
const modJsons = (import.meta as unknown as ViteImportMeta).glob("../home/mods/*/mod.json", {
  query: "?raw",
  import: "default",
  eager: true,
})
const files = Object.keys(sources).map((file) => file.slice("../src/".length))
const isEntry = (file: string): boolean => /^[^/]+\/[^/]+\/vibest-[^/]*\.ts$/.test(file)
const nameOf = (file: string): string => (file.split("/").at(-1) ?? "").replace(/\.ts$/, "")
const folderOf = (file: string): string => file.split("/").slice(0, -1).join("/")
const modFolders = new Set(files.filter(isEntry).map(folderOf))

const owner = (file: string): string | undefined =>
  file.startsWith("shared/") ? "shared" : modFolders.has(folderOf(file)) ? folderOf(file) : undefined

const resolve = (from: string, specifier: string): string => {
  const parts = folderOf(from).split("/")
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop()
    else if (part !== ".") parts.push(part)
  }
  return parts.filter((part) => part !== "").join("/")
}

describe("mod folders", () => {
  it("names only mod entries vibest-*, each with its home/mods/<name>/ folder", () => {
    expect(files.filter((file) => nameOf(file).startsWith("vibest-") && !isEntry(file))).toEqual([])
    const built = Object.keys(modJsons).map((file) => file.split("/").at(-2))
    expect(files.filter(isEntry).map(nameOf).sort()).toEqual(built.sort())
  })

  it("has one folder per mod entry, and every file belongs to a mod folder or src/shared", () => {
    expect([...modFolders].sort()).toEqual(["panel/agents", "sidebar/header", "sidebar/threads", "workspace/topbar"])
    expect(files.filter((file) => owner(file) === undefined)).toEqual([])
  })

  it("lets a file import only from its own mod folder or src/shared, and src/shared only from itself", () => {
    const crossings = files.flatMap((file) =>
      [...(sources[`../src/${file}`] ?? "").matchAll(/from "(\.[^"]+)"/g)]
        .map((match) => resolve(file, match[1] ?? ""))
        .filter((target) => owner(target) !== owner(file) && !(owner(target) === "shared" && owner(file) !== "shared"))
        .map((target) => `${file} -> ${target}`),
    )
    expect(crossings).toEqual([])
  })
})
