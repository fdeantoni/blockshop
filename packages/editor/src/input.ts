/**
 * Tap detection on top of OrbitControls: a pointer that moves less than TAP_PX
 * and lifts within TAP_MS, and was never part of a multi-touch gesture, is a tap.
 * Events are not stopped, so OrbitControls still receives every drag.
 */
export const TAP_PX = 8;
export const TAP_MS = 300;

export function attachTap(el: HTMLElement, onTap: (clientX: number, clientY: number) => void): () => void {
  let start: { id: number; x: number; y: number; t: number } | null = null;
  let active = 0;
  let multi = false;

  const down = (e: PointerEvent) => {
    active++;
    if (active > 1) multi = true;
    if (active === 1) { multi = false; start = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }; }
  };
  const up = (e: PointerEvent) => {
    active = Math.max(0, active - 1);
    if (!start || e.pointerId !== start.id) return;
    const dt = performance.now() - start.t;
    const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    const s = start;
    start = null;
    if (!multi && active === 0 && dt < TAP_MS && dist < TAP_PX) onTap(e.clientX, e.clientY);
    if (active === 0) multi = false;
    void s;
  };
  const cancel = () => { active = 0; start = null; multi = false; };
  const ctx = (e: Event) => e.preventDefault();

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("contextmenu", ctx);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
    el.removeEventListener("contextmenu", ctx);
  };
}

/** Long press (no movement) on an element, for the gallery's hide gesture. */
export function attachLongPress(el: HTMLElement, ms: number, onLongPress: () => void): () => void {
  let timer: number | null = null;
  let sx = 0, sy = 0;
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const down = (e: PointerEvent) => { sx = e.clientX; sy = e.clientY; clear(); timer = window.setTimeout(() => { timer = null; onLongPress(); }, ms); };
  const move = (e: PointerEvent) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > TAP_PX) clear(); };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
  el.addEventListener("pointerleave", clear);
  return () => { clear(); el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", clear); el.removeEventListener("pointercancel", clear); el.removeEventListener("pointerleave", clear); };
}
