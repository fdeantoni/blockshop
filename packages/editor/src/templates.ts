import type { PieceOptions, Voxel } from "@blockshop/schema";

/**
 * Starting points for a new piece. Kids pick one in the "Start from…" dialog and get a copy to
 * recolour and change. Coordinates: x 0-15 left to right, y 0-15 up, z 0 is the back and z 15 the
 * front (the yellow bar in the editor). Later boxes overwrite earlier ones at the same cell.
 * Colours must exist in DEFAULT_PALETTE (packages/editor/test/templates.test.ts checks).
 */
export interface Template {
  id: string;
  name: string;
  icon: string;
  voxels: Voxel[];
  options: PieceOptions;
}

/** Inclusive box of one colour. */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: string): Voxel[] {
  const out: Voxel[] = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) out.push({ x, y, z, c });
  return out;
}

/** Merge parts; the last part wins where they overlap. */
export function shape(...parts: Voxel[][]): Voxel[] {
  const cells = new Map<string, Voxel>();
  for (const part of parts) for (const v of part) cells.set(`${v.x},${v.y},${v.z}`, v);
  return [...cells.values()];
}

/** Remove an inclusive box from a shape (hollow tubs, drawers). */
export function cut(voxels: Voxel[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Voxel[] {
  return voxels.filter((v) => !(v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1 && v.z >= z0 && v.z <= z1));
}

const legs = (c: string, h: number, inset = 3, thick = 2): Voxel[] => {
  const a = inset, b = inset + thick - 1, d = 15 - inset - thick + 1, e = 15 - inset;
  return shape(box(a, 0, a, b, h, b, c), box(d, 0, a, e, h, b, c), box(a, 0, d, b, h, e, c), box(d, 0, d, e, h, e, c));
};

const bookRow = (y: number, colours: string[]): Voxel[] =>
  shape(...colours.map((c, i) => box(1 + i * 2, y + 1, 5, 2 + i * 2, y + 4, 11, c)));

export const TEMPLATES: Template[] = [
  {
    id: "chair", name: "Chair", icon: "🪑",
    voxels: shape(legs("oak", 5), box(3, 6, 3, 12, 7, 12, "oak"), box(3, 8, 3, 12, 14, 4, "oak")),
    options: { seat: { enabled: true, height: 8 } },
  },
  {
    id: "armchair", name: "Armchair", icon: "🛋️",
    voxels: shape(
      box(2, 0, 2, 13, 5, 13, "red"),
      box(2, 6, 2, 3, 9, 13, "red"), box(12, 6, 2, 13, 9, 13, "red"),
      box(2, 6, 2, 13, 12, 4, "red"),
      box(4, 6, 5, 11, 6, 13, "pink"),
    ),
    options: { seat: { enabled: true, height: 7 } },
  },
  {
    id: "sofa", name: "Sofa", icon: "🛋️",
    voxels: shape(box(0, 0, 3, 15, 6, 13, "blue"), box(0, 7, 3, 15, 11, 5, "blue"), box(0, 6, 6, 15, 6, 13, "purple")),
    options: { seat: { enabled: true, height: 7 } },
  },
  {
    id: "stool", name: "Stool", icon: "🪑",
    voxels: shape(legs("dark_wood", 5, 4), box(3, 6, 3, 12, 7, 12, "oak")),
    options: { seat: { enabled: true, height: 8 } },
  },
  {
    id: "table", name: "Table", icon: "🍽️",
    voxels: shape(legs("dark_wood", 11, 1), box(0, 12, 0, 15, 13, 15, "oak")),
    options: {},
  },
  {
    id: "desk", name: "Desk", icon: "🍽️",
    voxels: shape(
      box(0, 0, 3, 1, 10, 4, "dark_wood"), box(0, 0, 11, 1, 10, 12, "dark_wood"),
      box(9, 0, 3, 15, 10, 12, "dark_wood"),
      box(11, 3, 13, 13, 3, 13, "white"), box(11, 7, 13, 13, 7, 13, "white"),
      box(0, 11, 2, 15, 12, 13, "oak"),
    ),
    options: {},
  },
  {
    id: "lamp", name: "Lamp", icon: "💡",
    voxels: shape(box(5, 0, 5, 10, 1, 10, "grey"), box(7, 2, 7, 8, 9, 8, "grey"), box(3, 10, 3, 12, 14, 12, "yellow")),
    options: { light: 15 },
  },
  {
    id: "tv", name: "TV", icon: "📺",
    voxels: shape(
      box(6, 0, 6, 9, 1, 9, "black"), box(7, 2, 7, 8, 2, 8, "black"),
      box(0, 3, 6, 15, 13, 7, "black"), box(1, 4, 8, 14, 12, 8, "screen"),
    ),
    options: { light: 7 },
  },
  {
    id: "bookshelf", name: "Bookshelf", icon: "🗄️",
    voxels: shape(
      box(0, 0, 2, 15, 15, 2, "dark_wood"),
      box(0, 0, 3, 0, 15, 12, "dark_wood"), box(15, 0, 3, 15, 15, 12, "dark_wood"),
      box(0, 0, 3, 15, 0, 12, "dark_wood"), box(0, 5, 3, 15, 5, 12, "dark_wood"), box(0, 10, 3, 15, 10, 12, "dark_wood"), box(0, 15, 3, 15, 15, 12, "dark_wood"),
      bookRow(0, ["red", "blue", "green", "yellow", "purple", "orange", "pink"]),
      bookRow(5, ["green", "orange", "red", "white", "blue", "pink", "yellow"]),
      bookRow(10, ["purple", "yellow", "blue", "red", "green", "white", "orange"]),
    ),
    options: {},
  },
  {
    id: "plant", name: "Plant", icon: "🌷",
    voxels: shape(
      box(5, 0, 5, 10, 3, 10, "orange"), box(6, 4, 6, 9, 4, 9, "dark_wood"),
      box(7, 5, 7, 8, 9, 8, "green"),
      box(4, 9, 4, 11, 11, 11, "green"), box(6, 12, 6, 9, 13, 9, "green"),
      box(2, 8, 6, 4, 10, 9, "green"), box(11, 8, 6, 13, 10, 9, "green"),
      box(7, 14, 7, 8, 14, 8, "pink"),
    ),
    options: {},
  },
  {
    id: "bed", name: "Bed", icon: "🛏️",
    voxels: shape(
      box(0, 0, 0, 15, 3, 15, "dark_wood"), box(0, 4, 0, 15, 9, 1, "dark_wood"),
      box(1, 4, 2, 14, 5, 14, "white"),
      box(2, 6, 2, 13, 6, 5, "white"),
      box(1, 6, 7, 14, 6, 14, "blue"), box(1, 4, 15, 14, 6, 15, "blue"),
    ),
    options: {},
  },
  {
    id: "bath", name: "Bath", icon: "🛁",
    voxels: shape(
      cut(box(0, 0, 2, 15, 7, 13, "white"), 2, 3, 4, 13, 7, 11),
      box(2, 3, 4, 13, 5, 11, "glass"),
      box(7, 8, 2, 8, 9, 2, "grey"), box(7, 9, 3, 8, 9, 3, "grey"),
    ),
    options: { seat: { enabled: true, height: 6 } },
  },
];
