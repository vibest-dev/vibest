# Delivery

Messages between the main agent and its sessions: tasks and sends. A turn end sends nothing; an agent sends when it
decides to, and the reply of a turn is read with `vibest result`. Each capability below says what it is and when it
counts as working.

## S2. Send while busy

`vibest send` to a session that is mid-turn queues the message; once the session is idle, every queued message is
delivered, together as one prompt in one turn.

## S3. A turn end sends nothing

When a session's turn ends without the session sending anything, nothing is sent to anyone: the turn completes with its
reply as its answer, no message has the session as sender, and the main agent's model gets no request.

## S4. Send after an interrupt

`vibest interrupt` stops a session's running turn, which sends and notifies nothing, and the next `vibest send` is
delivered and its turn's answer can be read.

## S11. Claude main agent inbox

A Claude main agent gets its messages from vibestd: it takes them, holds them while it works on them, and acknowledges
each one; a message from a session still arrives as one line with its context after the conversation is cleared, and after the main
agent is stopped and resumed in the same pane.

## S12. Pi main agent inbox and its screen

A Pi main agent gets each message from a session pushed into its own turn, also after a daemon restart; a turn of several tool calls
shows on its screen as one collapsed group line.

## S13. Status changes reach vibestd at once

A change in an agent's terminal status reaches vibestd without waiting for its next poll.

## S15. Claude main agent across sessions and restarts

A Claude main agent with two sessions gets each one's messages matched to it; a message that arrives mid-turn still
arrives; a message taken by a poller that went away is offered again; delivery continues after `vibest daemon restart`.

## S18. A long first turn keeps its terminal

A session whose first turn outlasts herdr's start window keeps its terminal: no false exit is recorded, `vibest peek`
reads it, and its answer can be read.

## S19. Pi under herdr's own Pi hook

A Pi session with herdr's own Pi hook installed gets its first prompt within seconds; `vibest daemon restart` and
`vibest interrupt` work while its turn runs.

## S26. Delivery stays prompt

Over repeated rounds, every queued send to a busy session goes out once the session is idle, and every closed pane's
process ends; how long each takes is recorded.

## S32. A send repeated with one request id

A send repeated with the same request id gets the same answer and makes one message, delivered once, with one more turn and no message sent.

## S39. Sends from one session merge

Two sends from the same session that are waiting together reach the main agent as one message.

## S45. A session sends to the main agent

`vibest send` from a session to the main agent of its project queues one message from that session; the main agent gets
it as an `<agent-message>` naming the session, once, whichever way its harness takes messages (a Claude main agent polls for it, a Pi main agent is pushed it).

## S46. A session sends to a sibling

`vibest send` from a session to another session of the same project is typed into that session once it is idle, as
the input of its next turn; it reads as an `<agent-message>` naming the sender, unless the sender gave the session its
task.

## S47. A send stays inside its project

`vibest send` from a session to a session of another project is refused, and to an archived session is refused with the
id of the project's main agent; neither queues anything.

## S48. An undeliverable send goes back to its sender

When the session a send was meant for ends before the message reaches it, the message is not delivered and its sender
is told so in a notice that holds the message.

## S50. A turn that ends in an error tells its creator

When a session's turn ends in an error, the turn is `failed` with its failure, and the session's creator gets exactly one
notice that carries the failure, typed into the main agent once.

## S52. A session has no report command

`vibest report` is a usage error: a session tells another agent something with `vibest send`.
