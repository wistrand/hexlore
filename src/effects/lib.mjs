// Shared helpers for effects in src/effects/. Not an effect itself (server.mjs skips it).
//
// An effect module exports `meta` ({ name, description }) and `create(ctx)`, which
// returns { frame(t, dt) }. frame() gets seconds since start and since the previous
// frame, and returns { zoneId: [r, g, b] }; zones it leaves out are dark. ctx:
//   zones:      [{ id, x, y }] lit corner zones, device coordinates (y up)
//   tiles:      [{ cx, cy, corners: [{ id, x, y, a }] }] corners sorted by angle a
//   sideLength: tile side in layout units (67)

import { groupTiles } from "../nanoleaf.mjs";

// Brightness 0..1 to a warm RGB; dim end goes amber, bright end near white.
export function warm(v) {
  v = Math.max(0, Math.min(1, v));
  const lvl = v ** 2.2;
  return [Math.round(255 * lvl), Math.round(255 * lvl * (0.55 + 0.4 * v)), Math.round(255 * lvl * (0.25 + 0.6 * v))];
}

// Per-zone brightness buffer on normalized 0..1 coordinates (y up), drawn with warm().
export class Canvas {
  constructor(zones) {
    const xs = zones.map((z) => z.x), ys = zones.map((z) => z.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    this.pos = new Map(zones.map((z) => [z.id, [(z.x - x0) / (x1 - x0 || 1), (z.y - y0) / (y1 - y0 || 1)]]));
    this.buf = new Map(zones.map((z) => [z.id, 0]));
  }
  // Multiplies every level by k per 1/25 s (the factors were tuned at 25 fps); pass the
  // frame's dt so trails last the same time at any frame rate.
  fade(k, dt = 1 / 25) {
    const f = k ** (dt * 25);
    for (const [id, v] of this.buf) this.buf.set(id, v * f);
  }
  blob(x, y, r, v = 1) {
    for (const [id, [px, py]] of this.pos) {
      const d = Math.hypot(px - x, py - y);
      if (d < r) this.buf.set(id, Math.max(this.buf.get(id), v * (1 - d / r)));
    }
  }
  clear() {
    for (const id of this.buf.keys()) this.buf.set(id, 0);
  }
  colors() {
    return Object.fromEntries([...this.buf].map(([id, v]) => [id, warm(v)]));
  }
}

export const rand = (a, b) => a + Math.random() * (b - a);

// The ctx above from a device layout: `zones` are the lit zones ({ panelId, x, y, o }),
// grouped into tiles by the device library's groupTiles(). Used by src/server.mjs and
// `run` in src/hexlore.mjs.
export function effectContext(zones, sideLength) {
  return {
    sideLength,
    zones: zones.map((z) => ({ id: z.panelId, x: z.x, y: z.y })),
    tiles: groupTiles(zones, sideLength),
  };
}

// Effect modules in this folder: key (file name without .mjs) -> module.
export async function loadEffects(dir) {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const out = new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "lib.mjs").sort()) {
    try {
      out.set(f.slice(0, -4), await import(pathToFileURL(join(dir, f))));
    } catch (e) {
      console.error(`effect ${f} failed to load: ${e.message}`);
    }
  }
  return out;
}
