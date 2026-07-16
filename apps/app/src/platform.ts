/** Browser or native capabilities supplied by the host entry point. */
export type Platform = {
  /** Optional network adapter for hosts that cannot use the global fetch. */
  fetch?: typeof fetch;
  /** Close the host application when that operation exists. */
  quit?: () => void;
};
