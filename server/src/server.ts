// HTTP + WebSocket backend for the web UI. A thin layer over @kretsa/core; started by `kretsa serve`.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { watch as watchFs, type FSWatcher } from "node:fs";
import {
  detectKicadCli, exportGlb, exportNetlist, migrateLegacyDir, projectDirOf, readWorkspaceState, ReviewStore, rootSchematic,
  runChecks, safeJoin, readDesign, keepRev, diffSince, scanProject, workspaceInfo, writeWorkspaceState, libraryInfo, libraryTables, partDetail, partAsset, svgToPng,
  type LibContext,
} from "@kretsa/core";
import type { CommentPatch, NewComment, ProjectInfo, SendRequest, ServerMessage } from "../../shared/review";

const ROOT = resolve(import.meta.dir, "../..");

export interface ServeOptions {
  /** A workspace (folder with one or more KiCad projects) or a single project folder. */
  root: string;
  port?: number; // default 7777
  /** 0.0.0.0 (default) makes it reachable on the LAN. There is no auth: trusted networks only. */
  host?: string;
  /** Built frontend to serve (default web/dist). */
  webDist?: string;
}

export async function startServer(opts: ServeOptions) {
  const root = resolve(opts.root);
  const port = opts.port ?? 7777;
  const host = opts.host ?? "0.0.0.0";
  const webDist = opts.webDist ?? join(ROOT, "web/dist");
  const kicadCli = await detectKicadCli();

  // The open project. Everything below reads these, and switchProject() replaces them.
  let currentId: string | null = null;
  let projectDir = root;
  let review = new ReviewStore(root);
  let project: ProjectInfo = { name: "", dir: root, rev: "", files: [], kicadCli };
  let projectWatcher: FSWatcher | null = null;

  async function switchProject(id: string | null, opts: { persist?: boolean; announce?: boolean } = {}) {
    const info = await workspaceInfo(root);
    const target = info.projects.find((p) => p.id === id) ?? info.projects.find((p) => p.id === info.current);
    if (!target) {
      currentId = null;
      return;
    }
    projectDir = projectDirOf(root, target.id);
    if (await migrateLegacyDir(projectDir)) console.log(`migrated ${projectDir}/.wiber -> .kretsa`);
    currentId = target.id;
    review = new ReviewStore(projectDir);
    project = await scanProject(projectDir, kicadCli);
    watchProject();
    watchExternalLibs();
    if (opts.persist) await writeWorkspaceState(root, { current: currentId });
    console.log(`[project] ${currentId} (${project.files.length} files)`);
    if (opts.announce) broadcast({ type: "project", id: currentId });
  }

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const libCtx = (): LibContext => ({ projectDir, tableDirs: [root] });

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      if (path === "/ws") {
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (path === "/api/workspace" && req.method === "GET") return json({ ...(await workspaceInfo(root)), current: currentId });

      if (path === "/api/workspace/current" && req.method === "POST") {
        const { id } = (await req.json()) as { id: string };
        const info = await workspaceInfo(root);
        if (!info.projects.some((p) => p.id === id)) return json({ error: `no project ${id}` }, 404);
        await switchProject(id, { persist: true, announce: true });
        return json({ current: currentId });
      }

      if (!currentId && path.startsWith("/api/") && path !== "/api/workspace") {
        return json({ error: `No KiCad project in ${root}` }, 404);
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

      // Libraries: lib tables of the project + workspace root (see core/src/library.ts).
      if (path === "/api/lib") return json(await libraryInfo(libCtx()));
      if (path === "/api/lib/part" || path === "/api/lib/asset") {
        const part = await partDetail(libCtx(), url.searchParams.get("id") ?? "");
        if (typeof part === "string") return json({ error: part }, 404);
        if (path === "/api/lib/part") return json(part);
        const file = url.searchParams.get("f") ?? "";
        if (!/^(symbol_unit\d+\.svg|footprint\.svg|part\.glb)$/.test(file)) return json({ error: "bad asset" }, 400);
        try {
          const out = await partAsset(part, file, projectDir);
          if (!(await Bun.file(out).exists())) return json({ error: "not rendered" }, 404);
          return new Response(Bun.file(out), { headers: { "cache-control": "no-store", "content-type": file.endsWith(".svg") ? "image/svg+xml" : "model/gltf-binary" } });
        } catch (e) {
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

      if (path === "/api/diff") {
        const since = url.searchParams.get("since") ?? "";
        const d = await diffSince(project, since);
        return d ? json(d) : json({ error: `revision ${since} was not kept (kretsa keeps the design at each comment and full check)` }, 404);
      }

      if (path === "/api/components") {
        const d = await readDesign(project);
        const byRef = new Map<string, { ref: string; value: string; footprint: string; lib?: string; layer?: string; props: [string, string][] }>();
        for (const s of d.symbols) {
          if (s.power) continue;
          for (const ref of s.refs) if (!ref.startsWith("#")) byRef.set(ref, { ref, value: s.value, footprint: s.footprint, lib: s.lib, props: s.props });
        }
        for (const f of d.board?.footprints ?? []) {
          if (!f.ref) continue;
          const c = byRef.get(f.ref);
          if (c) c.layer = f.layer;
          else byRef.set(f.ref, { ref: f.ref, value: f.value, footprint: f.lib, layer: f.layer, props: [] });
        }
        return json([...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true })));
      }

      if (path === "/api/check") {
        const report = await runChecks(project, kicadCli);
        return json(report);
      }

      if (path === "/api/review" && req.method === "GET") return json(await review.load());

      if (path === "/api/review/comments" && req.method === "POST") {
        const body = (await req.json()) as NewComment;
        if (!body?.text?.trim()) return json({ error: "text required" }, 400);
        // Library comments on the symbol or footprint: attach the render the human was looking at.
        if (body.view === "lib" && body.part && !body.snapshotPng && (body.aspect === "symbol" || body.aspect === "footprint")) {
          try {
            const part = await partDetail(libCtx(), body.part);
            if (typeof part !== "string") {
              const svgFile = await partAsset(part, body.aspect === "symbol" ? "symbol_unit1.svg" : "footprint.svg", projectDir);
              body.snapshotPng = "data:image/png;base64," + svgToPng(await readFile(svgFile, "utf8"), 900).toString("base64");
            }
          } catch (e) { console.warn(`[review] no snapshot for ${body.part}: ${(e as Error).message}`); }
        }
        const c = await review.add(body, project.rev);
        keepRev(project).catch((e) => console.warn(`[revs] ${(e as Error).message}`)); // for "what changed since"
        broadcast({ type: "review" });
        return json(c, 201);
      }

      if (path === "/api/review/send" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as SendRequest;
        const sent = await review.send(body.ids);
        broadcast({ type: "review" });
        return json({ sent: sent.map((c) => c.id) });
      }

      const m = path.match(/^\/api\/review\/comments\/([\w-]+)$/);
      if (m && req.method === "PATCH") {
        let c;
        try { c = await review.patch(m[1]!, (await req.json()) as CommentPatch); }
        catch (e) { return json({ error: (e as Error).message }, 400); }
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

  // Watch the open project: design file changes -> rescan + reload; external review.json edits (the agent) -> refresh.
  let timer: Timer | undefined;
  let reviewChanged = false;
  let libTimer: Timer | undefined;
  function watchProject() {
    projectWatcher?.close();
    projectWatcher = watchFs(projectDir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const n = name.toString();
      if (n === ".kretsa/review.json") reviewChanged = true;
      else if (!n.startsWith(".kretsa/") && /(\.kicad_(sym|mod)|\.(step|stp|wrl)|-lib-table)$/i.test(n)) {
        clearTimeout(libTimer);
        libTimer = setTimeout(() => { broadcast({ type: "lib" }); if (n.endsWith("-lib-table")) watchExternalLibs(); }, 300);
        return;
      }
      else if (!/\.kicad_(pro|sch|pcb)$/.test(n) || n.startsWith(".kretsa/")) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 300);
    });
  }

  // Libraries can live outside the project (a shared hardware folder, registered in a lib table by an
  // absolute or ${ENV} path). Watch those too; re-evaluated whenever a lib table changes.
  let libWatchers: FSWatcher[] = [];
  async function watchExternalLibs() {
    for (const w of libWatchers) w.close();
    libWatchers = [];
    const dirs = new Set<string>();
    for (const lib of await libraryTables(libCtx()).catch(() => [])) {
      if (!lib.exists) continue;
      const dir = lib.kind === "fp" ? lib.path : dirname(lib.path);
      if (dir === projectDir || dir.startsWith(projectDir + "/")) continue;
      dirs.add(dir);
    }
    const targets: [string, boolean][] = [...dirs].map((d) => [d, true]);
    if (root !== projectDir) targets.push([root, false]); // the workspace root's own lib tables
    for (const [dir, recursive] of targets) {
      try {
        libWatchers.push(watchFs(dir, { recursive }, (_ev, name) => {
          const n = String(name ?? "");
          if (!/(\.kicad_(sym|mod)|\.(step|stp|wrl)|-lib-table)$/i.test(n)) return;
          clearTimeout(libTimer);
          libTimer = setTimeout(() => { broadcast({ type: "lib" }); if (n.endsWith("-lib-table")) watchExternalLibs(); }, 300);
        }));
      } catch (e) { console.warn(`[lib] can't watch ${dir}: ${(e as Error).message}`); }
    }
    if (dirs.size) console.log(`[lib] watching ${dirs.size} library folder(s) outside the project`);
  }

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

  // The agent switches projects with `kretsa use`, which writes <root>/.kretsa/workspace.json: follow it.
  const wsDir = join(root, ".kretsa");
  await mkdir(wsDir, { recursive: true });
  const workspaceWatcher = watchFs(wsDir, async (_ev, name) => {
    if (name?.toString() !== "workspace.json") return;
    const { current } = await readWorkspaceState(root);
    if (current && current !== currentId) await switchProject(current, { announce: true });
  });

  await switchProject((await readWorkspaceState(root)).current);

  console.log(`kretsa server  http://localhost:${port}`);
  console.log(`  workspace: ${root}`);
  console.log(`  project: ${currentId ?? "(none found)"}`);
  console.log(`  kicad-cli: ${kicadCli ?? "NOT FOUND (3D and checks disabled)"}`);

  return {
    server,
    stop() { projectWatcher?.close(); for (const w of libWatchers) w.close(); workspaceWatcher.close(); server.stop(true); },
  };
}
