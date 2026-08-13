// A small, deliberately self-contained annotation vocabulary for a frozen
// device screenshot: a stroke IS a stroke, and a note is typed feedback
// with a three-way split (f = fix, q = question, n = new thing). This
// shape is compatible with external page-annotation tools that use the
// same f/q/n convention, so a freeze bundle can be picked up by whatever
// annotation workflow a project already has, but nothing in this repo
// requires one to exist: the built-in annotation modal (freeze.ts) is
// enough on its own.
//
// Deliberately narrow: no attached-element selectors, no captured CSS
// layout frame, no in-place text edits. A frozen panel is a bitmap, not a
// DOM, so those concepts (which matter for annotating a live web page)
// would have nothing real to hold here.

export type MarkType = "f" | "q" | "n";

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: number;
  type: MarkType;
  points: Point[];
}

export interface Note {
  id: number;
  type: MarkType;
  text: string;
}

export interface Journal {
  strokes: Stroke[];
  notes: Note[];
}

// red ! fix, blue ? question, green + new thing.
export const MARK_COLORS: Record<MarkType, string> = {
  f: "#c0392b",
  q: "#2f6fb0",
  n: "#2f8f4f",
};

export const MARK_LABELS: Record<MarkType, string> = {
  f: "fix",
  q: "question",
  n: "new",
};

export function emptyJournal(): Journal {
  return { strokes: [], notes: [] };
}
