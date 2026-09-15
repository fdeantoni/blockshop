import { createHash } from "node:crypto";

/**
 * Deterministic UUID (v5-style layout, SHA-1 based) from a name. Used for packs whose ids must be
 * stable across publishes but must never collide with the ids stored in project.json.
 */
export function deriveUuid(name: string): string {
  const h = createHash("sha1").update(name, "utf8").digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
