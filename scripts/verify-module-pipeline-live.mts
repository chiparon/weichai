/**
 * Live module-pipeline verification.
 *
 * Runs the whole module-level path with the real model and a real compiler:
 * static analysis -> approved module plan -> per-module generation in an
 * isolated worktree -> combined wave validation -> human approval bound to the
 * prepared hash -> atomic commit on the managed migration branch. The user's
 * checkout is never edited in place.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { analyzeRepository } from '@forexplore/code-indexer';
import {
  buildModuleMigrationPlan,
  createMigrationRunManifest,
  recordModulePlanDecision,
} from '@forexplore/workflow-core';
import {
  moduleMigrationSchemaVersion,
  type FunctionalModule,
  type ModuleMigrationProposal,
} from '@forexplore/contracts';
import {
  ModuleWaveExecutionCoordinator,
  WorkspaceModulePatchPreparer,
  createWorkspaceTranslationModelClient,
} from '@forexplore/adaptation-service';
import { prepareGeneratedModuleWave } from '../apps/vscode-extension/src/module-wave-execution-host.js';
import { CommandModuleWaveValidator } from '../apps/vscode-extension/src/module-wave-validation.js';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: 'tmp/module-pipeline-mvp/live-report.json' },
  'max-turns': { type: 'string', default: '30' },
  'keep-root': { type: 'boolean', default: false },
} });
const maxModelTurns = Number(values['max-turns']);
assert(Number.isSafeInteger(maxModelTurns) && maxModelTurns >= 4 && maxModelTurns <= 200, 'max-turns must be 4..200.');

const environment = parseEnv(await readFile('services/adaptation-service/.env', 'utf8'));
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || environment.DEEPSEEK_API_KEY?.trim();
assert(apiKey, 'DEEPSEEK_API_KEY is required (services/adaptation-service/.env or the process environment).');
const model = environment.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash';
const now = new Date().toISOString();
const runId = `module-live-${now.replace(/[:.]/g, '-')}`;
const report: Record<string, unknown> = { startedAt: now, runId, model, host: process.platform, maxModelTurns };

const project = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup>',
  '    <OutputType>Exe</OutputType>',
  '    <TargetFramework>net8.0</TargetFramework>',
  '    <Nullable>enable</Nullable>',
  '    <ImplicitUsings>disable</ImplicitUsings>',
  '    <AssemblyName>Fixture</AssemblyName>',
  '    <RootNamespace>Fixture</RootNamespace>',
  '  </PropertyGroup>',
  '</Project>',
  '',
].join('\n');
const harness = [
  'using System;',
  '',
  'namespace Fixture',
  '{',
  '    public static class Harness',
  '    {',
  '        public static int Main()',
  '        {',
  '            if (Limit.Increment(0) != 1)',
  '            {',
  '                Console.Error.WriteLine("increment(0) must be 1");',
  '                return 1;',
  '            }',
  '            try',
  '            {',
  '                Limit.Increment(-1);',
  '                Console.Error.WriteLine("negative input must be rejected");',
  '                return 1;',
  '            }',
  '            catch (ArgumentOutOfRangeException)',
  '            {',
  '            }',
  '            Console.WriteLine("limit behavior verified");',
  '            return 0;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');
const stub = [
  'namespace Fixture',
  '{',
  '    public static class Limit',
  '    {',
  '        public static int Increment(int value)',
  '        {',
  '            return value + 1;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

const compileCommand = { executable: 'dotnet', args: ['build', 'Fixture.csproj', '--nologo', '-v', 'q'], timeoutMs: 600_000 };
const verification = {
  command: { executable: 'dotnet', args: ['exec', 'bin/Debug/net8.0/Fixture.dll'], timeoutMs: 120_000 },
  protectedFiles: ['Program.cs'],
};

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-module-live-'));
  const files: Record<string, string> = {
    '.gitignore': 'bin/\nobj/\n',
    'Fixture.csproj': project,
    'Program.cs': harness,
    'src/Limit.cs': stub,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }
  git(root, ['init']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.email', 'forexplore@example.test']);
  git(root, ['config', 'user.name', 'ForeXplore Live Verification']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  return root;
}

function limitModule(): FunctionalModule {
  return {
    id: 'limit',
    name: 'limit',
    kind: 'feature',
    description: 'Boundary-checked increment used by the upload limit path',
    purpose: 'Increment a nonnegative value and reject negative input with a typed error.',
    coreApis: ['Limit.Increment(int)'],
    sourceFiles: ['Program.cs', 'src/Limit.cs'],
    symbolIds: [],
    dependsOn: [],
    writeSet: ['src/Limit.cs'],
    resourceLocks: [],
    evidenceIds: [],
  };
}

/** The trusted host owns joint validation; a bare HTTP client can never supply it. */
const waveValidator = new CommandModuleWaveValidator([
  {
    id: 'wave-build',
    label: 'Joint wave build in the combined staging worktree',
    executable: 'dotnet',
    args: ['build', 'Fixture.csproj', '--nologo', '-v', 'q'],
    cwd: '.',
    required: true,
    timeoutMs: 600_000,
  },
  {
    id: 'wave-behavior',
    label: 'Joint wave behavioral acceptance',
    executable: 'dotnet',
    args: ['exec', 'bin/Debug/net8.0/Fixture.dll'],
    cwd: '.',
    required: true,
    timeoutMs: 120_000,
  },
]);

const root = await fixtureRepository();
report.repositoryRoot = root;
const analysis = await analyzeRepository({ root, createdAt: now });
report.analysis = {
  snapshotId: analysis.snapshotId,
  revision: analysis.repository.revision,
  files: analysis.files.map((file) => ({ path: file.path, role: file.role, language: file.language })),
};

const proposal: ModuleMigrationProposal = {
  schemaVersion: moduleMigrationSchemaVersion,
  snapshotId: analysis.snapshotId,
  objective: 'Reject negative input in the limit module while preserving the increment behavior used by upload size checks.',
  modules: [limitModule()],
  fileAssignments: [
    { path: 'Program.cs', kind: 'module', moduleId: 'limit' },
    { path: 'src/Limit.cs', kind: 'module', moduleId: 'limit' },
    { path: 'Fixture.csproj', kind: 'excluded', reason: 'Project configuration is not migrated in this MVP.' },
  ],
};
const draftPlan = buildModuleMigrationPlan(analysis, proposal, { now });
const plan = recordModulePlanDecision(
  draftPlan,
  { id: 'plan-approval', kind: 'plan-approval', status: 'approved', snapshotId: analysis.snapshotId, planHash: draftPlan.planHash, actor: 'live-verification', decidedAt: now },
  analysis.snapshotId,
  now,
);
assert.equal(plan.status, 'approved');
report.plan = { id: plan.id, planHash: plan.planHash, waveId: plan.executionWaves[0]!.id, modules: plan.executionWaves[0]!.moduleIds };

const manifest = createMigrationRunManifest(plan, runId, now);
const coordinator = new ModuleWaveExecutionCoordinator();
const events: Array<Record<string, unknown>> = [];
const preparer = new WorkspaceModulePatchPreparer({
  client: createWorkspaceTranslationModelClient({ apiKey: () => apiKey, temperature: 0 }),
  compileCommand,
  verification,
  maxModelTurns,
  observe: (event) => { events.push({ ...event }); console.info(JSON.stringify({ module: event.moduleId, phase: event.phase, status: event.status, turns: event.modelTurns, detail: event.detail })); },
});

const generatedAt = Date.now();
const preparedWave = await prepareGeneratedModuleWave({
  repositoryRoot: root,
  analysis,
  plan,
  manifest,
  runId,
  preparer,
  validator: waveValidator,
  coordinator,
  maxPreparationParallelism: 1,
  now,
});
const prepared = preparedWave.prepared;
report.preparation = {
  elapsedMs: Date.now() - generatedAt,
  preparedHash: prepared.transaction.preparedHash,
  storedPrepared: preparedWave.storedPrepared,
  baseCommit: prepared.transaction.baseCommit,
  events,
  modules: prepared.preparedModules.map((module) => ({
    moduleId: module.moduleId,
    files: module.files.map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions })),
    validation: module.validation.map((record) => ({ id: record.id, status: record.status, required: record.required })),
  })),
  validation: prepared.validation.map((record) => ({ id: record.id, status: record.status, required: record.required, summary: record.summary })),
  planStatus: prepared.plan.status,
  waveStatus: prepared.plan.executionWaves[0]!.status,
};
assert.equal(prepared.transaction.status, 'prepared');
assert.equal(prepared.preparedModules.length, 1);
assert.equal(await readFile(path.join(root, 'src', 'Limit.cs'), 'utf8'), stub, 'preparation must not touch the user checkout');

const approved = recordModulePlanDecision(prepared.plan, {
  id: `wave-approval:${prepared.transaction.preparedHash}`,
  kind: 'wave-approval',
  status: 'approved',
  waveId: plan.executionWaves[0]!.id,
  preparedHash: prepared.transaction.preparedHash,
  snapshotId: plan.snapshotId,
  planHash: plan.planHash,
  actor: 'live-verification-reviewer',
  decidedAt: now,
}, plan.snapshotId, now);

const committed = await coordinator.commit({
  repositoryRoot: root,
  analysis,
  plan: approved,
  manifest: prepared.manifest,
  prepared,
  now,
});

const changed = git(root, ['diff', '--name-only', `${prepared.transaction.baseCommit}..${committed.branchName}`]).trim().split('\n').filter(Boolean);
const generated = git(root, ['show', `${committed.branchName}:src/Limit.cs`]);
report.commit = {
  branchName: committed.branchName,
  commit: committed.commit,
  changedPaths: changed,
  generatedSource: generated,
  transactionStatus: committed.transaction.status,
  summaryWaveStatus: committed.summary.generated.executionWaves[0]?.status,
};

assert.equal(committed.transaction.status, 'committed');
assert.equal(committed.transaction.commit, committed.commit);
assert(changed.includes('src/Limit.cs'), 'the wave must publish the module file');
assert(
  changed.filter((file) => !file.startsWith('.forexplore/')).every((file) => file === 'src/Limit.cs'),
  `the wave must not change files outside the write set: ${changed.join(', ')}`,
);
assert(/ArgumentOutOfRangeException/.test(generated), 'the committed implementation must be the generated one');
assert.equal(await readFile(path.join(root, 'src', 'Limit.cs'), 'utf8'), stub, 'the user checkout must stay untouched');
assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'the user checkout must stay clean');

report.passed = true;
report.finishedAt = new Date().toISOString();
report.keptRepository = values['keep-root'] ? root : undefined;
const output = path.resolve(values.output!);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify({
  passed: true,
  branch: committed.branchName,
  commit: committed.commit,
  preparedHash: prepared.transaction.preparedHash,
  changedPaths: changed,
  report: output,
}, null, 2));
console.info(generated);
