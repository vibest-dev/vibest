---
name: plannotator-review-tailnet
description: Open Plannotator's code review UI for the current worktree or a PR URL, served over tailnet https so another Mac can annotate, then act on the feedback.
allowed-tools: Bash(plannotator:*), Bash(tailscale:*)
disable-model-invocation: true
---

# Plannotator Review (tailnet https)

Launch a review session on a random port, front it with `tailscale serve`, hand over the https URL, and when the review is submitted, act on it.

If `$ARGUMENTS` contains a URL, it is a PR to review — the only token that may ever be forwarded to the CLI. Everything else in `$ARGUMENTS` is prose addressed to you; `plannotator review` treats stray words as a PR URL and hangs, so never forward them. Port and host have no CLI flags — env vars only.

## 1. Launch

Start the server with Bash `run_in_background: true` — the process lives until the review is submitted, so it must never run in the foreground:

```bash
PLANNOTATOR_PORT=0 PLANNOTATOR_REMOTE=1 plannotator review <PR_URL if given>
```

`PLANNOTATOR_PORT=0` lets the OS pick a free port, so concurrent worktree sessions never collide. `PLANNOTATOR_REMOTE=1` skips opening a local browser.

Done when the task's output file says "Plannotator session ready" — the line `http://localhost:<PORT>` right after it is where you read the assigned port.

## 2. Serve over tailnet https and hand over the URL

Map the port (tailnet-only https, arbitrary ports are allowed):

```bash
tailscale serve --bg --https=$PORT $PORT
```

Resolve the MagicDNS name — always the name, never a bare 100.x IP:

```bash
tailscale status --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
```

Give exactly two links, then stop and wait for the review to come back:

- Other devices (tailnet): `https://<dnsname>:<PORT>/`
- This machine: `http://localhost:<PORT>`

The startup output also prints a `share.plannotator.ai/#…` link — don't offer it: it carries the whole diff to a third-party host, while the tailnet link stays private.

## 3. Act on the feedback

The background task exits when the user submits. Read its full output, then:

- Annotations / change requests → address every one in this conversation; done when each annotation is either fixed or answered.
- Approval / LGTM → say the review passed and continue.

Either way, remove this session's serve mapping so they don't pile up: `tailscale serve --https=$PORT off`. Leave the other mappings (`tailscale serve status`) untouched.
