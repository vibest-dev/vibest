import fs from "node:fs/promises"

import { Schema } from "effect"

import type { Json } from "./driver.ts"

const Entry = Schema.Struct({
  session: Schema.optional(Schema.String),
  after: Schema.optional(Schema.Number),
  sent: Schema.optional(Schema.Boolean),
  text: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Json),
})

export type Entry = {
  readonly session?: string | undefined
  readonly after?: number | undefined
  readonly sent?: boolean | undefined
  readonly text?: string | undefined
  readonly value?: Json | undefined
}

const decodeFile = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Entry)))

const readEntries = async (file: string) => {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)

  return text === undefined ? [] : Object.entries(decodeFile(text))
}

export class Journal {
  private writing: Promise<void> = Promise.resolve()

  private constructor(
    private readonly file: string | undefined,
    private readonly entries: Map<string, Entry>,
  ) {}

  static async open(file?: string) {
    return new Journal(file, new Map(file === undefined ? [] : await readEntries(file)))
  }

  get(key: string) {
    return this.entries.get(key)
  }

  set(key: string, entry: Entry) {
    this.entries.set(key, entry)
    const file = this.file

    if (file === undefined) return this.writing
    const snapshot = JSON.stringify(Object.fromEntries(this.entries), null, 2)
    this.writing = this.writing.then(async () => {
      await fs.writeFile(`${file}.tmp`, snapshot)
      await fs.rename(`${file}.tmp`, file)
    })

    return this.writing
  }
}
