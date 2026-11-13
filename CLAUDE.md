# kretsa

A local, web-based viewer for KiCad projects (schematic, PCB, 3D). It is the **review channel between a
human and an AI agent that is designing a PCB**. The agent edits the KiCad files. The human
watches the result live in the browser, then points at things, draws on them, and leaves comments.
Those comments are saved in a form the agent can read and act on.

The viewer is **read-only toward KiCad files**. It never writes `.kicad_sch` or `.kicad_pcb` files.
Only the AI agent (or the human in KiCad) changes the design. The viewer's only output is review data.

## Core loop

1. The agent writes or changes files in a KiCad project dir (`*.kicad_pro`, `*.kicad_sch`, `*.kicad_pcb`).
2. The server watches the dir, regenerates derived assets (the 3D GLB, and optionally SVG or netlist), and
   pushes a reload to the browser.
3. The human views the sch, pcb, or 3D tab, selects items or areas, sketches, and writes comments.
4. The comments are saved to `<project>/.kretsa/` as plain JSON plus PNG snapshots, as drafts until the human
   presses **Send to AI** (or posts with Send).
5. The agent, blocked in `kretsa wait` (run in the background), gets the sent comments, makes the changes, verifies
   them (`kretsa check`, `diff`, `render`) and answers with `kretsa reply <#> "…" --addressed`. The human then
   resolves or reopens (a human reply or reopen sends the comment again).

## Architecture

```
kretsa/
  shared/   contract types: review.ts (review.json), check.ts (ERC/DRC report), netlist.ts, library.ts, diff.ts
  core/     @kretsa/core: all project logic, no HTTP (scan, kicad-cli wrappers, review store, checks)
  cli/      @kretsa/cli: the `kretsa` binary. Agent-facing (markdown out, --json), plus `kretsa serve`
  server/   @kretsa/server: thin HTTP + WebSocket layer over core, exists only for the web UI (startServer())
  web/      Vite + TS frontend: Schematic | PCB | 3D, comments, drawing, checks
  vendor/   kicanvas (git submodule). Do not edit in place without noting it here
  docs/     review-format spec (agent instructions)
```

- **Rule:** logic lives in `core/`. The CLI and the server are thin wrappers so they always give the same answers.
  An MCP server, if added, is a third wrapper.
- **The CLI works on project files directly.** The web server does not need to be running (except for `serve`). `review.json` is
  the source of truth. The server watches it, so CLI writes appear live in the browser.
- **Runtime**: Bun (`~/.local/bin/bun`), Node 22 via nvm. Use Bun for everything unless there is a reason not to.
- The server watches the project dir (debounced), runs `kicad-cli` for derived assets cached by hash (GLB, netlist, checks),
  serves the raw KiCad files, and pushes `{type:"reload"}` / `{type:"review"}` over WebSocket.

## Library scan (Nov 2026)

| Need | Choice | Notes |
|---|---|---|
| 2D sch + pcb rendering in browser | **KiCanvas** (theacodes/kicanvas, MIT, TS, WebGL/Canvas2D) | Parses KiCad 6+ s-expr files directly, no server needed. Read-only, web-component based. **No 3D.** Not a polished npm lib, so vendor or fork it and hook into its viewer, selection, and coordinate APIs for annotations. |
| Alt 2D + 3D + BOM | ecad-viewer (Huaqiu-Electronics, KiCanvas fork) | Adds 3D via a kicad-cli→GLB server endpoint, a BOM view, and Altium files. Heavier, partly Chinese UI. Mine it for ideas or code, but don't base on it. |
| 3D | **`kicad-cli pcb export glb`** + **three.js** (GLTFLoader, OrbitControls) | Useful flags: `--subst-models --include-tracks --include-pads --include-zones --include-silkscreen --include-soldermask`, and `--define-var KIPRJMOD=<dir>` so model paths resolve. Optionally compress with gltfpack/meshopt. Docker kicad-cli builds have been reported to drop GLB colors. |
| STEP in browser (fallback) | occt-import-js | Only needed if GLB export is insufficient. |
| Server-side parsing (nets, refdes, UUID lookup) | kiutils / kicad-skip (Python), or a small TS s-expr parser | Prefer TS in-process. KiCanvas already contains an s-expr parser that can be reused server-side. |
| Live KiCad link (optional, later) | KiCad IPC API + `kicad-python` | KiCad 9/10: PCB only, no schematic, no export (export arrives in KiCad 11). Not needed for the file-based loop. |
| Prior art: design review | KiCAD-Prism (Apache-2.0) | Self-hosted review platform. Comments are stored in SQLite, with export to `.comments/comments.json`. Worth reading before designing the review format. |
| Prior art: visual diffs | KiRI, kidiff, plotgitsch | Useful later for a "what changed since the last review" overlay. |

**Environment**: KiCad **10.0.8** AppImage, extracted to `~/.local/opt/kicad-10.0.8/squashfs-root/`.
`~/.local/bin/kicad-cli` and `~/.local/bin/kicad` are wrapper scripts around its `AppRun`. The bundled
stock libraries are in `.../share/kicad/` (`3dmodels/`, `footprints/`, `symbols/`, `demos/`). The server
detects kicad-cli and degrades gracefully without it, so 2D still works.

**kicad-cli GLB export findings (verified on 10.0.8):**
- The stock 3D library is shipped as **STEP only**, while many boards reference `….wrl`. `--subst-models`
  does **not** fall back when the `.wrl` is missing. The fix in `server/src/kicad.ts` exports from a temp copy
  with stock-library `.wrl` paths rewritten to `.step`, and passes `-D KIPRJMOD=<real project dir>`.
- Legacy path vars (`KISYS3DMOD`, `KICAD6_3DMODEL_DIR`, …) already resolve to the bundled library.
  `--define-var` only sets project text vars, and setting env vars changes nothing.
- GLB node names are the bare refdes (`U2`, `J7`, …), so 3D click-to-pick by node name works. Mesh units are metres.
- Export takes about 6 s for an approximately 90-part board (stickhub), so the cache matters.

## Review data format (`<project>/.kretsa/review.json`)

This is the contract with the AI agent, so keep it stable, human-readable, and diff-friendly.

```jsonc
{
  "version": 1,
  "comments": [
    {
      "id": "c_01H...",               // ulid
      "status": "open",               // open | addressed | resolved | wontfix
      "view": "pcb",                  // sch | pcb | 3d
      "sheet": "/power/",             // sch only: sheet path
      "layer": "F.Cu",                // pcb only, optional
      "anchors": [                    // what the human pointed at. Prefer stable KiCad identities
        { "kind": "symbol", "ref": "U3", "uuid": "..." },
        { "kind": "net", "name": "VBUS" },
        { "kind": "area", "bbox_mm": [x1, y1, x2, y2] },     // KiCad document coords, in mm
        { "kind": "point", "at_mm": [x, y] }
      ],
      "ink": "ink/c_01H....svg",      // optional freehand sketch, in document coords (mm)
      "snapshot": "snap/c_01H....png",// rendered view + annotations, so the agent can look at it
      "text": "Move C12 closer to U3 pin 4, keep loop small",
      "design_rev": "sha256:...",     // hash of the files when the comment was made
      "thread": [ { "author": "ai", "text": "Moved C12 to ...", "at": "2026-11-08T..." } ],
      "created": "2026-11-08T...",
      "sent": "2026-11-08T..."        // when the human sent it to the agent; unset = draft
    },
    {                                 // a library comment
      "view": "lib", "part": "Proj:LM1117", "aspect": "footprint",   // symbol | footprint | 3d; no part = new part request
      "anchors": [ { "kind": "pin", "pin": "3", "name": "VI" }, { "kind": "pad", "ref": "Proj:SOT-223", "pad": "4" } ], ...
    }
  ]
}
```

Rules:
- Always store geometry in **KiCad document coordinates (mm)**, never in screen pixels, so anchors
  stay valid across zoom levels and re-renders.
- Prefer semantic anchors (refdes, UUID, net, pad `U3.4`) over bare geometry, and add geometry as context.
- Write files atomically (write to a temp file, then rename). Both the agent and the server may touch
  this file. The agent may only append to `thread` and change `status`, normally through `kretsa reply`
  (`ReviewStore.patch`, which refuses `resolved` from the agent and re-sends on human replies/reopens).
- `kretsa wait` remembers what it returned in `.kretsa/agent.json` (`seen` = latest `sent`).
- Also generate `.kretsa/REVIEW.md`, a readable summary of the open comments, for agents that work
  better from markdown.

## Conventions

- TypeScript everywhere (strict). Keep the frontend framework-light: vanilla TS + web components to
  match KiCanvas. Add a framework only if the UI really needs one.
- KiCad files are the source of truth. Never cache them in a way that can go stale. The file
  hash is the cache key.
- Put test fixtures in `fixtures/` (small real KiCad 8, 9, and 10 projects). KiCanvas compatibility with
  newer file versions is the main risk, so add a fixture whenever a parse failure shows up.
- Use the browser (claude-in-chrome) to verify UI changes visually, not just type-checks.

## Commands

```sh
git submodule update --init         # vendor/kicanvas
bun install
bun run build:kicanvas              # builds vendor/kicanvas -> web/public/vendor/kicanvas.js (gitignored)
bun link                            # optional: puts `kretsa` on PATH (else: bun run kretsa <cmd> / bun cli/src/main.ts)

kretsa serve [dir]                  # web viewer for a workspace or project dir (default cwd), :7777, LAN-reachable
kretsa projects | use <project>     # list projects / switch the current one (the open viewer follows)
KRETSA_PROJECT=/path bun run dev    # frontend dev: server :7777 + Vite HMR :5177 (no project: fixtures/stickhub)
kretsa check [project]              # ERC + DRC + parity, markdown, new/fixed since last `kretsa check`
kretsa status | review [project]    # summary / open comments as markdown
kretsa wait | reply <#> "…" --addressed   # the agent's side of Send to AI
kretsa diff [since] | render sch|pcb|3d [--around U3] [--net X]   # what changed / images to look at
kretsa lib check [--klc] | lib set <part> F=V                     # part lint / safe field edits
kretsa lib [query] | lib show <part> | lib fp <Lib:Name>   # parts, detail + renders (PNG) for the agent
kretsa theme [init]                 # the user's color file (~/.config/kretsa/theme.json): layers, schematic, highlight
bun run typecheck
```

**Workspace** (`core/src/workspace.ts`): any folder with KiCad projects, or a single project folder. Projects are discovered up to
5 levels deep, including nested ones. A project scan stops at subfolders that have their own `.kicad_pro`. The **current project** is
shared by viewer and agent through `<workspace>/.kretsa/workspace.json`. `kretsa use` writes it; the server watches it and
broadcasts `{type:"project"}`, and the page reloads. Picking a project in the viewer (`P`, or click the breadcrumb) writes it too.
CLI project resolution: the `[project]` arg (a path, or a name/id) → `$KRETSA_PROJECT` → the project containing cwd → the workspace's
current project. The workspace root is `$KRETSA_WORKSPACE`, else the nearest ancestor with `.kretsa/workspace.json`, else cwd.
kretsa is generic (open source): personal standards and preferences belong in the user's workspace CLAUDE.md, not here.

Servers listen on all interfaces (LAN: `http://<lan-ip>:7777`, or `:5177` in dev). **There is no auth**, so use trusted networks only.
`--host 127.0.0.1` / `KRETSA_HOST` keeps it local. Env vars: `KRETSA_PROJECT`, `KRETSA_PORT` (7777), `KRETSA_HOST`,
`KICAD_CLI` (defaults to `kicad-cli` on PATH), `KRETSA_THEME` (color file).

**Libraries** (`core/src/library.ts`, `render.ts`, `library-md.ts`; types in `shared/library.ts`): only libraries in the
`sym-lib-table`/`fp-lib-table` of the project and the workspace root. KiCad's global tables and stock libraries are deliberately
ignored, because in a kretsa workflow the agent authors every part. A part is symbol + footprint + 3D model. The generic checks are:
footprint resolves, pin↔pad numbers match, courtyard present, model present and not a stock path, plus Reference/Value.
House style (field sets, KLC deviations) is the user's workspace CLAUDE.md's business, not kretsa's. Renders go to
`<project>/.kretsa/parts/<id>/`: symbol and footprint via `kicad-cli sym|fp export svg` → resvg PNG, and 3D via a scratch board
(footprint at the origin, model paths absolute, board version = footprint's) → `kicad-cli pcb render` top/iso/side.

The web **Library** mode (`web/src/library-view.ts`, key `5`) shows the same data: a part list with issue badges, and per part the
symbol and footprint (kicad-cli SVGs, cached in `.kretsa/parts/` until the library file changes), 3D (GLB of the scratch board), and pin/pad/field
tables. Library file changes broadcast `{type:"lib"}`; libraries outside the project dir (absolute or `${ENV}` paths in a lib
table) get their own watchers, refreshed when a lib table changes. Comments in Library mode go to the selected part (`view:"lib"`,
`part`, `aspect`): the tiles' Comment buttons set the aspect, pin/pad rows add anchors, "Request a new part" comments without a
part. The server attaches the symbol/footprint render as the snapshot; 3D comments snapshot the three.js tile.
**KLC** (`core/src/klc.ts`) is an opt-in generic subset of the KiCad Library Conventions (`klc_<rule>` issues; `--klc`,
`?klc=1`, the KLC checkbox). `core/src/lib-edit.ts` (`kretsa lib set`) splices symbol field values, verifies, writes atomically.

**Checks** (`core/src/check.ts`): `kicad-cli sch erc` and `pcb drc --schematic-parity` (JSON, mm), normalized to `CheckReport`
(sources: erc, drc, unconnected, parity). Library-lookup types (`lib_symbol_issues`, `footprint_link_issues`, …) are flagged
`library` and hidden by default. They are noise until project libraries exist. Cached per rev in `.kretsa/check/<rev>.v<N>.json`.
`kretsa check` diffs against `.kretsa/check/baseline.json` (its own previous full run) to show NEW and FIXED. kicad-cli
creates a `.kicad_prl` next to its input; `runCli` deletes it if it wasn't there before.

**Design geometry, renders, diffs**: `core/src/design.ts` parses board (footprints, pads with nets, tracks, vias, zones, edge)
and schematic sheets (placed symbols with all instance refs, pin positions, bboxes) from the files. `design-render.ts`
(`kretsa render`) exports `kicad-cli sch|pcb export svg` (document mm; cached per rev/hash in `.kretsa/cache/`), crops the
viewBox around parts/nets, overlays magenta marks and rasterizes with resvg. kicad-cli's invisible `<text>` copies are used to
find which schematic page shows a ref, and stripped before rasterizing (resvg panics on some when zoomed). `diff.ts` keeps copies
of the design files per rev in `.kretsa/revs/<rev>/` (on comment creation and full `kretsa check`, newest 50) and diffs parts,
pad nets and routing (`kretsa diff`, `GET /api/diff?since=`).

## Code map

- `shared/review.ts`: **the review contract** (review.json), so change it carefully. `shared/check.ts`, `shared/netlist.ts`.
- `core/src/`: `project.ts` (scan + hash, `findProjectDir`, `rootSchematic`/`mainPcb`, `.wiber`→`.kretsa` migration),
  `kicad.ts` (kicad-cli detection, GLB export cached in `.kretsa/cache/<hash>.glb`, netlist), `review.ts` (review store:
  atomic writes, REVIEW.md, snapshot PNGs, ink SVG), `check.ts` (ERC/DRC, diff, markdown).
- `core/src/design.ts`, `design-render.ts`, `diff.ts`, `klc.ts`, `lib-edit.ts`: see above.
- `cli/src/main.ts`: `kretsa` commands. `server/src/server.ts`: `startServer()` with routes, WebSocket and watcher.
- `web/src/main.ts`: app state, panes, selection and cross-probing, comments, drawing, checks tab.
  `kicanvas-view.ts` wraps KiCanvas (picking, nets, camera, capture). `nets.ts` holds schematic connectivity. `ink.ts` holds drawing.
  `kicad-theme.ts` holds canvas colors. `three-view.ts` is the GLB viewer (lazy-loaded).
- `docs/review-format.md`: instructions for the AI agent on consuming and updating review.json.
- `fixtures/stickhub/` (USB hub, local 3D models, about 90 parts) and `fixtures/pic_programmer/` (hierarchical
  sheets): KiCad's own demo projects, from `share/kicad/demos` or gitlab kicad/code/kicad `demos/`.

## UI

Colors follow VS Code "Dark Modern" (CSS vars in `style.css`). The KiCanvas canvases are recolored at runtime by
`kicad-theme.ts`, because KiCanvas has no theme API: it mutates its shared Color objects, then calls `paint()`.
**Canvas colors are user preferences**: `shared/theme.ts` (defaults, `resolveTheme`: board keys are KiCad layer names or KiCanvas
theme keys, normalized to theme paths like `copper.f`), `core/src/theme.ts` (`$KRETSA_THEME`, else `~/.config/kretsa/theme.json`;
`kretsa theme [init]`), `GET /api/theme`; the server polls the file and broadcasts `{type:"theme"}`, and the page re-applies
(`KiCanvasView.refreshTheme`, `ThreeView.applyTheme`). Also `highlight.net` / `selection` / `breathe_seconds` and `3d.background`. Layout borrows from enterprise EDA web viewers. The top bar has view tabs (Schematic | PCB | 3D). The left panel has
Documents and Components (searchable). The right panel has Comments, Properties of the selection, and Checks (ERC/DRC list; click to jump to the location, marked `!`). A floating
toolbar sits at the bottom (Fit, Zoom to selection, Comment mode, Draw, Toggle panel), and the PCB view has a layer bar
(click focuses a layer, right-click shows or hides it). Comments appear as numbered pins on the canvas and follow
the camera. Keys: `C` comment mode (click to drop a pin), `D` draw, `F` fit, `Z` zoom to selection, `1`–`5` views (also `#sch`…`#lib` in the URL), `P` projects, `[` panel, `?` help overlay (also the toolbar's ? button), `Esc`.

**Cross-probing:** one selection, keyed by refdes, is shared by every pane (`state.selectedRef` in `main.ts`) and kept across
view switches. The **Sch + PCB** mode (`#split`) runs two KiCanvas viewers side by side. Selecting in one selects and
zooms in the other, switching schematic sheets if needed (`KiCanvasView.selectRef`). In 3D, the selected part is tinted and
framed (`ThreeView.highlight`). Components-list clicks, comment cards and 3D picks all go through `selectRef()`.

**Net cross-probing** (`selectNet()` in `main.ts`, `web/src/nets.ts`): KiCanvas has no schematic connectivity and only picks
symbols, so `buildSheetGroups` unions wires, junctions, labels and symbol pins of the displayed sheet geometrically and names each
group from the kicad-cli netlist (`GET /api/netlist`) by pin votes. Nets are matched between sch and pcb **by shared pins**
(`U3.4`), with the name as fallback. Click a wire or label (sch), or a track, via or zone fill (pcb) to select a net. A second click on a pad of the
already-selected footprint selects that pad's net. Sch highlight is an SVG overlay (`svg.netlayer`). PCB uses KiCanvas' native
`highlight_net`, which shares the overlay layer with the selection box. 3D tints every part on the net. We replace `viewer.on_pick`
on both viewers. Pads are not in KiCanvas' bbox index, so they are hit-tested by geometry (`padAt`).
The highlight **breathes** (theme `highlight.breathe_seconds`, 0 = steady): sch via a CSS opacity animation on `svg.netlayer`,
pcb by pulsing the overlay layer's opacity (~30 redraws/s, only while a net is lit; `paintPcbNet` is KiCanvas' `paint_net` with the
theme color, since `highlight_net` hard-codes white), 3D by pulsing the emissive intensity. The 3D view renders on demand otherwise.

**Drawing** (`ink.ts`, `bindInk` in `main.ts`): pen, box and arrow strokes on sch/pcb, stored in document mm. On post, each shape is
summarized into `ink_shapes`: `covers` = parts enclosed by a box or loop, or touched by an open stroke; arrows get `from_ref`/`to_ref`.
Referenced parts and an overall `area` are added as anchors. The server writes `ink/<id>.svg` and describes the shapes in
REVIEW.md. A cropped PNG with the ink burned in becomes the snapshot (`KiCanvasView.capture()` renders WebGL synchronously and
copies the canvas in the same task, because there is no preserveDrawingBuffer).

**Send to AI**: the composer has Send (post + send all drafts, Ctrl+Enter) and Draft (Ctrl+Shift+Enter). Drafts show a "draft"
pill and a Send button; the top bar's Send to AI button and the bar above the composer send all of them (`POST /api/review/send`).
**What changed?**: comments whose `design_rev` differs from the current rev get a button that lists `/api/diff` and draws changed
parts as dashed boxes on the canvas (`state.diff`, `diffMarkup`).
Drafts can be edited (`PATCH {text}`, drafts only) and deleted (`DELETE /api/review/comments/:id`, drafts only; two-click
confirm, no modal). The status bar shows whether an agent is in `kretsa wait` (`GET /api/agent`; `wait` writes its pid to
`.kretsa/agent.json`, the server checks the pid is alive and broadcasts `{type:"agent"}`). The Components search also lists
matching nets. Draw is disabled in 3D-only mode. PCB layers: long-press on touch toggles visibility.

**Phone** (`max-width: 820px`): side panels become drawers (hamburger and comments button), split stacks vertically, toolbar
icons only. KiCanvas supports touch pan and pinch natively. The draw catcher uses `touch-action: none`.

### KiCanvas integration gotchas (verified)

- Use `controls="basic"`. With `"none"`, KiCanvas **disables all interaction** (no pan, zoom or select).
- The embed's `theme` attribute is **not** passed down to the viewers. Themes come from localStorage
  `kc:prefs:theme` = `{"val":"kicad"}`, set before the bundle loads. `kc:prefs:alignControlsWithKiCad` makes the wheel zoom.
- `kicanvas:select` is dispatched on the internal **viewer object, a plain EventTarget**. It never reaches
  `document`, so listen on `app.viewer`. Get the viewer fresh every time, because KiCanvas replaces it after the first render.
- Don't `remove()` KiCanvas internal elements, because that breaks its DisposableStack. Hide them with `style.display`.
- PCB picks hitting both a footprint and a net go through `viewer.contextMenuCallback`. We override it to prefer the
  footprint, and wrap `handleItemClick` to surface net clicks.
- KiCanvas's `@no_self_recursion` decorator uses **one flag per method shared by all viewer instances**. Calling
  `otherViewer.select()` from inside a `kicanvas:select` handler is silently dropped, so defer it (`setTimeout`).
  Programmatic selects are made "quiet" in `KiCanvasView` so they don't echo back as user selections.
- `Viewer.draw()` queues one `requestAnimationFrame` per call, so every wheel/touch/drag event was a full redraw, often
  many per frame (measured ~20 on a wheel burst). `coalesceDraws` (kicanvas-view.ts) patches the base Viewer prototype once
  so draws coalesce to one per frame. Avoid per-frame DOM writes in overlays (pins move by `transform`, only on change):
  KiCanvas calls `getBoundingClientRect()` on every draw and mouse move, which forces a layout if the DOM is dirty.
- Picking uses the last `mousemove` position. Browser automation must dispatch `mousemove` before `click`
  (see the JS snippets used during testing: `canvas.dispatchEvent(new MouseEvent("mousemove", …))`).

## API

`GET /api/workspace` · `POST /api/workspace/current {id}` · `GET /api/project` · `GET /api/netlist` · `GET /api/check` · `GET /api/lib` · `GET /api/lib/part?id=` · `GET /api/lib/asset?id=&f=symbol_unitN.svg|footprint.svg|part.glb` · `GET /project/<file>` (raw) · `GET /api/3d.glb` · `GET /api/review` ·
`POST /api/review/comments` · `PATCH /api/review/comments/:id` `{status?, reply?}` · `POST /api/review/send` `{ids?}` ·
`DELETE /api/review/comments/:id` · `GET /api/agent` · `GET /api/theme` · `GET /api/diff?since=<rev>` · `GET /api/components` · `?klc=1` on `/api/lib*` · `GET /kretsa/<path>` ·
`WS /ws` → `{type:"reload", rev, changed[]}` | `{type:"review"}` | `{type:"project", id}` | `{type:"lib"}` | `{type:"agent"}` | `{type:"theme"}`

## Roadmap / known gaps

- Drawing on library renders (library comments anchor pins/pads and attach the render, but no ink yet).
- `kretsa diff` only knows revisions kretsa kept; a git-based fallback would cover older revs.
