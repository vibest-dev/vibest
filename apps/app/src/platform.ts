/** Browser or native capabilities supplied by the host entry point. */
export type Platform = {
  /** Close the host application when that operation exists. */
  quit?: () => void;
};
