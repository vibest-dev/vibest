import {
  type TransformOptions,
  transform,
  transformTemplate,
} from "@vibest/code-inspector-node/transform";

export interface VueQuery {
  vue?: boolean;
  src?: boolean;
  type?: "script" | "template" | "style" | "custom";
  index?: number;
  lang?: string;
  raw?: boolean;
  from?: string;
  isJsx?: boolean;
}

export function parseVueRequest(id: string): {
  filename: string;
  query: VueQuery;
} {
  const [filename] = id.split("?", 2);
  const url = new URL(id, "http://domain.inspector");
  const query = Object.fromEntries(url.searchParams.entries()) as VueQuery;
  if (query.vue != null) query.vue = true;

  if (query.src != null) query.src = true;

  if (query.index != null) query.index = Number(query.index);

  if (query.raw != null) query.raw = true;

  if ("lang.tsx" in query || "lang.jsx" in query) query.isJsx = true;

  return {
    filename,
    query,
  };
}

export function transformHandler(id: string, code: string, options: TransformOptions) {
  const { filename, query } = parseVueRequest(id);

  const isJsx =
    filename.endsWith(".jsx") ||
    filename.endsWith(".tsx") ||
    (filename.endsWith(".vue") && query.isJsx);
  if (isJsx) {
    const result = transform(code, options);
    if (!result || !result.code) return null;
    return { code: result.code, map: result.map };
  }

  const isTemplate = filename.endsWith(".vue") && query.type !== "style" && !query.raw;
  if (isTemplate) {
    const result = transformTemplate(code, options);
    return { code: result.code, map: result.map };
  }

  return null;
}
