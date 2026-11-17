export const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
