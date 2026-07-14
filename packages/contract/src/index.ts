import { claudeCodeContract } from "./claude-code";
import { codexContract } from "./codex";

export const contract = {
  claudeCode: claudeCodeContract,
  codex: codexContract,
};
export type Contract = typeof contract;

export { claudeCodeContract, codexContract };
export type { ToolPermissionRequest } from "./claude-code";
