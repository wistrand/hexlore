# Architecture: device API and streaming

How this repo talks to the panels. All device access is in `src/nanoleaf.mjs`, a
self-contained library (Node built-ins, no app state):

| Export                                         | Does                                                           |
|------------------------------------------------|----------------------------------------------------------------|
| `discover()`                                   | SSDP search on every IPv4 interface: `[{ip, name, id, model}]` |
| `pair(host)`, `checkToken()`                   | poll `POST /api/v1/new` in the button window; test a token     |
| `new Nanoleaf({host, token})`                  | client; also `Nanoleaf.fromFile()`; `request()` for raw REST   |
| `isOn`, `setOn`, `brightness`, `setBrightness` | state                                                          |
| `effect`, `effects`, `selectEffect`, `info`    | effects and device info                                        |
| `command(name)`                                | device command through the effects write channel               |
| `layout()`                                     | `{sideLength, zones, controller, tiles}`                       |
| `touchIds()`                                   | every tile's touch id (getHeatmap)                             |
| `startStream()`, `send(colors)`                | extControl v2 on; UDP frames                                   |
| `events(cb)`, `touch(cb)`                      | SSE events, raw touch stream; reconnect; return stop()         |
| `groupTiles`, `predictTouchIds`                | pure helpers, also `encodeFrame`, `decodeTouch`, `layoutFrom`  |

Users: `src/server.mjs` (the app; its simulator is a stand-in object with the same
methods), `src/hexlore.mjs` (the CLI), and `effectContext()` in
`src/effects/lib.mjs` (tile grouping).

## Contents
- Discovery
- Pairing
- REST API
- Touch input (tile and touch ids, device commands)
- Panel layout
- extControl v2 streaming

## Discovery

The device advertises itself two ways:

| Method | Query                         | Response carries                                              |
|--------|-------------------------------|---------------------------------------------------------------|
| mDNS   | `_nanoleafapi._tcp.local` PTR | name, `id=` device id, `md=NL52`, `srcvers=` firmware         |
| SSDP   | M-SEARCH `ST: nanoleaf:nl52`  | `Location: http://<ip>:16021`, `nl-deviceid`, `nl-devicename` |

It also advertises `_meshcop._udp` (Thread border router) and `_ltpdu`.

Open TCP ports: 16021 (REST API), 80 (firmware upload page), 6517 (HomeKit HAP,
replies 470). A targeted scan of ~1060 common ports found nothing else.

Port 80 endpoints (from `firmware_upload_script.js`):

| Method | Path                | Notes                                                  |
|--------|---------------------|--------------------------------------------------------|
| GET    | `/device_info`      | no auth; serial, hardware, firmware, bootloader, model |
| POST   | `/upgrade_firmware` | raw `.firmware` body; 403 outside the button window    |

No firmware read/download endpoint exists. Backing up firmware requires physical
flash access.

## Controller identity

| Field      | Value                                                       |
|------------|-------------------------------------------------------------|
| Bootloader | 2.1.29                                                      |
| MAC OUI    | 80:8a:f7, registered to Nanoleaf (no chip vendor hint)      |
| Thread     | border router, `tv=1.3.0`, network `Google-2262`            |
| BLE        | not advertising (15 s scan, no Nanoleaf/HAP/Matter adverts) |

Inferred, unverified: embedded RTOS, Wi-Fi SoC plus a Thread radio running
OpenThread. Confirming the chips needs the PCB markings.

## Pairing

1. User holds the controller power button 5-7 s until LEDs flash (30 s window).
2. `POST /api/v1/new` returns `{"auth_token": "..."}` with 200. Outside the window it returns 403.

Poll the endpoint once a second rather than asking the user to time it. The token
persists until `DELETE /api/v1/<token>`.

`node src/hexlore.mjs pair` does both steps (library `discover()` and `pair()`):
SSDP M-SEARCH for `nanoleaf:nl52`, `nl42`, `nl29` and `nanoleaf_aurora:light`, sent
from every non-internal IPv4 interface (see the avahi/docker note in
[gotchas.md](gotchas.md)), then the polling loop for 60 s. It writes `token.json` as
`{auth_token, host, name, id}` with mode 0600 and never prints the token; `--ip`
skips discovery, `--force` re-pairs over a working token. `src/server.mjs` and the
other `hexlore.mjs` commands take `host` from that file; a file without `host` is
an error that asks to pair again. `hexlore.mjs find` only lists controllers.
Discovery and pairing (button hold, polling, writing `token.json`) verified on the
device 2026-10-31.

Other `hexlore.mjs` commands: `run` (animations, below), `status`, `on`/`off`, `brightness`, `ct` (whole-panel
white, 1500-4000 K), `effects`, `select`, `identify` (verified: flashes the panels),
`layout` (tiles with touch ids), `touch` and `events` (live), and `cmd <name>`,
which refuses the secret-bearing commands and needs `--write` for names not starting
with get/request/is.

## REST API

Base: `http://<ip>:16021/api/v1/<token>`. JSON bodies, `PUT` returns 204 on success.

| Method | Path                   | Purpose                                           |
|--------|------------------------|---------------------------------------------------|
| GET    | `/`                    | everything: info, state, effects, layout          |
| GET    | `/state/<field>`       | single state field (`on`, `brightness`, `ct`, ..) |
| PUT    | `/state`               | set state, examples below                         |
| GET    | `/effects/select`      | current effect name (JSON string)                 |
| GET    | `/effects/effectsList` | installed effect names                            |
| PUT    | `/effects`             | `{"select":"Ember"}` or `{"write":{...}}`         |
| GET    | `/panelLayout/layout`  | `numPanels`, `sideLength`, `positionData[]`       |
| GET    | `/events?id=1,2,3,4`   | SSE stream: 1 state, 2 layout, 3 effects, 4 touch |

`PUT /state` bodies: `{"on":{"value":true}}`,
`{"brightness":{"value":40,"duration":2}}`, `{"ct":{"value":2700}}`.

`src/server.mjs` holds `/events?id=2` open to follow reconfigurations: any layout
event triggers a refetch of `/panelLayout/layout`. It also polls every 30 s in case
an event is missed, keeps colors of zones that survive, and sends clients a named SSE
`layout` event so the page re-renders. The page also refetches `/api/layout` on every
SSE (re)connect, since a `layout` event sent while it was disconnected is lost.
Device requests (library `request()`) time out after 5 s: refreshes run one at a time, so a
hung request would otherwise block layout refresh for Node's 5-minute default.
On 2026-10-30, on a second (macOS) host, newly connected tiles lit but did not appear until a
server restart; the cause was not confirmed (either of the above fits, as does
the controller not yet having registered them). Live detection of added tiles is
still untested after these fixes.

Paint app server API (`src/server.mjs`):

| Method     | Path                 | Purpose                                                                                            |
|------------|----------------------|----------------------------------------------------------------------------------------------------|
| GET        | `/`, `/tiles`, files | static client from `docs/` (`index.html`, `tiles.html`)                                            |
| GET        | `/api/effects`       | effects (key, name, description) and the active key                                                |
| POST       | `/api/effect`        | `{key}` starts an effect, `{key: null}` stops it                                                   |
| GET        | `/api/tiles`         | per tile: center, corners by o, touch id, predicted ids                                            |
| GET        | `/api/layout`        | `sideLength`, zones, `controller`, `sim`, sim `tiles`                                              |
| GET        | `/api/events`        | SSE: colors, then change sets; `status`, `touch`, `effect`, `effectFrame`, `glow`, `layout` events |
| POST       | `/api/paint`         | `{panelId: [r,g,b]}` change set                                                                    |
| POST       | `/api/fill`          | `{color}` for all zones                                                                            |
| GET        | `/api/scenes`        | all saved scenes                                                                                   |
| PUT/DELETE | `/api/scenes/<name>` | save (body = colors) / delete one scene                                                            |
| GET/POST   | `/api/brightness`    | device master brightness; POST needs `{value}`                                                     |
| POST       | `/api/takeover`      | re-enable extControl                                                                               |
| POST       | `/api/touch`         | `{mode}`, `{brush}`, `{map}` (see Touch input)                                                     |
| POST       | `/api/sim/tiles`     | simulator only: `{tiles: [[q, r], ...]}`                                                           |

## Touch input

Verified 2026-10-31 on firmware 12.4.1. Open `GET /events?id=4` with header
`TouchEventsPort: <udp port>` and, while that stream stays open, the device sends
UDP packets to that port on the requesting host, about every 140 ms while any tile
is touched or approached:

| Field           | Size | Meaning                                                |
|-----------------|------|--------------------------------------------------------|
| count           | u16  | number of tile records that follow                     |
| tile id         | u16  | touch id of the tile (see below)                       |
| type, strength  | u8   | high nibble type, low nibble strength 0..15            |
| swiped from     | u16  | previous tile for type 4, else 65535                   |

Types: 0 hover (strength 1-4 seen, before contact), 1 down, 2 hold (strength 15),
3 up, 4 swipe. The SSE stream itself only carries gestures (`{"panelId":-1,
"gesture":n}`, 2 = swipe up and 5 = swipe right per Nanoleaf's numbering), with no tile.

Touch ids are per tile (one per hexagon), and they do not appear in
`/panelLayout/layout`, which lists only the corner zones. `src/server.mjs` keeps
a map from touch id to the tile's corner zones in `data/touch-map.json`. An unknown
touch id is first matched against touch ids predicted from each tile's corner ids
(`predictTouch()`, model below); a unique match is stored at
once. Only when that fails does mapping fall back to lighting tiles. "Map touch"
on the page lights one tile at a time (top row first) and assigns the next new
touch id with type down or hold to it. A run visits only tiles without a touch id;
when every tile is mapped, a manual run remaps all of them. A down or hold from an
unknown touch id starts a run by itself (`startMapping(trigger)`): with one unmapped
tile it is assigned directly, otherwise that id must lift before it can claim the
lit tile. Auto-start waits until the layout has been unchanged for 15 s. Any touch id
not yet used in the run, including one mapped earlier, claims the lit tile; a known id
moves, so a wrong entry heals by touching the right tile in a later run. Touched tiles glow (`shown()`: each channel
raised toward warm white, hover up to 0.5, contact 1, fading 250 ms after the last
packet). The server sends the glow levels to the page as SSE `glow` events and
the mapping state as `touch` events. Verified on the device: a full 14-tile mapping
run and the glow.

### Tile and touch ids

Derived 2026-10-31 from 20 hand-mapped tiles, then confirmed on 29 tiles from
other installations (sample layouts in the Nanoleaf app). The ids are a CRC-16 of a
counter; what else goes into the CRC is unknown.

- Sort a tile's 6 corner zones by raw `o` (not mod 360). The corner ids in that
  order, then the touch id, are `id(j) = K ^ L(j)` for 7 consecutive integers j
  (inferred: a factory counter, 7 ids per tile, touch sensor last).
- L is the linear part of a reflected CRC-16 with polynomial 0x8005 (the
  CRC-16/ARC, MODBUS, USB, MAXIM family) over a little-endian counter: in the
  bit-reflected domain, L(2k) = L(k) / x mod x^16 + x^15 + x^2 + 1. Measured
  L(1) = 0x90c1; derived L(2^k) for k = 0..15: 90c1 6181 c302 c607 cc0d d819 f031
  a061 00c1 0182 0304 0608 0c10 1820 3040 6080. How it was found: L(4) = L(2) << 1
  exactly, which pointed at shift structure; the reflected shift fits all three
  measured values with one polynomial, 0x8005, and then predicted the four
  carry-step values seen (L(15) = f445, L(31) = 3848, L(63) = e051,
  L(127) = 1060) with no free parameter.
- Neighbor XORs are `L(j ^ (j+1)) = L(2^n - 1)`, which reveals j mod 8 and so the
  step from the last corner to the touch id, except when j+6 is a multiple of 8:
  then the carry length is unknown and every L(2^n - 1), n >= 4, is a candidate
  (n = 4 half the time). On the 20 tiles: 15 exact, 5 with candidates, every real
  touch id matches exactly one tile.
- K is not global: no single K makes the 20 tiles consecutive runs, and the
  counter distance between any two tiles (from `L^-1(id_a ^ id_b)`) is never small.
  So the CRC input also holds per-tile data (a serial, or counter bits above 16),
  which the corner ids cannot reveal. Init and xorout of the CRC are absorbed in K.
- Ids belong to the tile hardware: rotating a tile kept its mapping, and a 20th
  tile added later was mapped by prediction on its first touch. Moving a tile is
  untested.
- The touch id is the hexagon's own panel id. The Nanoleaf Android app (12.0.0,
  decompiled and analyzed with [cupella](https://wistrand.github.io/cupella/)) names the shape types: 12 `ULP_CONTROLLER`, 14 `APEX_HEX`, 15
  `APEX_KITE` ("Apex" is the Elements codename, kites are the corner zones). Its
  layout comes from a binary TLV (version 2; 13 bytes per panel: id u16, x i32,
  y i32, o i16, shape u8) that lists an `APEX_HEX` entry per tile next to its six
  kites; the REST `/panelLayout/layout` omits the type 14 entries. The hex `o` is
  the first kite's `o` minus 60.
- Verified on other units: the app's debug layout viewer embeds sample layouts
  from three Elements installations (29 hexagons). All 29 fit the step structure,
  and the `APEX_HEX` id equals the predicted touch id for all 29 (26 exact, 3 via
  the L(15) candidate). So the model is not specific to this controller.
- Carry length at the ambiguous step (j+6 a multiple of 8), over the 8 such
  tiles seen (5 here, 3 in the app samples): L(15) 5, L(31) 1, L(127) 2.
- The app shows no derivation of its own: it reads `APEX_HEX` ids from the device.
  Its only CRC code is CRC-16/XMODEM (0x1021) for BLE packets, unrelated.
- `getHeatmap` (see [Device commands](#device-commands)) lists every tile by its
  touch id, no touching needed. `prefillTouchMap()` in `src/server.mjs` calls it at
  startup and 15 s after the last layout change, assigns each id to the tile that
  predicts it (overlaps resolved by elimination) and saves the map. Verified: on
  the 20-tile layout it resolved all 20 ids, identical to the hand-built map.

### Device commands

The app's `CustomRequest` subclasses name about 100 commands. They go through the
same channel as streaming setup: `PUT /effects {"write":{"command":"<name>"}}`.
Only read commands were sent (2026-10-31); setters, calibration, `trigger*` and
`delete` were left alone. Without parameters:

| Command                                   | Result                                                    |
|-------------------------------------------|-----------------------------------------------------------|
| `getHeatmap`                              | `heatmapData`: base64 TLV, type 1 = count (20), type 2 = 7-byte records: touch id u16 + 5 bytes (all zero but one tile; meaning unknown) |
| `requestTouchConfig`                      | gestures `dt su sd sl sr`, system actions, `userPanelConfigs` (empty) |
| `getTouchKillSwitch`                      | `touchKillSwitchOn: false`                                |
| `requestBrightnessSensorConfig`           | ambient sensor: enabled, mode, min/max, calibrated        |
| `getSpParams`                             | `llcParams` with `pir` (to 1200, rd 180, cd 60), `cb.conf` = 20 bytes valued 1-3, one per tile (meaning unknown) |
| `getOrchestratorBox`, `getOrchestratorScreenConfig` | screen-mirror box 640x360x100, no devices       |
| `getPLRConfig`, `getRemoteDebugEnable`, `isSceneChangeAnimationEnabled`, `getSpAdminId`, `getScenescape`, `getScreenMirrorOrchestratorConfigEnable` | flags, all off or empty |
| `requestAll`                              | every installed effect with full definition               |
| `getThreadNetworkParameters`, `getMijiaStatus` | contain network or account secrets                   |
| others tried                              | 400 (need parameters) or 404 (`getPowerOnConfiguration`)  |

Never print or log the responses of `getThreadNetworkParameters` (Thread
network key, PSKc), `getMijiaStatus` (token), `getDeviceAuthToken` or
`getEventEncryptionKeyAndIVBase`.
- Tiles carry no visible serial number (checked 2026-10-31), so K cannot be
  tied to a printed value. Recovering the full CRC input would need the
  tile-to-controller bus traffic or firmware; not pursued.

Effects (`src/effects/*.mjs`, picked in the Effects sheet on the page or run with
`node src/hexlore.mjs run <key> [seconds] [--keep]`): ported from the former Python
scripts (removed 2026-10-31), one module each: `sweep`, `corners`, `ball`,
`pinwheels`, `fireworks`, `rain`, `heartbeat`, `pixel-show`, `moon`, `moon-phases`.
`loadEffects()` in `lib.mjs` loads every module except `lib.mjs`, for both runners;
a module exports `meta` and `create(ctx)` returning `{ frame(t, dt) }` (contract and
`ctx` in `lib.mjs`). A running effect replaces the picture in `shown()`; the picture
stays untouched underneath, the touch overlay draws on top, and touch paint keeps
editing the hidden picture. Frames go to the panels every 40 ms tick and to the page
as SSE `effectFrame` events every third tick; `effect` events carry the active key.
`GET /api/effects` lists them, `POST /api/effect {"key"}` starts one, `{"key":null}`
stops. A layout change restarts the running effect on the new geometry. Adding an
effect: drop a module in `src/effects/` and restart the server.

Page layout (`docs/index.html`): a fixed header, the tile stage, and a fixed dock of
tabs (Paint, Effects, Touch, View, plus Layout in the simulator) with Undo/Redo.
Each tab opens one sheet of controls that floats over the bottom of the stage, so
the stage never changes size; the open tab or Escape folds it. `showTab()` switches
sheets, `tabHooks` runs code when one opens or closes, and the last tab is kept in
localStorage. The Touch tab exists only with a real device.

Touch modes (Touch sheet, `POST /api/touch {"mode"}`): `off`, `glow`, `ripple`
(default; glow plus a ring from the tile's center on each down or swipe-in, at most
one per tile per 400 ms). Ring speed, width, fade and peak are the `RIPPLE_*`
constants. `stepOverlay()` merges glow and ripples into one per-zone level, so
the panels and the page draw the same thing. Ripples verified on the device.
`paint` fills the touched tile (down, hold or swipe-in) with the brush through the
normal `applySet()` path, so it is persisted and broadcast like page paint. The page
sends its brush (`{"brush":[r,g,b]}`, black when erasing) on entering paint mode
and on each change; with several pages open the last sender wins. Touch paint is
not in any page's undo history.

Simulator (`node src/server.mjs [port] --sim`): `SimDevice` in `src/sim.mjs` has the
same methods as the library's `Nanoleaf` class that the server uses, so the server
has one code path. Nothing is sent and there are no event or touch streams. Tiles
are axial hex cells `[q, r]` (flat-top, neighbors at 30 + 60k degrees, spacing
sqrt(3) x side) persisted in `data/sim-layout.json`. Geometry matches the real unit
(sideLength 67, zones at 50/67 of the side, `o` = center-to-zone direction). Zone
ids come from (q, r, corner), so colors stay with their tile. `POST /api/sim/tiles`
calls `setTiles()` (deduplicated, |q|,|r| < 32) and fires the
normal `layout` event. The page shows a Layout tab only when `/api/layout`
reports `sim: true`; while its sheet is open, dashed ghost slots appear next to
existing tiles, tapping one adds a tile, and tapping a tile removes it. Disconnected layouts are allowed. The
picture and scenes use `data/sim-state.json` and `data/sim-scenes.json`.
Layout-mode shape tools (`docs/index.html`): symmetry off/mirror/3-fold/6-fold repeats
every add and remove around a center cell fixed when editing starts (`images()`,
rotation `(q,r) -> (-r, q+r)`, mirror `(q,r) -> (-q, q+r)`). Grow adds the ghost ring,
Shrink keeps only tiles with all 6 neighbors, Fill holes floods empty cells from
outside a padded box and fills what isn't reached, and Symmetrize unions the shape
with its symmetric images. For tests, use a throwaway instance:
`node src/server.mjs 8323 --sim --tag test` (files `data/sim-test-*.json`).

Keeping the page and the panels in sync (`src/server.mjs`):

- **Device status:** `refreshStatus()` reads `/state/on` and `/effects/select`. The
  panels show the painting only when on and the effect is `*ExtControl*`. It runs on
  every device state or effect event (`/events?id=1,2,3`) and every 5 s. Changes go
  to clients as an SSE `status` event; the page shows the reason and a Resume
  button (`/api/takeover`). Verified: selecting Fireflies directly on the device was
  reported within about 3 s, and Resume restored streaming.
- **Keepalive:** the full frame is resent every second, not only on change. UDP is
  unacknowledged, so a lost packet would otherwise leave the panels stale.
- **Persisted picture:** colors are saved to `data/state.json` (debounced 1 s) and
  reloaded on start, so a server restart doesn't blank the picture.
- **Failed sends:** if a `/api/paint` POST fails, the page reconnects SSE and takes
  the server's full state.

Page features: zone outlines hidden except a hover outline of the brush footprint
(`setHover()`, mouse/pen only), master brightness scales the preview after `tone()`
and follows the device via the `status` event, corner/tile brush (`targets()`), pick (`pickFrom()`), undo/redo
grouped per stroke (`beginStroke()`/`endStroke()`, client-side only, so one device's
history does not include other devices' strokes), scene loads are undoable, and
keyboard shortcuts (`keydown` handler).

3D view in `docs/index.html`: separate stacked `<svg>` layers in a CSS
`preserve-3d` scene. The wall (back glow, halo) sits at z=0, 18 thickness slices
come next (each carrying the rim edge gradients, so side walls glow like the rim),
and the face is at 10 mm (the mounted thickness, boosted 2x so it reads).
Drag on empty space, or right/shift-drag anywhere, to rotate (yaw) and tilt (pitch),
clamped to +/-80 degrees. Double-click on empty space or press Reset view to reset;
the view persists in localStorage. Browser hit testing follows the 3D transform:
all 42 zones are reachable at yaw/pitch (0,0), (35,30) and (-60,-45).

Grouping zones into tiles without relying on list order: `o mod 360` is the
direction from the tile center to the zone, and zones sit at 50/67 of `sideLength`
from that center (`hexGroups()` in `docs/index.html`, `tiles()` in
`src/server.mjs`, `effectContext()` in `src/effects/lib.mjs`). Verified on the 7-,
14- and 20-tile layouts.

State ranges on this unit: brightness 0-100, ct 1500-4000 K, hue 0-360, sat 0-100.

## Panel layout

`positionData[]` entries: `panelId` (u16), `x`, `y`, `o` (orientation degrees),
`shapeType`. Use `x`/`y` for spatial effects; the demo computes the bounding-box
center for radial patterns.

This unit was 7 hexagons x 6 corner zones = 42 lit zones (shapeType 15), verified
visually with the former `zones_demo.py` (now the `corners` effect). It grew to 14
and then 20 hexagons in 2026-10 and has 19 (114 zones) as of 2026-10-31; use
`node src/hexlore.mjs status` for the current count. The extra
entry, `panelId 0` shapeType 12 at (72,74), does not light (inferred: controller).
With 14 tiles it is 68 units from the nearest tile center (131,108) at -150 degrees,
the direction of that tile's lower-left edge midpoint (apothem 58), so it sits about
10 units outside the edge, where the edge connector is. Inferred: the controller
plugs into that edge. Its `o` (120) is not decoded. The page draws it there with the
Controller button (`/api/layout` returns it as `controller`). The public shapeType
table maps 12/15 to other products, so treat the numbers as firmware-specific.

Connectors between tiles are not reported. The layout gives bounds only: 14 tiles
share 29 edges, and (inferred) at least 13 of them carry a linker, since the
controller discovers tiles through the chain. Which of the other shared edges are
linked cannot be read from the API.

`positionData` lists zones in runs of 6 per hexagon, in this order:

| Hex | Center    |
|-----|-----------|
| 0   | (131,108) |
| 1   | (232,166) |
| 2   | (131,224) |
| 3   | (232,282) |
| 4   | (332,224) |
| 5   | (332,108) |
| 6   | (232,50)  |

Overall shape is a flower: hex 1 in the middle, the other six around it. Zones
fall on four near-circular rings around the centroid (232,166): radii 50 (6),
~77 (12), ~126 (12), ~161 (12). Treat the display as a disk in raw layout units;
per-axis normalization (`Canvas.pos` in `src/effects/lib.mjs`) distorts it about
5%. `src/effects/moon-phases.mjs` maps corner vertices onto the disk.

### Light diffusion (observed by the user)

Each zone's LED sits at a hexagon corner, at the vertex angle. Its light diffuses
widely across the flat top, and the inner side walls are reflective. Verified
from a photo with two single zones lit: one LED fills nearly the whole hexagon,
with a moderate hotspot at its corner and the far side still around half as bright.
Consequences:

- Zones are not crisp pixels. Within one hexagon, neighboring corners blend; the
  usable detail is roughly "which hexagon" plus "which side is brighter".
- Treat the light origin as the vertex (`sideLength` from the hex center), not the
  `positionData` x/y (about 0.75 x sideLength from center).
- The tile edges glow too: a lit tile shows a bright rim along its whole
  perimeter, strongest near the lit corner, and spills a halo onto the surface
  around it (verified from a photo).
- Physical cause (light guide, rim leakage): see [research.md](research.md).
- Structure-derived terms in the preview: two fading "arm" glows per LED along its
  adjacent edges (L housing, `GLOW_ARM`, `ARM_REACH`), rim plateau over the housing
  (`RIM_L_LEN`), rim dip at each edge midpoint connector (`RIM_MID_DIP`), and a
  blurred back-emission copy of each tile (`BACK_GLOW`). The midpoint dip is
  inferred from the connector windows, not yet seen in a lit photo.
- Color: `panelColor()` shows the requested RGB saturated, as-is (user preference);
  brightness per tile follows `tone()`, so 1 lit corner is close to 6.
- `docs/index.html` (`render()`, `GLOW_STOPS`, `paintZone()`, `rimLight()`) previews this as one radial gradient
  per LED centered on its vertex, screen-blended and clipped to the hexagon, plus
  per-edge rim lines and a blurred copy as the halo. Rim brightness is sampled at
  9 points per edge, summing per LED a near-field gaussian around its corner, a
  direct term scaled by the cosine of incidence on the wall (walls facing the LED
  are brightest), and a small ambient term. Corners are shared samples, so there
  are no jumps at vertices; butt caps avoid overlap hotspots under screen blending. The
  falloff values are fitted by eye to that photo, not measured.
- LED ramp (observed by the user): the panels ease each LED to a new color instead
  of switching, even with transition 0, so quick changes look softer on the wall.
  The preview eases each zone toward its target exponentially (`LED_FADE_MS` = 70,
  about 95% after 210 ms; `paintZone()` marks, `stepFades()` advances, `drawHex()`
  draws). The time constant is a by-eye estimate, not measured.

### Orientation (verified)

Layout y points up. With the default (unflipped) view, the photo matched: the
controller (`panelId 0`, buttons and cable) is on hex 0 at lower left, and lit
zones 1230 (hex 6, lower-left corner) and 18733 (hex 5, right corner) appeared on
the bottom-middle and lower-right hexagons with hotspots at those corners.

Color rendering: `[255,120,20]` shows as peach/salmon, `[230,240,255]` as cool
white. The panels render a warm-to-cool range, not saturated color.

Within a run, `o` steps by 60 degrees per corner. All code now groups by geometry
(see above) instead of relying on runs of 6 in list order.

## extControl v2 streaming

Enable once per session:

```json
PUT /effects {"write":{"command":"display","animType":"extControl","extControlVersion":"v2"}}
```

Then send UDP datagrams to `<ip>:60222`. Frame, all big-endian:

| Field          | Type | Notes                                   |
|----------------|------|-----------------------------------------|
| nPanels        | u16  | count of panel records that follow      |
| panelId        | u16  | from `positionData`                     |
| r, g, b, w     | u8   | w unused, send 0                        |
| transitionTime | u16  | units of 100 ms; 0 = instant (verified) |

No ack. ~20 fps (50 ms sleep) works. Panel ids from `/panelLayout/layout` are
accepted directly (verified). While streaming, `/effects/select` reports a
`*...*` pseudo-name.
