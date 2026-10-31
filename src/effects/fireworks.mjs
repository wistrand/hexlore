// Ported from the former pixel_show.py: rockets rise, slow down and burst into falling sparks.

import { Canvas, rand } from "./lib.mjs";

export const meta = { name: "Fireworks", description: "Rockets rise and burst into falling sparks" };

export function create({ zones }) {
  const c = new Canvas(zones);
  let rockets = [], sparks = []; // rockets [x, y, vy]; sparks [x, y, vx, vy, life]
  return {
    frame(t, dt) {
      if (Math.random() < 1.2 * dt) rockets.push([rand(0.15, 0.85), 0, rand(0.9, 1.3)]);
      c.fade(0.82);
      rockets = rockets.filter((r) => {
        r[1] += r[2] * dt;
        r[2] -= 0.9 * dt;
        c.blob(r[0], r[1], 0.08, 0.6);
        if (r[2] >= 0.25) return true;
        for (let a = 0; a < 10; a++) {
          const ang = (a * Math.PI) / 5 + rand(-0.2, 0.2), sp = rand(0.25, 0.45);
          sparks.push([r[0], r[1], sp * Math.cos(ang), sp * Math.sin(ang), 1]);
        }
        return false;
      });
      sparks = sparks.filter((s) => {
        s[0] += s[2] * dt;
        s[1] += s[3] * dt;
        s[3] -= 0.5 * dt;
        s[4] -= 0.9 * dt;
        if (s[4] <= 0) return false;
        c.blob(s[0], s[1], 0.1, s[4]);
        return true;
      });
      return c.colors();
    },
  };
}
