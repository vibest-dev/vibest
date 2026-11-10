# Recovery

What happens when a pane, a harness, herdr or vibestd dies mid-work: no result is lost and nothing is sent twice. Each
capability below says what it is and when it counts as working.

## S8. Self-healing and a bad model

A daemon killed mid-turn and a pane closed mid-turn are recovered as below (S21, S23). A run with a model its harness
does not list is refused before any pane opens, naming the model, and no session is created.

## S21. Pane killed mid-turn

When a session's pane is killed mid-turn, the turn fails, a send queued for it fails with a notice, the session ends,
and exactly one result says so; the time it took is recorded.

## S22. Harness killed

When a session's harness process is killed and its pane stays, the same happens as in S21, and the pane still exists.

## S23. vibestd restarted or killed around a turn end

When vibestd restarts mid-turn, or is killed right after a turn ends, exactly one completed result arrives, pointing at
the turn's report.

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

When vibestd is killed before a session's first task reached it, the next vibestd types the task once, and one result
arrives.

## S30. Archive cut off

When an archive is cut off after it started, the next vibestd finishes it: it closes the session's tab, ends it as
archived and keeps its worktree.

## S31. vibestd killed before an archive on completion

When vibestd is killed after a completed result was delivered and before its archive on completion, the next vibestd
archives the session once, with no extra notice.
