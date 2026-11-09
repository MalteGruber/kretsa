// Geometry of a design, read straight from the KiCad files: footprints, pads, tracks and nets of the
// board; placed symbols and their pins on the schematic sheets. Used by `kretsa render` (crop windows,
// highlights) and `kretsa diff` (what changed between two revisions). Read-only, document mm.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectInfo } from "../../shared/review";
import { kid, kids, nums, parseSexpr, val, type SExpr } from "./sexpr";

export type Box = [number, number, number, number]; // x1, y1, x2, y2 (mm, y down)
export type Pt = [number, number];

export function growBox(b: Box | undefined, x: number, y: number): Box {
  return b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
}
export function unionBox(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
export function padBoxBy(b: Box, m: number): Box { return [b[0] - m, b[1] - m, b[2] + m, b[3] + m]; }

// ---------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------

export interface BoardPad { number: string; at: Pt; size: [number, number]; net: string; type: string }
export interface BoardFootprint {
  ref: string;
  value: string;
  lib: string; // footprint lib id
  at: [number, number, number];
  layer: string; // F.Cu | B.Cu
  pads: BoardPad[];
  bbox: Box; // courtyard if present, else pads
}
export interface BoardTrack { kind: "segment" | "arc" | "via"; start: Pt; end: Pt; width: number; layer: string; net: string }
export interface Board {
  footprints: BoardFootprint[];
  tracks: BoardTrack[];
  zones: { net: string; layers: string[] }[];
  edge?: Box;
}

const str = (x: SExpr | undefined) => (typeof x === "string" ? x : "");

function netName(node: SExpr[] | undefined, table: Map<string, string>): string {
  if (!node) return "";
  const a = str(node[1]), b = str(node[2]);
  if (b) return b; // (net 3 "GND")
  return /^\d+$/.test(a) ? table.get(a) ?? "" : a; // (net 3) | (net "GND")
}

function rot(x: number, y: number, deg: number): Pt {
  const t = (deg * Math.PI) / 180;
  return [x * Math.cos(t) + y * Math.sin(t), -x * Math.sin(t) + y * Math.cos(t)];
}

function graphicPts(g: SExpr[]): Pt[] {
  const out: Pt[] = [];
  for (const k of ["start", "end", "mid", "center"]) {
    const n = nums(kid(g, k));
    if (n.length >= 2) out.push([n[0]!, n[1]!]);
  }
  if (/circle$/.test(str(g[0]))) {
    const c = nums(kid(g, "center")), e = nums(kid(g, "end"));
    if (c.length >= 2 && e.length >= 2) {
      const r = Math.hypot(e[0]! - c[0]!, e[1]! - c[1]!);
      out.push([c[0]! - r, c[1]! - r], [c[0]! + r, c[1]! + r]);
    }
  }
  for (const xy of kids(kid(g, "pts") ?? [], "xy")) {
    const n = nums(xy);
    if (n.length >= 2) out.push([n[0]!, n[1]!]);
  }
  return out;
}

export function parseBoard(text: string): Board {
  const root = parseSexpr(text)[0];
  if (!Array.isArray(root)) return { footprints: [], tracks: [], zones: [] };
  const table = new Map<string, string>();
  for (const n of kids(root, "net")) table.set(str(n[1]), str(n[2]));

  const footprints: BoardFootprint[] = [];
  for (const f of [...kids(root, "footprint"), ...kids(root, "module")]) {
    const at = nums(kid(f, "at"));
    const fat: [number, number, number] = [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0];
    const toWorld = (x: number, y: number): Pt => { const [rx, ry] = rot(x, y, fat[2]); return [fat[0] + rx, fat[1] + ry]; };
    const prop = (name: string) => {
      const p = kids(f, "property").find((p) => p[1] === name);
      if (p) return str(p[2]);
      const t = kids(f, "fp_text").find((t) => t[1] === name.toLowerCase());
      return t ? str(t[2]) : "";
    };
    const pads: BoardPad[] = kids(f, "pad").map((p) => {
      const pa = nums(kid(p, "at")), size = nums(kid(p, "size"));
      return {
        number: str(p[1]), type: str(p[2]),
        at: toWorld(pa[0] ?? 0, pa[1] ?? 0),
        size: [size[0] ?? 0, size[1] ?? 0],
        net: netName(kid(p, "net"), table),
      };
    });
    let crt: Box | undefined, padsBox: Box | undefined;
    for (const g of f.filter((c): c is SExpr[] => Array.isArray(c) && /^fp_(line|rect|poly|circle|arc)$/.test(str(c[0])))) {
      if (!/CrtYd/.test(val(g, "layer") ?? "")) continue;
      for (const [x, y] of graphicPts(g)) { const w = toWorld(x, y); crt = growBox(crt, w[0], w[1]); }
    }
    for (const p of pads) {
      const r = Math.max(p.size[0], p.size[1]) / 2;
      padsBox = growBox(growBox(padsBox, p.at[0] - r, p.at[1] - r), p.at[0] + r, p.at[1] + r);
    }
    footprints.push({
      ref: prop("Reference"), value: prop("Value"), lib: str(f[1]), at: fat, layer: val(f, "layer") ?? "F.Cu", pads,
      bbox: crt ?? padsBox ?? [fat[0] - 1, fat[1] - 1, fat[0] + 1, fat[1] + 1],
    });
  }

  const tracks: BoardTrack[] = [];
  for (const kind of ["segment", "arc"] as const) {
    for (const s of kids(root, kind)) {
      const a = nums(kid(s, "start")), b = nums(kid(s, "end"));
      tracks.push({ kind, start: [a[0] ?? 0, a[1] ?? 0], end: [b[0] ?? 0, b[1] ?? 0], width: nums(kid(s, "width"))[0] ?? 0.2, layer: val(s, "layer") ?? "", net: netName(kid(s, "net"), table) });
    }
  }
  for (const v of kids(root, "via")) {
    const a = nums(kid(v, "at"));
    const p: Pt = [a[0] ?? 0, a[1] ?? 0];
    tracks.push({ kind: "via", start: p, end: p, width: nums(kid(v, "size"))[0] ?? 0.6, layer: "via", net: netName(kid(v, "net"), table) });
  }
  const zones = kids(root, "zone").map((z) => ({
    net: val(z, "net_name") ?? netName(kid(z, "net"), table),
    layers: [...(kid(z, "layers") ?? []).slice(1).map(str), val(z, "layer") ?? ""].filter(Boolean),
  }));

  let edge: Box | undefined;
  for (const g of root.filter((c): c is SExpr[] => Array.isArray(c) && /^gr_(line|rect|poly|circle|arc|curve)$/.test(str(c[0])))) {
    if (val(g, "layer") !== "Edge.Cuts") continue;
    for (const [x, y] of graphicPts(g)) edge = growBox(edge, x, y);
  }
  return { footprints, tracks, zones, edge };
}

// ---------------------------------------------------------------------------------------------
// Schematic
// ---------------------------------------------------------------------------------------------

export interface SchPin { number: string; at: Pt }
export interface SchSymbol {
  file: string; // project-relative sheet file
  refs: string[]; // every instance reference (hierarchical sheets reused N times have N)
  value: string;
  footprint: string;
  lib: string;
  at: [number, number, number];
  unit: number;
  power: boolean;
  bbox: Box;
  pins: SchPin[];
  props: [string, string][];
}

interface LibSym { pins: { number: string; at: Pt; unit: number; style: number }[]; body: { pts: Pt[]; unit: number; style: number }[]; power: boolean }

function readLibSymbols(root: SExpr[]): Map<string, LibSym> {
  const out = new Map<string, LibSym>();
  for (const s of kids(kid(root, "lib_symbols") ?? [], "symbol")) {
    const ls: LibSym = { pins: [], body: [], power: !!kid(s, "power") };
    for (const u of kids(s, "symbol")) {
      const m = str(u[1]).match(/_(\d+)_(\d+)$/);
      const unit = m ? Number(m[1]) : 0, style = m ? Number(m[2]) : 1;
      for (const p of kids(u, "pin")) {
        const a = nums(kid(p, "at"));
        ls.pins.push({ number: str(kid(p, "number")?.[1]), at: [a[0] ?? 0, a[1] ?? 0], unit, style });
      }
      for (const g of u.filter((c): c is SExpr[] => Array.isArray(c) && /^(rectangle|polyline|circle|arc|text_box)$/.test(str(c[0])))) {
        ls.body.push({ pts: graphicPts(g), unit, style });
      }
    }
    out.set(str(s[1]), ls);
  }
  return out;
}

/** Symbol-local (y up) -> sheet coords, the way KiCad places symbols: rotate (90° steps), mirror, flip y. */
function symWorld(x: number, y: number, at: [number, number, number], mirror: string): Pt {
  const r = ((Math.round(at[2] / 90) % 4) + 4) % 4;
  for (let i = 0; i < r; i++) [x, y] = [-y, x];
  if (mirror === "x") y = -y;
  if (mirror === "y") x = -x;
  return [at[0] + x, at[1] - y];
}

export function parseSheet(text: string, file: string): SchSymbol[] {
  const root = parseSexpr(text)[0];
  if (!Array.isArray(root)) return [];
  const libs = readLibSymbols(root);
  const out: SchSymbol[] = [];
  for (const s of kids(root, "symbol")) {
    const libId = val(s, "lib_id");
    if (!libId) continue;
    const lib = libs.get(val(s, "lib_name") ?? libId);
    const a = nums(kid(s, "at"));
    const at: [number, number, number] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
    const mirror = val(s, "mirror") ?? "";
    const unit = Number(val(s, "unit") ?? 1);
    const prop = (n: string) => str(kids(s, "property").find((p) => p[1] === n)?.[2]);
    const refs = new Set<string>();
    for (const proj of kids(kid(s, "instances") ?? [], "project")) for (const p of kids(proj, "path")) { const r = val(p, "reference"); if (r) refs.add(r); }
    if (!refs.size && prop("Reference")) refs.add(prop("Reference"));
    const inUnit = (x: { unit: number; style: number }) => (x.unit === 0 || x.unit === unit) && x.style <= 1;
    const pins = (lib?.pins ?? []).filter(inUnit).map((p) => ({ number: p.number, at: symWorld(p.at[0], p.at[1], at, mirror) }));
    let bbox: Box | undefined;
    for (const b of (lib?.body ?? []).filter(inUnit)) for (const [x, y] of b.pts) { const w = symWorld(x, y, at, mirror); bbox = growBox(bbox, w[0], w[1]); }
    for (const p of pins) bbox = growBox(bbox, p.at[0], p.at[1]);
    out.push({
      file, refs: [...refs], value: prop("Value"), footprint: prop("Footprint"), lib: libId, at, unit,
      power: !!lib?.power || libId.startsWith("power:"),
      bbox: bbox ?? [at[0] - 2.54, at[1] - 2.54, at[0] + 2.54, at[1] + 2.54],
      pins,
      props: kids(s, "property").map((p) => [str(p[1]), str(p[2])] as [string, string]).filter(([k, v]) => k && v),
    });
  }
  return out;
}

export interface Design { board?: Board; symbols: SchSymbol[] }

/** Parse the project's board (main PCB) and every schematic sheet. `readText` lets diff read old copies. */
export async function readDesign(project: ProjectInfo, baseDir = project.dir): Promise<Design> {
  const read = (rel: string) => readFile(join(baseDir, rel), "utf8").catch(() => null);
  const pcbFile = project.files.find((f) => f.kind === "pcb" && f.path === `${project.name}.kicad_pcb`) ?? project.files.find((f) => f.kind === "pcb");
  const pcbText = pcbFile ? await read(pcbFile.path) : null;
  const symbols: SchSymbol[] = [];
  for (const f of project.files.filter((f) => f.kind === "sch")) {
    const t = await read(f.path);
    if (t) symbols.push(...parseSheet(t, f.path));
  }
  return { board: pcbText ? parseBoard(pcbText) : undefined, symbols };
}

/** Normalized net name for matching sch <-> pcb and user input ("/USB/D+" ~ "D+"). */
export function netMatches(name: string, query: string): boolean {
  if (!name || !query) return false;
  if (name === query) return true;
  const strip = (s: string) => s.replace(/^\//, "").toLowerCase();
  return strip(name) === strip(query) || strip(name).endsWith("/" + strip(query));
}
