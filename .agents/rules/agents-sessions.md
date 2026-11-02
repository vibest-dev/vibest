# Agents and Sessions

1. One main agent per project. Starting it elsewhere asks to move it here and continue its conversation; `y` moves it, anything else fails and changes nothing.
2. A notice reaches the main agent only when it has something to act on: each notice costs it a turn.
3. A session has a title (`vibest run --title`): 3 to 6 words, verb first, any language.
4. Agent types read as nouns: General Agent, later Planner Agent and Reviewer Agent.

Status: decided, not yet on main. 1 as a refusal and 2 are in open PR #307 (`fix/quiet-notices-one-main-agent`); the `y` move in 1 is decided. 3 and 4 are on `feat/claude-http-transport`.
