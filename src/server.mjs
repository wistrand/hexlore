// Touch-paint server for the Nanoleaf panels. No dependencies. Code lives in src/,
// runtime data in data/; the browser client (HTML, JS) is served from docs/.
// Usage: node src/server.mjs [port] [--sim]   (default 8321, listens on all interfaces)
//   --sim: no device; a simulated Elements layout whose tiles can be added and removed
//          from the page. Uses its own sim-*.json files so the real picture is untouched.
//   --tag X: separate data files (sim-X-*.json / X-*.json), for throwaway test instances.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Nanoleaf, predictTouchIds } from "./nanoleaf.mjs";
import { SimDevice } from "./sim.mjs";
import { effectContext as effectContextOf, loadEffects } from "./effects/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, "..", "docs");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
// Static client files: "/" and "/tiles" are pages, anything else is a file under docs/.
function serveStatic(url, res) {
  const name = url === "/" ? "index.html" : url === "/tiles" ? "tiles.html" : url.slice(1);
  const file = path.resolve(DOCS, name);
  if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
  return true;
}
const SIM = process.argv.includes("--sim");
const PORT = Number(process.argv.slice(2).find((a, i, all) => /^\d+$/.test(a) && all[i - 1] !== "--tag") ?? 8321);
// --tag X keeps a separate set of data files (e.g. for a throwaway test instance).
const TAG = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "";
// Runtime data (picture, scenes, touch map, simulator tiles) lives in data/, untracked.
const DATA = path.join(HERE, "..", "data");
fs.mkdirSync(DATA, { recursive: true });
const dataFile = (name) => path.join(DATA, `${SIM ? "sim-" : ""}${TAG ? `${TAG}-` : ""}${name}`);

// The controller, or with --sim the simulated one from src/sim.mjs (same methods, plus
// an editable tile set). token.json from src/pair.mjs holds { auth_token, host }; older
// files have no host. Each REST request times out after 5 s, which matters for
// refreshLayout(): it runs one request at a time, and the controller can stall while
// taking in new tiles.
const device = SIM ? new SimDevice({ tilesFile: dataFile("layout.json") })
  : Nanoleaf.fromFile(path.join(HERE, "..", "token.json"), { fallbackHost: "192.168.50.108" });

let layout = await device.layout();
let zones = layout.zones;
// The picture survives server restarts in data/state.json.
const STATE_FILE = dataFile("state.json");
let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch {}
let colors = new Map(zones.map((z) => [z.panelId, saved[z.panelId] ?? [0, 0, 0]]));
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(Object.fromEntries(colors)));
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
  }, 1000);
}
const prevEffect = await device.effect();

async function takeover() {
  await device.startStream();
  dirty = true;
  await refreshStatus();
}

// Touch: the device reports touches per tile, not per corner, under IDs that appear
// nowhere in the layout. data/touch-map.json maps each touch ID to its tile's corner
// zones; "Map touch" on the page fills it by lighting one tile at a time.
const TOUCH_MAP_FILE = dataFile("touch-map.json");
let touchMap = {};
try {
  touchMap = JSON.parse(fs.readFileSync(TOUCH_MAP_FILE, "utf8"));
} catch {}
const GLOW = [255, 205, 140];
const HOVER_MAX = 0.5; // glow at full hover strength; contact gives 1
const GLOW_HOLD_MS = 250; // packets come every ~140 ms while touched; fade after a gap
// Ripples: a ring leaves the touched tile's center at RIPPLE_SPEED (layout units/s,
// tile spacing is about 116) and fades with age.
const RIPPLE_SPEED = 350;
const RIPPLE_WIDTH = 45;
const RIPPLE_FADE_S = 0.9;
const RIPPLE_PEAK = 0.8;
const RIPPLE_MAX = 12;
// ripple includes the glow; paint fills the touched tile with the brush, no glow
const TOUCH_MODES = ["off", "glow", "ripple", "paint"];
let touchMode = "ripple";
// The page's current brush (color after brightness, black when erasing). Last page
// to send wins when several are open.
let brushColor = [255, 205, 140];
const glow = new Map(); // zone id -> { level 0..1, t: last refresh }
let ripples = []; // { ids: tile zone ids, x, y, t0 }
let overlay = new Map(); // zone id -> level 0..1: max of glow and ripples, what shown() uses
let mapping = null; // { tiles: [[zone ids]], i, map: { touchId: zone ids } }

// Tiles as lists of corner zone ids, top row first, left to right (the order mapping
// runs light them in). Grouping is the library's groupTiles(), done in layoutFrom().
function tiles() {
  const row = (t) => Math.round(t.cy / layout.sideLength);
  return [...layout.tiles].sort((a, b) => row(b) - row(a) || a.cx - b.cx).map((t) => t.corners.map((c) => c.id));
}

// Touch id candidates for a tile from its corner ids (library predictTouchIds(); model
// in agent_docs/architecture.md, "Tile and touch ids").
function predictTouch(ids) {
  const o = new Map(zones.map((z) => [z.panelId, z.o]));
  if (ids.some((id) => !o.has(id))) return [];
  return predictTouchIds(ids.map((id) => ({ id, o: o.get(id) })));
}
// Assign an unknown touch ID when exactly one tile predicts it. Returns whether it did.
function learnTouch(id) {
  const hits = tiles().filter((ids) => predictTouch(ids).includes(id));
  if (hits.length !== 1) return false;
  const tile = new Set(hits[0]);
  touchMap = Object.fromEntries(Object.entries(touchMap).filter(([, ids]) => !ids.some((z) => tile.has(z))));
  touchMap[id] = hits[0];
  fs.writeFileSync(TOUCH_MAP_FILE, JSON.stringify(touchMap));
  console.log(`touch map: id ${id} predicted from corner ids`);
  sendTouch();
  return true;
}

// Prefill the map without touching: the device lists every tile by touch ID
// (touchIds(), from the getHeatmap command). Each ID goes to the tile that predicts it;
// candidate sets that overlap are resolved by elimination. Runs at startup and after
// layout changes.
async function prefillTouchMap() {
  if (SIM) return;
  try {
    const ids = await device.touchIds();
    let open = tiles().map((t) => ({ t, p: new Set(predictTouch(t)) }));
    let todo = ids.slice(), added = 0;
    for (let progress = true; progress && todo.length; ) {
      progress = false;
      for (const id of todo) {
        const hits = open.filter(({ p }) => p.has(id));
        if (hits.length !== 1) continue;
        const tile = new Set(hits[0].t);
        const before = JSON.stringify(touchMap[id]);
        touchMap = Object.fromEntries(Object.entries(touchMap).filter(([k, zs]) => k === String(id) || !zs.some((z) => tile.has(z))));
        touchMap[id] = hits[0].t;
        if (JSON.stringify(touchMap[id]) !== before) added++;
        open = open.filter((o) => o !== hits[0]);
        todo = todo.filter((x) => x !== id);
        progress = true;
      }
    }
    if (added) fs.writeFileSync(TOUCH_MAP_FILE, JSON.stringify(touchMap));
    console.log(`touch map: ${ids.length} touch ids from getHeatmap, ${added} new or changed${todo.length ? `, ${todo.length} unresolved` : ""}`);
    sendTouch();
  } catch (e) {
    console.error(`touch map prefill failed: ${e.message}`);
  }
}

const touchMsg = () => {
  const mapped = new Set(Object.values(touchMap).flat().filter((id) => colors.has(id)));
  const info = {
    mode: touchMode, available: !SIM, tiles: tiles().length, mapped: Math.round(mapped.size / 6),
    mapping: mapping && { index: mapping.i, total: mapping.tiles.length, auto: mapping.auto },
  };
  return `event: touch\ndata: ${JSON.stringify(info)}\n\n`;
};
const sendTouch = () => { for (const res of clients) res.write(touchMsg()); };

// A run visits only tiles with no touch ID yet; corner and touch IDs belong to the
// tile hardware (inferred), so moving tiles keeps the map valid. With nothing new, a
// manual run remaps every tile. `trigger` is an unknown touch ID that started the run
// on its own: it must lift (type 3) before it can claim a tile, since its finger is
// usually not on the lit one, and with a single new tile it is assigned directly.
// No auto-start while tiles are still joining: a touched tile that is not in the
// layout yet would claim whichever tile is lit (seen 2026-10-31).
const LAYOUT_SETTLE_MS = 15_000;
let layoutChangedAt = 0;
let prefillTimer = null;
function startMapping(trigger) {
  const auto = trigger !== undefined;
  if (auto && Date.now() - layoutChangedAt < LAYOUT_SETTLE_MS) return;
  const known = new Set(Object.values(touchMap).flat());
  const missing = tiles().filter((ids) => !ids.some((id) => known.has(id)));
  const todo = missing.length || auto ? missing : tiles();
  if (!todo.length) return;
  mapping = {
    tiles: todo, i: 0, map: {}, auto,
    blocked: new Set(auto ? [trigger] : []),
  };
  if (auto && todo.length === 1) {
    mapping.map[trigger] = todo[0];
    return stopMapping();
  }
  console.log(`touch map: ${todo.length} tile(s) to map${auto ? `, started by unknown touch id ${trigger}` : ""}`);
  glow.clear();
  ripples = [];
  dirty = true;
  sendTouch();
}
// Keep earlier entries for tiles this run didn't reach.
function stopMapping() {
  if (!mapping) return;
  const done = new Set(Object.values(mapping.map).flat());
  const kept = Object.entries(touchMap).filter(([id, ids]) => !(id in mapping.map) && !ids.some((z) => done.has(z)));
  touchMap = { ...Object.fromEntries(kept), ...mapping.map };
  fs.writeFileSync(TOUCH_MAP_FILE, JSON.stringify(touchMap));
  console.log(`touch map: ${Object.keys(mapping.map).length} tiles mapped`);
  mapping = null;
  dirty = true;
  sendTouch();
}
// Down or hold from a touch ID not yet assigned in this run claims the lit tile. A
// finger still on the previous tile keeps sending its own ID, which is ignored. An ID
// mapped before this run may claim it too: its old entry was wrong, and stopMapping()
// drops it, so a bad mapping heals by touching the right tile in a later run.
function mapTouch(id, type) {
  if (type === 3) mapping.blocked.delete(id);
  if ((type !== 1 && type !== 2) || id in mapping.map || mapping.blocked.has(id)) return;
  mapping.map[id] = mapping.tiles[mapping.i++];
  if (mapping.i >= mapping.tiles.length) return stopMapping();
  dirty = true;
  sendTouch();
}

// One record from the device's touch stream (library touch()). Types: 0 hover, 1 down,
// 2 hold, 3 up, 4 swipe; strength 0..15.
function onTouch({ id, type, strength }) {
  const now = Date.now();
  if (mapping) return mapTouch(id, type);
  if (touchMode === "off") return;
  if (!(id in touchMap) && (type === 0 || type === 1 || type === 2) && !learnTouch(id) && type !== 0) {
    startMapping(id);
    if (mapping) return;
  }
  if (touchMode === "paint") {
    if (type === 1 || type === 2 || type === 4) paintTile(touchMap[id]);
    return;
  }
  if (touchMode === "ripple" && (type === 1 || type === 4)) spawnRipple(touchMap[id]);
  const level = type === 0 ? (HOVER_MAX * strength) / 15 : 1;
  for (const zid of touchMap[id] ?? []) {
    const g = glow.get(zid);
    if (type === 3) {
      if (g) g.t = 0;
    } else if (!g || level >= g.level) glow.set(zid, { level, t: now });
  }
}

// Hold repeats every ~140 ms; skip tiles that already have the brush color.
function paintTile(ids) {
  const todo = (ids ?? []).filter((id) => colors.has(id) && colors.get(id).some((v, k) => v !== brushColor[k]));
  if (todo.length) applySet(Object.fromEntries(todo.map((id) => [id, brushColor])));
}

function spawnRipple(ids) {
  const pts = (ids ?? []).map((id) => zones.find((z) => z.panelId === id)).filter(Boolean);
  // Down repeats while a finger settles (seen twice in 150 ms): one ripple per tile per 400 ms.
  if (!pts.length || ripples.some((r) => r.ids === ids && Date.now() - r.t0 < 400)) return;
  const x = pts.reduce((s, z) => s + z.x, 0) / pts.length, y = pts.reduce((s, z) => s + z.y, 0) / pts.length;
  ripples.push({ ids, x, y, t0: Date.now() });
  if (ripples.length > RIPPLE_MAX) ripples.shift();
}

// Advances glow and ripples and rebuilds the overlay. Returns whether anything is left to show.
function stepOverlay(now) {
  for (const [id, g] of glow) {
    if (now - g.t < GLOW_HOLD_MS) continue;
    g.level *= 0.8;
    if (g.level < 0.02) glow.delete(id);
  }
  ripples = ripples.filter((r) => now - r.t0 < RIPPLE_FADE_S * 4000);
  overlay = new Map([...glow].map(([id, g]) => [id, g.level]));
  for (const r of ripples) {
    const age = (now - r.t0) / 1000, radius = RIPPLE_SPEED * age, amp = RIPPLE_PEAK * Math.exp(-age / RIPPLE_FADE_S);
    for (const z of zones) {
      const d = Math.hypot(z.x - r.x, z.y - r.y) - radius;
      const level = amp * Math.exp(-((d / RIPPLE_WIDTH) ** 2));
      if (level > 0.02) overlay.set(z.panelId, Math.min(1, Math.max(overlay.get(z.panelId) ?? 0, level)));
    }
  }
  return overlay.size > 0;
}

// Effects: every src/effects/*.mjs except lib.mjs (helpers and the module contract).
// A running effect replaces the picture on the panels, which stays untouched
// underneath; the touch overlay still draws on top.
const effects = await loadEffects(path.join(HERE, "effects")); // key (file name) -> module
let running = null; // { key, inst, t0, last }
let effectColors = null; // zone id -> [r, g, b] while an effect runs
const effectContext = () => effectContextOf(zones, layout.sideLength);
const effectMsg = () => `event: effect\ndata: ${JSON.stringify({ active: running?.key ?? null })}\n\n`;
function setEffect(key) {
  running = null;
  effectColors = null;
  if (key && effects.has(key)) {
    try {
      running = { key, inst: effects.get(key).create(effectContext()), t0: Date.now(), last: Date.now() };
    } catch (e) {
      console.error(`effect ${key} failed to start: ${e.message}`);
    }
  }
  console.log(`effect: ${running?.key ?? "none"}`);
  dirty = true;
  for (const res of clients) res.write(effectMsg());
}
// Returns whether an effect produced a frame.
function stepEffect(now) {
  if (!running) return false;
  try {
    const out = running.inst.frame((now - running.t0) / 1000, (now - running.last) / 1000);
    running.last = now;
    effectColors = new Map(Object.entries(out ?? {}).map(([id, c]) => [Number(id), c.map((v) => Math.max(0, Math.min(255, v | 0)))]));
    return true;
  } catch (e) {
    console.error(`effect ${running.key} failed: ${e.message}`);
    setEffect(null);
    return false;
  }
}

// What the panel shows for a zone: the picture (or the running effect), raised toward
// GLOW where touched or a ripple passes. While mapping, only the tile waiting for a
// touch is lit.
function shown(id, c) {
  if (mapping) return mapping.tiles[mapping.i]?.includes(id) ? [255, 255, 255] : c.map((v) => v >> 3);
  const base = effectColors ? effectColors.get(id) ?? [0, 0, 0] : c;
  const g = overlay.get(id);
  return g ? base.map((v, k) => Math.max(v, Math.round(GLOW[k] * g))) : base;
}

let dirty = true;
// Send on change, and resend the full frame every second anyway: UDP has no delivery
// guarantee, so a lost packet would otherwise leave the panels stale until the next edit.
let ticks = 0;
// Overlay levels go to the page every other tick while they change, plus one empty set
// when the last one fades.
let glowShown = false, glowTick = 0, effectTick = 0;
setInterval(() => {
  const now = Date.now();
  const glowing = stepOverlay(now);
  if (glowing) dirty = true;
  // Effect frames: every tick to the panels, every third (about 8 fps) to the page.
  if (stepEffect(now)) {
    dirty = true;
    if (++effectTick % 3 === 0) {
      const msg = `event: effectFrame\ndata: ${JSON.stringify(Object.fromEntries(effectColors))}\n\n`;
      for (const res of clients) res.write(msg);
    }
  }
  if ((glowing || glowShown) && ++glowTick % 2 === 0) {
    const levels = Object.fromEntries([...overlay].map(([id, g]) => [id, Math.round(g * 100) / 100]));
    for (const res of clients) res.write(`event: glow\ndata: ${JSON.stringify(levels)}\n\n`);
    glowShown = glowing;
  }
  if (!dirty && ++ticks < 25) return;
  dirty = false;
  ticks = 0;
  device.send(new Map([...colors].map(([id, c]) => [id, shown(id, c)])));
}, 40);

// SSE clients get the full state on connect, then each change set, plus a named
// "layout" event when panels are added, removed or moved.
const clients = new Set();

// Reconfiguration: refetch the layout, keep colors of zones that survive, new zones
// start dark, and tell clients to re-render.
let refreshing = null;
function refreshLayout(reason) {
  refreshing ??= (async () => {
    try {
      const next = await device.layout();
      if (JSON.stringify(next) === JSON.stringify(layout)) return;
      layout = next;
      zones = layout.zones;
      colors = new Map(zones.map((z) => [z.panelId, colors.get(z.panelId) ?? [0, 0, 0]]));
      dirty = true;
      console.log(`layout changed (${reason}): ${zones.length} zones`);
      layoutChangedAt = Date.now();
      // Tiles join over several layout events; prefill once the layout has settled.
      clearTimeout(prefillTimer);
      prefillTimer = setTimeout(prefillTouchMap, LAYOUT_SETTLE_MS);
      if (mapping) stopMapping();
      if (running) setEffect(running.key); // restart on the new geometry
      for (const res of clients) res.write(`event: layout\ndata: {}\n\n`);
      sendTouch();
    } catch (e) {
      console.error(`layout refresh failed: ${e.message}`);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// Whether the panels actually show our picture: on, and the effect is extControl.
// Another app, an automation, the power button or a reboot can end streaming
// without telling us; clients get a "status" event so the page can say so.
let status = { on: true, effect: "*ExtControl*", streaming: true };
const statusMsg = () => `event: status\ndata: ${JSON.stringify(status)}\n\n`;
async function refreshStatus() {
  try {
    const on = await device.isOn();
    const effect = await device.effect();
    const brightness = await device.brightness();
    const next = { on, effect, brightness, streaming: on && effect === "*ExtControl*" };
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    if (next.streaming && !status.streaming) dirty = true;
    status = next;
    console.log(`device status: ${JSON.stringify(status)}`);
    for (const res of clients) res.write(statusMsg());
  } catch (e) {
    console.error(`status refresh failed: ${e.message}`);
  }
}
setInterval(refreshStatus, 5000);

// Device events (1 state, 2 layout, 3 effects) and the raw touch stream, both from the
// library with reconnects; the polls cover missed events.
if (!SIM) {
  device.events(({ id }) => (id === 2 ? refreshLayout("device event") : refreshStatus()),
    { onError: (e) => console.error(`event stream: ${e.message}`) });
  device.touch(onTouch, { onError: (e) => console.error(`touch stream: ${e.message}`) });
  setInterval(() => refreshLayout("poll"), 30_000);
}
function broadcast(set) {
  const msg = `data: ${JSON.stringify(set)}\n\n`;
  for (const res of clients) res.write(msg);
}

function applySet(set) {
  const applied = {};
  for (const [id, c] of Object.entries(set)) {
    const key = Number(id);
    if (!colors.has(key) || !Array.isArray(c) || c.length !== 3) continue;
    const rgb = c.map((v) => Math.max(0, Math.min(255, v | 0)));
    colors.set(key, rgb);
    applied[key] = rgb;
  }
  if (Object.keys(applied).length) {
    dirty = true;
    persist();
    broadcast(applied);
  }
}

// Saved scenes: { name: { panelId: [r, g, b] } } in data/scenes.json.
const SCENES = dataFile("scenes.json");
function loadScenes() {
  try {
    return JSON.parse(fs.readFileSync(SCENES, "utf8"));
  } catch {
    return {};
  }
}
function saveScenes(scenes) {
  const tmp = SCENES + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(scenes, null, 1));
  fs.renameSync(tmp, SCENES);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && !req.url.startsWith("/api/") && serveStatic(req.url.split("?")[0], res)) {
      // served from docs/
    } else if (req.method === "GET" && req.url === "/api/tiles") {
      // Per tile: center, corners by rising o, mapped touch id and the predicted one(s).
      const byId = new Map(zones.map((z) => [z.panelId, z]));
      const mapped = Object.entries(touchMap).map(([t, ids]) => [new Set(ids), Number(t)]);
      const out = tiles().map((ids) => {
        const zs = ids.map((id) => byId.get(id)).sort((a, b) => a.o - b.o);
        return {
          x: Math.round(zs.reduce((s, z) => s + z.x, 0) / zs.length),
          y: Math.round(zs.reduce((s, z) => s + z.y, 0) / zs.length),
          corners: zs.map((z) => ({ id: z.panelId, o: z.o })),
          touch: mapped.find(([set]) => ids.some((id) => set.has(id)))?.[1] ?? null,
          predicted: predictTouch(ids),
        };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sideLength: layout.sideLength, sim: SIM, tiles: out, controller: layout.controller,
      }));
    } else if (req.method === "GET" && req.url === "/api/layout") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sideLength: layout.sideLength, zones, controller: layout.controller ?? undefined, sim: SIM, tiles: SIM ? device.tiles : undefined,
      }));
    } else if (SIM && req.method === "POST" && req.url === "/api/sim/tiles") {
      // Replace the simulated tile set: [[q, r], ...] (validated by SimDevice).
      device.setTiles((await readJson(req)).tiles);
      await refreshLayout("sim edit");
      persist();
      res.writeHead(204).end();
    } else if (req.method === "GET" && req.url === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(Object.fromEntries(colors))}\n\n`);
      res.write(statusMsg());
      res.write(touchMsg());
      res.write(effectMsg());
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (req.method === "POST" && req.url === "/api/paint") {
      applySet(await readJson(req));
      res.writeHead(204).end();
    } else if (req.method === "POST" && req.url === "/api/fill") {
      const { color } = await readJson(req);
      applySet(Object.fromEntries([...colors.keys()].map((id) => [id, color])));
      res.writeHead(204).end();
    } else if (req.url === "/api/scenes" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(loadScenes()));
    } else if (req.url.startsWith("/api/scenes/") && (req.method === "PUT" || req.method === "DELETE")) {
      const name = decodeURIComponent(req.url.slice("/api/scenes/".length)).slice(0, 80);
      if (!name) return res.writeHead(400).end();
      const scenes = loadScenes();
      if (req.method === "PUT") scenes[name] = await readJson(req);
      else delete scenes[name];
      saveScenes(scenes);
      res.writeHead(204).end();
    } else if (req.url === "/api/brightness" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: await device.brightness() }));
    } else if (req.url === "/api/brightness" && req.method === "POST") {
      const { value } = await readJson(req);
      await device.setBrightness(value | 0);
      res.writeHead(204).end();
    } else if (req.method === "GET" && req.url === "/api/effects") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        active: running?.key ?? null,
        effects: [...effects].map(([key, m]) => ({ key, name: m.meta?.name ?? key, description: m.meta?.description ?? "" })),
      }));
    } else if (req.method === "POST" && req.url === "/api/effect") {
      // { key: "rain" } starts an effect, { key: null } returns to the picture.
      const { key } = await readJson(req);
      if (key && !effects.has(key)) return res.writeHead(404).end();
      setEffect(key ?? null);
      res.writeHead(204).end();
    } else if (req.method === "POST" && req.url === "/api/touch") {
      // { mode: "off" | "glow" | "ripple" | "paint" } sets what touches do; { brush:
      // [r, g, b] } is the color paint uses; { map: bool } starts or ends a mapping run.
      const body = await readJson(req);
      if (Array.isArray(body.brush) && body.brush.length === 3) {
        brushColor = body.brush.map((v) => Math.max(0, Math.min(255, v | 0)));
      }
      if (TOUCH_MODES.includes(body.mode)) {
        touchMode = body.mode;
        glow.clear();
        ripples = [];
      }
      if (body.map === true && !SIM) startMapping();
      else if (body.map === false) stopMapping();
      sendTouch();
      res.writeHead(204).end();
    } else if (req.method === "POST" && req.url === "/api/takeover") {
      await takeover();
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    console.error(e);
    if (res.headersSent) res.end();
    else res.writeHead(500).end(String(e.message ?? e));
  }
});

server.on("error", (e) => {
  console.error(`listen failed: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", async () => {
  await takeover();
  console.log(`hexlore touch paint on http://0.0.0.0:${PORT}  (${zones.length} zones)${SIM ? "  [simulator]" : ""}`);
  await prefillTouchMap();
});

async function shutdown() {
  console.log("\nshutting down");
  if (typeof prevEffect === "string" && !prevEffect.startsWith("*")) {
    try {
      await device.selectEffect(prevEffect);
      console.log(`restored effect: ${prevEffect}`);
    } catch (e) {
      console.error(e.message);
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
