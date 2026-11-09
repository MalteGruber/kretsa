#!/usr/bin/env bun
// kretsa: KiCad review loop between a human (web viewer) and an AI agent (this CLI).
// Output is markdown by default (for LLMs), --json for machines. Works on the project files directly;
// the web server does not need to be running (except for `serve`, which is the server).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkMarkdown, REPORT_VERSION, detectKicadCli, diffChecks, findProjectDir, mainPcb, migrateLegacyDir, ReviewStore, rootSchematic,
  runChecks, scanProject, toMarkdown,
} from "@kretsa/core";
import type { CheckReport } from "../../shared/check";

const ROOT = resolve(import.meta.dir, "../..");

const HELP = `kretsa: KiCad design review between you (web viewer) and an AI agent (this CLI)

Usage: kretsa <command> [project-dir] [options]

The project dir defaults to $KRETSA_PROJECT, else the nearest dir at/above cwd with a .kicad_pro.

Commands:
  serve     Start the web viewer (http://<host>:7777, LAN-reachable)
              --port N  --host ADDR  --dev (Vite + HMR on :5177 for frontend work)
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

  let dir = await findProjectDir(positionals[0]);
  if (!dir && cmd === "serve" && o.dev) dir = join(ROOT, "fixtures/stickhub"); // frontend dev without a project
  if (!dir) die(`No KiCad project found${positionals[0] ? ` at ${positionals[0]}` : " (pass a dir, set KRETSA_PROJECT, or cd into one)"}.`);
  await migrateLegacyDir(dir);

  switch (cmd) {
    case "serve": return serve(dir, o);
    case "check": return check(dir, o);
    case "status": return status(dir);
    case "review": return review(dir, !!o.json);
    default: die(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------

async function serve(dir: string, o: { port?: string; host?: string; dev?: boolean }) {
  const port = Number(o.port ?? process.env.KRETSA_PORT ?? 7777);
  const host = o.host ?? process.env.KRETSA_HOST ?? "0.0.0.0";
  const web = join(ROOT, "web");
  if (!o.dev && !existsSync(join(web, "dist/index.html"))) {
    console.log("Building the frontend (first run)…");
    const b = Bun.spawnSync([process.execPath, "run", "build"], { cwd: web, stdout: "inherit", stderr: "inherit" });
    if (b.exitCode !== 0) die("Frontend build failed.");
  }
  const { startServer } = await import("@kretsa/server");
  await startServer({ projectDir: dir, port, host });
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
