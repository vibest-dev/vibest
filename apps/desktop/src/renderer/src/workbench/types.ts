export interface SplitState {
  id: string;
  partIds: string[];
  activePartId: string | null;
}

export interface PartState {
  id: string;
  viewType: string;
  title: string;
  state: unknown;
}

export interface WorkbenchState {
  splits: SplitState[];
  parts: PartState[];
}

export interface ViewState {
  type: string;
  state?: unknown;
}

export function createWorkbenchState(): WorkbenchState {
  return {
    splits: [],
    parts: [],
  };
}
