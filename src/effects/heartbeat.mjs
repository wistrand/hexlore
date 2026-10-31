// A double heartbeat pulsing from the center.

import { Canvas } from "./lib.mjs";

export const meta = { name: "Heartbeat", description: "A double pulse from the center, once a second" };

export function create({ zones }) {
  const c = new Canvas(zones);
  return {
    frame(t) {
      const ph = t % 1.1;
      const beat = Math.exp(-(((ph - 0.1) / 0.06) ** 2)) + 0.7 * Math.exp(-(((ph - 0.35) / 0.07) ** 2));
      for (const [id, [x, y]] of c.pos) c.buf.set(id, 0.08 + beat * Math.max(0, 1 - Math.hypot(x - 0.5, y - 0.5) * 1.4));
      return c.colors();
    },
  };
}
