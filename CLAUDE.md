Guidance for agents working in this repo. Read this first, then the relevant
file in `agent_docs/`.

## What this is

hexlore: local control of a Nanoleaf Elements light panel set over its LAN REST API
(port 16021) and the extControl v2 UDP streaming protocol (port 60222). No cloud,
no third-party libraries: plain Node with built-in modules only (no npm deps).

## Layout

| Path                  | Role                                                                                 |
|-----------------------|--------------------------------------------------------------------------------------|
| `src/nanoleaf.mjs`    | device library: discovery, pairing, REST, streaming, events, touch, touch id model   |
| `src/server.mjs`      | touch-paint server (HTTP + SSE), touch and effect engines; device via the library    |
| `src/sim.mjs`         | `SimDevice`: simulated controller for `--sim`, same methods as `Nanoleaf`            |
| `src/effect.mjs`      | CLI: run one effect on the panels without the server                                 |
| `src/pair.mjs`        | CLI: find controllers (SSDP), pair, write `token.json`                               |
| `src/effects/`        | animations, one module per effect, for the server and the CLI; contract in `lib.mjs` |
| `docs/`               | browser client, served from `src/server.mjs` as static files; no server code         |
| `docs/index.html`     | paint page (SVG, 3D preview, dock with control sheets)                               |
| `docs/tiles.html`     | reference page at `/tiles`: tile hardware, protocols, touch id model, live map       |
| `data/`               | runtime data written by the server; untracked                                        |
| `media/`              | images for README.md (`paint-3d.png`: paint page screenshot)                         |
| `data/state.json`     | current picture, restored on server start                                            |
| `data/scenes.json`    | saved paint scenes `{name: {panelId: [r,g,b]}}`                                      |
| `data/touch-map.json` | touch id to tile corner zones, from prediction or "Map touch"                        |
| `data/sim-*.json`     | simulator tiles/picture/scenes, separate from the real ones                          |
| `token.json`          | `{"auth_token", "host", "name", "id"}` from `pair.mjs`; secret, untracked            |
| `agent_docs/`         | deep dives (linked below)                                                            |

## Device

| Field    | Value                                                                             |
|----------|-----------------------------------------------------------------------------------|
| Model    | NL52 (Elements), name "Elements 66C5"                                             |
| IP       | 192.168.50.108 (DHCP, may change)                                                 |
| MAC      | 80:8a:f7:0d:66:c5                                                                 |
| Firmware | 12.4.1, hardware 1.3-0                                                            |
| Zones    | 20 hexagons x 6 corners = 120 lit + 1 controller entry (7 tiles until 2026-10)    |

## Commands

```bash
node src/pair.mjs [--ip A]         # find a controller, pair (hold power button), save token.json
node src/pair.mjs --find           # list controllers on the LAN and exit (--force: re-pair)
node src/server.mjs [port]         # touch-paint app on 0.0.0.0:8321; Ctrl-C restores effect
node src/server.mjs 8322 --sim     # no device: simulated tiles, editable from the page (Layout)
node src/effect.mjs --list         # effects in src/effects/
node src/effect.mjs rain [sec]     # run one effect without the server, then restore the effect
node src/effect.mjs moon 1 --keep  # leave the last frame up (no restore)
```

## Docs

- [agent_docs/architecture.md](agent_docs/architecture.md): REST endpoints, streaming frame format, panel layout, discovery.
- [agent_docs/research.md](agent_docs/research.md): panel build, dimensions, optics (light guide, rim leakage); read before changing the light model.
- [agent_docs/gotchas.md](agent_docs/gotchas.md): non-obvious traps. Skim before changing pairing, streaming, or discovery code.

## Invariants

- Never commit, print in docs, or send `token.json` anywhere off the LAN. Anyone holding the token controls the lights.
- Never POST to port 80 on the device. It is the firmware upload page (`/upgrade_firmware`, gated by the power-button window); a bad upload can brick the controller.
- Streaming code restores the previous effect on exit, unless the previous selection was a `*...*` pseudo-effect. `src/effect.mjs --keep` is the deliberate exception.
- Never run `src/effect.mjs` while the paint server streams; both send full frames and overwrite each other.
- Read the token from `token.json`; never hardcode it in source.
- Never print, log or store the replies of the `getThreadNetworkParameters`, `getMijiaStatus`, `getDeviceAuthToken` or `getEventEncryptionKeyAndIVBase` device commands; they carry network keys and tokens.
- Send only read commands (`get*`, `request*`, `is*`) when exploring the device command list; setters, calibration and `trigger*` change persistent state.

## Conventions

- All device access goes through `src/nanoleaf.mjs`; never call the controller (fetch, dgram) from other files. Keep the library free of app state, paths and data files.
- Node built-ins only (`http`, `dgram`, `fetch`); no package.json. Node code stays in `src/`, browser code in `docs/`, files the server writes in `data/`. Don't add dependencies without asking.
- Don't run `deno fmt`/lint or tests; don't install packages.
- Commands that change device state (on/off, effect, streaming) are fine to run; they are visible and reversible.

## Documentation Style

- Markdown links for doc references you want an agent to follow, not backticks.
  Backticks are fine for source paths in tables and inline code. Align table columns.
- No AI-isms (no "powerful", "seamlessly", "leverage", rule-of-three, "not just
  X but Y"). No em dashes or emojis in project copy. State the point directly.
- Concise; assume the agent is competent. Add only what it can't infer.
- State each rule on its own line as always/never.
- Mark inferred claims and open questions; don't present a guess as a fact.
- Keep this file the routing entry point; move subsystem detail into agent_docs/.
