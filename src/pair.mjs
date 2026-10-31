// Find a Nanoleaf controller on the LAN, pair with it and save token.json.
// Usage: node src/pair.mjs [--ip <address>] [--force]
//        node src/pair.mjs --find
//   --find:  only list the controllers on the network, then exit
//   --ip:    skip discovery and pair with this controller
//   --force: replace an existing token.json even if its token still works
// Discovery is SSDP, sent from every IPv4 LAN interface (a default multicast route
// can point at docker or tailscale instead of the LAN). Pairing polls
// POST /api/v1/new once a second while the user holds the power button; it answers
// 403 until the controller's 30 s pairing window opens. The token is never printed.
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, "..", "token.json");
const args = process.argv.slice(2);
const force = args.includes("--force");
const ipArg = args.includes("--ip") ? args[args.indexOf("--ip") + 1] : null;

// Search targets: Elements (nl52), Shapes (nl42), Canvas (nl29), original Light Panels.
const TARGETS = ["nanoleaf:nl52", "nanoleaf:nl42", "nanoleaf:nl29", "nanoleaf_aurora:light"];

async function discover(ms = 3000) {
  const found = new Map(); // ip -> { ip, name, id, model }
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address);
  const sockets = await Promise.all(addrs.map((addr) => new Promise((resolve) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.on("error", () => resolve(null));
    s.on("message", (msg, rinfo) => {
      const text = msg.toString();
      const header = (name) => new RegExp(`^${name}:\\s*(.+)$`, "mi").exec(text)?.[1].trim();
      const st = header("ST") ?? "";
      if (!/nanoleaf/i.test(st) && !header("nl-deviceid")) return;
      const loc = header("Location");
      const ip = (loc && /\/\/([\d.]+)/.exec(loc)?.[1]) || rinfo.address;
      found.set(ip, { ip, name: header("nl-devicename") ?? "", id: header("nl-deviceid") ?? "", model: st.split(":").pop() });
    });
    s.bind(0, addr, () => {
      try { s.setMulticastInterface(addr); } catch {}
      for (const st of TARGETS) {
        const q = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        s.send(q, 1900, "239.255.255.250");
      }
      resolve(s);
    });
  })));
  await new Promise((r) => setTimeout(r, ms));
  for (const s of sockets) s?.close();
  return [...found.values()];
}

async function tokenWorks(ip, token) {
  try {
    const res = await fetch(`http://${ip}:16021/api/v1/${token}/`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

if (args.includes("--find")) {
  const devices = await discover();
  for (const d of devices) console.log(`${d.ip}  ${d.name || "(unnamed)"}  ${d.model}  ${d.id}`);
  if (!devices.length) console.log("no Nanoleaf controllers found");
  process.exit(devices.length ? 0 : 1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  if (fs.existsSync(TOKEN_FILE) && !force) {
    const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    const host = cur.host ?? "192.168.50.108";
    if (cur.auth_token && (await tokenWorks(host, cur.auth_token))) {
      console.log(`token.json already works with the controller at ${host}. Use --force to pair again.`);
      process.exit(0);
    }
    console.log("token.json exists but its token is not accepted; pairing again.");
  }

  let device;
  if (ipArg) {
    device = { ip: ipArg, name: "", id: "", model: "" };
  } else {
    console.log("Searching the network for Nanoleaf controllers...");
    const devices = await discover();
    if (!devices.length) {
      console.log("None found. If you know the address, run: node src/pair.mjs --ip <address>");
      process.exit(1);
    }
    devices.forEach((d, i) => console.log(`  ${i + 1}. ${d.name || "(unnamed)"}  ${d.ip}  ${d.model}`));
    let pick = 0;
    if (devices.length > 1) {
      const answer = await rl.question(`Pair with which one? [1-${devices.length}] `);
      pick = Number(answer) - 1;
      if (!devices[pick]) throw new Error("no such controller");
    }
    device = devices[pick];
  }

  console.log(`\nPairing with ${device.name || device.ip}.`);
  console.log("Hold the controller's power button for 5 to 7 seconds, until its LEDs flash.");
  console.log("Waiting up to 60 seconds...");
  let token = null;
  for (let t = 0; t < 60 && !token; t++) {
    try {
      const res = await fetch(`http://${device.ip}:16021/api/v1/new`, { method: "POST", signal: AbortSignal.timeout(3000) });
      if (res.ok) token = (await res.json()).auth_token;
    } catch {}
    if (!token) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!token) {
    console.log("No token: the pairing window did not open. Try again and hold the button a little longer.");
    process.exit(1);
  }
  const out = { auth_token: token, host: device.ip, ...(device.name && { name: device.name }), ...(device.id && { id: device.id }) };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 1) + "\n", { mode: 0o600 });
  console.log(`Paired. Saved token and address to token.json (keep it private).`);
  console.log("Start the app with: node src/server.mjs");
} catch (e) {
  console.error(`pairing failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
