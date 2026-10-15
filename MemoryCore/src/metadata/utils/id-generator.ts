/**
 * Unique ID generation with business prefixes.
 *
 * Corresponds to the design doc section 4 ID generation spec (v3.1):
 *   - principal/resource entities: `{prefix}-{4-char timestamp Base36}{6-char random Base36}` (section 4.4 option A)
 *   - relation tables: UUID v4 (`randomUUID()`)
 */

import { randomUUID } from "node:crypto";

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const BASE = CHARS.length; // 36
const TS_LEN = 4;
const RAND_LEN = 6;

/** @deprecated v3.1 relation tables switched to UUID; constant kept for reference when migrating old tests. */
export const RELATION_ID_LEN = 36;

/** Business entity ID prefix mapping (relation tables have no prefix). */
export const ID_PREFIX = {
  user: "usr",
  team: "team",
  agent: "agt",
  task: "task",
  asset: "ast",
  userKey: "uky",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** Encode a non-negative integer as fixed-length Base36 (left-padded with 0 if short). */
function encodeBase36(value: number, length: number): string {
  let out = "";
  let remaining = value;
  for (let i = 0; i < length; i++) {
    out = CHARS[remaining % BASE] + out;
    remaining = Math.floor(remaining / BASE);
  }
  return out;
}

/** Generate a random Base36 string of length characters. */
function randomBase36(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CHARS[Math.floor(Math.random() * BASE)];
  }
  return out;
}

/**
 * Generate a prefixed entity ID, e.g. `usr-3mfxa3b9c1`.
 *
 * @param prefix business prefix (see ID_PREFIX)
 */
export function generateId(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000) % BASE ** TS_LEN;
  const tsPart = encodeBase36(ts, TS_LEN);
  const randPart = randomBase36(RAND_LEN);
  return `${prefix}-${tsPart}${randPart}`;
}

/** Generate a relation table primary key (UUID v4). */
export function generateRelationId(): string {
  return randomUUID();
}

/**
 * Validate ID legality.
 *
 * @param id ID to validate
 * @param prefix optional; when specified the ID must start with `{prefix}-`; when not specified only non-emptiness is validated
 *               (compatible with legacy ULID format).
 */
export function isValidId(id: string, prefix?: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (prefix === undefined) return id.length > 0;
  return id.startsWith(`${prefix}-`);
}
