declare const VIBEST_VERSION: string

export const VERSION = typeof VIBEST_VERSION === "undefined" ? "0.0.0-local" : VIBEST_VERSION
