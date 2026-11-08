import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Comment, CommentPatch, NewComment, Review } from "../../shared/review";

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
    if (c.snapshot) lines.push(`Snapshot: .wiber/${c.snapshot}`, "");
    for (const t of c.thread) lines.push(`> **${t.author}** (${t.at}): ${t.text}`, "");
  }
  return lines.join("\n");
}
