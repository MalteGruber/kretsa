# Review format: instructions for the AI agent designing the PCB

This file is meant to be copied into, or referenced from, the CLAUDE.md or AGENTS.md of the **KiCad project being designed**.

The human reviews your design in kretsa. Their feedback is stored in the KiCad project directory:

- `.kretsa/review.json`: the source of truth. Types are in `shared/review.ts` in the kretsa repo.
- `.kretsa/REVIEW.md`: a readable summary of the open and addressed comments, regenerated on every write.
- `.kretsa/snap/<id>.png`: a screenshot of what the human was looking at (the canvas with their drawing burned in, or the
  symbol/footprint/3D view of a part). Look at it.
- `ink_shapes` on a comment: what the human drew. `covers` lists the parts a box or loop encloses. Arrows give `from_ref` and `to_ref`,
  meaning "move this there".

You never need to edit `review.json` by hand: use `kretsa reply`.

## The loop

1. Start `kretsa wait` **in the background** (in Claude Code: a background Bash command; you are re-invoked when it exits).
   It blocks until the human presses **Send to AI**, then prints the comments they sent and exits.
2. Handle each comment: make the change, then verify it with `kretsa check` (ERC/DRC, what's new or fixed), `kretsa diff`
   (what you changed in parts, nets and routing) and `kretsa render` (look at the result).
3. Answer: `kretsa reply <#> "what you changed" --addressed`. Use `--wontfix` with a reason if it can't be done, or no flag
   to ask a question (the comment stays open; the human's answer comes back through `kretsa wait`). **Never resolve**: only the
   human resolves or reopens.
4. Start `kretsa wait` again.

`kretsa review` lists every open comment at any time, including drafts the human hasn't sent yet (marked; they may still change).

## Commands

- `kretsa wait [--timeout SEC] [--all]`: block until comments are sent (exit 0), or time out (exit 3).
- `kretsa reply <comment> "text" [--addressed | --wontfix | --open]`: `<comment>` is the number shown in the viewer (`3`, `#3`)
  or the id.
- `kretsa review`: open comments as markdown, with anchors, drawings and snapshot paths.
- `kretsa check`: ERC + DRC + schematic/PCB parity, plus **what is new or fixed since your previous `kretsa check`**. Run it
  before and after each change, and don't leave new errors behind. Library-lookup warnings are hidden (`--library` shows them).
- `kretsa diff [since]`: what changed since your last full `kretsa check` (default), since a comment was written (`kretsa diff 3`),
  or since a rev. The human sees the same list ("What changed?") on comments made before your change.
- `kretsa render sch|pcb|3d [--around U3,C7] [--net VBUS|U3.4] [--sheet NAME] [--side bottom]`: PNGs of the design, cropped
  around parts or a net with them marked in magenta. Look at them.
- `kretsa lib`, `kretsa lib show <part>`, `kretsa lib check [--klc]`, `kretsa lib set <part> Field=Value`: the project's parts
  (see below).
- `kretsa status`: files, revision, comment counts, check summary. `kretsa projects` / `kretsa use <project>`.

All commands take `-p <project>`; output is markdown, or JSON with `--json`.

## Comments

`view` says where the comment was made: `sch`, `pcb`, `3d`, or `lib` (the library).

Anchors say what the human pointed at:
- `symbol` `{ref, uuid?}`: a schematic symbol or footprint, found by refdes. Prefer `uuid` when present.
- `net` `{name}`, `pad` `{ref, pad}` (for example `U3.4`).
- `point` `{at_mm}` and `area` `{bbox_mm}`: KiCad document coordinates in mm, in the file named by `file` (`sheet` for schematics).

**Library comments** (`view: "lib"`) are about the parts you make:
- `part` is the symbol (`Lib:Name`) and `aspect` what the human was looking at: `symbol`, `footprint` or `3d`.
- `pin` `{pin, name?}` anchors are symbol pins; `pad` anchors carry the footprint id as `ref` (`{ref: "Lib:Footprint", pad: "1"}`).
- A library comment **without `part`** is a request for a new part: make the symbol, footprint and 3D model in the project
  libraries, check it with `kretsa lib show <part>` (look at the renders) and `kretsa lib check --klc`, then reply with the part id.

`sent` is when the human sent the comment to you; comments without it are drafts. `design_rev` records which design revision
the comment was made against: if the design changed since, re-check that the comment still applies (`kretsa diff <#>`).

## If you must edit review.json directly

Only append to `thread` (`{"author": "ai", "text": "…", "at": "<ISO time>"}`) and change `status` (never to `"resolved"`).
Write atomically (temp file, then rename), keep 2-space indentation, don't touch other fields or reorder comments.
