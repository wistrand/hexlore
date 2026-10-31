// Find a Nanoleaf controller on the LAN, pair with it and save token.json.
// Usage: node src/pair.mjs [--ip <address>] [--force]
//        node src/pair.mjs --find
//   --find:  only list the controllers on the network, then exit
//   --ip:    skip discovery and pair with this controller
//   --force: replace an existing token.json even if its token still works
// Discovery and pairing are discover() and pair() from src/nanoleaf.mjs. The token is
// never printed.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { checkToken, discover, pair } from "./nanoleaf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, "..", "token.json");
const args = process.argv.slice(2);
const force = args.includes("--force");
const ipArg = args.includes("--ip") ? args[args.indexOf("--ip") + 1] : null;

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
    if (cur.auth_token && (await checkToken(host, cur.auth_token))) {
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
      pick = Number(await rl.question(`Pair with which one? [1-${devices.length}] `)) - 1;
      if (!devices[pick]) throw new Error("no such controller");
    }
    device = devices[pick];
  }

  console.log(`\nPairing with ${device.name || device.ip}.`);
  console.log("Hold the controller's power button for 5 to 7 seconds, until its LEDs flash.");
  console.log("Waiting up to 60 seconds...");
  const token = await pair(device.ip);
  if (!token) {
    console.log("No token: the pairing window did not open. Try again and hold the button a little longer.");
    process.exit(1);
  }
  const out = { auth_token: token, host: device.ip, ...(device.name && { name: device.name }), ...(device.id && { id: device.id }) };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 1) + "\n", { mode: 0o600 });
  console.log("Paired. Saved token and address to token.json (keep it private).");
  console.log("Start the app with: node src/server.mjs");
} catch (e) {
  console.error(`pairing failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
