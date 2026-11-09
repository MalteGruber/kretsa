// Workspace: project discovery and the shared "current project" (see shared/workspace.ts).

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Review } from "../../shared/review";
import type { ProjectEntry, WorkspaceInfo, WorkspaceState } from "../../shared/workspace";

const SKIP = new Set([".git", ".kretsa", ".wiber", "node_modules", ".venv", "dist", "build"]);
const MAX_DEPTH = 5;

/** Directories (absolute) under `root` that contain a .kicad_pro, including nested projects. */
export async function discoverProjects(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name.endsWith(".kicad_pro"))) out.push(dir);
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".") && !e.name.endsWith("-backups")) {
        await walk(join(dir, e.name), depth + 1);
      }
    }
  };
  await walk(resolve(root), 0);
  return out.sort();
}

export const projectId = (root: string, dir: string) => relative(resolve(root), dir).split(sep).join("/") || ".";
export const projectDirOf = (root: string, id: string) => resolve(root, id);

async function entry(root: string, dir: string): Promise<ProjectEntry> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const pro = files.find((f) => f.endsWith(".kicad_pro"));
  let modified = 0;
  for (const f of files) {
    if (/\.kicad_(pro|sch|pcb)$/.test(f)) modified = Math.max(modified, (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0);
  }
  const review = await readFile(join(dir, ".kretsa", "review.json"), "utf8").then((s) => JSON.parse(s) as Review, () => null);
  const n = (s: string) => review?.comments.filter((c) => c.status === s).length ?? 0;
  return {
    id: projectId(root, dir),
    name: pro ? basename(pro, ".kicad_pro") : basename(dir),
    hasSch: files.some((f) => f.endsWith(".kicad_sch")),
    hasPcb: files.some((f) => f.endsWith(".kicad_pcb")),
    modified: new Date(modified || Date.now()).toISOString(),
    open: n("open"),
    addressed: n("addressed"),
  };
}

const stateFile = (root: string) => join(resolve(root), ".kretsa", "workspace.json");

export async function readWorkspaceState(root: string): Promise<WorkspaceState> {
  return readFile(stateFile(root), "utf8").then((s) => JSON.parse(s) as WorkspaceState, () => ({ current: null }));
}

export async function writeWorkspaceState(root: string, state: WorkspaceState): Promise<void> {
  const f = stateFile(root);
  await mkdir(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
  await rename(tmp, f);
}

/**
 * Projects in the workspace plus the current one. If the stored current project is gone (or none was
 * chosen yet), the most recently modified project is current.
 */
export async function workspaceInfo(root: string): Promise<WorkspaceInfo> {
  const dirs = await discoverProjects(root);
  const projects = await Promise.all(dirs.map((d) => entry(root, d)));
  const state = await readWorkspaceState(root);
  const current = projects.some((p) => p.id === state.current)
    ? state.current
    : [...projects].sort((a, b) => b.modified.localeCompare(a.modified))[0]?.id ?? null;
  return { root: resolve(root), projects, current };
}

/**
 * Resolve a project reference given by a user/agent: a workspace id ("projects/foo"), a project name
 * ("foo"), or a unique substring of either.
 */
export function matchProject(info: WorkspaceInfo, ref: string): ProjectEntry | string {
  const exact = info.projects.filter((p) => p.id === ref || p.name === ref || p.id.split("/").at(-1) === ref);
  if (exact.length === 1) return exact[0]!;
  const loose = info.projects.filter((p) => p.id.toLowerCase().includes(ref.toLowerCase()) || p.name.toLowerCase().includes(ref.toLowerCase()));
  if (loose.length === 1) return loose[0]!;
  const list = (exact.length ? exact : loose).map((p) => p.id).join(", ");
  return list ? `"${ref}" is ambiguous: ${list}` : `No project matching "${ref}"`;
}

/**
 * The workspace root for a CLI call: explicit, else KRETSA_WORKSPACE, else the nearest dir at/above cwd
 * that has a .kretsa/workspace.json (i.e. one `kretsa serve` or `kretsa use` ran in), else cwd.
 */
export async function workspaceRoot(explicit?: string, cwd = process.cwd()): Promise<string> {
  const given = explicit ?? process.env.KRETSA_WORKSPACE;
  if (given) return resolve(given);
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (await stat(join(d, ".kretsa", "workspace.json")).then(() => true, () => false)) return d;
    if (dirname(d) === d) return resolve(cwd);
  }
}

/** True if `dir` directly contains a .kicad_pro. */
export async function isProjectDir(dir: string): Promise<boolean> {
  return (await readdir(dir).catch(() => [] as string[])).some((n) => n.endsWith(".kicad_pro"));
}
