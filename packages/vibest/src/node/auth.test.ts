import { describe, expect, it } from "vitest";

import { bearerToken, createTicketStore, TICKET_TTL_MS, tokensMatch } from "./auth";

describe("bearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(bearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns null for a missing header", () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(bearerToken("Basic abc123")).toBeNull();
  });

  it("returns null when the scheme has no value", () => {
    expect(bearerToken("Bearer")).toBeNull();
  });
});

describe("tokensMatch", () => {
  it("accepts an exact match", () => {
    expect(tokensMatch("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(tokensMatch("s3cret", "s3crey")).toBe(false);
  });

  it("rejects a different length", () => {
    expect(tokensMatch("s3cret", "s3cre")).toBe(false);
  });

  it("rejects null", () => {
    expect(tokensMatch("s3cret", null)).toBe(false);
  });
});

describe("createTicketStore", () => {
  it("accepts a ticket it issued", () => {
    const store = createTicketStore();
    const ticket = store.issue();
    expect(store.consume(ticket)).toBe(true);
  });

  it("rejects the same ticket twice (single use)", () => {
    const store = createTicketStore();
    const ticket = store.issue();
    store.consume(ticket);
    expect(store.consume(ticket)).toBe(false);
  });

  it("rejects a ticket it never issued", () => {
    const store = createTicketStore();
    expect(store.consume("never-issued")).toBe(false);
  });

  it("rejects null", () => {
    const store = createTicketStore();
    expect(store.consume(null)).toBe(false);
  });

  it("rejects an expired ticket", () => {
    let now = 1_000;
    const store = createTicketStore(() => now);
    const ticket = store.issue();
    now += TICKET_TTL_MS + 1;
    expect(store.consume(ticket)).toBe(false);
  });

  it("issues distinct tickets", () => {
    const store = createTicketStore();
    expect(store.issue()).not.toBe(store.issue());
  });
});
