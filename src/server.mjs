// Touch-paint server for the Nanoleaf panels. No dependencies. Code lives in src/,
// runtime data in data/; the browser client (HTML, JS) is served from docs/.
// Usage: node src/server.mjs [port] [--sim]   (default 8321, listens on all interfaces)
//   --sim: no device; a simulated Elements layout whose tiles can be added and removed
//          from the page. Uses its own sim-*.json files so the real picture is untouched.
//   --tag X: separate data files (sim-X-*.json / X-*.json), for throwaway test instances.
import http from "node:http";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const UDP_PORT = 60222;
const SIM = process.argv.includes("--sim");
const PORT = Number(process.argv.slice(2).find((a, i, all) => /^\d+$/.test(a) && all[i - 1] !== "--tag") ?? 8321);
// token.json from src/pair.mjs: { auth_token, host }. Older files have no host.
const CONFIG = SIM ? {} : JSON.parse(fs.readFileSync(path.join(HERE, "..", "token.json"), "utf8"));
const HOST = CONFIG.host ?? "192.168.50.108";
const TOKEN = CONFIG.auth_token ?? "";
const BASE = `http://${HOST}:16021/api/v1/${TOKEN}`;
// --tag X keeps a separate set of data files (e.g. for a throwaway test instance).
const TAG = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "";
// Runtime data (picture, scenes, touch map, simulator tiles) lives in data/, untracked.
const DATA = path.join(HERE, "..", "data");
fs.mkdirSync(DATA, { recursive: true });
const dataFile = (name) => path.join(DATA, `${SIM ? "sim-" : ""}${TAG ? `${TAG}-` : ""}${name}`);

// Simulated device: answers the same REST calls the server makes. Tiles sit on a hex
// grid in axial coordinates (q, r); geometry matches the real unit: sideLength 67,
// vertices at 0, 60, ... degrees, zones at 50/67 of the side from the tile center,
// `o` = direction from center to zone. Zone ids are derived from (q, r, corner) so
// colors stay attached to a tile when other tiles change.
const SIM_SIDE = 67;
const SIM_TILES_FILE = dataFile("layout.json");
const FLOWER = [[0, 0], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]];
let simTiles = FLOWER;
if (SIM) {
  try {
    simTiles = JSON.parse(fs.readFileSync(SIM_TILES_FILE, "utf8"));
  } catch {}
}
const sim = { on: true, brightness: 100 };
const simId = (q, r, k) => ((q + 32) * 64 + (r + 32)) * 8 + k + 1; // fits u16 for |q|,|r| < 32
function simLayout() {
  const positionData = [];
  for (const [q, r] of simTiles) {
    const cx = 400 + 1.5 * SIM_SIDE * q;
    const cy = 400 + Math.sqrt(3) * SIM_SIDE * (r + q / 2);
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      positionData.push({
        panelId: simId(q, r, k),
        x: Math.round(cx + (50 / 67) * SIM_SIDE * Math.cos(a)),
        y: Math.round(cy + (50 / 67) * SIM_SIDE * Math.sin(a)),
        o: k * 60,
        shapeType: 15,
        tile: `${q},${r}`,
      });
    }
  }
  return { numPanels: positionData.length, sideLength: SIM_SIDE, positionData };
}
function simApi(method, p, body) {
  if (p === "/panelLayout/layout") return simLayout();
  if (p === "/effects/select") return "*ExtControl*";
  if (p === "/state/on") return { value: sim.on };
  if (p === "/state/brightness") return { value: sim.brightness, max: 100, min: 0 };
  if (method === "PUT" && p === "/state") {
    if (body.on) sim.on = body.on.value;
    if (body.brightness) sim.brightness = body.brightness.value;
  }
  return null;
}

async function api(method, p, body) {
  if (SIM) return simApi(method, p, body);
  // Timeout: refreshLayout() runs one request at a time, so a request the controller
  // never answers (it can stall while taking in new tiles) would block every later
  // refresh until Node's 5-minute default.
  const res = await fetch(BASE + p, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let layout = await api("GET", "/panelLayout/layout");
let zones = layout.positionData.filter((p) => p.shapeType !== 12);
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
const prevEffect = await api("GET", "/effects/select");

async function takeover() {
  await api("PUT", "/state", { on: { value: true } });
  await api("PUT", "/effects", {
    write: { command: "display", animType: "extControl", extControlVersion: "v2" },
  });
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

// Tiles as lists of corner zone ids, top row first, left to right. Same grouping as
// hexGroups() in docs/index.html: zones sit at ZONE_R x sideLength from the tile center,
// in direction `o` mod 360.
const ZONE_R = 50 / 67;
function tiles() {
  const side = layout.sideLength, groups = [];
  for (const z of zones) {
    const a = ((z.o % 360) * Math.PI) / 180;
    const ex = z.x - ZONE_R * side * Math.cos(a), ey = z.y - ZONE_R * side * Math.sin(a);
    let g = groups.find((g) => Math.hypot(g.ex - ex, g.ey - ey) < side * 0.3);
    if (!g) groups.push((g = { ex, ey, ids: [] }));
    g.ids.push(z.panelId);
  }
  const row = (g) => Math.round(g.ey / side);
  return groups.sort((a, b) => row(b) - row(a) || a.ex - b.ex).map((g) => g.ids);
}

// Touch ID from corner IDs, no touching needed (model fitted to 20 tiles, matches all;
// see agent_docs/architecture.md, "Tile and touch ids"). A tile's 6 corner IDs in
// order of rising `o`, then its touch ID, are id(j) = K ^ L(j) for 7 consecutive j,
// where L is the linear part of a reflected CRC-16 with polynomial 0x8005 (the
// CRC-16/ARC family) over a little-endian counter: L(2k) = L(k) / x in the
// bit-reflected domain. L(1) was measured; the rest follows. Neighbor XORs are then
// L(j ^ (j + 1)) = L(2^n - 1), which reveals j mod 8 and so the step from the last
// corner to the touch ID, except when j + 6 is a multiple of 8: then the carry length
// is unknown and every L(2^n - 1), n >= 4, is a candidate (n = 4 half the time).
const refl16 = (v) => { let r = 0; for (let i = 0; i < 16; i++) r = (r << 1) | ((v >> i) & 1); return r; };
const divx = (y) => (y & 1 ? y ^ 0x18005 : y) >>> 1;
const LB = []; // LB[k] = L(2^k)
for (let y = refl16(0x90c1), k = 0; k < 16; k++, y = divx(y)) LB.push(refl16(y));
const Lf = (j) => { let r = 0; for (let k = 0; k < 16; k++) if (j >> k & 1) r ^= LB[k]; return r; };
const HIGH = Array.from({ length: 13 }, (_, i) => Lf((1 << (i + 4)) - 1));
function predictTouch(ids) {
  const o = new Map(zones.map((z) => [z.panelId, z.o]));
  if (ids.length !== 6 || ids.some((id) => !o.has(id))) return [];
  const z = [...ids].sort((a, b) => o.get(a) - o.get(b));
  const d = z.slice(1).map((id, i) => z[i] ^ id);
  // Step i -> i + 1 is L((j + i) ^ (j + i + 1)); at a multiple of 8 any HIGH value fits.
  const fits = (jl, i, s) => ((jl + i) % 8 === 7 ? HIGH.includes(s) : s === Lf((jl + i) ^ (jl + i + 1)));
  const out = [];
  for (let jl = 0; jl < 8; jl++) {
    if (!d.every((s, i) => fits(jl, i, s))) continue;
    const steps = (jl + 5) % 8 === 7 ? HIGH : [Lf((jl + 5) ^ (jl + 6))];
    out.push(...steps.map((s) => z[5] ^ s));
  }
  return out;
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

// Prefill the map without touching: the getHeatmap device command lists every tile
// by touch ID (base64 TLV: type 1 count, type 2 records of id u16 + 5 bytes). Each ID
// goes to the tile that predicts it; candidate sets that overlap are resolved by
// elimination. Runs at startup and after layout changes.
async function prefillTouchMap() {
  if (SIM) return;
  try {
    const { heatmapData } = await api("PUT", "/effects", { write: { command: "getHeatmap" } });
    const b = Buffer.from(heatmapData, "base64");
    let recs = Buffer.alloc(0);
    for (let i = 0; i + 3 <= b.length; ) {
      const type = b[i], len = b.readUInt16BE(i + 1);
      if (type === 2) recs = b.subarray(i + 3, i + 3 + len);
      i += 3 + len;
    }
    const ids = [];
    for (let o = 0; o + 7 <= recs.length; o += 7) ids.push(recs.readUInt16BE(o));
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

// UDP touch packet: n u16, then per tile id u16, type<<4 | strength u8, swipedFrom u16.
// Types: 0 hover, 1 down, 2 hold, 3 up, 4 swipe. Strength 0..15.
function onTouch(buf) {
  if (buf.length < 2) return;
  const n = buf.readUInt16BE(0), now = Date.now();
  for (let i = 0, o = 2; i < n && o + 5 <= buf.length; i++, o += 5) {
    const id = buf.readUInt16BE(o), type = buf[o + 2] >> 4, strength = buf[o + 2] & 15;
    if (mapping) {
      mapTouch(id, type);
      continue;
    }
    if (touchMode === "off") continue;
    if (!(id in touchMap) && (type === 0 || type === 1 || type === 2) && !learnTouch(id) && type !== 0) {
      startMapping(id);
      if (mapping) continue;
    }
    if (touchMode === "paint") {
      if (type === 1 || type === 2 || type === 4) paintTile(touchMap[id]);
      continue;
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

// v2 frame: nPanels u16, then per panel id u16, r g b w u8, transition u16 (100 ms units)
function frame() {
  const buf = Buffer.alloc(2 + colors.size * 8);
  buf.writeUInt16BE(colors.size, 0);
  let o = 2;
  for (const [id, c] of colors) {
    const [r, g, b] = shown(id, c);
    buf.writeUInt16BE(id, o);
    buf.writeUInt8(r, o + 2);
    buf.writeUInt8(g, o + 3);
    buf.writeUInt8(b, o + 4);
    buf.writeUInt8(0, o + 5);
    buf.writeUInt16BE(0, o + 6);
    o += 8;
  }
  return buf;
}

const udp = dgram.createSocket("udp4");
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
  if (!SIM) udp.send(frame(), UDP_PORT, HOST);
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
      const next = await api("GET", "/panelLayout/layout");
      if (JSON.stringify(next) === JSON.stringify(layout)) return;
      layout = next;
      zones = layout.positionData.filter((p) => p.shapeType !== 12);
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
    const on = (await api("GET", "/state/on")).value;
    const effect = await api("GET", "/effects/select");
    const brightness = (await api("GET", "/state/brightness")).value;
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

// Device event stream: id 1 = state (on/off, brightness), 2 = layout (panels added,
// removed, orientation), 3 = effects. Reconnects on drop; polls cover missed events.
async function watchLayoutEvents() {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/events?id=1,2,3`);
      if (!res.ok) throw new Error(`events: ${res.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const msg = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!/^data:/m.test(msg)) continue;
          const kind = Number(/^id:\s*(\d+)/m.exec(msg)?.[1]);
          if (kind === 2) refreshLayout("device event");
          else refreshStatus();
        }
      }
    } catch (e) {
      console.error(`event stream: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
// Touch stream: the device sends per-tile touch packets over UDP to the port named in
// the TouchEventsPort header, for as long as this id=4 (gesture) stream stays open.
// Gestures themselves carry no tile (panelId -1) and are not used.
const touchUdp = dgram.createSocket("udp4");
touchUdp.on("message", onTouch);
async function watchTouch() {
  await new Promise((r) => touchUdp.bind(0, r));
  const port = touchUdp.address().port;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/events?id=4`, { headers: { TouchEventsPort: String(port) } });
      if (!res.ok) throw new Error(`touch events: ${res.status}`);
      for await (const _ of res.body);
    } catch (e) {
      console.error(`touch stream: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
if (!SIM) {
  watchLayoutEvents();
  watchTouch();
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
        sideLength: layout.sideLength, sim: SIM, tiles: out,
        controller: layout.positionData.find((p) => p.shapeType === 12) ?? null,
      }));
    } else if (req.method === "GET" && req.url === "/api/layout") {
      res.writeHead(200, { "content-type": "application/json" });
      const controller = layout.positionData.find((p) => p.shapeType === 12);
      res.end(JSON.stringify({ sideLength: layout.sideLength, zones, controller, sim: SIM, tiles: SIM ? simTiles : undefined }));
    } else if (SIM && req.method === "POST" && req.url === "/api/sim/tiles") {
      // Replace the simulated tile set: [[q, r], ...], deduplicated and range-checked.
      const { tiles } = await readJson(req);
      const seen = new Set();
      simTiles = (Array.isArray(tiles) ? tiles : [])
        .map(([q, r]) => [q | 0, r | 0])
        .filter(([q, r]) => Math.abs(q) < 32 && Math.abs(r) < 32 && !seen.has(`${q},${r}`) && seen.add(`${q},${r}`));
      fs.writeFileSync(SIM_TILES_FILE, JSON.stringify(simTiles));
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
      res.end(JSON.stringify(await api("GET", "/state/brightness")));
    } else if (req.url === "/api/brightness" && req.method === "POST") {
      const { value } = await readJson(req);
      await api("PUT", "/state", { brightness: { value: Math.max(0, Math.min(100, value | 0)) } });
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
      await api("PUT", "/effects", { select: prevEffect });
      console.log(`restored effect: ${prevEffect}`);
    } catch (e) {
      console.error(e.message);
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
