import { readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ProjectFile, ProjectInfo } from "../../shared/review";

const KINDS: Record<string, ProjectFile["kind"]> = {
  ".kicad_pro": "pro",
  ".kicad_sch": "sch",
  ".kicad_pcb": "pcb",
};
const SKIP_DIRS = new Set([".kretsa", ".wiber", ".git", "node_modules"]);

function hash(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 16);
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.endsWith("-backups")) await walk(join(dir, e.name), out);
    } else if (Object.keys(KINDS).some((ext) => e.name.endsWith(ext))) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

export async function scanProject(dir: string, kicadCli: string | null): Promise<ProjectInfo> {
  const paths = (await walk(dir)).sort();
  const files: ProjectFile[] = [];
  for (const p of paths) {
    const ext = Object.keys(KINDS).find((e) => p.endsWith(e))!;
    files.push({
      path: relative(dir, p).split(sep).join("/"),
      kind: KINDS[ext]!,
      hash: hash(await readFile(p)),
    });
  }
  const pro = files.find((f) => f.kind === "pro");
  return {
    name: pro ? basename(pro.path, ".kicad_pro") : basename(dir),
    dir,
    rev: hash(files.map((f) => f.path + f.hash).join("\n")),
    files,
    kicadCli,
  };
}

/** Resolve a project-relative path, refusing anything that escapes the project dir. */
export function safeJoin(dir: string, rel: string): string | null {
  const p = resolve(dir, rel);
  return p === dir || p.startsWith(dir + sep) ? p : null;
}

/** The root sheet: named like the .kicad_pro, else the shallowest .kicad_sch. */
export function rootSchematic(project: ProjectInfo): string | undefined {
  const pro = project.files.find((f) => f.kind === "pro")?.path.replace(/\.kicad_pro$/, ".kicad_sch");
  const schs = project.files.filter((f) => f.kind === "sch").map((f) => f.path);
  return schs.find((p) => p === pro) ?? schs.sort((a, b) => a.split("/").length - b.split("/").length)[0];
}

/** The board: named like the .kicad_pro, else the first .kicad_pcb. */
export function mainPcb(project: ProjectInfo): string | undefined {
  const pro = project.files.find((f) => f.kind === "pro")?.path.replace(/\.kicad_pro$/, ".kicad_pcb");
  const pcbs = project.files.filter((f) => f.kind === "pcb").map((f) => f.path);
  return pcbs.find((p) => p === pro) ?? pcbs[0];
}

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

/**
 * The project dir for a CLI invocation: an explicit path, else KRETSA_PROJECT, else the nearest
 * directory at or above `cwd` containing a .kicad_pro. Returns null if none is found.
 */
export async function findProjectDir(explicit?: string, cwd = process.cwd()): Promise<string | null> {
  const given = explicit ?? process.env.KRETSA_PROJECT;
  if (given) return (await isDir(resolve(given))) ? resolve(given) : null;
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if ((await readdir(d).catch(() => [] as string[])).some((n) => n.endsWith(".kicad_pro"))) return d;
    if (dirname(d) === d) return null;
  }
}

/** Data written by kretsa lives in <project>/.kretsa/. Projects reviewed before the rename have .wiber/: move it once. */
export async function migrateLegacyDir(projectDir: string): Promise<boolean> {
  const legacy = join(projectDir, ".wiber"), current = join(projectDir, ".kretsa");
  const exists = (p: string) => stat(p).then(() => true, () => false);
  if (!(await exists(legacy)) || (await exists(current))) return false;
  await rename(legacy, current);
  return true;
}
