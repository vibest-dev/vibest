import { fsContract } from "./fs";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./session-events";

export const contract = {
  session: sessionContract,
  fs: fsContract,
};
export type Contract = typeof contract;

export { fsContract, sessionContract };
export type { SessionEventStreamItem } from "./session";
