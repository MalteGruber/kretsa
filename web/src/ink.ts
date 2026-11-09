// Freehand annotation ("ink") on schematic / PCB panes, stored in KiCad document mm.
// Shapes are summarized for the AI (what they enclose / point at) when the comment is posted.

import type { InkShape } from "../../shared/review";

export type Tool = InkShape["tool"];
type Pt = [number, number];

export const INK_COLOR = "#ff3df5"; // magenta: distinct from F.Cu red, silk yellow and wires

/** Ramer–Douglas–Peucker polyline simplification (tolerance in mm). */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0]!, pts.at(-1)!];
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i]!, a, b);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

function distToSeg(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function bboxOf(pts: Pt[]): [number, number, number, number] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function inPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export interface RefBox { ref: string; bbox: [number, number, number, number] }

const center = (b: RefBox["bbox"]): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const contains = (b: RefBox["bbox"], p: Pt) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const round = (p: Pt): Pt => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

/** The smallest part box containing p. */
function partAt(boxes: RefBox[], p: Pt): string | undefined {
  return boxes.filter((b) => contains(b.bbox, p))
    .sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0]?.ref;
}

/** Turn a raw stroke into a stored shape, working out which parts it refers to. */
export function finishShape(tool: Tool, raw: Pt[], boxes: RefBox[], mmPerPx: number): InkShape | null {
  if (raw.length < 2) return null;
  const a = raw[0]!, b = raw.at(-1)!;
  if (tool === "rect") {
    const bb = bboxOf([a, b]);
    if (bb[2] - bb[0] < 2 * mmPerPx && bb[3] - bb[1] < 2 * mmPerPx) return null;
    const covers = boxes.filter((x) => contains(bb, center(x.bbox))).map((x) => x.ref);
    return { tool, bbox_mm: bb.map((n) => +n.toFixed(2)) as InkShape["bbox_mm"], covers: cap(covers), pts_mm: [round(a), round(b)] };
  }
  if (tool === "arrow") {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 8 * mmPerPx) return null;
    const from_ref = partAt(boxes, a), to_ref = partAt(boxes, b);
    return {
      tool, bbox_mm: bboxOf([a, b]).map((n) => +n.toFixed(2)) as InkShape["bbox_mm"],
      from_mm: round(a), to_mm: round(b), ...(from_ref && { from_ref }), ...(to_ref && to_ref !== from_ref && { to_ref }),
      pts_mm: [round(a), round(b)],
    };
  }
  const pts = simplify(raw, 1.5 * mmPerPx).map(round);
  const bb = bboxOf(pts);
  const size = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  // A loop (end near start) encloses parts; an open stroke (underline, scribble, cross) touches them.
  const closed = pts.length > 3 && Math.hypot(b[0] - a[0], b[1] - a[1]) < size * 0.3;
  const covers = closed
    ? boxes.filter((x) => inPoly(center(x.bbox), pts)).map((x) => x.ref)
    : boxes.filter((x) => raw.some((p) => contains(x.bbox, p))).map((x) => x.ref);
  return { tool: "pen", bbox_mm: bb.map((n) => +n.toFixed(2)) as InkShape["bbox_mm"], covers: cap(covers), pts_mm: pts };
}

const cap = (refs: string[]) => [...new Set(refs)].filter((r) => !r.startsWith("#")).slice(0, 12);

/** SVG markup for shapes, projected to screen px with `toScreen`. */
export function inkMarkup(shapes: InkShape[], toScreen: (p: Pt) => Pt | null, opts: { width?: number; opacity?: number } = {}): string {
  const w = opts.width ?? 3;
  return shapes.map((s) => {
    const pts = s.pts_mm.map((p) => toScreen(p)).filter((p): p is Pt => !!p);
    if (pts.length < 2) return "";
    const attrs = `stroke="${INK_COLOR}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${opts.opacity ?? 1}"`;
    if (s.tool === "rect") {
      const [x1, y1, x2, y2] = bboxOf(pts);
      return `<rect ${attrs} x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" rx="2"/>`;
    }
    const line = `<polyline ${attrs} points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
    if (s.tool !== "arrow") return line;
    const [a, b] = [pts[0]!, pts[1]!];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 6 + w * 3;
    const h1 = [b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)];
    const h2 = [b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)];
    return `${line}<path d="M${h1.join(" ")}L${b.join(" ")}L${h2.join(" ")}Z" fill="${INK_COLOR}" opacity="${opts.opacity ?? 1}"/>`;
  }).join("");
}

/** Draw shapes onto a 2D canvas context (for snapshots). `toPx` maps mm -> canvas px. */
export function paintInk(ctx: CanvasRenderingContext2D, shapes: InkShape[], toPx: (p: Pt) => Pt | null, width: number) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = INK_COLOR;
  ctx.lineWidth = width;
  ctx.lineCap = ctx.lineJoin = "round";
  for (const s of shapes) {
    const pts = s.pts_mm.map(toPx).filter((p): p is Pt => !!p);
    if (pts.length < 2) continue;
    ctx.beginPath();
    if (s.tool === "rect") {
      const [x1, y1, x2, y2] = bboxOf(pts);
      ctx.rect(x1, y1, x2 - x1, y2 - y1);
    } else pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.stroke();
    if (s.tool === "arrow") {
      const [a, b] = [pts[0]!, pts[1]!];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = width * 5;
      ctx.beginPath();
      ctx.moveTo(b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45));
      ctx.lineTo(...b);
      ctx.lineTo(b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}
