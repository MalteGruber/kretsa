// A workspace is any folder containing one or more KiCad projects (a project folder on its own is a
// workspace with one project). The "current" project is shared by the human (web UI) and the agent
// (CLI): switching in either moves the other. Stored in <workspace>/.kretsa/workspace.json.

export interface ProjectEntry {
  /** Workspace-relative path of the project dir ("." when the workspace is the project). */
  id: string;
  name: string; // .kicad_pro basename
  hasSch: boolean;
  hasPcb: boolean;
  /** Last modification of any design file (ISO). */
  modified: string;
  /** Review comments with status "open" / "addressed". */
  open: number;
  addressed: number;
}

export interface WorkspaceInfo {
  root: string;
  projects: ProjectEntry[];
  current: string | null; // ProjectEntry.id
}

/** <workspace>/.kretsa/workspace.json */
export interface WorkspaceState {
  current: string | null;
}
