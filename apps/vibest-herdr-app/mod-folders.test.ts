import { describe, expect, it } from "vitest"

interface ViteImportMeta {
  glob(pattern: readonly string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>
}

const sources = (import.meta as unknown as ViteImportMeta).glob(["./src/mods/*/*.ts", "./src/shared/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
})
const manifests = (import.meta as unknown as ViteImportMeta).glob(["./src/mods/*/mod.json"], {
  query: "?raw",
  import: "default",
  eager: true,
})

const folderOf = (file: string): string => file.split("/").slice(0, -1).join("/")
const files = Object.keys(sources)

const resolve = (from: string, specifier: string): string => {
  const parts = folderOf(from).split("/")
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop()
    else if (part !== ".") parts.push(part)
  }
  return parts.join("/")
}

const imports = (file: string): string[] =>
  [...(sources[file] ?? "").matchAll(/from "(\.[^"]+)"/g)].map((match) => resolve(file, match[1] ?? ""))

describe("mod folders", () => {
  it("gives every mod folder an index.ts entry and a mod.json", () => {
    const withEntry = files.filter((file) => file.endsWith("/index.ts")).map(folderOf)
    expect(withEntry.sort()).toEqual(Object.keys(manifests).map(folderOf).sort())
  })

  it("lets a mod import only its own folder and shared/, and shared/ only itself", () => {
    const crossings = files.flatMap((file) =>
      imports(file)
        .filter((target) => folderOf(target) !== folderOf(file) && folderOf(target) !== "./src/shared")
        .map((target) => `${file} -> ${target}`),
    )
    expect(crossings).toEqual([])
  })

  it("has no import cycles", () => {
    const cycles: string[] = []
    const visit = (file: string, path: readonly string[]): void => {
      if (path.includes(file)) {
        cycles.push([...path.slice(path.indexOf(file)), file].join(" -> "))
        return
      }
      for (const target of imports(file)) visit(target, [...path, file])
    }
    for (const file of files) visit(file, [])
    expect(cycles).toEqual([])
  })
})
