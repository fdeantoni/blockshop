import type { PaletteEntry, Piece, Project } from "@blockshop/schema";
import { geometryId, type Cube, cubeBounds } from "./geometry.js";

export type RenderMethod = "opaque" | "blend";

export function blockIdentifier(project: Pick<Project, "namespace">, id: string): string {
  return `${project.namespace}:${id}`;
}

export function textureName(namespace: string, paletteId: string): string {
  return `${namespace}_${paletteId}`;
}

export function seatComponentName(namespace: string): string {
  return `${namespace}:seat`;
}

/** Palette ids used by the piece, most-used first (ties broken by id). */
export function paletteUsage(piece: Pick<Piece, "voxels">): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const v of piece.voxels) counts.set(v.c, (counts.get(v.c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export function renderMethodFor(usage: readonly [string, number][], palette: ReadonlyMap<string, PaletteEntry>): RenderMethod {
  return usage.some(([id]) => palette.get(id)?.translucent) ? "blend" : "opaque";
}

export function hexColor(rgba: readonly [number, number, number, number]): string {
  return "#" + rgba.slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("");
}

/** One material instance per palette entry used, plus "*" for the dominant one; all share the render method. */
export function buildMaterialInstances(ns: string, usage: readonly [string, number][], renderMethod: RenderMethod, dominant: string): Record<string, { texture: string; render_method: RenderMethod }> {
  const materialInstances: Record<string, { texture: string; render_method: RenderMethod }> = {
    "*": { texture: textureName(ns, dominant), render_method: renderMethod },
  };
  for (const [id] of usage) materialInstances[id] = { texture: textureName(ns, id), render_method: renderMethod };
  return materialInstances;
}

/**
 * Material instances that never change with the piece: every palette entry plus "*" on the first one.
 * Used for the Geyser mapping, which Geyser only reads at startup; recolouring a piece must not need a restart.
 */
export function buildStableMaterialInstances(ns: string, palette: readonly PaletteEntry[], renderMethod: RenderMethod): Record<string, { texture: string; render_method: RenderMethod }> {
  const materialInstances: Record<string, { texture: string; render_method: RenderMethod }> = {
    "*": { texture: textureName(ns, palette[0]!.id), render_method: renderMethod },
  };
  for (const p of palette) materialInstances[p.id] = { texture: textureName(ns, p.id), render_method: renderMethod };
  return materialInstances;
}

const ROTATIONS: Array<[string, number]> = [["north", 0], ["east", 270], ["south", 180], ["west", 90]];

export interface BlockBuildInput {
  project: Project;
  piece: Piece;
  cubes: readonly Cube[];
  usage: readonly [string, number][];
  palette: ReadonlyMap<string, PaletteEntry>;
}

export function buildBlock({ project, piece, cubes, usage, palette }: BlockBuildInput) {
  const ns = project.namespace;
  const identifier = blockIdentifier(project, piece.id);
  const renderMethod = renderMethodFor(usage, palette);
  const dominant = usage[0]?.[0] ?? project.palette[0]!.id;
  const [minX, minY, minZ, maxX, maxY, maxZ] = cubeBounds(cubes);
  const box = { origin: [minX, minY, minZ], size: [maxX - minX, maxY - minY, maxZ - minZ] };
  const hidden = piece.options.hidden === true;
  const seat = piece.options.seat?.enabled === true;

  const materialInstances = buildMaterialInstances(ns, usage, renderMethod, dominant);

  const components: Record<string, unknown> = {
    "minecraft:geometry": { identifier: geometryId(ns, piece.id) },
    "minecraft:material_instances": materialInstances,
    "minecraft:collision_box": box,
    "minecraft:selection_box": box,
    "minecraft:destructible_by_mining": { seconds_to_destroy: 0.6 },
    "minecraft:destructible_by_explosion": { explosion_resistance: 2 },
    "minecraft:light_dampening": 0,
    "minecraft:map_color": hexColor(palette.get(dominant)?.rgba ?? [128, 128, 128, 255]),
  };
  if (piece.options.light) components["minecraft:light_emission"] = piece.options.light;
  if (seat) {
    components[seatComponentName(ns)] = { height: piece.options.seat!.height };
    // Ticks let the script keep exactly one seat entity per placed chair (self-healing every 5 s).
    components["minecraft:tick"] = { interval_range: [100, 100], looping: true };
  }

  const trait: Record<string, unknown> = { enabled_states: ["minecraft:cardinal_direction"] };
  if (project.generator.rotationOffset !== 0) trait["y_rotation_offset"] = project.generator.rotationOffset;

  return {
    json: {
      format_version: project.formatVersion,
      "minecraft:block": {
        description: {
          identifier,
          menu_category: { category: hidden ? "none" : "construction", is_hidden_in_commands: hidden },
          traits: { "minecraft:placement_direction": trait },
        },
        components,
        permutations: ROTATIONS.map(([dir, yaw]) => ({
          condition: `q.block_state('minecraft:cardinal_direction') == '${dir}'`,
          components: { "minecraft:transformation": { rotation: [0, yaw, 0] } },
        })),
      },
    },
    identifier,
    renderMethod,
    bounds: [minX, minY, minZ, maxX, maxY, maxZ] as [number, number, number, number, number, number],
    sound: palette.get(dominant)?.sound ?? "wood",
    hidden,
    seat,
  };
}
