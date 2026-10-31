// nanoleaf.mjs: local control of Nanoleaf Elements (and related) controllers over the
// LAN. Self-contained: Node 18+ built-ins only, no knowledge of the hexlore app.
//
//   import { Nanoleaf, discover, pair } from "./nanoleaf.mjs";
//
//   const [dev] = await discover();                  // [{ ip, name, id, model }]
//   const token = await pair(dev.ip);                // user holds the power button
//   const nl = new Nanoleaf({ host: dev.ip, token }); // or Nanoleaf.fromFile("token.json")
//
//   const { zones, tiles } = await nl.layout();
//   await nl.startStream();
//   nl.send({ [zones[0].panelId]: [255, 180, 90] });  // zone id -> [r, g, b]
//   const stop = nl.touch((t) => console.log(t));     // { id, type, strength, from }
//   ...
//   stop(); nl.close();
//
// Protocol notes: REST and SSE on port 16021, extControl v2 frames over UDP to port
// 60222, raw touch data over UDP to a port the client names. See agent_docs/ in the
// hexlore repository for how each part was verified.
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";

export const REST_PORT = 16021;
export const STREAM_PORT = 60222;

// Touch record types in the raw touch stream.
export const TOUCH = { HOVER: 0, DOWN: 1, HOLD: 2, UP: 3, SWIPE: 4 };

// Shape types in the layout that matter for Elements: corner zones and the controller.
export const SHAPE = { CONTROLLER: 12, HEX: 14, KITE: 15 };

export class Nanoleaf {
  // host: controller IP; token: auth token from pair(); timeout: per REST request, ms;
  // onError(err): send() failures (UDP errors such as EHOSTUNREACH), default console.
  constructor({ host, token, timeout = 5000, onError = (e) => console.error(`nanoleaf: ${e.message}`) }) {
    if (!host) throw new Error("Nanoleaf needs a host (controller IP)");
    if (!token) throw new Error("Nanoleaf needs a token (did pairing time out?)");
    this.host = host;
    this.token = token;
    this.timeout = timeout;
    this.onError = onError;
    this.base = `http://${host}:${REST_PORT}/api/v1/${token}`;
    this.udp = null;
    this.stops = new Set();
  }

  // Reads { auth_token, host } as written by pair tools.
  static fromFile(file) {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!cfg.host) throw new Error(`${file} has no "host": pair again, or add the controller's IP as "host"`);
    return new Nanoleaf({ host: cfg.host, token: cfg.auth_token });
  }

  // Raw REST call below /api/v1/<token>. Returns parsed JSON, or null for an empty body.
  async request(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Everything at once: name, model, firmware, state, effects, layout.
  info() {
    return this.request("GET", "/");
  }

  async isOn() {
    return (await this.request("GET", "/state/on")).value;
  }
  setOn(on) {
    return this.request("PUT", "/state", { on: { value: !!on } });
  }
  async brightness() {
    return (await this.request("GET", "/state/brightness")).value;
  }
  // value 0..100; duration in seconds for a fade.
  setBrightness(value, duration) {
    const v = Math.max(0, Math.min(100, Math.round(value)));
    return this.request("PUT", "/state", { brightness: duration ? { value: v, duration } : { value: v } });
  }

  // Whole-panel white at a color temperature in kelvin (1500..4000 on Elements). Ends
  // any effect or stream, like selecting a color in the Nanoleaf app.
  setColorTemperature(kelvin, duration) {
    const v = Math.round(kelvin);
    return this.request("PUT", "/state", { ct: duration ? { value: v, duration } : { value: v } });
  }
  // Flashes the panels briefly, to find which controller is which.
  identify() {
    return this.request("PUT", "/identify");
  }

  // Name of the selected effect. Streaming shows as "*ExtControl*"; other names in
  // stars are pseudo-effects too and can't be selected back.
  effect() {
    return this.request("GET", "/effects/select");
  }
  effects() {
    return this.request("GET", "/effects/effectsList");
  }
  selectEffect(name) {
    return this.request("PUT", "/effects", { select: name });
  }

  // Device command through the effects write channel, e.g. "requestTouchConfig".
  // Sends any name, including setters, calibration and trigger* commands that change
  // persistent device state; stick to get*/request*/is* unless you mean to write.
  // Some replies carry secrets (Thread keys, tokens): don't log them blindly.
  command(name, params = {}) {
    return this.request("PUT", "/effects", { write: { command: name, ...params } });
  }

  // Layout: { sideLength, zones, controller, tiles }. zones are the lit corner zones
  // ({ panelId, x, y, o, shapeType }, y up), controller its layout entry or null,
  // tiles from groupTiles().
  async layout() {
    const raw = await this.request("GET", "/panelLayout/layout");
    return layoutFrom(raw);
  }

  // Touch id of every tile, from the getHeatmap command (base64 TLV: type 1 count,
  // type 2 records of id u16 plus 5 bytes). Pair them with tiles via predictTouchIds().
  async touchIds() {
    const { heatmapData } = await this.command("getHeatmap");
    const b = Buffer.from(heatmapData, "base64");
    const ids = [];
    for (let i = 0; i + 3 <= b.length; ) {
      const type = b[i], len = b.readUInt16BE(i + 1);
      if (type === 2) for (let o = i + 3; o + 7 <= i + 3 + len; o += 7) ids.push(b.readUInt16BE(o));
      i += 3 + len;
    }
    return ids;
  }

  // Switches the panels on and into extControl v2 streaming.
  async startStream() {
    await this.setOn(true);
    await this.command("display", { animType: "extControl", extControlVersion: "v2" });
  }

  // Sends one frame: colors as a Map or object of zone id -> [r, g, b]; transition in
  // 100 ms units (0 = hard cut). Zones left out keep their color. UDP has no delivery
  // guarantee, so resend the full frame now and then. Errors go to onError: without a
  // listener, a failed UDP send would be an unhandled 'error' event and end the process.
  send(colors, { transition = 0 } = {}) {
    if (!this.udp) {
      this.udp = dgram.createSocket("udp4");
      this.udp.on("error", (e) => this.onError(e));
    }
    this.udp.send(encodeFrame(colors, transition), STREAM_PORT, this.host, (e) => e && this.onError(e));
  }

  // Device events over SSE: ids 1 state, 2 layout, 3 effects, 4 gestures. Calls
  // onEvent({ id, data }) per event and reconnects after `retry` ms when the stream
  // drops. Returns stop().
  events(onEvent, { ids = [1, 2, 3], retry = 5000, onError } = {}) {
    return this.#stream(`/events?id=${ids.join(",")}`, {}, onEvent, retry, onError);
  }

  // Raw touch stream: calls onTouch({ id, type, strength, from }) for every tile
  // record, about 7 times a second per touched tile. id is the tile's touch id (not a
  // layout zone id); type is a TOUCH value; strength 0..15; from is the previous tile
  // for swipes, else null. Returns stop().
  touch(onTouch, { retry = 5000, onError } = {}) {
    const sock = dgram.createSocket("udp4");
    sock.on("message", (buf) => { for (const t of decodeTouch(buf)) onTouch(t); });
    sock.on("error", (e) => (onError ?? this.onError)(e));
    let stopStream = null, stopped = false;
    sock.bind(0, () => {
      if (stopped) return;
      const headers = { TouchEventsPort: String(sock.address().port) };
      stopStream = this.#stream("/events?id=4", headers, () => {}, retry, onError);
    });
    const stop = () => {
      if (stopped) return; // closing a dgram socket twice throws
      stopped = true;
      stopStream?.();
      sock.close();
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }

  // Stops every stream and closes the frame socket.
  close() {
    for (const stop of [...this.stops]) stop();
    this.udp?.close();
    this.udp = null;
  }

  #stream(path, headers, onEvent, retry, onError) {
    let ctrl = null, stopped = false;
    (async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await fetch(this.base + path, { headers, signal: ctrl.signal });
          if (!res.ok) throw new Error(`${path}: ${res.status}`);
          const decoder = new TextDecoder();
          let buf = "";
          for await (const chunk of res.body) {
            buf += decoder.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const msg = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = /^data:\s*(.*)$/m.exec(msg)?.[1];
              if (data === undefined) continue;
              let parsed = data;
              try { parsed = JSON.parse(data); } catch {}
              onEvent({ id: Number(/^id:\s*(\d+)/m.exec(msg)?.[1]), data: parsed });
            }
          }
          if (!stopped) throw new Error(`${path}: stream ended`);
        } catch (e) {
          if (!stopped) onError?.(e);
        }
        if (!stopped) await new Promise((r) => setTimeout(r, retry));
      }
    })();
    const stop = () => {
      stopped = true;
      ctrl?.abort();
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }
}

// Finds controllers by SSDP, sending from every IPv4 interface (a default multicast
// route can point at docker or a VPN instead of the LAN). Resolves to
// [{ ip, name, id, model }] after `timeout` ms.
export async function discover({ timeout = 3000 } = {}) {
  const targets = ["nanoleaf:nl52", "nanoleaf:nl42", "nanoleaf:nl29", "nanoleaf_aurora:light"];
  const found = new Map();
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address);
  const sockets = await Promise.all(addrs.map((addr) => new Promise((resolve) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    // An interface that can't bind or send is skipped; its socket is closed so it
    // can't keep the process alive.
    s.on("error", () => {
      try { s.close(); } catch {}
      resolve(null);
    });
    s.on("message", (msg, rinfo) => {
      const text = msg.toString();
      const header = (name) => new RegExp(`^${name}:\\s*(.+)$`, "mi").exec(text)?.[1].trim();
      const st = header("ST") ?? "";
      if (!/nanoleaf/i.test(st) && !header("nl-deviceid")) return;
      const ip = /\/\/([\d.]+)/.exec(header("Location") ?? "")?.[1] || rinfo.address;
      found.set(ip, { ip, name: header("nl-devicename") ?? "", id: header("nl-deviceid") ?? "", model: st.split(":").pop() });
    });
    s.bind(0, addr, () => {
      try { s.setMulticastInterface(addr); } catch {}
      for (const st of targets) {
        s.send(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`, 1900, "239.255.255.250");
      }
      resolve(s);
    });
  })));
  await new Promise((r) => setTimeout(r, timeout));
  for (const s of sockets) { try { s?.close(); } catch {} } // may already be closed by an error
  return [...found.values()];
}

// Requests a token from the controller at `host`. The controller only hands one out
// within 30 s of its power button being held for 5 to 7 s; this polls once a second
// for `timeout` ms so the user doesn't have to time it. Resolves to the token, or null.
export async function pair(host, { timeout = 60000, interval = 1000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://${host}:${REST_PORT}/api/v1/new`, { method: "POST", signal: AbortSignal.timeout(3000) });
      if (res.ok) return (await res.json()).auth_token;
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

// Whether `token` is accepted by the controller at `host`.
export async function checkToken(host, token) {
  try {
    return (await fetch(`http://${host}:${REST_PORT}/api/v1/${token}/`, { signal: AbortSignal.timeout(4000) })).ok;
  } catch {
    return false;
  }
}

// Layout object from a raw /panelLayout/layout reply (also usable for simulated ones).
export function layoutFrom(raw) {
  const zones = raw.positionData.filter((p) => p.shapeType !== SHAPE.CONTROLLER);
  return {
    sideLength: raw.sideLength,
    zones,
    controller: raw.positionData.find((p) => p.shapeType === SHAPE.CONTROLLER) ?? null,
    tiles: groupTiles(zones, raw.sideLength),
  };
}

// Groups corner zones into tiles by geometry, not list order: a zone sits at 50/67 of
// sideLength from its tile center, in direction `o` mod 360. Returns
// [{ cx, cy, corners: [{ id, x, y, o, a }] }], corners sorted by angle a around the center.
export function groupTiles(zones, sideLength) {
  const groups = [];
  for (const z of zones) {
    const a = ((z.o % 360) * Math.PI) / 180, r = (50 / 67) * sideLength;
    const ex = z.x - r * Math.cos(a), ey = z.y - r * Math.sin(a);
    let g = groups.find((g) => Math.hypot(g.ex - ex, g.ey - ey) < sideLength * 0.3);
    if (!g) groups.push((g = { ex, ey, zs: [] }));
    g.zs.push(z);
  }
  return groups.map(({ ex, ey, zs }) => {
    const full = zs.length === 6;
    const cx = full ? zs.reduce((s, z) => s + z.x, 0) / 6 : ex, cy = full ? zs.reduce((s, z) => s + z.y, 0) / 6 : ey;
    const corners = zs.map((z) => ({ id: z.panelId, x: z.x, y: z.y, o: z.o, a: Math.atan2(z.y - cy, z.x - cx) }));
    return { cx, cy, corners: corners.sort((p, q) => p.a - q.a) };
  });
}

// Touch id candidates for one Elements tile, from its six corners ({ id, o }).
// The corner ids in order of rising raw `o`, then the touch id, are K ^ L(j) for 7
// consecutive j, L being the linear part of a reflected CRC-16 (polynomial 0x8005)
// over a little-endian counter. Neighbor XORs reveal j mod 8 and so the last step;
// when j + 6 is a multiple of 8 the carry length is unknown and all 13 L(2^n - 1),
// n >= 4, are candidates. Usually one candidate; matched all 49 tiles checked.
export function predictTouchIds(corners) {
  if (corners.length !== 6) return [];
  const z = [...corners].sort((p, q) => p.o - q.o).map((c) => c.id);
  const d = z.slice(1).map((id, i) => z[i] ^ id);
  const fits = (jl, i, s) => ((jl + i) % 8 === 7 ? HIGH.includes(s) : s === crcL((jl + i) ^ (jl + i + 1)));
  const out = [];
  for (let jl = 0; jl < 8; jl++) {
    if (!d.every((s, i) => fits(jl, i, s))) continue;
    const steps = (jl + 5) % 8 === 7 ? HIGH : [crcL((jl + 5) ^ (jl + 6))];
    out.push(...steps.map((s) => z[5] ^ s));
  }
  return out;
}
const refl16 = (v) => { let r = 0; for (let i = 0; i < 16; i++) r = (r << 1) | ((v >> i) & 1); return r; };
const divx = (y) => (y & 1 ? y ^ 0x18005 : y) >>> 1;
const LB = []; // LB[k] = L(2^k): L(1) measured, the rest by dividing by x (reflected domain)
for (let y = refl16(0x90c1), k = 0; k < 16; k++, y = divx(y)) LB.push(refl16(y));
const crcL = (j) => { let r = 0; for (let k = 0; k < 16; k++) if (j >> k & 1) r ^= LB[k]; return r; };
const HIGH = Array.from({ length: 13 }, (_, i) => crcL((1 << (i + 4)) - 1));

// extControl v2 frame: count u16, then per zone id u16, r g b w u8, transition u16.
export function encodeFrame(colors, transition = 0) {
  const entries = colors instanceof Map ? [...colors] : Object.entries(colors);
  const buf = Buffer.alloc(2 + entries.length * 8);
  buf.writeUInt16BE(entries.length, 0);
  entries.forEach(([id, c], i) => {
    const o = 2 + i * 8;
    buf.writeUInt16BE(Number(id), o);
    for (let k = 0; k < 3; k++) buf.writeUInt8(Math.max(0, Math.min(255, c[k] | 0)), o + 2 + k);
    buf.writeUInt16BE(transition, o + 6);
  });
  return buf;
}

// Raw touch packet: count u16, then per tile id u16, type << 4 | strength u8, from u16.
export function decodeTouch(buf) {
  const out = [];
  if (buf.length < 2) return out;
  const n = buf.readUInt16BE(0);
  for (let i = 0, o = 2; i < n && o + 5 <= buf.length; i++, o += 5) {
    const from = buf.readUInt16BE(o + 3);
    out.push({ id: buf.readUInt16BE(o), type: buf[o + 2] >> 4, strength: buf[o + 2] & 15, from: from === 0xffff ? null : from });
  }
  return out;
}
