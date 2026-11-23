# CLI

The command surface: what each command is for, and who calls it. Help text (`vibest --help`) is the short form of this. Three callers:

- **User.** A terminal that is not a session. Bare `vibest` opens the project's entry session there.
- **Agent.** A session. Its environment has `VIBEST_SESSION_ID`. `vibest run` is how it starts another session.
- **Harness integration.** The plugin or hook vibest installed in a harness. It reports prompts, execution ends and tool calls. An agent does not run these commands.

A session sends to, interrupts, peeks at and archives only the sessions it started, and may also send to the session that started it. The entry session is not interrupted, peeked at or archived this way: end it in its own terminal.

An id is the session id, or a unique prefix of at least 8 characters. A text argument is literal, or `-` to read stdin. Put `--` before text that starts with `-`.

## Naming

A verb names what happens to the user's thing, as `docker stop` and `docker rm`, and Paseo `stop`. One name per operation. No aliases. Nothing is deleted from the ledger: ending a session, forgetting a machine, or any later removal keeps the record.

`vibest rm` is not a command. It used to be another name for `archive`, and `rm` says delete. An old `vibest rm` is an unknown command.

Three aliases are still accepted, and are the same operations: `vibest upgrade` is `vibest update`, `vibest harness ls` is `vibest harness list`, and `vibest agent ls` is `vibest agent list`.

`vibest machine rm` is not a session command. It forgets a machine.

## Lifecycle

Three levels, three verbs. Each leaves more of the session in place than the one below it.

### interrupt

Execution level. `vibest interrupt <id>` stops the running execution. The session stays, and its terminal stays. That execution sends no reply. The next `vibest send` continues the same session.

The user, or a session for a session it started.

### stop

Process level. Planned, not a command on this tree: another pull request adds it. `vibest stop <id>` ends the session's process and its terminal. The session stays. The next `vibest send` resumes it.

This is not `vibest integration stop`, which is a harness hook, and not the herdr plugin action `vibest herdr stop`, which interrupts the session in the focused pane and keeps its terminal.

### archive

Session level. `vibest archive <id>` ends the session for good. It closes the terminal and removes a clean worktree. It keeps the record, the messages, the replies and the branch. A worktree with unsaved work stays, and the command says why. `--keep-worktree` keeps it anyway. Nothing about an archived session comes back; start a new one. `vibest ls --all` still lists it, as exited.

The user, or a session for a session it started.

`vibest run --archive-on-idle` is not a flag. It used to archive that session the first time it was idle after a completed execution. An old `--archive-on-idle` is an unknown flag. A session is archived only with `vibest archive <id>`.

## Commands

### Opening a project

| Command                                                  | For                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Who           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `vibest`                                                 | In a project directory, open its entry session in this terminal. `--new` starts a new conversation. Leave `--harness` out to keep the current one; on a project's first start, leave it out to use Claude when Claude can start. `--provider` and `--model` apply only when passed: leaving them out, including with `--new`, does not keep the previous ones. `--agent` starts a new conversation as that definition (default coordinator); the conversation keeps it, so another needs `--new`. | User          |
| `vibest project create <directory> --from <repository>…` | Several repositories worked on together. Copies each into the new directory as its own folder and leaves the originals untouched. One git repository is already a project.                                                                                                                                                                                                                                                                                                                        | User          |
| `vibest project add [directory]`                         | Record a checkout as a project without opening an entry session, so another machine can run agents in it.                                                                                                                                                                                                                                                                                                                                                                                         | User          |
| `vibest project move <old-directory>`                    | Continue, here, the project recorded at an old directory that is gone. Same id, memories and sessions. Run it inside the repository at its new place.                                                                                                                                                                                                                                                                                                                                             | User          |
| `vibest project clone <url>`                             | Clone a repository and record it as a project, here or with `--machine` on another machine. The folder is `--dir`, or the repository name under that machine's clone directory. A non-empty folder is refused.                                                                                                                                                                                                                                                                                    | User or agent |

### Sessions

| Command                           | For                                                                                                                                                                                                                                                                       | Who           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `vibest run [<harness>] <prompt>` | Start a session on a task and print `{"id":"…"}` at once. Its own worktree, detached, on no branch. In a project of several repositories, one worktree of each, side by side. An execution end sends nothing: the session messages with `vibest send` when it decides to. | Agent         |
| `vibest send <id> <message>`      | Queue a message. Delivered when the session is idle; it does not interrupt a running execution. For a resumable session started with vibest run, sending after its pane closes or its harness exits reopens the conversation in a new pane. Prints at once.               | User or agent |
| `vibest result <id>`              | A session object, as JSON, for an id that exists. `reply` is null until the first result; test `reply`, not the object.                                                                                                                                                   | User or agent |
| `vibest ls`                       | Sessions that have not exited, as JSON: task (cut to 500 characters), status, latest result. `--all` includes exited ones.                                                                                                                                                | User or agent |
| `vibest peek <id>`                | The last lines of the session's terminal, read now, as plain text. Where to look when a result says the execution ended with no reply or did not start. Not the entry session.                                                                                            | User or agent |
| `vibest interrupt <id>`           | See [Lifecycle](#interrupt).                                                                                                                                                                                                                                              | User or agent |
| `vibest archive <id>`             | See [Lifecycle](#archive).                                                                                                                                                                                                                                                | User or agent |

`vibest run` options a caller needs: leave the harness out and the session uses the caller's harness, provider and model; name a harness to switch, and then leaving `--provider` and `--model` out uses that harness's default. `--title` names the pane; `--env KEY=VALUE` reaches the harness and is not saved; `--share <id>` runs in that session's directory instead of a new worktree; `--file` attaches a file, copied into the project folder; `--machine` runs it on another machine, and `--project` picks which of that machine's projects when it has several; `--agent` picks the agent definition (`general` by default); `--runtime` picks the terminal runtime; `--session` picks the runtime's session.

### Project folder

| Command                         | For                                                                                                                                | Who           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `vibest project info`           | Paths of the project folder and of preferences.md, docs, memories and artifacts. For an agent that folder is `VIBEST_PROJECT_DIR`. | User or agent |
| `vibest project search <query>` | Case-insensitive search of that folder. `--kind` is `docs`, `memories` or `artifacts`.                                             | User or agent |

### Agent definitions

| Command                  | For                                                                                                                                                                                        | Who           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `vibest agent list`      | Each definition: description, who added it, and the harness, provider and model a run uses when it names none. Invalid files are listed with the reason. `--machine` asks another machine. | User or agent |
| `vibest agent show <id>` | One definition, including the prompt its sessions get before their session facts.                                                                                                          | User or agent |

Definitions are the builtin ones, one file `~/.vibest/agents/<id>.md` each, and any a plugin adds.

### Worktrees

| Command                | For                                                                                                                                                                                          | Who           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `vibest worktree list` | The worktrees vibest made, grouped by project, as JSON: path, git state (dirty, unsaved, or clean) and the sessions recorded there. `--project` limits it. `--machine` asks another machine. | User or agent |

### Harnesses and models

| Command                           | For                                                                                                                                                                                | Who           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `vibest models [<harness>]`       | Models each harness reports. A row's harness, provider and model are what `vibest run` takes. Provider null means leave it out.                                                    | User or agent |
| `vibest harness list`             | Each harness: binary, whether it can start, default model, and why not when it cannot. `--machine` asks another machine. vibest does not read a repository's own harness settings. | User or agent |
| `vibest harness models <harness>` | Same JSON as `vibest models` for one harness.                                                                                                                                      | User or agent |
| `vibest subscriptions`            | Each harness login and its usage limits, as last read.                                                                                                                             | User or agent |

### Machines

Only the user. Another machine's vibestd is reached over ssh.

| Command                              | For                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `vibest machine add <name> <target>` | Connect once and keep the machine. `<target>` is `user@host`, `user@host:port`, or a Host from the ssh config. |
| `vibest machine ls`                  | Connection, runtimes, whether this machine shows their terminals, and their load. JSON.                        |
| `vibest machine rm <name>`           | Forget the machine and stop the connection. Agents there keep running; adding it again delivers their results. |
| `vibest connect`                     | What the other machine's vibestd runs over ssh. Not for direct use.                                            |

`vibest run --machine` starts a session there. `send`, `result`, `peek`, `interrupt` and `archive` take `<machine>/<id>`. `ls` takes no id; its list includes sessions on other machines.

### Maintenance

| Command                      | For                                                                                                                                                                                                                                                                                                                           | Who           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `vibest status`              | This vibest, whether vibestd is running, this machine's load when it is, and the terminal runtimes it has. Does not start vibestd.                                                                                                                                                                                            | User or agent |
| `vibest onboard`             | Choose where agents run (offering to install herdr-core when no runtime is found) and which harness starts, and save them as `defaultRuntime` and `defaultHarness` in `vibest.json`. Works outside a git repository.                                                                                                          | User          |
| `vibest doctor`              | Whether vibest can work here. Each problem says how to fix it. Starts vibestd when it is not running.                                                                                                                                                                                                                         | User or agent |
| `vibest daemon`              | Start vibestd in the background. Exits 0 when it is already running. `--foreground` runs it in this process.                                                                                                                                                                                                                  | User          |
| `vibest daemon restart`      | Replace the running vibestd with this vibest, after a confirmation. May refuse while work is still finishing. Then asks whether to restart agents still on the old version, keeping their conversations.                                                                                                                      | User          |
| `vibest daemon import-check` | Check that this vibest can open the current database.                                                                                                                                                                                                                                                                         | User          |
| `vibest update`              | Update vibest the way it was installed, try the new one aside (it must open the database), replace the running vibestd, then ask about restarting agents still on the old version. A stable install takes the newest stable release; a beta install takes the newest of either channel. `--yes` answers the restart question. | User          |
| `vibest events`              | The event log as JSON lines. `--session` and `--after <seq>` read one session from a cursor; `--follow` keeps printing.                                                                                                                                                                                                       | User          |
| `vibest plugins`             | Plugins loaded from `~/.vibest/plugins` and `vibest.json`, with hook counts since vibestd started.                                                                                                                                                                                                                            | User or agent |

### Harness integration

Not for direct use. The harness plugin calls them. They do not start vibestd; a report that does not arrive exits non-zero. `--harness` names which harness.

| Command                     | For                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `vibest integration prompt` | Execution start: the harness's prompt or activity event as JSON on stdin.                                   |
| `vibest integration stop`   | Execution end: the harness's execution-end event as JSON on stdin.                                          |
| `vibest integration ready`  | Session start: the session takes input.                                                                     |
| `vibest integration guard`  | Pre-tool: the harness's pre-tool input on stdin. Prints a refusal when the session's rules refuse the call. |

### herdr plugin

`vibest herdr <verb>` is what the herdr plugin runs. Only the user. The project directory comes from the herdr context, not the working directory. `open-entry` opens or focuses the entry session. `run` is not a way to start a session: it calls as the user and is refused. An agent starts a session with `vibest run`. `stop` interrupts the session in the focused pane and keeps its terminal; it is not [stop](#stop). `runs` lists live sessions. `subscriptions` prints usage. `palette` is the menu of those actions. `startup` republishes pane labels.
