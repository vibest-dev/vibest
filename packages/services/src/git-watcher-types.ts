/**
 * Git change event types for streaming.
 */
export interface GitChangeEvent {
  type: "diff";
  path: string;
  stats: {
    insertions: number;
    deletions: number;
    filesChanged: number;
  };
}

export type GitWatcherEvents = {
  [K: `git:changes:${string}`]: GitChangeEvent;
};
