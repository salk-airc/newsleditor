import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";

// Three-way merge for the studio: when an edition changed outside it (in the
// EmDash admin, or Claude through EmDash) while people were typing, the
// outside edit is applied on top of the live text, like a git merge, instead
// of making anyone choose between the two.

const dmp = new DiffMatchPatch();

/**
 * What changed from base to theirs, applied to ours. `clean` is false when
 * part of their change overlapped an edit of ours and was left out (ours wins
 * there).
 */
export function merge(base: string, ours: string, theirs: string): { text: string; clean: boolean } {
  if (theirs === base || theirs === ours) return { text: ours, clean: true };
  if (ours === base) return { text: theirs, clean: true };
  const [text, applied] = dmp.patch_apply(dmp.patch_make(base, theirs), ours);
  return { text, clean: applied.every(Boolean) };
}

/**
 * Turns ytext into next with the smallest edits, so co-editors' cursors stay
 * where they were outside the changed parts. Call inside a transaction.
 */
export function setText(ytext: Y.Text, next: string): void {
  let at = 0;
  for (const [op, chunk] of dmp.diff_main(ytext.toString(), next)) {
    if (op === DiffMatchPatch.DIFF_EQUAL) at += chunk.length;
    else if (op === DiffMatchPatch.DIFF_DELETE) ytext.delete(at, chunk.length);
    else {
      ytext.insert(at, chunk);
      at += chunk.length;
    }
  }
}
