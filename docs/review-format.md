# Review format: instructions for the AI agent designing the PCB

This file is meant to be copied into, or referenced from, the CLAUDE.md or AGENTS.md of the **KiCad project being designed**.

The human reviews your design in kretsa. Their feedback is stored in the KiCad project directory:

- `.kretsa/review.json`: the source of truth. Types are in `shared/review.ts` in the kretsa repo.
- `.kretsa/REVIEW.md`: a readable summary of the open and addressed comments, regenerated on every UI write.
- `.kretsa/snap/<id>.png`: a screenshot of what the human was looking at, if they took one. Look at it.

## Workflow

1. Read `.kretsa/review.json` and work through the comments with `status: "open"`.
2. Use `anchors` to find what each comment refers to:
   - `symbol` `{ref, uuid?}`: a schematic symbol or footprint, found by refdes. Prefer `uuid` when present.
   - `net` `{name}`, `pad` `{ref, pad}` (for example `U3.4`).
   - `point` `{at_mm}` and `area` `{bbox_mm}`: KiCad document coordinates in mm, in the file named by `file`.
3. Make the change in the KiCad files. The viewer reloads automatically.
4. Update each comment you handled. Edit only these fields:
   - set `status` to `"addressed"`. **Never** set it to `"resolved"`, because only the human resolves.
   - append to `thread`: `{"author": "ai", "text": "<what you changed>", "at": "<ISO time>"}`
   - use `"wontfix"` only when you explain why in `thread` and the human asked for something impossible.
5. Write the file atomically: write `review.json.tmp`, then rename it. Keep 2-space JSON indentation.
   Don't touch other fields, and don't reorder comments.

`design_rev` records which design revision the comment was made against. If the design has changed
since then, re-check that the comment still applies.
