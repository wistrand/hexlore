// Ported from the former pixel_show.py: a ball bouncing with gravity, leaving a short trail.

import { Canvas } from "./lib.mjs";

export const meta = { name: "Bouncing ball", description: "A ball bouncing under gravity with a fading trail" };

export function create({ zones }) {
  const c = new Canvas(zones);
  let x = 0.2, y = 0.9, vx = 0.45, vy = 0;
  return {
    frame(t, dt) {
      vy -= 1.6 * dt;
      x += vx * dt;
      y += vy * dt;
      if (y < 0) [y, vy] = [0, Math.abs(vy) * 0.92 + 0.05];
      if (x < 0 || x > 1) [vx, x] = [-vx, Math.min(1, Math.max(0, x))];
      c.fade(0.75);
      c.blob(x, y, 0.18);
      return c.colors();
    },
  };
}
