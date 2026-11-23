import { Copy, ExternalLink, GitBranch, GitCommit, MessageSquarePlus } from "lucide-react"
import { useState } from "react"

import { renderSafeMarkdownHtml } from "../markdown-safe.ts"
import type { Artifact, CommentAnchor } from "../schema.ts"

type GateStatus = "passed" | "failed" | "pending"

const GATE_TONES: Record<GateStatus, string> = {
  passed: "status-ok",
  failed: "status-attention",
  pending: "status-warn",
}

function InlineCode(props: { text: string }) {
  return <>{props.text.split("`").map((part, idx) => (idx % 2 === 1 ? <code key={idx}>{part}</code> : part))}</>
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

  const passedCount = card?.gates.filter((g) => g.status === "passed").length ?? 0

  return (
    <div className="markdown-container">
      {card && (
        <div className="verify">
          <header className="verify-head">
            <h2 className="verify-goal">
              <InlineCode text={card.goal} />
            </h2>
            <div className="verify-meta">
              <span className="mono">
                <GitBranch size={13} aria-hidden="true" /> {card.branch}
              </span>
              <span className="mono">
                <GitCommit size={13} aria-hidden="true" /> {card.commitSha}
              </span>
              {card.prUrl && (
                <a href={card.prUrl} target="_blank" rel="noreferrer">
                  Pull request <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>
          </header>

          <section className="verify-block" aria-labelledby="verify-gates-title">
            <div className="verify-block-head">
              <h3 className="verify-block-title" id="verify-gates-title">
                Gates
              </h3>
              <span className="section-note">
                {passedCount} of {card.gates.length} passed
              </span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Gate</th>
                  <th scope="col" className="num">
                    Time
                  </th>
                  <th scope="col">
                    <span className="sr-only">Comment</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {card.gates.map((gate) => (
                  <tr key={gate.id}>
                    <td>
                      <span className={`status ${GATE_TONES[gate.status]}`}>{gate.status}</span>
                    </td>
                    <td>
                      <div className="gate-name mono">{gate.command}</div>
                      {gate.detail && <div className="gate-detail">{gate.detail}</div>}
                    </td>
                    <td className="num">
                      {gate.durationMs !== undefined ? `${(gate.durationMs / 1000).toFixed(1)} s` : "–"}
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        aria-label={`Comment on ${gate.name}`}
                        onClick={() => setActiveSection({ section: gate.name, gateId: gate.id })}
                      >
                        <MessageSquarePlus size={13} aria-hidden="true" /> Comment
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {activeSection && (
            <div className="quote-composer">
              <div className="composer-label">
                Comment on <span className="mono">{activeSection.section}</span>
              </div>
              <textarea
                className="textarea"
                aria-label="Comment on gate"
                placeholder="A question or blocker on this check"
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
              />
              <div className="form-actions">
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setActiveSection(null)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSaveVerifyPin()}>
                  Pin comment
                </button>
              </div>
            </div>
          )}

          {(card.risks.length > 0 || card.unverified.length > 0) && (
            <div className="verify-columns">
              <section className="verify-block">
                <h3 className="verify-block-title">Known risks</h3>
                <ul>
                  {card.risks.map((r, idx) => (
                    <li key={idx}>{r}</li>
                  ))}
                </ul>
              </section>
              <section className="verify-block">
                <h3 className="verify-block-title">Not verified</h3>
                <ul>
                  {card.unverified.map((u, idx) => (
                    <li key={idx}>{u}</li>
                  ))}
                </ul>
              </section>
            </div>
          )}

          {card.authorizedCommand && (
            <section className="verify-block">
              <div className="verify-block-head">
                <h3 className="verify-block-title">Merge command</h3>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(card.authorizedCommand ?? "")
                    setCopiedCmd(true)
                    setTimeout(() => setCopiedCmd(false), 1500)
                  }}
                >
                  <Copy size={12} aria-hidden="true" /> {copiedCmd ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="code-block">{card.authorizedCommand}</pre>
            </section>
          )}
        </div>
      )}

      {content.trim().length > 0 && (
        <div
          className="markdown-body"
          style={{ marginTop: 40 }}
          dangerouslySetInnerHTML={{ __html: renderSafeMarkdownHtml(content) }}
        />
      )}
    </div>
  )
}
