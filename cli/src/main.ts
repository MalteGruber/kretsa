#!/usr/bin/env bun
// kretsa: KiCad review loop between a human (web viewer) and an AI agent (this CLI).
// Output is markdown by default (for LLMs), --json for machines. Works on the project files directly;
// the web server does not need to be running (except for `serve`, which is the server).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkMarkdown, REPORT_VERSION, detectKicadCli, diffChecks, findProjectDir, isProjectDir, mainPcb, matchProject, migrateLegacyDir,
  projectDirOf, ReviewStore, commentMarkdown, rootSchematic, runChecks, scanProject, toMarkdown, workspaceInfo, workspaceRoot, writeWorkspaceState,
  footprintDetail, footprintMarkdown, libraryInfo, libraryMarkdown, partDetail, partMarkdown, render3d, renderFootprint, renderPart,
  keepRev, diffSince, diffMarkdown, readRev,
  renderPcb, renderSch, renderBoard3d, renderMarkdown, type RenderResult,
  type LibContext,
} from "@kretsa/core";
import type { CheckReport } from "../../shared/check";

const ROOT = resolve(import.meta.dir, "../..");

const HELP = `kretsa: KiCad design review between you (web viewer) and an AI agent (this CLI)

Usage: kretsa <command> [project] [options]

A workspace is any folder with KiCad projects in it (or a single project folder). The project a
command acts on is, in order: the [project] argument (a path, or a name/id from \`kretsa projects\`),
$KRETSA_PROJECT, the project you are inside (cwd or a parent has a .kicad_pro), else the workspace's
current project, which is shared with the web viewer.

Commands:
  serve [dir]    Start the web viewer for a workspace or project dir (default: cwd)
                   http://<host>:7777, LAN-reachable. --port N  --host ADDR
                   --dev  Vite + HMR on :5177 (frontend work)
  projects       List the workspace's projects; * marks the current one
  use <project>  Make <project> current, for later commands and in the open viewer
  check     Run ERC (schematic) + DRC with schematic parity (PCB); prints what is new/fixed
            since your previous \`kretsa check\`
              --erc / --drc  only one of them   --limit N  rows per section (25)
              --library  include library-lookup warnings   --json  full report
              --fail  exit 1 if there are errors (for scripts)
  lib [query]          Parts in the project's libraries (sym-lib-table / fp-lib-table of the project
                       and workspace root; KiCad's stock libraries are never used), with health checks
                         --issues  only parts with problems
  lib show <part>      One part: fields, pin table, pad table, 3D model, issues, and renders to look at
                       (symbol, footprint, 3D top/iso/side PNGs)   --no-3d  --no-render
  lib fp <Lib:Name>    One footprint (also ones no symbol uses), same detail and renders
  render sch|pcb|3d [project]   Images of the design to look at (PNG, printed paths)
              --around U3[,C7]  crop to parts and mark them   --net VBUS|U3.4  show a net
              --sheet NAME (sch)   --side top|bottom (pcb, 3d)   --layers F.Cu,... (pcb)
              --size PX (1600)   --margin MM   --out DIR (.kretsa/render)
  diff [since]   What changed in parts, nets and routing since your last full \`kretsa check\` (default),
                 a comment (diff 3 / diff c_…: since the human wrote it), or a rev
  status    Project files, revision, comments, last check
  review    Open review comments from the human, as markdown (--json: raw review.json)
  wait      Block until the human presses "Send to AI", then print the comments sent and exit.
            Run it in the background; when it exits, handle the comments, reply, and start it again.
              --timeout SEC  give up after SEC (exit 3)   --all  include ones an earlier wait returned
  reply <comment> "text"   Answer a comment (id, or its number in the viewer: 3 / #3)
              --addressed  you handled it (the human then resolves or reopens)
              --wontfix  you won't do it (say why)   --open  keep it open (e.g. you asked a question)
              Without a flag the status stays as it is. Only the human resolves.
  help      This text

Options for every command: --project/-p <project> (instead of the [project] argument).
`;

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { values: o, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: "string" }, host: { type: "string" }, dev: { type: "boolean" },
      erc: { type: "boolean" }, drc: { type: "boolean" }, json: { type: "boolean" },
      limit: { type: "string" }, library: { type: "boolean" }, fail: { type: "boolean" },
      issues: { type: "boolean" }, "no-3d": { type: "boolean" }, "no-render": { type: "boolean" }, out: { type: "string" },
      around: { type: "string" }, net: { type: "string" }, sheet: { type: "string" }, side: { type: "string" },
      layers: { type: "string" }, size: { type: "string" }, margin: { type: "string" },
      project: { type: "string", short: "p" }, addressed: { type: "boolean" }, wontfix: { type: "boolean" }, open: { type: "boolean" },
      timeout: { type: "string" }, all: { type: "boolean" },
    },
  });

  if (cmd === "help" || cmd === "--help" || cmd === "-h") return void process.stdout.write(HELP);

  if (cmd === "serve") {
    let root = resolve(positionals[0] ?? process.env.KRETSA_WORKSPACE ?? process.env.KRETSA_PROJECT ?? process.cwd());
    if (o.dev && !positionals[0] && !(await workspaceInfo(root)).projects.length) root = join(ROOT, "fixtures"); // frontend dev
    return serve(root, o);
  }
  if (cmd === "projects") return projects(!!o.json);
  if (cmd === "lib" && o.project) process.env.KRETSA_PROJECT = (await resolveProject(o.project));
  if (cmd === "use") return use(positionals[0]);
  if (cmd === "lib") return lib(positionals, o);

  const projectArg = o.project ?? (cmd === "render" ? positionals[1] : cmd === "reply" || cmd === "diff" ? undefined : positionals[0]);
  const dir = await resolveProject(projectArg);
  await migrateLegacyDir(dir);
  switch (cmd) {
    case "check": return check(dir, o);
    case "status": return status(dir);
    case "render": return render(dir, positionals[0], o);
    case "wait": return wait(dir, o);
    case "diff": return diff(dir, positionals[0], o);
    case "reply": return reply(dir, positionals[0], positionals.slice(1).join(" "), o);
    case "review": return review(dir, !!o.json);
    default: die(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

/** Which project a command acts on (see HELP). */
async function resolveProject(ref = process.env.KRETSA_PROJECT): Promise<string> {
  if (ref) {
    if (await isProjectDir(resolve(ref))) return resolve(ref);
    const info = await workspaceInfo(await workspaceRoot());
    const m = matchProject(info, ref);
    if (typeof m === "string") die(m);
    return projectDirOf(info.root, m.id);
  }
  const inside = await findProjectDir();
  if (inside) return inside;
  const info = await workspaceInfo(await workspaceRoot());
  if (info.current) return projectDirOf(info.root, info.current);
  die(`No KiCad project found in ${info.root} (pass a project, cd into one, or set KRETSA_PROJECT).`);
}

/**
 * Library context: the resolved project (KIPRJMOD) plus the workspace root's lib tables. Outside any
 * project (e.g. a library-only workspace) the workspace root stands in for the project.
 */
async function libContext(): Promise<LibContext> {
  const ws = await workspaceRoot();
  let projectDir = ws;
  try {
    const inside = process.env.KRETSA_PROJECT ? resolve(process.env.KRETSA_PROJECT) : await findProjectDir();
    projectDir = inside ?? projectDirOf(ws, (await workspaceInfo(ws)).current ?? ".");
  } catch {}
  return { projectDir, tableDirs: [ws] };
}

async function lib(args: string[], o: { json?: boolean; issues?: boolean; "no-3d"?: boolean; "no-render"?: boolean; out?: string }) {
  const ctx = await libContext();
  const [sub, ref] = args;
  const outFor = (id: string) => resolve(o.out ?? join(ctx.projectDir, ".kretsa", "parts", id.replace(/[^\w.+-]+/g, "_")));
  if (sub === "show") {
    if (!ref) die("Usage: kretsa lib show <part>");
    const part = await partDetail(ctx, ref);
    if (typeof part === "string") die(part);
    const renders = o["no-render"] ? undefined : await renderPart(part, outFor(part.id), ctx.projectDir, { threeD: !o["no-3d"] });
    if (o.json) return void process.stdout.write(JSON.stringify({ ...part, renders }, null, 1) + "\n");
    return void process.stdout.write(partMarkdown(part, renders));
  }
  if (sub === "fp") {
    if (!ref) die("Usage: kretsa lib fp <Lib:Name>");
    const fp = await footprintDetail(ctx, ref);
    if (typeof fp === "string") die(fp);
    const lines = footprintMarkdown(fp);
    if (!o["no-render"]) {
      const dir = outFor(fp.id);
      const png = await renderFootprint(fp, dir, ctx.projectDir).catch((e) => `⚠ ${e.message}`);
      const threeD = o["no-3d"] ? [] : await render3d(fp, dir, ctx.projectDir).catch((e) => [`⚠ ${e.message}`]);
      lines.push("## Renders (look at these)", "", `- footprint: ${png}`, ...threeD.map((p) => `- 3D: ${p}`), "");
    }
    return void process.stdout.write(o.json ? JSON.stringify(fp, null, 1) + "\n" : lines.join("\n"));
  }
  const info = await libraryInfo(ctx);
  const query = sub === "list" ? ref : sub;
  if (o.json) return void process.stdout.write(JSON.stringify(info, null, 1) + "\n");
  process.stdout.write(libraryMarkdown(info, { query, issuesOnly: o.issues }));
}

async function projects(json: boolean) {
  const info = await workspaceInfo(await workspaceRoot());
  if (json) return void process.stdout.write(JSON.stringify(info, null, 1) + "\n");
  const lines = [`# Projects in ${info.root}`, ""];
  if (!info.projects.length) lines.push("None found (no .kicad_pro files).");
  else {
    lines.push("| | id | name | sch | pcb | open comments | modified |", "|---|---|---|---|---|---|---|");
    for (const p of info.projects) {
      lines.push(`| ${p.id === info.current ? "*" : ""} | ${p.id} | ${p.name} | ${p.hasSch ? "✓" : ""} | ${p.hasPcb ? "✓" : ""} | ${p.open || ""} | ${p.modified.slice(0, 16).replace("T", " ")} |`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function use(ref?: string) {
  if (!ref) die("Usage: kretsa use <project>  (see `kretsa projects`)");
  const info = await workspaceInfo(await workspaceRoot());
  const m = matchProject(info, ref);
  if (typeof m === "string") die(m);
  await writeWorkspaceState(info.root, { current: m.id });
  process.stdout.write(`Current project: ${m.id} (${m.name}). An open viewer switches to it.\n`);
}

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------

async function serve(root: string, o: { port?: string; host?: string; dev?: boolean }) {
  const port = Number(o.port ?? process.env.KRETSA_PORT ?? 7777);
  const host = o.host ?? process.env.KRETSA_HOST ?? "0.0.0.0";
  const web = join(ROOT, "web");
  if (!o.dev && !existsSync(join(web, "dist/index.html"))) {
    console.log("Building the frontend (first run)…");
    const b = Bun.spawnSync([process.execPath, "run", "build"], { cwd: web, stdout: "inherit", stderr: "inherit" });
    if (b.exitCode !== 0) die("Frontend build failed.");
  }
  const { startServer } = await import("@kretsa/server");
  await startServer({ root, port, host });
  if (o.dev) {
    const vite = [join(web, "node_modules/.bin/vite"), join(ROOT, "node_modules/.bin/vite")].find(existsSync);
    if (!vite) die("vite not found; run `bun install`.");
    const p = Bun.spawn([vite], { cwd: web, stdout: "inherit", stderr: "inherit", env: { ...process.env, KRETSA_PORT: String(port) } });
    const stop = () => { p.kill(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    console.log("  dev UI: http://localhost:5177 (Vite, proxies to the server)");
  }
}

async function check(dir: string, o: { erc?: boolean; drc?: boolean; json?: boolean; limit?: string; library?: boolean; fail?: boolean }) {
  const kicad = await detectKicadCli();
  const project = await scanProject(dir, kicad);
  const only = o.erc || o.drc ? { erc: !!o.erc, drc: !!o.drc } : {};
  const report = await runChecks(project, kicad, only);
  // The baseline is the agent's previous `kretsa check` (full runs only), so the diff shows the effect of its edits.
  const baselineFile = join(dir, ".kretsa", "check", "baseline.json");
  const full = !o.erc && !o.drc;
  const prev = full ? await readFile(baselineFile, "utf8").then((s) => JSON.parse(s) as CheckReport, () => null) : null;
  const diff = diffChecks(prev && prev.rev !== report.rev ? prev : null, report);
  if (full && !report.errors.length) {
    await Bun.write(baselineFile, JSON.stringify(report, null, 1));
    await keepRev(project); // so `kretsa diff` can compare against this check
  }

  if (o.json) process.stdout.write(JSON.stringify({ ...report, diff }, null, 1) + "\n");
  else process.stdout.write(checkMarkdown(report, { limit: o.limit ? Number(o.limit) : undefined, library: o.library, diff }));
  if (o.fail && report.violations.some((v) => v.severity === "error" && !v.library)) process.exit(1);
}

async function render(dir: string, kind: string | undefined, o: {
  around?: string; net?: string; sheet?: string; side?: string; layers?: string; size?: string; margin?: string; out?: string; json?: boolean;
}) {
  if (!kind || !["sch", "pcb", "3d"].includes(kind)) die("Usage: kretsa render sch|pcb|3d [project] [--around REF] [--net NET] ...");
  const project = await scanProject(dir, await detectKicadCli());
  if (!project.kicadCli) die("kicad-cli not found (set KICAD_CLI).");
  if (o.side && o.side !== "top" && o.side !== "bottom") die("--side is top or bottom");
  const opts = {
    around: o.around, net: o.net, sheet: o.sheet, layers: o.layers, side: o.side as "top" | "bottom" | undefined,
    size: o.size ? Number(o.size) : undefined, margin: o.margin ? Number(o.margin) : undefined,
    outDir: resolve(o.out ?? join(dir, ".kretsa", "render")),
  };
  let results: RenderResult[];
  try {
    results = kind === "sch" ? await renderSch(project, opts)
      : kind === "pcb" ? [await renderPcb(project, opts)]
      : [await renderBoard3d(project, opts)];
  } catch (e) { die(String((e as Error).message)); }
  const what = [kind, o.around && `around ${o.around}`, o.net && `net ${o.net}`, o.sheet && `sheet ${o.sheet}`, o.side].filter(Boolean).join(" · ");
  process.stdout.write(o.json ? JSON.stringify(results, null, 1) + "\n" : renderMarkdown(results, what));
}

async function status(dir: string) {
  const kicad = await detectKicadCli();
  const p = await scanProject(dir, kicad);
  const r = await new ReviewStore(dir).load();
  const n = (s: string) => r.comments.filter((c) => c.status === s).length;
  const cached = await readFile(join(dir, ".kretsa", "check", `${p.rev}.v${REPORT_VERSION}.json`), "utf8").then((s) => JSON.parse(s) as CheckReport, () => null);
  const real = cached?.violations.filter((v) => !v.library) ?? [];
  const lines = [
    `# ${p.name} · rev ${p.rev}`,
    "",
    `Dir: ${dir}`,
    `Schematic: ${rootSchematic(p) ?? "none"}${p.files.filter((f) => f.kind === "sch").length > 1 ? ` (+${p.files.filter((f) => f.kind === "sch").length - 1} sheets)` : ""}`,
    `PCB: ${mainPcb(p) ?? "none"}`,
    `kicad-cli: ${kicad ?? "not found"}`,
    "",
    `Review: ${n("open")} open, ${n("addressed")} addressed (awaiting human), ${n("resolved") + n("wontfix")} closed`,
    cached
      ? `Check (this rev): ${real.filter((v) => v.severity === "error").length} errors, ${real.filter((v) => v.severity === "warning").length} warnings`
      : "Check: not run for this rev (`kretsa check`)",
    "",
  ];
  process.stdout.write(lines.join("\n"));
}

async function diff(dir: string, since: string | undefined, o: { json?: boolean; project?: string }) {
  const project = await scanProject(dir, null);
  let rev = "", title = "Design changes";
  const baseline = await readFile(join(dir, ".kretsa", "check", "baseline.json"), "utf8").then((s) => JSON.parse(s) as CheckReport, () => null);
  if (!since || since === "check") {
    if (!baseline) die("No previous `kretsa check` to compare against. Pass a comment (#3) or a rev.");
    rev = baseline.rev; title = "Since your last full `kretsa check`";
  } else if (await readRev(dir, since)) rev = since;
  else {
    const c = await new ReviewStore(dir).find(since);
    if (typeof c === "string") die(`"${since}" is neither a kept revision nor a comment: ${c}`);
    rev = c.design_rev; title = `Since comment ${c.id}`;
  }
  const d = await diffSince(project, rev);
  if (!d) die(`Revision ${rev} was not kept (kretsa keeps the design when a comment is made and at each full check).`);
  process.stdout.write(o.json ? JSON.stringify(d, null, 1) + "\n" : diffMarkdown(d, title));
}

async function wait(dir: string, o: { timeout?: string; all?: boolean; json?: boolean }) {
  const store = new ReviewStore(dir);
  const timeoutMs = o.timeout ? Number(o.timeout) * 1000 : undefined;
  const got = await store.waitForSent({ timeoutMs, all: o.all });
  if (!got.length) { process.stderr.write(`No comments sent within ${o.timeout}s.\n`); process.exit(3); }
  if (o.json) return void process.stdout.write(JSON.stringify(got, null, 1) + "\n");
  const r = await store.load();
  const lines = [`# ${got.length} comment${got.length === 1 ? "" : "s"} sent to you · ${basename(dir)}`, ""];
  for (const c of got) lines.push(...commentMarkdown(c, r.comments.findIndex((x) => x.id === c.id) + 1));
  lines.push("---", "", "For each: make the change, check it (`kretsa check`, `kretsa render …`), then",
    "`kretsa reply <#> \"what you did\" --addressed` (or --wontfix with a reason, or a question without a flag).",
    "Then run `kretsa wait` again (in the background) for the next batch.", "");
  process.stdout.write(lines.join("\n"));
}

async function reply(dir: string, ref: string | undefined, text: string, o: { addressed?: boolean; wontfix?: boolean; open?: boolean }) {
  if (!ref || (!text.trim() && !o.addressed && !o.wontfix && !o.open)) die('Usage: kretsa reply <comment> "text" [--addressed | --wontfix | --open]');
  const flags = [o.addressed && "addressed", o.wontfix && "wontfix", o.open && "open"].filter(Boolean) as ("addressed" | "wontfix" | "open")[];
  if (flags.length > 1) die("Pick one of --addressed, --wontfix, --open.");
  const store = new ReviewStore(dir);
  const c = await store.find(ref);
  if (typeof c === "string") die(c);
  if (c.status === "resolved") die(`${c.id} is resolved by the human; leave it (or ask them to reopen it).`);
  const updated = await store.patch(c.id, { ...(flags[0] && { status: flags[0] }), ...(text.trim() && { reply: { author: "ai", text: text.trim() } }) });
  process.stdout.write(`${updated!.id}: ${updated!.status}${text.trim() ? ", reply added" : ""}. The viewer shows it live.\n`);
}

async function review(dir: string, json: boolean) {
  const r = await new ReviewStore(dir).load();
  process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : toMarkdown(r));
}

main().catch((e) => die(String(e?.stack ?? e)));
