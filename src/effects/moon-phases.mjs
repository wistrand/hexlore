// A full lunar cycle every 20 s, northern-hemisphere view
// (waxing is lit on the right).
//
// Designed around the panel optics (agent_docs/research.md): one lit corner lights
// most of its tile, so the moon is shaded per tile, then each tile's light is pushed
// toward its corners on the sunlit side.

export const meta = { name: "Moon phases", description: "Lunar cycle shaded per tile, light biased to the sunlit corners" };

const PERIOD = 20;
const MOON = [235, 240, 255]; // cool white; Elements renders this as its coolest white
const EARTHSHINE = 0.04; // tile level on the dark side; all 6 corners add up, so keep it low
const BIAS = 3; // exponent sharpening per-corner weights toward the lit side

// Lommel-Seeliger brightness of the lunar sphere at disk point (u, v), phase p.
function illum(u, v, p) {
  const z = Math.sqrt(Math.max(1e-4, 1 - u * u - v * v)), th = 2 * Math.PI * p;
  const mu0 = Math.max(0, u * Math.sin(th) - z * Math.cos(th)); // sun dir; viewer along +z
  return Math.min(1, (2 * mu0) / (mu0 + z));
}

// Total corner intensity (0..6) that makes a tile read at `level` (0..1): inverts the
// tile saturation curve, scaled so level 1 drives every corner at 100%.
function invTone(level) {
  const raw = (x) => -Math.log(1 - Math.min(x, 0.997));
  return (6 * raw(level)) / raw(1);
}

// Split `total` over corners by weight, capping each at 1 and refilling the rest.
function spread(total, weights) {
  const out = weights.map(() => 0);
  let free = weights.map((_, i) => i);
  while (total > 1e-6 && free.length) {
    const wsum = free.reduce((s, i) => s + weights[i], 0);
    for (const i of free) out[i] += total * (wsum ? weights[i] / wsum : 1 / free.length);
    total = 0;
    free = free.filter((i) => {
      if (out[i] <= 1) return true;
      total += out[i] - 1;
      out[i] = 1;
      return false;
    });
  }
  return out;
}

export function create({ tiles, sideLength }) {
  // Corner light comes from the hexagon vertex, not the zone point; map all onto the unit disk.
  const verts = tiles.map((tile) => ({
    cx: tile.cx, cy: tile.cy,
    corners: tile.corners.map((c) => ({ id: c.id, x: tile.cx + sideLength * Math.cos(c.a), y: tile.cy + sideLength * Math.sin(c.a) })),
  }));
  const all = verts.flatMap((v) => v.corners);
  const mx = all.reduce((s, c) => s + c.x, 0) / all.length, my = all.reduce((s, c) => s + c.y, 0) / all.length;
  const r = Math.max(...all.map((c) => Math.hypot(c.x - mx, c.y - my))) * 1.02;
  const geo = verts.map((v) => ({
    u: (v.cx - mx) / r, v: (v.cy - my) / r,
    corners: v.corners.map((c) => ({ id: c.id, u: (c.x - mx) / r, v: (c.y - my) / r })),
  }));
  return {
    frame(t) {
      const p = (t / PERIOD) % 1, out = {};
      for (const tile of geo) {
        const lit = tile.corners.map((c) => illum(c.u, c.v, p));
        // Tile level: mean over corners and center, so a tile on the terminator reads half lit.
        let level = (lit.reduce((s, x) => s + x, 0) + illum(tile.u, tile.v, p)) / (lit.length + 1);
        level = EARTHSHINE + (1 - EARTHSHINE) * level;
        const I = spread(invTone(level), lit.map((x) => x ** BIAS + 1e-3));
        tile.corners.forEach((c, k) => (out[c.id] = MOON.map((ch) => Math.round(ch * I[k]))));
      }
      return out;
    },
  };
}
