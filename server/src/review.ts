import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Comment, CommentPatch, InkShape, NewComment, Review } from "../../shared/review";

export class ReviewStore {
  readonly wiberDir: string;
  readonly file: string;
  /** Content we last wrote ourselves, so the watcher can ignore our own writes. */
  lastWritten = "";

  constructor(projectDir: string) {
    this.wiberDir = join(projectDir, ".wiber");
    this.file = join(this.wiberDir, "review.json");
  }

  async load(): Promise<Review> {
    try {
      const r = JSON.parse(await readFile(this.file, "utf8")) as Review;
      r.comments ??= [];
      return r;
    } catch (e: any) {
      if (e?.code === "ENOENT") return { version: 1, comments: [] };
      throw e;
    }
  }

  private async save(r: Review): Promise<void> {
    const json = JSON.stringify(r, null, 2) + "\n";
    this.lastWritten = json;
    await atomicWrite(this.file, json);
    await atomicWrite(join(this.wiberDir, "REVIEW.md"), toMarkdown(r));
  }

  async add(input: NewComment, designRev: string): Promise<Comment> {
    const r = await this.load();
    const { snapshotPng, ...rest } = input;
    const c: Comment = {
      ...rest,
      id: newId(),
      status: "open",
      design_rev: designRev,
      thread: [],
      created: new Date().toISOString(),
    };
    if (snapshotPng?.startsWith("data:image/png;base64,")) {
      const rel = `snap/${c.id}.png`;
      const buf = Buffer.from(snapshotPng.slice("data:image/png;base64,".length), "base64");
      await mkdir(join(this.wiberDir, "snap"), { recursive: true });
      await writeFile(join(this.wiberDir, rel), buf);
      c.snapshot = rel;
    }
    if (c.ink_shapes?.length) {
      const rel = `ink/${c.id}.svg`;
      await atomicWrite(join(this.wiberDir, rel), inkSvg(c.ink_shapes));
      c.ink = rel;
    }
    r.comments.push(c);
    await this.save(r);
    return c;
  }

  async patch(id: string, p: CommentPatch): Promise<Comment | null> {
    const r = await this.load();
    const c = r.comments.find((c) => c.id === id);
    if (!c) return null;
    if (p.status) c.status = p.status;
    if (p.reply?.text) c.thread.push({ ...p.reply, at: new Date().toISOString() });
    await this.save(r);
    return c;
  }
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

function newId(): string {
  // time-sortable, short, collision-safe enough for a single-user review file
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Standalone SVG of the drawing in KiCad document coordinates (1 user unit = 1 mm). */
export function inkSvg(shapes: InkShape[]): string {
  const xs = shapes.flatMap((s) => [s.bbox_mm[0], s.bbox_mm[2]]), ys = shapes.flatMap((s) => [s.bbox_mm[1], s.bbox_mm[3]]);
  const m = 2, x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m;
  const w = Math.max(...xs) - x0 + m, h = Math.max(...ys) - y0 + m;
  const f = (n: number) => n.toFixed(2);
  const body = shapes.map((s) => {
    const pts = s.pts_mm.map((p) => `${f(p[0])},${f(p[1])}`).join(" ");
    const meta = `data-tool="${s.tool}"${s.covers?.length ? ` data-covers="${s.covers.join(" ")}"` : ""}`;
    if (s.tool === "rect") {
      const [[ax, ay], [bx, by]] = s.pts_mm as [[number, number], [number, number]];
      return `<rect ${meta} x="${f(Math.min(ax, bx))}" y="${f(Math.min(ay, by))}" width="${f(Math.abs(bx - ax))}" height="${f(Math.abs(by - ay))}"/>`;
    }
    if (s.tool === "arrow") return `<polyline ${meta} points="${pts}" marker-end="url(#head)"/>`;
    return `<polyline ${meta} points="${pts}"/>`;
  }).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0)} ${f(y0)} ${f(w)} ${f(h)}" width="${f(w)}mm" height="${f(h)}mm">
  <defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#ff3df5"/></marker></defs>
  <g fill="none" stroke="#ff3df5" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round">
  ${body}
  </g>
</svg>
`;
}

/** One line per drawn shape, for REVIEW.md / LLMs. */
export function describeInk(s: InkShape): string {
  const f = (p: number[]) => `(${p.map((n) => n.toFixed(1)).join(", ")})`;
  const box = `[${s.bbox_mm.map((n) => n.toFixed(1)).join(", ")}] mm`;
  if (s.tool === "arrow")
    return `arrow from ${s.from_ref ?? f(s.from_mm ?? s.pts_mm[0]!)} to ${s.to_ref ? `${s.to_ref} ` : ""}${f(s.to_mm ?? s.pts_mm.at(-1)!)} mm`;
  const what = s.tool === "rect" ? "rectangle" : "freehand mark";
  return `${what} ${box}${s.covers?.length ? ` around ${s.covers.join(", ")}` : ""}`;
}

function fmtAnchor(a: Comment["anchors"][number]): string {
  switch (a.kind) {
    case "symbol": return a.ref;
    case "net": return `net ${a.name}`;
    case "pad": return `${a.ref}.${a.pad}`;
    case "area": return `area [${a.bbox_mm.map((n) => n.toFixed(2)).join(", ")}] mm`;
    case "point": return `@(${a.at_mm.map((n) => n.toFixed(2)).join(", ")}) mm`;
  }
}

export function toMarkdown(r: Review): string {
  const open = r.comments.filter((c) => c.status === "open" || c.status === "addressed");
  const lines = [
    "# Design review",
    "",
    "_Generated from review.json by kicad-wiber. Do not edit by hand; edit review.json._",
    "",
    `Open: ${r.comments.filter((c) => c.status === "open").length} · ` +
      `Addressed (awaiting human): ${r.comments.filter((c) => c.status === "addressed").length}`,
    "",
  ];
  for (const c of open) {
    lines.push(`## ${c.id} · ${c.view}${c.file ? ` · ${c.file}` : ""} · **${c.status}**`, "");
    if (c.anchors.length) lines.push(`Anchors: ${c.anchors.map(fmtAnchor).join(", ")}`, "");
    lines.push(c.text, "");
    if (c.ink_shapes?.length) {
      lines.push("Drawing (document mm):");
      for (const s of c.ink_shapes) lines.push(`- ${describeInk(s)}`);
      lines.push(c.ink ? `  (SVG: .wiber/${c.ink})` : "", "");
    }
    if (c.snapshot) lines.push(`Snapshot: .wiber/${c.snapshot}`, "");
    for (const t of c.thread) lines.push(`> **${t.author}** (${t.at}): ${t.text}`, "");
  }
  return lines.join("\n");
}
