import { transform as babelTransform } from "@babel/core";
// import vueJsxPlugin from "@vue/babel-plugin-jsx";
import {
  type AttributeNode,
  type BaseElementNode,
  type NodeTransform,
  NodeTypes,
  parse as vueParse,
  transform as vueTransform,
} from "@vue/compiler-dom";
import MagicString from "magic-string";
import { relative } from "pathe";
import invariant from "tiny-invariant";

import { InspectorBabelPlugin } from "./babel";
import { INSPECTOR_ATTRIBUTE_DATA_KEY, INSPECTOR_NAME_ATTRIBUTE_DATA_KEY } from "./constants";

export interface TransformOptions {
  /**
   * root path of project
   */
  rootPath?: string;
  /**
   * absolute path of source file
   */
  absolutePath?: string;
  /**
   * relative path of source file
   */
  relativePath?: string;
}

export const transform = (
  code: string,
  { rootPath, absolutePath, relativePath }: TransformOptions,
) => {
  invariant(
    (rootPath && absolutePath) || relativePath,
    "both rootPath and absolutePath or relativePath is required",
  );
  // use babel transform
  return babelTransform(code, {
    filename: absolutePath, // pass filename to babel, so state.filename has value
    parserOpts: {
      sourceType: "module",
      allowUndeclaredExports: true,
      allowImportExportEverywhere: true,
      plugins: ["jsx", "typescript"],
    },
    plugins: [InspectorBabelPlugin({ rootPath, relativePath })],
    generatorOpts: {
      retainLines: true,
    },
  });

  // backup parse/traverse/generate method (verified to work)
  // const ast: Node = parse(code, {
  // 	sourceType: "module",
  // 	allowUndeclaredExports: true,
  // 	allowImportExportEverywhere: true,
  // 	plugins: ["jsx", "typescript", ...(options?.babelPlugins ?? [])],
  // 	...options?.babelOptions,
  // });

  // traverse(ast, createTransformVisitor({ relativePath }));

  // return generate(ast, { retainLines: true });
};
const EXCLUDE_TAG = ["template", "script", "style"];

export const transformTemplate = (
  code: string,
  { rootPath, absolutePath, relativePath }: TransformOptions,
) => {
  invariant(
    (rootPath && absolutePath) || relativePath,
    "both rootPath and absolutePath or relativePath is required",
  );

  const s = new MagicString(code);
  const ast = vueParse(code, { comments: true });
  vueTransform(ast, {
    nodeTransforms: [vueNodeTransformer({ s, rootPath, relativePath, absolutePath })],
  });

  return {
    code: s.toString(),
    map: s.generateMap(),
  };
};

type VueNodeTransformer = (
  options: TransformOptions & {
    s?: MagicString;
  },
) => NodeTransform;

export const vueNodeTransformer: VueNodeTransformer =
  ({ rootPath, relativePath, s }) =>
  (node, context) => {
    const filename = context.filename;
    if (node.type === 1) {
      if ((node.tagType === 0 || node.tagType === 1) && !EXCLUDE_TAG.includes(node.tag)) {
        if (node.loc.source.includes(INSPECTOR_ATTRIBUTE_DATA_KEY)) return;
        const insertPosition = node.props.length
          ? Math.max(...node.props.map((i) => i.loc.end.offset))
          : node.loc.start.offset + node.tag.length + 1;
        const { line, column } = node.loc.start;
        // if relativePath is not set, use rootPath and filename to calculate relative path
        const finalRelativePath =
          relativePath || (rootPath && filename ? relative(rootPath, filename) : filename);

        if (s) {
          const content = [
            ` ${INSPECTOR_ATTRIBUTE_DATA_KEY}="${finalRelativePath}:${line}:${column}"`,
            ` ${INSPECTOR_NAME_ATTRIBUTE_DATA_KEY}="${node.tag}"`,
          ]
            .filter((e) => e && e !== " ")
            .join("");
          s.prependLeft(insertPosition, content);
        } else {
          const el = node as BaseElementNode;
          el.props.push(
            {
              type: NodeTypes.ATTRIBUTE,
              name: INSPECTOR_ATTRIBUTE_DATA_KEY,
              // @ts-expect-error
              value: {
                type: NodeTypes.TEXT,
                content: `"${finalRelativePath}:${line}:${column}`,
              },
            } satisfies AttributeNode,
            {
              type: NodeTypes.ATTRIBUTE,
              name: INSPECTOR_NAME_ATTRIBUTE_DATA_KEY,
              // @ts-expect-error
              value: {
                type: NodeTypes.TEXT,
                content: node.tag,
              },
            } satisfies AttributeNode,
          );
        }
      }
    }
  };
