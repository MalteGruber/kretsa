// HTTP + WebSocket backend for the web UI. A thin layer over @kretsa/core; started by `kretsa serve`.

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  detectKicadCli, exportGlb, exportNetlist, migrateLegacyDir, ReviewStore, rootSchematic, runChecks, safeJoin, scanProject,
} from "@kretsa/core";
import type { CommentPatch, NewComment, ProjectInfo, ServerMessage } from "../../shared/review";

const ROOT = resolve(import.meta.dir, "../..");

export interface ServeOptions {
  projectDir: string;
  port?: number; // default 7777
  /** 0.0.0.0 (default) makes it reachable on the LAN. There is no auth: trusted networks only. */
  host?: string;
  /** Built frontend to serve (default web/dist). */
  webDist?: string;
}

export async function startServer(opts: ServeOptions) {
  const projectDir = resolve(opts.projectDir);
  const port = opts.port ?? 7777;
  const host = opts.host ?? "0.0.0.0";
  const webDist = opts.webDist ?? join(ROOT, "web/dist");

  if (await migrateLegacyDir(projectDir)) console.log(`migrated ${projectDir}/.wiber -> .kretsa`);
  const kicadCli = await detectKicadCli();
  const review = new ReviewStore(projectDir);
  let project: ProjectInfo = await scanProject(projectDir, kicadCli);

  const json = (data: unknown, status = 200) => Response.json(data, { status });

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      if (path === "/ws") {
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (path === "/api/project") return json(project);

      // Raw KiCad files, served as-is to KiCanvas. Never cached: the files are the source of truth.
      if (path.startsWith("/project/")) {
        const p = safeJoin(projectDir, path.slice("/project/".length));
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
          const out = await exportGlb(projectDir, join(projectDir, pcb.path), pcb.hash);
          return new Response(Bun.file(out), { headers: { "content-type": "model/gltf-binary" } });
        } catch (e) {
          console.error(e);
          return json({ error: String((e as Error).message) }, 500);
        }
      }

      if (path === "/api/netlist") {
        if (!kicadCli) return json({ error: "kicad-cli not installed" }, 503);
        const sch = rootSchematic(project);
        if (!sch) return json({ error: "no .kicad_sch in project" }, 404);
        try {
          return json(await exportNetlist(projectDir, join(projectDir, sch), project.rev));
        } catch (e) {
          console.error(e);
          return json({ error: String((e as Error).message) }, 500);
        }
      }

      if (path === "/api/check") {
        const report = await runChecks(project, kicadCli);
        return json(report);
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

      if (path.startsWith("/kretsa/")) {
        const p = safeJoin(review.dataDir, path.slice("/kretsa/".length));
        return p ? new Response(Bun.file(p)) : new Response("forbidden", { status: 403 });
      }

      // Production: serve the built frontend.
      const p = safeJoin(webDist, path === "/" ? "index.html" : path.slice(1));
      if (p && (await Bun.file(p).exists())) return new Response(Bun.file(p));
      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
      const index = Bun.file(join(webDist, "index.html"));
      return (await index.exists())
        ? new Response(index)
        : new Response("Frontend not built. Run `bun run build` (or `kretsa serve --dev`)", { status: 404 });
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
  const watcher = watch(projectDir, { recursive: true }, (_ev, name) => {
    if (!name) return;
    const n = name.toString();
    if (n === ".kretsa/review.json") reviewChanged = true;
    else if (!/\.kicad_(pro|sch|pcb)$/.test(n) || n.startsWith(".kretsa/")) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  });

  async function onChange() {
    if (reviewChanged) {
      reviewChanged = false;
      const current = await readFile(review.file, "utf8").catch(() => "");
      if (current !== review.lastWritten) broadcast({ type: "review" });
    }
    const next = await scanProject(projectDir, kicadCli);
    if (next.rev === project.rev) return;
    const old = new Map(project.files.map((f) => [f.path, f.hash]));
    const changed = next.files.filter((f) => old.get(f.path) !== f.hash).map((f) => f.path);
    project = next;
    console.log(`[reload] rev ${next.rev} changed: ${changed.join(", ") || "(removed files)"}`);
    broadcast({ type: "reload", rev: next.rev, changed });
  }

  console.log(`kretsa server  http://localhost:${port}`);
  console.log(`  project: ${projectDir} (${project.files.length} files)`);
  console.log(`  kicad-cli: ${kicadCli ?? "NOT FOUND (3D and checks disabled)"}`);

  return {
    server,
    stop() { watcher.close(); server.stop(true); },
  };
}
