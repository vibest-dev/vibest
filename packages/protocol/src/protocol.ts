/** Wire protocol. Independent of the package version in package.json. Bump only when a request a current daemon accepts would be misunderstood. */
export const PROTOCOL = 3

export const PROTOCOL_HEADER = "vibest-protocol"
export const CALLER_HEADER = "vibest-caller"
export const SESSION_HEADER = "vibest-session-id"
export const REPOSITORY_HEADER = "vibest-repository"
