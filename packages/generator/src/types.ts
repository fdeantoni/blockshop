/** Relative path → file contents. Text files are strings, binaries are bytes. */
export type FileTree = Map<string, string | Uint8Array>;

export type Face = "up" | "down" | "north" | "south" | "east" | "west";
export const FACES: readonly Face[] = ["up", "down", "north", "south", "east", "west"];

/** Axis-aligned box in editor voxel space (inclusive origin, exclusive origin+size). */
export interface MeshBox {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  /** Palette id. */
  c: string;
  /** Faces that are at least partly exposed and therefore emitted. */
  faces: Face[];
}

export interface PieceReport {
  id: string;
  identifier: string;
  name: string;
  voxels: number;
  cubesBeforeMerge: number;
  cubesAfterMerge: number;
  facesEmitted: number;
  renderMethod: "opaque" | "blend";
  /** Model-space bounds after the mirror flag: [minX, minY, minZ, maxX, maxY, maxZ]. */
  bounds: [number, number, number, number, number, number];
  hidden: boolean;
  seat: boolean;
  warnings: string[];
}

export interface BuildReport {
  version: [number, number, number];
  packName: string;
  seatsEnabled: boolean;
  pieces: PieceReport[];
  warnings: string[];
  fileCount: number;
}

export interface BuildResult {
  tree: FileTree;
  report: BuildReport;
}
