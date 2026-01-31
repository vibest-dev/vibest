export type InspectState = "idle" | "active";

export interface InspectMetadata {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  componentName: string;
}

export interface InspectedTarget {
  id: string;
  element: HTMLElement;
  metadata: InspectMetadata;
}

export type InspectedTargetData = Pick<InspectedTarget, "id" | "metadata">;

export interface InspectorRpcClientFunctions {
  inspectedTargetsChange: (data: { targets: InspectedTargetData[] }) => void;
  inspectedStateChange: (data: { state: InspectState }) => void;
}

export interface InspectorRpcServerFunctions {
  inspectStart: () => Promise<void>;
  inspectStop: () => Promise<void>;
  inspectRemove: (data: { id: string }) => Promise<void>;
  inspectClear: () => Promise<void>;
}
