// Net connectivity for cross-probing.
//
// KiCanvas has no connectivity model for schematics (it only picks symbols), so we build one per
// displayed sheet: wires, labels, junctions and symbol pins are unioned geometrically into groups,
// and each group is named through the kicad-cli netlist (via its pins, "REF.PIN"). A net can span
// several groups (labels, power symbols) and several sheets.
//
// Schematic and PCB nets are matched through shared pins (symbol pin "U3.4" == footprint pad "U3.4"),
// falling back to the net name.

import type { Netlist } from "../../shared/netlist";

type Pt = [number, number];

/** A net selection as it travels between panes. */
export interface NetSel {
  name: string;
  /** Pins on the net, "REF.PIN". Empty when unknown. */
  nodes: string[];
}

export interface SchGroup {
  net: string | null;
  wires: [Pt, Pt][];
  pins: { at: Pt; node: string }[];
  /** Label anchor points (local, global, hierarchical, power symbols). */
  labels: Pt[];
}

/** Netlist with lookups. */
export class NetIndex {
  readonly byNode = new Map<string, string>();
  readonly byName = new Map<string, string[]>();
  constructor(readonly netlist: Netlist) {
    for (const n of netlist.nets) {
      this.byName.set(n.name, n.nodes);
      for (const node of n.nodes) this.byNode.set(node, n.name);
    }
  }
  /** The netlist name for a label text seen on sheet `sheetPath` (e.g. "/power/"). */
  nameForLabel(text: string, sheetPath = "/"): string | null {
    const sp = sheetPath.endsWith("/") ? sheetPath : sheetPath + "/";
    for (const c of [text, sp + text, "/" + text]) if (this.byName.has(c)) return c;
    for (const n of this.byName.keys()) if (n.endsWith("/" + text)) return n;
    return null;
  }
  /** Resolve a selection coming from another pane to a netlist name: majority vote over its pins, else by name. */
  resolve(sel: NetSel): string | null {
    const votes = new Map<string, number>();
    for (const node of sel.nodes) {
      const n = this.byNode.get(node);
      if (n) votes.set(n, (votes.get(n) ?? 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
    return this.byName.has(sel.name) ? sel.name : this.nameForLabel(sel.name.replace(/^.*\//, ""));
  }
}

// ---------- geometry helpers ----------

const EPS = 0.01; // mm; KiCad snaps to a 1.27 / 0.635 mm grid, so this is plenty
const key = (p: Pt) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

/** Distance from p to segment ab. */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const onSeg = (p: Pt, a: Pt, b: Pt) => segDist(p, a, b) < EPS;

/**
 * World position of a symbol pin. Mirrors KiCanvas' PinPainter.apply_symbol_transformations:
 * library coords are y-up; rotate in 90° steps, mirror, then translate (y flipped).
 */
function pinWorld(sym: any, def: any): Pt {
  let x: number = def.at.position.x, y: number = def.at.position.y;
  const rot = ((Math.round((sym.at.rotation ?? 0) / 90) % 4) + 4) % 4;
  for (let i = 0; i < rot; i++) [x, y] = [-y, x];
  if (sym.mirror === "x") y = -y;
  if (sym.mirror === "y") x = -x;
  return [sym.at.position.x + x, sym.at.position.y - y];
}

class DSU {
  p: number[] = [];
  add() { this.p.push(this.p.length); return this.p.length - 1; }
  find(i: number): number { while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]!]!; return i; }
  union(a: number, b: number) { this.p[this.find(a)] = this.find(b); }
}

/**
 * Connectivity groups of one schematic sheet (a KiCanvas KicadSch whose hierarchical data has been
 * set for the displayed instance, so `symbol.reference` is the instance's refdes).
 */
export function buildSheetGroups(sch: any, nets: NetIndex | null, sheetPath = "/"): SchGroup[] {
  const dsu = new DSU();
  const wires: { id: number; a: Pt; b: Pt }[] = [];
  for (const w of sch?.wires ?? []) {
    const pts: Pt[] = (w.pts ?? []).map((v: any) => [v.x, v.y]);
    for (let i = 1; i < pts.length; i++) wires.push({ id: dsu.add(), a: pts[i - 1]!, b: pts[i]! });
  }

  // Everything that is a point (pins, labels, junctions) gets a node; coincident points share one.
  const points = new Map<string, number>();
  const pointNode = (p: Pt) => {
    const k = key(p);
    let id = points.get(k);
    if (id === undefined) { id = dsu.add(); points.set(k, id); }
    return id;
  };
  const attach = (p: Pt, id: number, interior: boolean) => {
    for (const w of wires) if (interior ? onSeg(p, w.a, w.b) : same(p, w.a) || same(p, w.b)) dsu.union(id, w.id);
  };

  // Wire endpoints connect to other wires' endpoints and interiors (T-connections).
  for (const w of wires) for (const p of [w.a, w.b]) { const id = pointNode(p); dsu.union(id, w.id); attach(p, id, true); }
  // Junctions join crossing wires.
  for (const j of sch?.junctions ?? []) { const p: Pt = [j.at.position.x, j.at.position.y]; attach(p, pointNode(p), true); }

  const pins: { id: number; at: Pt; node: string; power?: string }[] = [];
  for (const sym of sch?.symbols?.values?.() ?? []) {
    let ref: string;
    try { ref = sym.reference; } catch { continue; }
    const isPower = ref.startsWith("#") || sym.lib_symbol?.power;
    for (const pin of sym.unit_pins ?? []) {
      let def: any;
      try { def = pin.definition; } catch { continue; }
      if (!def?.at) continue;
      const at = pinWorld(sym, def);
      const id = pointNode(at);
      attach(at, id, true);
      pins.push({ id, at, node: `${ref}.${pin.number}`, power: isPower ? sym.value : undefined });
    }
  }

  const labels: { id: number; at: Pt; name: string | null }[] = [];
  const addLabels = (list: any[], global: boolean) => {
    for (const l of list ?? []) {
      const at: Pt = [l.at.position.x, l.at.position.y];
      const id = pointNode(at);
      attach(at, id, true);
      const text = String(l.shown_text ?? l.text ?? "");
      labels.push({ id, at, name: nets?.nameForLabel(text, global ? "/" : sheetPath) ?? text });
    }
  };
  addLabels(sch?.net_labels, false);
  addLabels(sch?.global_labels, true);
  addLabels(sch?.hierarchical_labels, false);

  // Collect groups.
  const groups = new Map<number, SchGroup & { votes: Map<string, number>; fallback: string | null }>();
  const group = (id: number) => {
    const r = dsu.find(id);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { net: null, wires: [], pins: [], labels: [], votes: new Map(), fallback: null }));
    return g;
  };
  for (const w of wires) group(w.id).wires.push([w.a, w.b]);
  for (const p of pins) {
    const g = group(p.id);
    g.pins.push({ at: p.at, node: p.node });
    const n = nets?.byNode.get(p.node);
    if (n) g.votes.set(n, (g.votes.get(n) ?? 0) + 1);
    if (p.power) { g.labels.push(p.at); g.fallback ??= nets?.nameForLabel(p.power) ?? p.power; }
  }
  for (const l of labels) { const g = group(l.id); g.labels.push(l.at); g.fallback ??= l.name; }

  const out: SchGroup[] = [];
  for (const g of groups.values()) {
    if (!g.wires.length && g.pins.length < 2 && !g.labels.length) continue; // lone unconnected pin
    const best = [...g.votes].sort((a, b) => b[1] - a[1])[0];
    out.push({ net: best?.[0] ?? g.fallback, wires: g.wires, pins: g.pins, labels: g.labels });
  }
  return out;
}

/** The group under `p` (document mm), within `tol` mm of a wire, pin end or label anchor. */
export function groupAt(groups: SchGroup[], p: Pt, tol: number): SchGroup | null {
  let best: SchGroup | null = null, bestD = tol;
  for (const g of groups) {
    for (const [a, b] of g.wires) { const d = segDist(p, a, b); if (d < bestD) { bestD = d; best = g; } }
    for (const l of g.labels) { const d = Math.hypot(p[0] - l[0], p[1] - l[1]); if (d < bestD) { bestD = d; best = g; } }
  }
  return best;
}

/** All pins ("REF.PIN") of a group set, for sending a selection to the PCB. */
export function groupNodes(groups: SchGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => g.pins.map((p) => p.node)).filter((n) => !n.startsWith("#")))];
}
