import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

const MAGIC = Buffer.from("VBST")
const READY_MARKER = ".ready"

export interface ArchiveEntry {
  readonly path: string
  readonly mode: number
  readonly data: Uint8Array
}

export interface MaterializedAssets {
  readonly root: string
  readonly harnesses: string
  readonly herdrPlugin: string
}

export const encodeArchive = (entries: ReadonlyArray<ArchiveEntry>): Uint8Array => {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)))
  const parts: Array<Buffer> = []
  const header = Buffer.alloc(8)
  MAGIC.copy(header, 0)
  header.writeUInt32BE(sorted.length, 4)
  parts.push(header)

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, "utf8")
    const meta = Buffer.alloc(2 + name.length + 8)
    meta.writeUInt16BE(name.length, 0)
    name.copy(meta, 2)
    meta.writeUInt32BE(entry.mode & 0o777, 2 + name.length)
    meta.writeUInt32BE(entry.data.byteLength, 2 + name.length + 4)
    parts.push(meta, Buffer.from(entry.data))
  }

  return zlib.gzipSync(Buffer.concat(parts), { level: 9 })
}

export const decodeArchive = (compressed: Uint8Array): ReadonlyArray<ArchiveEntry> => {
  const raw = zlib.gunzipSync(compressed)

  if (raw.byteLength < 8 || !raw.subarray(0, 4).equals(MAGIC))
    throw new Error("embedded vibest assets archive is corrupt")
  const count = raw.readUInt32BE(4)
  const entries: Array<ArchiveEntry> = []
  let offset = 8

  for (let i = 0; i < count; i++) {
    const nameLength = raw.readUInt16BE(offset)
    offset += 2
    const relPath = raw.subarray(offset, offset + nameLength).toString("utf8")
    offset += nameLength
    const mode = raw.readUInt32BE(offset)
    offset += 4
    const dataLength = raw.readUInt32BE(offset)
    offset += 4
    const data = new Uint8Array(raw.subarray(offset, offset + dataLength))
    offset += dataLength
    entries.push({ path: relPath, mode, data })
  }

  return entries
}

const collectEntries = (prefix: string, root: string, current: string, out: Array<ArchiveEntry>) => {
  const names = fs.readdirSync(current).sort()

  for (const name of names) {
    const full = path.join(current, name)
    const stat = fs.statSync(full)

    if (stat.isDirectory()) {
      collectEntries(prefix, root, full, out)
      continue
    }

    if (!stat.isFile()) continue
    const rel = path.relative(root, full).split(path.sep).join("/")
    out.push({
      path: `${prefix}/${rel}`,
      mode: stat.mode & 0o777,
      data: fs.readFileSync(full),
    })
  }
}

export const packDirectoryArchive = (
  roots: ReadonlyArray<{ readonly prefix: string; readonly dir: string }>,
): Uint8Array => {
  const entries: Array<ArchiveEntry> = []

  for (const { prefix, dir } of roots) collectEntries(prefix, dir, dir, entries)

  return encodeArchive(entries)
}

const linkHerdrPlugin = (home: string, herdrPlugin: string) => {
  if (!fs.existsSync(herdrPlugin)) return
  const link = path.join(home, "herdr-plugin")

  try {
    if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === herdrPlugin) return
  } catch {}

  const tmp = path.join(home, `.herdr-plugin.${process.pid}.${Math.random().toString(36).slice(2, 10)}`)

  try {
    fs.symlinkSync(herdrPlugin, tmp)
    fs.renameSync(tmp, link)
  } catch {
    fs.rmSync(tmp, { force: true })
  }
}

export const materializeAssets = (home: string, version: string, archive: Uint8Array): MaterializedAssets => {
  const hash = crypto.createHash("sha256").update(archive).digest("hex").slice(0, 16)
  const cacheRoot = path.join(home, "cache", "assets")
  const target = path.join(cacheRoot, `${version}-${hash}`)
  const ready = path.join(target, READY_MARKER)

  if (!fs.existsSync(ready)) {
    fs.mkdirSync(cacheRoot, { recursive: true })

    const tmp = path.join(
      cacheRoot,
      `.tmp-${version}-${hash}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    )

    try {
      fs.mkdirSync(tmp, { recursive: true })

      for (const entry of decodeArchive(archive)) {
        const dest = path.join(tmp, entry.path)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, entry.data)
        fs.chmodSync(dest, entry.mode)
      }

      fs.writeFileSync(path.join(tmp, READY_MARKER), `${version}-${hash}\n`)

      try {
        fs.renameSync(tmp, target)
      } catch (error) {
        fs.rmSync(tmp, { recursive: true, force: true })

        if (!fs.existsSync(ready)) throw error
      }
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw error
    }
  }

  const herdrPlugin = path.join(target, "herdr-plugin")
  linkHerdrPlugin(home, herdrPlugin)

  return {
    root: target,
    harnesses: path.join(target, "harnesses"),
    herdrPlugin,
  }
}
