import { PNG } from "pngjs";

export type Rgba = readonly [number, number, number, number];

function encode(png: PNG): Uint8Array {
  const buf = PNG.sync.write(png, { deflateLevel: 9, deflateStrategy: 0, filterType: 0 });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Solid-colour square texture. */
export function solidPng(size: number, rgba: Rgba): Uint8Array {
  const png = new PNG({ width: size, height: size, colorType: 6 });
  for (let i = 0; i < size * size; i++) png.data.set(rgba, i * 4);
  return encode(png);
}

/**
 * Pack icon: background square with a simple chair glyph drawn from a 16×16 bitmap,
 * scaled up with nearest-neighbour so it stays crisp.
 */
export function packIconPng(size: number, bg: Rgba, fg: Rgba): Uint8Array {
  const glyph = [
    "................",
    "....######......",
    "....#....#......",
    "....#....#......",
    "....#....#......",
    "....#....#......",
    "....#....#......",
    "....##########..",
    "....##########..",
    "....#........#..",
    "....#........#..",
    "....#........#..",
    "....#........#..",
    "....#........#..",
    "................",
    "................",
  ];
  const png = new PNG({ width: size, height: size, colorType: 6 });
  const scale = size / 16;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = glyph[Math.floor(y / scale)]?.[Math.floor(x / scale)] === "#";
    png.data.set(on ? fg : bg, (y * size + x) * 4);
  }
  return encode(png);
}
