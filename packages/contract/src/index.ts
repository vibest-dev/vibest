import { projectContract } from "./project";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./project";

export const contract = {
  session: sessionContract,
  project: projectContract,
};
export type Contract = typeof contract;

export { projectContract, sessionContract };
