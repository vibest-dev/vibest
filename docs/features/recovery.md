# Recovery

What happens when a pane, a harness, herdr or vibestd dies mid-work: no reply is lost and nothing is sent twice. Each
capability below says what it is and when it counts as working.

## S8. Self-healing and a bad model

A daemon killed mid-execution and a pane closed mid-execution are recovered as below (S21, S23). A run with a model its harness
does not list is refused before any pane opens, naming the model, and no session is created.

## S21. Pane killed mid-execution

When a session's pane is killed mid-execution, the execution fails with its failure, the session ends, and its creator gets one notice that carries the failure, how to
peek and resume it, and the text of every send that was queued for it and not delivered; the time it took is recorded.

## S22. Harness killed

When a session's harness process is killed and its pane stays, the same happens as in S21, and the pane still exists.

## S23. vibestd restarted or killed around an execution end

When vibestd restarts mid-execution, or is killed right after an execution ends, exactly one completed execution results, carrying
the execution's reply, and it sends nothing.

## S24. vibestd killed mid-delivery

When vibestd is killed while it delivers a message, that message fails once with a notice that it may or may not have
arrived, is not delivered again, and a later send is delivered.

## S25. herdr hands over to a new server

When herdr hands over to a new server, vibest catches up with it: a pane closed afterwards is seen as exited (the time
is recorded), and sends still work.

## S28. vibestd killed before a terminal opened

When vibestd is killed while a session's terminal is not open yet, the next vibestd ends the session as failed to
launch, with one notice, and removes its worktree, or keeps it and says why.

## S29. vibestd killed before the first task was handed over

When vibestd is killed before a session's first task reached it, the next vibestd types the task once, and the one
execution it runs sends nothing.

## S30. Archive cut off

When an archive is cut off after it started, the next vibestd finishes it: it closes the session's tab, ends it as
archived and keeps its worktree.

## S51. Pane killed while idle

When a session's pane is killed while it is idle, the session ends, its completed execution stays completed, and its creator
gets exactly one notice that it exited, saying how to peek and resume it.
