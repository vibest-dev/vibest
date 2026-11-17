import type { Catalog, Fact, Row } from "./event.ts"

type Defined = (typeof Catalog)[keyof typeof Catalog]

export const factOf = (row: Row, definition: Defined, data: Defined["data"]["Type"]): Fact =>
  ({
    aggregate: row.aggregate,
    seq: row.seq,
    at: row.at,
    type: definition.type,
    ...(definition.aggregate === "project" && { projectId: row.aggregate }),
    ...(definition.aggregate === "session" && { sessionId: row.aggregate }),
    data,
  }) as Fact
