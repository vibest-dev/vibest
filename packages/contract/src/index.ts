import { sessionContract } from "./session";

export * from "./domain";

export const contract = {
  session: sessionContract,
};
export type Contract = typeof contract;

export { sessionContract };
