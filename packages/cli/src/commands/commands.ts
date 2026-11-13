import { ProjectKind } from "@vibest/schema/project"
import { Argument, Flag } from "effect/cli"

import { Spec } from "../framework/spec.ts"

const text = (name: string) =>
  Argument.String(name).pipe(
    Argument.withDescription(
      "Literal text, or - to read it from stdin. Put -- before it so text starting with - is not read as an option",
    ),
  )

const id = Argument.String("id").pipe(
  Argument.withDescription("session id, or a unique prefix of at least 8 of its characters (as vibest shows ids)"),
)

const sessionFlag = Flag.String("session").pipe(
  Flag.withDescription(
    "The herdr session to use, overriding the ambient herdr session when run inside herdr (default vibest); bare `vibest` refuses it inside herdr",
  ),
  Flag.optional,
)

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Only this provider's models; a harness with no provider option refuses it"),
  Flag.optional,
)

const hookHarness = Flag.String("harness").pipe(Flag.withDescription("The harness whose hook this is"))

export const entryFlags = {
  fresh: Flag.Boolean("new").pipe(
    Flag.withDescription("Start a new conversation with the entry session instead of reopening the current one"),
    Flag.withDefault(false),
  ),
  harness: Flag.String("harness").pipe(
    Flag.withDescription("Leave out for the harness the entry session last used; a project's first start needs it"),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(Flag.optional),
  model: Flag.String("model").pipe(Flag.optional),
  session: sessionFlag,
  headless: Flag.Boolean("headless").pipe(
    Flag.withDescription("Outside herdr: do not attach to the session"),
    Flag.withDefault(false),
  ),
  runtime: Flag.String("runtime").pipe(
    Flag.withDescription(
      "The terminal runtime the entry session runs in. Overrides the runtime this terminal's environment detects; required when none is detected",
    ),
    Flag.optional,
  ),
}

const daemon = Spec.make("daemon", {
  description: "Start vibestd (in the background unless --foreground); exits 0 if it is already running",
  params: {
    foreground: Flag.Boolean("foreground").pipe(
      Flag.withDescription("Run vibestd in this process"),
      Flag.withDefault(false),
    ),
    handoff: Flag.Boolean("import").pipe(Flag.withHidden, Flag.withDefault(false)),
  },
  commands: [
    Spec.make("restart", {
      description:
        "Replace the running vibestd with this vibest, after a yes on a terminal; agents keep running and queued messages are kept, but unfinished daemon operations may refuse the restart. Then offers to restart the agents on another integration in place, with their conversations",
    }),
    Spec.make("import-check"),
  ],
})

const run = Spec.make("run", {
  description:
    'Run by an agent in a session; a person opens a session with bare vibest. Start a session on a task and print {"id":"<session id>"} at once; the routing that plugins decided is in the routing field of vibest ls and vibest result. An execution end sends nothing: the session sends a message with vibest send when it decides to, and its latest reply is read with vibest result. vibest makes each session its own worktree (detached, no branch); in a project of several repositories (a directory of git repositories) that is one worktree of every repository, side by side. The entry session may run it from anywhere in its project, also from inside one repository. Never tell the session to make its own worktree, clone or copy',
  params: {
    words: Argument.String("harness and prompt").pipe(
      Argument.between(1, 2),
      Argument.withMetavar("[<harness>] <prompt>"),
      Argument.withDescription(
        "The harness (leave it out to use the caller's harness, provider and model; name one to switch), then the prompt: literal text, or - to read it from stdin. Put -- before the prompt so text starting with - is not read as an option",
      ),
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription(
        "What the agent does, in a few words (its pane title, and the line its results show); default: the task's start",
      ),
      Flag.optional,
    ),
    provider: Flag.String("provider").pipe(Flag.optional),
    model: Flag.String("model").pipe(
      Flag.withDescription("Leave out for the harness default; see vibest models"),
      Flag.optional,
    ),
    env: Flag.KeyValuePair("env").pipe(
      Flag.withDescription(
        "KEY=VALUE for the harness, never stored: a restart or a harness change in the same pane keeps it, a new pane (the old one closed) does not; pass it again then",
      ),
      Flag.optional,
    ),
    share: Flag.String("share").pipe(
      Flag.withDescription(
        "A session id (or a unique prefix of at least 8 characters): run in its directory, on its runtime and machine, in a pane split from its pane, instead of a new worktree (the directory goes with the archive of the last live session in it)",
      ),
      Flag.optional,
    ),
    archive: Flag.Boolean("archive-on-idle").pipe(
      Flag.withDescription(
        "Archive the session the first time it is idle after a completed execution with nothing it sent or was sent still waiting (as vibest archive: branch kept, worktree removed only when git loses nothing)",
      ),
      Flag.withDefault(false),
    ),
    runtime: Flag.String("runtime").pipe(
      Flag.withDescription(
        "The terminal runtime for this session. Default: the --share session's, otherwise its parent's",
      ),
      Flag.optional,
    ),
    machine: Flag.String("machine").pipe(
      Flag.withDescription(
        "Run it on another machine (vibest machine ls), in that machine's checkout of this repository at this HEAD; its address is <machine>/<id>, and its results come to this project's entry session, or stay there for vibest result <machine>/<id> when there is none",
      ),
      Flag.optional,
    ),
    agent: Flag.String("agent").pipe(
      Flag.withDescription(
        "The agent definition the session runs as: its system prompt and tool rules. The registered ids are listed when one is unknown",
      ),
      Flag.withDefault("general"),
    ),
    session: sessionFlag,
  },
})

const send = Spec.make("send", {
  description:
    "Continue a session: queue a message, delivered once it is idle (never interrupts an execution); prints at once",
  params: { id, message: text("message") },
})

const status = Spec.make("status", {
  description:
    "vibest's status: this client, vibestd (running or not; never started by this) and the terminal runtimes it has",
})

const result = Spec.make("result", {
  description: "A session's latest result (JSON; null before its first)",
  params: { id },
})

const interrupt = Spec.make("interrupt", {
  description:
    "Interrupt a session's running execution; the session stays for follow-ups (no reply arrives for that execution)",
  params: { id },
})

const peek = Spec.make("peek", {
  description:
    "Print the last lines on a session's terminal, read now (plain text). Results never carry screen text: look here when one says the execution ended without a reply or did not start",
  params: {
    id,
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("How many of the last lines to print (at most 500; vibestd's default is 30)"),
      Flag.optional,
    ),
  },
})

const archive = Spec.make("archive", {
  alias: "rm",
  description:
    "Archive an agent session (a working one is interrupted for up to 10 s, then its pane closed and that execution's reply lost; releases terminal pane, workspace, and clean worktree; retains the session row, inbox history, and stored replies)",
  params: {
    id,
    keepWorktree: Flag.Boolean("keep-worktree").pipe(
      Flag.withDescription("Archive the session but keep its worktree"),
      Flag.withDefault(false),
    ),
  },
})

const ls = Spec.make("ls", {
  description:
    "Your sessions that have not exited, as JSON: each task (cut to 500 characters), its live status, and its latest result (--all: exited ones too). vibest result keeps the full task",
  params: {
    all: Flag.Boolean("all").pipe(
      Flag.withAlias("a"),
      Flag.withDescription("Exited sessions too"),
      Flag.withDefault(false),
    ),
  },
})

const events = Spec.make("events", {
  description:
    "The event log as JSON lines: one session's facts (--session, from after --after) or all of them; --follow keeps printing new ones",
  params: {
    session: Flag.String("session").pipe(
      Flag.withDescription("Only this session's facts (its id, or a unique prefix of at least 8 characters)"),
      Flag.optional,
    ),
    after: Flag.Int("after").pipe(
      Flag.withDescription("With --session: only facts after this seq (the seq of the last fact already seen)"),
      Flag.optional,
    ),
    follow: Flag.Boolean("follow").pipe(
      Flag.withDescription("Keep running and print facts as they are recorded"),
      Flag.withDefault(false),
    ),
  },
})

const models = Spec.make("models", {
  description:
    "The models each harness accepts, as the harness reports them: start a session with one entry's harness, provider (null: leave it out) and model",
  params: {
    target: Argument.String("harness").pipe(Argument.withDescription("Only this harness's models"), Argument.optional),
    harness: Flag.String("harness").pipe(Flag.withDescription("Same as the harness argument"), Flag.optional),
    provider: providerFlag,
  },
})

const harness = Spec.make("harness", {
  description: "The harnesses vibest runs",
  commands: [
    Spec.make("list", {
      alias: "ls",
      description:
        "Each harness: its binary, whether vibest can start it, the model it runs by default (null: the harness chooses) and why it cannot be started; --machine lists another machine's. The list is the whole machine's; the default model is the harness's global default, which a repository's own harness settings may change in its project, and vibest does not read them",
      params: {
        machine: Flag.String("machine").pipe(
          Flag.withDescription("List another machine's harnesses (asked each time)"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("models", {
      description: "The models one harness accepts; same JSON as vibest models",
      params: { harness: Argument.String("harness"), provider: providerFlag },
    }),
  ],
})

const project = Spec.make("project", {
  description:
    "This repository's project folder (VIBEST_PROJECT_DIR for agents): preferences.md, docs/, memories/ and artifacts/, read and written with file tools",
  commands: [
    Spec.make("create", {
      description:
        "Only for working on several repositories together; a single git repository is already a project (cd into it and run vibest). Copies them into a new project directory, one folder each: `vibest project create ~/work/combo --from ~/code/shop --from ~/code/admin` makes ~/work/combo/shop and ~/work/combo/admin (your originals are untouched); ~/work/combo itself must not be inside a git repository. Then `cd ~/work/combo && vibest`: the entry session works there, and each subagent gets its own copy with the same folders. An agent may not run it",
      params: {
        directory: Argument.String("directory").pipe(
          Argument.withDescription("The project directory to create (or an empty directory to use)"),
        ),
        from: Flag.String("from").pipe(
          Flag.withDescription("A git repository to copy in, as a folder named after it. Repeat for each repository"),
          Flag.atLeast(1),
        ),
      },
    }),
    Spec.make("add", {
      description:
        "Record a checkout as a project without starting an entry session, so another machine's vibestd can run agents in it",
      params: { directory: Argument.String("directory").pipe(Argument.withDefault(".")) },
    }),
    Spec.make("info", {
      description: "The paths of the project folder, its preferences.md, docs, memories and artifacts",
    }),
    Spec.make("search", {
      description: "Case-insensitive text search; hits are kind/path:line: text",
      params: {
        query: Argument.String("query"),
        kind: Flag.Literals("kind", ProjectKind.literals).pipe(Flag.optional),
      },
    }),
  ],
})

const plugins = Spec.make("plugins", {
  description:
    "List the plugins vibestd loaded (from ~/.vibest/plugins and vibest.json) with their hook counters since it started",
})

const subscriptions = Spec.make("subscriptions", {
  description: "Print each harness login and its usage limits, as vibestd last read them",
})

const integration = Spec.make("integration", {
  description:
    "Internal: called by vibest's plugin in each harness (user prompt, execution end, pre-tool guard); not for direct use",
  commands: [
    Spec.make("guard", {
      description:
        "Pre-tool hook: reads the harness's pre-tool input on stdin, prints its answer when the rules of the session's agent refuse the call",
      params: { harness: hookHarness },
    }),
    Spec.make("prompt", {
      description:
        "A harness plugin's execution-start bridge: its prompt or activity event JSON on stdin. Does not start vibestd; exits non-zero when the report did not reach vibestd",
      params: { harness: hookHarness },
    }),
    Spec.make("stop", {
      description:
        "A harness plugin's execution-end bridge: its execution-end event JSON on stdin. Does not start vibestd; exits non-zero when the report did not reach vibestd",
      params: { harness: hookHarness },
    }),
    Spec.make("ready", {
      description:
        "A harness plugin's session-start bridge: tells vibestd the session takes input. Does not start vibestd; exits non-zero when the report did not reach vibestd",
      params: { harness: hookHarness },
    }),
  ],
})

const doctor = Spec.make("doctor", {
  description:
    "Check that vibest can work here: the coding agents, vibestd, each runtime agents run in, and plugins, each problem with how to fix it; starts vibestd when it is not running",
})

const update = Spec.make("update", {
  alias: "upgrade",
  description:
    "Update vibest the way it was installed (install.sh: the latest GitHub release; npm: the version the registry's beta tag names, at that exact version, with the package manager that installed it; either is first tried aside and must open the database), hand the running vibestd over to it (agents keep running), then offer to restart the agents still on the old integration in place, with their conversations",
  params: {
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription(
        "Restart the agents still on the old integration without asking (a shell without a terminal)",
      ),
      Flag.withDefault(false),
    ),
    restartAgentsAfter: Flag.Int("restart-agents-after").pipe(Flag.withHidden, Flag.optional),
  },
})

const connect = Spec.make("connect", {
  description:
    "Internal: what another machine's vibestd runs over ssh. Joins stdin and stdout to this machine's vibestd, starting it when it is not running",
})

const machine = Spec.make("machine", {
  description: "Other machines this vibestd dials over ssh, to run agents there (vibest run --machine)",
  commands: [
    Spec.make("add", {
      description: "Connect once to a machine's vibestd over ssh and keep it as a machine",
      params: {
        name: Argument.String("name").pipe(Argument.withDescription("What --machine and addresses name/<id> use")),
        target: Argument.String("target").pipe(
          Argument.withDescription("ssh target: user@host, user@host:port, or a Host of the ssh config"),
        ),
      },
    }),
    Spec.make("ls", {
      description:
        "The machines this vibestd dials, with their connection state, their runtimes and whether this machine shows their terminals (JSON)",
    }),
    Spec.make("rm", {
      description:
        "Forget a machine: its connection stops; its agents keep running there and adding it again delivers their results",
      params: { name: Argument.String("name") },
    }),
  ],
})

export const Commands = Spec.make("vibest", {
  description:
    "vibest: in a project directory, open its entry session here (--new: a new conversation); the entry session runs subagents in herdr panes",
  params: entryFlags,
  commands: [
    daemon,
    run,
    send,
    status,
    result,
    interrupt,
    peek,
    archive,
    ls,
    events,
    models,
    harness,
    project,
    plugins,
    subscriptions,
    integration,
    doctor,
    update,
    connect,
    machine,
  ],
})
