/**
 * Acceptance for "every corpus repository is modelled and visible in the frontend".
 *
 * The product tree is built by `buildProjectExplorer` from the host's durable
 * module analysis, so a repository only renders as modules when its analysis is
 * `ready`; otherwise the tree degrades to a file view. This check reads the same
 * payload the panel receives and fails when any corpus repository is missing,
 * unmodelled, or still rendered as a file view.
 *
 *   npx tsx scripts/verify-corpus-explorer.mts --corpus fixtures/code-corpus
 */
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  workbench: { type: 'string', default: 'http://127.0.0.1:4042' },
  corpus: { type: 'string', multiple: true, default: ['fixtures/code-corpus'] },
  /** Repositories that must additionally appear as the selected target. */
  'expect-target-modules': { type: 'boolean', default: false },
  output: { type: 'string' },
} });

interface TreeNode { kind: string; name: string; children?: TreeNode[] }
interface Workspace {
  name: string; mode: 'target' | 'history'; repositoryId?: string; projectId?: string;
  stats: { modules: number; files: number; types: number; methods: number };
  tree: TreeNode[];
  analysis?: { state?: string; modeling?: { strategy?: string }; hierarchy?: { nodeCount?: number } };
}

const expected = (await Promise.all(values.corpus!.map(async (directory) => {
  const entries = await readdir(path.resolve(directory), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name).sort();
}))).flat();

const response = await fetch(`${values.workbench}/v1/workbench/message`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'READY' }),
});
assert(response.ok, `Workbench payload request failed with HTTP ${response.status}.`);
const messages = (await response.json()) as Array<{ type: string; payload?: { moduleExplorer?: { history: Workspace[]; target: Workspace } } }>;
const explorer = messages.find((message) => message.type === 'INIT')?.payload?.moduleExplorer;
assert(explorer, 'The workbench payload carries no module explorer.');

const fileViewSuffix = '（文件视图）';
const fileViewOnly = (workspace: Workspace): boolean => workspace.tree.length > 0
  && workspace.tree.every((node) => node.kind === 'folder' && node.name.endsWith(fileViewSuffix));
const modelled = (workspace: Workspace): boolean => workspace.analysis?.state === 'ready' && workspace.stats.modules > 0 && !fileViewOnly(workspace);

const rows = explorer.history.map((workspace) => ({
  name: workspace.name,
  repositoryId: workspace.repositoryId,
  projectId: workspace.projectId,
  analysisState: workspace.analysis?.state ?? '(none)',
  strategy: workspace.analysis?.modeling?.strategy ?? '-',
  modules: workspace.stats.modules,
  files: workspace.stats.files,
  roots: workspace.tree.map((node) => node.name).slice(0, 3).join(' | '),
  visible: modelled(workspace),
}));
console.table(rows.map((row) => ({ repo: row.name.split(' / ')[0], state: row.analysisState, strategy: row.strategy,
  modules: row.modules, files: row.files, firstModules: row.roots })));

const presentNames = new Set(rows.map((row) => row.name.split(' / ')[0]));
const missing = expected.filter((name) => !presentNames.has(name));
const notModelled = rows.filter((row) => !row.visible).map((row) => `${row.name} [state=${row.analysisState} modules=${row.modules}]`);
const totalModules = rows.reduce((sum, row) => sum + row.modules, 0);
const targetVisible = values['expect-target-modules'] ? modelled(explorer.target) : true;

console.log(JSON.stringify({ workbench: values.workbench, expected: expected.length, visible: rows.length - notModelled.length,
  totalModules, missing, notModelled, target: { name: explorer.target.name, modules: explorer.target.stats.modules,
    analysisState: explorer.target.analysis?.state ?? '(none)' } }, null, 2));
if (values.output) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.resolve(values.output), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows, expected, missing, notModelled }, null, 2)}\n`, 'utf8');
}
assert.equal(missing.length, 0, `Corpus repositories missing from the frontend: ${missing.join(', ')}`);
assert.equal(notModelled.length, 0, `Corpus repositories are not shown as modelled modules: ${notModelled.join('; ')}`);
assert(targetVisible, `The selected target is not shown as modelled modules (state=${explorer.target.analysis?.state}, modules=${explorer.target.stats.modules}).`);
console.log(`OK: ${rows.length} corpus repositories visible with ${totalModules} modelled modules.`);
