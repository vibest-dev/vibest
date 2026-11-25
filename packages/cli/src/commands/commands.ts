import { ProjectKind } from "@vibest/schema/project"
import { Argument, Flag } from "effect/cli"

import { Spec } from "../framework/spec.ts"

const text = (name: string) =>
  Argument.String(name).pipe(
    Argument.withDescription("The text, or - to read it from stdin. Put -- before it when it starts with -"),
  )

const id = Argument.String("id").pipe(
  Argument.withDescription("A session id, or a unique prefix of at least 8 characters"),
)

const sessionMachine = Flag.String("machine").pipe(
  Flag.withDescription("Target a session on another machine (vibest machine ls)"),
  Flag.optional,
)

const sessionFlag = Flag.String("session").pipe(
  Flag.withDescription(
    "The runtime's session to use, instead of the one this terminal is in. Bare vibest refuses it inside a runtime's terminal",
  ),
  Flag.optional,
)

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Only this provider's models. A harness with no provider option refuses it"),
  Flag.optional,
)

export const entryFlags = {
  fresh: Flag.Boolean("new").pipe(
    Flag.withDescription("Start a new conversation instead of reopening the current one"),
    Flag.withDefault(false),
  ),
  harness: Flag.String("harness").pipe(
    Flag.withDescription(
      "The harness for the entry session. Leave it out to keep the current one. On a project's first start, leave it out to use Claude when Claude can start",
    ),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription(
      "The provider for --model. Used only when you pass it; leaving it out does not keep the previous one",
    ),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription(
      "The model for the entry session. Used only when you pass it. Leaving it out, including with --new, does not keep the previous model",
    ),
    Flag.optional,
  ),
  agent: Flag.String("agent").pipe(
    Flag.withDescription(
      "The agent definition a new entry conversation runs as (default coordinator; see vibest agent list). A conversation keeps the agent it started with: naming another needs --new",
    ),
    Flag.optional,
  ),
  session: sessionFlag,
  headless: Flag.Boolean("headless").pipe(
    Flag.withDescription("Do not attach to the session when it opens outside a runtime's terminal"),
    Flag.withDefault(false),
  ),
  runtime: Flag.String("runtime").pipe(
    Flag.withDescription(
      "The terminal runtime the entry session runs in. Overrides what this terminal's environment detects; required when none is detected",
    ),
    Flag.optional,
  ),
}

const daemon = Spec.make("daemon", {
  description: "Start vibestd in the background. Exits 0 when it is already running",
  params: {
    foreground: Flag.Boolean("foreground").pipe(
      Flag.withDescription("Run vibestd in this process. Its log is vibestd.log in the vibest home"),
      Flag.withDefault(false),
    ),
    handoff: Flag.Boolean("import").pipe(Flag.withHidden, Flag.withDefault(false)),
  },
  commands: [
    Spec.make("restart", {
      description:
        "Replace the running vibestd with this vibest, after you confirm. May refuse while work is still finishing. Then asks whether to restart agents still on the old version, keeping their conversations",
    }),
    Spec.make("import-check", {
      description: "Check that this vibest can open the current database",
    }),
  ],
})

const run = Spec.make("run", {
  description:
    "Start a session on a task and print its id. Only an agent in a session runs this; a person opens a session with bare vibest. Leave the harness out to use your own harness, provider and model. An execution end sends nothing: the session messages with vibest send, and its latest reply is vibest result. Each session gets its own worktree, detached and on no branch; in a project of several repositories, one worktree of each, side by side. Do not tell the session to make its own worktree, clone or copy. A plugin's harness choice shows on the session in vibest ls",
  params: {
    words: Argument.String("harness and prompt").pipe(
      Argument.between(1, 2),
      Argument.withMetavar("[<harness>] <prompt>"),
      Argument.withDescription(
        "The harness, then the prompt. Leave the harness out to use your harness, provider and model. Name a harness to switch; then leave --provider and --model out for that harness's default. The prompt is literal text, or - for stdin. Put -- before a prompt that starts with -",
      ),
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription(
        "A few words for what the agent does: its pane title, and the line its results show. Default: the start of the task",
      ),
      Flag.optional,
    ),
    provider: Flag.String("provider").pipe(
      Flag.withDescription(
        "The provider. With the harness left out, leave this out to use the caller's provider. With a harness named, leave it out for that harness's default. A harness with no provider option refuses it",
      ),
      Flag.optional,
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription(
        "The model. With the harness left out, leave this out to use the caller's model. With a harness named, leave it out for that harness's default. See vibest models",
      ),
      Flag.optional,
    ),
    env: Flag.KeyValuePair("env").pipe(
      Flag.withDescription("KEY=VALUE for the harness. Not saved: pass it again when the session opens a new terminal"),
      Flag.optional,
    ),
    share: Flag.String("share").pipe(
      Flag.withDescription(
        "A session id, or a unique prefix of at least 8 characters. Run in its directory, on its runtime and machine, in a pane split from its pane, instead of a new worktree. The directory goes when the last live session in it is archived",
      ),
      Flag.optional,
    ),
    runtime: Flag.String("runtime").pipe(
      Flag.withDescription(
        "The terminal runtime for this session. Default: the --share session's, otherwise its parent's",
      ),
      Flag.optional,
    ),
    machine: Flag.String("machine").pipe(
      Flag.withDescription(
        "Run it on another machine (vibest machine ls), in that machine's checkout of this repository at this commit. Results come to this project's session, or stay for vibest result <id> --machine <machine> when there is none",
      ),
      Flag.optional,
    ),
    project: Flag.String("project").pipe(
      Flag.withDescription(
        "With --machine: the project of that machine to run in, by its id (or a unique prefix of at least 8 characters) or its folder name; it must still hold this project's repositories at these commits. Needed when that machine has several such projects",
      ),
      Flag.optional,
    ),
    agent: Flag.String("agent").pipe(
      Flag.withDescription(
        "The agent definition: its system prompt and tool rules. An unknown id lists the registered ones. Default: general",
      ),
      Flag.withDefault("general"),
    ),
    file: Flag.String("file").pipe(
      Flag.withDescription(
        "Attach this file. It is copied into the project folder for the new session, and the task ends with a line naming the copy. Repeat for each file. A file over 10 MiB, or one that cannot be read, refuses the run",
      ),
      Flag.atLeast(0),
    ),
    from: Flag.String("from").pipe(
      Flag.withDescription("Allow this session to send messages to the new session. Repeat for each session"),
      Flag.atLeast(0),
    ),
    to: Flag.String("to").pipe(
      Flag.withDescription("Allow the new session to send messages to this session. Repeat for each session"),
      Flag.atLeast(0),
    ),
    with: Flag.String("with").pipe(
      Flag.withDescription(
        "Allow bidirectional messages between this session and the new session. Repeat for each session",
      ),
      Flag.atLeast(0),
    ),
    session: sessionFlag,
  },
})

const send = Spec.make("send", {
  description:
    "Queue a message for a session and print at once. It is delivered when the session is idle, and does not interrupt a running execution. For a resumable session started with vibest run, sending after its pane closes or its harness exits reopens the conversation in a new pane",
  params: { id, machine: sessionMachine, message: text("message") },
})

const status = Spec.make("status", {
  description:
    "This vibest, whether vibestd is running, this machine's load when vibestd is running, and the terminal runtimes it has. Does not start vibestd",
})

const result = Spec.make("result", {
  description:
    "A session, as JSON. For an id that exists the object is always returned; reply is null until the first result. Test reply, not the object",
  params: { id, machine: sessionMachine },
})

const interrupt = Spec.make("interrupt", {
  description:
    "Stop a session's running execution. The session stays, and that execution sends no reply. Not the entry session: end that one in its terminal",
  params: { id, machine: sessionMachine },
})

const stop = Spec.make("stop", {
  description: "End the session process and keep the session; the next vibest send resumes it",
  params: { id, machine: sessionMachine },
})

const peek = Spec.make("peek", {
  description:
    "Print the last lines of a session's terminal, as plain text, read now. Look here when a result says the execution ended without a reply or did not start. Not the entry session",
  params: {
    id,
    machine: sessionMachine,
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("How many of the last lines to print, at most 500. Default 30"),
      Flag.optional,
    ),
  },
})

const archive = Spec.make("archive", {
  description:
    "End a session for good. Closes its terminal and removes a clean worktree. Keeps the record, its messages, replies and branch. Not the entry session: end that one in its terminal",
  params: {
    id,
    machine: sessionMachine,
    keepWorktree: Flag.Boolean("keep-worktree").pipe(
      Flag.withDescription("End the session and keep its worktree"),
      Flag.withDefault(false),
    ),
  },
})

const ls = Spec.make("ls", {
  description:
    "Sessions that have not exited, as JSON: each task, cut to 500 characters, its status, and its latest result. vibest result has the full task",
  params: {
    all: Flag.Boolean("all").pipe(
      Flag.withAlias("a"),
      Flag.withDescription("Include exited sessions"),
      Flag.withDefault(false),
    ),
  },
})

const linkParams = {
  ids: Argument.String("id").pipe(
    Argument.withDescription("Session ids, or unique prefixes of at least 8 characters"),
    Argument.atLeast(1),
  ),
  machine: sessionMachine,
  to: Flag.String("to").pipe(
    Flag.withDescription("Link or unlink directed edges from the positional sessions to each --to session"),
    Flag.atLeast(0),
  ),
  toMachine: Flag.String("to-machine").pipe(
    Flag.withDescription("With --to: target --to sessions on another machine"),
    Flag.optional,
  ),
  chain: Flag.Boolean("chain").pipe(
    Flag.withDescription("Link or unlink directed edges in sequence: id1 -> id2 -> id3"),
    Flag.withDefault(false),
  ),
}

const session = Spec.make("session", {
  description: "Manage messaging links between sessions in a project",
  commands: [
    Spec.make("link", {
      description:
        "Add messaging links between sessions: positional ids for all-to-all mutual links, --to for directed links, or --chain for a directed chain",
      params: linkParams,
    }),
    Spec.make("unlink", {
      description:
        "Remove messaging links between sessions: positional ids for all-to-all mutual links, --to for directed links, or --chain for a directed chain",
      params: linkParams,
    }),
  ],
})

const events = Spec.make("events", {
  description:
    "Print the event log as JSON lines, for one session (--session) or all of them. --follow keeps printing new ones. Only the user runs this",
  params: {
    session: Flag.String("session").pipe(
      Flag.withDescription("Only this session: its id, or a unique prefix of at least 8 characters"),
      Flag.optional,
    ),
    after: Flag.Int("after").pipe(
      Flag.withDescription("With --session: only events after this seq, the seq of the last one already seen"),
      Flag.optional,
    ),
    follow: Flag.Boolean("follow").pipe(
      Flag.withDescription("Keep running and print events as they are recorded"),
      Flag.withDefault(false),
    ),
  },
})

const models = Spec.make("models", {
  description:
    "The models each harness accepts, as the harness reports them. Start a session with one entry's harness, provider (null: leave it out) and model",
  params: {
    target: Argument.String("harness").pipe(Argument.withDescription("Only this harness"), Argument.optional),
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
        "Each harness: its binary, whether vibest can start it, the model it runs by default (null: the harness chooses) and, when it cannot start, why. --machine lists another machine's. This is the whole machine. A repository's own harness settings can change the default model in that project; vibest does not read them",
      params: {
        machine: Flag.String("machine").pipe(
          Flag.withDescription("List another machine's harnesses. Asked each time"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("models", {
      description: "The models one harness accepts. Same JSON as vibest models",
      params: { harness: Argument.String("harness"), provider: providerFlag },
    }),
  ],
})

const agentMachine = Flag.String("machine").pipe(
  Flag.withDescription("Ask another machine, whose own definitions its sessions run as"),
  Flag.optional,
)

const agent = Spec.make("agent", {
  description:
    "The agent definitions sessions run as: the builtin ones, one per file in ~/.vibest/agents (<id>.md) and those plugins add",
  commands: [
    Spec.make("list", {
      alias: "ls",
      description:
        "Each agent definition with its description, the plugin that added it and the harness, provider and model it starts on when a run names none; invalid lists each definition file that failed to load and why",
      params: { machine: agentMachine },
    }),
    Spec.make("show", {
      description: "One agent definition with the full prompt its sessions get before their session facts",
      params: { id: Argument.String("id"), machine: agentMachine },
    }),
  ],
})

const project = Spec.make("project", {
  description:
    "This repository's project folder (VIBEST_PROJECT_DIR for agents): preferences.md, docs/, memories/ and artifacts/. Read and write them with your file tools",
  commands: [
    Spec.make("create", {
      description:
        "For working on several repositories together. One git repository is already a project: cd into it and run vibest. Copies each repository into a new directory, one folder each, and leaves your originals untouched. The new directory must not be inside a git repository. Example: vibest project create ~/work/combo --from ~/code/shop --from ~/code/admin. Only the user runs this",
      params: {
        directory: Argument.String("directory").pipe(
          Argument.withDescription("The project directory to create, or an empty directory to use"),
        ),
        from: Flag.String("from").pipe(
          Flag.withDescription("A git repository to copy in, as a folder named after it. Repeat for each repository"),
          Flag.atLeast(1),
        ),
      },
    }),
    Spec.make("clone", {
      description:
        "Clone a git repository (any URL: ssh or https, any host) and record it as a project, here or with --machine on another machine; it clones the default branch, and vibest run --machine still needs the exact commit there. The folder is --dir, or the repository name under cloneDirectory in vibest.json (default ~/code) of the machine that clones; a folder that is not empty is refused. Prints git's progress on stderr, then the project id and folder",
      params: {
        url: Argument.String("url"),
        machine: Flag.String("machine").pipe(
          Flag.withDescription("Clone on this machine (vibest machine ls) instead of here"),
          Flag.optional,
        ),
        dir: Flag.String("dir").pipe(
          Flag.withDescription(
            "The folder to clone into; with --machine a relative folder is under that machine's cloneDirectory",
          ),
          Flag.optional,
        ),
      },
    }),
    Spec.make("add", {
      description:
        "Record a checkout as a project without opening an entry session, so another machine can run agents in it. Only the user runs this",
      params: { directory: Argument.String("directory").pipe(Argument.withDefault(".")) },
    }),
    Spec.make("move", {
      description:
        "Continue, here, the project recorded at an old directory: same id, memories and sessions. Run it inside the repository at its new place, and only when the old directory is gone. Prints git worktree repair for each of your worktrees outside vibest's. Only the user runs this",
      params: { from: Argument.String("old-directory") },
    }),
    Spec.make("info", {
      description: "The paths of the project folder and of its preferences.md, docs, memories and artifacts",
    }),
    Spec.make("search", {
      description: "Search the project folder, ignoring case. Each hit is kind/path:line: text",
      params: {
        query: Argument.String("query"),
        kind: Flag.Literals("kind", ProjectKind.literals).pipe(
          Flag.withDescription("Only this kind: docs, memories or artifacts"),
          Flag.optional,
        ),
      },
    }),
  ],
})

const plugins = Spec.make("plugins", {
  description: "Plugins loaded from ~/.vibest/plugins and vibest.json, with hook counts since vibestd started",
})

const subscriptions = Spec.make("subscriptions", {
  description: "Each harness login and its usage limits, as last read",
})

const onboard = Spec.make("onboard", {
  description:
    "Set up where vibest runs agents and which coding agent it starts: pick a terminal runtime (offering to install herdr-core when none is found) and a harness, and save both as defaults in vibest.json. Works outside a git repository. Only the user runs this",
})

const doctor = Spec.make("doctor", {
  description:
    "Check that vibest can work here: the harnesses, vibestd, the runtimes agents run in, and plugins. Each problem says how to fix it. Starts vibestd when it is not running",
})

const update = Spec.make("update", {
  alias: "upgrade",
  description:
    "Update vibest the way it was installed. install.sh takes a GitHub release; npm takes that exact version from the registry, with the package manager that installed it. The new one is tried aside first and must open the database. Then replaces the running vibestd and asks whether to restart agents still on the old version, keeping their conversations. A stable install updates to the newest stable release; a beta install updates to the newest release of either channel",
  params: {
    beta: Flag.Boolean("beta").pipe(
      Flag.withDescription("Update to the newest release, beta or stable"),
      Flag.withDefault(false),
    ),
    stable: Flag.Boolean("stable").pipe(
      Flag.withDescription("Update to the newest stable release only"),
      Flag.withDefault(false),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Restart agents still on the old version without asking. For a shell with no terminal"),
      Flag.withDefault(false),
    ),
    restartAgentsAfter: Flag.Int("restart-agents-after").pipe(Flag.withHidden, Flag.optional),
  },
})

const connect = Spec.make("connect", {
  description:
    "What another machine's vibestd runs over ssh. Joins stdin and stdout to this machine's vibestd, and starts it when it is not running. Not for direct use",
})

const worktree = Spec.make("worktree", {
  description: "Worktrees vibest made for projects on this machine",
  commands: [
    Spec.make("list", {
      alias: "ls",
      description:
        "The worktrees vibest made, grouped by project, as JSON. Each has its path, and for every repository in it (one, or one folder each in a project of several) that repository's folder, its branch or detached commit, and its state computed now with git: dirty with the number of changed files, unsaved (commits on no branch, lost if the worktree is removed), or clean. Sessions whose recorded directory is that worktree are listed with their id, title, and whether they are live or archived. --project limits the list to one project. --machine asks another machine, which answers for its own projects",
      params: {
        project: Flag.String("project").pipe(
          Flag.withDescription("Only this project: its id, or its folder (on --machine, a path on that machine)"),
          Flag.optional,
        ),
        machine: Flag.String("machine").pipe(
          Flag.withDescription("Ask another machine (vibest machine list); it lists its own worktrees"),
          Flag.optional,
        ),
      },
    }),
  ],
})

const machine = Spec.make("machine", {
  description:
    "Machines this vibestd connects to over ssh, so vibest run --machine can run agents there. Only the user runs these",
  commands: [
    Spec.make("add", {
      description: "Connect to a machine's vibestd over ssh and keep it",
      params: {
        name: Argument.String("name").pipe(Argument.withDescription("The name --machine uses")),
        target: Argument.String("target").pipe(
          Argument.withDescription("An ssh target: user@host, user@host:port, or a Host from the ssh config"),
        ),
      },
    }),
    Spec.make("list", {
      alias: "ls",
      description:
        "The machines this vibestd connects to: connection, runtimes, whether this machine shows their terminals, and their load (cores, CPU in use, memory, working executions; loadError when it cannot be read). JSON",
    }),
    Spec.make("remove", {
      alias: "rm",
      description:
        "Forget a machine and stop its connection. Agents there keep running; adding it again delivers their results",
      params: { name: Argument.String("name") },
    }),
  ],
})

export const Commands = Spec.make("vibest", {
  description: "In a project directory, open its entry session in this terminal. --new starts a new conversation",
  params: entryFlags,
  commands: [
    daemon,
    run,
    send,
    status,
    result,
    interrupt,
    stop,
    peek,
    archive,
    ls,
    session,
    events,
    models,
    harness,
    agent,
    project,
    worktree,
    plugins,
    subscriptions,
    onboard,
    doctor,
    update,
    connect,
    machine,
  ],
})
