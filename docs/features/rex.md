# Rex runtime

Agents can run in Rex blocks (Superlogical Rex 0.1.0, API revision 18 or newer). Each capability below says what it is and
when it counts as working.

## RX1. Agents in Rex without naming it

`vibest` typed in a Rex block, without `--runtime`, starts the entry session in that block. A session it starts with
`vibest run` opens in a new window of the same Rex session; its multiline `vibest send` reaches the entry session as one
message with its lines intact, and a message sent to it is its next execution. `vibest run --share` opens beside the
shared session, a split in the same window. `vibest peek` reads the session's block, `vibest doctor` names the Rex
server and its API revision, and `vibest archive` closes the session's block.

## RX2. Starting in Rex from outside, stopping, resuming and restarting

`vibest --runtime rex` outside Rex starts the entry session in the Rex session named after the project, and it stays
running. A session it starts answers; `vibest stop` ends its harness and closes its block; the next `vibest send`
resumes the same conversation in a new block; after `vibest daemon restart` a send is still answered in that block;
`vibest archive` closes it.

## RX3. A real model orchestrating in Rex

With the user's default Pi provider and model, the entry session started in a Rex block follows a task to start a
session with `vibest run` and a second with `--share`: the first commits a file in its worktree and sends its creator a
report of five or more lines, which reaches the entry session's harness whole and wakes it to summarise the report; a
message sent to the first session is answered, `vibest peek` shows its answer, and archive closes both blocks.

## RX4. A real model keeps its conversation over stop, resume and a vibestd restart

With the user's default Pi provider and model, a session started from an entry session that was started with
`--runtime rex` keeps a codeword it was told over `vibest stop` and the resuming `vibest send`, and answers after
`vibest daemon restart`.
