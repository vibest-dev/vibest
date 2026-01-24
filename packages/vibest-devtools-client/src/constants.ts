/**
 * the root path of the project
 */
export const rootPath = /* @__PURE__ */ process.env.VIBEST_ROOT_PATH;
/**
 * the workspace path of the project (the git repository root path), useful in monorepo
 */
export const workspacePath = /* @__PURE__ */ process.env.VIBEST_WORKSPACE_PATH;
/**
 * the server port of the dev server
 */
// biome-ignore lint/style/noNonNullAssertion: env var is guaranteed to be set at build time
export const VIBEST_LOCAL_URL = /* @__PURE__ */ process.env.VIBEST_LOCAL_URL!;
