import type { ProjectModule } from "@forexplore/contracts";
import type {
  FunctionGroupVerificationFunction,
  VerificationFunction,
} from "../services/translation-verifier/src/types.js";

type ModuleApiSource = Pick<ProjectModule, "sourceFiles" | "coreApis"> | {
  sourceFiles?: readonly string[];
  coreApis?: readonly string[];
};

export type FunctionMappingDiagnostic = {
  targetApi: string;
  reason:
    | "no-source-api"
    | "ambiguous-source-api"
    | "ambiguous-target-api"
    | "source-file-ambiguous"
    | "target-file-ambiguous";
};

export type ModuleFunctionMapping = {
  functions: FunctionGroupVerificationFunction[];
  unmatchedFunctions: VerificationFunction[];
  diagnostics: FunctionMappingDiagnostic[];
};

type ApiDescriptor = {
  raw: string;
  name: string;
  compareName: string;
  path?: string;
};

function normalizeCompareName(value: string): string {
  return value
    .replace(/[`"']/g, "")
    .replace(/\s+/g, "")
    .replace(/^~/, "")
    .toLocaleLowerCase();
}

/**
 * Core APIs are emitted by several indexers in slightly different forms:
 * `Class.Method`, `Class::Method(args)`, and `returnType Method(args)` are all
 * valid. Keep the original text as a signature, but compare the callable tail
 * after removing arguments, generic brackets, and a return type.
 */
export function callableApiName(value: string): string {
  let base = value.trim();
  const argumentStart = base.indexOf("(");
  if (argumentStart >= 0) base = base.slice(0, argumentStart);
  base = base.replace(/<[^<>]*>/g, "");
  const qualified = base.split(/::|[.#]/).filter(Boolean).at(-1) ?? base;
  const tokens = qualified.trim().split(/\s+/).filter(Boolean);
  return (tokens.at(-1) ?? qualified.trim()).replace(/[;,]+$/, "");
}

function qualifierTokens(value: string): string[] {
  let base = value.trim();
  const argumentStart = base.indexOf("(");
  if (argumentStart >= 0) base = base.slice(0, argumentStart);
  base = base.replace(/<[^<>]*>/g, "");
  const pieces = base.split(/::|[.#]/).filter(Boolean);
  const last = pieces.at(-1) ?? base;
  const tokens = last.trim().split(/\s+/).filter(Boolean);
  return [...pieces.slice(0, -1), ...tokens.slice(0, -1)]
    .map((token) => normalizeCompareName(token))
    .filter(Boolean);
}

function fileStem(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  return normalizeCompareName(name.replace(/\.[^.]+$/, ""));
}

/** Return a path only when the API-to-file association is unambiguous. */
function resolveApiPath(rawApi: string, files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  if (files.length === 1) return files[0];
  const qualifiers = new Set(qualifierTokens(rawApi));
  const raw = normalizeCompareName(rawApi);
  const scored = files.map((path) => {
    const stem = fileStem(path);
    let score = 0;
    if (qualifiers.has(stem)) score = 3;
    else if ([...qualifiers].some((token) => token === stem || token.endsWith(stem) || stem.endsWith(token))) score = 2;
    else if (raw.includes(stem)) score = 1;
    return { path, score };
  }).sort((left, right) => right.score - left.score);
  if (scored[0]!.score === 0 || scored[0]!.score === scored[1]?.score) return undefined;
  return scored[0]!.path;
}

function resolveRelatedFile(targetPath: string | undefined, sourceFiles: readonly string[]): string | undefined {
  if (!targetPath || sourceFiles.length === 0) return undefined;
  const targetStem = fileStem(targetPath);
  const matches = sourceFiles.filter((path) => fileStem(path) === targetStem);
  return matches.length === 1 ? matches[0] : undefined;
}

function describeApis(source: ModuleApiSource): ApiDescriptor[] {
  return [...new Set((source.coreApis ?? []).map((value) => value.trim()).filter(Boolean))]
    .map((raw) => {
      const name = callableApiName(raw);
      return {
        raw,
        name,
        compareName: normalizeCompareName(name),
        path: resolveApiPath(raw, source.sourceFiles ?? []),
      };
    });
}

function asVerificationFunction(api: ApiDescriptor, fallbackPath: string | undefined): VerificationFunction {
  return {
    path: api.path ?? fallbackPath ?? "unknown",
    name: api.name,
    ...(api.raw !== api.name ? { signature: api.raw } : {}),
  };
}

/**
 * Build only mappings that can be justified by both API identity and file
 * ownership. Every target API that fails one of those checks is retained as an
 * unmatched target so the verifier cannot silently claim complete coverage.
 */
export function buildModuleFunctionMapping(
  targetModule: ProjectModule,
  sourceModule: ModuleApiSource | undefined,
): ModuleFunctionMapping {
  const targetApis = describeApis(targetModule);
  const sourceApis = sourceModule ? describeApis(sourceModule) : [];
  const sourceByName = new Map<string, ApiDescriptor[]>();
  const targetByName = new Map<string, ApiDescriptor[]>();
  for (const api of sourceApis) sourceByName.set(api.compareName, [...(sourceByName.get(api.compareName) ?? []), api]);
  for (const api of targetApis) targetByName.set(api.compareName, [...(targetByName.get(api.compareName) ?? []), api]);

  const functions: FunctionGroupVerificationFunction[] = [];
  const unmatchedFunctions: VerificationFunction[] = [];
  const diagnostics: FunctionMappingDiagnostic[] = [];
  for (const targetApi of targetApis) {
    const sourceMatches = sourceByName.get(targetApi.compareName) ?? [];
    const targetMatches = targetByName.get(targetApi.compareName) ?? [];
    const targetFunction = asVerificationFunction(targetApi, targetModule.sourceFiles[0]);
    if (sourceMatches.length === 0) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "no-source-api" });
      continue;
    }
    if (sourceMatches.length !== 1) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "ambiguous-source-api" });
      continue;
    }
    if (targetMatches.length !== 1) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "ambiguous-target-api" });
      continue;
    }
    const sourceApi = sourceMatches[0]!;
    const sourcePath = sourceApi.path ?? resolveRelatedFile(targetApi.path, sourceModule?.sourceFiles ?? []);
    if (!sourcePath) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "source-file-ambiguous" });
      continue;
    }
    if (!targetApi.path) {
      unmatchedFunctions.push(targetFunction);
      diagnostics.push({ targetApi: targetApi.raw, reason: "target-file-ambiguous" });
      continue;
    }
    functions.push({
      source: { ...asVerificationFunction(sourceApi, sourceModule?.sourceFiles?.[0]), path: sourcePath },
      target: targetFunction,
    });
  }
  return { functions, unmatchedFunctions, diagnostics };
}
