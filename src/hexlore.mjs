// hexlore command line: device control on top of src/nanoleaf.mjs, plus `run` for the
// animations in src/effects/ without the paint server. `find` and `pair` work without
// token.json; `pair` writes it ({auth_token, host, name, id}, mode 0600) and every
// other command reads it. The token is never printed.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Nanoleaf, checkToken, discover, pair, predictTouchIds } from "./nanoleaf.mjs";
import { effectContext, loadEffects } from "./effects/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, "..", "token.json");
const FALLBACK_HOST = "192.168.50.108"; // for token.json files written before host was stored

const USAGE = `usage: node src/hexlore.mjs <command> [args]
  find                    list Nanoleaf controllers on the network
  pair [--ip A] [--force] find a controller, pair (hold its power button), save token.json
  run                     list hexlore's animations (src/effects/)
  run <name> [s] [--keep] play one until Ctrl-C or for s seconds, then restore the
                          previous effect (--keep: leave the last frame up); stop
                          the paint server first, both stream to the same panels
  status                  name, model, firmware, power, brightness, effect, tiles
  on | off                power
  brightness <0-100> [s]  set brightness, optionally fading over s seconds
  ct <kelvin> [s]         whole-panel white at a color temperature (1500-4000)
  effects                 the controller's own effects, current one marked
  select <effect name>    play one of them (ends streaming from the paint server)
  identify                flash the panels
  layout                  tiles: center, corner zone ids, touch id
  touch                   print touches live until Ctrl-C
  events                  print device events live until Ctrl-C
  cmd <name> [--write]    send a device command, print the reply (writes need --write)`;

// Commands whose replies carry network keys or tokens; never printed.
const SECRET = new Set(["getThreadNetworkParameters", "getMijiaStatus", "getDeviceAuthToken", "getEventEncryptionKeyAndIVBase"]);
const TOUCH_NAMES = ["hover", "down", "hold", "up", "swipe"];
const EVENT_NAMES = { 1: "state", 2: "layout", 3: "effects", 4: "gesture" };

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const args = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--ip");
const number = (v, name) => {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) throw new Error(`${name}: expected a number`);
  return n;
};
const time = () => new Date().toISOString().slice(11, 23);

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}

// Lists controllers found by SSDP.
async function find() {
  const devices = await discover();
  for (const d of devices) console.log(`${d.ip}  ${d.name || "(unnamed)"}  ${d.model}  ${d.id}`);
  if (!devices.length) {
    console.log("no Nanoleaf controllers found");
    process.exitCode = 1;
  }
}

// Finds (or takes --ip) a controller, waits for the pairing window, writes token.json.
async function pairCommand() {
  if (fs.existsSync(TOKEN_FILE) && !flags.has("--force")) {
    const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    const host = cur.host ?? FALLBACK_HOST;
    if (cur.auth_token && (await checkToken(host, cur.auth_token))) {
      console.log(`token.json already works with the controller at ${host}. Use --force to pair again.`);
      return;
    }
    console.log("token.json exists but its token is not accepted; pairing again.");
  }
  let device = option("--ip") && { ip: option("--ip"), name: "", id: "", model: "" };
  if (!device) {
    console.log("Searching the network for Nanoleaf controllers...");
    const devices = await discover();
    if (!devices.length) throw new Error("None found. If you know the address: node src/hexlore.mjs pair --ip <address>");
    devices.forEach((d, i) => console.log(`  ${i + 1}. ${d.name || "(unnamed)"}  ${d.ip}  ${d.model}`));
    let pick = 0;
    if (devices.length > 1) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      pick = Number(await rl.question(`Pair with which one? [1-${devices.length}] `)) - 1;
      rl.close();
      if (!devices[pick]) throw new Error("no such controller");
    }
    device = devices[pick];
  }
  console.log(`\nPairing with ${device.name || device.ip}.`);
  console.log("Hold the controller's power button for 5 to 7 seconds, until its LEDs flash.");
  console.log("Waiting up to 60 seconds...");
  const token = await pair(device.ip);
  if (!token) throw new Error("No token: the pairing window did not open. Try again and hold the button a little longer.");
  const out = { auth_token: token, host: device.ip, ...(device.name && { name: device.name }), ...(device.id && { id: device.id }) };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 1) + "\n", { mode: 0o600 });
  console.log("Paired. Saved token and address to token.json (keep it private).");
  console.log("Start the app with: node src/server.mjs");
}

// Plays an animation from src/effects/ at 25 fps, sending every zone in every frame
// (zones the effect leaves out go dark). On exit, puts back the previous effect unless
// --keep or it was a *...* pseudo-effect such as the paint server's *ExtControl*.
async function runEffect(nl, effects, key, seconds) {
  const FPS = 25;
  const prevEffect = await nl.effect();
  const { zones, sideLength } = await nl.layout();
  const ids = zones.map((z) => z.panelId);
  const inst = effects.get(key).create(effectContext(zones, sideLength));
  await nl.startStream();
  console.log(`${effects.get(key).meta?.name ?? key} on ${ids.length} zones${Number.isFinite(seconds) ? ` for ${seconds} s` : ""}; Ctrl-C to stop`);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let last = t0, stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      if (!flags.has("--keep") && typeof prevEffect === "string" && !prevEffect.startsWith("*")) {
        try {
          await nl.selectEffect(prevEffect);
          console.log(`restored effect: ${prevEffect}`);
        } catch (e) {
          console.error(`restore failed: ${e.message}`);
        }
      }
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const timer = setInterval(() => {
      const now = Date.now(), t = (now - t0) / 1000;
      if (t >= seconds) return stop();
      let out;
      try {
        out = inst.frame(t, (now - last) / 1000) ?? {};
      } catch (e) {
        console.error(`effect failed: ${e.message}`);
        return stop(); // still restores the previous effect
      }
      nl.send(new Map(ids.map((id) => [id, out[id] ?? [0, 0, 0]])));
      last = now;
    }, 1000 / FPS);
  });
}

// Keeps a live watcher running until Ctrl-C.
function untilInterrupted(nl) {
  process.on("SIGINT", () => {
    nl.close();
    process.exit(0);
  });
  return new Promise(() => {});
}

async function deviceCommand(nl) {
  switch (cmd) {
    case "status": {
      const [info, { tiles }] = await Promise.all([nl.info(), nl.layout()]);
      const s = info.state;
      console.log(`${info.name}  ${info.model}  firmware ${info.firmwareVersion}  at ${nl.host}`);
      console.log(`power ${s.on.value ? "on" : "off"}, brightness ${s.brightness.value}, effect ${info.effects.select}`);
      console.log(`${tiles.length} tiles, ${tiles.reduce((n, t) => n + t.corners.length, 0)} zones`);
      return;
    }
    case "on":
    case "off":
      return nl.setOn(cmd === "on");
    case "brightness":
      return nl.setBrightness(number(args[0], "brightness"), args[1] ? number(args[1], "seconds") : undefined);
    case "ct":
      return nl.setColorTemperature(number(args[0], "kelvin"), args[1] ? number(args[1], "seconds") : undefined);
    case "effects": {
      const [list, current] = await Promise.all([nl.effects(), nl.effect()]);
      for (const name of list) console.log(`${name === current ? "*" : " "} ${name}`);
      if (!list.includes(current)) console.log(`  (now showing ${current})`);
      return;
    }
    case "select":
      if (!args.length) throw new Error("select: name an effect (see: effects)");
      return nl.selectEffect(args.join(" "));
    case "identify":
      return nl.identify();
    case "layout": {
      const { tiles, controller } = await nl.layout();
      let ids = [];
      try { ids = await nl.touchIds(); } catch {}
      tiles.forEach((t, i) => {
        const touch = predictTouchIds(t.corners).filter((id) => ids.includes(id));
        console.log(`tile ${String(i + 1).padStart(2)}  center ${Math.round(t.cx)},${Math.round(t.cy)}  touch ${touch.length === 1 ? touch[0] : "?"}  corners ${t.corners.map((c) => c.id).join(" ")}`);
      });
      if (controller) console.log(`controller at ${controller.x},${controller.y}`);
      return;
    }
    case "touch":
      console.log("touch the panels; Ctrl-C to stop");
      nl.touch(({ id, type, strength, from }) =>
        console.log(`${time()}  ${String(id).padStart(5)}  ${TOUCH_NAMES[type] ?? type}  ${strength}${from !== null ? `  from ${from}` : ""}`),
      { onError: (e) => console.error(`touch stream: ${e.message}`) });
      return untilInterrupted(nl);
    case "events":
      console.log("watching state, layout, effect and gesture events; Ctrl-C to stop");
      nl.events(({ id, data }) => console.log(`${time()}  ${EVENT_NAMES[id] ?? id}  ${JSON.stringify(data)}`),
        { ids: [1, 2, 3, 4], onError: (e) => console.error(`event stream: ${e.message}`) });
      return untilInterrupted(nl);
    case "cmd": {
      const name = args[0];
      if (!name) throw new Error("cmd: name a device command, e.g. requestTouchConfig");
      if (SECRET.has(name)) throw new Error(`${name} returns network keys or tokens; not printed by this tool`);
      if (!/^(get|request|is)/.test(name) && !flags.has("--write")) {
        throw new Error(`${name} may change device state; add --write if that is what you want`);
      }
      const reply = await nl.command(name);
      console.log(reply === null ? "(no reply)" : JSON.stringify(reply, null, 1));
      return;
    }
    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

try {
  const effects = cmd === "run" ? await loadEffects(path.join(HERE, "effects")) : null;
  if (cmd === "find") await find();
  else if (cmd === "pair") await pairCommand();
  else if (cmd === "run" && !args[0]) {
    for (const [k, m] of effects) console.log(`  ${k.padEnd(12)} ${m.meta?.name ?? k}: ${m.meta?.description ?? ""}`);
  } else if (cmd === "run" && !effects.has(args[0])) {
    throw new Error(`unknown animation "${args[0]}"; list them with: node src/hexlore.mjs run`);
  } else {
    if (!fs.existsSync(TOKEN_FILE)) throw new Error("no token.json yet: run node src/hexlore.mjs pair");
    const nl = Nanoleaf.fromFile(TOKEN_FILE, { fallbackHost: FALLBACK_HOST });
    if (cmd === "run") await runEffect(nl, effects, args[0], args[1] ? number(args[1], "seconds") : Infinity);
    else await deviceCommand(nl);
    nl.close();
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
