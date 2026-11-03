/** `raw` as a JSON object, or undefined when it is not one (not JSON, an array, a scalar). */
export const jsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}
