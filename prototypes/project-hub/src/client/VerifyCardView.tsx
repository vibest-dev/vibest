import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommit,
  MessageSquarePlus,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import { marked } from "marked"
import { useState } from "react"

import type { Artifact, CommentAnchor } from "../schema.ts"

function renderGateIcon(status: "passed" | "failed" | "pending") {
  switch (status) {
    case "passed":
      return <CheckCircle2 size={17} color="#10b981" />
    case "failed":
      return <XCircle size={17} color="#ef4444" />
    case "pending":
      return <AlertTriangle size={17} color="#f59e0b" />
  }
}

export function VerifyCardView(props: {
  artifact: Artifact
  content: string
  onCreateComment: (body: string, anchor: CommentAnchor) => Promise<void>
}) {
  const { artifact, content, onCreateComment } = props
  const card = artifact.metadata.verifyCard
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [activeSection, setActiveSection] = useState<{ section: string; gateId?: string } | null>(null)
  const [note, setNote] = useState("")

  const handleSaveVerifyPin = async () => {
    if (!activeSection || note.trim().length === 0) return
    await onCreateComment(note.trim(), {
      kind: "verify",
      section: activeSection.section,
      ...(activeSection.gateId !== undefined && { gateId: activeSection.gateId }),
    })
    setNote("")
    setActiveSection(null)
  }

  return (
    <div className="markdown-container">
      {card && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="card" style={{ borderLeft: "4px solid var(--accent-green)" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span className="badge badge-green">
                <ShieldCheck size={13} /> PR MERGE VERIFY CARD
              </span>
              <div className="btn-row">
                <span className="badge badge-blue">
                  <GitBranch size={12} /> {card.branch}
                </span>
                <span className="badge badge-purple">
                  <GitCommit size={12} /> {card.commitSha}
                </span>
                {card.prUrl && (
                  <a
                    href={card.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="badge badge-neutral"
                    style={{ textDecoration: "none" }}
                  >
                    PR Link <ExternalLink size={11} />
                  </a>
                )}
              </div>
            </div>
            <h2 style={{ margin: "4px 0 0", fontSize: 17 }}>{card.goal}</h2>
          </div>

          <div className="card">
            <div className="drawer-section-title">
              <span>Deterministic Verification Gates ({card.gates.length})</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {card.gates.map((gate) => (
                <div
                  key={gate.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {renderGateIcon(gate.status)}
                    <div>
                      <div style={{ fontWeight: 650 }}>{gate.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        <code>{gate.command}</code>
                        {gate.detail ? ` — ${gate.detail}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="btn-row">
                    {gate.durationMs !== undefined && (
                      <span className="badge badge-neutral">{(gate.durationMs / 1000).toFixed(1)}s</span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setActiveSection({ section: gate.name, gateId: gate.id })}
                    >
                      <MessageSquarePlus size={12} /> Pin
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {activeSection && (
            <div className="card" style={{ borderColor: "var(--accent-blue)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-blue)" }}>
                Comment on Gate: {activeSection.section}
              </div>
              <textarea
                className="textarea"
                placeholder="Question or blocker on this verification check..."
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
              />
              <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn btn-sm" onClick={() => setActiveSection(null)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSaveVerifyPin()}>
                  Save Comment
                </button>
              </div>
            </div>
          )}

          {(card.risks.length > 0 || card.unverified.length > 0) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div className="card">
                <div className="drawer-section-title">Known Risks</div>
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)", fontSize: 12.5 }}>
                  {card.risks.map((r, idx) => (
                    <li key={idx}>{r}</li>
                  ))}
                </ul>
              </div>
              <div className="card">
                <div className="drawer-section-title">Unverified Scope</div>
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)", fontSize: 12.5 }}>
                  {card.unverified.map((u, idx) => (
                    <li key={idx}>{u}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {card.authorizedCommand && (
            <div className="card">
              <div className="drawer-section-title">
                <span>Authorized Merge Command</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(card.authorizedCommand ?? "")
                    setCopiedCmd(true)
                    setTimeout(() => setCopiedCmd(false), 1500)
                  }}
                >
                  <Copy size={12} /> {copiedCmd ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="code-block" style={{ margin: 0 }}>
                {card.authorizedCommand}
              </pre>
            </div>
          )}
        </div>
      )}

      {content.trim().length > 0 && (
        <div
          className="markdown-body"
          style={{ marginTop: 22 }}
          dangerouslySetInnerHTML={{ __html: String(marked.parse(content, { async: false, gfm: true })) }}
        />
      )}
    </div>
  )
}
