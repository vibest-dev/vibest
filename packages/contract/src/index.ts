import { projectContract } from "./project";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./session-events";

export const contract = {
  project: projectContract,
  session: sessionContract,
};
export type Contract = typeof contract;

export { projectContract, sessionContract };
export type { SessionEventStreamItem } from "./session";
