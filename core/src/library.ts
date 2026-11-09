// Component libraries: lib tables -> symbols + footprints + 3D models, with generic part checks.
//
// Only libraries listed in sym-lib-table / fp-lib-table files of the project (and the workspace root)
// are used. KiCad's global tables and stock libraries are deliberately ignored: in a kretsa workflow
// the agent authors every part, so a part that silently resolves to a stock library is a bug.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FootprintDetail, LibraryInfo, LibraryRef, Model, Pad, PartDetail, PartIssue, PartSummary, Pin } from "../../shared/library";
import { flag, kid, kids, nums, parseSexpr, val, type SExpr } from "./sexpr";
import { klcFootprint, klcSymbol } from "./klc";

export interface CheckOptions {
  /** Also run the KLC style checks (core/src/klc.ts). */
  klc?: boolean;
}

async function klcIssues(sym: RawSymbol, fp: FootprintDetail | undefined): Promise<PartIssue[]> {
  const out = klcSymbol(sym.node);
  if (fp) {
    const root = parseSexpr(await readFile(fp.file, "utf8"))[0];
    if (Array.isArray(root)) out.push(...klcFootprint(root, basename(fp.file, ".kicad_mod")));
  }
  return out;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

// ---------------------------------------------------------------------------------------------
// Lib tables and path variables
// ---------------------------------------------------------------------------------------------

export interface LibContext {
  projectDir: string;
  /** Extra lib-table dirs (e.g. the workspace root). Project tables win on name clashes. */
  tableDirs?: string[];
}

/** Expand ${VAR}: KIPRJMOD is the project dir, everything else comes from the environment. */
export function expandVars(path: string, projectDir: string): string {
  return path.replace(/\$\{(\w+)\}/g, (m, name: string) => (name === "KIPRJMOD" ? projectDir : process.env[name] ?? m));
}

const STOCK_VAR = /\$\{(KISYS3DMOD|KICAD\d*_(3DMODEL|FOOTPRINT|SYMBOL)_DIR)\}/;

async function readTable(file: string, kind: "sym" | "fp", projectDir: string): Promise<LibraryRef[]> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return [];
  const root = parseSexpr(text)[0];
  if (!Array.isArray(root)) return [];
  const out: LibraryRef[] = [];
  for (const lib of kids(root, "lib")) {
    const name = val(lib, "name"), uri = val(lib, "uri");
    if (!name || !uri || val(lib, "type")?.toLowerCase() === "legacy" || flag(lib, "disabled")) continue;
    const expanded = expandVars(uri, projectDir);
    const path = isAbsolute(expanded) ? expanded : resolve(dirname(file), expanded);
    out.push({ kind, name, uri, path, table: file, exists: await exists(path) });
  }
  return out;
}

export async function libraryTables(ctx: LibContext): Promise<LibraryRef[]> {
  const dirs = [ctx.projectDir, ...(ctx.tableDirs ?? []).filter((d) => resolve(d) !== resolve(ctx.projectDir))];
  const seen = new Set<string>();
  const out: LibraryRef[] = [];
  for (const d of dirs) {
    for (const kind of ["sym", "fp"] as const) {
      for (const lib of await readTable(join(d, `${kind}-lib-table`), kind, ctx.projectDir)) {
        const k = `${kind}:${lib.name}`;
        if (!seen.has(k)) { seen.add(k); out.push(lib); }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------------------------

interface RawSymbol {
  name: string;
  node: SExpr[];
  fields: Record<string, string>;
  extends?: string;
  power: boolean;
  pins: Pin[];
  units: number;
}

function readPin(p: SExpr[], unit: number): Pin {
  const at = nums(kid(p, "at"));
  const name = kid(p, "name"), number = kid(p, "number");
  return {
    number: typeof number?.[1] === "string" ? number[1] : "",
    name: typeof name?.[1] === "string" ? name[1] : "",
    type: typeof p[1] === "string" ? p[1] : "",
    shape: typeof p[2] === "string" ? p[2] : "",
    unit,
    hidden: flag(p, "hide"),
    at: [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0],
    length: nums(kid(p, "length"))[0] ?? 0,
    alternates: kids(p, "alternate").map((a) => ({ name: String(a[1] ?? ""), type: String(a[2] ?? "") })),
  };
}

function readSymbols(text: string): RawSymbol[] {
  const root = parseSexpr(text)[0];
  if (!Array.isArray(root)) return [];
  const raw = kids(root, "symbol").map((s): RawSymbol => {
    const name = String(s[1] ?? "");
    const fields: Record<string, string> = {};
    for (const p of kids(s, "property")) if (typeof p[1] === "string") fields[p[1]] = String(p[2] ?? "");
    const pins: Pin[] = [];
    let units = 1;
    for (const u of kids(s, "symbol")) {
      // Unit sub-symbols are named <name>_<unit>_<style>; style 2 is the De Morgan alternate (skip).
      const m = String(u[1] ?? "").match(/_(\d+)_(\d+)$/);
      const unit = m ? Number(m[1]) : 0, style = m ? Number(m[2]) : 1;
      if (style > 1) continue;
      units = Math.max(units, unit);
      for (const p of kids(u, "pin")) pins.push(readPin(p, unit));
    }
    return { name, node: s, fields, extends: val(s, "extends"), power: !!kid(s, "power") || s.includes("power"), pins, units };
  });
  // Derived symbols (extends) inherit pins, units and missing fields from their parent.
  const byName = new Map(raw.map((r) => [r.name, r]));
  for (const r of raw) {
    const parent = r.extends ? byName.get(r.extends) : undefined;
    if (!parent) continue;
    if (!r.pins.length) { r.pins = parent.pins; r.units = parent.units; }
    r.fields = { ...parent.fields, ...r.fields };
    r.power ||= parent.power;
  }
  return raw;
}

// ---------------------------------------------------------------------------------------------
// Footprints
// ---------------------------------------------------------------------------------------------

function grow(b: [number, number, number, number] | undefined, x: number, y: number): [number, number, number, number] {
  return b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
}

function graphicPoints(g: SExpr[]): [number, number][] {
  const pts: [number, number][] = [];
  for (const k of ["start", "end", "mid", "center"]) {
    const n = nums(kid(g, k));
    if (n.length >= 2) pts.push([n[0]!, n[1]!]);
  }
  if (g[0] === "fp_circle") {
    const c = nums(kid(g, "center")), e = nums(kid(g, "end"));
    if (c.length >= 2 && e.length >= 2) {
      const r = Math.hypot(e[0]! - c[0]!, e[1]! - c[1]!);
      pts.push([c[0]! - r, c[1]! - r], [c[0]! + r, c[1]! + r]);
    }
  }
  for (const xy of kids(kid(g, "pts") ?? [], "xy")) {
    const n = nums(xy);
    if (n.length >= 2) pts.push([n[0]!, n[1]!]);
  }
  return pts;
}

export async function readFootprint(file: string, id: string, projectDir: string): Promise<FootprintDetail> {
  const root = parseSexpr(await readFile(file, "utf8"))[0];
  if (!Array.isArray(root)) throw new Error(`not a footprint: ${file}`);
  const pads: Pad[] = kids(root, "pad").map((p) => {
    const at = nums(kid(p, "at")), size = nums(kid(p, "size"));
    const drill = kid(p, "drill");
    return {
      number: String(p[1] ?? ""),
      type: String(p[2] ?? ""),
      shape: String(p[3] ?? ""),
      at: [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0],
      size: [size[0] ?? 0, size[1] ?? 0],
      ...(drill && { drill: nums(drill).length ? nums(drill) : nums(drill, 2) }),
      layers: (kid(p, "layers") ?? []).slice(1).map(String),
    };
  });
  let courtyard: FootprintDetail["courtyard"], fab: FootprintDetail["fab"];
  for (const g of root.filter((c): c is SExpr[] => Array.isArray(c) && /^fp_(line|rect|poly|circle|arc)$/.test(String(c[0])))) {
    const layer = val(g, "layer") ?? "";
    for (const [x, y] of graphicPoints(g)) {
      if (/CrtYd/.test(layer)) courtyard = grow(courtyard, x, y);
      else if (/Fab/.test(layer)) fab = grow(fab, x, y);
    }
  }
  const models: Model[] = [];
  for (const m of kids(root, "model")) {
    const path = String(m[1] ?? "");
    const resolvedRaw = expandVars(path, projectDir);
    const resolved = isAbsolute(resolvedRaw) ? resolvedRaw : resolve(projectDir, resolvedRaw);
    const xyz = (k: string, d: number): [number, number, number] => {
      const n = nums(kid(kid(m, k) ?? [], "xyz"));
      return [n[0] ?? d, n[1] ?? d, n[2] ?? d];
    };
    models.push({ path, resolved, exists: !resolved.includes("${") && (await exists(resolved)), offset: xyz("offset", 0), scale: xyz("scale", 1), rotate: xyz("rotate", 0) });
  }
  const attr = kid(root, "attr");
  return {
    id, file,
    description: val(root, "descr") ?? val(root, "description") ?? "",
    attributes: attr ? attr.slice(1).map(String) : [],
    pads, courtyard, fab, models,
  };
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Generic, standard-agnostic checks: does the part hang together? (House style is the agent's job.) */
function checkPart(sym: RawSymbol, fpRef: string, fp: FootprintDetail | undefined, fpProblem: string | undefined): PartIssue[] {
  const issues: PartIssue[] = [];
  const add = (level: PartIssue["level"], code: string, text: string) => issues.push({ level, code, text });
  if (!sym.fields.Reference) add("error", "no_reference", "Reference field is empty");
  if (!sym.fields.Value) add("warning", "no_value", "Value field is empty");
  const seen = new Map<string, number>();
  for (const p of sym.pins) {
    if (!p.number) add("error", "pin_without_number", `pin "${p.name}" has no number`);
    const k = `${p.unit}:${p.number}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1 && k.split(":")[1]) add("warning", "duplicate_pin", `pin ${k.split(":")[1]} appears ${n}× in unit ${k.split(":")[0]} (stacked pins must be hidden duplicates)`);
  if (sym.power) return issues;

  if (!fpRef) { add("warning", "no_footprint", "no Footprint assigned"); return issues; }
  if (fpProblem) { add("error", "footprint_missing", fpProblem); return issues; }
  if (!fp) return issues;

  const padNums = new Set(fp.pads.filter((p) => p.number && p.type !== "np_thru_hole").map((p) => p.number));
  const pinNums = new Set(sym.pins.map((p) => p.number).filter(Boolean));
  const noPad = [...pinNums].filter((n) => !padNums.has(n));
  const noPin = [...padNums].filter((n) => !pinNums.has(n));
  if (noPad.length) add("error", "pin_without_pad", `symbol pins with no pad: ${noPad.join(", ")}`);
  if (noPin.length) add("warning", "pad_without_pin", `pads with no symbol pin (unconnected on boards): ${noPin.join(", ")}`);
  if (!fp.courtyard) add("warning", "no_courtyard", "footprint has no courtyard (F.CrtYd/B.CrtYd)");
  if (!fp.models.length) add("warning", "no_model", "footprint has no 3D model");
  for (const m of fp.models) {
    if (STOCK_VAR.test(m.path)) add("warning", "stock_model", `3D model uses a stock KiCad path: ${m.path}`);
    else if (!m.exists) add("error", "model_missing", `3D model file not found: ${m.path}`);
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

interface Loaded {
  libs: LibraryRef[];
  symbols: { lib: LibraryRef; sym: RawSymbol }[];
  fpLibs: Map<string, LibraryRef>;
}

async function load(ctx: LibContext): Promise<Loaded> {
  const libs = await libraryTables(ctx);
  const symbols: Loaded["symbols"] = [];
  for (const lib of libs.filter((l) => l.kind === "sym" && l.exists)) {
    const text = await readFile(lib.path, "utf8").catch(() => "");
    for (const sym of readSymbols(text)) symbols.push({ lib, sym });
  }
  return { libs, symbols, fpLibs: new Map(libs.filter((l) => l.kind === "fp").map((l) => [l.name, l])) };
}

async function resolveFootprint(l: Loaded, ref: string, projectDir: string): Promise<{ fp?: FootprintDetail; problem?: string }> {
  const [libName, fpName] = ref.includes(":") ? ref.split(":", 2) as [string, string] : ["", ref];
  const lib = l.fpLibs.get(libName);
  if (!lib) return { problem: `footprint library "${libName}" is not in an fp-lib-table of this project/workspace (${ref})` };
  const file = join(lib.path, `${fpName}.kicad_mod`);
  if (!(await exists(file))) return { problem: `footprint ${ref} not found (${file})` };
  try { return { fp: await readFootprint(file, ref, projectDir) }; }
  catch (e) { return { problem: `footprint ${ref} unreadable: ${(e as Error).message}` }; }
}

function summary(lib: LibraryRef, sym: RawSymbol, issues: PartIssue[], hasModel: boolean): PartSummary {
  return {
    id: `${lib.name}:${sym.name}`,
    lib: lib.name,
    name: sym.name,
    reference: sym.fields.Reference ?? "",
    value: sym.fields.Value ?? "",
    description: sym.fields.Description ?? sym.fields.ki_description ?? "",
    footprint: sym.fields.Footprint ?? "",
    power: sym.power,
    pins: new Set(sym.pins.map((p) => p.number)).size,
    units: sym.units,
    hasModel,
    errors: issues.filter((i) => i.level === "error").length,
    warnings: issues.filter((i) => i.level === "warning").length,
  };
}

/** All parts of all libraries (with checks), plus footprints no symbol uses. */
export async function libraryInfo(ctx: LibContext, opts: CheckOptions = {}): Promise<LibraryInfo> {
  const l = await load(ctx);
  const used = new Set<string>();
  const parts: PartSummary[] = [];
  for (const { lib, sym } of l.symbols) {
    const fpRef = sym.fields.Footprint ?? "";
    if (fpRef) used.add(fpRef);
    const { fp, problem } = fpRef && !sym.power ? await resolveFootprint(l, fpRef, ctx.projectDir) : {};
    const issues = checkPart(sym, fpRef, fp, problem);
    if (opts.klc) issues.push(...(await klcIssues(sym, fp)));
    parts.push(summary(lib, sym, issues, !!fp?.models.some((m) => m.exists)));
  }
  const orphanFootprints: string[] = [];
  for (const lib of l.libs.filter((x) => x.kind === "fp" && x.exists)) {
    for (const f of await readdir(lib.path).catch(() => [] as string[])) {
      if (!f.endsWith(".kicad_mod")) continue;
      const id = `${lib.name}:${basename(f, ".kicad_mod")}`;
      if (!used.has(id)) orphanFootprints.push(id);
    }
  }
  return { libraries: l.libs, parts, orphanFootprints: orphanFootprints.sort() };
}

/**
 * One part in full. `ref` is "Lib:Name", or just "Name" / a unique case-insensitive substring
 * (also matched against Value). Returns an error string if nothing or several parts match.
 */
export async function partDetail(ctx: LibContext, ref: string, opts: CheckOptions = {}): Promise<PartDetail | string> {
  const l = await load(ctx);
  const id = (x: Loaded["symbols"][number]) => `${x.lib.name}:${x.sym.name}`;
  let hits = l.symbols.filter((x) => id(x) === ref || x.sym.name === ref);
  if (!hits.length) {
    const q = ref.toLowerCase();
    hits = l.symbols.filter((x) => id(x).toLowerCase().includes(q) || (x.sym.fields.Value ?? "").toLowerCase().includes(q));
  }
  if (hits.length !== 1) {
    return hits.length ? `"${ref}" matches ${hits.length} parts: ${hits.slice(0, 15).map(id).join(", ")}` : `No part matching "${ref}" in ${l.libs.filter((x) => x.kind === "sym").map((x) => x.name).join(", ") || "(no symbol libraries in the lib tables)"}`;
  }
  const { lib, sym } = hits[0]!;
  const fpRef = sym.fields.Footprint ?? "";
  const { fp, problem } = fpRef && !sym.power ? await resolveFootprint(l, fpRef, ctx.projectDir) : {};
  const issues = checkPart(sym, fpRef, fp, problem);
  if (opts.klc) issues.push(...(await klcIssues(sym, fp)));
  return {
    ...summary(lib, sym, issues, !!fp?.models.some((m) => m.exists)),
    file: lib.path,
    fields: sym.fields,
    ...(sym.extends && { extends: sym.extends }),
    pinList: sym.pins,
    ...(fp && { footprintDetail: fp }),
    issues,
  };
}

/** Footprint by "Lib:Name" (for footprint-only views). */
export async function footprintDetail(ctx: LibContext, ref: string): Promise<FootprintDetail | string> {
  const l = await load(ctx);
  const { fp, problem } = await resolveFootprint(l, ref, ctx.projectDir);
  return fp ?? problem ?? `footprint ${ref} not found`;
}
