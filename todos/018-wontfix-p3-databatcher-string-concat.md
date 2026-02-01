---
status: wontfix
priority: p3
issue_id: "018"
tags: [code-review, performance, optimization]
dependencies: []
---

# DataBatcher Uses String Concatenation

## Problem Statement

The DataBatcher accumulates data using string concatenation (`this.data += chunkStr`), which creates new string allocations on each write. For high-throughput output, this creates GC pressure.

## Findings

**Location:** `apps/desktop/src/main/terminal/terminal-manager.ts:48`

```typescript
this.data += chunkStr;  // String reallocation on each chunk
```

## Proposed Solutions

### Option A: Use array of chunks with join at flush

```typescript
private chunks: string[] = [];

write(chunk: Buffer | string): void {
  this.chunks.push(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  // ...
}

flush(): void {
  const data = this.chunks.join('');
  this.chunks = [];
  // ...
}
```

**Note:** Current implementation follows Hyper's pattern and may be "good enough" for typical use.

## Acceptance Criteria

- [ ] Benchmark before/after
- [ ] Only change if measurable improvement
- [ ] No functional regression

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | String concat is O(n) per operation |
| 2026-02-01 | Verified Hyper uses identical pattern (string concat with StringDecoder) | This is the standard approach, not a problem. V8 optimizes short string concat, batch size is small (200KB max, 16ms flush) |
