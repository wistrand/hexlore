// A static crescent (shadow disk offset 0.35: 0.15 thin .. 0.6 fat).

import { Canvas } from "./lib.mjs";

export const meta = { name: "Crescent moon", description: "A static warm crescent" };

const OFFSET = 0.35;

export function create({ zones }) {
  const c = new Canvas(zones);
  const cx = 0.5, cy = 0.5, r = 0.55, sx = cx + OFFSET, sy = cy + 0.08, sr = r * 0.9, edge = 0.12;
  for (const [id, [x, y]] of c.pos) {
    const inside = (r - Math.hypot(x - cx, y - cy)) / edge, shadow = (Math.hypot(x - sx, y - sy) - sr) / edge;
    c.buf.set(id, Math.max(0, Math.min(1, inside, shadow)));
  }
  const colors = c.colors();
  return { frame: () => colors };
}
