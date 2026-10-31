// The five pixel scenes in turn, 10 s each.

import * as ball from "./ball.mjs";
import * as pinwheels from "./pinwheels.mjs";
import * as fireworks from "./fireworks.mjs";
import * as rain from "./rain.mjs";
import * as heartbeat from "./heartbeat.mjs";

export const meta = { name: "Pixel show", description: "Ball, pinwheels, fireworks, rain and heartbeat, 10 s each" };

const SCENES = [ball, pinwheels, fireworks, rain, heartbeat];
const PER_SCENE = 10;

export function create(ctx) {
  let index = -1, scene = null;
  return {
    frame(t, dt) {
      const i = Math.floor(t / PER_SCENE) % SCENES.length;
      if (i !== index) [index, scene] = [i, SCENES[i].create(ctx)];
      return scene.frame(t % PER_SCENE, dt);
    },
  };
}
