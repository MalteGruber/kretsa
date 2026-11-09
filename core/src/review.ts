import { readFileSync, watch, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDraft, type Comment, type CommentPatch, type InkShape, type NewComment, type Review, type Status } from "../../shared/review";

export class ReviewStore {
  readonly dataDir: string;
  readonly file: string;
  /** Content we last wrote ourselves, so the watcher can ignore our own writes. */
  lastWritten = "";

  constructor(projectDir: string) {
    this.dataDir = join(projectDir, ".kretsa");
    this.file = join(this.dataDir, "review.json");
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
    await atomicWrite(join(this.dataDir, "REVIEW.md"), toMarkdown(r));
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
      await mkdir(join(this.dataDir, "snap"), { recursive: true });
      await writeFile(join(this.dataDir, rel), buf);
      c.snapshot = rel;
    }
    if (c.ink_shapes?.length) {
      const rel = `ink/${c.id}.svg`;
      await atomicWrite(join(this.dataDir, rel), inkSvg(c.ink_shapes));
      c.ink = rel;
    }
    r.comments.push(c);
    await this.save(r);
    return c;
  }

  /**
   * Change status and/or append a reply. A human reply or reopen goes straight to the agent: the comment
   * becomes open and is (re)sent. The agent ("ai") may not resolve; that is the human's call.
   */
  async patch(id: string, p: CommentPatch): Promise<Comment | null> {
    const r = await this.load();
    const c = r.comments.find((c) => c.id === id);
    if (!c) return null;
    const now = new Date().toISOString();
    const human = p.reply?.author !== "ai" && (p.reply ? true : p.status === "open");
    if (p.reply?.author === "ai" && p.status === "resolved") throw new Error("the agent may not resolve comments; use addressed");
    if (p.text !== undefined) {
      if (!isDraft(c)) throw new Error("only drafts can be edited (this one was sent to the agent; reply instead)");
      if (!p.text.trim()) throw new Error("text required");
      c.text = p.text.trim();
    }
    if (p.status) c.status = p.status;
    if (p.reply?.text) c.thread.push({ ...p.reply, at: now });
    if (human && (p.reply?.text || p.status === "open") && c.status !== "resolved" && c.status !== "wontfix") {
      if (c.status === "addressed" || p.status === "open") c.status = "open";
      if (c.sent || p.status === "open") c.sent = now; // drafts stay drafts until "Send to AI"
    }
    await this.save(r);
    return c;
  }

  /** Delete a draft (comments the agent has seen stay, so the thread history is kept). */
  async remove(id: string): Promise<boolean> {
    const r = await this.load();
    const c = r.comments.find((c) => c.id === id);
    if (!c) return false;
    if (!isDraft(c)) throw new Error("only drafts can be deleted; resolve it instead");
    r.comments = r.comments.filter((x) => x !== c);
    await this.save(r);
    return true;
  }

  /** "Send to AI": hand drafts to the agent (all of them, or `ids`). Returns the comments sent. */
  async send(ids?: string[]): Promise<Comment[]> {
    const r = await this.load();
    const now = new Date().toISOString();
    const out = r.comments.filter((c) => isDraft(c) && (!ids || ids.includes(c.id)));
    for (const c of out) c.sent = now;
    if (out.length) await this.save(r);
    return out;
  }

  /** A comment by id, unique id prefix/suffix, or its number as shown in the viewer ("3", "#3"). */
  async find(ref: string): Promise<Comment | string> {
    const r = await this.load();
    const n = ref.match(/^#?(\d+)$/);
    if (n) return r.comments[Number(n[1]) - 1] ?? `no comment #${n[1]} (there are ${r.comments.length})`;
    const exact = r.comments.find((c) => c.id === ref);
    if (exact) return exact;
    const hits = r.comments.filter((c) => c.id.startsWith(ref) || c.id.endsWith(ref));
    return hits.length === 1 ? hits[0]! : hits.length ? `"${ref}" matches ${hits.map((c) => c.id).join(", ")}` : `no comment "${ref}"`;
  }

  // ---- agent side of "Send to AI" ------------------------------------------------------------

  private get agentFile() { return join(this.dataDir, "agent.json"); }

  async agentState(): Promise<{ seen?: string; waiting?: { pid: number; since: string } }> {
    return readFile(this.agentFile, "utf8").then((s) => JSON.parse(s), () => ({}));
  }

  private async setAgentState(patch: { seen?: string; waiting?: { pid: number; since: string } | null }) {
    const cur = await this.agentState();
    const next: Record<string, unknown> = { ...cur, ...patch };
    if (patch.waiting === null) delete next.waiting;
    await atomicWrite(this.agentFile, JSON.stringify(next, null, 1) + "\n");
  }

  /** Is a `kretsa wait` blocked on this project (its process still alive)? */
  async agentWaiting(): Promise<{ waiting: boolean; since?: string }> {
    const w = (await this.agentState()).waiting;
    if (!w) return { waiting: false };
    try { process.kill(w.pid, 0); return { waiting: true, since: w.since }; }
    catch { return { waiting: false }; }
  }

  /** Open comments the human sent after `seen` (what `kretsa wait` returns). */
  async sentSince(seen?: string): Promise<Comment[]> {
    const r = await this.load();
    return r.comments.filter((c) => c.status === "open" && c.sent && (!seen || c.sent > seen));
  }

  /**
   * Block until the human sends comments (or `timeoutMs` passes), then remember them as seen.
   * `all`: also return open sent comments that an earlier wait already returned.
   */
  async waitForSent(opts: { timeoutMs?: number; all?: boolean } = {}): Promise<Comment[]> {
    const seen = opts.all ? undefined : (await this.agentState()).seen;
    await mkdir(this.dataDir, { recursive: true });
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    let wake: (() => void) | null = null;
    const w = watch(this.dataDir, (_e, name) => { if (String(name).startsWith("review.json")) wake?.(); });
    await this.setAgentState({ waiting: { pid: process.pid, since: new Date().toISOString() } });
    // Killed while waiting (Ctrl+C, the agent stopping the background job): clear the flag synchronously.
    const clear = () => {
      try {
        const { waiting: _, ...rest } = JSON.parse(readFileSync(this.agentFile, "utf8"));
        writeFileSync(this.agentFile, JSON.stringify(rest, null, 1) + "\n");
      } catch {}
    };
    const onSignal = () => { clear(); process.exit(130); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      for (;;) {
        const got = await this.sentSince(seen);
        if (got.length) {
          const latest = got.map((c) => c.sent!).sort().at(-1)!;
          const prev = (await this.agentState()).seen;
          if (!prev || latest > prev) await this.setAgentState({ seen: latest });
          return got;
        }
        const left = deadline - Date.now();
        if (left <= 0) return [];
        // fs.watch can miss renames on some filesystems: poll as a fallback.
        await new Promise<void>((res) => { wake = res; setTimeout(res, Math.min(left, 2000)); });
        wake = null;
      }
    } finally {
      w.close();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await this.setAgentState({ waiting: null }).catch(() => {});
    }
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
    case "pad": return a.ref.includes(":") ? `pad ${a.pad} (${a.ref})` : `${a.ref}.${a.pad}`;
    case "pin": return `pin ${a.pin}${a.name ? ` (${a.name})` : ""}`;
    case "area": return `area [${a.bbox_mm.map((n) => n.toFixed(2)).join(", ")}] mm`;
    case "point": return `@(${a.at_mm.map((n) => n.toFixed(2)).join(", ")}) mm`;
  }
}

export function toMarkdown(r: Review): string {
  const open = r.comments.filter((c) => c.status === "open" || c.status === "addressed");
  const lines = [
    "# Design review",
    "",
    "_Generated from review.json by kretsa. Do not edit; answer with `kretsa reply <#> \"…\" --addressed`._",
    "",
    `Open: ${r.comments.filter((c) => c.status === "open").length} · ` +
      `Addressed (awaiting human): ${r.comments.filter((c) => c.status === "addressed").length}`,
    "",
  ];
  for (const c of open) lines.push(...commentMarkdown(c, r.comments.indexOf(c) + 1));
  return lines.join("\n");
}

/** One comment as markdown (REVIEW.md, `kretsa review`, `kretsa wait`). */
export function commentMarkdown(c: Comment, num?: number): string[] {
  const where = c.view === "lib"
    ? `library · ${c.part ? `${c.part}${c.aspect ? ` (${c.aspect})` : ""}` : "**new part request**"}`
    : `${c.view}${c.file ? ` · ${c.file}` : ""}${c.sheet && c.sheet !== "/" ? ` · sheet ${c.sheet}` : ""}`;
  const lines = [`## ${num ? `#${num} · ` : ""}${c.id} · ${where} · **${c.status}**${isDraft(c) ? " · _draft, not sent yet_" : ""}`, ""];
  if (c.anchors.length) lines.push(`Anchors: ${c.anchors.map(fmtAnchor).join(", ")}`, "");
  lines.push(c.text, "");
  if (c.ink_shapes?.length) {
    lines.push(c.view === "lib" ? "Drawing:" : "Drawing (document mm):");
    for (const s of c.ink_shapes) lines.push(`- ${describeInk(s)}`);
    lines.push(c.ink ? `  (SVG: .kretsa/${c.ink})` : "", "");
  }
  if (c.snapshot) lines.push(`Snapshot: .kretsa/${c.snapshot}`, "");
  if (c.view === "lib") lines.push(c.part ? `Inspect: \`kretsa lib show ${c.part}\`` : "Create the part in the project libraries, then check it with `kretsa lib show <part>`.", "");
  for (const t of c.thread) lines.push(`> **${t.author}** (${t.at}): ${t.text}`, "");
  return lines;
}

export const AGENT_STATUSES: Status[] = ["open", "addressed", "wontfix"];
