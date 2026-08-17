import { eventIterator, oc, type } from "@orpc/contract";
import { Schema } from "effect";

import { toStandardSchema } from "./domain";

export const PtyIdInputSchema = Schema.Struct({ ptyId: Schema.String });
export type PtyIdInput = typeof PtyIdInputSchema.Type;

export const PtyCreateInputSchema = Schema.Struct({
  projectId: Schema.String.check(Schema.isUUID()),
  cols: Schema.Number,
  rows: Schema.Number,
});
export type PtyCreateInput = typeof PtyCreateInputSchema.Type;

export const PtyListInputSchema = Schema.Struct({
  projectId: Schema.String.check(Schema.isUUID()),
});
export type PtyListInput = typeof PtyListInputSchema.Type;

export const PtyWriteInputSchema = Schema.Struct({
  ptyId: Schema.String,
  data: Schema.String,
});
export type PtyWriteInput = typeof PtyWriteInputSchema.Type;

export const PtyResizeInputSchema = Schema.Struct({
  ptyId: Schema.String,
  cols: Schema.Number,
  rows: Schema.Number,
});
export type PtyResizeInput = typeof PtyResizeInputSchema.Type;

export const PtyInfoSchema = Schema.Struct({
  ptyId: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  cols: Schema.Number,
  rows: Schema.Number,
});
export type PtyInfo = typeof PtyInfoSchema.Type;

export type PtyStreamEvent =
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number };

const ptyIdData = toStandardSchema(Schema.Struct({ ptyId: Schema.String }));
const projectIdData = toStandardSchema(Schema.Struct({ projectId: Schema.String }));
const limitData = toStandardSchema(
  Schema.Struct({ projectId: Schema.String, limit: Schema.Number }),
);

const lookupErrors = {
  NOT_FOUND: { data: ptyIdData },
};

const createErrors = {
  PROJECT_NOT_FOUND: { data: projectIdData },
  LIMIT_REACHED: { data: limitData },
  SPAWN_FAILED: { data: projectIdData },
};

/**
 * Interactive pseudo-terminal sessions. In-memory only — a server restart
 * drops every shell. Output is a dedicated event iterator, not the session
 * firehose.
 */
export const ptyContract = {
  create: oc
    .input(toStandardSchema(PtyCreateInputSchema))
    .errors(createErrors)
    .output(toStandardSchema(PtyInfoSchema)),
  list: oc
    .input(toStandardSchema(PtyListInputSchema))
    .errors({ PROJECT_NOT_FOUND: { data: projectIdData } })
    .output(toStandardSchema(Schema.Array(PtyInfoSchema))),
  get: oc
    .input(toStandardSchema(PtyIdInputSchema))
    .errors(lookupErrors)
    .output(toStandardSchema(PtyInfoSchema)),
  write: oc.input(toStandardSchema(PtyWriteInputSchema)).errors(lookupErrors),
  resize: oc.input(toStandardSchema(PtyResizeInputSchema)).errors(lookupErrors),
  delete: oc.input(toStandardSchema(PtyIdInputSchema)).errors(lookupErrors),
  subscribe: oc
    .input(toStandardSchema(PtyIdInputSchema))
    .errors(lookupErrors)
    .output(eventIterator(type<PtyStreamEvent>())),
};
