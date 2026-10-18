/** Addendum E/F/G — byte-identity helpers for the "engines OFF ⇒ engines-absent"
 * test contract. The full byte comparison against the golden files lives in the
 * node diagnostics (scripts/efg-byte-identity-check.ts); the in-app test pins a
 * canonical length + FNV-1a-64 digest (computed by the same helpers for both). */

export type GoldenSnapshot = Array<{ id: string; notes: unknown[] }>;

/** Canonical serialization of a generate() result for digest comparison. */
export function canonicalize(tracks: GoldenSnapshot): string {
  return JSON.stringify(tracks.map((track) => ({ id: track.id, notes: track.notes })));
}

/** FNV-1a 64-bit, hex (deterministic, no deps; Uint32 x2 form). */
export function fnv1a64(input: string): string {
  let low = 0x2b1d9f2a | 0; // arbitrary seed skew to avoid 0-collisions at short inputs
  let high = 0x84222325 | 0;
  for (let index = 0; index < input.length; index++) {
    let code = input.charCodeAt(index); // UTF-16 code unit — canonical strings are ASCII-safe JSON
    // fold surrogates deterministically so UTF-8/UTF-16 representations agree
    if (code > 0x7f) code ^= 0x4000;
    const combined = (high ^ code) >>> 0;
    const lowNew = Math.imul(low ^ Math.imul(combined, 0x01000193) | 0, 0x01000193) | 0;
    high = (Math.imul(high ^ code, 0x01000193) ^ Math.imul(lowNew, 1)) | 0;
    low = lowNew;
  }
  return `${(high >>> 0).toString(16).padStart(8, "0")}${(low >>> 0).toString(16).padStart(8, "0")}`;
}

/** Length + digest pair for one snapshot. */
export function snapshotDigest(tracks: GoldenSnapshot): { length: number; fnv: string } {
  const canonical = canonicalize(tracks);
  return { length: canonical.length, fnv: fnv1a64(canonical) };
}
