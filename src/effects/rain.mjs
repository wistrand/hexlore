// Drops falling at different speeds.

import { Canvas, rand } from "./lib.mjs";

export const meta = { name: "Rain", description: "Drops falling at different speeds" };

export function create({ zones }) {
  const c = new Canvas(zones);
  let drops = []; // [x, y, speed]
  return {
    frame(t, dt) {
      if (Math.random() < 6 * dt) drops.push([Math.random(), 1.1, rand(0.6, 1)]);
      c.fade(0.7, dt);
      drops = drops.filter((d) => {
        d[1] -= d[2] * dt;
        if (d[1] < -0.1) return false;
        c.blob(d[0], d[1], 0.09, 0.9);
        return true;
      });
      return c.colors();
    },
  };
}
