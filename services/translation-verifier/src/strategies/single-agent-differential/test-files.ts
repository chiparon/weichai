import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  hashContent,
  isProjectTestPath,
} from "../multi-agent-write-box/behavior-workspace.js";
import { validateTestPath, type TestSubmission } from "./report.js";

export const defaultWriteDirectories = [
  ".forexplore-tests",
  "src/test",
  "tests",
  "test",
];

export function validateWriteDirectories(directories: readonly string[]): void {
  if (!directories.length || directories.length > 32)
    throw new Error("Configure 1..32 test directories.");
  for (const path of directories) {
    validateTestPath(path);
    if (!isProjectTestPath(`${path}/generated.txt`))
      throw new Error(`Not a project test directory: ${path}`);
  }
}

/** Only publishes new files; rollback never resets a project or overwrites user edits. */
export class SubmittedTestFiles {
  private readonly created: { path: string; hash: string }[] = [];
  private readonly directories: string[] = [];
  private readonly root: string;

  constructor(
    root: string,
    private readonly allowed: readonly string[] | null,
  ) {
    this.root = realpathSync(root);
    if (allowed !== null) validateWriteDirectories(allowed);
  }

  private checked(path: string): string {
    validateTestPath(path);
    if (realpathSync(this.root) !== this.root)
      throw new Error("Test project root changed.");
    let current = this.root;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      try {
        const stat = lstatSync(current);
        if (
          stat.isSymbolicLink() ||
          (index < parts.length - 1
            ? !stat.isDirectory()
            : !stat.isFile() || stat.nlink !== 1)
        ) {
          throw new Error(`Unsupported test path: ${path}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return current;
  }

  apply(files: TestSubmission["files"]): void {
    // Check the whole bundle before the first write.
    for (const file of files) {
      if (
        this.allowed !== null && !this.allowed.some((directory) => file.path.startsWith(`${directory}/`))
      ) {
        throw new Error(
          `Test path is outside configured directories: ${file.path}`,
        );
      }
      const target = this.checked(file.path);
      try {
        lstatSync(target);
        throw new Error(`Test file already exists: ${file.path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const file of files) {
      let current = this.root;
      for (const part of file.path.split("/").slice(0, -1)) {
        current = join(current, part);
        try {
          mkdirSync(current);
          this.directories.push(current);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "EEXIST" ||
            !lstatSync(current).isDirectory() ||
            lstatSync(current).isSymbolicLink()
          )
            throw error;
        }
      }
      const target = this.checked(file.path);
      const temporary = join(
        dirname(target),
        `.forexplore-write-${randomUUID()}`,
      );
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, file.content, "utf8");
        this.checked(file.path);
        linkSync(temporary, target); // Exclusive publication: cannot replace an existing file.
        this.created.push({ path: file.path, hash: hashContent(file.content) });
      } finally {
        closeSync(descriptor);
        unlinkSync(temporary);
      }
    }
  }

  assertUnchanged(): void {
    for (const file of this.created) {
      if (hashContent(readFileSync(this.checked(file.path))) !== file.hash) {
        throw new Error(
          `Submitted test changed during execution: ${file.path}`,
        );
      }
    }
  }

  rollback(): void {
    // Preflight all files so a concurrent modification cannot cause a partial cleanup.
    const removable: string[] = [];
    for (const file of this.created) {
      const target = this.checked(file.path);
      try {
        if (hashContent(readFileSync(target)) !== file.hash)
          throw new Error(
            `Cannot remove externally changed test: ${file.path}`,
          );
        removable.push(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const target of removable.reverse()) unlinkSync(target);
    this.created.length = 0;
    for (const directory of [...this.directories].reverse()) {
      try {
        rmdirSync(directory);
      } catch (error) {
        if (
          !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    this.directories.length = 0;
  }
}
