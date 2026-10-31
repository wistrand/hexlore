// Run one effect from src/effects/ on the panels without the paint server.
// Usage: node src/effect.mjs <effect> [seconds] [--keep]
//        node src/effect.mjs --list
//   seconds: stop after this long (default: run until Ctrl-C)
//   --keep:  leave the last frame up on exit instead of restoring the previous effect
// The previous effect is restored on exit unless it was a *...* pseudo-effect (such
// as *ExtControl* from the paint server). Stop the paint server first: both stream
// to the same panels and would overwrite each other.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Nanoleaf } from "./nanoleaf.mjs";
import { effectContext, loadEffects } from "./effects/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 25;

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const [key, secondsArg] = args.filter((a) => !a.startsWith("--"));
const effects = await loadEffects(path.join(HERE, "effects"));

if (args.includes("--list") || !key) {
  console.log("usage: node src/effect.mjs <effect> [seconds] [--keep]\n");
  for (const [k, m] of effects) console.log(`  ${k.padEnd(12)} ${m.meta?.name ?? k}: ${m.meta?.description ?? ""}`);
  process.exit(key || args.includes("--list") ? 0 : 1);
}
if (!effects.has(key)) {
  console.error(`unknown effect "${key}"; try --list`);
  process.exit(1);
}

// token.json from src/pair.mjs: { auth_token, host }. Older files have no host.
const nl = Nanoleaf.fromFile(path.join(HERE, "..", "token.json"), { fallbackHost: "192.168.50.108" });
const prevEffect = await nl.effect();
const { zones, sideLength } = await nl.layout();
const ids = zones.map((z) => z.panelId);
const inst = effects.get(key).create(effectContext(zones, sideLength));
await nl.startStream();
const seconds = secondsArg ? Number(secondsArg) : Infinity;
console.log(`${effects.get(key).meta?.name ?? key} on ${ids.length} zones${Number.isFinite(seconds) ? ` for ${seconds} s` : ""}; Ctrl-C to stop`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (!keep && typeof prevEffect === "string" && !prevEffect.startsWith("*")) {
    try {
      await nl.selectEffect(prevEffect);
      console.log(`restored effect: ${prevEffect}`);
    } catch (e) {
      console.error(`restore failed: ${e.message}`);
    }
  }
  nl.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const t0 = Date.now();
let last = t0;
const timer = setInterval(() => {
  const now = Date.now(), t = (now - t0) / 1000;
  if (t >= seconds) return stop();
  // Every zone in every frame: zones the effect leaves out go dark.
  const out = inst.frame(t, (now - last) / 1000);
  nl.send(new Map(ids.map((id) => [id, out[id] ?? [0, 0, 0]])));
  last = now;
}, 1000 / FPS);
