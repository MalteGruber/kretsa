# kretsa: guide for the AI agent designing the PCB

`kretsa guide` prints this file plus the current state of the workspace. Run it at the start of a session.

You design a KiCad project by editing its files. A human watches the result live in the kretsa viewer (schematic, PCB, 3D,
libraries), points at things, draws on them, and sends you comments. You read them, change the design, check your work, and
answer, all through the `kretsa` command. kretsa never edits the design itself: you do, or the human in KiCad.

## Start here

1. `kretsa guide` (this), then read the workspace's CLAUDE.md / AGENTS.md: the human's own conventions (house style, part
   standards, fab rules) live there and win over anything generic here.
2. `kretsa status`: the project, its files, open comments, last check. `kretsa review`: the open comments in full.
3. Start `kretsa wait` **in the background** and work through what it returns (the loop below).

## The loop

1. `kretsa wait` blocks until the human presses **Send to AI**, then prints the comments they sent and exits. If comments were
   sent before you started it, it returns right away. Run it in the background (in Claude Code: a background Bash command;
   you are re-invoked when it exits). `--timeout SEC` gives up after SEC (exit 3).
2. Handle each comment: read the text, the anchors and the drawing, and **look at the snapshot PNG**. Make the change.
3. Verify: `kretsa check` (no NEW errors you caused), `kretsa diff` (what you changed), `kretsa render` (look at the result).
4. Answer: `kretsa reply <#> "what you changed and how you verified it" --addressed`.
   - `--wontfix` with the reason if it can't or shouldn't be done.
   - `--open` (or no flag) to ask a question; the comment stays open and the human's answer comes back through `kretsa wait`.
   - **Never resolve**: only the human resolves or reopens. A human reply or reopen sends the comment to you again.
5. Start `kretsa wait` again.

`kretsa review` lists every open comment at any time, including drafts the human hasn't sent yet (marked; they may change).

## Commands

Every command takes `-p <project>` (a path, or a name from `kretsa projects`). Output is markdown, or JSON with `--json`.
Commands work on the files directly; the viewer doesn't need to be running.

Review
- `kretsa wait [--timeout SEC] [--all]`: block until comments are sent (exit 0) or time out (exit 3). `--all` also returns
  open comments an earlier wait returned.
- `kretsa reply <comment> "text" [--addressed | --wontfix | --open]`: `<comment>` is the number shown in the viewer (`3`, `#3`)
  or the id.
- `kretsa review`: open comments as markdown, with anchors, drawings and snapshot paths.

Checking your work
- `kretsa check`: ERC + DRC + schematic/PCB parity, plus **what is new or fixed since your previous `kretsa check`**. Run it
  before and after each change. Library-lookup warnings are hidden (`--library` shows them). `--erc` / `--drc` for one side.
- `kretsa diff [since]`: parts added, removed, moved, re-valued or re-footprinted, pad nets and routing, since your last full
  `kretsa check` (default), since a comment was written (`kretsa diff 3`), or since a rev. The human sees the same list
  ("What changed?") on comments made before your change.
- `kretsa render sch|pcb|3d`: PNGs of the design to look at (the paths are printed).
  `--around U3,C7` crops to parts and marks them, `--net VBUS` or `--net U3.4` shows a net, `--sheet NAME` (sch),
  `--side top|bottom` (pcb, 3d), `--layers F.Cu,B.Cu` (pcb), `--size PX`, `--margin MM`.

Parts (symbol + footprint + 3D model, in the project's own libraries)
- `kretsa lib [query]`: parts in the libraries of the project's and workspace's `sym-lib-table` / `fp-lib-table`, with health
  checks (`--issues`: only parts with problems). KiCad's stock libraries are deliberately not used: you make every part.
- `kretsa lib show <part>`: fields, pin and pad tables, 3D model, issues, and renders of the symbol, footprint and 3D model.
  Look at the renders.
- `kretsa lib fp <Lib:Name>`: one footprint, also one no symbol uses.
- `kretsa lib check [query] [--klc]`: every issue as a checklist; `--klc` adds KiCad Library Convention style rules (the
  human's CLAUDE.md may deviate from them).
- `kretsa lib set <part> Field=Value ...`: set symbol fields safely (formatting kept, verified, atomic); `Field=` removes one.

Projects
- `kretsa status`: files, revision, comment counts, check summary.
- `kretsa projects` / `kretsa use <project>`: list projects / switch the current one (the human's viewer follows).

## Comments

Files, in the KiCad project directory:
- `.kretsa/review.json`: the source of truth (types: `shared/review.ts` in the kretsa repo). Use `kretsa reply`, not edits.
- `.kretsa/REVIEW.md`: a readable summary of open and addressed comments.
- `.kretsa/snap/<id>.png`: what the human was looking at (the canvas with their drawing burned in, or the part's
  symbol/footprint/3D view). Look at it.

`view` says where the comment was made: `sch`, `pcb`, `3d`, or `lib` (the library).

Anchors say what the human pointed at:
- `symbol` `{ref, uuid?}`: a schematic symbol or footprint, by refdes. Prefer `uuid` when present.
- `net` `{name}`; `pad` `{ref, pad}` (for example `U3.4`: also used for a schematic pin, connected or not).
- `point` `{at_mm}` and `area` `{bbox_mm}`: KiCad document coordinates in mm, in the file named by `file` (`sheet` for schematics).

`ink_shapes`: what the human drew. `covers` lists the parts a box or loop encloses; arrows give `from_ref` and `to_ref`,
meaning "move this there".

**Library comments** (`view: "lib"`) are about the parts you make:
- `part` is the symbol (`Lib:Name`) and `aspect` what the human was looking at: `symbol`, `footprint` or `3d`.
- `pin` `{pin, name?}` anchors are symbol pins; `pad` anchors carry the footprint id as `ref` (`{ref: "Lib:Footprint", pad: "1"}`).
- A library comment **without `part`** is a request for a new part: make the symbol, footprint and 3D model in the project
  libraries, check it with `kretsa lib show <part>` (look at the renders) and `kretsa lib check --klc`, then reply with the part id.

`sent` is when the human sent the comment to you; comments without it are drafts. `design_rev` records which design revision
the comment was made against: if the design changed since, re-check that the comment still applies (`kretsa diff <#>`).

## Rules

- Keep the KiCad files loadable by KiCad; prefer small, targeted edits. Re-run `kretsa check` after each change.
- Only touch the project and the libraries its lib tables point to.
- Don't commit, push, publish or upload anything unless the human asked for it.
- When something is ambiguous or risky (removing parts, changing the board outline, swapping a footprint), ask with
  `kretsa reply <#> "question" --open` instead of guessing.
- Replies: short and concrete. Refs, nets, values, before -> after.

## If you must edit review.json directly

Only append to `thread` (`{"author": "ai", "text": "…", "at": "<ISO time>"}`) and change `status` (never to `"resolved"`).
Write atomically (temp file, then rename), keep 2-space indentation, don't touch other fields or reorder comments.
