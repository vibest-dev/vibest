---
name: record-acceptance-demo
description: Record an end-to-end acceptance demo of vibest from a real PTY into a 1920x1080 MP4 with keyframe PNGs and a paired Markdown acceptance report, rendered offscreen in headless Chromium (no screen-recording permission, works on a locked Mac). Use when asked for an acceptance demo, a recorded terminal walkthrough, a video of a CLI, TUI or runtime feature working, or visual verification of a feature.
---

# Record an acceptance demo

The deliverable is a pair under `$VIBEST_PROJECT_DIR/artifacts/<slug>/` (`/tmp/vbaccept-<slug>-out/` outside a vibest session): `<slug>-demo.mp4` (1920x1080 H.264) with its
keyframe PNGs, and `<slug>-report.md`. The video shows what a user would see; the report holds what a reviewer needs to
trust it. Two scripts in `scripts/` do the mechanics:

- `pty-tape.mjs` drives a real program in a Bun PTY (132x36) and records every byte it prints, with timestamps, into a
  tape (`<name>.json`, plus the ANSI-stripped transcript `<name>.txt`).
- `studio.mjs` plays a tape in a 1920x1080 page (`player.html`) in headless Chromium, records it with Playwright, saves
  a PNG at every keyframe and transcodes to MP4 with ffmpeg.

## Rule 1: real PTY only, never fake output

Every byte on screen comes from the compiled `packages/cli/dist/vibest` (run `pnpm install && pnpm build` first) or the
real programs it starts, captured by `openTape` (`Bun.spawn(argv, { terminal: { cols: 132, rows: 36, data } })`). Never
write terminal output yourself, edit a tape, or retake until a bug disappears: a real PTY catches real bugs (TTY stdin
races, ANSI wrapping, startup dialogs), and a bug caught on camera is a finding for the report.

## Rule 2: strict host isolation, zero leftovers

Run everything with its own environment under `/tmp/vbaccept-<slug>-*`: `HOME`, `VIBEST_HOME`, `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR` (keep it short; sockets have a path limit),
`HC_SOCKET`, `REX_SOCKET` and `REX_RUNTIME_DIR` (start Rex with `--autostart=false`). Set `TERM=xterm-256color` and
`LANG=en_US.UTF-8` (without it macOS bash garbles typed CJK). A harness that needs its login uses the real `HOME` only
when the demo is about that harness; say so in the report. Never touch the user's `~/.vibest` or herdr session.

Stop every daemon, core and server you started by PID in a `finally` block, then check `ps -axo pid,command | grep
/tmp/vbaccept-<slug>` and `lsof +D /tmp/vbaccept-<slug>-*` return nothing. Leftovers are a failed demo.

## Rule 3: the two-column 1920x1080 stage

`player.html` lays out a top bar (scene badge and step caption, from `tape.step`), the 132x36 terminal on the left, a
state inspector on the right (one panel per `tape.state(title, body)`, latest body wins) and a progress bar at the
bottom. Put the evidence a viewer needs beside the terminal: `vibest.json`, `vibest ls`, the runtime session or window
tree. Fill the inspector from real commands run in the same isolated environment, never typed by hand.

The terminal is rendered by `@wterm/dom` (vercel-labs/wterm, DOM text, crisp vector glyphs). It was checked on 24-bit
colour, CJK with emoji (`🚀 核心服务重构`) and a full-screen alternate-screen TUI (vim) entering and leaving.

Idle gaps longer than 1.5 s are shortened in playback, so waiting on a model or a daemon does not stall the video; the
tape keeps the real timings.

## Rule 4: fail-fast offscreen recording

`studio.mjs` serves the page over `Bun.serve({ port: 0, hostname: "127.0.0.1" })` (never `file://`), fails on any
`pageerror` or console error, and gives up after the tape length plus 120 s (`STUDIO_TIMEOUT_MS`). `@wterm/dom`,
Playwright and its headless Chromium are installed into `/tmp/vbstudio-work` (`STUDIO_WORK`, browsers under
`ms-playwright/` unless `PLAYWRIGHT_BROWSERS_PATH` is set) on first use and again when the pinned versions change,
never into the repository or the user's caches; it needs `npm`, `npx` and `ffmpeg` on `PATH`. It writes `<slug>-demo.mp4` (`libx264`, `yuv420p`, `-preset slow
-crf 20`, `+faststart`) and `<slug>-<n>-<keyframe>.png` into the output folder and prints their paths.

Open every PNG with `Read` before reporting: check that the text is legible, nothing is cut off, wide characters line
up and the scene caption matches what the terminal shows. Check the MP4 with `ffprobe` (h264, 1920x1080, yuv420p).

## Rule 5: paired output

`<slug>-report.md` beside the video holds: the commit (`git rev-parse HEAD`) and how the binary was built; each scene
with the exact commands and the keyframe PNG; the raw transcript (`<tape>.txt`) or the relevant part of it; the
config and JSON evidence shown in the inspector; every bug seen on camera with its timestamp and keyframe; the
leftover check output from Rule 2. The report says what was demonstrated, not that a feature works beyond it.

## Writing a demo

Write the demo as one Bun script in `/tmp/vbaccept-<slug>-*/demo.mjs` (it is a throwaway, not repository code).
`<root>` is that folder (keep it short, for the socket paths), with `home/`, `vibest/`, `xdg/` and `r/` made in it; the last lines of `finally` stop whatever still holds
a file under it, by PID:

```js
import { openTape } from "<repo>/.agents/skills/record-acceptance-demo/scripts/pty-tape.mjs"

const root = "<root>"
const env = {
  HOME: `${root}/home`,
  VIBEST_HOME: `${root}/vibest`,
  XDG_CONFIG_HOME: `${root}/xdg/config`,
  XDG_DATA_HOME: `${root}/xdg/data`,
  XDG_STATE_HOME: `${root}/xdg/state`,
  XDG_CACHE_HOME: `${root}/xdg/cache`,
  XDG_RUNTIME_DIR: `${root}/r`,
  HC_SOCKET: `${root}/r/hc.sock`,
  REX_SOCKET: `${root}/r/rex.sock`,
  REX_RUNTIME_DIR: `${root}/r/rex`,
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
}
const shell = {
  ...env,
  PATH: "<repo>/packages/cli/dist:/usr/bin:/bin",
  PS1: "$ ",
  BASH_SILENCE_DEPRECATION_WARNING: "1",
}
const tape = openTape(["/bin/bash", "--noprofile", "--norc", "-i"], shell, root)

try {
  tape.step("1/1", "vibest reports its state")
  await tape.wait("$ ")
  await tape.type("vibest status\r")
  await tape.wait("$ ")
  tape.state("vibest status", await Bun.$`vibest status`.env(shell).nothrow().text())
  tape.keyframe("status")
} finally {
  await tape.close()
  await tape.save(`${root}/demo.json`, "vibest status acceptance")
  const holders = (await Bun.$`lsof -t +D ${root}`.nothrow().text()).split("\n")
  const pids = holders.filter((pid) => pid && ![process.pid, process.ppid].includes(Number(pid)))
  if (pids.length > 0) await Bun.$`kill ${pids}`.quiet().nothrow()
}
```

`tape.wait(textOrRegExp, timeoutMs)` matches the ANSI-stripped output after the previous match, so two waits for the
same prompt wait for two prompts; it throws with the last output when the program exits or the time runs out. Typed
input is echoed, so wait for what the program prints, not for what you typed. `tape.type(text)` types like a person;
`tape.press(keys)` sends raw bytes (`"\x1b"`, `"\x03"`). `tape.close()` hangs up the PTY (SIGHUP, then SIGKILL after
3 s). For a single command, `bun scripts/pty-tape.mjs <tape.json> -- <command> [args...]` records it to its exit.

Then render:

```sh
out="${VIBEST_PROJECT_DIR:+$VIBEST_PROJECT_DIR/artifacts/<slug>}"
bun .agents/skills/record-acceptance-demo/scripts/studio.mjs /tmp/vbaccept-<slug>-*/demo.json "${out:-/tmp/vbaccept-<slug>-out}" <slug>
```
