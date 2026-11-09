# Distribution

Installation and update details for the [vibest surfaces](architecture.md#13-surfaces-and-protocol).

From omac `bin/`, `cli-<platform>` packages, `build-flags.ts`: two installs of the same compiled binary,
built without `bunfig` and `.env` autoloading (otherwise a compiled Bun executable loads `bunfig.toml`, whose
`preload` runs code, and `.env` from the directory it runs in, and vibest runs in repositories it does not control). install.sh (`curl … | sh`) downloads this platform's archive from the
latest GitHub Release (a `v*` tag's release: one archive per platform, install.sh, and `version`), unpacks it to
`~/.local/share/vibest/versions/<version>/` and links `~/.local/bin/vibest` to it; it keeps the version before as well, for a
vibestd and sessions still running it. npm (`npm i -g @vibest/cli@beta`): a Node launcher runs the platform package's
binary. `vibest update` updates the way vibest was installed: install.sh again into the same directories, or the package
manager; a build or source checkout is refused. The install never lives under `~/.vibest`, which holds data only.
The archive also holds `herdr-plugin/`, which install.sh does not link; the user links it.

The npm launcher (`bin/vibest.cjs`) passes arguments and stdio through and hands the binary the package's
`harnesses/` as `VIBEST_HARNESSES`, which is also how the binary knows npm installed it. It forwards SIGTERM and
SIGHUP but not SIGINT: the terminal already delivers Ctrl-C to the binary in the same process group, and forwarding
it would make one Ctrl-C two. It ends with the binary's exit status, or dies of the same signal; a signal Node
ignores (SIGPIPE) becomes exit status 128 + its number. When the package manager skipped the optional platform
package (bun does at times), it prints the exact command that adds it.

`vibest update` upgrades an npm install with the package manager that owns the binary's real path, not the first
npm on PATH: bun's global directory, or an npm prefix (`<prefix>/lib/node_modules/@vibest/…`, as under fnm, mise,
nvm and Homebrew), whose own npm is taken to be `<prefix>/bin/npm`. bun is also given the platform package, which
it may skip. install.sh is read whole before it runs, so a cut-off download never runs half a script.
Before it installs, `vibest update` fetches the new version into a temporary directory (install.sh with
`VIBEST_INSTALL` and `VIBEST_BIN` there, or the package manager with `--prefix` or `--cwd`), checks that it reports the
version asked for, and has it run `vibest daemon import-check` against this `VIBEST_HOME`; when any of that fails,
nothing is installed, vibestd is left running and the message says why and what to do. A package manager then
installs that exact version, not the `beta` tag, so what is installed is what was tried. install.sh takes no version:
it installs the latest release again, which is the one tried unless a release lands in between. Either way the release
is fetched twice. When
the vibestd step fails after the install, the message also gives the command that puts the version before back. An install
already current goes on to the vibestd and agent steps, which also covers an upgrade made with npm or bun directly.
`update` and `doctor` report more than one `vibest` on PATH (one per real file, in PATH order): the first as the
one that runs, the others with the command that removes them. The user's own `vibest`, `vibest status` and
`vibest doctor`, never an agent's, print one line when a newer version is out (the registry's `beta` tag, or the
release's `version` file). vibestd looks it up at start and then every hour and keeps the answer in memory only
(`{checked, latest, checking}`; a failed look-up clears `checked` and is retried at the next hour); the CLI reads it
from Ping, and `vibest status` shows it as `daemon.update`. Without a running vibestd nothing is printed.
`VIBEST_NO_UPDATE_CHECK=1` turns it off: in vibestd's environment it stops the look-up, in the CLI's the line. A registry that answers 404 (a local build installed from a tarball) is
reported as having no release yet.
