import type { PluginPass, Visitor } from "@babel/core";
import type { TraverseOptions } from "@babel/traverse";
import type * as t from "@babel/types";

import {
  identifier,
  jsxAttribute,
  jsxExpressionContainer,
  jsxIdentifier,
  objectExpression,
  objectProperty,
  stringLiteral,
} from "@babel/types";
import { relative } from "pathe";

import {
  INSPECTOR_ATTRIBUTE,
  INSPECTOR_ATTRIBUTE_DATA_KEY,
  INSPECTOR_NAME_ATTRIBUTE,
  INSPECTOR_NAME_ATTRIBUTE_DATA_KEY,
} from "./constants";

export interface ImportBinding {
  imported: string;
  local: string;
  source: string;
}

export function createTransformVisitor(options: { relativePath: string }): TraverseOptions {
  const { relativePath } = options;

  const imports: Record<string, ImportBinding> = Object.create(null);

  return {
    ImportDeclaration: {
      enter(path) {
        doImportDeclaration(path.node, imports);
      },
    },
    JSXOpeningElement: {
      enter(path) {
        doJSXOpeningElement(path.node, imports, { relativePath });
      },
    },
  } satisfies TraverseOptions;
}

export function createBabelPluginVisitor(options: {
  rootPath?: string;
  relativePath?: string;
}): Visitor<PluginPass> {
  const { rootPath, relativePath } = options;
  const imports: Record<string, ImportBinding> = Object.create(null);

  return {
    ImportDeclaration: {
      enter(path) {
        doImportDeclaration(path.node, imports);
      },
    },
    JSXOpeningElement: {
      enter(path, state) {
        const filename = state?.filename;

        // if relativePath is not set, use rootPath and filename to calculate relative path
        const finalRelativePath =
          relativePath || (rootPath && filename ? relative(rootPath, filename) : filename);

        if (!finalRelativePath) return;
        doJSXOpeningElement(path.node, imports, {
          relativePath: finalRelativePath,
        });
      },
    },
  };
}

export function doImportDeclaration(
  node: t.ImportDeclaration,
  imports: Record<string, ImportBinding>,
) {
  for (const specifier of node.specifiers) {
    const imported = getImportedName(specifier);
    const local = specifier.local.name;
    const source = node.source.value;

    imports[local] = {
      imported,
      local,
      source,
    };
  }
}

export function doJSXOpeningElement(
  node: t.JSXOpeningElement,
  imports: Record<string, ImportBinding>,
  { relativePath }: { relativePath: string },
) {
  if (node.name.type === "JSXNamespacedName") {
    return;
  }
  if (isReactFragment(node)) {
    return;
  }

  const line = node.loc?.start.line;
  const column = node.loc?.start.column;
  const name = getComponentName(node);

  if (name && imports[name] && imports[name].source === "react-native") {
    const inspectorAttribute = jsxAttribute(
      jsxIdentifier("dataSet"),
      jsxExpressionContainer(
        objectExpression([
          objectProperty(
            identifier(INSPECTOR_ATTRIBUTE),
            stringLiteral(`${relativePath}:${line}:${column}`),
          ),
          objectProperty(stringLiteral(INSPECTOR_NAME_ATTRIBUTE), stringLiteral(name)),
        ]),
      ),
    );

    node.attributes.unshift(inspectorAttribute);
  } else {
    const nameAttribute =
      name !== undefined
        ? jsxAttribute(jsxIdentifier(INSPECTOR_NAME_ATTRIBUTE_DATA_KEY), stringLiteral(name))
        : undefined;
    const inspectorAttribute =
      line !== undefined && column !== undefined
        ? jsxAttribute(
            jsxIdentifier(INSPECTOR_ATTRIBUTE_DATA_KEY),
            stringLiteral(`${relativePath}:${line}:${column}`),
          )
        : undefined;

    for (const attribute of [inspectorAttribute, nameAttribute]) {
      if (attribute) {
        node.attributes.unshift(attribute);
      }
    }
  }
}

function isReactFragment(node: t.JSXOpeningElement) {
  return (
    (node.name.type === "JSXIdentifier" && node.name.name.endsWith("Fragment")) ||
    (node.name.type === "JSXMemberExpression" && node.name.property.name.endsWith("Fragment"))
  );
}

export function getImportedName(
  specifier: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier,
): string {
  if (specifier.type === "ImportSpecifier")
    return specifier.imported.type === "Identifier"
      ? specifier.imported.name
      : specifier.imported.value;
  if (specifier.type === "ImportNamespaceSpecifier") return "*";
  return "default";
}

export function getComponentName(node: t.JSXOpeningElement) {
  if (node.name.type === "JSXIdentifier") {
    return node.name.name;
  }
  if (node.name.type === "JSXMemberExpression") {
    if (node.name.object.type === "JSXIdentifier") {
      return node.name.object.name;
    }
  }
  return undefined;
}
