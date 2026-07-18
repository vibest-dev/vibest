import { harnessContract } from "./harness";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./session-events";

export const contract = {
  harness: harnessContract,
  session: sessionContract,
};
export type Contract = typeof contract;

export { harnessContract, sessionContract };
export type { SessionEventStreamItem } from "./session";
