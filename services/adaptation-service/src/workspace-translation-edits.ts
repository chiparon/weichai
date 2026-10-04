/**
 * Anchored edits for the Translator.
 *
 * A whole-file write was the only way to change a file, so a one-line fix resent
 * the whole file and a regeneration could silently drop the parts the model did
 * not repeat. An anchored edit keeps the change to the text the model actually
 * names, and every failure mode is explicit rather than silent: a missing or
 * ambiguous anchor is refused instead of guessed.
 */
export interface WorkspaceEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll: boolean;
}

export const maxWorkspaceEdits = 20;
export const maxWorkspaceEditChars = 32_000;

const anchorPreview = (value: string) => {
  const line = value.split("\n", 1)[0] ?? "";
  const preview = line.length > 120 ? `${line.slice(0, 120)}…` : line;
  return JSON.stringify(preview);
};

function parseEdit(value: unknown, index: number): WorkspaceEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`edits[${index}] must be an object with oldText, newText and an optional replaceAll.`);
  }
  const edit = value as Record<string, unknown>;
  const unknownKey = Object.keys(edit).find((key) => !["oldText", "newText", "replaceAll"].includes(key));
  if (unknownKey) throw new Error(`edits[${index}] has an unsupported field: ${unknownKey}`);
  if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
    throw new Error(`edits[${index}] requires string oldText and newText.`);
  }
  if (!edit.oldText) throw new Error(`edits[${index}].oldText must be the exact existing text to replace.`);
  if (edit.oldText.length > maxWorkspaceEditChars || edit.newText.length > maxWorkspaceEditChars) {
    throw new Error(`edits[${index}] exceeds the per-edit text limit.`);
  }
  if (edit.replaceAll !== undefined && typeof edit.replaceAll !== "boolean") {
    throw new Error(`edits[${index}].replaceAll must be a boolean.`);
  }
  if (edit.oldText === edit.newText) throw new Error(`edits[${index}] does not change the file.`);
  return { oldText: edit.oldText, newText: edit.newText, replaceAll: edit.replaceAll === true };
}

export function parseWorkspaceEdits(value: unknown): WorkspaceEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edit_file requires a nonempty edits array.");
  }
  if (value.length > maxWorkspaceEdits) {
    throw new Error(`edit_file accepts at most ${maxWorkspaceEdits} edits per call.`);
  }
  return value.map(parseEdit);
}

/**
 * Edits apply in order to the content as it evolves, so a later anchor may match
 * text an earlier edit produced. Ambiguity is refused because replacing the wrong
 * occurrence is worse than failing: the model can lengthen the anchor or set
 * replaceAll explicitly.
 */
export function applyWorkspaceEdits(content: string, edits: readonly WorkspaceEdit[]): string {
  let current = content;
  for (const [index, edit] of edits.entries()) {
    const first = current.indexOf(edit.oldText);
    if (first < 0) {
      throw new Error(`edits[${index}] anchor was not found in the file: ${anchorPreview(edit.oldText)}. Read the file and use the exact current text.`);
    }
    if (!edit.replaceAll) {
      if (current.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
        const occurrences = current.split(edit.oldText).length - 1;
        throw new Error(`edits[${index}] anchor matches ${occurrences} times: ${anchorPreview(edit.oldText)}. Lengthen the anchor or set replaceAll.`);
      }
      current = current.slice(0, first) + edit.newText + current.slice(first + edit.oldText.length);
      continue;
    }
    current = current.split(edit.oldText).join(edit.newText);
  }
  return current;
}
