// The review contract between the human (via the web UI) and the AI agent.
// Persisted as <project>/.wiber/review.json. Keep changes backwards compatible; bump `version` otherwise.
// Spec + agent instructions: docs/review-format.md

export type View = "sch" | "pcb" | "3d";
export type Status = "open" | "addressed" | "resolved" | "wontfix";

export type Anchor =
  | { kind: "symbol"; ref: string; uuid?: string; value?: string } // sch symbol or pcb footprint
  | { kind: "net"; name: string }
  | { kind: "pad"; ref: string; pad: string }
  | { kind: "area"; bbox_mm: [number, number, number, number] } // KiCad document coords (mm)
  | { kind: "point"; at_mm: [number, number] };

export interface ThreadEntry {
  author: "human" | "ai";
  text: string;
  at: string; // ISO timestamp
}

export interface Comment {
  id: string;
  status: Status;
  view: View;
  file?: string; // project-relative file the comment was made on
  sheet?: string;
  layer?: string;
  anchors: Anchor[];
  ink?: string; // .wiber-relative path to SVG
  snapshot?: string; // .wiber-relative path to PNG
  text: string;
  design_rev: string;
  thread: ThreadEntry[];
  created: string;
}

export interface Review {
  version: 1;
  comments: Comment[];
}

export interface ProjectFile {
  path: string; // project-relative, forward slashes
  kind: "pro" | "sch" | "pcb";
  hash: string;
}

export interface ProjectInfo {
  name: string;
  dir: string;
  rev: string; // hash over all design files
  files: ProjectFile[];
  kicadCli: string | null; // version string, or null if not installed
}

export type ServerMessage =
  | { type: "reload"; rev: string; changed: string[] }
  | { type: "review" };

export type NewComment = Omit<Comment, "id" | "status" | "design_rev" | "thread" | "created"> & {
  snapshotPng?: string; // data URL, server stores it to snap/<id>.png
};

export type CommentPatch = { status?: Status; reply?: Omit<ThreadEntry, "at"> };
