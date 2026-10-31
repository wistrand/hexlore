// Ported from the former stream_demo.py: a warm sine sweep across the wall, then ripples from the
// center, alternating every 10 s.

export const meta = { name: "Sweep and ripple", description: "Sine sweep left to right, then ripples from the center" };

export function create({ zones }) {
  const xs = zones.map((z) => z.x), ys = zones.map((z) => z.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return {
    frame(t) {
      const ripple = Math.floor(t / 10) % 2 === 1;
      const out = {};
      for (const z of zones) {
        const v = ripple
          ? 0.5 + 0.5 * Math.sin(Math.hypot(z.x - cx, z.y - cy) / 25 - t * 5)
          : 0.5 + 0.5 * Math.sin(z.x / 40 - t * 4);
        const lvl = Math.round(255 * v * v);
        out[z.id] = [lvl, Math.round(lvl * 0.8), Math.round(lvl * 0.5)];
      }
      return out;
    },
  };
}
