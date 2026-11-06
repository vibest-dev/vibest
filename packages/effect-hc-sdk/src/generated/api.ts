import { Schema } from "effect"

export const VERSION = "0.1.18" as const
export const GENERATION = 1 as const

export type AttachResult = { readonly "automatic_input": boolean; readonly "channel": number; readonly "resize_notifications": boolean; readonly "terminal": Terminal; }
export const AttachResult: Schema.Codec<AttachResult> = Schema.Struct({ "automatic_input": Schema.Boolean, "channel": Schema.Number, "resize_notifications": Schema.Boolean, "terminal": Schema.suspend((): Schema.Codec<Terminal> => Terminal) })

export type Children = "any" | "all"
export const Children: Schema.Codec<Children> = Schema.Literals(["any", "all"])

export type CoreInfo = { readonly "id": string; readonly "name": string; }
export const CoreInfo: Schema.Codec<CoreInfo> = Schema.Struct({ "id": Schema.String, "name": Schema.String })

export type Display = { readonly "bg"?: string | null | undefined; readonly "cell"?: ReadonlyArray<number> | null | undefined; readonly "cursor"?: string | null | undefined; readonly "fg"?: string | null | undefined; }
export const Display: Schema.Codec<Display> = Schema.Struct({ "bg": Schema.optional(Schema.NullOr(Schema.String)), "cell": Schema.optional(Schema.NullOr(Schema.Array(Schema.Number))), "cursor": Schema.optional(Schema.NullOr(Schema.String)), "fg": Schema.optional(Schema.NullOr(Schema.String)) })

export type DocGetResult = { readonly "value": unknown; readonly "version": number; }
export const DocGetResult: Schema.Codec<DocGetResult> = Schema.Struct({ "value": Schema.Unknown, "version": Schema.Number })

export type DocSetResult = { readonly "version": number; }
export const DocSetResult: Schema.Codec<DocSetResult> = Schema.Struct({ "version": Schema.Number })

export type Edit = { readonly "new": string; readonly "old": string; }
export const Edit: Schema.Codec<Edit> = Schema.Struct({ "new": Schema.String, "old": Schema.String })

export type ExecResult = { readonly "code"?: number | null | undefined; readonly "ms": number; readonly "signal"?: number | null | undefined; readonly "stderr": string; readonly "stdout": string; readonly "timed_out": boolean; readonly "truncated": boolean; }
export const ExecResult: Schema.Codec<ExecResult> = Schema.Struct({ "code": Schema.optional(Schema.NullOr(Schema.Number)), "ms": Schema.Number, "signal": Schema.optional(Schema.NullOr(Schema.Number)), "stderr": Schema.String, "stdout": Schema.String, "timed_out": Schema.Boolean, "truncated": Schema.Boolean })

export type FileReadResult = { readonly "first": number; readonly "last": number; readonly "lines": number; readonly "text": string; }
export const FileReadResult: Schema.Codec<FileReadResult> = Schema.Struct({ "first": Schema.Number, "last": Schema.Number, "lines": Schema.Number, "text": Schema.String })

export type FileResult = { readonly "bytes": number; readonly "path": string; }
export const FileResult: Schema.Codec<FileResult> = Schema.Struct({ "bytes": Schema.Number, "path": Schema.String })

export type FirstMessage = { readonly "reason"?: string | null | undefined; readonly "sent": boolean; readonly "started"?: boolean | null | undefined; readonly "turn"?: number | null | undefined; }
export const FirstMessage: Schema.Codec<FirstMessage> = Schema.Struct({ "reason": Schema.optional(Schema.NullOr(Schema.String)), "sent": Schema.Boolean, "started": Schema.optional(Schema.NullOr(Schema.Boolean)), "turn": Schema.optional(Schema.NullOr(Schema.Number)) })

export type Foreground = { readonly "argv": ReadonlyArray<string>; readonly "cwd": string; readonly "name": string; readonly "pid": number; }
export const Foreground: Schema.Codec<Foreground> = Schema.Struct({ "argv": Schema.Array(Schema.String), "cwd": Schema.String, "name": Schema.String, "pid": Schema.Number })

export type HelloResult = { readonly "core": CoreInfo; readonly "features": ReadonlyArray<string>; readonly "framed": boolean; readonly "generation": number; readonly "methods": ReadonlyArray<string>; readonly "version": string; }
export const HelloResult: Schema.Codec<HelloResult> = Schema.Struct({ "core": Schema.suspend((): Schema.Codec<CoreInfo> => CoreInfo), "features": Schema.Array(Schema.String), "framed": Schema.Boolean, "generation": Schema.Number, "methods": Schema.Array(Schema.String), "version": Schema.String })

export type HolderInfo = { readonly "current": boolean; readonly "instance": string; readonly "pid": number; readonly "terminals": number; }
export const HolderInfo: Schema.Codec<HolderInfo> = Schema.Struct({ "current": Schema.Boolean, "instance": Schema.String, "pid": Schema.Number, "terminals": Schema.Number })

export type IdleOrWorking = "idle" | "working"
export const IdleOrWorking: Schema.Codec<IdleOrWorking> = Schema.Literals(["idle", "working"])

export type InitialSize = { readonly "cols": number; readonly "rows": number; }
export const InitialSize: Schema.Codec<InitialSize> = Schema.Struct({ "cols": Schema.Number, "rows": Schema.Number })

export type InterruptResult = { readonly "key": string; readonly "outcome": string; }
export const InterruptResult: Schema.Codec<InterruptResult> = Schema.Struct({ "key": Schema.String, "outcome": Schema.String })

export type KeysResult = { readonly "status"?: string | null | undefined; readonly "turn": number; }
export const KeysResult: Schema.Codec<KeysResult> = Schema.Struct({ "status": Schema.optional(Schema.NullOr(Schema.String)), "turn": Schema.Number })

export type ListResult = { readonly "hidden_finished": number; readonly "machines": ReadonlyArray<MachineView>; readonly "terminals": ReadonlyArray<Terminal>; }
export const ListResult: Schema.Codec<ListResult> = Schema.Struct({ "hidden_finished": Schema.Number, "machines": Schema.Array(Schema.suspend((): Schema.Codec<MachineView> => MachineView)), "terminals": Schema.Array(Schema.suspend((): Schema.Codec<Terminal> => Terminal)) })

export type Machine = { readonly "host": string; readonly "id": string; readonly "name": string; readonly "session"?: string | null | undefined; readonly "target": string; readonly "temporary"?: boolean | undefined; readonly "version": string; readonly "via"?: boolean | undefined; }
export const Machine: Schema.Codec<Machine> = Schema.Struct({ "host": Schema.String, "id": Schema.String, "name": Schema.String, "session": Schema.optional(Schema.NullOr(Schema.String)), "target": Schema.String, "temporary": Schema.optional(Schema.Boolean), "version": Schema.String, "via": Schema.optional(Schema.Boolean) })

export type MachineListResult = { readonly "machines": ReadonlyArray<MachineView>; }
export const MachineListResult: Schema.Codec<MachineListResult> = Schema.Struct({ "machines": Schema.Array(Schema.suspend((): Schema.Codec<MachineView> => MachineView)) })

export type MachineView = { readonly "host": string; readonly "id": string; readonly "name": string; readonly "session"?: string | null | undefined; readonly "since_ms"?: number | null | undefined; readonly "state": string; readonly "target": string; readonly "temporary"?: boolean | undefined; readonly "version": string; readonly "via"?: boolean | undefined; readonly "why"?: string | null | undefined; }
export const MachineView: Schema.Codec<MachineView> = Schema.Struct({ "host": Schema.String, "id": Schema.String, "name": Schema.String, "session": Schema.optional(Schema.NullOr(Schema.String)), "since_ms": Schema.optional(Schema.NullOr(Schema.Number)), "state": Schema.String, "target": Schema.String, "temporary": Schema.optional(Schema.Boolean), "version": Schema.String, "via": Schema.optional(Schema.Boolean), "why": Schema.optional(Schema.NullOr(Schema.String)) })

export type PutResult = { readonly "bytes": number; readonly "path": string; }
export const PutResult: Schema.Codec<PutResult> = Schema.Struct({ "bytes": Schema.Number, "path": Schema.String })

export type ReadResult = { readonly "complete": boolean; readonly "how": string; readonly "text": string; readonly "why"?: string | null | undefined; }
export const ReadResult: Schema.Codec<ReadResult> = Schema.Struct({ "complete": Schema.Boolean, "how": Schema.String, "text": Schema.String, "why": Schema.optional(Schema.NullOr(Schema.String)) })

export type RemoveResult = { readonly "removed": string; }
export const RemoveResult: Schema.Codec<RemoveResult> = Schema.Struct({ "removed": Schema.String })

export type RunResult = { readonly "address": string; readonly "argv": ReadonlyArray<string>; readonly "cols": number; readonly "created_ms": number; readonly "cwd": string; readonly "die_with_parent"?: boolean | undefined; readonly "exit_code"?: number | null | undefined; readonly "finished_ms"?: number | null | undefined; readonly "first_message"?: FirstMessage | null | undefined; readonly "foreground"?: Foreground | null | undefined; readonly "identity"?: string | undefined; readonly "keep"?: boolean | undefined; readonly "labels": { readonly [key: string]: string }; readonly "name"?: string | null | undefined; readonly "notify"?: boolean | undefined; readonly "output"?: string | null | undefined; readonly "parent"?: string | null | undefined; readonly "paste_gap_ms"?: number | null | undefined; readonly "pid"?: number | null | undefined; readonly "reason"?: string | null | undefined; readonly "records"?: { readonly [key: string]: Status } | undefined; readonly "reported"?: boolean | undefined; readonly "rm"?: boolean | undefined; readonly "rows": number; readonly "screen": string; readonly "signal"?: number | null | undefined; readonly "state": string; readonly "status"?: Status | null | undefined; readonly "status_ms"?: number | null | undefined; readonly "stop"?: string | null | undefined; readonly "submit"?: string | null | undefined; readonly "template"?: string | null | undefined; readonly "title"?: string | undefined; readonly "turn"?: number | undefined; readonly "wait"?: WaitResult | null | undefined; }
export const RunResult: Schema.Codec<RunResult> = Schema.Struct({ "address": Schema.String, "argv": Schema.Array(Schema.String), "cols": Schema.Number, "created_ms": Schema.Number, "cwd": Schema.String, "die_with_parent": Schema.optional(Schema.Boolean), "exit_code": Schema.optional(Schema.NullOr(Schema.Number)), "finished_ms": Schema.optional(Schema.NullOr(Schema.Number)), "first_message": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<FirstMessage> => FirstMessage))), "foreground": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<Foreground> => Foreground))), "identity": Schema.optional(Schema.String), "keep": Schema.optional(Schema.Boolean), "labels": Schema.Record(Schema.String, Schema.String), "name": Schema.optional(Schema.NullOr(Schema.String)), "notify": Schema.optional(Schema.Boolean), "output": Schema.optional(Schema.NullOr(Schema.String)), "parent": Schema.optional(Schema.NullOr(Schema.String)), "paste_gap_ms": Schema.optional(Schema.NullOr(Schema.Number)), "pid": Schema.optional(Schema.NullOr(Schema.Number)), "reason": Schema.optional(Schema.NullOr(Schema.String)), "records": Schema.optional(Schema.Record(Schema.String, Schema.suspend((): Schema.Codec<Status> => Status))), "reported": Schema.optional(Schema.Boolean), "rm": Schema.optional(Schema.Boolean), "rows": Schema.Number, "screen": Schema.String, "signal": Schema.optional(Schema.NullOr(Schema.Number)), "state": Schema.String, "status": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<Status> => Status))), "status_ms": Schema.optional(Schema.NullOr(Schema.Number)), "stop": Schema.optional(Schema.NullOr(Schema.String)), "submit": Schema.optional(Schema.NullOr(Schema.String)), "template": Schema.optional(Schema.NullOr(Schema.String)), "title": Schema.optional(Schema.String), "turn": Schema.optional(Schema.Number), "wait": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<WaitResult> => WaitResult))) })

export type SendResult = { readonly "started"?: boolean | null | undefined; readonly "status"?: string | null | undefined; readonly "turn": number; readonly "wait"?: WaitResult | null | undefined; }
export const SendResult: Schema.Codec<SendResult> = Schema.Struct({ "started": Schema.optional(Schema.NullOr(Schema.Boolean)), "status": Schema.optional(Schema.NullOr(Schema.String)), "turn": Schema.Number, "wait": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<WaitResult> => WaitResult))) })

export type Status = { readonly "app"?: string | undefined; readonly "kind"?: string | null | undefined; readonly "msg"?: string | undefined; readonly "progress"?: number | null | undefined; readonly "state": string; readonly "title"?: string | undefined; }
export const Status: Schema.Codec<Status> = Schema.Struct({ "app": Schema.optional(Schema.String), "kind": Schema.optional(Schema.NullOr(Schema.String)), "msg": Schema.optional(Schema.String), "progress": Schema.optional(Schema.NullOr(Schema.Number)), "state": Schema.String, "title": Schema.optional(Schema.String) })

export type StatusResult = { readonly "core": CoreInfo; readonly "finished": number; readonly "holder"?: HolderInfo | null | undefined; readonly "holders": ReadonlyArray<HolderInfo>; readonly "installed_by"?: string | null | undefined; readonly "live": number; readonly "pid": number; readonly "uptime_ms": number; readonly "version": string; }
export const StatusResult: Schema.Codec<StatusResult> = Schema.Struct({ "core": Schema.suspend((): Schema.Codec<CoreInfo> => CoreInfo), "finished": Schema.Number, "holder": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<HolderInfo> => HolderInfo))), "holders": Schema.Array(Schema.suspend((): Schema.Codec<HolderInfo> => HolderInfo)), "installed_by": Schema.optional(Schema.NullOr(Schema.String)), "live": Schema.Number, "pid": Schema.Number, "uptime_ms": Schema.Number, "version": Schema.String })

export type StopResult = { readonly "stopped": boolean; }
export const StopResult: Schema.Codec<StopResult> = Schema.Struct({ "stopped": Schema.Boolean })

export type SubscribeResult = { readonly "channel"?: number | null | undefined; readonly "seq": number; readonly "terminals": ReadonlyArray<Terminal>; }
export const SubscribeResult: Schema.Codec<SubscribeResult> = Schema.Struct({ "channel": Schema.optional(Schema.NullOr(Schema.Number)), "seq": Schema.Number, "terminals": Schema.Array(Schema.suspend((): Schema.Codec<Terminal> => Terminal)) })

export type TemplateInfo = { readonly "command": string; readonly "description": string; readonly "error"?: string | null | undefined; readonly "name": string; }
export const TemplateInfo: Schema.Codec<TemplateInfo> = Schema.Struct({ "command": Schema.String, "description": Schema.String, "error": Schema.optional(Schema.NullOr(Schema.String)), "name": Schema.String })

export type TemplatesResult = { readonly "templates": ReadonlyArray<TemplateInfo>; }
export const TemplatesResult: Schema.Codec<TemplatesResult> = Schema.Struct({ "templates": Schema.Array(Schema.suspend((): Schema.Codec<TemplateInfo> => TemplateInfo)) })

export type Terminal = { readonly "address": string; readonly "argv": ReadonlyArray<string>; readonly "cols": number; readonly "created_ms": number; readonly "cwd": string; readonly "die_with_parent"?: boolean | undefined; readonly "exit_code"?: number | null | undefined; readonly "finished_ms"?: number | null | undefined; readonly "first_message"?: FirstMessage | null | undefined; readonly "foreground"?: Foreground | null | undefined; readonly "identity"?: string | undefined; readonly "keep"?: boolean | undefined; readonly "labels": { readonly [key: string]: string }; readonly "name"?: string | null | undefined; readonly "notify"?: boolean | undefined; readonly "parent"?: string | null | undefined; readonly "paste_gap_ms"?: number | null | undefined; readonly "pid"?: number | null | undefined; readonly "reason"?: string | null | undefined; readonly "records"?: { readonly [key: string]: Status } | undefined; readonly "reported"?: boolean | undefined; readonly "rm"?: boolean | undefined; readonly "rows": number; readonly "screen": string; readonly "signal"?: number | null | undefined; readonly "state": string; readonly "status"?: Status | null | undefined; readonly "status_ms"?: number | null | undefined; readonly "stop"?: string | null | undefined; readonly "submit"?: string | null | undefined; readonly "template"?: string | null | undefined; readonly "title"?: string | undefined; readonly "turn"?: number | undefined; }
export const Terminal: Schema.Codec<Terminal> = Schema.Struct({ "address": Schema.String, "argv": Schema.Array(Schema.String), "cols": Schema.Number, "created_ms": Schema.Number, "cwd": Schema.String, "die_with_parent": Schema.optional(Schema.Boolean), "exit_code": Schema.optional(Schema.NullOr(Schema.Number)), "finished_ms": Schema.optional(Schema.NullOr(Schema.Number)), "first_message": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<FirstMessage> => FirstMessage))), "foreground": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<Foreground> => Foreground))), "identity": Schema.optional(Schema.String), "keep": Schema.optional(Schema.Boolean), "labels": Schema.Record(Schema.String, Schema.String), "name": Schema.optional(Schema.NullOr(Schema.String)), "notify": Schema.optional(Schema.Boolean), "parent": Schema.optional(Schema.NullOr(Schema.String)), "paste_gap_ms": Schema.optional(Schema.NullOr(Schema.Number)), "pid": Schema.optional(Schema.NullOr(Schema.Number)), "reason": Schema.optional(Schema.NullOr(Schema.String)), "records": Schema.optional(Schema.Record(Schema.String, Schema.suspend((): Schema.Codec<Status> => Status))), "reported": Schema.optional(Schema.Boolean), "rm": Schema.optional(Schema.Boolean), "rows": Schema.Number, "screen": Schema.String, "signal": Schema.optional(Schema.NullOr(Schema.Number)), "state": Schema.String, "status": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<Status> => Status))), "status_ms": Schema.optional(Schema.NullOr(Schema.Number)), "stop": Schema.optional(Schema.NullOr(Schema.String)), "submit": Schema.optional(Schema.NullOr(Schema.String)), "template": Schema.optional(Schema.NullOr(Schema.String)), "title": Schema.optional(Schema.String), "turn": Schema.optional(Schema.Number) })

export type WaitResult = { readonly "children": ReadonlyArray<WaitResult>; readonly "ended": boolean; readonly "exit_code"?: number | null | undefined; readonly "from"?: string | null | undefined; readonly "reason": string; readonly "signal"?: number | null | undefined; readonly "status"?: string | null | undefined; readonly "terminal": string; readonly "turn": number; }
export const WaitResult: Schema.Codec<WaitResult> = Schema.Struct({ "children": Schema.Array(Schema.suspend((): Schema.Codec<WaitResult> => WaitResult)), "ended": Schema.Boolean, "exit_code": Schema.optional(Schema.NullOr(Schema.Number)), "from": Schema.optional(Schema.NullOr(Schema.String)), "reason": Schema.String, "signal": Schema.optional(Schema.NullOr(Schema.Number)), "status": Schema.optional(Schema.NullOr(Schema.String)), "terminal": Schema.String, "turn": Schema.Number })

export type HelloParams = { readonly "calls_you"?: string | null | undefined; readonly "core"?: CoreInfo | null | undefined; readonly "features"?: ReadonlyArray<string> | undefined; readonly "framed"?: boolean | undefined; readonly "generation"?: number | null | undefined; }
export const HelloParams: Schema.Codec<HelloParams> = Schema.Struct({ "calls_you": Schema.optional(Schema.NullOr(Schema.String)), "core": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<CoreInfo> => CoreInfo))), "features": Schema.optional(Schema.Array(Schema.String)), "framed": Schema.optional(Schema.Boolean), "generation": Schema.optional(Schema.NullOr(Schema.Number)) })

export type ServerStatusParams = {  }
export const ServerStatusParams: Schema.Codec<ServerStatusParams> = Schema.Struct({  })

export type ServerStopParams = {  }
export const ServerStopParams: Schema.Codec<ServerStopParams> = Schema.Struct({  })

export type ServerRestartParams = {  }
export const ServerRestartParams: Schema.Codec<ServerRestartParams> = Schema.Struct({  })

export type TerminalRunParams = { readonly "argv"?: ReadonlyArray<string> | undefined; readonly "caller"?: string | null | undefined; readonly "cwd"?: string | null | undefined; readonly "die_with_parent"?: boolean | undefined; readonly "display"?: Display | null | undefined; readonly "env"?: { readonly [key: string]: string } | undefined; readonly "keep"?: boolean | undefined; readonly "labels"?: { readonly [key: string]: string } | undefined; readonly "line"?: string | null | undefined; readonly "name"?: string | null | undefined; readonly "no_notify"?: boolean | undefined; readonly "no_parent"?: boolean | undefined; readonly "on"?: string | null | undefined; readonly "outlive_parent"?: boolean | undefined; readonly "parent"?: string | null | undefined; readonly "rm"?: boolean | undefined; readonly "size"?: InitialSize | null | undefined; readonly "timeout"?: number | null | undefined; readonly "wait"?: boolean | undefined; }
export const TerminalRunParams: Schema.Codec<TerminalRunParams> = Schema.Struct({ "argv": Schema.optional(Schema.Array(Schema.String)), "caller": Schema.optional(Schema.NullOr(Schema.String)), "cwd": Schema.optional(Schema.NullOr(Schema.String)), "die_with_parent": Schema.optional(Schema.Boolean), "display": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<Display> => Display))), "env": Schema.optional(Schema.Record(Schema.String, Schema.String)), "keep": Schema.optional(Schema.Boolean), "labels": Schema.optional(Schema.Record(Schema.String, Schema.String)), "line": Schema.optional(Schema.NullOr(Schema.String)), "name": Schema.optional(Schema.NullOr(Schema.String)), "no_notify": Schema.optional(Schema.Boolean), "no_parent": Schema.optional(Schema.Boolean), "on": Schema.optional(Schema.NullOr(Schema.String)), "outlive_parent": Schema.optional(Schema.Boolean), "parent": Schema.optional(Schema.NullOr(Schema.String)), "rm": Schema.optional(Schema.Boolean), "size": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<InitialSize> => InitialSize))), "timeout": Schema.optional(Schema.NullOr(Schema.Number)), "wait": Schema.optional(Schema.Boolean) })

export type TemplatesListParams = {  }
export const TemplatesListParams: Schema.Codec<TemplatesListParams> = Schema.Struct({  })

export type TerminalListParams = { readonly "all"?: boolean | undefined; readonly "labels"?: { readonly [key: string]: string } | undefined; }
export const TerminalListParams: Schema.Codec<TerminalListParams> = Schema.Struct({ "all": Schema.optional(Schema.Boolean), "labels": Schema.optional(Schema.Record(Schema.String, Schema.String)) })

export type TerminalGetParams = { readonly "caller"?: string | null | undefined; readonly "terminal": string; }
export const TerminalGetParams: Schema.Codec<TerminalGetParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "terminal": Schema.String })

export type TerminalKillParams = { readonly "caller"?: string | null | undefined; readonly "terminal": string; }
export const TerminalKillParams: Schema.Codec<TerminalKillParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "terminal": Schema.String })

export type TerminalRmParams = { readonly "caller"?: string | null | undefined; readonly "terminal": string; }
export const TerminalRmParams: Schema.Codec<TerminalRmParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "terminal": Schema.String })

export type TerminalKeepParams = { readonly "keep": boolean; readonly "terminal": string; }
export const TerminalKeepParams: Schema.Codec<TerminalKeepParams> = Schema.Struct({ "keep": Schema.Boolean, "terminal": Schema.String })

export type TerminalLabelParams = { readonly "labels": { readonly [key: string]: string }; readonly "terminal": string; }
export const TerminalLabelParams: Schema.Codec<TerminalLabelParams> = Schema.Struct({ "labels": Schema.Record(Schema.String, Schema.String), "terminal": Schema.String })

export type TerminalReadParams = { readonly "caller"?: string | null | undefined; readonly "lines"?: number | undefined; readonly "terminal": string; }
export const TerminalReadParams: Schema.Codec<TerminalReadParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "lines": Schema.optional(Schema.Number), "terminal": Schema.String })

export type TerminalAttachParams = { readonly "caller"?: string | null | undefined; readonly "cols": number; readonly "display"?: Display | undefined; readonly "history"?: number | undefined; readonly "observe"?: boolean | undefined; readonly "resize_notifications"?: boolean | undefined; readonly "resumed"?: boolean | undefined; readonly "rows": number; readonly "terminal": string; }
export const TerminalAttachParams: Schema.Codec<TerminalAttachParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "cols": Schema.Number, "display": Schema.optional(Schema.suspend((): Schema.Codec<Display> => Display)), "history": Schema.optional(Schema.Number), "observe": Schema.optional(Schema.Boolean), "resize_notifications": Schema.optional(Schema.Boolean), "resumed": Schema.optional(Schema.Boolean), "rows": Schema.Number, "terminal": Schema.String })

export type TerminalSendParams = { readonly "caller"?: string | null | undefined; readonly "force"?: boolean | undefined; readonly "if"?: IdleOrWorking | null | undefined; readonly "terminal": string; readonly "text": string; readonly "timeout"?: number | null | undefined; readonly "wait"?: boolean | undefined; }
export const TerminalSendParams: Schema.Codec<TerminalSendParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "force": Schema.optional(Schema.Boolean), "if": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<IdleOrWorking> => IdleOrWorking))), "terminal": Schema.String, "text": Schema.String, "timeout": Schema.optional(Schema.NullOr(Schema.Number)), "wait": Schema.optional(Schema.Boolean) })

export type TerminalWaitParams = { readonly "caller"?: string | null | undefined; readonly "children"?: Children | null | undefined; readonly "output"?: string | null | undefined; readonly "terminal"?: string | null | undefined; readonly "timeout"?: number | null | undefined; }
export const TerminalWaitParams: Schema.Codec<TerminalWaitParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "children": Schema.optional(Schema.NullOr(Schema.suspend((): Schema.Codec<Children> => Children))), "output": Schema.optional(Schema.NullOr(Schema.String)), "terminal": Schema.optional(Schema.NullOr(Schema.String)), "timeout": Schema.optional(Schema.NullOr(Schema.Number)) })

export type TerminalKeysParams = { readonly "caller"?: string | null | undefined; readonly "keys": ReadonlyArray<string>; readonly "terminal": string; }
export const TerminalKeysParams: Schema.Codec<TerminalKeysParams> = Schema.Struct({ "caller": Schema.optional(Schema.NullOr(Schema.String)), "keys": Schema.Array(Schema.String), "terminal": Schema.String })

export type TerminalInterruptParams = { readonly "terminal": string; readonly "timeout"?: number | null | undefined; }
export const TerminalInterruptParams: Schema.Codec<TerminalInterruptParams> = Schema.Struct({ "terminal": Schema.String, "timeout": Schema.optional(Schema.NullOr(Schema.Number)) })

export type TerminalPutParams = { readonly "data": string; readonly "name": string; readonly "terminal": string; }
export const TerminalPutParams: Schema.Codec<TerminalPutParams> = Schema.Struct({ "data": Schema.String, "name": Schema.String, "terminal": Schema.String })

export type MachineExecParams = { readonly "argv"?: ReadonlyArray<string> | undefined; readonly "cwd"?: string | null | undefined; readonly "env"?: { readonly [key: string]: string } | undefined; readonly "input"?: string | null | undefined; readonly "line"?: string | null | undefined; readonly "on"?: string | null | undefined; readonly "timeout"?: number | null | undefined; }
export const MachineExecParams: Schema.Codec<MachineExecParams> = Schema.Struct({ "argv": Schema.optional(Schema.Array(Schema.String)), "cwd": Schema.optional(Schema.NullOr(Schema.String)), "env": Schema.optional(Schema.Record(Schema.String, Schema.String)), "input": Schema.optional(Schema.NullOr(Schema.String)), "line": Schema.optional(Schema.NullOr(Schema.String)), "on": Schema.optional(Schema.NullOr(Schema.String)), "timeout": Schema.optional(Schema.NullOr(Schema.Number)) })

export type FileReadParams = { readonly "cwd"?: string | null | undefined; readonly "limit"?: number | null | undefined; readonly "offset"?: number | null | undefined; readonly "on"?: string | null | undefined; readonly "path": string; }
export const FileReadParams: Schema.Codec<FileReadParams> = Schema.Struct({ "cwd": Schema.optional(Schema.NullOr(Schema.String)), "limit": Schema.optional(Schema.NullOr(Schema.Number)), "offset": Schema.optional(Schema.NullOr(Schema.Number)), "on": Schema.optional(Schema.NullOr(Schema.String)), "path": Schema.String })

export type FileWriteParams = { readonly "cwd"?: string | null | undefined; readonly "data": string; readonly "on"?: string | null | undefined; readonly "path": string; }
export const FileWriteParams: Schema.Codec<FileWriteParams> = Schema.Struct({ "cwd": Schema.optional(Schema.NullOr(Schema.String)), "data": Schema.String, "on": Schema.optional(Schema.NullOr(Schema.String)), "path": Schema.String })

export type FileEditParams = { readonly "cwd"?: string | null | undefined; readonly "edits": ReadonlyArray<Edit>; readonly "on"?: string | null | undefined; readonly "path": string; }
export const FileEditParams: Schema.Codec<FileEditParams> = Schema.Struct({ "cwd": Schema.optional(Schema.NullOr(Schema.String)), "edits": Schema.Array(Schema.suspend((): Schema.Codec<Edit> => Edit)), "on": Schema.optional(Schema.NullOr(Schema.String)), "path": Schema.String })

export type DocGetParams = { readonly "name": string; readonly "on"?: string | null | undefined; }
export const DocGetParams: Schema.Codec<DocGetParams> = Schema.Struct({ "name": Schema.String, "on": Schema.optional(Schema.NullOr(Schema.String)) })

export type DocSetParams = { readonly "name": string; readonly "on"?: string | null | undefined; readonly "value": unknown; readonly "version": number; }
export const DocSetParams: Schema.Codec<DocSetParams> = Schema.Struct({ "name": Schema.String, "on": Schema.optional(Schema.NullOr(Schema.String)), "value": Schema.Unknown, "version": Schema.Number })

export type EventsSubscribeParams = { readonly "children_of"?: string | null | undefined; readonly "labels"?: { readonly [key: string]: string } | undefined; readonly "terminal"?: string | null | undefined; }
export const EventsSubscribeParams: Schema.Codec<EventsSubscribeParams> = Schema.Struct({ "children_of": Schema.optional(Schema.NullOr(Schema.String)), "labels": Schema.optional(Schema.Record(Schema.String, Schema.String)), "terminal": Schema.optional(Schema.NullOr(Schema.String)) })

export type MachineAddParams = { readonly "name"?: string | null | undefined; readonly "session"?: string | null | undefined; readonly "target"?: string | null | undefined; readonly "temporary"?: boolean | undefined; readonly "via"?: string | null | undefined; }
export const MachineAddParams: Schema.Codec<MachineAddParams> = Schema.Struct({ "name": Schema.optional(Schema.NullOr(Schema.String)), "session": Schema.optional(Schema.NullOr(Schema.String)), "target": Schema.optional(Schema.NullOr(Schema.String)), "temporary": Schema.optional(Schema.Boolean), "via": Schema.optional(Schema.NullOr(Schema.String)) })

export type MachineListParams = {  }
export const MachineListParams: Schema.Codec<MachineListParams> = Schema.Struct({  })

export type MachineConnectParams = { readonly "machine": string; }
export const MachineConnectParams: Schema.Codec<MachineConnectParams> = Schema.Struct({ "machine": Schema.String })

export type MachineRenameParams = { readonly "machine": string; readonly "new_name": string; }
export const MachineRenameParams: Schema.Codec<MachineRenameParams> = Schema.Struct({ "machine": Schema.String, "new_name": Schema.String })

export type MachineRmParams = { readonly "machine": string; }
export const MachineRmParams: Schema.Codec<MachineRmParams> = Schema.Struct({ "machine": Schema.String })

export type RpcDiscoverParams = {  }
export const RpcDiscoverParams: Schema.Codec<RpcDiscoverParams> = Schema.Struct({  })

export type RpcDiscoverResult = unknown
export const RpcDiscoverResult: Schema.Codec<RpcDiscoverResult> = Schema.Unknown

export const METHODS = {
  "hello": { params: HelloParams, result: HelloResult, errors: ["unsupported_generation"] },
  "server.status": { params: ServerStatusParams, result: StatusResult, errors: [] },
  "server.stop": { params: ServerStopParams, result: StopResult, errors: [] },
  "server.restart": { params: ServerRestartParams, result: StopResult, errors: [] },
  "terminal.run": { params: TerminalRunParams, result: RunResult, errors: ["invalid_params", "name_taken", "spawn_failed", "unavailable", "invalid_template", "not_found", "machine_unknown", "config"] },
  "templates.list": { params: TemplatesListParams, result: TemplatesResult, errors: [] },
  "terminal.list": { params: TerminalListParams, result: ListResult, errors: [] },
  "terminal.get": { params: TerminalGetParams, result: Terminal, errors: ["not_found", "machine_unknown"] },
  "terminal.kill": { params: TerminalKillParams, result: Terminal, errors: ["not_found", "machine_unknown"] },
  "terminal.rm": { params: TerminalRmParams, result: RemoveResult, errors: ["not_found", "machine_unknown", "live"] },
  "terminal.keep": { params: TerminalKeepParams, result: Terminal, errors: ["not_found", "invalid_params"] },
  "terminal.label": { params: TerminalLabelParams, result: Terminal, errors: ["not_found", "machine_unknown", "invalid_params"] },
  "terminal.read": { params: TerminalReadParams, result: ReadResult, errors: ["not_found", "machine_unknown"] },
  "terminal.attach": { params: TerminalAttachParams, result: AttachResult, errors: ["not_found", "machine_unknown", "finished", "unavailable", "needs_framed"] },
  "terminal.send": { params: TerminalSendParams, result: SendResult, errors: ["not_found", "machine_unknown", "finished", "unavailable", "blocked", "status_mismatch", "invalid_params", "config"] },
  "terminal.wait": { params: TerminalWaitParams, result: WaitResult, errors: ["not_found", "machine_unknown", "invalid_params", "needs_target", "config"] },
  "terminal.keys": { params: TerminalKeysParams, result: KeysResult, errors: ["not_found", "machine_unknown", "finished", "unavailable", "invalid_params"] },
  "terminal.interrupt": { params: TerminalInterruptParams, result: InterruptResult, errors: ["not_found", "machine_unknown", "finished", "unavailable", "invalid_params"] },
  "terminal.put": { params: TerminalPutParams, result: PutResult, errors: ["not_found", "machine_unknown", "finished", "invalid_params"] },
  "machine.exec": { params: MachineExecParams, result: ExecResult, errors: ["invalid_params", "spawn_failed", "machine_unknown", "unavailable", "needs_update"] },
  "file.read": { params: FileReadParams, result: FileReadResult, errors: ["invalid_params", "not_found", "not_text", "io", "machine_unknown", "unavailable", "needs_update"] },
  "file.write": { params: FileWriteParams, result: FileResult, errors: ["invalid_params", "io", "machine_unknown", "unavailable", "needs_update"] },
  "file.edit": { params: FileEditParams, result: FileResult, errors: ["invalid_params", "edit_failed", "not_found", "not_text", "io", "machine_unknown", "unavailable", "needs_update"] },
  "doc.get": { params: DocGetParams, result: DocGetResult, errors: ["invalid_params", "machine_unknown", "unavailable", "needs_update"] },
  "doc.set": { params: DocSetParams, result: DocSetResult, errors: ["invalid_params", "conflict", "internal", "machine_unknown", "unavailable", "needs_update"] },
  "events.subscribe": { params: EventsSubscribeParams, result: SubscribeResult, errors: ["not_found", "machine_unknown"] },
  "machine.add": { params: MachineAddParams, result: Machine, errors: ["invalid_params", "name_taken", "already_added", "unreachable", "hc_missing", "incompatible"] },
  "machine.list": { params: MachineListParams, result: MachineListResult, errors: [] },
  "machine.connect": { params: MachineConnectParams, result: MachineView, errors: ["machine_unknown"] },
  "machine.rename": { params: MachineRenameParams, result: Machine, errors: ["invalid_params", "name_taken", "machine_unknown"] },
  "machine.rm": { params: MachineRmParams, result: RemoveResult, errors: ["machine_unknown"] },
  "rpc.discover": { params: RpcDiscoverParams, result: RpcDiscoverResult, errors: [] },
} as const
