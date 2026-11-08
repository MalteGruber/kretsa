import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommentPatch, NewComment, ProjectInfo, ServerMessage } from "../../shared/review";
import { detectKicadCli, exportGlb } from "./kicad";
import { safeJoin, scanProject } from "./project";
import { ReviewStore } from "./review";

const ROOT = resolve(import.meta.dir, "../..");
const PROJECT_DIR = resolve(process.argv[2] ?? process.env.WIBER_PROJECT ?? join(ROOT, "fixtures/demo"));
const PORT = Number(process.env.WIBER_PORT ?? 7777);
const WEB_DIST = join(ROOT, "web/dist");

if (!(await stat(PROJECT_DIR).then((s) => s.isDirectory(), () => false))) {
  console.error(`Project dir not found: ${PROJECT_DIR}`);
  process.exit(1);
}

const kicadCli = await detectKicadCli();
const review = new ReviewStore(PROJECT_DIR);
let project: ProjectInfo = await scanProject(PROJECT_DIR, kicadCli);

const json = (data: unknown, status = 200) => Response.json(data, { status });

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/ws") {
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (path === "/api/project") return json(project);

    // Raw KiCad files, served as-is to KiCanvas. Never cached: the files are the source of truth.
    if (path.startsWith("/project/")) {
      const p = safeJoin(PROJECT_DIR, path.slice("/project/".length));
      if (!p) return new Response("forbidden", { status: 403 });
      const f = Bun.file(p);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "cache-control": "no-store" } });
    }

    if (path === "/api/3d.glb") {
      if (!kicadCli) return json({ error: "kicad-cli not installed; 3D view unavailable" }, 503);
      const pcb = project.files.find((f) => f.kind === "pcb" && (!url.searchParams.get("file") || f.path === url.searchParams.get("file")));
      if (!pcb) return json({ error: "no .kicad_pcb in project" }, 404);
      try {
        const out = await exportGlb(PROJECT_DIR, join(PROJECT_DIR, pcb.path), pcb.hash);
        return new Response(Bun.file(out), { headers: { "content-type": "model/gltf-binary" } });
      } catch (e) {
        console.error(e);
        return json({ error: String((e as Error).message) }, 500);
      }
    }

    if (path === "/api/review" && req.method === "GET") return json(await review.load());

    if (path === "/api/review/comments" && req.method === "POST") {
      const body = (await req.json()) as NewComment;
      if (!body?.text?.trim()) return json({ error: "text required" }, 400);
      const c = await review.add(body, project.rev);
      broadcast({ type: "review" });
      return json(c, 201);
    }

    const m = path.match(/^\/api\/review\/comments\/([\w-]+)$/);
    if (m && req.method === "PATCH") {
      const c = await review.patch(m[1]!, (await req.json()) as CommentPatch);
      if (!c) return json({ error: "not found" }, 404);
      broadcast({ type: "review" });
      return json(c);
    }

    if (path.startsWith("/wiber/")) {
      const p = safeJoin(review.wiberDir, path.slice("/wiber/".length));
      return p ? new Response(Bun.file(p)) : new Response("forbidden", { status: 403 });
    }

    // Production: serve the built frontend.
    const p = safeJoin(WEB_DIST, path === "/" ? "index.html" : path.slice(1));
    if (p && (await Bun.file(p).exists())) return new Response(Bun.file(p));
    if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
    const index = Bun.file(join(WEB_DIST, "index.html"));
    return (await index.exists())
      ? new Response(index)
      : new Response("Frontend not built. Run `bun run dev` and open http://localhost:5173", { status: 404 });
  },
  websocket: {
    open(ws) { ws.subscribe("all"); },
    message() {},
  },
});

function broadcast(msg: ServerMessage) {
  server.publish("all", JSON.stringify(msg));
}

// Watch the project: design file changes -> rescan + reload; external review.json edits (the agent) -> refresh.
let timer: Timer | undefined;
let reviewChanged = false;
watch(PROJECT_DIR, { recursive: true }, (_ev, name) => {
  if (!name) return;
  const n = name.toString();
  if (n === ".wiber/review.json") reviewChanged = true;
  else if (!/\.kicad_(pro|sch|pcb)$/.test(n) || n.startsWith(".wiber/")) return;
  clearTimeout(timer);
  timer = setTimeout(onChange, 300);
});

async function onChange() {
  if (reviewChanged) {
    reviewChanged = false;
    const current = await readFile(review.file, "utf8").catch(() => "");
    if (current !== review.lastWritten) broadcast({ type: "review" });
  }
  const next = await scanProject(PROJECT_DIR, kicadCli);
  if (next.rev === project.rev) return;
  const old = new Map(project.files.map((f) => [f.path, f.hash]));
  const changed = next.files.filter((f) => old.get(f.path) !== f.hash).map((f) => f.path);
  project = next;
  console.log(`[reload] rev ${next.rev} changed: ${changed.join(", ") || "(removed files)"}`);
  broadcast({ type: "reload", rev: next.rev, changed });
}

console.log(`kicad-wiber server  http://localhost:${PORT}`);
console.log(`  project: ${PROJECT_DIR} (${project.files.length} files)`);
console.log(`  kicad-cli: ${kicadCli ?? "NOT FOUND (3D disabled)"}`);
