# Terminal status

What an agent's terminal shows about its state. Each capability below says what it is and when it counts as working.

## T1. Native status reports from Pi

Pi reports its state to herdr-core itself: working, blocked on a question, resumed, done and aborted each show on the
terminal, results are unchanged, and no status sequence is visible on screen. Claude reports its own state to
herdr-core the same way; that is Claude's protocol, not vibest's, and vibest writes no terminal status for it. Cursor writes no
terminal status; it reports to vibestd instead (I10). agy writes no terminal status either; its hooks report to vibestd (H10).
