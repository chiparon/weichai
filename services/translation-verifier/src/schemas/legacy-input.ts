import type { FilePatch } from "@forexplore/contracts";
import { canonicalJson } from "@forexplore/workflow-core";
import { sha256Hex } from "./validate-json-paths.js";
import type { VerificationInput as SchemaInput } from "./verification-schema-types.js";

/** The standalone verifier owns this legacy JSON envelope; new worktree runs use WorkspaceTestInput. */
export type AdaptationRequestV2 = SchemaInput["request"] & {
  requirement: string;
  route: {
    sourceLanguageId: string;
    targetLanguageId: string;
    [key: string]: unknown;
  };
  candidate: {
    entity: { path: string; name: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  target: {
    entity: { path: string; name: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  targetContext: SchemaInput["request"]["targetContext"] & {
    constraints?: string[];
  };
  decisionNotes: string[];
};
export type RepositoryIngestionJsonValue =
  | null
  | boolean
  | number
  | string
  | RepositoryIngestionJsonValue[]
  | { [key: string]: RepositoryIngestionJsonValue };

/** Preserve the existing wire hash: SHA-256 of canonical JSON, including file order. */
export function calculatePatchHashV2(files: readonly FilePatch[]): string {
  return sha256Hex(canonicalJson(files));
}
