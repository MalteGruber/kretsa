#!/usr/bin/env bun
// kretsa: KiCad review loop between a human (web viewer) and an AI agent (this CLI).
// Output is markdown by default (for LLMs), --json for machines. Works on the project files directly;
// the web server does not need to be running (except for `serve`, which is the server).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkMarkdown, REPORT_VERSION, detectKicadCli, diffChecks, findProjectDir, isProjectDir, mainPcb, matchProject, migrateLegacyDir,
  projectDirOf, ReviewStore, rootSchematic, runChecks, scanProject, toMarkdown, workspaceInfo, workspaceRoot, writeWorkspaceState,
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
  status    Project files, revision, comments, last check
  review    Open review comments from the human, as markdown (--json: raw review.json)
  help      This text
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
    },
  });

  if (cmd === "help" || cmd === "--help" || cmd === "-h") return void process.stdout.write(HELP);

  if (cmd === "serve") {
    let root = resolve(positionals[0] ?? process.env.KRETSA_WORKSPACE ?? process.env.KRETSA_PROJECT ?? process.cwd());
    if (o.dev && !positionals[0] && !(await workspaceInfo(root)).projects.length) root = join(ROOT, "fixtures"); // frontend dev
    return serve(root, o);
  }
  if (cmd === "projects") return projects(!!o.json);
  if (cmd === "use") return use(positionals[0]);

  const dir = await resolveProject(positionals[0]);
  await migrateLegacyDir(dir);
  switch (cmd) {
    case "check": return check(dir, o);
    case "status": return status(dir);
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
  if (full && !report.errors.length) await Bun.write(baselineFile, JSON.stringify(report, null, 1));

  if (o.json) process.stdout.write(JSON.stringify({ ...report, diff }, null, 1) + "\n");
  else process.stdout.write(checkMarkdown(report, { limit: o.limit ? Number(o.limit) : undefined, library: o.library, diff }));
  if (o.fail && report.violations.some((v) => v.severity === "error" && !v.library)) process.exit(1);
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

async function review(dir: string, json: boolean) {
  const r = await new ReviewStore(dir).load();
  process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : toMarkdown(r));
}

main().catch((e) => die(String(e?.stack ?? e)));
