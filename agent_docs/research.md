# Research: physical build and optics of Elements hexagons

What the panels are made of and how light moves through them. Facts are marked
with their source; inferences are marked as such. Used to tune the light model in
`docs/index.html` (see [architecture.md](architecture.md) "Light diffusion").

## Contents
- Physical build
- Layout units vs millimetres
- Optics
- What the photos show
- Expansion and compatibility
- Sources

## Physical build

| Property            | Value                                          | Source                 |
|---------------------|------------------------------------------------|------------------------|
| Panel size          | ~23 cm corner to corner, ~20 cm flat to flat   | retail spec sheets     |
| Edge thickness      | 6 mm                                           | retail spec sheets     |
| Mounted thickness   | 10 mm (foam pad behind)                        | retail spec sheets     |
| Weight              | ~208 g                                         | retail spec sheets     |
| Face                | PVC laminate with wood-grain print, not veneer | spec sheets, reviews   |
| Output              | 22 lm per panel, 1500-4000 K whites only       | spec sheets            |
| Light zones         | 6, one per apex ("corner control technology")  | Nanoleaf via reviews   |
| Joining             | snap-on plastic connectors, controller on side | reviews                |

No public teardown found. LED type, driver, and the internal light-guide shape of
Elements are not documented.

## Layout units vs millimetres

`sideLength` 67 units = 115 mm side (230 mm / 2), so 1 unit is about 1.72 mm.
Check: apothem 58 units = 100 mm, matching the 20 cm flat-to-flat size.

## Optics

From Nanoleaf's patent application US 2021/0165154 ("coupled lighting panels",
same family as Shapes/Elements; it does not describe Elements specifically):

- LEDs inject light into a thin PMMA "light-transmitting body" from a recessed
  entry surface at the panel edge or apex; the triangle embodiment puts LED
  clusters at the apexes.
- Light travels inside the body by total internal reflection and is extracted
  through the front face by scattering microstructures (TiO2 particles,
  sub-millimetre indentations, laser-etched dimples).
- The body may taper away from the LEDs, and far edges can carry reflective
  material, both to even out output.
- Opaque structures cover the LED clusters, which leaves dark spots right at
  the source.
- Stated design goal: face output within 20% of the mean (5-15% preferred).

Inferred for Elements (consistent with the patent and the photos, not confirmed):

- Each apex LED feeds the whole 6 mm plate. Because light bounces many times
  before it scatters out, one LED lights nearly the whole face; the hotspot is
  the near field before the light mixes.
- The uniformity target is why a 1-corner tile looks almost as bright as a
  6-corner tile, and why detail inside a tile is limited.
- Light that reaches the side walls without being extracted leaks out of the
  edges: the bright rim, plus a halo on the wall behind.
- The dark notch at each corner is the opaque LED housing/connector.
- The printed laminate modulates transmission, so the grain shows when lit.

## Tile structure (user photos of a detached tile, 2026-10-17)

Observed:

- **Body:** one molded slab of translucent, milky cream plastic (diffusing, not
  clear). The back is flat in the middle with a raised ring of molded features
  around the perimeter.
- **Corners:** each of the 6 corners has an L-shaped (chevron) raised block that
  follows the corner angle, about 1/4 of each adjacent edge long. One per corner,
  matching the 6 corner zones, so these almost certainly house the LEDs.
- **Edge midpoints:** each of the 6 edges has a connector window at its midpoint
  showing a small white PCB with 3 contact pads. These are for the snap-on
  linkers (likely power, ground, data), so any edge can link to a neighbor.
- **Between corner and connector:** rectangular raised pads on each edge,
  probably wiring or driver cover. A PCB or flex ring likely runs around the
  perimeter inside the slab.
- **Face:** a separate wood-grain laminate layer with a slightly embossed grain and
  a small edge chamfer. The print shows in cross-section along the outer edge.
- **Center:** a round twist-lock mounting plate with an adhesive tab (front
  sticker: apply pressure, twist 30 degrees).
- **Label:** "Elements NL52, Input 42V DC 1A, 42W max, Class 2,
  NANOLEAF-NanoGrid Limited, Kowloon", date code 202527 (2025 week 27). That
  matches the controller serial S2527...
- Faint straight lines run inward from some corner blocks, visible through the
  back. Unclear whether these are molding seams, internal boundaries, or
  scratches.

Inferred optics, updating the patent-based picture above:

- The slab scatters light throughout its volume, so it is a diffuser rather than
  a clear light guide with printed dots. That gives the near-uniform face.
- The L-shaped corner blocks spread each LED's light along both adjacent edges
  near the corner. That gives a wide hotspot and bright rim near a lit corner.
- The translucent back lets light out behind the tile. Together with edge
  leakage, that produces the halo on the wall.
- The connector windows and pads at edge midpoints may make the rim slightly
  dimmer at the middle of each edge. Not yet checked against a lit photo.

## What the photos show

User photos taken with the panels on the floor (2026-10-17):

- One lit corner fills nearly the whole tile, with a moderate hotspot at that corner.
- Tiles with 1, 2, 4 and 6 lit corners look nearly equally bright.
- `[255,150,50]` renders as soft peach/salmon; `[230,240,255]` as cool white.
- Seams between lit tiles are bright lines; small dark notches at the corners.
- The whole assembly casts a soft halo on the surface around it.

## Expansion and compatibility

Limits for Elements hexagons, from the Nanoleaf spec sheet (123led PDF):

| Limit                     | Value |
|---------------------------|-------|
| Max panels per controller | 80    |
| Max panels per 42 W PSU   | 21    |
| Power per panel           | 2 W   |

7 existing + 13-pack (NL52-K-3002HB-13PK) = 20 hexagons, within both limits. A
starter kit ships with its own controller and PSU. One layout uses one controller.
Extra PSUs can join the same layout. Nanoleaf says never to mix 42 W and 75 W PSUs
in one setup (search excerpt, page not read).

Placement and run length (web search 2026-10-31; official placement page not
found, mostly third-party sources):

- No published limit on chain length or run shape; the binding limit is the power
  budget. Some retailers and a repair guide say 22 Elements per 42 W PSU, not 21.
  The 14-tile layout draws about 28 W, within one PSU.
- Controller and PSU can attach to any panel (Nanoleaf quick-start guide).
- Near or over the PSU limit, panels farthest from the power input dim first
  (voltage drop; [Trunetto](https://www.trunetto.com/troubleshooting/smart-lighting/nanoleaf/nanoleaf-panels-uneven-brightness)).
  Fix: fewer panels, or a second PSU on a free linker. Inferred, not official: a
  power input near the middle of a large layout shortens the longest run.
- A single dim or flickering panel is usually a loose or dirty linker. Moving the
  panel elsewhere separates a bad panel from a bad connection.
- A tile that lights but is missing from `/panelLayout/layout` fits a linker that
  carries power but not data (inferred); reseat it.
- Open question: whether closed loops of linkers are allowed or matter. Nothing found.

Shapes figures, for comparison (Nanoleaf manual via search excerpts; pages
returned 429): 500 panels per controller; per 42 W PSU about 21-22 Hexagons,
28 Triangles, 77-78 Mini Triangles. Sources disagree by one panel.

Physical compatibility, from Nanoleaf's FAQ "Connecting Different Nanoleaf
Devices" (text pasted by the user, 2026-10-23; the page returns 403 to fetches):

| Product line                         | Connects physically to                     |
|--------------------------------------|--------------------------------------------|
| Elements                             | Shapes (same linkers)                      |
| Shapes (Hexagons, Triangles, Minis)  | each other, Elements; Blocks (rigid only)  |
| Blocks                               | Shapes, rigid linkers only (not flex)      |
| Lines                                | only Lines (own connectors)                |
| Canvas, Light Panels (original)      | nothing else, not each other               |
| Skylight                             | not covered by the FAQ; unknown            |

- Elements stay white-only in a mixed layout. The FAQ notes wood or white next to
  Shapes may look off, and suggests Black Shapes.
- Products that cannot connect physically can still be controlled together with
  Group Scenes in the Nanoleaf app (same home/account). Each remains a
  separate device on the LAN API.

Open questions:

- Whether the 80-panel limit or the Shapes 500-panel limit applies to a mixed
  Elements + Shapes layout.
- How many zones a Shapes panel exposes in `panelLayout` and which `shapeType`
  ids it uses. The tile grouping (`effectContext()` in `src/effects/lib.mjs`,
  `tiles()` in `src/server.mjs`) and the corner light model in `docs/index.html`
  assume 6-zone Elements hexagons.

## Sources

- [TechRadar launch article](https://www.techradar.com/news/nanoleaf-gives-smart-lighting-a-classy-wood-like-finish-with-new-elements-range)
- [Review Geek: corner control technology](https://www.reviewgeek.com/86190/nanoleafs-new-element-shapes-bring-a-woodgrain-look-to-your-smart-home/)
- [Pocket-lint review](https://www.pocket-lint.com/smart-home/reviews/157741-nanoleaf-elements-review)
- [Tech Advisor review](https://www.techadvisor.com/article/722566/nanoleaf-elements-review-2.html)
- [HomeKit News: light through the material](https://homekitnews.com/2021/06/04/new-nanoleaf-elements-hexagons-announced-and-more/)
- [123led spec sheet (PDF)](https://www.123led.nl/pdf/LNA00036.pdf)
- [John Lewis listing](https://m.johnlewis.com/nanoleaf-elements-hexagon-starter-kit-7-led-panels-cool-warm-white/p5708328)
- [US 2021/0165154 A1, Nanoleaf coupled lighting panels](https://patents.google.com/patent/US20210165154A1/en)
- [Nanoleaf FAQ: Connecting Different Nanoleaf Devices](https://support.nanoleaf.me/hc/en-us/articles/37748558919956-FAQ-Technical-Connecting-Different-Nanoleaf-Devices)
- [Nanoleaf Shapes manual: Large Installations](https://nanoleaf.me/en-AU/products/nanoleaf-shapes/get-started/large-installations/)
- [Nanoleaf Shapes 42W Power Supply](https://nanoleaf.me/en-US/products/nanoleaf-shapes/42w-power-supply-each/)
