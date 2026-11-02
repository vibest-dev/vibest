# Update and Restart

1. No hot reload.
2. `vibest update` hands vibestd off to the new version: it plans to keep running, hand off or restart, and says why.
3. Then it asks once to restart every agent still on the old integration. Yes restarts them in place (see [runtime-boundary.md](runtime-boundary.md) 4) with the same vibest session and harness conversation; an interrupted turn gets `continue`.
4. There is no separate restart command. Mismatch messages name `vibest update` ([protocol-versioning.md](protocol-versioning.md) 3).
5. An installed version directory is not deleted while a running session uses it.

Status: decided, planned in the update-restart pipeline plan (`pipeline-update-restart-plan.md` in the project scratch).
