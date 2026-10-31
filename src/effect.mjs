// Run one effect from src/effects/ on the panels without the paint server.
// Usage: node src/effect.mjs <effect> [seconds] [--keep]
//        node src/effect.mjs --list
//   seconds: stop after this long (default: run until Ctrl-C)
//   --keep:  leave the last frame up on exit instead of restoring the previous effect
// The previous effect is restored on exit unless it was a *...* pseudo-effect (such
// as *ExtControl* from the paint server). Stop the paint server first: both stream
// to the same panels and would overwrite each other.
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effectContext, loadEffects } from "./effects/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UDP_PORT = 60222;
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
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "token.json"), "utf8"));
const HOST = CONFIG.host ?? "192.168.50.108";
const TOKEN = CONFIG.auth_token;
const BASE = `http://${HOST}:16021/api/v1/${TOKEN}`;
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// v2 frame: nPanels u16, then per panel id u16, r g b w u8, transition u16 (100 ms units)
function frame(ids, colors) {
  const buf = Buffer.alloc(2 + ids.length * 8);
  buf.writeUInt16BE(ids.length, 0);
  ids.forEach((id, i) => {
    const [r, g, b] = (colors[id] ?? [0, 0, 0]).map((v) => Math.max(0, Math.min(255, v | 0)));
    buf.writeUInt16BE(id, 2 + i * 8);
    buf.writeUInt8(r, 4 + i * 8);
    buf.writeUInt8(g, 5 + i * 8);
    buf.writeUInt8(b, 6 + i * 8);
  });
  return buf;
}

const prevEffect = await api("GET", "/effects/select");
const layout = await api("GET", "/panelLayout/layout");
const zones = layout.positionData.filter((p) => p.shapeType !== 12);
const ids = zones.map((z) => z.panelId);
const inst = effects.get(key).create(effectContext(zones, layout.sideLength));

await api("PUT", "/state", { on: { value: true } });
await api("PUT", "/effects", { write: { command: "display", animType: "extControl", extControlVersion: "v2" } });
const udp = dgram.createSocket("udp4");
const seconds = secondsArg ? Number(secondsArg) : Infinity;
console.log(`${effects.get(key).meta?.name ?? key} on ${ids.length} zones${Number.isFinite(seconds) ? ` for ${seconds} s` : ""}; Ctrl-C to stop`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (!keep && typeof prevEffect === "string" && !prevEffect.startsWith("*")) {
    try {
      await api("PUT", "/effects", { select: prevEffect });
      console.log(`restored effect: ${prevEffect}`);
    } catch (e) {
      console.error(`restore failed: ${e.message}`);
    }
  }
  udp.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const t0 = Date.now();
let last = t0;
const timer = setInterval(() => {
  const now = Date.now(), t = (now - t0) / 1000;
  if (t >= seconds) return stop();
  udp.send(frame(ids, inst.frame(t, (now - last) / 1000)), UDP_PORT, HOST);
  last = now;
}, 1000 / FPS);
