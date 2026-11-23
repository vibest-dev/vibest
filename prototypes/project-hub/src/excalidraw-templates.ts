export type ArchitecturePreset = "vibest-architecture" | "event-pipeline" | "multi-agent-review"

interface DiagramBoxSpec {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor: string
  strokeColor: string
  kind?: "rectangle" | "ellipse" | "diamond"
}

interface DiagramArrowSpec {
  id: string
  fromId: string
  toId: string
  label: string
  startX: number
  startY: number
  dx: number
  dy: number
  strokeColor: string
}

function makeBoxElements(spec: DiagramBoxSpec, seedBase: number) {
  const textId = `${spec.id}-label`
  const elementType = spec.kind ?? "rectangle"
  const lines = spec.label.split("\n")
  const textHeight = lines.length * 20

  return [
    {
      id: spec.id,
      type: elementType,
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      angle: 0,
      strokeColor: spec.strokeColor,
      backgroundColor: spec.backgroundColor,
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: seedBase,
      version: 1,
      versionNonce: seedBase + 17,
      isDeleted: false,
      boundElements: [{ type: "text", id: textId }],
      updated: 1732290000000,
      link: null,
      locked: false,
    },
    {
      id: textId,
      type: "text",
      x: spec.x + 12,
      y: spec.y + Math.max(12, Math.floor((spec.height - textHeight) / 2)),
      width: spec.width - 24,
      height: textHeight,
      angle: 0,
      strokeColor: "#1a1917",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: seedBase + 31,
      version: 1,
      versionNonce: seedBase + 47,
      isDeleted: false,
      boundElements: null,
      updated: 1732290000000,
      link: null,
      locked: false,
      text: spec.label,
      fontSize: 14,
      fontFamily: 2,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: spec.id,
      originalText: spec.label,
      lineHeight: 1.35,
    },
  ]
}

function makeArrowElements(spec: DiagramArrowSpec, seedBase: number) {
  const labelId = `${spec.id}-text`

  return [
    {
      id: spec.id,
      type: "arrow",
      x: spec.startX,
      y: spec.startY,
      width: Math.abs(spec.dx),
      height: Math.abs(spec.dy),
      angle: 0,
      strokeColor: spec.strokeColor,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 2 },
      seed: seedBase,
      version: 1,
      versionNonce: seedBase + 13,
      isDeleted: false,
      boundElements: spec.label ? [{ type: "text", id: labelId }] : [],
      updated: 1732290000000,
      link: null,
      locked: false,
      points: [
        [0, 0],
        [spec.dx, spec.dy],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: spec.fromId, focus: 0, gap: 6 },
      endBinding: { elementId: spec.toId, focus: 0, gap: 6 },
      startArrowhead: null,
      endArrowhead: "arrow",
    },
    ...(spec.label
      ? [
          {
            id: labelId,
            type: "text",
            x: spec.startX + Math.floor(spec.dx / 2) - 65,
            y: spec.startY + Math.floor(spec.dy / 2) - 12,
            width: 130,
            height: 22,
            angle: 0,
            strokeColor: "#4d4a44",
            backgroundColor: "#fdfdfb",
            fillStyle: "solid",
            strokeWidth: 1,
            strokeStyle: "solid",
            roughness: 0,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: seedBase + 29,
            version: 1,
            versionNonce: seedBase + 43,
            isDeleted: false,
            boundElements: null,
            updated: 1732290000000,
            link: null,
            locked: false,
            text: spec.label,
            fontSize: 12,
            fontFamily: 2,
            textAlign: "center",
            verticalAlign: "middle",
            containerId: spec.id,
            originalText: spec.label,
            lineHeight: 1.25,
          },
        ]
      : []),
  ]
}

function boxesForPreset(preset: ArchitecturePreset): DiagramBoxSpec[] {
  switch (preset) {
    case "event-pipeline":
      return [
        {
          id: "node-command",
          label: "RPC / CLI Command\n(Validated Input)",
          x: 80,
          y: 160,
          width: 220,
          height: 92,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-ledger",
          label: "Append-Only Event Log\n(SQLite STRICT + Trigger)",
          x: 390,
          y: 160,
          width: 240,
          height: 92,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-readmodel",
          label: "Derived Read Model\n(Board + Needs You)",
          x: 720,
          y: 90,
          width: 230,
          height: 88,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-ws",
          label: "WebSocket Live Bus\n(Zero-Poll UI Sync)",
          x: 720,
          y: 230,
          width: 230,
          height: 88,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
      ]
    case "multi-agent-review":
      return [
        {
          id: "node-entry",
          label: "Entry Coordinator\n(claude --model opus)",
          x: 90,
          y: 170,
          width: 230,
          height: 90,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-worker",
          label: "Author Worker Session\n(Isolated Git Worktree)",
          x: 410,
          y: 80,
          width: 240,
          height: 90,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-artifact-gate",
          label: "Artifact Review Gate\n(DOM + Region + Whiteboard)",
          x: 410,
          y: 250,
          width: 240,
          height: 94,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-owner",
          label: "Owner Browser Triage\n(Approve / Request Changes)",
          x: 740,
          y: 165,
          width: 245,
          height: 96,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
      ]
    case "vibest-architecture":
      return [
        {
          id: "node-harnesses",
          label: "CLI Harnesses\n(claude · agy · pi · cursor)",
          x: 50,
          y: 80,
          width: 280,
          height: 94,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-vibestd",
          label: "vibestd Daemon\n(Effect RPC + Unix Socket)",
          x: 50,
          y: 255,
          width: 280,
          height: 94,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-ledger",
          label: "SQLite Event Ledger\n(Append-Only + Read Model)",
          x: 420,
          y: 168,
          width: 300,
          height: 100,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-hub",
          label: "Bun Project & Artifact Hub\n(HTTP + WS + CLI Bridge)",
          x: 810,
          y: 80,
          width: 295,
          height: 94,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
        {
          id: "node-browser",
          label: "Web Review Studio\n(DOM Picker · Box · Excalidraw)",
          x: 810,
          y: 255,
          width: 295,
          height: 96,
          backgroundColor: "#ededea",
          strokeColor: "#4d4a44",
        },
      ]
  }
}

function arrowsForPreset(preset: ArchitecturePreset): DiagramArrowSpec[] {
  switch (preset) {
    case "event-pipeline":
      return [
        {
          id: "arrow-cmd-ledger",
          fromId: "node-command",
          toId: "node-ledger",
          label: "appendFact()",
          startX: 304,
          startY: 206,
          dx: 82,
          dy: 0,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-ledger-rm",
          fromId: "node-ledger",
          toId: "node-readmodel",
          label: "sync tx",
          startX: 634,
          startY: 192,
          dx: 82,
          dy: -54,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-ledger-ws",
          fromId: "node-ledger",
          toId: "node-ws",
          label: "broadcast",
          startX: 634,
          startY: 220,
          dx: 82,
          dy: 52,
          strokeColor: "#4d4a44",
        },
      ]
    case "multi-agent-review":
      return [
        {
          id: "arrow-entry-worker",
          fromId: "node-entry",
          toId: "node-worker",
          label: "vibest run",
          startX: 324,
          startY: 195,
          dx: 82,
          dy: -65,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-worker-gate",
          fromId: "node-worker",
          toId: "node-artifact-gate",
          label: "artifact put",
          startX: 530,
          startY: 174,
          dx: 0,
          dy: 72,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-gate-owner",
          fromId: "node-artifact-gate",
          toId: "node-owner",
          label: "Needs You",
          startX: 654,
          startY: 285,
          dx: 82,
          dy: -62,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-owner-entry",
          fromId: "node-owner",
          toId: "node-entry",
          label: "<vibest-artifact-review>",
          startX: 736,
          startY: 195,
          dx: -412,
          dy: 15,
          strokeColor: "#4d4a44",
        },
      ]
    case "vibest-architecture":
      return [
        {
          id: "arrow-harness-vibestd",
          fromId: "node-harnesses",
          toId: "node-vibestd",
          label: "hook events",
          startX: 190,
          startY: 178,
          dx: 0,
          dy: 72,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-vibestd-ledger",
          fromId: "node-vibestd",
          toId: "node-ledger",
          label: "append facts",
          startX: 334,
          startY: 290,
          dx: 82,
          dy: -60,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-ledger-hub",
          fromId: "node-ledger",
          toId: "node-hub",
          label: "readonly sync",
          startX: 724,
          startY: 205,
          dx: 82,
          dy: -68,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-hub-browser",
          fromId: "node-hub",
          toId: "node-browser",
          label: "WS live sync",
          startX: 955,
          startY: 178,
          dx: 0,
          dy: 72,
          strokeColor: "#4d4a44",
        },
        {
          id: "arrow-browser-vibestd",
          fromId: "node-browser",
          toId: "node-vibestd",
          label: "<vibest-artifact-review>",
          startX: 806,
          startY: 325,
          dx: -472,
          dy: 10,
          strokeColor: "#4d4a44",
        },
      ]
  }
}

export function generateArchitectureScene(preset: ArchitecturePreset): string {
  const boxes = boxesForPreset(preset)
  const arrows = arrowsForPreset(preset)

  const elements = [
    ...boxes.flatMap((box, idx) => makeBoxElements(box, 1000 + idx * 100)),
    ...arrows.flatMap((arrow, idx) => makeArrowElements(arrow, 5000 + idx * 100)),
  ]

  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "https://vibest.local/project-hub",
      elements,
      appState: {
        viewBackgroundColor: "#fdfdfb",
        gridSize: 20,
      },
      files: {},
    },
    null,
    2,
  )
}
