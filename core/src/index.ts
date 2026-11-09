// @kretsa/core: everything kretsa knows about a KiCad project, without HTTP.
// Used by the CLI (agent-facing) and the server (web UI backend), so both give the same answers.

export * from "./project";
export * from "./kicad";
export * from "./review";
export * from "./check";
export * from "./workspace";
export * from "./library";
export * from "./library-md";
export * from "./render";
export * from "./sexpr";
export * from "./design";
export * from "./design-render";
export * from "./diff";
export * from "./klc";
