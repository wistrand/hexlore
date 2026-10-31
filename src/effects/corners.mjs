// Shows the tile structure. Each tile in turn lights one corner
// at a time (two laps) and then all six; then every tile chases its corners in sync.
// Loops.

export const meta = { name: "Corner chase", description: "One corner at a time, tile by tile, then all tiles in sync" };

const ON = [255, 200, 120];

export function create({ tiles }) {
  // Steps of [lit zone ids, seconds].
  const steps = [[[], 1.0]];
  for (const tile of tiles) {
    const ids = tile.corners.map((c) => c.id);
    for (let lap = 0; lap < 2; lap++) for (const id of ids) steps.push([[id], 0.15]);
    steps.push([ids, 0.6], [[], 0.3]);
  }
  for (let k = 0; k < 36; k++) steps.push([tiles.map((tile) => tile.corners[k % tile.corners.length].id), 0.12]);
  steps.push([[], 0.5]);
  const total = steps.reduce((s, [, d]) => s + d, 0);
  return {
    frame(t) {
      let at = t % total, i = 0;
      while (at >= steps[i][1]) at -= steps[i++][1];
      return Object.fromEntries(steps[i][0].map((id) => [id, ON]));
    },
  };
}
