import type { InspectedTarget, InspectMetadata } from "./types";

import {
  INSPECTOR_ATTRIBUTE_DATA_KEY,
  INSPECTOR_IGNORE_ATTRIBUTE_DATA_KEY,
  INSPECTOR_NAME_ATTRIBUTE_DATA_KEY,
} from "./constants";

const getInspector = (el: HTMLElement) => {
  const data = el.getAttribute(INSPECTOR_ATTRIBUTE_DATA_KEY);
  if (!data) return null;

  const splitRE = /(.+):([\d]+):([\d]+)$/;
  const match = data.match(splitRE);
  if (!match) return null;

  const [_, fileName, line, column] = match;
  return {
    fileName,
    lineNumber: Number(line),
    columnNumber: Number(column),
  };
};

const getInspectorComponentName = (el: HTMLElement) => {
  return el.getAttribute(INSPECTOR_NAME_ATTRIBUTE_DATA_KEY);
};

export const getInspectorMetadata = (el: HTMLElement): InspectMetadata | null => {
  const inspector = getInspector(el);
  if (!inspector) return null;

  return {
    ...inspector,
    // biome-ignore lint/style/noNonNullAssertion: exists
    componentName: getInspectorComponentName(el)!,
  };
};

export const isHTMLElement = (node: EventTarget): node is HTMLElement =>
  node instanceof HTMLElement;

export const tryInspectElement = (
  e: PointerEvent | MouseEvent,
  inspectedTargets: InspectedTarget[] = [],
) => {
  const path = e.composedPath();
  if (!path) return;
  for (const element of path) {
    if (isHTMLElement(element)) {
      if (element.hasAttribute(INSPECTOR_IGNORE_ATTRIBUTE_DATA_KEY)) {
        return;
      }
      if (
        inspectedTargets.some(
          (target) => target.element === element || target.element.contains(element),
        )
      ) {
        return;
      }
      const metadata = getInspectorMetadata(element);
      if (metadata) {
        return {
          element,
          metadata,
        };
      }
    }
  }
};

export const shouldIgnoreInspectorEvent = (event: PointerEvent) => {
  return event
    .composedPath()
    .some(
      (target) => isHTMLElement(target) && target.hasAttribute(INSPECTOR_IGNORE_ATTRIBUTE_DATA_KEY),
    );
};

export const getFilenameFromPath = (path?: string) => {
  return path?.split(/\\|\//).pop() ?? null;
};
