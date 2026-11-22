import type { Database } from "bun:sqlite"

import {
  ArtifactRowSchema,
  ProjectRowSchema,
  TaskRowSchema,
  ThreadRowSchema,
  hydrateArtifactRow,
  hydrateProjectRow,
  hydrateTaskRow,
  hydrateThreadRow,
} from "./database-rows.ts"
import type { Artifact, HubEventFact } from "./schema.ts"

export function initLedgerSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate TEXT NOT NULL,
      at        INTEGER NOT NULL,
      type      TEXT NOT NULL,
      data      TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS event_no_update BEFORE UPDATE ON event
    BEGIN
      SELECT RAISE(ABORT, 'event is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS event_no_delete BEFORE DELETE ON event
    BEGIN
      SELECT RAISE(ABORT, 'event is append-only');
    END;
  `)
  createReadModelTables(db)
}

export function createReadModelTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      slug               TEXT NOT NULL,
      description        TEXT NOT NULL,
      repo_path          TEXT,
      vibest_project_dir TEXT,
      entry_session_id   TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS task (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      title            TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')),
      summary          TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      session_ids_json TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_task_project ON task (project_id, status);

    CREATE TABLE IF NOT EXISTS session (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL,
      task_id           TEXT,
      parent_session_id TEXT,
      name              TEXT NOT NULL,
      agent             TEXT NOT NULL,
      harness           TEXT NOT NULL,
      model             TEXT,
      directory         TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('running', 'idle', 'blocked', 'ended')),
      blocked_reason    TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_session_project ON session (project_id, status);

    CREATE TABLE IF NOT EXISTS artifact (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL,
      task_id             TEXT,
      slug                TEXT NOT NULL,
      title               TEXT NOT NULL,
      kind                TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'whiteboard', 'verify')),
      summary             TEXT NOT NULL,
      version             INTEGER NOT NULL,
      review_status       TEXT NOT NULL CHECK (review_status IN ('none', 'requested', 'approved', 'changes_requested')),
      content_path        TEXT NOT NULL,
      questions_json      TEXT NOT NULL,
      answers_json        TEXT NOT NULL,
      metadata_json       TEXT NOT NULL,
      author_session_id   TEXT,
      last_review_payload TEXT,
      versions_json       TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_artifact_project ON artifact (project_id, review_status);

    CREATE TABLE IF NOT EXISTS comment_thread (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      artifact_id      TEXT NOT NULL,
      artifact_version INTEGER NOT NULL,
      pin_number       INTEGER NOT NULL,
      author           TEXT NOT NULL,
      body             TEXT NOT NULL,
      anchor_json      TEXT NOT NULL,
      resolved         INTEGER NOT NULL,
      replies_json     TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_comment_artifact ON comment_thread (artifact_id, pin_number);
  `)
}

export function applyFactToReadModel(db: Database, fact: HubEventFact): void {
  switch (fact.type) {
    case "project.created": {
      const p = fact.project
      db.query(
        `INSERT INTO project (id, name, slug, description, repo_path, vibest_project_dir, entry_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.id,
        p.name,
        p.slug,
        p.description,
        p.repoPath ?? null,
        p.vibestProjectDir ?? null,
        p.entrySessionId ?? null,
        p.createdAt,
        p.updatedAt,
      )
      break
    }

    case "project.updated": {
      const raw = db.query("SELECT * FROM project WHERE id = ?").get(fact.projectId)

      if (raw === null) break
      const existing = hydrateProjectRow(ProjectRowSchema.parse(raw))
      db.query("UPDATE project SET name = ?, description = ?, entry_session_id = ?, updated_at = ? WHERE id = ?").run(
        fact.name ?? existing.name,
        fact.description ?? existing.description,
        fact.entrySessionId ?? existing.entrySessionId ?? null,
        fact.updatedAt,
        fact.projectId,
      )
      break
    }

    case "task.created": {
      const t = fact.task
      db.query(
        `INSERT INTO task (id, project_id, title, status, summary, branch, pr_url, session_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        t.id,
        t.projectId,
        t.title,
        t.status,
        t.summary,
        t.branch ?? null,
        t.prUrl ?? null,
        JSON.stringify(t.sessionIds),
        t.createdAt,
        t.updatedAt,
      )
      break
    }

    case "task.updated": {
      const raw = db.query("SELECT * FROM task WHERE id = ?").get(fact.taskId)

      if (raw === null) break
      const existing = hydrateTaskRow(TaskRowSchema.parse(raw))
      db.query(
        `UPDATE task
         SET title = ?, status = ?, summary = ?, branch = ?, pr_url = ?, session_ids_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        fact.title ?? existing.title,
        fact.status ?? existing.status,
        fact.summary ?? existing.summary,
        fact.branch !== undefined ? fact.branch : (existing.branch ?? null),
        fact.prUrl !== undefined ? fact.prUrl : (existing.prUrl ?? null),
        JSON.stringify(fact.sessionIds ?? existing.sessionIds),
        fact.updatedAt,
        fact.taskId,
      )
      break
    }

    case "session.upserted": {
      const s = fact.session
      db.query(
        `INSERT INTO session (id, project_id, task_id, parent_session_id, name, agent, harness, model, directory, status, blocked_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           parent_session_id = excluded.parent_session_id,
           name = excluded.name,
           agent = excluded.agent,
           harness = excluded.harness,
           model = excluded.model,
           directory = excluded.directory,
           status = excluded.status,
           blocked_reason = excluded.blocked_reason,
           updated_at = excluded.updated_at`,
      ).run(
        s.id,
        s.projectId,
        s.taskId ?? null,
        s.parentSessionId ?? null,
        s.name,
        s.agent,
        s.harness,
        s.model ?? null,
        s.directory,
        s.status,
        s.blockedReason ?? null,
        s.createdAt,
        s.updatedAt,
      )
      break
    }

    case "session.status_changed": {
      db.query("UPDATE session SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?").run(
        fact.status,
        fact.blockedReason ?? null,
        fact.updatedAt,
        fact.sessionId,
      )
      break
    }

    case "artifact.created": {
      const a = fact.artifact
      db.query(
        `INSERT INTO artifact (
          id, project_id, task_id, slug, title, kind, summary, version, review_status,
          content_path, questions_json, answers_json, metadata_json, author_session_id,
          last_review_payload, versions_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        a.id,
        a.projectId,
        a.taskId ?? null,
        a.slug,
        a.title,
        a.kind,
        a.summary,
        a.version,
        a.reviewStatus,
        a.contentPath,
        JSON.stringify(a.questions),
        JSON.stringify(a.answers),
        JSON.stringify(a.metadata),
        a.authorSessionId ?? null,
        a.lastReviewPayload ?? null,
        JSON.stringify(a.versions),
        a.createdAt,
        a.updatedAt,
      )
      break
    }

    case "artifact.version_published": {
      const raw = db.query("SELECT * FROM artifact WHERE id = ?").get(fact.artifactId)

      if (raw === null) break
      const existing = hydrateArtifactRow(ArtifactRowSchema.parse(raw))

      const nextVersions = [
        ...existing.versions,
        {
          version: fact.version,
          summary: fact.summary,
          contentPath: fact.contentPath,
          createdAt: fact.updatedAt,
        },
      ]

      db.query(
        `UPDATE artifact
         SET version = ?, summary = ?, content_path = ?, review_status = ?,
             metadata_json = ?, questions_json = ?, versions_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        fact.version,
        fact.summary,
        fact.contentPath,
        fact.reviewStatus,
        JSON.stringify(fact.metadata ?? existing.metadata),
        JSON.stringify(fact.questions ?? existing.questions),
        JSON.stringify(nextVersions),
        fact.updatedAt,
        fact.artifactId,
      )
      break
    }

    case "artifact.metadata_updated": {
      db.query("UPDATE artifact SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(fact.metadata),
        fact.updatedAt,
        fact.artifactId,
      )
      break
    }

    case "artifact.question_answered": {
      const raw = db.query("SELECT * FROM artifact WHERE id = ?").get(fact.artifactId)

      if (raw === null) break
      const existing = hydrateArtifactRow(ArtifactRowSchema.parse(raw))

      const nextAnswers: Artifact["answers"] = {
        ...existing.answers,
        [fact.questionId]: [...fact.selectedOptionIds],
      }

      db.query("UPDATE artifact SET answers_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(nextAnswers),
        fact.updatedAt,
        fact.artifactId,
      )
      break
    }

    case "comment.created": {
      const c = fact.thread
      db.query(
        `INSERT INTO comment_thread (
          id, project_id, artifact_id, artifact_version, pin_number,
          author, body, anchor_json, resolved, replies_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.id,
        c.projectId,
        c.artifactId,
        c.artifactVersion,
        c.pinNumber,
        c.author,
        c.body,
        JSON.stringify(c.anchor),
        c.resolved ? 1 : 0,
        JSON.stringify(c.replies),
        c.createdAt,
        c.updatedAt,
      )
      break
    }

    case "comment.replied": {
      const raw = db.query("SELECT * FROM comment_thread WHERE id = ?").get(fact.threadId)

      if (raw === null) break
      const existing = hydrateThreadRow(ThreadRowSchema.parse(raw))
      const nextReplies = [...existing.replies, fact.reply]
      db.query("UPDATE comment_thread SET replies_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(nextReplies),
        fact.updatedAt,
        fact.threadId,
      )
      break
    }

    case "comment.resolved_changed": {
      db.query("UPDATE comment_thread SET resolved = ?, updated_at = ? WHERE id = ?").run(
        fact.resolved ? 1 : 0,
        fact.updatedAt,
        fact.threadId,
      )
      break
    }

    case "artifact.reviewed": {
      db.query(
        "UPDATE artifact SET review_status = ?, answers_json = ?, last_review_payload = ?, updated_at = ? WHERE id = ?",
      ).run(fact.reviewStatus, JSON.stringify(fact.answers), fact.agentPayload, fact.reviewedAt, fact.artifactId)
      break
    }
  }
}
