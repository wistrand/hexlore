// Simulated Elements controller for `node src/server.mjs --sim`: the subset of the
// Nanoleaf class (src/nanoleaf.mjs) that the server uses, with an editable tile set.
//
// Tiles sit on a hex grid in axial coordinates [q, r]: flat-top hexes, neighbors at
// 30 + 60k degrees, center spacing sqrt(3) x side. Geometry matches the real unit:
// sideLength 67, zones at 50/67 of the side from the tile center, `o` = direction from
// center to zone. Zone ids are derived from (q, r, corner), so colors stay attached to
// a tile when other tiles change. There is no touch stream and nothing is sent.
import fs from "node:fs";
import { layoutFrom } from "./nanoleaf.mjs";

const SIDE = 67;
const FLOWER = [[0, 0], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]];
const zoneId = (q, r, k) => ((q + 32) * 64 + (r + 32)) * 8 + k + 1; // fits u16 for |q|,|r| < 32

// tilesFile: where the tile set is kept between runs (created on the first edit).
export class SimDevice {
  constructor({ tilesFile }) {
    this.tilesFile = tilesFile;
    this.tiles = FLOWER;
    try {
      this.tiles = JSON.parse(fs.readFileSync(tilesFile, "utf8"));
    } catch {}
    this.state = { on: true, brightness: 100 };
  }

  // Replaces the tile set ([[q, r], ...], deduplicated, |q|,|r| < 32) and saves it.
  setTiles(tiles) {
    const seen = new Set();
    this.tiles = (Array.isArray(tiles) ? tiles : [])
      .map(([q, r]) => [q | 0, r | 0])
      .filter(([q, r]) => Math.abs(q) < 32 && Math.abs(r) < 32 && !seen.has(`${q},${r}`) && seen.add(`${q},${r}`));
    fs.writeFileSync(this.tilesFile, JSON.stringify(this.tiles));
  }

  // Raw /panelLayout/layout reply for the current tiles.
  rawLayout() {
    const positionData = [];
    for (const [q, r] of this.tiles) {
      const cx = 400 + 1.5 * SIDE * q, cy = 400 + Math.sqrt(3) * SIDE * (r + q / 2);
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        positionData.push({
          panelId: zoneId(q, r, k),
          x: Math.round(cx + (50 / 67) * SIDE * Math.cos(a)),
          y: Math.round(cy + (50 / 67) * SIDE * Math.sin(a)),
          o: k * 60,
          shapeType: 15,
          tile: `${q},${r}`,
        });
      }
    }
    return { numPanels: positionData.length, sideLength: SIDE, positionData };
  }

  async layout() { return layoutFrom(this.rawLayout()); }
  async isOn() { return this.state.on; }
  async setOn(on) { this.state.on = !!on; }
  async brightness() { return this.state.brightness; }
  async setBrightness(v) { this.state.brightness = Math.max(0, Math.min(100, Math.round(v))); }
  async effect() { return "*ExtControl*"; }
  async selectEffect() {}
  async startStream() {}
  async touchIds() { return []; }
  send() {}
  events() { return () => {}; }
  touch() { return () => {}; }
  close() {}
}
