# Delivery

Messages between the entry session and its sessions: tasks and sends. An execution end sends nothing; an agent sends when it
decides to, and the reply of an execution is read with `vibest result`. Each capability below says what it is and when it
counts as working.

## S2. Send while busy

`vibest send` to a session that is mid-execution queues the message; once the session is idle, every queued message is
delivered, together as one prompt in one execution.

## S3. An execution end sends nothing

When a session's execution ends without the session sending anything, nothing is sent to anyone: the execution completes with its
reply, no message has the session as sender, and the entry session's model gets no request.

## S4. Send after an interrupt

`vibest interrupt` stops a session's running execution, which sends and notifies nothing, and the next `vibest send` is
delivered and its execution's reply can be read.

## S53. A Claude session takes its messages when idle

A Claude session takes a send when it is idle: the send is one inbox row delivered into one execution of its own, a send
made while an execution runs waits until it ends and then opens the next execution, and every execution has its own reply.

## S54. A first task is delivered once

A session's first task is delivered once, as one execution that completes with its reply; no other message is delivered
into that execution.

## S11. Claude entry session inbox

A Claude entry session takes its messages from vibestd when it is idle, one batch at a time; the batch opens an execution
and is recorded as that execution's input; a message from a session still arrives as one line with its context after the
conversation is cleared, and after the entry session is stopped and resumed in the same pane.

## S12. Pi entry session inbox and its screen

A Pi entry session takes each message from a session when it is idle, in an execution of its own, also after a daemon restart; an execution of several tool calls
shows on its screen as one collapsed group line.

## S13. Status changes reach vibestd at once

A change in an agent's terminal status reaches vibestd without waiting for a timer.

## S15. Claude entry session across sessions and restarts

A Claude entry session with two sessions gets each one's messages matched to it; a message that arrives mid-execution still
arrives once the execution it interrupted ends; delivery continues after `vibest daemon restart`.

## S18. A long first execution keeps its terminal

A session whose first execution outlasts herdr's start window keeps its terminal: no false exit is recorded, `vibest peek`
reads it, and its reply can be read.

## S19. Pi under herdr's own Pi hook

A Pi session with herdr's own Pi hook installed gets its first prompt within seconds; `vibest daemon restart` and
`vibest interrupt` work while its execution runs.

## S26. Delivery stays prompt

Over repeated executions, every queued send to a busy session goes out once the session is idle, and every closed pane's
process ends; how long each takes is recorded.

## S32. A send repeated with one request id

A send repeated with the same request id gets the same answer and makes one message, delivered once, with one more execution and no message sent.

## S39. Sends from one session merge

Two sends from the same session that are waiting together reach the entry session as one message.

## S45. A session sends to the entry session

`vibest send` from a session to the entry session of its project queues one message from that session; the entry session gets
it as an `<agent-message>` naming the session, once, whichever way its harness takes messages (a Claude entry session polls for it, a Pi entry session is pushed it).

## S46. A session cannot send to a sibling

`vibest send` from a session to another session of the same project is refused when that session is not the one that
started it and not one it started. Nothing is queued.

## S47. A send stays inside its project

`vibest send` from a session to a session of another project is refused, and to an archived session is refused with the
id of the project's entry session; neither queues anything.

## S48. An undeliverable send goes back to its sender

When the session a send was meant for ends before the message reaches it, the message is not delivered and its sender
is told so in a notice that holds the message.

## S50. An execution that ends in an error tells its creator

When a session's execution ends in an error, the execution is `failed` with its failure, and the session's creator gets exactly one
notice that carries the failure, typed into the entry session once.

## S52. A session has no report command

`vibest report` is a usage error: a session tells another agent something with `vibest send`.
