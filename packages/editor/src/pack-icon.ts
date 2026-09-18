import { CUSTOM_ICONS, customIconUrl } from "./icons.js";

/** Bedrock pack icons are shown small in the pack list; 256 is what the generated ones use. */
const SIZE = 256;

/**
 * A profile's icon as a pack icon: the emoji (or the custom icon's drawing) on the pack's own colour, so the
 * kids recognise their pack in Minecraft's list. Only the editor can do this — an emoji needs the system's
 * font, and the server has none.
 */
export async function renderPackIcon(icon: string, accent: readonly [number, number, number, number]): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");

  ctx.fillStyle = `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // A soft inner square, so a dark emoji stays readable on a dark palette colour and the other way round.
  ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
  const pad = SIZE * 0.1;
  roundRect(ctx, pad, pad, SIZE - pad * 2, SIZE - pad * 2, SIZE * 0.14);
  ctx.fill();

  const custom = CUSTOM_ICONS[icon];
  if (custom) {
    // Safari draws an SVG with no intrinsic size as nothing, so the drawing gets one here; on screen the
    // icon is an <img> with a CSS size, which is why `icons.ts` leaves it out.
    const sized = { ...custom, svg: custom.svg.replace("<svg ", `<svg width="${SIZE}" height="${SIZE}" `) };
    const img = await loadImage(customIconUrl(sized));
    const box = SIZE * 0.64;
    ctx.drawImage(img, (SIZE - box) / 2, (SIZE - box) / 2, box, box);
  } else {
    ctx.font = `${Math.round(SIZE * 0.56)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#1c1c20";
    ctx.fillText(icon, SIZE / 2, SIZE * 0.54);
  }
  return canvas.toDataURL("image/png");
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not draw ${src.slice(0, 32)}…`));
    img.src = src;
  });
}
