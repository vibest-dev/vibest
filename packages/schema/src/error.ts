export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
