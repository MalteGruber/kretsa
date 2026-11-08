# kicad-wiber

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
4. The comments are saved to `<project>/.wiber/` as plain JSON plus PNG snapshots.
5. The agent reads `.wiber/review.json`, makes the changes, and marks each comment `addressed` with a
   short note. The human then resolves it or reopens it.

## Architecture (planned)

```
kicad-wiber/
  server/      Bun/TS: file watcher, kicad-cli runner, static + REST + WebSocket, review store
  web/         Vite + TS frontend: tabs for Schematic | PCB | 3D, annotation layer, comment panel
  vendor/      kicanvas (git submodule or fork). Do not edit in place without noting it here
  docs/        review-format spec, decisions
```

- **Runtime**: Bun is installed (`~/.local/bin/bun`), Node 22 is available via nvm. Use Bun for
  the server and package management unless there is a reason not to.
- **Server** responsibilities: `fs.watch` with debounce on the project dir. Run `kicad-cli` for
  derived assets and cache them by file hash. Serve the raw KiCad files to the frontend. Push
  `{type:"reload", files:[...]}` over WebSocket. Read and write `.wiber/review.json`.
- **Frontend** responsibilities: render sch and pcb in 2D, render 3D, and provide an overlay layer for
  pins, rectangles, and freehand ink on all three views. Comment threads go in a side panel.

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

## Review data format (`<project>/.wiber/review.json`)

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
      "created": "2026-11-08T..."
    }
  ]
}
```

Rules:
- Always store geometry in **KiCad document coordinates (mm)**, never in screen pixels, so anchors
  stay valid across zoom levels and re-renders.
- Prefer semantic anchors (refdes, UUID, net, pad `U3.4`) over bare geometry, and add geometry as context.
- Write files atomically (write to a temp file, then rename). Both the agent and the server may touch
  this file. The agent may only append to `thread` and change `status`.
- Also generate `.wiber/REVIEW.md`, a readable summary of the open comments, for agents that work
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
WIBER_PROJECT=/path/to/kicad/project bun run dev   # server :7777 + vite :5173 → open http://localhost:5173
bun run typecheck
bun run build && bun run start /path/to/project    # prod: server also serves web/dist on :7777
```

Env vars: `WIBER_PROJECT` (or the first CLI arg to the server; defaults to `fixtures/stickhub`), `WIBER_PORT` (7777),
`KICAD_CLI` (defaults to `kicad-cli` on PATH).

## Code map

- `shared/review.ts`: types shared by server and web. This is **the review contract**, so change it carefully.
- `server/src/index.ts`: Bun.serve routes, WebSocket broadcast, project file watcher.
  `project.ts` scans and hashes files. `kicad.ts` handles kicad-cli detection and GLB export, cached in `.wiber/cache/<hash>.glb`.
  `review.ts` holds the review store (atomic writes, REVIEW.md generation, snapshot PNGs).
- `web/src/main.ts`: app state, tabs, comment panel. `kicanvas-view.ts` mounts `<kicanvas-embed>` and
  maps `kicanvas:select` events to anchors. `three-view.ts` is the three.js GLB viewer (lazy-loaded).
- `docs/review-format.md`: instructions for the AI agent on consuming and updating review.json.
- `fixtures/stickhub/` (USB hub, local 3D models, about 90 parts) and `fixtures/pic_programmer/` (hierarchical
  sheets): KiCad's own demo projects, from `share/kicad/demos` or gitlab kicad/code/kicad `demos/`.

## API

`GET /api/project` · `GET /project/<file>` (raw) · `GET /api/3d.glb` · `GET /api/review` ·
`POST /api/review/comments` · `PATCH /api/review/comments/:id` `{status?, reply?}` · `GET /wiber/<path>` ·
`WS /ws` → `{type:"reload", rev, changed[]}` | `{type:"review"}`

## Roadmap / known gaps

- Annotation overlay: rectangles and freehand ink in document mm, for both sch and pcb. This needs KiCanvas's
  viewer camera/transform, which means hooking into `vendor/kicanvas/src/viewers/base/viewer.ts` rather than the
  embed tag.
- 2D snapshots. KiCanvas's canvas is inside shadow DOM without `preserveDrawingBuffer`.
- Preserve pan and zoom across reloads. Show comment pins on the canvas. Click a comment to zoom to its anchor.
- Net and pad selection. Today only symbols/footprints (refdes) and generic `at` points come from `kicanvas:select`.
- Diff overlay: what changed since the `design_rev` of a comment.
