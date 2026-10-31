// Ported from the former pixel_show.py: every tile spins a light around its corners, neighbors in
// alternating directions.

import { warm } from "./lib.mjs";

export const meta = { name: "Pinwheels", description: "Each tile spins light around its corners, alternating direction" };

export function create({ tiles }) {
  return {
    frame(t) {
      const out = {};
      tiles.forEach((tile, i) => {
        const n = tile.corners.length, head = (((t * (i % 2 ? 6 : -6)) % n) + n) % n;
        tile.corners.forEach((c, k) => {
          const d = (((head - k) % n) + n) % n;
          out[c.id] = warm(Math.max(0, 1 - d / 3));
        });
      });
      return out;
    },
  };
}
