/**
 * short-id -- a short ID generator based on CSPRNG + base62
 *
 * Why not Math.random().toString(36):
 *   - Math.random() is pseudo-random (V8 xorshift128+), and the returned double mantissa has only 52 bits
 *   - no seed isolation across processes; replicas started within the same second may have correlated leading digits
 *   - 12 base36 characters look like 62 bits of space, but are limited by 52 bits of entropy;
 *     with 1 million skills in a single instance the collision probability is about 1.1e-4 (birthday paradox, not engineering-acceptable)
 *
 * This tool uses `crypto.randomBytes` (CSPRNG) + base62 encoding:
 *   - base62 = 0-9 A-Z a-z, purely alphanumeric, no special symbols (URL/object-key/log friendly)
 *   - 12 base62 characters = 62^12 ~= 3.23e21 space ~= 71 bits of true entropy
 *   - with 1 million entries the collision probability ~= 1.5e-10, about 730,000 times lower than the status quo
 *
 * Used for:
 *   - SkillCore generating skill_id (`skl-` + 12 characters = 16 characters, same length as now)
 *   - SqliteSkillStore / MongoSkillStore generating row_id
 */

import { randomBytes } from "node:crypto";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Rejection sampling threshold: floor(256 / 62) * 62 = 248
// Byte values 0..247 map uniformly to the 62 characters; 248..255 are discarded, avoiding modulo bias.
const REJECTION_THRESHOLD = 248;

/**
 * Generate a base62 random string of the given length (CSPRNG entropy).
 *
 * @param len number of output characters (>=1)
 */
export function randomBase62(len: number): string {
  if (!Number.isInteger(len) || len < 1) {
    throw new RangeError(`randomBase62: len must be a positive integer, got ${len}`);
  }
  let out = "";
  while (out.length < len) {
    // How many bytes are needed: estimate (remaining length * 256/248) rounded up + a small redundancy
    const remaining = len - out.length;
    const need = Math.max(8, Math.ceil((remaining * 256) / REJECTION_THRESHOLD) + 4);
    const buf = randomBytes(need);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      if (b < REJECTION_THRESHOLD) {
        out += BASE62_ALPHABET[b % 62];
      }
    }
  }
  return out;
}
