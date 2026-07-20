# Issue tracker conventions

This repo uses a **local-markdown tracker** for agent-driven planning efforts. GitHub Issues is not used for wayfinding.

## Wayfinding operations

Maps and tickets live under `docs/wayfinder/<effort-slug>/`:

```text
docs/wayfinder/<effort-slug>/
├── map.md              # the map issue (label wayfinder:map)
└── tickets/
    └── NN-<slug>.md    # child tickets, NN is a stable two-digit id
```

- **Identity**: a ticket's identity is its filename (`NN-<slug>.md`); its name is the `title` frontmatter field. Always refer to tickets by title, linking the file.
- **Frontmatter** (tickets):

  ```yaml
  ---
  title: <ticket name>
  status: open | closed
  assignee: # empty = unclaimed; a name = claimed
  labels: [wayfinder:research | wayfinder:prototype | wayfinder:grilling | wayfinder:task]
  blocked-by: [] # list of ticket filenames; all must be status: closed to unblock
  ---
  ```

- **Claiming**: set `assignee` before doing any work on a ticket.
- **Frontier query**: tickets with `status: open`, empty `assignee`, and every `blocked-by` entry `status: closed`. Example:
  `grep -l "status: open" docs/wayfinder/*/tickets/*.md` then filter by assignee/blockers.
- **Resolution**: append a `## Resolution` section to the ticket body, set `status: closed`, and add a one-line entry to the map's `## Decisions so far`.
- **Assets**: files produced while resolving a ticket (research notes, prototypes) live next to the tickets or in `docs/research/`, linked from the ticket.
