// The review contract between the human (via the web UI) and the AI agent.
// Persisted as <project>/.kretsa/review.json. Keep changes backwards compatible; bump `version` otherwise.
// Spec + agent instructions: docs/review-format.md

export type View = "sch" | "pcb" | "3d";
export type Status = "open" | "addressed" | "resolved" | "wontfix";
/** Where a comment was made: a design view, or the library (a part, or a request for a new one). */
export type CommentView = View | "lib";
/** Library comments: which side of the part the human was looking at. */
export type Aspect = "symbol" | "footprint" | "3d";

export type Anchor =
  | { kind: "symbol"; ref: string; uuid?: string; value?: string } // sch symbol or pcb footprint
  | { kind: "net"; name: string }
  | { kind: "pad"; ref: string; pad: string } // design: refdes + pad; library: footprint id + pad
  | { kind: "pin"; pin: string; name?: string } // library: a symbol pin of the comment's part
  | { kind: "area"; bbox_mm: [number, number, number, number] } // KiCad document coords (mm)
  | { kind: "point"; at_mm: [number, number] };

/**
 * A shape the human drew on the sch/pcb, in KiCad document coords (mm). Written for LLM consumption:
 * `covers`/`from_ref`/`to_ref` say what the shape points at, so the raw `pts_mm` rarely matter.
 */
export interface InkShape {
  tool: "pen" | "rect" | "arrow";
  bbox_mm: [number, number, number, number]; // x1, y1, x2, y2
  /** Parts enclosed by a rect / closed pen loop, or touched by an open pen stroke. */
  covers?: string[];
  /** Arrow: tail and head positions, and the parts under them ("move this there"). */
  from_mm?: [number, number];
  to_mm?: [number, number];
  from_ref?: string;
  to_ref?: string;
  /** Simplified polyline (pen), corners (rect: 2 points) or tail/head (arrow). */
  pts_mm: [number, number][];
}

export interface ThreadEntry {
  author: "human" | "ai";
  text: string;
  at: string; // ISO timestamp
}

export interface Comment {
  id: string;
  status: Status;
  view: CommentView;
  /** Library comments: the part ("Lib:Name"). Absent on a library comment = a request for a new part. */
  part?: string;
  aspect?: Aspect;
  file?: string; // project-relative file the comment was made on
  sheet?: string;
  layer?: string;
  anchors: Anchor[];
  ink?: string; // .kretsa-relative path to SVG (generated from ink_shapes, viewBox in document mm)
  ink_shapes?: InkShape[];
  snapshot?: string; // .kretsa-relative path to PNG
  text: string;
  design_rev: string;
  thread: ThreadEntry[];
  created: string;
  /**
   * When the human handed this comment to the agent ("Send to AI"). Unset = a draft the human may still
   * change. A human reply or reopen sends again. `kretsa wait` returns comments sent since it last returned.
   */
  sent?: string;
}

/** Open and not handed to the agent yet. */
export const isDraft = (c: Comment) => c.status === "open" && !c.sent;

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
  | { type: "review" }
  | { type: "project"; id: string } // the current project of the workspace changed
  | { type: "lib" } // a library file (symbol, footprint, 3D model, lib table) changed
  | { type: "agent" } // `kretsa wait` started or stopped
  | { type: "theme" }; // the color preference file changed

export type NewComment = Omit<Comment, "id" | "status" | "design_rev" | "thread" | "created"> & {
  snapshotPng?: string; // data URL, server stores it to snap/<id>.png
};

export type CommentPatch = {
  status?: Status;
  reply?: Omit<ThreadEntry, "at">;
  /** Drafts only: replace the text. */
  text?: string;
};

/** Is an agent blocked in `kretsa wait` for this project right now? (GET /api/agent) */
export interface AgentStatus { waiting: boolean; since?: string }

/** Body of POST /api/review/send: send these drafts (default: all drafts). */
export type SendRequest = { ids?: string[] };
