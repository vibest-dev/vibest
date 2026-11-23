---
name: Vibest Hub
description: Local review desk for multi-agent workstreams, set like a proofed engineering document.
colors:
  paper-ground: "#f6f6f3"
  paper-rail: "#ededea"
  paper-sheet: "#fdfdfb"
  paper-hover: "#e6e6e2"
  paper-rule: "#deddd8"
  paper-rule-strong: "#c4c2bb"
  ink: "#1a1917"
  ink-secondary: "#4d4a44"
  ink-muted: "#66625a"
  proof-vermilion: "#b3401d"
  proof-wash: "#f7e3da"
  pass-forest: "#2d6a3e"
  hold-ochre: "#8a5800"
  white: "#ffffff"
  carbon-ground: "#141412"
  carbon-rail: "#1a1a18"
  carbon-sheet: "#1e1e1b"
  carbon-hover: "#272724"
  carbon-rule: "#2e2d29"
  carbon-rule-strong: "#45433d"
  carbon-ink: "#ecebe6"
  carbon-ink-secondary: "#b8b4aa"
  carbon-ink-muted: "#9a968c"
  carbon-vermilion: "#ee7a55"
  carbon-on-vermilion: "#1b0c06"
  carbon-wash: "#3a2219"
  carbon-forest: "#82c391"
  carbon-ochre: "#dcaa4f"
typography:
  headline:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  studio-title:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  subtitle:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  reading:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
  code-reading:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.65
  code:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  hairline: "3px"
  tag: "4px"
  tab: "5px"
  control: "6px"
  group: "8px"
  panel: "10px"
  dialog: "12px"
  pill: "11px"
  round: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-sheet}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-secondary:
    backgroundColor: "{colors.paper-sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-request-changes:
    backgroundColor: "{colors.paper-ground}"
    textColor: "{colors.proof-vermilion}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  proof-pin:
    backgroundColor: "{colors.proof-vermilion}"
    textColor: "{colors.white}"
    rounded: "{rounded.round}"
    size: "26px"
---

# Design System: Vibest Hub

## Overview

**Creative North Star: "The Proofed Spec"**

The hub is where an engineer signs off work that agents produced: specs, HTML prototypes, whiteboards, and verify cards. Its world is the printed engineering document on a reviewer's desk: neutral paper, black ink set in a single precise sans, tables ruled with hairlines, and one vermilion proofreader's pencil that marks exactly what still needs a human. Everything else stays ink.

It is an Operate surface. Navigation, tabs, tables, buttons, and dialogs are the standard ones; the world contributes only type, palette, density, and the signature move. Light paper is the default because review happens in daylight next to code; a calibrated carbon theme carries the same roles at night without a blue cast.

The signature move is the proof mark: numbered vermilion pins on the HTML stage, vermilion-washed quotes in specs, the vermilion count beside Needs you, and the vermilion blocked state. If something is vermilion, it is waiting on you.

**Key Characteristics:**

- Hairline-ruled lists and tables instead of cards; at most one bordered panel at any depth.
- One family (IBM Plex Sans) for all UI text; IBM Plex Mono only for code, ids, commits, selectors, and paths.
- Sentence-case headings in strict h1 to h2 to h3 order; no uppercase tracked labels.
- Status is a word with a small solid dot, never a colored pill.

## Colors

Neutral paper and ink with a single vermilion signal; forest and ochre exist only as state words.

### Primary

- **Proof Vermilion** (#b3401d; carbon #ee7a55): attention only. Needs-you counts, pins, quote marks, blocked sessions, failed gates, focus rings, Request changes. Never decoration.

### Neutral

- **Paper Ground** (#f6f6f3): page ground. Near-neutral, not cream.
- **Paper Rail** (#ededea): the second neutral layer for the left rail, studio drawer, code wells, and inactive tab tracks.
- **Paper Sheet** (#fdfdfb): raised surfaces: active nav item, selected row, dialogs, composer, HTML stage.
- **Rule** (#deddd8) and **Rule Strong** (#c4c2bb): hairlines and control borders.
- **Ink** (#1a1917), **Ink Secondary** (#4d4a44), **Ink Muted** (#66625a): text roles. Muted still passes 4.5:1 on every surface.

### State

- **Pass Forest** (#2d6a3e; carbon #82c391): approved, passed, saved, live.
- **Hold Ochre** (#8a5800; carbon #dcaa4f): changes requested, pending, unsaved.

### Named Rules

**The One Pencil Rule.** Vermilion appears only where a human is needed. If a screen has nothing waiting, it has no vermilion except the focus ring.

**The Ink Button Rule.** The primary action is ink on paper, not a brand color. Approve is ink; Request changes is a vermilion outline.

## Typography

**UI Font:** IBM Plex Sans (self-hosted variable woff2, fallback Helvetica Neue, Arial)
**Code Font:** IBM Plex Mono (self-hosted woff2 at 400 and 500, fallback ui-monospace, Menlo)

**Character:** The technical-manual grotesque of engineering documentation: plain, exact, a little mechanical at the joints. Its mono sibling shares the same skeleton, so code sits in a sentence without changing the voice.

### Hierarchy

- **Headline** (600, 1.5rem, 1.2): page h1 (project name, Artifacts, Sessions, Knowledge).
- **Studio title** (600, 1.25rem, 1.25): the artifact h1 in the studio top bar.
- **Title** (600, 1.125rem, 1.3): section h2 and dialog titles.
- **Subtitle** (600, 0.9375rem, 1.35): row titles (h3), drawer headings.
- **Body** (400, 0.875rem, 1.5): all UI copy, table cells, descriptions.
- **Reading** (400, 0.9375rem, 1.65): rendered specs and knowledge previews, 70ch measure.
- **Label** (600, 0.75rem): field labels, status words, table headers, counts. Sentence case.
- **Code** (400, 0.75rem, 1.6): ids, SHAs, branches, selectors, payloads.
- **Code reading** (400, 0.8125rem, 1.65): inline code and the knowledge editor, where code is read at length.

### Named Rules

**The No-Kicker Rule.** No uppercase tracked labels above headings. A heading carries its own count inline.

**The Twelve Floor.** Nothing renders below 0.75rem (12px).

## Layout

A 236px left rail and a fluid workspace capped at 1080px for list pages. Pages open with an h1 over a full-ink rule; sections sit 40px apart, each headed by an h2 over a hairline. Rows are a three-column grid (kind, content, status) with 16px vertical padding and hairline separators. The studio is a stage plus a 368px drawer whose sections are separated by hairlines, not boxes. Spacing steps are 4, 8, 12, 16, 24, 40. Below 860px the rail stacks above the content and grids collapse to one column.

## Elevation & Depth

Flat by default. Depth comes from the three neutral layers (rail, ground, sheet). Shadows appear only on things that float above the page: dialogs and the comment composer use `0 12px 32px -8px rgb(26 25 23 / 0.22), 0 2px 6px rgb(26 25 23 / 0.08)`; the active nav item and active tab use a 1px contact shadow.

## Shapes

Small, consistent radii: 6px controls, 8px tab tracks, 10px panels, 12px dialogs, round pins. No one-sided accent borders on rounded boxes; emphasis is a full border, a tint, or a word.

## Components

### Buttons

- **Primary:** ink fill, paper text, 6px radius, 7px 14px padding. Hover lifts to ink secondary.
- **Secondary:** sheet fill, strong rule border.
- **Quiet:** transparent until hover; used for toolbar and dismiss actions.
- **Request changes:** transparent with vermilion text and border; hover adds the proof wash.

### Status words

A 6px solid dot in currentColor followed by a 12px semibold word: vermilion for review requested and blocked, forest for approved and passed, ochre for changes requested and pending, muted ink for draft and idle.

### Lists and tables

Hairline-ruled rows. Table headers sit on a full-ink rule. Clickable rows highlight to sheet on hover and are keyboard focusable.

### Inputs

Sheet fill, strong rule border, 6px radius; focus turns the border vermilion with a 1px ring. Caret is vermilion.

### Proof pins

26px round vermilion pins with a white numeral and a paper outline; the active pin turns ink; resolved pins turn muted. Regions are dashed vermilion, solid ink when active.

## Do's and Don'ts

### Do:

- **Do** use the status word pattern for every state.
- **Do** keep IBM Plex Mono for code-like content only.
- **Do** keep every text pair at 4.5:1 or better in both themes.

### Don't:

- **Don't** nest bordered containers or wrap list items in cards.
- **Don't** use colored pill badges, glowing dots, gradients, or slate-blue darks.
- **Don't** put a one-sided border on a rounded box.
- **Don't** set any text below 12px.
