import { Ajv } from "ajv";
import type { BehaviorCommand } from "../multi-agent-write-box/behavior-types.js";

/** Generated artifacts only. Execution results always come from the host. */
export interface TestSubmission {
  files: { path: string; content: string }[];
  command: BehaviorCommand;
}

export const testSubmissionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "command"],
  properties: {
    files: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 1024 },
          content: {
            type: "string",
            minLength: 1,
            maxLength: 256_000,
            pattern: "\\S",
          },
        },
      },
    },
    command: {
      type: "object",
      additionalProperties: false,
      required: ["executable", "args"],
      properties: {
        executable: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          pattern: "\\S",
        },
        args: {
          type: "array",
          maxItems: 128,
          items: { type: "string", maxLength: 16_000 },
        },
      },
    },
  },
} as const;
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile<TestSubmission>(testSubmissionSchema);

export function validateTestPath(path: string): void {
  if (
    !path ||
    path.length > 1024 ||
    /[\\:\x00-\x1f]/.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          [".git", ".forexplore"].includes(part.toLowerCase()),
      )
  ) {
    throw new Error(`Invalid test-relative path: ${path}`);
  }
}

export function parseTestSubmission(value: unknown): TestSubmission {
  if (!validate(value))
    throw new Error(
      `Invalid test submission: ${ajv.errorsText(validate.errors)}`,
    );
  const paths = new Set<string>();
  let characters = 0;
  for (const file of value.files) {
    validateTestPath(file.path);
    // Case-folding also prevents ambiguous bundles moved between platforms.
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error(`Duplicate test path: ${file.path}`);
    paths.add(key);
    if (file.content.includes("\0"))
      throw new Error("Test content must be UTF-8 text without NUL.");
    characters += file.content.length;
  }
  if (characters > 1_000_000)
    throw new Error("Test submission exceeds 1000000 characters.");
  if (
    [value.command.executable, ...value.command.args].some((text) =>
      text.includes("\0"),
    )
  ) {
    throw new Error("Command arguments cannot contain NUL.");
  }
  return structuredClone(value);
}
