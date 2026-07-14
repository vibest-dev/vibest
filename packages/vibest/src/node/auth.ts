import { randomUUID } from "node:crypto";

/** How long an issued WebSocket ticket stays redeemable. */
export const TICKET_TTL_MS = 10_000;

export type TicketStore = {
  /** Mint a ticket for one WebSocket upgrade. */
  issue(): string;
  /** Redeem a ticket. Always invalidates it, valid or not. */
  consume(ticket: string | null): boolean;
};

/**
 * Single-use, short-lived tickets for WebSocket upgrades. Browsers cannot set
 * headers on a WS handshake, so the bearer token cannot travel with it; the
 * renderer redeems a ticket fetched over the authenticated HTTP link instead.
 */
export function createTicketStore(now: () => number = Date.now): TicketStore {
  const expiries = new Map<string, number>();

  return {
    issue() {
      const ticket = randomUUID();
      expiries.set(ticket, now() + TICKET_TTL_MS);
      return ticket;
    },

    consume(ticket) {
      if (ticket === null) return false;
      const expiresAt = expiries.get(ticket);
      if (expiresAt === undefined) return false;
      // Delete before checking expiry: a ticket is spent by the attempt.
      expiries.delete(ticket);
      return expiresAt > now();
    },
  };
}

/** Pull the credential out of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value;
}

/** Length-then-XOR compare, so a match doesn't leak its prefix through timing. */
export function tokensMatch(expected: string, actual: string | null): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return diff === 0;
}
