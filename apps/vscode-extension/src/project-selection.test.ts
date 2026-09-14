// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from '@forexplore/code-intelligence-service';
import { CodeIntelligenceHost, type RepositoryIdentityStore } from './code-intelligence-host';

class MemoryIdentityStore implements RepositoryIdentityStore {
  readonly values = new Map<string, string>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

/** Creates the two-project target directory the ambiguity tests need. */
async function twoProjectTarget(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-project-choice-'));
  for (const name of ['first-project', 'second-project']) {
    const directory = path.join(root, name);
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name }));
    await writeFile(path.join(directory, 'index.ts'), 'export function run() { return 1; }');
  }
  return root;
}

function analysisPort(ensure: () => Promise<void>) {
  return { ensure, idle: async () => {}, read: async (scope: any) => ({ ...scope,
    state: 'missing' as const, projection: 'pending' as const, analysisProfile: 'code-understanding/v1', updatedAt: '' }) };
}

it('waits for an explicit project choice in a target directory containing multiple projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-project-choice-'));
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const ensure = vi.fn(async () => {});
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime,
    planProject: async () => { throw new Error('The test must not invoke a model.'); },
    projectAnalysisPort: analysisPort(ensure),
  });
  try {
    for (const name of ['first-project', 'second-project']) {
      const directory = path.join(root, name);
      await mkdir(directory);
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name }));
      await writeFile(path.join(directory, 'index.ts'), 'export function run() { return 1; }');
    }
    const result = await host.synchronize({ repositories: [{ localPath: root, role: 'target' }] });
    const repository = result.presentation.repositories[0]!;
    expect(repository.projects).toHaveLength(2);
    expect(repository.selectedProjectId).toBeNull();
    expect(await host.explorerData()).toEqual([]);
    expect(ensure).not.toHaveBeenCalled();
    const selected = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision!,
      projectId: repository.projects[1]!.projectId };
    await host.selectProjectForDisplay(selected);
    await host.waitForProjects();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(selected, false);
    expect((await host.explorerData())[0]!.projectId).toBe(selected.projectId);
  } finally {
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('chooses the only real project of a target that also holds unattributed files', async () => {
  // The target repo keeps host-owned tooling (`tools/*.mjs`) next to its real
  // project; the indexer reports them as a `directory` group, which is not an
  // ambiguous choice and must not hide the target.
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-project-default-'));
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const ensure = vi.fn(async () => {});
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime,
    planProject: async () => { throw new Error('The test must not invoke a model.'); },
    projectAnalysisPort: analysisPort(ensure),
  });
  try {
    await mkdir(path.join(root, 'tools'));
    await mkdir(path.join(root, 'src', 'main', 'java', 'example'), { recursive: true });
    await writeFile(path.join(root, 'pom.xml'), '<project><artifactId>real-project</artifactId></project>');
    await writeFile(path.join(root, 'src', 'main', 'java', 'example', 'Upload.java'),
      'package example;\npublic class Upload { public int run() { return 1; } }\n');
    await writeFile(path.join(root, 'tools', 'verify.mjs'), 'console.log("host-owned");');
    const repository = (await host.synchronize({ repositories: [{ localPath: root, role: 'target' }] }))
      .presentation.repositories[0]!;
    expect(repository.projects.map((project) => project.kind).sort()).toEqual(['directory', 'maven']);
    const real = repository.projects.find((project) => project.kind === 'maven')!;
    expect(repository.selectedProjectId).toBe(real.projectId);
    await host.waitForProjects();
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: repository.repositoryId,
      analysisRevision: repository.activeRevision, projectId: real.projectId }), false);
    const explorer = await host.explorerData();
    expect(explorer.map((item) => item.projectId)).toEqual([real.projectId]);
    expect(await host.selectedProjectForPath(root)).toBe(real.projectId);
  } finally {
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the chosen project of a multi-project target visible after a restart', async () => {
  const root = await twoProjectTarget();
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const identityStore = new MemoryIdentityStore();
  const options = { runtimeFactory: async () => runtime, identityStore,
    planProject: async () => { throw new Error('The test must not invoke a model.'); },
    projectAnalysisPort: analysisPort(async () => {}) };
  const repositories = [{ localPath: root, role: 'target' as const }];
  const first = new CodeIntelligenceHost(options);
  let chosen: string;
  try {
    const repository = (await first.synchronize({ repositories })).presentation.repositories[0]!;
    chosen = repository.projects[1]!.projectId;
    await first.selectProjectForDisplay({ repositoryId: repository.repositoryId,
      analysisRevision: repository.activeRevision!, projectId: chosen });
    await first.waitForProjects();
    expect([...identityStore.values.values()]).toContain(chosen);
  } finally {
    // Closing the window drops every in-memory choice; only UI state survives.
    first.dispose();
  }
  const second = new CodeIntelligenceHost(options);
  try {
    const repository = (await second.synchronize({ repositories })).presentation.repositories[0]!;
    expect(repository.selectedProjectId).toBe(chosen);
    const explorer = await second.explorerData();
    expect(explorer.map((item) => item.projectId)).toEqual([chosen]);
  } finally {
    second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('drops a remembered project that no longer exists in the current revision', async () => {
  const root = await twoProjectTarget();
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const identityStore = new MemoryIdentityStore();
  const options = { runtimeFactory: async () => runtime, identityStore,
    planProject: async () => { throw new Error('The test must not invoke a model.'); },
    projectAnalysisPort: analysisPort(async () => {}) };
  const repositories = [{ localPath: root, role: 'target' as const }];
  const first = new CodeIntelligenceHost(options);
  let repositoryId: string; let analysisRevision: string;
  try {
    const repository = (await first.synchronize({ repositories })).presentation.repositories[0]!;
    repositoryId = repository.repositoryId;
    analysisRevision = repository.activeRevision!;
    await first.selectProjectForDisplay({ repositoryId, analysisRevision,
      projectId: repository.projects[0]!.projectId });
    await first.waitForProjects();
  } finally {
    first.dispose();
  }
  // A stored choice from another checkout revision must not hide the repository.
  identityStore.values.set(`forexplore.code-intelligence.selected-project:${repositoryId}`, 'project-gone');
  const second = new CodeIntelligenceHost(options);
  try {
    const repository = (await second.synchronize({ repositories })).presentation.repositories[0]!;
    expect(repository.projects).toHaveLength(2);
    expect(repository.selectedProjectId).toBeNull();
    expect(await second.explorerData()).toEqual([]);
    expect([...identityStore.values.values()]).not.toContain('project-gone');
    expect(analysisRevision).toBe(repository.activeRevision);
  } finally {
    second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
