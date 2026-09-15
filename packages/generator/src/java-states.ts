import { FACINGS, type JavaCarrier, type JavaStates, type PieceJavaStates } from "@blockshop/schema";

/**
 * Vanilla "carrier" states for the Java side. CraftEngine registers custom blocks server-side and
 * shows each of them to clients as a vanilla block state nobody needs for its own sake; its
 * `internal/configuration/mappings.yml` remaps the real vanilla blocks onto one canonical
 * state per look, which frees the rest (real leaves and note blocks in the world stay untouched).
 *
 * The carrier decides how the *client* treats the block: collision, occlusion, render layer.
 * - `leaves`: full-cube collision, non-occluding (`noOcclusion`), cutout render layer. The right
 *   choice for furniture: neighbours keep their faces, so the ground under a chair stays visible.
 * - `note_block`: full opaque cube. The client culls the faces of neighbouring blocks that touch
 *   it, so anything smaller than a full cube shows the sky through the floor (seen 2026-09-15).
 */
export const LEAF_TYPES = [
  "azalea", "flowering_azalea", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "oak", "pale_oak", "cherry",
] as const;
export const LEAF_DISTANCES = 7;
/** Per leaf type: distance 1–7 × persistent, minus the canonical `distance=7,persistent=true`; waterlogged states are left alone (Geyser would flood them). */
export const LEAVES_STATE_COUNT = LEAF_TYPES.length * (LEAF_DISTANCES * 2 - 1);

/** Instrument names as in Java 1.20+ (`NoteBlockInstrument`), which also sets their canonical order. */
export const NOTE_BLOCK_INSTRUMENTS = [
  "harp", "basedrum", "snare", "hat", "bass", "flute", "bell", "guitar", "chime", "xylophone", "iron_xylophone",
  "cow_bell", "didgeridoo", "bit", "banjo", "pling", "zombie", "skeleton", "creeper", "dragon", "wither_skeleton",
  "piglin", "custom_head",
] as const;
export const NOTE_BLOCK_NOTES = 25;
export const NOTE_BLOCK_STATE_COUNT = NOTE_BLOCK_INSTRUMENTS.length * NOTE_BLOCK_NOTES * 2;

/** Canonical state string: properties in alphabetical order, exactly as Java and Geyser spell them. */
export function noteBlockState(instrument: string, note: number, powered: boolean): string {
  return `minecraft:note_block[instrument=${instrument},note=${note},powered=${powered}]`;
}

export function leavesState(type: string, distance: number, persistent: boolean): string {
  return `minecraft:${type}_leaves[distance=${distance},persistent=${persistent},waterlogged=false]`;
}

const cache = new Map<JavaCarrier, string[]>();

/** Allocation order for a carrier; stable forever, because `project.java.cursor` indexes into it. */
export function carrierStates(carrier: JavaCarrier): readonly string[] {
  let order = cache.get(carrier);
  if (order) return order;
  order = [];
  if (carrier === "leaves") {
    for (const type of LEAF_TYPES)
      for (const persistent of [false, true])
        for (let distance = 1; distance <= LEAF_DISTANCES; distance++) {
          if (persistent && distance === LEAF_DISTANCES) continue; // the one real leaves keep
          order.push(leavesState(type, distance, persistent));
        }
  } else {
    // powered=true and the mob-head instruments first: the states a real note block shows least.
    for (const powered of [true, false])
      for (const instrument of [...NOTE_BLOCK_INSTRUMENTS].reverse())
        for (let note = 0; note < NOTE_BLOCK_NOTES; note++) order.push(noteBlockState(instrument, note, powered));
  }
  cache.set(carrier, order);
  return order;
}

/** Kept for the tests and the notes; same as `carrierStates("note_block")`. */
export function noteBlockStates(): readonly string[] {
  return carrierStates("note_block");
}

export function carrierStateCount(carrier: JavaCarrier): number {
  return carrierStates(carrier).length;
}

/** `minecraft:note_block` part of a state string. */
export function javaBlockOf(state: string): string {
  const i = state.indexOf("[");
  return i < 0 ? state : state.slice(0, i);
}

/** `instrument=hat,note=0,powered=false` part of a state string: the key Geyser uses for state overrides. */
export function stateKey(state: string): string {
  const m = /^[a-z_:]+\[(.+)\]$/.exec(state);
  if (!m) throw new Error(`not a block state string: ${state}`);
  return m[1]!;
}

/** Whether a state belongs to the carrier family (leaves: any `*_leaves`; note_block: `note_block`). */
export function isCarrierState(carrier: JavaCarrier, state: string): boolean {
  const block = javaBlockOf(state);
  return carrier === "leaves" ? block.endsWith("_leaves") : block === "minecraft:note_block";
}

/**
 * Give every key (`namespace:piece`) without Java states four fresh ones (one per facing). Pure: returns
 * a new table; the server persists it. Existing assignments on the current carrier are never changed,
 * because blocks already placed in the world are stored as those vanilla states. States from another
 * carrier (after changing `carrier`) are dropped and reassigned; furniture placed under the old carrier
 * then shows as the plain vanilla block.
 */
export function allocateServerStates(table: JavaStates, keys: readonly string[]): { states: JavaStates; added: string[]; dropped: string[] } {
  const carrier = table.carrier;
  const all = carrierStates(carrier);
  const states: Record<string, PieceJavaStates> = {};
  const dropped: string[] = [];
  let cursor = table.cursor;
  for (const [key, s] of Object.entries(table.states)) {
    if (FACINGS.every((f) => isCarrierState(carrier, s[f]))) states[key] = s;
    else dropped.push(key);
  }
  if (dropped.length && Object.keys(states).length === 0) cursor = 0; // fresh start on the new carrier
  const added: string[] = [];
  for (const key of [...new Set(keys)].sort()) {
    if (states[key]) continue;
    if (cursor + FACINGS.length > all.length)
      throw new Error(`no ${carrier} states left for ${key} (${all.length} states, ${Object.keys(states).length} pieces allocated)`);
    states[key] = { north: all[cursor]!, east: all[cursor + 1]!, south: all[cursor + 2]!, west: all[cursor + 3]! };
    cursor += FACINGS.length;
    added.push(key);
  }
  return { states: { carrier, states, cursor }, added, dropped };
}
