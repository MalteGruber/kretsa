// What changed in the design between two revisions: parts added, removed, moved, re-valued or
// re-footprinted; pads whose net changed; routing added or removed per net.
//
// kretsa keeps copies of the design files of revisions it may need to compare against in
// <project>/.kretsa/revs/<rev>/ (when a comment is made, and at each full `kretsa check`), so
// "what changed since this comment" works without git.

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesignDiff, PartChange } from "../../shared/diff";
import type { ProjectInfo } from "../../shared/review";
import { readDesign, type Board, type Design, type Pt } from "./design";

const exists = (p: string) => stat(p).then(() => true, () => false);
export const revDir = (projectDir: string, rev: string) => join(projectDir, ".kretsa", "revs", rev);

/** Keep a copy of this revision's design files (no-op if already kept). Keeps the newest `keep` revisions. */
export async function keepRev(project: ProjectInfo, keep = 50): Promise<void> {
  const dir = revDir(project.dir, project.rev);
  if (await exists(join(dir, "files.json"))) return;
  for (const f of project.files) {
    await mkdir(dirname(join(dir, f.path)), { recursive: true });
    await cp(join(project.dir, f.path), join(dir, f.path));
  }
  await writeFile(join(dir, "files.json"), JSON.stringify({ ...project, dir: undefined, kept: new Date().toISOString() }, null, 1));
  // Prune old ones.
  const root = join(project.dir, ".kretsa", "revs");
  const all = await Promise.all((await readdir(root)).map(async (r) => ({ r, t: (await stat(join(root, r)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const { r } of all.sort((a, b) => b.t - a.t).slice(keep)) await rm(join(root, r), { recursive: true, force: true });
}

/** The project as it was at `rev`, if kretsa kept a copy. */
export async function readRev(projectDir: string, rev: string): Promise<{ project: ProjectInfo; design: Design } | null> {
  const dir = revDir(projectDir, rev);
  const meta = await Bun.file(join(dir, "files.json")).json().catch(() => null) as ProjectInfo | null;
  if (!meta) return null;
  const project = { ...meta, dir };
  return { project, design: await readDesign(project, dir) };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const f2 = (n: number) => +n.toFixed(2);

function trackLength(b: Board | undefined, net: string): { n: number; mm: number } {
  let n = 0, mm = 0;
  for (const t of b?.tracks ?? []) if (t.net === net && t.kind !== "via") { n++; mm += dist(t.start, t.end); }
  return { n, mm };
}

export function diffDesigns(a: Design, b: Design, fromRev: string, toRev: string): DesignDiff {
  const parts = new Map<string, PartChange>();
  const change = (ref: string, kind: PartChange["kind"], detail?: string, at?: Pt) => {
    const c = parts.get(ref) ?? { ref, kind, details: [] };
    if (kind !== "changed") c.kind = kind;
    if (detail) c.details.push(detail);
    if (at) c.at_mm = at;
    parts.set(ref, c);
  };

  // Schematic symbols (by refdes)
  const symMap = (d: Design) => {
    const m = new Map<string, Design["symbols"][number]>();
    for (const s of d.symbols) if (!s.power) for (const r of s.refs) if (!r.startsWith("#")) m.set(r, s);
    return m;
  };
  const sa = symMap(a), sb = symMap(b);
  for (const [ref, s] of sb) {
    const o = sa.get(ref);
    if (!o) { change(ref, "added", `added to the schematic (${s.value}, ${s.lib})`); continue; }
    if (o.value !== s.value) change(ref, "changed", `value ${o.value} → ${s.value}`);
    if (o.footprint !== s.footprint) change(ref, "changed", `footprint field ${o.footprint || "(none)"} → ${s.footprint || "(none)"}`);
    if (o.lib !== s.lib) change(ref, "changed", `symbol ${o.lib} → ${s.lib}`);
    if (o.file !== s.file) change(ref, "changed", `moved from sheet ${o.file} to ${s.file}`);
    else if (dist([o.at[0], o.at[1]], [s.at[0], s.at[1]]) > 0.01 || o.at[2] !== s.at[2]) change(ref, "changed", `moved on the schematic`);
  }
  for (const [ref, s] of sa) if (!sb.has(ref)) change(ref, "removed", `removed from the schematic (${s.value})`);

  // Board footprints
  const fa = new Map((a.board?.footprints ?? []).filter((f) => f.ref).map((f) => [f.ref, f]));
  const fb = new Map((b.board?.footprints ?? []).filter((f) => f.ref).map((f) => [f.ref, f]));
  const padNets: DesignDiff["padNets"] = [];
  for (const [ref, f] of fb) {
    const o = fa.get(ref);
    const at: Pt = [f.at[0], f.at[1]];
    if (!o) { change(ref, parts.get(ref)?.kind === "added" ? "added" : "changed", `placed on the board at (${f2(f.at[0])}, ${f2(f.at[1])}) mm`, at); continue; }
    const d = dist([o.at[0], o.at[1]], at);
    if (d > 0.005) change(ref, "changed", `moved ${f2(d)} mm on the board: (${f2(o.at[0])}, ${f2(o.at[1])}) → (${f2(f.at[0])}, ${f2(f.at[1])})`, at);
    if (o.at[2] !== f.at[2]) change(ref, "changed", `rotated ${o.at[2]}° → ${f.at[2]}°`, at);
    if (o.layer !== f.layer) change(ref, "changed", `flipped ${o.layer} → ${f.layer}`, at);
    if (o.lib !== f.lib) change(ref, "changed", `footprint ${o.lib} → ${f.lib}`, at);
    if (o.value !== f.value && !parts.get(ref)?.details.some((x) => x.startsWith("value"))) change(ref, "changed", `value ${o.value} → ${f.value}`, at);
    const on = new Map(o.pads.map((p) => [p.number, p.net]));
    for (const p of f.pads) {
      const was = on.get(p.number);
      if (was !== undefined && was !== p.net && p.number) padNets.push({ pad: `${ref}.${p.number}`, from: was, to: p.net });
    }
  }
  for (const [ref, f] of fa) if (!fb.has(ref)) change(ref, "removed", `removed from the board`, [f.at[0], f.at[1]]);
  for (const pn of padNets) change(pn.pad.slice(0, pn.pad.lastIndexOf(".")), "changed", `pad ${pn.pad}: net ${pn.from || "(none)"} → ${pn.to || "(none)"}`);

  // Routing per net
  const nets = new Set([...(a.board?.tracks ?? []), ...(b.board?.tracks ?? [])].map((t) => t.net).filter(Boolean));
  const routing: DesignDiff["routing"] = [];
  for (const net of nets) {
    const x = trackLength(a.board, net), y = trackLength(b.board, net);
    const va = (a.board?.tracks ?? []).filter((t) => t.net === net && t.kind === "via").length;
    const vb = (b.board?.tracks ?? []).filter((t) => t.net === net && t.kind === "via").length;
    if (x.n !== y.n || Math.abs(x.mm - y.mm) > 0.01 || va !== vb) {
      routing.push({ net, segments: [x.n, y.n], length_mm: [f2(x.mm), f2(y.mm)], vias: [va, vb] });
    }
  }
  routing.sort((p, q) => Math.abs(q.length_mm[1] - q.length_mm[0]) - Math.abs(p.length_mm[1] - p.length_mm[0]));

  return {
    from: fromRev, to: toRev,
    parts: [...parts.values()].sort((p, q) => p.ref.localeCompare(q.ref, undefined, { numeric: true })),
    padNets, routing,
  };
}

/** Diff the project's current state against a kept revision. Null if that revision wasn't kept. */
export async function diffSince(project: ProjectInfo, rev: string): Promise<DesignDiff | null> {
  if (rev === project.rev) return { from: rev, to: rev, parts: [], padNets: [], routing: [] };
  const old = await readRev(project.dir, rev);
  if (!old) return null;
  return diffDesigns(old.design, await readDesign(project), rev, project.rev);
}

export function diffMarkdown(d: DesignDiff, title = "Design changes"): string {
  const lines = [`# ${title} · ${d.from} → ${d.to}`, ""];
  if (!d.parts.length && !d.routing.length) return lines.concat(["No changes to parts, nets or routing.", ""]).join("\n");
  const by = (k: PartChange["kind"]) => d.parts.filter((p) => p.kind === k);
  for (const [k, label] of [["added", "Added"], ["removed", "Removed"], ["changed", "Changed"]] as const) {
    const list = by(k);
    if (!list.length) continue;
    lines.push(`## ${label} (${list.length})`, "");
    for (const p of list) lines.push(`- **${p.ref}**: ${p.details.join("; ")}`);
    lines.push("");
  }
  if (d.routing.length) {
    lines.push(`## Routing (${d.routing.length} nets)`, "");
    for (const r of d.routing.slice(0, 40)) {
      lines.push(`- ${r.net}: ${r.segments[0]} → ${r.segments[1]} segments, ${r.length_mm[0]} → ${r.length_mm[1]} mm${r.vias[0] !== r.vias[1] ? `, vias ${r.vias[0]} → ${r.vias[1]}` : ""}`);
    }
    if (d.routing.length > 40) lines.push(`- … ${d.routing.length - 40} more`);
    lines.push("");
  }
  return lines.join("\n");
}
