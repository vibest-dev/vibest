import { FileText, Layout, PenTool, ShieldCheck } from "lucide-react"

import type { ArtifactKind, ReviewStatus, SessionStatus } from "../schema.ts"

const KIND_LABELS: Record<ArtifactKind, string> = {
  html: "HTML prototype",
  whiteboard: "Whiteboard",
  markdown: "Spec",
  verify: "Verify card",
}

const REVIEW_LABELS: Record<ReviewStatus, { text: string; tone: string }> = {
  requested: { text: "Review requested", tone: "status-attention" },
  approved: { text: "Approved", tone: "status-ok" },
  changes_requested: { text: "Changes requested", tone: "status-warn" },
  none: { text: "Draft", tone: "status-muted" },
}

const SESSION_TONES: Record<SessionStatus, string> = {
  running: "status-ok",
  blocked: "status-attention",
  idle: "status-muted",
  ended: "status-muted",
}

function KindIcon(props: { kind: ArtifactKind }) {
  switch (props.kind) {
    case "html":
      return <Layout size={14} aria-hidden="true" />
    case "whiteboard":
      return <PenTool size={14} aria-hidden="true" />
    case "markdown":
      return <FileText size={14} aria-hidden="true" />
    case "verify":
      return <ShieldCheck size={14} aria-hidden="true" />
  }
}

export function KindLabel(props: { kind: ArtifactKind }) {
  return (
    <span className="row-kind">
      <KindIcon kind={props.kind} />
      {KIND_LABELS[props.kind]}
    </span>
  )
}

export function kindText(kind: ArtifactKind): string {
  return KIND_LABELS[kind]
}

export function ReviewStatusText(props: { status: ReviewStatus; testId?: string }) {
  const label = REVIEW_LABELS[props.status]

  return (
    <span className={`status ${label.tone}`} data-testid={props.testId}>
      {label.text}
    </span>
  )
}

export function SessionStatusText(props: { status: SessionStatus }) {
  return <span className={`status ${SESSION_TONES[props.status]}`}>{props.status}</span>
}
