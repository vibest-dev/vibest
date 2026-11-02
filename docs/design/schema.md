# Schema

Four SQLite tables, one purpose each:

- `project`: a Project directory and its current main conversation.
- `session`: one Agent run: one CLI process in one terminal pane.
- `inbox`: text waiting to be delivered to a session, and whether it was.
- `message`: one round of work by a session: the input it got and the output it gave.

Effect structs: `packages/schema/src/model.ts`.

## DDL

```sql
PRAGMA application_id = 1986617957;   -- "vibe"
PRAGMA user_version = 1;

CREATE TABLE project (
  id              INTEGER PRIMARY KEY,
  directory       TEXT NOT NULL UNIQUE,         -- the Project directory; its name is the directory's name
  main_session_id TEXT REFERENCES session (id)  -- the current main conversation
) STRICT;

CREATE TABLE session (
  id                 TEXT PRIMARY KEY,          -- 8 hex characters, typed by the user
  project_id         INTEGER NOT NULL REFERENCES project (id),
  parent_session_id  TEXT REFERENCES session (id), -- the session that started it; null: the user
  agent_type         TEXT NOT NULL,             -- the Agent definition: main, general, planner, reviewer, …
  harness            TEXT NOT NULL,             -- the CLI: claude | pi | cursor
  directory          TEXT NOT NULL,             -- where it works: the Project directory or its own worktree
  runtime            TEXT,                      -- JSON { type, … }: the runtime it runs in and where; null until started
  harness_session_id TEXT,                      -- the CLI's own conversation id, used to resume it
  metadata           TEXT NOT NULL DEFAULT '{}', -- JSON: provider, model, environment, machine, …
  created_at         INTEGER NOT NULL,
  ended_at           INTEGER
) STRICT;
CREATE INDEX session_project ON session (project_id);
CREATE INDEX session_parent ON session (parent_session_id);

CREATE TABLE inbox (
  id                   INTEGER PRIMARY KEY,
  recipient_session_id TEXT NOT NULL REFERENCES session (id),
  sender_type          TEXT NOT NULL,           -- user | session | system | plugin
  sender_id            TEXT,                    -- the session or plugin id; for system: the session it is about; null for user
  content              TEXT NOT NULL,           -- the text to deliver ('' when it reports a result)
  result_message_id    INTEGER REFERENCES message (id), -- set when it reports a subagent's round of work
  delivery_status      TEXT NOT NULL            -- pending | delivering | delivered | failed | dropped
) STRICT;
CREATE INDEX inbox_pending ON inbox (recipient_session_id, delivery_status);

CREATE TABLE message (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session (id),
  inbox_id    INTEGER REFERENCES inbox (id),    -- the inbox row whose delivery started it; null: the user typed into the pane
  input       TEXT NOT NULL,                    -- what the session was given
  output      TEXT,                             -- what it answered
  status      TEXT NOT NULL,                    -- working | completed | failed | interrupted | lost | not_started
  metadata    TEXT NOT NULL DEFAULT '{}',       -- JSON: what was parsed from the answer (summary, branch, pushed, error, …)
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
) STRICT;
CREATE INDEX message_session ON message (session_id);
```

## Inbox

An inbox row is text for one session. Delivering it gives the session its next input, so it opens a `message`
row for the recipient, whoever sent it: an instruction to a subagent, or a result or note to its parent.

- `result_message_id` set: it reports that subagent round; the delivered text is built from that `message`
  (its output, plus branch and push state read from git).
- Otherwise `content` is delivered as it is. Who wrote it is the sender: `user`, a `session` (an instruction from
  the main Agent, or a subagent's `vibest report`), `system` (vibest itself: a delivery failed), or a `plugin`.

## Runtime

`session.runtime` is whatever the runtime needs to find the session again, with its `type`; vibest stores it and
hands it back to that runtime unread. herdr: `{ "type": "herdr", "session": "default", "pane": "w5:p3" }`.
Another runtime defines its own shape.

## Not stored

- A Project's repositories: the git repositories in its directory (each one's origin says where it came from).
- Inbox order and delivery time: inbox ids are delivered in order; delivery time is the `started_at` of the
  `message` it opened.

## Message status

| `status`               | Meaning                                         |
| ---------------------- | ----------------------------------------------- |
| `working`              | the round is in progress                        |
| `completed` / `failed` | the session finished and said so in its answer  |
| `interrupted`          | `vibest interrupt` stopped it                   |
| `lost`                 | the session went idle without leaving an answer |
| `not_started`          | delivery could not be confirmed                 |

## One task, step by step

1. The main Agent runs `vibest run "fix the login bug"`: a new `session` (parent: the main Agent) and an `inbox`
   row (sender `session` = the main Agent).
2. The instruction is delivered: the inbox row becomes `delivered`, and a `message` row opens (`inbox_id` = that
   row, `input` = its text, `status` working).
3. The subagent answers: that `message` gets `output` and `status` completed, and its parent's inbox
   (`parent_session_id` while it has not ended, else the Project's current main session) gets a row with `result_message_id` pointing at it.
4. The user types into the subagent's pane while no round is open: a new `message` with `inbox_id` null and
   `input` = what was typed. It ends like any round, as in step 3: one result to the parent. Typing while a
   round is open (vibest opens its rounds before handing the text over) records nothing.

## Not a table

- **Run**: none. Who started a session is `parent_session_id`; a skill that drives several subagents keeps
  their ids itself.
- **Conversation**: a main Agent session (`agent_type` main). `vibest --new` adds one and moves
  `project.main_session_id`.
- **Workspace**: `session.directory`. A worktree is created and removed with its session.
- **Live status** (idle, working, blocked, done, unknown): read from the runtime, cached in memory.
- **Subscription**: vibestd memory, polled from CLIs and reported by plugins.
- **Machine**: configuration; online state is checked live; a session's machine is in its `metadata`.
- **Event log**: in memory plus logs.

## Rules

- A column only for what vibest cannot read elsewhere and needs to query; everything else goes in `metadata`.
- A session's task is the first inbox row delivered to it; its latest answer is its latest `message.output`; its access
  (read or write) comes from its Agent definition.
- Rows are never deleted. Times are epoch milliseconds. Project, inbox, and message ids are integers; session ids
  are 8 hex characters.
- Allowed values are checked in code, not with SQL `CHECK`s.
