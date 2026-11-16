# Terminal status

What an agent's terminal shows about its state. Each capability below says what it is and when it counts as working.

## T1. Native status reports from Claude and Pi

Claude and Pi report their state to herdr-core themselves: working, blocked on a question, resumed, done and aborted
each show on the terminal, results are unchanged, and no status sequence is visible on screen. Cursor writes no
terminal status; it reports to vibestd instead (I10). agy's state reaches herdr-core through its session-only status line (H11).
