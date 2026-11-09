// Optional style checks after the KiCad Library Conventions (KLC, https://klc.kicad.org), the generic
// subset only: grids, line widths, text sizes, courtyard, pad layers, attributes, metadata. Opt-in
// (`kretsa lib --klc`), because a house style may deviate; those deviations belong in the user's
// workspace CLAUDE.md. Every issue code is "klc_<rule>", e.g. "klc_S4.1".

import type { PartIssue } from "../../shared/library";
import { kid, kids, nums, val, type SExpr } from "./sexpr";

const MIL = 0.0254;
const EPS = 1e-3;
const onGrid = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) * step < EPS;
const str = (x: SExpr | undefined) => (typeof x === "string" ? x : "");
const f3 = (n: number) => +n.toFixed(3);

type Add = (level: PartIssue["level"], rule: string, text: string) => void;
const adder = (out: PartIssue[]): Add => (level, rule, text) => out.push({ level, code: `klc_${rule}`, text: `KLC ${rule}: ${text}` });

function strokeWidth(g: SExpr[]): number | undefined {
  const w = nums(kid(kid(g, "stroke") ?? [], "width"))[0] ?? nums(kid(g, "width"))[0];
  return w;
}
function fontSize(node: SExpr[]): number | undefined {
  return nums(kid(kid(kid(node, "effects") ?? [], "font") ?? [], "size"))[0];
}
function hidden(node: SExpr[]): boolean {
  const eff = kid(node, "effects");
  return !!(eff && (eff.includes("hide") || kid(eff, "hide")?.[1] === "yes")) || kid(node, "hide")?.[1] === "yes";
}

// ---------------------------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------------------------

export function klcSymbol(node: SExpr[]): PartIssue[] {
  const out: PartIssue[] = [];
  const add = adder(out);
  if (kid(node, "extends")) return out; // derived symbols share the parent's drawing
  const power = !!kid(node, "power");

  // S3.2 field text 50 mil
  for (const p of kids(node, "property")) {
    const name = str(p[1]);
    if (!["Reference", "Value"].includes(name) || hidden(p)) continue;
    const s = fontSize(p);
    if (s !== undefined && Math.abs(s - 50 * MIL) > EPS) add("info", "S3.2", `${name} text ${f3(s / MIL)} mil (50 mil)`);
  }
  // S3.6 pin name offset ≤ 50 mil
  const off = nums(kid(kid(node, "pin_names") ?? [], "offset"))[0];
  if (off !== undefined && off > 50 * MIL + EPS) add("info", "S3.6", `pin name offset ${f3(off / MIL)} mil (≤ 50 mil)`);

  const badGrid: string[] = [], badLen: string[] = [], badText: string[] = [], hiddenPower: string[] = [];
  let widths = new Set<number>(), xs: number[] = [], ys: number[] = [];
  for (const u of kids(node, "symbol")) {
    if (/_\d+_2$/.test(str(u[1]))) continue; // De Morgan alternate
    for (const g of u.filter((c): c is SExpr[] => Array.isArray(c) && /^(rectangle|polyline|circle|arc)$/.test(str(c[0])))) {
      const w = strokeWidth(g);
      if (w !== undefined && w > 0) widths.add(f3(w));
      for (const k of ["start", "end", "center"]) { const n = nums(kid(g, k)); if (n.length >= 2) { xs.push(n[0]!); ys.push(n[1]!); } }
      for (const xy of kids(kid(g, "pts") ?? [], "xy")) { const n = nums(xy); xs.push(n[0]!); ys.push(n[1]!); }
    }
    for (const p of kids(u, "pin")) {
      const at = nums(kid(p, "at")), num = str(kid(p, "number")?.[1]);
      const len = nums(kid(p, "length"))[0] ?? 0;
      if (!onGrid(at[0] ?? 0, 100 * MIL) || !onGrid(at[1] ?? 0, 100 * MIL)) badGrid.push(num);
      if (!onGrid(len, 50 * MIL) || len < 100 * MIL - EPS || len > 300 * MIL + EPS) badLen.push(`${num} (${f3(len / MIL)} mil)`);
      for (const k of ["name", "number"]) {
        const s = fontSize(kid(p, k) ?? []);
        if (s !== undefined && (s < 20 * MIL - EPS || s > 50 * MIL + EPS)) { badText.push(num); break; }
      }
      if (str(p[1]) === "power_in" && (p.includes("hide") || kid(p, "hide")?.[1] === "yes") && !power) hiddenPower.push(num);
    }
  }
  if (badGrid.length) add("warning", "S4.1", `pins off the 100 mil grid: ${badGrid.slice(0, 12).join(", ")}${badGrid.length > 12 ? ", …" : ""}`);
  if (badLen.length) add("info", "S4.2", `pin length not a multiple of 50 mil in 100–300 mil: ${badLen.slice(0, 8).join(", ")}${badLen.length > 8 ? ", …" : ""}`);
  if (badText.length) add("info", "S4.4", `pin name/number text outside 20–50 mil: ${badText.slice(0, 8).join(", ")}`);
  if (hiddenPower.length) add("warning", "S4.6", `hidden power input pins (connect implicitly): ${hiddenPower.join(", ")}`);
  const odd = [...widths].filter((w) => Math.abs(w - 10 * MIL) > EPS);
  if (odd.length) add("info", "S3.3", `body line width ${odd.map((w) => `${f3(w / MIL)} mil`).join(", ")} (10 mil)`);
  if (xs.length && !power) {
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    if (Math.abs(cx) > 100 * MIL + EPS || Math.abs(cy) > 100 * MIL + EPS) add("info", "S3.1", `body is not centered on the origin (center at ${f3(cx)}, ${f3(cy)} mm)`);
  }
  // S6: Datasheet / Description fields
  const field = (n: string) => str(kids(node, "property").find((p) => p[1] === n)?.[2]);
  if (!power && !field("Datasheet")) add("info", "S6.2", `Datasheet field is empty (use a URL, or "~" when there is none)`);
  if (!power && !field("Description") && !field("ki_description")) add("info", "S6.2", "Description is empty");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Footprints
// ---------------------------------------------------------------------------------------------

type Box = [number, number, number, number];
const grow = (b: Box | undefined, x: number, y: number): Box => (b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y]);

export function klcFootprint(root: SExpr[], name: string): PartIssue[] {
  const out: PartIssue[] = [];
  const add = adder(out);
  const graphics = root.filter((c): c is SExpr[] => Array.isArray(c) && /^fp_(line|rect|poly|circle|arc)$/.test(str(c[0])));
  const onLayer = (re: RegExp) => graphics.filter((g) => re.test(val(g, "layer") ?? ""));
  const widthsOf = (gs: SExpr[][]) => [...new Set(gs.map(strokeWidth).filter((w): w is number => w !== undefined && w > 0).map(f3))];

  // F5.1 silkscreen width 0.10–0.15
  const silkW = widthsOf(onLayer(/SilkS/)).filter((w) => w < 0.1 - EPS || w > 0.15 + EPS);
  if (silkW.length) add("warning", "F5.1", `silkscreen line width ${silkW.join(", ")} mm (0.10–0.15, 0.12 nominal)`);
  // F5.2 fab outline + ${REFERENCE}
  const fab = onLayer(/Fab/);
  if (!fab.length) add("warning", "F5.2", "no body outline on F.Fab");
  const fabW = widthsOf(fab).filter((w) => w < 0.1 - EPS || w > 0.15 + EPS);
  if (fabW.length) add("info", "F5.2", `fab line width ${fabW.join(", ")} mm (0.10–0.15)`);
  const texts = [...kids(root, "fp_text"), ...kids(root, "property")];
  const fabRef = texts.some((t) => /\$\{REFERENCE\}|%R/.test(str(t[2])) && /Fab/.test(val(t, "layer") ?? ""));
  if (!fabRef) add("info", "F5.2", "no ${REFERENCE} text on F.Fab");
  // F5.3 courtyard: width 0.05, grid 0.01, clearance to pads
  const crt = onLayer(/CrtYd/);
  const crtW = widthsOf(crt).filter((w) => Math.abs(w - 0.05) > EPS);
  if (crtW.length) add("warning", "F5.3", `courtyard line width ${crtW.join(", ")} mm (0.05)`);
  let cbox: Box | undefined;
  const offGrid: string[] = [];
  for (const g of crt) {
    for (const k of ["start", "end", "center", "mid"]) {
      const n = nums(kid(g, k));
      if (n.length < 2) continue;
      cbox = grow(cbox, n[0]!, n[1]!);
      if (!onGrid(n[0]!, 0.01) || !onGrid(n[1]!, 0.01)) offGrid.push(`(${n[0]}, ${n[1]})`);
    }
    for (const xy of kids(kid(g, "pts") ?? [], "xy")) { const n = nums(xy); cbox = grow(cbox, n[0]!, n[1]!); }
  }
  if (offGrid.length) add("info", "F5.3", `courtyard points off the 0.01 mm grid: ${offGrid.slice(0, 4).join(", ")}${offGrid.length > 4 ? ", …" : ""}`);

  const pads = kids(root, "pad").map((p) => {
    const at = nums(kid(p, "at")), size = nums(kid(p, "size")), drill = kid(p, "drill");
    const rot = ((at[2] ?? 0) % 180 + 180) % 180;
    const [w, h] = rot === 90 ? [size[1] ?? 0, size[0] ?? 0] : [size[0] ?? 0, size[1] ?? 0];
    return {
      number: str(p[1]), type: str(p[2]), shape: str(p[3]), x: at[0] ?? 0, y: at[1] ?? 0, w, h,
      drill: drill ? nums(drill).filter((n) => n > 0) : [], layers: (kid(p, "layers") ?? []).slice(1).map(str),
    };
  });
  let pbox: Box | undefined;
  for (const p of pads) { pbox = grow(pbox, p.x - p.w / 2, p.y - p.h / 2); pbox = grow(pbox, p.x + p.w / 2, p.y + p.h / 2); }
  if (cbox && pbox) {
    const m = Math.min(pbox[0] - cbox[0], pbox[1] - cbox[1], cbox[2] - pbox[2], cbox[3] - pbox[3]);
    if (m < 0.15 - EPS) add("warning", "F5.3", `courtyard only ${f3(m)} mm from the pads (0.25 mm; 0.15 for small parts)`);
    else if (m < 0.25 - EPS) add("info", "F5.3", `courtyard ${f3(m)} mm from the pads (0.25 mm nominal)`);
  }

  // F6.1 / F7.1 attributes
  const attr = (kid(root, "attr") ?? []).slice(1).map(str);
  const tht = pads.some((p) => p.type === "thru_hole"), smd = pads.some((p) => p.type === "smd");
  if (tht && !attr.includes("through_hole")) add("warning", "F7.1", `has through-hole pads but the type is ${attr[0] ?? "unspecified"} (Through hole)`);
  if (smd && !tht && !attr.includes("smd")) add("warning", "F6.1", `has only SMD pads but the type is ${attr[0] ?? "unspecified"} (SMD)`);
  // F6.3 SMD pad layers, F7.4 THT pad layers, F7.5 annular ring
  const noMask = pads.filter((p) => p.type === "smd" && p.layers.some((l) => /Cu/.test(l)) && !p.layers.some((l) => /Mask/.test(l))).map((p) => p.number || "—");
  if (noMask.length) add("warning", "F6.3", `SMD pads without solder mask opening: ${noMask.slice(0, 8).join(", ")}`);
  const noPaste = pads.filter((p) => p.type === "smd" && p.layers.some((l) => /Cu/.test(l)) && !p.layers.some((l) => /Paste/.test(l))).map((p) => p.number || "—");
  if (noPaste.length) add("info", "F6.3", `SMD copper pads without paste (fine for thermal/test pads): ${noPaste.slice(0, 8).join(", ")}`);
  const thtLayers = pads.filter((p) => p.type === "thru_hole" && !(p.layers.includes("*.Cu") && p.layers.includes("*.Mask"))).map((p) => p.number);
  if (thtLayers.length) add("warning", "F7.4", `through-hole pads not on *.Cu + *.Mask: ${thtLayers.slice(0, 8).join(", ")}`);
  const thin = pads.filter((p) => p.type === "thru_hole" && p.drill.length && (Math.min(p.w, p.h) - Math.max(...p.drill)) / 2 < 0.15 - EPS).map((p) => p.number);
  if (thin.length) add("warning", "F7.5", `annular ring under 0.15 mm on pads ${thin.slice(0, 8).join(", ")}`);
  if (pads.length > 1 && !pads.some((p) => p.number === "1" || p.number === "A1")) add("info", "F4.2", "no pad 1 (or A1)");

  // F9.1 metadata
  const prop = (n: string, t: string) => str(kids(root, "property").find((p) => p[1] === n)?.[2]) || str(kids(root, "fp_text").find((p) => p[1] === t)?.[2]);
  const ref = prop("Reference", "reference"), value = prop("Value", "value");
  if (ref && ref !== "REF**") add("info", "F9.1", `Reference is "${ref}" (REF**)`);
  if (value && value !== name) add("info", "F9.1", `Value is "${value}", not the footprint name "${name}"`);
  if (!val(root, "descr") && !val(root, "description")) add("info", "F9.1", "no description");
  // F9.3 model
  for (const m of kids(root, "model")) {
    const path = str(m[1]);
    if (!/\.(step|stp|wrl)$/i.test(path)) add("warning", "F9.3", `3D model is not STEP/WRL: ${path}`);
    const scale = nums(kid(kid(m, "scale") ?? [], "xyz"));
    if (scale.some((s) => Math.abs(s - 1) > EPS)) add("warning", "F9.3", `3D model scale ${scale.join(" ")} (1 1 1)`);
  }
  return out;
}
