import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  FunctionalModule,
  FunctionalModuleKind,
  IndexedCodeDocument,
  IndexedModuleDocument,
  ModuleSummary,
  ModuleSymbolEvidence,
} from '@forexplore/contracts';
import { discoverRepositories } from './discover.js';
import { extractCorpus } from './index.js';

const usableSummaryStatuses = new Set(['approved', 'executing', 'completed']);
const functionalModuleKinds = new Set<FunctionalModuleKind>([
  'feature', 'shared-contract', 'infrastructure', 'integration', 'test-support', 'other',
]);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

function uniqueStable(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((item) => item.length > 1);
}

function label(value: string): string {
  if (value === 'core') return 'Core';
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function moduleKind(value: string): FunctionalModuleKind {
  const normalized = value.toLowerCase();
  if (/(port|servlet|adapter|bridge|integration)/.test(normalized)) return 'integration';
  if (/(infra|disk|store|journal|repository|persistence)/.test(normalized)) return 'infrastructure';
  if (/(contract|domain|model|core|common|util)/.test(normalized)) return 'shared-contract';
  if (/(test|fixture|support)/.test(normalized)) return 'test-support';
  if (/(generated|autogen)/.test(normalized)) return 'other';
  return 'feature';
}

function commonDirectoryPrefix(paths: string[]): string[] {
  const directories = paths.map((filePath) => filePath.split('/').slice(0, -1));
  if (directories.length === 0) return [];
  const first = directories[0] ?? [];
  let length = first.length;
  for (const directory of directories.slice(1)) {
    length = Math.min(length, directory.length);
    for (let index = 0; index < length; index += 1) {
      if (first[index] !== directory[index]) {
        length = index;
        break;
      }
    }
  }
  return first.slice(0, length);
}

function inferredGroups(
  documents: IndexedCodeDocument[],
  sourceRoot: string | undefined,
): Map<string, IndexedCodeDocument[]> {
  const normalizedRoot = sourceRoot?.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const relative = documents.map((document) => ({
    document,
    path: normalizedRoot && document.path.startsWith(`${normalizedRoot}/`)
      ? document.path.slice(normalizedRoot.length + 1)
      : document.path,
  }));
  const prefix = commonDirectoryPrefix(relative.map((item) => item.path));
  const groups = new Map<string, IndexedCodeDocument[]>();
  for (const item of relative) {
    const parts = item.path.split('/').slice(prefix.length);
    const key = parts.length > 1 ? parts[0] || 'core' : 'core';
    const current = groups.get(key) ?? [];
    current.push(item.document);
    groups.set(key, current);
  }
  return groups;
}

function isModuleSummary(value: unknown): value is ModuleSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Partial<ModuleSummary>;
  return Boolean(
    summary.generated &&
    Array.isArray(summary.generated.modules) &&
    summary.generated.modules.every((module) => {
      if (typeof module !== 'object' || module === null) return false;
      const item = module as Partial<FunctionalModule>;
      return (
        typeof item.id === 'string' && typeof item.name === 'string' &&
        typeof item.kind === 'string' && functionalModuleKinds.has(item.kind as FunctionalModuleKind) &&
        typeof item.description === 'string' &&
        Array.isArray(item.sourceFiles) && item.sourceFiles.every((file) => typeof file === 'string') &&
        (item.generatedFiles === undefined ||
          (Array.isArray(item.generatedFiles) && item.generatedFiles.every((file) => typeof file === 'string'))) &&
        Array.isArray(item.dependsOn) && item.dependsOn.every((id) => typeof id === 'string')
      );
    }) &&
    usableSummaryStatuses.has(String(summary.generated.status)) &&
    summary.human?.approvalsCurrent === true,
  );
}

async function approvedSummary(repositoryRoot: string): Promise<{
  summary?: ModuleSummary;
  fallbackRisk?: string;
}> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(repositoryRoot, '.forexplore', 'module-summary.json'), 'utf8'),
    );
    return isModuleSummary(value)
      ? { summary: value }
      : { fallbackRisk: 'Unapproved module summary ignored; deterministic boundary fallback used' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      return { fallbackRisk: 'Invalid module summary ignored; deterministic boundary fallback used' };
    }
    throw error;
  }
}

async function repositoryDescription(repositoryRoot: string): Promise<string> {
  try {
    const markdown = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    let inCode = false;
    const prose: string[] = [];
    for (const rawLine of markdown.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('```')) {
        inCode = !inCode;
        continue;
      }
      if (inCode || !line || /^#+\s/.test(line)) continue;
      if (/^(?:requirements?|toolchain|build|test|lint|license)\s*:/i.test(line.replace(/^[-*]\s*/, ''))) continue;
      prose.push(line.replace(/^[-*]\s+/, ''));
      if (prose.join(' ').length >= 1_200) break;
    }
    return prose.join(' ').slice(0, 1_200);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function evidence(document: IndexedCodeDocument): ModuleSymbolEvidence {
  return {
    id: document.id,
    title: document.title,
    kind: document.kind,
    path: document.path,
    signature: document.signature,
    summary: document.summary,
    preview: document.preview.slice(0, 1_200),
  };
}

function buildModule(
  repository: string,
  language: IndexedCodeDocument['language'],
  license: string,
  module: Pick<FunctionalModule, 'id' | 'name' | 'kind' | 'description' | 'dependsOn'>,
  documents: IndexedCodeDocument[],
  declaredFiles?: string[],
  extraRisks: string[] = [],
  fallbackDescription = '',
): IndexedModuleDocument {
  const sorted = [...documents].sort((left, right) =>
    left.path.localeCompare(right.path) || left.id.localeCompare(right.id),
  );
  const sourceFiles = unique(declaredFiles ?? sorted.map((document) => document.path));
  const classes = sorted.filter((document) => document.kind === 'class');
  const functions = sorted.filter((document) => document.kind === 'function');
  const representatives = [...classes.slice(0, 6), ...functions.slice(0, 8)]
    .slice(0, 12)
    .map(evidence);
  const coreApis = uniqueStable([
    ...classes.slice(0, 12).map((document) => document.title),
    ...functions.slice(0, 20).map((document) => document.signature),
  ]).slice(0, 24);
  const dependencies = unique([
    ...module.dependsOn,
    ...sorted.flatMap((document) => document.dependencies),
  ]);
  const repositoryName = repository.replace(/^fixture\//, '');
  const domain = unique([...words(repositoryName), ...words(module.name)])
    .filter((term) => !['java', 'python', 'typescript', 'csharp', 'rust', 'golang'].includes(term))
    .join(' ');
  const purpose = module.description.trim() || [
    fallbackDescription.trim(),
    `${module.name} provides reusable ${domain || 'application'} behavior.`,
    coreApis.length > 0 ? `Core APIs: ${coreApis.slice(0, 8).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  const structureTerms = unique([
    module.kind,
    ...words(module.name),
    ...coreApis.flatMap(words),
    ...dependencies.flatMap(words),
    ...sourceFiles.flatMap((file) => words(path.basename(file, path.extname(file)))),
  ]);
  const contentHash = digest(JSON.stringify({
    repository,
    module: module.id,
    sourceFiles,
    symbols: sorted.map((document) => document.id),
    purpose,
    coreApis,
    dependencies,
  }));
  return {
    id: `${repository}:${module.id}`,
    repository,
    moduleId: module.id,
    name: module.name,
    kind: module.kind,
    language,
    license,
    purpose,
    domain,
    coreApis,
    sourceFiles,
    symbolIds: sorted.map((document) => document.id),
    dependencies,
    structureTerms,
    representativeSymbols: representatives,
    compatibility: [`Extracted from ${language} source`, 'Module-level retrieval candidate'],
    risks: unique([
      ...(sorted.some((document) => document.risks.includes('Synthetic evaluation fixture'))
        ? ['Synthetic evaluation fixture']
        : []),
      ...extraRisks,
    ]),
    snapshotId: `module-${contentHash.slice(0, 20)}`,
    contentHash,
  };
}

/** Build module candidates while preserving each manifest repository as an authorization boundary. */
export async function extractModuleCorpus(corpusRoot: string): Promise<IndexedModuleDocument[]> {
  const modules: IndexedModuleDocument[] = [];
  for (const { root, manifest } of await discoverRepositories(corpusRoot)) {
    const documents = await extractCorpus(root);
    if (documents.length === 0) continue;
    const repository = `fixture/${manifest.repository}`;
    const fallbackDescription = await repositoryDescription(root);
    const summaryResult = await approvedSummary(root);
    if (summaryResult.summary) {
      const byPath = new Map(documents.map((document) => [document.path, document]));
      const assignedIds = new Set<string>();
      for (const definition of summaryResult.summary.generated.modules) {
        const declaredFiles = unique([
          ...definition.sourceFiles,
          ...(definition.generatedFiles ?? []),
        ]);
        const selected = declaredFiles
          .map((file) => byPath.get(file))
          .filter((document): document is IndexedCodeDocument => document !== undefined);
        if (selected.length === 0) continue;
        selected.forEach((document) => assignedIds.add(document.id));
        modules.push(buildModule(
          repository,
          manifest.language,
          manifest.license || 'Unknown',
          definition,
          selected,
          declaredFiles,
        ));
      }
      const unassigned = documents.filter((document) => !assignedIds.has(document.id));
      if (unassigned.length > 0) {
        modules.push(buildModule(
          repository,
          manifest.language,
          manifest.license || 'Unknown',
          {
            id: 'unassigned',
            name: 'Unassigned source',
            kind: 'other',
            description: 'Source symbols not assigned by the approved module summary.',
            dependsOn: [],
          },
          unassigned,
          undefined,
          ['Approved module summary did not assign every indexed source symbol'],
        ));
      }
      continue;
    }

    const groups = inferredGroups(documents, manifest.sourceRoot);
    for (const [group, selected] of groups) {
      const id = group.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'core';
      modules.push(buildModule(
        repository,
        manifest.language,
        manifest.license || 'Unknown',
        {
          id,
          name: group === 'core' ? `${manifest.repository} Core` : label(group),
          kind: group === 'core' && groups.size === 1 ? 'feature' : moduleKind(group),
          description: '',
          dependsOn: [],
        },
        selected,
        undefined,
        summaryResult.fallbackRisk ? [summaryResult.fallbackRisk] : [],
        fallbackDescription,
      ));
    }
  }
  return modules.sort((left, right) => left.id.localeCompare(right.id));
}
