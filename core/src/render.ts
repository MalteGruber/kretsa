// Part renders an agent can look at: symbol and footprint PNGs (kicad-cli SVG export -> resvg) and
// 3D renders of the footprint with its model on a scratch board (kicad-cli pcb render).

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { FootprintDetail, PartDetail } from "../../shared/library";
import { CLI } from "./kicad";
import { expandVars } from "./library";

async function run(args: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn([CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`kicad-cli ${args.slice(0, 3).join(" ")} failed (exit ${code}): ${(e || o).trim()}`);
  return o + e;
}

/** Grow an SVG's viewBox by `frac` on every side (kicad-cli crops to the exact item extents). */
export function padSvg(svg: string, frac = 0.06): string {
  return svg.replace(/viewBox="([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)"/, (_m, x, y, w, h) => {
    const [X, Y, W, H] = [x, y, w, h].map(Number) as [number, number, number, number];
    const d = Math.max(W, H) * frac;
    return `viewBox="${X - d} ${Y - d} ${W + 2 * d} ${H + 2 * d}"`;
  }).replace(/(<svg[^>]*?)\swidth="[^"]*"\s+height="[^"]*"/, "$1");
}

export function svgToPng(svg: string, width = 900, background = "#ffffff"): Buffer {
  svg = padSvg(svg);
  const r = new Resvg(svg, { fitTo: { mode: "width", value: width }, background, font: { loadSystemFonts: true } });
  return r.render().asPng();
}

const safe = (s: string) => s.replace(/[^\w.+-]+/g, "_");

/** Symbol units as PNG (and SVG). Returns the PNG paths, one per unit. */
export async function renderSymbol(libFile: string, name: string, outDir: string): Promise<string[]> {
  const tmp = join(outDir, ".sym");
  await mkdir(tmp, { recursive: true });
  try {
    await run(["sym", "export", "svg", "-s", name, "-o", tmp, libFile]);
    const out: string[] = [];
    for (const f of (await readdir(tmp)).filter((f) => f.endsWith(".svg")).sort()) {
      const unit = f.match(/_unit(\d+)\.svg$/)?.[1] ?? "1";
      const png = join(outDir, `symbol_unit${unit}.png`);
      const svg = await readFile(join(tmp, f), "utf8");
      await writeFile(join(outDir, `symbol_unit${unit}.svg`), svg);
      await writeFile(png, svgToPng(svg, 900));
      out.push(png);
    }
    return out;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/** Footprint (all layers, pad numbers sketched on fab) as PNG + SVG. */
export async function renderFootprint(fp: FootprintDetail, outDir: string, projectDir: string): Promise<string> {
  const tmp = join(outDir, ".fp");
  await mkdir(tmp, { recursive: true });
  try {
    const name = fp.id.split(":").slice(1).join(":") || fp.id;
    await run(["fp", "export", "svg", "--fp", name, "--sp", "-D", `KIPRJMOD=${projectDir}`, "-o", tmp, dirname(fp.file)]);
    const svgFile = (await readdir(tmp)).find((f) => f.endsWith(".svg"));
    if (!svgFile) throw new Error("kicad-cli wrote no footprint SVG");
    const svg = await readFile(join(tmp, svgFile), "utf8");
    await writeFile(join(outDir, "footprint.svg"), svg);
    const png = join(outDir, "footprint.png");
    await writeFile(png, svgToPng(svg, 1000));
    return png;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/**
 * A board containing only this footprint (model paths made absolute) with an outline around it.
 * The board's format version follows the footprint's, so older footprints still parse.
 */
export async function scratchBoard(fp: FootprintDetail, projectDir: string, margin = 1.5): Promise<string> {
  let text = await readFile(fp.file, "utf8");
  const version = text.match(/\(version\s+(\d+)\)/)?.[1] ?? "20221018";
  text = text.replace(/\(model\s+"([^"]*)"/g, (_m, p: string) => `(model "${fp.models.find((x) => x.path === p)?.resolved ?? expandVars(p, projectDir)}"`);
  text = text.replace(/^\s*\((footprint|module)\s+("[^"]*"|\S+)/, (_m, kw) => `(${kw} "${fp.id}"\n\t(at 0 0)`);
  const b = fp.courtyard ?? fp.fab ?? padBox(fp) ?? [-2, -2, 2, 2];
  const [x1, y1, x2, y2] = [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin];
  return `(kicad_pcb (version ${version}) (generator "kretsa")
  (general (thickness 1.6))
  ${text}
  (gr_rect (start ${x1} ${y1}) (end ${x2} ${y2}) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
)
`;
}

function padBox(fp: FootprintDetail): [number, number, number, number] | undefined {
  if (!fp.pads.length) return undefined;
  const xs = fp.pads.flatMap((p) => [p.at[0] - p.size[0] / 2, p.at[0] + p.size[0] / 2]);
  const ys = fp.pads.flatMap((p) => [p.at[1] - p.size[1] / 2, p.at[1] + p.size[1] / 2]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 3D renders (top, iso, side) of the footprint with its model. Returns PNG paths. */
export async function render3d(fp: FootprintDetail, outDir: string, projectDir: string, opts: { width?: number; height?: number } = {}): Promise<string[]> {
  const dir = join(outDir, ".3d");
  await mkdir(dir, { recursive: true });
  const board = join(dir, "part.kicad_pcb");
  await writeFile(board, await scratchBoard(fp, projectDir));
  const common = ["pcb", "render", "-w", String(opts.width ?? 900), "-h", String(opts.height ?? 700), "--quality", "high", "--background", "opaque"];
  const views: [string, string[]][] = [
    ["3d_top.png", ["--side", "top"]],
    ["3d_iso.png", ["--rotate", "-55,0,35", "--zoom", "0.8"]],
    ["3d_side.png", ["--side", "front"]],
  ];
  try {
    const out: string[] = [];
    for (const [name, args] of views) {
      const png = join(outDir, name);
      await run([...common, ...args, "-o", png, board]);
      out.push(png);
    }
    return out;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export interface PartRenders { symbol: string[]; footprint?: string; threeD: string[]; errors: string[] }

/** Everything for one part into `outDir`. Failures are collected, not thrown. */
export async function renderPart(part: PartDetail, outDir: string, projectDir: string, opts: { threeD?: boolean } = {}): Promise<PartRenders> {
  await mkdir(outDir, { recursive: true });
  const r: PartRenders = { symbol: [], threeD: [], errors: [] };
  await renderSymbol(part.file, part.name, outDir).then((p) => (r.symbol = p), (e) => r.errors.push(String(e.message ?? e)));
  const fp = part.footprintDetail;
  if (fp) {
    await renderFootprint(fp, outDir, projectDir).then((p) => (r.footprint = p), (e) => r.errors.push(String(e.message ?? e)));
    if (opts.threeD !== false) await render3d(fp, outDir, projectDir).then((p) => (r.threeD = p), (e) => r.errors.push(String(e.message ?? e)));
  }
  return r;
}
