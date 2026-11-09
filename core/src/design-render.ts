// Images of the design for the agent (`kretsa render`): schematic pages and the board as PNG, whole or
// cropped around parts or a net, with what was asked for marked in magenta; and 3D renders of the board.
// Pipeline: kicad-cli sch|pcb export svg (document mm, cached per file hash) -> crop viewBox + overlay -> resvg.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { ProjectInfo } from "../../shared/review";
import { runCli } from "./check";
import { type Board, type Box, padBoxBy, parseBoard, parseSheet, type Pt, type SchSymbol, unionBox, netMatches } from "./design";
import { CLI, exportNetlist, STOCK_WRL } from "./kicad";
import { mainPcb, rootSchematic } from "./project";

export const INK = "#ff3df5";

export interface RenderOptions {
  /** Refdes (comma separated for several) to center on and mark. */
  around?: string;
  /** Net name (or a pad like U3.4) to show and mark. */
  net?: string;
  /** pcb: kicad layer list, e.g. "F.Cu,F.SilkS,Edge.Cuts". */
  layers?: string;
  side?: "top" | "bottom";
  /** sch: only pages whose name contains this. */
  sheet?: string;
  /** Long side of the PNG in px (default 1600). */
  size?: number;
  /** Extra space around the crop, mm. */
  margin?: number;
  outDir: string;
}

export interface RenderResult {
  file: string;
  view: "sch" | "pcb" | "3d";
  page?: string;
  window_mm?: Box;
  px?: [number, number];
  marked: string[];
  notes: string[];
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);
const safe = (s: string) => s.replace(/[^\w.+-]+/g, "_");
const f1 = (n: number) => n.toFixed(1);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cropToPng(svg: string, win: Box | undefined, overlay: string, size: number, background: string): { png: Buffer; px: [number, number] } {
  // kicad-cli adds every text again as an invisible <text> (for search); resvg panics laying some out when zoomed.
  svg = svg.replace(/<text\b[^>]*>[^<]*<\/text>/g, "");
  if (win) {
    svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${win[0]} ${win[1]} ${win[2] - win[0]} ${win[3] - win[1]}"`);
  }
  svg = svg.replace(/(<svg[^>]*?)\swidth="[^"]*"\s+height="[^"]*"/, "$1");
  if (overlay) svg = svg.replace(/<\/svg>\s*$/, `<g fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">${overlay}</g></svg>`);
  const vb = svg.match(/viewBox="([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)"/);
  const w = Number(vb?.[3] ?? 1), h = Number(vb?.[4] ?? 1);
  const fit = w >= h ? { mode: "width" as const, value: size } : { mode: "height" as const, value: size };
  const r = new Resvg(svg, { fitTo: fit, background, font: { loadSystemFonts: true } }).render();
  return { png: r.asPng(), px: [r.width, r.height] };
}

/** Make a crop window at least `min` mm wide/high, around `b` plus `margin`. */
function windowAround(b: Box, margin: number, min: [number, number]): Box {
  let [x1, y1, x2, y2] = padBoxBy(b, margin);
  if (x2 - x1 < min[0]) { const c = (x1 + x2) / 2; x1 = c - min[0] / 2; x2 = c + min[0] / 2; }
  if (y2 - y1 < min[1]) { const c = (y1 + y2) / 2; y1 = c - min[1] / 2; y2 = c + min[1] / 2; }
  return [x1, y1, x2, y2];
}

const rectSvg = (b: Box, w: number) => `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" stroke-width="${w}" stroke-dasharray="${w * 3} ${w * 2}"/>`;
const circleSvg = (p: Pt, r: number, w: number) => `<circle cx="${p[0]}" cy="${p[1]}" r="${r}" stroke-width="${w}"/>`;

function refList(s: string): string[] { return s.split(/[,\s]+/).filter(Boolean); }

// ---------------------------------------------------------------------------------------------
// PCB
// ---------------------------------------------------------------------------------------------

async function boardSvg(project: ProjectInfo, pcbRel: string, layers: string): Promise<string> {
  const pcbHash = project.files.find((f) => f.path === pcbRel)?.hash ?? "x";
  const out = join(project.dir, ".kretsa", "cache", `pcb-${pcbHash}-${hash(layers)}.svg`);
  if (await exists(out)) return readFile(out, "utf8");
  await mkdir(join(project.dir, ".kretsa", "cache"), { recursive: true });
  const r = await runCli(["pcb", "export", "svg", "--mode-single", "--exclude-drawing-sheet", "--page-size-mode", "0", "-l", layers, "-o", out], project.dir, join(project.dir, pcbRel));
  if (!(await exists(out))) throw new Error(`kicad-cli pcb export svg failed (exit ${r.code}): ${r.out.trim()}`);
  return readFile(out, "utf8");
}

/** Pads, tracks and vias of the net `query` (a name, or a pad "U3.4" whose net is meant). */
export function boardNet(board: Board, query: string) {
  let name = "";
  const pad = query.match(/^(.+)\.([\w-]+)$/);
  if (pad) {
    const fp = board.footprints.find((f) => f.ref === pad[1]);
    name = fp?.pads.find((p) => p.number === pad[2])?.net ?? "";
  }
  if (!name) {
    const names = new Set([...board.footprints.flatMap((f) => f.pads.map((p) => p.net)), ...board.tracks.map((t) => t.net)]);
    name = [...names].find((n) => n === query) ?? [...names].find((n) => netMatches(n, query)) ?? "";
  }
  if (!name) return null;
  const pads = board.footprints.flatMap((f) => f.pads.filter((p) => p.net === name).map((p) => ({ ...p, ref: f.ref })));
  const tracks = board.tracks.filter((t) => t.net === name);
  const zones = board.zones.filter((z) => z.net === name);
  return { name, pads, tracks, zones };
}

export async function renderPcb(project: ProjectInfo, o: RenderOptions): Promise<RenderResult> {
  const pcbRel = mainPcb(project);
  if (!pcbRel) throw new Error("no .kicad_pcb in the project");
  const board = parseBoard(await readFile(join(project.dir, pcbRel), "utf8"));
  const bottom = o.side === "bottom";
  const layers = o.layers ?? (bottom ? "B.Cu,B.SilkS,B.Fab,Edge.Cuts" : "B.Cu,F.Cu,F.SilkS,F.Fab,Edge.Cuts");
  const svg = await boardSvg(project, pcbRel, layers);
  const notes: string[] = [`layers: ${layers}${bottom ? " (bottom, seen through the board from the top, not mirrored)" : ""}`];
  const marked: string[] = [];
  let overlay = "";
  let focus: Box | undefined;
  let name = "board";
  const all = board.edge ?? board.footprints.reduce<Box | undefined>((b, f) => unionBox(b, f.bbox), undefined);

  if (o.around) {
    for (const ref of refList(o.around)) {
      const fp = board.footprints.find((f) => f.ref === ref) ?? board.footprints.find((f) => f.ref.toLowerCase() === ref.toLowerCase());
      if (!fp) throw new Error(`no footprint ${ref} on the board`);
      focus = unionBox(focus, fp.bbox);
      overlay += rectSvg(padBoxBy(fp.bbox, 0.3), 0.12);
      marked.push(`${fp.ref} (dashed box)`);
      notes.push(`${fp.ref}: ${fp.value} · ${fp.lib} · at (${f1(fp.at[0])}, ${f1(fp.at[1])}) mm, ${fp.at[2]}° · ${fp.layer} · ${fp.pads.length} pads`);
    }
    name = `around-${safe(o.around)}`;
  }
  if (o.net) {
    const n = boardNet(board, o.net);
    if (!n) {
      const names = [...new Set(board.footprints.flatMap((f) => f.pads.map((p) => p.net)).filter(Boolean))];
      const q = o.net.toLowerCase().replace(/^\//, "");
      const near = names.filter((x) => x.toLowerCase().includes(q)).slice(0, 12);
      throw new Error(`no net "${o.net}" on the board${near.length ? ` (similar: ${near.join(", ")})` : ""}`);
    }
    for (const t of n.tracks) {
      if (t.kind === "via") { overlay += circleSvg(t.start, t.width / 2 + 0.15, 0.1); focus = unionBox(focus, padBoxBy([...t.start, ...t.start], t.width)); }
      else {
        overlay += `<line x1="${t.start[0]}" y1="${t.start[1]}" x2="${t.end[0]}" y2="${t.end[1]}" stroke-width="${t.width + 0.25}" stroke-opacity="0.55"/>`;
        focus = unionBox(focus, [Math.min(t.start[0], t.end[0]), Math.min(t.start[1], t.end[1]), Math.max(t.start[0], t.end[0]), Math.max(t.start[1], t.end[1])]);
      }
    }
    for (const p of n.pads) {
      const r = Math.max(p.size[0], p.size[1]) / 2 + 0.25;
      overlay += circleSvg(p.at, r, 0.12);
      focus = unionBox(focus, padBoxBy([...p.at, ...p.at], r));
    }
    marked.push(`net ${n.name}: ${n.pads.length} pads circled, ${n.tracks.filter((t) => t.kind !== "via").length} track segments and ${n.tracks.filter((t) => t.kind === "via").length} vias traced`);
    notes.push(`net ${n.name} pads: ${n.pads.map((p) => `${p.ref}.${p.number}`).join(", ") || "none"}`);
    if (n.zones.length) notes.push(`net ${n.name} has zones on ${[...new Set(n.zones.flatMap((z) => z.layers))].join(", ")}`);
    if (!n.tracks.length && n.pads.length > 1) notes.push(`net ${n.name} has no tracks (unrouted, or connected only by zones)`);
    name = `${name === "board" ? "" : name + "-"}net-${safe(n.name)}`;
  }
  const win = focus ? windowAround(focus, o.margin ?? 4, [12, 9]) : all ? padBoxBy(all, o.margin ?? 2) : undefined;
  const { png, px } = cropToPng(svg, win, overlay, o.size ?? 1600, "#101010");
  await mkdir(o.outDir, { recursive: true });
  const file = join(o.outDir, `pcb-${bottom ? "bottom-" : ""}${name}.png`);
  await writeFile(file, png);
  return { file, view: "pcb", window_mm: win, px, marked, notes };
}

// ---------------------------------------------------------------------------------------------
// Schematic
// ---------------------------------------------------------------------------------------------

interface SchPage { name: string; file: string; svg: string }

async function schPages(project: ProjectInfo): Promise<SchPage[]> {
  const root = rootSchematic(project);
  if (!root) throw new Error("no .kicad_sch in the project");
  const dir = join(project.dir, ".kretsa", "cache", `sch-${project.rev}`);
  if (!(await exists(join(dir, ".done")))) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const r = await runCli(["sch", "export", "svg", "--exclude-drawing-sheet", "-o", dir], project.dir, join(project.dir, root));
    if (!(await readdir(dir)).some((f) => f.endsWith(".svg"))) throw new Error(`kicad-cli sch export svg failed (exit ${r.code}): ${r.out.trim()}`);
    await writeFile(join(dir, ".done"), "");
  }
  const base = basename(root, ".kicad_sch");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".svg")).sort((a, b) => (a === `${base}.svg` ? -1 : b === `${base}.svg` ? 1 : a.localeCompare(b)));
  return Promise.all(files.map(async (f) => ({
    name: f === `${base}.svg` ? "/ (root)" : f.slice(base.length + 1, -4),
    file: f,
    svg: await readFile(join(dir, f), "utf8"),
  })));
}

/** The page that shows `ref` (kicad-cli keeps every text as an invisible <text> element). */
function pageOf(pages: SchPage[], ref: string): SchPage | undefined {
  const re = new RegExp(`>${reEsc(ref)}[A-Z]?</text>`);
  return pages.find((p) => re.test(p.svg));
}

export async function renderSch(project: ProjectInfo, o: RenderOptions): Promise<RenderResult[]> {
  const pages = await schPages(project);
  const symbols: SchSymbol[] = [];
  for (const f of project.files.filter((f) => f.kind === "sch")) symbols.push(...parseSheet(await readFile(join(project.dir, f.path), "utf8"), f.path));
  const symOf = (ref: string) => symbols.find((s) => s.refs.includes(ref));
  const size = o.size ?? 1600;
  await mkdir(o.outDir, { recursive: true });
  const out: RenderResult[] = [];
  const emit = async (page: SchPage, tag: string, win: Box | undefined, overlay: string, marked: string[], notes: string[]) => {
    const { png, px } = cropToPng(page.svg, win, overlay, size, "#ffffff");
    const file = join(o.outDir, `sch-${safe(page.name === "/ (root)" ? "root" : page.name)}${tag ? `-${tag}` : ""}.png`);
    await writeFile(file, png);
    out.push({ file, view: "sch", page: page.name, window_mm: win, px, marked, notes });
  };

  if (o.around || o.net) {
    // Group everything to mark by page.
    const byPage = new Map<SchPage, { box?: Box; overlay: string; marked: string[]; notes: string[] }>();
    const slot = (p: SchPage) => byPage.get(p) ?? byPage.set(p, { overlay: "", marked: [], notes: [] }).get(p)!;
    for (const ref of o.around ? refList(o.around) : []) {
      const sym = symOf(ref);
      const page = pageOf(pages, ref);
      if (!sym || !page) throw new Error(`no symbol ${ref} on the schematic`);
      const s = slot(page);
      s.box = unionBox(s.box, sym.bbox);
      s.overlay += rectSvg(padBoxBy(sym.bbox, 1.27), 0.35);
      s.marked.push(`${ref} (dashed box)`);
      s.notes.push(`${ref}: ${sym.value} · ${sym.lib}${sym.footprint ? ` · ${sym.footprint}` : ""} · at (${f1(sym.at[0])}, ${f1(sym.at[1])}) mm on ${sym.file}`);
    }
    if (o.net) {
      const root = rootSchematic(project)!;
      const nl = await exportNetlist(project.dir, join(project.dir, root), project.rev);
      const pad = o.net.match(/^(.+)\.([\w-]+)$/);
      const net = (pad && nl.nets.find((n) => n.nodes.includes(o.net!))) || nl.nets.find((n) => n.name === o.net) || nl.nets.find((n) => netMatches(n.name, o.net!));
      if (!net) {
        const q = o.net.toLowerCase().replace(/^\//, "");
        const near = nl.nets.map((n) => n.name).filter((x) => x.toLowerCase().includes(q)).slice(0, 12);
        throw new Error(`no net "${o.net}" in the schematic${near.length ? ` (similar: ${near.join(", ")})` : ""}`);
      }
      const missing: string[] = [];
      for (const node of net.nodes) {
        const i = node.lastIndexOf(".");
        const ref = node.slice(0, i), pin = node.slice(i + 1);
        const sym = symbols.find((s) => s.refs.includes(ref) && s.pins.some((p) => p.number === pin));
        const page = pageOf(pages, ref);
        const at = sym?.pins.find((p) => p.number === pin)?.at;
        if (!at || !page) { missing.push(node); continue; }
        const s = slot(page);
        s.box = unionBox(s.box, [at[0], at[1], at[0], at[1]]);
        s.overlay += circleSvg(at, 1.4, 0.35);
        s.marked.push(node);
      }
      for (const s of byPage.values()) s.notes.unshift(`net ${net.name} (${net.nodes.length} pins): pins circled on this page: ${s.marked.filter((m) => !m.includes(" ")).join(", ")}`);
      if (missing.length) out.push({ file: "", view: "sch", marked: [], notes: [`net ${net.name}: not located on any page: ${missing.join(", ")}`] });
    }
    const tag = [o.around && `around-${safe(o.around)}`, o.net && `net-${safe(o.net)}`].filter(Boolean).join("-");
    for (const [page, s] of byPage) {
      await emit(page, tag, s.box ? windowAround(s.box, o.margin ?? 12, [60, 40]) : undefined, s.overlay, s.marked, s.notes);
    }
    return out.filter((r) => r.file || r.notes.length);
  }

  const chosen = o.sheet ? pages.filter((p) => p.name.toLowerCase().includes(o.sheet!.toLowerCase()) || p.file.toLowerCase().includes(o.sheet!.toLowerCase())) : pages;
  if (!chosen.length) throw new Error(`no sheet matching "${o.sheet}" (pages: ${pages.map((p) => p.name).join(", ")})`);
  for (const p of chosen) await emit(p, "", undefined, "", [], []);
  return out;
}

// ---------------------------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------------------------

export async function renderBoard3d(project: ProjectInfo, o: RenderOptions & { view?: "top" | "bottom" | "iso" }): Promise<RenderResult> {
  const pcbRel = mainPcb(project);
  if (!pcbRel) throw new Error("no .kicad_pcb in the project");
  await mkdir(o.outDir, { recursive: true });
  const view = o.view ?? (o.side === "bottom" ? "bottom" : "iso");
  const tmp = join(project.dir, ".kretsa", "cache", `render3d-${process.pid}.kicad_pcb`);
  await writeFile(tmp, (await readFile(join(project.dir, pcbRel), "utf8")).replace(STOCK_WRL, '$1.step"'));
  const file = join(o.outDir, `3d-${view}.png`);
  const size = o.size ?? 1600;
  const args = [CLI, "pcb", "render", "-w", String(size), "-h", String(Math.round(size * 0.75)), "--quality", "high", "--background", "opaque",
    "-D", `KIPRJMOD=${project.dir}`,
    ...(view === "iso" ? ["--rotate", "-45,0,30", "--zoom", "0.9"] : ["--side", view]), "-o", file, tmp];
  try {
    const p = Bun.spawn(args, { cwd: project.dir, stdout: "pipe", stderr: "pipe" });
    const [so, se, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0 || !(await exists(file))) throw new Error(`kicad-cli pcb render failed (exit ${code}): ${(se || so).trim()}`);
  } finally {
    const base = tmp.replace(/\.kicad_pcb$/, "");
    await Promise.all(["kicad_pcb", "kicad_prl", "kicad_pro"].map((e) => rm(`${base}.${e}`, { force: true })));
  }
  return { file, view: "3d", marked: [], notes: [`view: ${view}`] };
}

export function renderMarkdown(results: RenderResult[], title: string): string {
  const lines = [`# Render · ${title}`, ""];
  for (const r of results) {
    if (!r.file) { lines.push(...r.notes.map((n) => `- ⚠ ${n}`), ""); continue; }
    lines.push(`## ${r.file}`, "");
    const meta = [r.page && `page ${r.page}`, r.window_mm && `window [${r.window_mm.map(f1).join(", ")}] mm`, r.px && `${r.px[0]}×${r.px[1]} px`].filter(Boolean);
    if (meta.length) lines.push(meta.join(" · "), "");
    if (r.marked.length) lines.push(`Marked in magenta: ${r.marked.join(", ")}`, "");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  lines.push("Look at the PNGs. Coordinates are KiCad document mm (y down).", "");
  return lines.join("\n");
}
