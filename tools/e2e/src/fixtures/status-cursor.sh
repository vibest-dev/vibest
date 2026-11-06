#!/bin/sh
set -eu
hook=$1
printf '%s' '{"hook_event_name":"beforeSubmitPrompt","prompt":"scratch"}' | sh "$hook" prompt
printf 'prompt-finished\n'
read -r _
printf '%s' '{"hook_event_name":"afterAgentResponse","text":"cursor-status-completed"}' | sh "$hook" stop
printf 'response-finished\n'
read -r _
printf '%s' '{"hook_event_name":"stop","status":"completed"}' | sh "$hook" stop
printf '%s' 'not json' | sh "$hook" prompt
printf '{"hook_event_name":"preToolUse","cwd":"%s","tool_name":"Shell","tool_input":{"command":"git status"}}' "$PWD" | sh "$hook" guard
printf 'ignored-finished\n'
read -r _
