import { sessionContract } from "./session";

export * from "./domain";
export * from "./session-events";

export const contract = {
  session: sessionContract,
};
export type Contract = typeof contract;

export { sessionContract };
export type { SessionEventStreamItem } from "./session";
