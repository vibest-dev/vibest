// Enforces frontend-state and package boundary rules documented in
// .agents/rules/frontend-state.md and .agents/rules/architecture.md.

const FEATURES_ROOT = "apps/app/src/features/";
const APP_ROOT = "apps/app/";

const featureNameFromFilename = (filename) => {
  const normalized = filename.replaceAll("\\", "/");
  const idx = normalized.indexOf(FEATURES_ROOT);
  if (idx === -1) return null;
  const rest = normalized.slice(idx + FEATURES_ROOT.length);
  return rest.split("/")[0] ?? null;
};

const isAppFile = (filename) => filename.replaceAll("\\", "/").includes(APP_ROOT);

const crossFeatureImport = (source, featureName) => {
  if (typeof source !== "string") return null;
  const match = source.match(/^@\/features\/([^/]+)/);
  if (!match || match[1] === featureName) return null;
  return match[1];
};

const featureNoRouteMatch = {
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    const featureName = featureNameFromFilename(filename);
    if (!featureName) return {};

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@tanstack/react-router") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.name === "useMatch" &&
            specifier.importKind !== "type"
          ) {
            context.report({
              node: specifier,
              message:
                "Features must not read route identity via useMatch. Derive session/project context from props or panel handles at the composition root instead.",
            });
          }
        }
      },
    };
  },
};

const featureNoCrossImport = {
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    const featureName = featureNameFromFilename(filename);
    if (!featureName) return {};

    return {
      ImportDeclaration(node) {
        const other = crossFeatureImport(node.source.value, featureName);
        if (!other) return;
        context.report({
          node: node.source,
          message: `Features must not import each other. Move shared needs to a composition root instead of importing from @/features/${other}.`,
        });
      },
    };
  },
};

const appNoServerImport = {
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (!isAppFile(filename)) return {};

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        if (source === "@vibest/server" || source.startsWith("@vibest/server/")) {
          context.report({
            node: node.source,
            message:
              "apps/app must not import @vibest/server. Use @vibest/client and @vibest/contract instead.",
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "vibest-boundaries" },
  rules: {
    "feature-no-route-match": featureNoRouteMatch,
    "feature-no-cross-import": featureNoCrossImport,
    "app-no-server-import": appNoServerImport,
  },
};
