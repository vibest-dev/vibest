import { z } from "zod";

// Path to stable ID conversion
export function pathToId(path: string): string {
  return path.replace(/^\//, "").replace(/\//g, "-");
}

// ID generators using native crypto
export const generateTaskId = () => `task_${crypto.randomUUID().slice(0, 12)}`;
export const generateLabelId = () => `label_${crypto.randomUUID().slice(0, 8)}`;

// Label schema - uses id as primary key (enables renaming)
export const LabelSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  color: z.string().regex(/^[0-9A-Fa-f]{6}$/),
  description: z.string().max(200).optional(),
});

export type Label = z.infer<typeof LabelSchema>;

// Default labels for new repositories (workflow stages only)
export const DEFAULT_LABELS: Label[] = [
  { id: "label_todo", name: "todo", color: "e4e669", description: "Not started" },
  { id: "label_progress", name: "in-progress", color: "0075ca", description: "In progress" },
  { id: "label_review", name: "review", color: "a2eeef", description: "Pending review" },
  { id: "label_done", name: "done", color: "0e8a16", description: "Completed" },
];

// Task schema
export const TaskSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  labels: z.array(z.string()), // References Label.id
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Task = z.infer<typeof TaskSchema>;

// Repository
export const RepositorySchema = z.object({
  id: z.string(), // Derived from path: pathToId(path)
  name: z.string(),
  path: z.string(), // Main repository path
  defaultBranch: z.string(), // Default branch for creating worktrees (e.g., "main", "master")
  labels: z.array(LabelSchema).default([]), // Repository-level label definitions
});

export type Repository = z.infer<typeof RepositorySchema>;

// Worktree (stored in electron-store, without runtime fields)
export const StoredWorktreeSchema = z.object({
  id: z.string(), // Derived from path: pathToId(path)
  repositoryId: z.string(), // Derived from repository path: pathToId(repositoryPath)
  taskId: z.string(), // Associated Task ID (required - every worktree belongs to a task)
  path: z.string(), // Full path
  branch: z.string(), // Branch name
});

export type StoredWorktree = z.infer<typeof StoredWorktreeSchema>;

// Worktree (with runtime fields for API responses)
export const WorktreeSchema = StoredWorktreeSchema.extend({
  exists: z.boolean(), // Whether the worktree path exists on disk
});

export type Worktree = z.infer<typeof WorktreeSchema>;

// Git Status
export const GitStatusSchema = z.object({
  branch: z.string(),
  ahead: z.number(),
  behind: z.number(),
  staged: z.number(), // Number of staged files
  modified: z.number(), // Number of modified files
  untracked: z.number(), // Number of untracked files
  clean: z.boolean(),
});

export type GitStatus = z.infer<typeof GitStatusSchema>;

// Branch Info
export const BranchSchema = z.object({
  name: z.string(),
  current: z.boolean(),
  remote: z.string(), // Remote tracking branch, empty string if none
});

export type Branch = z.infer<typeof BranchSchema>;

// Store Schema
export interface StoreSchema {
  repositories: Repository[];
  tasks: Task[];
  worktrees: StoredWorktree[];
}

// Git Diff types
export const DiffFileContentsSchema = z.object({
  filename: z.string(),
  contents: z.string(),
});

export type DiffFileContents = z.infer<typeof DiffFileContentsSchema>;

export const FileDiffSchema = z.object({
  oldFile: DiffFileContentsSchema.nullable(),
  newFile: DiffFileContentsSchema.nullable(),
  status: z.enum(["modified", "added", "deleted", "renamed"]),
});

export type FileDiff = z.infer<typeof FileDiffSchema>;

export const DiffResultSchema = z.object({
  files: z.array(FileDiffSchema),
  stats: z.object({
    filesChanged: z.number(),
    insertions: z.number(),
    deletions: z.number(),
  }),
});

export type DiffResult = z.infer<typeof DiffResultSchema>;

// Lightweight diff stats (no file content)
export const DiffFileInfoSchema = z.object({
  path: z.string(),
  status: z.enum(["modified", "added", "deleted", "renamed"]),
  staged: z.boolean(),
  insertions: z.number(),
  deletions: z.number(),
  size: z.number(), // file size in bytes
});

export type DiffFileInfo = z.infer<typeof DiffFileInfoSchema>;

export const DiffStatsSchema = z.object({
  files: z.array(DiffFileInfoSchema),
  totalInsertions: z.number(),
  totalDeletions: z.number(),
});

export type DiffStats = z.infer<typeof DiffStatsSchema>;

// Single file diff content (lazy loaded)
export const FileDiffContentSchema = z.object({
  path: z.string(),
  oldContent: z.string().nullable(),
  newContent: z.string().nullable(),
  error: z.string().optional(), // "too_large" | "binary" | "not_found"
});

export type FileDiffContent = z.infer<typeof FileDiffContentSchema>;
