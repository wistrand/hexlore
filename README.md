# hexlore

What a Nanoleaf Elements hexagon set does on the wire, and tools built on it.
Local network only: no cloud account, no Nanoleaf app after pairing, no
third-party libraries.

Findings, verified on an NL52 controller (firmware 12.4.1):

- Per-corner control: each hexagon is six LED zones with their own ids, driven
  over the extControl v2 UDP stream.
- Raw touch input: hover, down, hold, up and swipe per tile, about 7 readings a
  second, from the UDP touch stream the device opens on request.
- Touch ids are not layout ids. They derive from a tile's corner ids through a
  reflected CRC-16 (polynomial 0x8005), so new tiles are recognized on first
  touch without a mapping step.
- Layout, controller position, panel optics (light guide, rim leakage) and
  expansion limits, with sources and open questions.

The reference lives in `agent_docs/` (start with
[CLAUDE.md](CLAUDE.md)) and on the `/tiles` page of the server below.

## Tools

| Tool                  | Purpose                                                                    |
|-----------------------|----------------------------------------------------------------------------|
| `node src/server.mjs` | touch-paint app: paint corners from a browser, run effects, touch the panel to glow, ripple or paint; `/tiles` documents the hardware and protocol live |
| `node src/effect.mjs` | run one effect from the command line, without the app                      |

Effects (`src/effects/`): sweep and ripple, corner chase, bouncing ball,
pinwheels, fireworks, rain, heartbeat, a pixel show of those, a crescent moon and
moon phases. Each is one module; drop a new one in to add an effect.

Code is in `src/`, the browser client in `docs/`, and runtime data (picture,
scenes, touch map) in `data/`, which stays out of version control. Node only, no
dependencies.

## Setup

1. Find the device IP (router DHCP list, or SSDP search for `nanoleaf:nl52`).
2. Hold the controller power button 5-7 seconds until the LEDs flash.
3. Within 30 seconds:

   ```bash
   curl -X POST http://<ip>:16021/api/v1/new > token.json
   ```

`token.json` is a secret. Keep it out of version control.

## Usage

Turn on and pick an effect:

```bash
T=$(node -p 'require("./token.json").auth_token')
curl -X PUT -d '{"on":{"value":true}}' http://<ip>:16021/api/v1/$T/state
curl -X PUT -d '{"select":"Ember"}'    http://<ip>:16021/api/v1/$T/effects
```

Run an effect for 20 seconds, then restore the previous effect (stop the paint
app first; both stream to the same panels):

```bash
node src/effect.mjs --list
node src/effect.mjs rain 20
```

Start the paint app on port 8321 and open it in a browser on the same network:

```bash
node src/server.mjs
```

Nanoleaf and Elements are trademarks of Nanoleaf. This project is not
affiliated with or endorsed by Nanoleaf.
