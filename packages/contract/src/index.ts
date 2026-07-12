import { claudeCodeContract } from "./claude-code";

export const contract = {
  claudeCode: claudeCodeContract,
};
export type Contract = typeof contract;

export { claudeCodeContract };
export type { ToolPermissionRequest } from "./claude-code";
