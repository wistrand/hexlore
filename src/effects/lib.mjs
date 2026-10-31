// Shared helpers for effects in src/effects/. Not an effect itself (server.mjs skips it).
//
// An effect module exports `meta` ({ name, description }) and `create(ctx)`, which
// returns { frame(t, dt) }. frame() gets seconds since start and since the previous
// frame, and returns { zoneId: [r, g, b] }; zones it leaves out are dark. ctx:
//   zones:      [{ id, x, y }] lit corner zones, device coordinates (y up)
//   tiles:      [{ cx, cy, corners: [{ id, x, y, a }] }] corners sorted by angle a
//   sideLength: tile side in layout units (67)

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
  fade(k) {
    for (const [id, v] of this.buf) this.buf.set(id, v * k);
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

// The ctx above from a device layout: `zones` are positionData entries of the lit
// zones ({ panelId, x, y, o }). Zones are grouped into tiles by geometry, not list
// order: each sits at 50/67 x sideLength from its tile center, in direction o mod 360.
// Used by src/server.mjs and the CLI runner src/effect.mjs.
export function effectContext(zones, sideLength) {
  const groups = [];
  for (const z of zones) {
    const a = ((z.o % 360) * Math.PI) / 180, r = (50 / 67) * sideLength;
    const ex = z.x - r * Math.cos(a), ey = z.y - r * Math.sin(a);
    let g = groups.find((g) => Math.hypot(g.ex - ex, g.ey - ey) < sideLength * 0.3);
    if (!g) groups.push((g = { ex, ey, zs: [] }));
    g.zs.push(z);
  }
  return {
    sideLength,
    zones: zones.map((z) => ({ id: z.panelId, x: z.x, y: z.y })),
    tiles: groups.map(({ zs }) => {
      const cx = zs.reduce((s, z) => s + z.x, 0) / zs.length, cy = zs.reduce((s, z) => s + z.y, 0) / zs.length;
      const corners = zs.map((z) => ({ id: z.panelId, x: z.x, y: z.y, a: Math.atan2(z.y - cy, z.x - cx) }));
      return { cx, cy, corners: corners.sort((p, q) => p.a - q.a) };
    }),
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
