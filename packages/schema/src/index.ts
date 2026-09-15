/**
 * Shared data model for Blockshop: zod schemas plus inferred TypeScript types.
 * Everything that crosses a process boundary (API, disk, generator input) is
 * validated with these schemas.
 */
import { z } from "zod";

/** Voxel grid edge length. Pieces live in a 16×16×16 volume, one Minecraft block. */
export const GRID = 16;

/** Identifiers that end up in file names, block identifiers and texture names. */
export const ID_RE = /^[a-z][a-z0-9_]{0,40}$/;
export const IdSchema = z.string().regex(ID_RE, "lowercase letters, digits and underscores; must start with a letter");

const Byte = z.number().int().min(0).max(255);
const Coord = z.number().int().min(0).max(GRID - 1);
const DottedVersion = z.string().regex(/^\d+\.\d+\.\d+$/, "expected a.b.c");

export const VersionSchema = z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]);
export type Version = z.infer<typeof VersionSchema>;

export const BlockSounds = ["wood", "stone", "cloth", "glass", "metal"] as const;
export const BlockSoundSchema = z.enum(BlockSounds);
export type BlockSound = z.infer<typeof BlockSoundSchema>;

export const PaletteEntrySchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(40),
  rgba: z.tuple([Byte, Byte, Byte, Byte]),
  translucent: z.boolean().optional(),
  sound: BlockSoundSchema.optional(),
});
export type PaletteEntry = z.infer<typeof PaletteEntrySchema>;

export const VoxelSchema = z.object({ x: Coord, y: Coord, z: Coord, c: IdSchema });
export type Voxel = z.infer<typeof VoxelSchema>;

export const SeatSchema = z.object({
  enabled: z.boolean(),
  /** Seat height in voxels above the block floor (0..15). */
  height: Coord,
});
export type Seat = z.infer<typeof SeatSchema>;

export const LightLevelSchema = z.union([z.literal(0), z.literal(7), z.literal(15)]);

export const PieceOptionsSchema = z.object({
  seat: SeatSchema.optional(),
  /** Hidden pieces stay in the pack (placed blocks survive) but leave the creative menu. */
  hidden: z.boolean().optional(),
  light: LightLevelSchema.optional(),
});
export type PieceOptions = z.infer<typeof PieceOptionsSchema>;

export const PieceSchema = z.object({
  /** Identifier suffix (`family:<id>`). Immutable once published. */
  id: IdSchema,
  name: z.string().min(1).max(40),
  author: z.string().max(40).default(""),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  voxels: z.array(VoxelSchema).max(GRID * GRID * GRID),
  options: PieceOptionsSchema.prefault({}),
  /** First pack version that contained this piece. */
  publishedInVersion: VersionSchema.optional(),
});
export type Piece = z.infer<typeof PieceSchema>;
export type PieceInput = z.input<typeof PieceSchema>;

export const GeneratorOptionsSchema = z.object({
  /**
   * Flip the editor x axis when emitting geometry. Bedrock block-model space has +x pointing
   * west (Blockbench mirrors Bedrock models on x for the same reason); the device test on
   * 2026-09-14 confirmed the armrest came out on the wrong side without this. Default true.
   */
  mirrorX: z.boolean().default(true),
  /** Emitted as `y_rotation_offset` on the placement trait. Set it if pieces face the wrong way on a device. */
  rotationOffset: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  /** Greedy-merge voxels into boxes (false = one cube per voxel, for debugging). */
  merge: z.boolean().default(true),
});
export type GeneratorOptions = z.infer<typeof GeneratorOptionsSchema>;

export const PackUuidsSchema = z.object({
  bp: z.uuid(),
  rp: z.uuid(),
  bpModule: z.uuid(),
  rpModule: z.uuid(),
  scriptModule: z.uuid(),
});
export type PackUuids = z.infer<typeof PackUuidsSchema>;

// ---- Java / CraftEngine / Geyser export (docs/family-server-internals.md)

export const FACINGS = ["north", "east", "south", "west"] as const;
export const FacingSchema = z.enum(FACINGS);
export type Facing = z.infer<typeof FacingSchema>;

const QuarterTurn = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const YawTableSchema = z.object({ north: QuarterTurn, east: QuarterTurn, south: QuarterTurn, west: QuarterTurn });
export type YawTable = z.infer<typeof YawTableSchema>;

/** Canonical Java block state string, e.g. `minecraft:note_block[instrument=hat,note=0,powered=false]`. */
export const JavaStateSchema = z.string().regex(/^minecraft:[a-z_]+\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\]$/);
export const PieceJavaStatesSchema = z.object({ north: JavaStateSchema, east: JavaStateSchema, south: JavaStateSchema, west: JavaStateSchema });
export type PieceJavaStates = z.infer<typeof PieceJavaStatesSchema>;

/**
 * Vanilla block family whose freed states carry the furniture on Java (CraftEngine remaps the real
 * blocks onto canonical states). `leaves`: non-occluding full cubes, right for furniture. `note_block`:
 * opaque cubes; the client culls the faces of touching neighbours, so partial shapes show the sky
 * through the floor. Changing this reassigns every piece's states (placed furniture turns vanilla).
 */
export const JavaCarrierSchema = z.enum(["leaves", "note_block"]);
export type JavaCarrier = z.infer<typeof JavaCarrierSchema>;

/** Per-pack tuning of the Java export; the shared state bookkeeping lives in the workspace (`JavaStatesSchema`). */
export const JavaSettingsSchema = z.object({
  /**
   * Java model rotation (blockstate `y`, clockwise seen from above) per facing. The model's front is
   * the editor's +z side; vanilla convention: facing = the side the front points to.
   * If CraftEngine turns out to place pieces with their back to the player, swap north/south and east/west here.
   */
  yaw: YawTableSchema.prefault({ north: 180, east: 270, south: 0, west: 90 }),
  /** Rotation for the Geyser (Bedrock) mapping per facing; Bedrock turns the other way round. */
  bedrockYaw: YawTableSchema.prefault({ north: 180, east: 90, south: 0, west: 270 }),
  /** Added to the seat height (in blocks) for CraftEngine's seat_block; tune once on the real server. */
  seatOffset: z.number().min(-1).max(1).default(0),
});
export type JavaSettings = z.infer<typeof JavaSettingsSchema>;

/** `<namespace>:<piece id>`: the key of a piece across every profile on the family server. */
export const ServerStateKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,15}:[a-z][a-z0-9_]{0,40}$/);

/**
 * The family server's carrier-state bookkeeping, shared by all profiles (server/java-states.json).
 * States are assigned once and never reused or reordered, retired profiles included: blocks already
 * placed in the world are stored as these vanilla states.
 */
export const JavaStatesSchema = z.object({
  carrier: JavaCarrierSchema.default("leaves"),
  states: z.record(ServerStateKeySchema, PieceJavaStatesSchema).default({}),
  /** Next index into the carrier's allocation order (see generator `carrierStates()`). */
  cursor: z.number().int().min(0).default(0),
});
export type JavaStates = z.infer<typeof JavaStatesSchema>;

export function serverStateKey(namespace: string, pieceId: string): string {
  return `${namespace}:${pieceId}`;
}

export const ProjectSchema = z.object({
  /** Identifier prefix: `<namespace>:<piece.id>`. */
  namespace: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/).default("family"),
  packName: z.string().min(1).max(60),
  uuids: PackUuidsSchema,
  /** Pack version; the server bumps the patch component on every publish. */
  version: VersionSchema,
  /** Block JSON `format_version`, e.g. "1.26.30". See docs/format-notes.md. */
  formatVersion: DottedVersion,
  minEngineVersion: VersionSchema,
  /** `@minecraft/server` version for the script module dependency, e.g. "2.8.0". */
  scriptApiVersion: DottedVersion,
  palette: z.array(PaletteEntrySchema).min(1).max(64),
  generator: GeneratorOptionsSchema.prefault({}),
  /** Counter used by the server to mint piece ids. */
  nextPieceNumber: z.number().int().min(1).default(1),
  /** Settings and state bookkeeping for the Paper/CraftEngine/Geyser export. */
  java: JavaSettingsSchema.prefault({}),
});
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;

/** Palette shipped with a fresh project. Ids are stable forever; labels are for kids. */
export const DEFAULT_PALETTE: PaletteEntry[] = [
  { id: "oak", label: "Oak", rgba: [184, 148, 95, 255], sound: "wood" },
  { id: "dark_wood", label: "Dark wood", rgba: [92, 62, 38, 255], sound: "wood" },
  { id: "white", label: "White", rgba: [240, 240, 236, 255], sound: "cloth" },
  { id: "red", label: "Red", rgba: [196, 48, 44, 255], sound: "cloth" },
  { id: "blue", label: "Blue", rgba: [52, 92, 196, 255], sound: "cloth" },
  { id: "green", label: "Green", rgba: [72, 150, 64, 255], sound: "cloth" },
  { id: "yellow", label: "Yellow", rgba: [232, 200, 52, 255], sound: "cloth" },
  { id: "black", label: "Black", rgba: [28, 28, 32, 255], sound: "cloth" },
  { id: "glass", label: "Glass", rgba: [200, 230, 240, 110], translucent: true, sound: "glass" },
  { id: "stone", label: "Stone", rgba: [128, 128, 128, 255], sound: "stone" },
  // Added for the templates (2026-09-15). Append only: palette[0] is the Geyser "*" texture and
  // published pieces reference ids by name.
  { id: "grey", label: "Grey", rgba: [150, 150, 156, 255], sound: "stone" },
  { id: "brown", label: "Brown", rgba: [122, 80, 52, 255], sound: "cloth" },
  { id: "pink", label: "Pink", rgba: [236, 140, 180, 255], sound: "cloth" },
  { id: "orange", label: "Orange", rgba: [230, 130, 50, 255], sound: "cloth" },
  { id: "purple", label: "Purple", rgba: [140, 84, 190, 255], sound: "cloth" },
  { id: "screen", label: "Screen", rgba: [172, 222, 255, 255], sound: "glass" },
];

/**
 * Appends default palette entries an existing project lacks (new colours ship with new templates).
 * Existing entries keep their order and values; only missing ids are added, at the end.
 */
export function ensureDefaultPalette(project: Project): { project: Project; added: string[] } {
  const have = new Set(project.palette.map((p) => p.id));
  const missing = DEFAULT_PALETTE.filter((p) => !have.has(p.id));
  if (missing.length === 0) return { project, added: [] };
  return { project: { ...project, palette: [...project.palette, ...missing] }, added: missing.map((p) => p.id) };
}

/**
 * Defaults for a fresh project: the LOWEST Minecraft version on the family devices, not the
 * newest release (a pack whose min_engine_version exceeds the client is refused).
 * The iPads run 26.32 (internally 1.26.32) as of 2026-09-14; script API 2.8.0 shipped with 26.30.
 * See docs/format-notes.md for the release table.
 */
export const DEFAULT_FORMAT_VERSION = "1.26.30";
export const DEFAULT_MIN_ENGINE_VERSION: Version = [1, 26, 30];
export const DEFAULT_SCRIPT_API_VERSION = "2.8.0";

export function newProject(uuids: PackUuids, overrides: Partial<ProjectInput> = {}): Project {
  return ProjectSchema.parse({
    packName: "Family Furniture",
    uuids,
    version: [1, 0, 0],
    formatVersion: DEFAULT_FORMAT_VERSION,
    minEngineVersion: DEFAULT_MIN_ENGINE_VERSION,
    scriptApiVersion: DEFAULT_SCRIPT_API_VERSION,
    palette: DEFAULT_PALETTE,
    ...overrides,
  });
}

/** Map key for a voxel position. */
export function voxelKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function parseVoxelKey(key: string): [number, number, number] {
  const [x, y, z] = key.split(",").map(Number);
  return [x ?? 0, y ?? 0, z ?? 0];
}

/** Build a lookup map from a voxel list; later entries win on duplicates. */
export function voxelMap(voxels: readonly Voxel[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of voxels) m.set(voxelKey(v.x, v.y, v.z), v.c);
  return m;
}

/** Deterministic voxel order: y, then z, then x. Used before hashing/snapshotting. */
export function sortVoxels(voxels: readonly Voxel[]): Voxel[] {
  return [...voxels].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
}

/** Check that every voxel colour exists in the palette; returns the unknown ids. */
export function unknownPaletteIds(piece: Pick<Piece, "voxels">, palette: readonly PaletteEntry[]): string[] {
  const known = new Set(palette.map((p) => p.id));
  const missing = new Set<string>();
  for (const v of piece.voxels) if (!known.has(v.c)) missing.add(v.c);
  return [...missing].sort();
}

/** Map piece.name to something safe for a .lang value: single line, no leading '#'. */
export function sanitizeDisplayName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\r\n\t]+/g, " ").replace(/^#+/, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

// ---- Profiles: one pack per person, a workspace file holding them and the grown-up PIN

export const MAX_PROFILES = 3;
/** Pieces per profile, hidden ones included: 3 × 11 × 4 facings stays under the 143 Java carrier states. */
export const MAX_PIECES_PER_PROFILE = 11;
export const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, "a-z, 0-9 and _; starts with a letter; at most 16");
/** Namespaces that can never be a profile: Minecraft's, ours for shared items, Geyser's. */
export const RESERVED_PROFILE_IDS = ["minecraft", "blockshop", "geyser_custom", "geyser", "default", "craftengine"] as const;
export const ProfileRoleSchema = z.enum(["grownup", "kid"]);
export type ProfileRole = z.infer<typeof ProfileRoleSchema>;
/** One or two emoji; UTF-16 units, so a flag or a keycap fits. */
export const IconSchema = z.string().trim().min(1).max(16);
export const PinSchema = z.string().regex(/^\d{4,8}$/, "4 to 8 digits");

export const ProfileSchema = z.object({
  /** Also the namespace of every block the profile publishes; never changes. */
  id: ProfileIdSchema,
  name: z.string().trim().min(1).max(40),
  icon: IconSchema,
  role: ProfileRoleSchema,
  createdAt: z.iso.datetime(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const WorkspaceSchema = z.object({
  profiles: z.array(ProfileSchema).max(MAX_PROFILES).default([]),
  /** Ids of deleted profiles: their Java states stay taken, so the id can never come back. */
  retired: z.array(ProfileIdSchema).default([]),
  /** The grown-up PIN (scrypt) and the browser sessions that entered it. null until the setup screen ran. */
  admin: z.object({ pinHash: z.string(), salt: z.string(), sessions: z.array(z.string()).default([]) }).nullable().default(null),
  /** Version of the family-server export; every update bumps it (the served Bedrock packs need a rising version). */
  serverVersion: VersionSchema.default([1, 0, 0]),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** A namespace-safe id from a person's name: "Chloë-Mae" → "chloe_mae"; a number is appended while `taken` has it. */
export function profileIdFromName(name: string, taken: ReadonlySet<string>): string {
  let base = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `p_${base}`;
  base = base.replace(/_+$/, "").slice(0, 16).replace(/_+$/, "") || "p";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = `${base.slice(0, 16 - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The Bedrock pack name for a profile. */
export function packNameFor(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}' Furniture` : `${n}'s Furniture`;
}
