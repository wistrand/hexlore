# Gotchas and findings

## Contents
- Traps
- Findings

## Traps

- **Elements is warm-white only.** RGB values are accepted but render as warm/cool white. Design effects around brightness and warmth, not hue.
- **Panel ids exceed 255.** Use extControl v2 (u16 ids). v1 frames have u8 ids and won't address these panels.
- **`*Dynamic*` and other `*...*` selections are not real effects.** They can't be re-selected with `{"select": ...}`. When restoring after streaming, skip them.
- **Streaming mode persists.** The device stays in extControl after the sender stops, frozen on the last frame, until another effect is selected. Always restore in `finally`.
- **`GET /` on port 16021 returns 422 and `/api/v1/` returns 401 without a token.** That is normal, not a fault.
- **No avahi daemon on the dev machine.** `avahi-browse` fails with "Daemon not running". Discovery was done with raw mDNS/SSDP sockets in Python, bound to the LAN interface (machine also has docker/tailscale interfaces).
- **Port scans overwhelm the controller.** 400 parallel connects returned zero open ports; even 8 workers missed 6517. Closed ports are a mix of RST and silent drops, so full-range scans time out. Probe specific ports one at a time.
- **SVG filters on lines need user-space regions.** The default filter region is relative to the element's bounding box; a horizontal `<line>` has zero height, so the region collapses and the blurred stroke is cropped thinner than diagonal lines. `docs/index.html` sets `filterUnits="userSpaceOnUse"` with a region covering the whole drawing.
- **`pgrep -f`/`pkill -f` match the calling shell too.** A pattern taken from a server's command line also matches the bash command running pgrep, so `kill $(pgrep -f ...)` kills your own shell. Kill by a PID you recorded, or use a pattern that can't appear in your own command.
- **macOS blocks LAN access for unpermitted processes (macOS 15+).** A server started with `nohup` over SSH reaches the device only while the SSH session is open; after it exits, every request fails with `EHOSTUNREACH`. Tailscale traffic is unaffected, so the web UI still loads while the device is unreachable. On macOS, start `src/server.mjs` from Terminal.app and allow the Local Network prompt. See the finding below.
- **IP comes from DHCP.** If 192.168.50.108 stops answering, rediscover via SSDP `ST: nanoleaf:nl52` before assuming the device is down.

## Findings

### Streaming worked first try with layout ids

- **Symptom:** none; recorded because it was an open question.
- **Diagnosis:** firmware 12.4.1 accepts `positionData[].panelId` values directly in v2 frames for all 43 zones.
- **Takeaway:** no id translation layer needed.

### Zone structure and instant transitions

- **Symptom:** open questions: what the 43 zones are, and whether `transitionTime` 0 is instant.
- **Diagnosis:** the former `zones_demo.py` (now the `corners` effect) lit one zone at a time with transition 0. User confirmed each step lit exactly one corner of one hexagon, with sharp cuts.
- **Takeaway:** 7 hexagons x 6 corners; `panelId 0` is not a light. Use transition 0 for hard cuts, 1+ for smoothing.

### macOS Local Network privacy blocks a detached server

- **Symptom:** on a macOS 26 host, `src/server.mjs` started with `nohup ... &` over SSH served the page, but the panels did not react. The log showed `EHOSTUNREACH` (and once `EPIPE`) for 192.168.50.108. The same `fetch` run inside an open SSH session got 401 as expected.
- **Diagnosis:** Local Network privacy, per Apple [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy). It gates outgoing traffic to Wi-Fi/Ethernet subnets, multicast and broadcast, but not VPN interfaces. Automatically allowed: `launchd` daemons, root processes, and command-line tools run from Terminal or over SSH plus their children. `launchd` agents are not exempt. Inferred, not documented: the SSH exemption ends when the session exits, which matches a detached test script failing from its first request.
- **Takeaway:**
  - Run the server from Terminal.app and grant the prompt. Over SSH, `open -a Terminal <script>.command` launches it under Terminal.
  - For a headless service, use one of the two documented options: a `launchd` daemon (`/Library/LaunchDaemons`, `UserName` set to the user), or (macOS 15.5+) `sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array "192.168.50.108/32"` plus a reboot, which exempts that address for every process. Use `AllowedEthernetLocalNetworkAddresses` on wired hosts. Neither option was tested here.

### Touch ids are not layout ids

- **Symptom:** touch packets name tiles by ids such as 53901 that appear nowhere in `/panelLayout/layout`.
- **Diagnosis:** the layout lists corner zones only; touch reports one id per hexagon. An openHAB user saw the same on Elements. The touch id can be predicted from the corner ids; see [Tile and touch ids](architecture.md#tile-and-touch-ids).
- **Takeaway:** never look a touch id up in the layout. `learnTouch()` in `src/server.mjs` resolves it by prediction, with "Map touch" as fallback; `data/touch-map.json` caches the result.

### Touch mapping while tiles are still joining

- **Symptom:** after adding 5 tiles, one tile reacted to touch on the panel but a mapping run never accepted it.
- **Diagnosis:** its touch id 26199 had been assigned to another tile. The first touch came while the controller was still taking in tiles (layout 90, 6, 108, then 114 zones), so the touched tile was not in the run's list and its next touch claimed the lit tile. Later runs ignored 26199 as already known. The id structure in [Tile and touch ids](architecture.md#tile-and-touch-ids) tied 26199 to the stuck tile.
- **Takeaway:** auto-start now waits 15 s after a layout change, and runs let known ids claim the lit tile, so a bad entry can be fixed by remapping. The bad entry was removed by hand.
