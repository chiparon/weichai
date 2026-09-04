import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AnalysisRevisionRecord,
  ModuleArtifactRecord,
  RepositoryId,
  RepositoryRecord,
  RepositoryRole,
  RepositoryRevisionScope,
  RepositoryStaticAnalysis,
  StructuralIndex,
} from '@forexplore/contracts';
import type { SemanticQueryPort } from '@forexplore/workflow-core';
import type {
  CodeIntelligencePresentation,
  CodeIntelligenceRepositoryPresentation,
  CodeIntelligenceSummaryPresentation,
} from './ui-types';

/** Local-only SeekDB configuration; credentials never cross a UI boundary. */
export interface SeekDbRuntimeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  vectorDimension?: number;
}

/** The narrow host composition input intentionally excludes scanners/DB handles from callers. */
export interface CreateCodeIntelligenceRuntimeOptions {
  seekdb?: SeekDbRuntimeConfig;
}

export interface CodeIntelligenceEnvironmentOptions {
  /** Production hosts require an explicit SeekDB database; dev/test may opt into transient storage. */
  allowInMemory?: boolean;
}

interface HostIndexStore {
  getRevision(scope: RepositoryRevisionScope): Promise<AnalysisRevisionRecord | null>;
  getStructuralIndex(scope: RepositoryRevisionScope): Promise<StructuralIndex | null>;
  listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]>;
  listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]>;
  putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void>;
}

interface HostRepositoryRegistry {
  get(repositoryId: RepositoryId): Promise<RepositoryRecord | null>;
  register(request: {
    repositoryId: RepositoryId;
    displayName?: string;
    localPath: string;
    role: RepositoryRole;
  }): Promise<RepositoryRecord>;
}

interface HostAnalysisCoordinator {
  run(request: { repositoryId: RepositoryId; mode: 'full' | 'incremental' }): Promise<unknown>;
}

interface HostJavaCsharpSpecializedProvider {
  register(binding: RepositoryRevisionScope & {
    analysisHash: string;
    analysis: RepositoryStaticAnalysis;
  }): Promise<void>;
}

/**
 * Structural typing keeps VS Code's typecheck out of the service source tree.
 * Runtime composition is still the actual code-intelligence service bundle.
 */
export interface CodeIntelligenceRuntime {
  store: HostIndexStore;
  registry: HostRepositoryRegistry;
  coordinator: HostAnalysisCoordinator;
  /** Trusted host bridge for legacy compiler-probe evidence; never expose it to Agent/MCP callers. */
  javaCsharpSpecializedProvider?: HostJavaCsharpSpecializedProvider;
  queryPort: SemanticQueryPort;
  close(): Promise<void>;
}

interface CodeIntelligenceServiceModule {
  createCodeIntelligenceRuntime(
    options: CreateCodeIntelligenceRuntimeOptions,
  ): Promise<CodeIntelligenceRuntime>;
  SeekDbProjection: new (store: HostIndexStore) => {
    projectModuleArtifacts(index: StructuralIndex, signal?: AbortSignal): Promise<void>;
  };
}

let loadedCodeIntelligenceService: CodeIntelligenceServiceModule | undefined;

function codeIntelligenceService(): CodeIntelligenceServiceModule {
  // Keep test/UI typechecking independent from the service's source-level
  // ESM imports. The actual service is loaded only by the trusted host path.
  loadedCodeIntelligenceService ??= require('@forexplore/code-intelligence-service') as CodeIntelligenceServiceModule;
  return loadedCodeIntelligenceService;
}

/**
 * Minimal persistence surface supplied by VS Code's globalState.  IDs are
 * deliberately keyed by a digest of a local path, and no local path ever
 * appears in a presentation returned from this host.
 */
export interface RepositoryIdentityStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: string): PromiseLike<void>;
}

export type CodeIntelligenceRuntimeFactory = (
  options: CreateCodeIntelligenceRuntimeOptions,
) => Promise<CodeIntelligenceRuntime>;

export interface CodeIntelligenceHostOptions {
  /**
   * The VS Code host owns this composition.  It can use SeekDB when its local
   * process environment has been configured, but it is never created by a
   * webview, MCP tool, or Agent request.
   */
  runtimeOptions?: CreateCodeIntelligenceRuntimeOptions;
  runtimeFactory?: CodeIntelligenceRuntimeFactory;
  identityStore?: RepositoryIdentityStore;
  output?: { appendLine(value: string): void };
  storageKind?: 'seekdb' | 'memory';
  now?: () => string;
  /** Test seam; production uses the service-owned SeekDB projection. */
  projectModuleArtifacts?: (
    runtime: CodeIntelligenceRuntime,
    index: StructuralIndex,
  ) => Promise<void>;
}

export interface CodeIntelligenceRepositoryInput {
  localPath: string;
  displayName?: string;
  role: RepositoryRole;
}

export interface SynchronizeCodeIntelligenceRequest {
  repositories: readonly CodeIntelligenceRepositoryInput[];
  /** Full is useful for an explicit user refresh; ordinary refreshes reuse unchanged files. */
  forceFull?: boolean;
  /** Registration-only requests are useful for a lightweight status refresh. */
  scan?: boolean;
}

export interface CodeIntelligenceSynchronizationResult {
  presentation: CodeIntelligencePresentation;
  scannedRepositoryIds: RepositoryId[];
  failedRepositoryIds: RepositoryId[];
}

/**
 * Webview-facing revision intent. The host resolves both opaque IDs against
 * its own registry/store; it never accepts a local path or changes the
 * repository's active revision in response to this request.
 */
export interface SelectCodeIntelligenceRevisionRequest extends RepositoryRevisionScope {}

export interface PublishModuleSummaryRequest extends RepositoryRevisionScope {
  analysisHash: string;
  planHash: string;
  /** Already host-validated summary/plan data. It is never accepted from a Webview. */
  payload: unknown;
  contentHash?: string;
}

/**
 * Local-path input for the trusted host bridge only.  The result deliberately
 * contains revision identifiers but never echoes the root back to a caller.
 */
export interface BindJavaCsharpCompilerProbeEvidenceRequest {
  localPath: string;
  analysis: RepositoryStaticAnalysis;
}

export interface JavaCsharpCompilerProbeBindingResult {
  status: 'bound' | 'skipped';
  repositoryId?: RepositoryId;
  analysisRevision?: string;
}

const identityKeyPrefix = 'forexplore.code-intelligence.repository-id';

function defaultRuntimeFactory(
  options: CreateCodeIntelligenceRuntimeOptions,
): Promise<CodeIntelligenceRuntime> {
  return codeIntelligenceService().createCodeIntelligenceRuntime(options);
}

function stableIdentityKey(localPath: string): string {
  const normalized = process.platform === 'win32'
    ? path.resolve(localPath).toLowerCase()
    : path.resolve(localPath);
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `${identityKeyPrefix}:${digest}`;
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function genericRuntimeFailure(): string {
  return '代码智能索引运行时不可用；请检查本机索引配置和输出日志。';
}

function memoryStorageNotice(): string {
  return '代码智能索引正在使用非持久的内存开发存储；配置 CODE_INTELLIGENCE_SEEKDB_DATABASE 以启用 SeekDB。';
}

function repositoryInputKey(input: CodeIntelligenceRepositoryInput): string {
  const normalized = path.resolve(input.localPath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** A presentation name is a label, never a second local-path channel. */
function safeRepositoryDisplayName(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  const leaf = normalized.split('/').filter(Boolean).at(-1)?.trim();
  if (!leaf || leaf === '.' || leaf === '..') return 'repository';
  return leaf.slice(0, 160);
}

function preferredRepositoryInputs(
  inputs: readonly CodeIntelligenceRepositoryInput[],
): CodeIntelligenceRepositoryInput[] {
  const byPath = new Map<string, CodeIntelligenceRepositoryInput>();
  for (const input of inputs) {
    if (!input.localPath.trim()) continue;
    const key = repositoryInputKey(input);
    const current = byPath.get(key);
    // A workspace target has a stronger role than the same root configured as
    // a historical corpus.  This makes both paths use one registry record.
    if (!current || input.role === 'target') byPath.set(key, input);
  }
  return [...byPath.values()].sort((left, right) =>
    repositoryInputKey(left).localeCompare(repositoryInputKey(right)),
  );
}

function summaryArtifact(
  artifacts: readonly ModuleArtifactRecord[],
  revision: AnalysisRevisionRecord,
): ModuleArtifactRecord | undefined {
  return artifacts
    .filter((artifact) => (
      artifact.kind === 'module-summary' &&
      artifact.status === 'current' &&
      artifact.analysisHash === revision.analysisHash &&
      Boolean(artifact.planHash)
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function latestSummaryArtifact(
  artifacts: readonly ModuleArtifactRecord[],
  revision: AnalysisRevisionRecord,
): ModuleArtifactRecord | undefined {
  return artifacts
    .filter((artifact) => (
      artifact.kind === 'module-summary' &&
      artifact.analysisHash === revision.analysisHash &&
      Boolean(artifact.planHash)
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function isReadOnlyQueryableRevision(
  revision: AnalysisRevisionRecord,
): revision is AnalysisRevisionRecord & { status: 'ready' | 'superseded' } {
  return revision.status === 'ready' || revision.status === 'superseded';
}

function isBoundedOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isJavaCsharpLegacyFile(file: RepositoryStaticAnalysis['files'][number]): boolean {
  return file.language === 'Java' || file.language === 'C#';
}

/**
 * A compiler-probe snapshot is only safe to attach when its Java/C# source
 * bytes exactly match the active structural revision.  Other languages are
 * intentionally outside this compatibility provider's evidence domain.
 */
function compilerProbeFilesMatchStructuralIndex(
  analysis: RepositoryStaticAnalysis,
  index: StructuralIndex,
): boolean {
  const legacyFiles = analysis.files.filter(isJavaCsharpLegacyFile);
  const structuralFiles = index.files.filter((file) =>
    file.languageId === 'java' || file.languageId === 'csharp',
  );
  if (legacyFiles.length === 0 || legacyFiles.length !== structuralFiles.length) return false;
  const structuralByPath = new Map(structuralFiles.map((file) => [file.relativePath, file.sha256]));
  return legacyFiles.every((file) => structuralByPath.get(file.path) === file.sha256);
}

/**
 * Trusted VS Code composition for the shared repository chain.  The host is
 * allowed to hold local paths and invoke Registry/Coordinator; consumers get
 * only `SemanticQueryPort` or the path-free presentation above.
 */
export class CodeIntelligenceHost {
  readonly #runtimeFactory: CodeIntelligenceRuntimeFactory;
  readonly #runtimeOptions: CreateCodeIntelligenceRuntimeOptions;
  readonly #identityStore?: RepositoryIdentityStore;
  readonly #output?: { appendLine(value: string): void };
  readonly #storageKind: 'seekdb' | 'memory';
  readonly #now: () => string;
  readonly #projectModuleArtifacts: (runtime: CodeIntelligenceRuntime, index: StructuralIndex) => Promise<void>;
  #runtimePromise: Promise<CodeIntelligenceRuntime> | undefined;
  #synchronizing: Promise<CodeIntelligenceSynchronizationResult> | undefined;
  #ephemeralRepositoryIds = new Map<string, RepositoryId>();
  /** Per-panel-host display choice only; never persisted as repository state. */
  #selectedRevisions = new Map<RepositoryId, string>();
  #lastFailure = false;
  #disposed = false;

  constructor(options: CodeIntelligenceHostOptions = {}) {
    this.#runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;
    this.#runtimeOptions = options.runtimeOptions ?? {};
    this.#identityStore = options.identityStore;
    this.#output = options.output;
    this.#storageKind = options.storageKind ?? (options.runtimeOptions?.seekdb ? 'seekdb' : 'memory');
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#projectModuleArtifacts = options.projectModuleArtifacts ?? (async (runtime, index) => {
      await new (codeIntelligenceService().SeekDbProjection)(runtime.store).projectModuleArtifacts(index);
    });
  }

  /** Safe read-only data boundary suitable for a ToolCallingArchitectRuntime. */
  async semanticQueryPort(): Promise<SemanticQueryPort> {
    return (await this.runtime()).queryPort;
  }

  async synchronize(
    request: SynchronizeCodeIntelligenceRequest,
  ): Promise<CodeIntelligenceSynchronizationResult> {
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    if (this.#synchronizing) return this.#synchronizing;
    const operation = this.synchronizeInternal(request).finally(() => {
      if (this.#synchronizing === operation) this.#synchronizing = undefined;
    });
    this.#synchronizing = operation;
    return operation;
  }

  /** Read the safe UI model without handing the Webview a registry or store. */
  async presentation(): Promise<CodeIntelligencePresentation> {
    if (this.#disposed) {
      return this.emptyPresentation('error', genericRuntimeFailure());
    }
    if (!this.#runtimePromise) return this.emptyPresentation('initializing');
    try {
      const runtime = await this.runtime();
      return await this.presentationFor(runtime);
    } catch (error) {
      this.logFailure('read code intelligence status', error);
      return this.emptyPresentation('error', genericRuntimeFailure());
    }
  }

  /**
   * Select an already-indexed revision for read-only presentation/query work.
   * This only changes an in-memory display choice and deliberately never calls
   * the registry's activation APIs or the analysis coordinator.
   */
  async selectRevisionForDisplay(
    request: SelectCodeIntelligenceRevisionRequest,
  ): Promise<CodeIntelligencePresentation> {
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    if (!isBoundedOpaqueIdentifier(request.repositoryId) || !isBoundedOpaqueIdentifier(request.analysisRevision)) {
      throw new Error('A revision selection requires bounded repository and revision identifiers.');
    }
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(request.repositoryId);
    if (!repository) throw new Error('The selected repository is not registered in this host.');
    const [revision, index] = await Promise.all([
      runtime.store.getRevision(request),
      runtime.store.getStructuralIndex(request),
    ]);
    if (
      !revision ||
      !index ||
      !isReadOnlyQueryableRevision(revision) ||
      index.analysisHash !== revision.analysisHash
    ) {
      throw new Error('The selected analysis revision is not available for read-only queries.');
    }
    // Verify the public query boundary accepts this exact immutable scope
    // before exposing it as selected. This remains a read-only operation.
    await runtime.queryPort.getRepositoryOverview(request);
    this.#selectedRevisions.set(request.repositoryId, request.analysisRevision);
    return this.presentationFor(runtime);
  }

  /**
   * Host-only summary publication for the tool-calling planning flow.  Legacy
   * RepositoryStaticAnalysis summaries are intentionally not coerced into a
   * new revision: their analysis hash is a different evidence domain.
   */
  async publishModuleSummary(request: PublishModuleSummaryRequest): Promise<void> {
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(request.repositoryId);
    if (!repository || repository.activeRevision !== request.analysisRevision) {
      throw new Error('A module summary may only be published for the active repository revision.');
    }
    const revision = await runtime.store.getRevision(request);
    const index = await runtime.store.getStructuralIndex(request);
    if (!revision || !index || revision.analysisHash !== request.analysisHash) {
      throw new Error('Module summary analysisHash does not match the indexed analysis revision.');
    }
    if (!request.planHash.trim()) throw new Error('Module summary planHash is required.');

    const now = this.#now();
    await runtime.store.putModuleArtifact({
      ...request,
      moduleArtifactId: `module-summary:${randomUUID()}`,
      kind: 'module-summary',
      status: 'current',
      contentHash: request.contentHash ?? contentHash(request.payload),
      createdAt: now,
      updatedAt: now,
    });
    // Rebuild only this revision's non-authoritative search projection.  The
    // projection class owns SeekDB writes and has no global clear operation.
    await this.#projectModuleArtifacts(runtime, index);
  }

  /**
   * Bind an already host-verified Java/C# compiler-probe snapshot to the
   * active structural revision.  This is intentionally a host-only hook: no
   * Agent, Webview, or MCP caller can supply a root or access the provider.
   *
   * The caller must have registered/scanned the root first.  A mismatch or a
   * missing Java/C# semantic bridge is non-fatal to the legacy workflow and
   * returns `skipped` without changing the active revision.
   */
  async bindJavaCsharpCompilerProbeEvidence(
    request: BindJavaCsharpCompilerProbeEvidenceRequest,
  ): Promise<JavaCsharpCompilerProbeBindingResult> {
    if (this.#disposed || !request.localPath.trim()) return { status: 'skipped' };
    try {
      const runtime = await this.runtime();
      const repositoryId = await this.existingRepositoryIdFor(request.localPath);
      if (!repositoryId) return { status: 'skipped' };
      const repository = await runtime.registry.get(repositoryId);
      const analysisRevision = repository?.activeRevision;
      if (!repository || !analysisRevision || !runtime.javaCsharpSpecializedProvider) {
        return { status: 'skipped', repositoryId };
      }
      const scope = { repositoryId, analysisRevision };
      const revision = await runtime.store.getRevision(scope);
      const index = await runtime.store.getStructuralIndex(scope);
      if (
        !revision ||
        revision.status !== 'ready' ||
        !index ||
        index.analysisHash !== revision.analysisHash ||
        !compilerProbeFilesMatchStructuralIndex(request.analysis, index)
      ) {
        return { status: 'skipped', repositoryId, analysisRevision };
      }
      await runtime.javaCsharpSpecializedProvider.register({
        ...scope,
        analysisHash: revision.analysisHash,
        analysis: request.analysis,
      });
      return { status: 'bound', repositoryId, analysisRevision };
    } catch (error) {
      this.logFailure('bind Java/C# compiler-probe evidence', error);
      return { status: 'skipped' };
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#selectedRevisions.clear();
    const pending = this.#runtimePromise;
    this.#runtimePromise = undefined;
    if (pending) {
      void pending.then((runtime) => runtime.close()).catch(() => undefined);
    }
  }

  private async synchronizeInternal(
    request: SynchronizeCodeIntelligenceRequest,
  ): Promise<CodeIntelligenceSynchronizationResult> {
    this.#output?.appendLine('[forexplore] code intelligence synchronization started.');
    let runtime: CodeIntelligenceRuntime;
    try {
      runtime = await this.runtime();
    } catch (error) {
      this.logFailure('start code intelligence runtime', error);
      return {
        presentation: this.emptyPresentation('error', genericRuntimeFailure()),
        scannedRepositoryIds: [],
        failedRepositoryIds: [],
      };
    }

    const registered = new Map<RepositoryId, { repositoryId: RepositoryId; activeRevision: string | null }>();
    const failedRepositoryIds: RepositoryId[] = [];
    let registrationFailed = false;
    for (const input of preferredRepositoryInputs(request.repositories)) {
      try {
        const repositoryId = await this.repositoryIdFor(input.localPath);
        const repository = await runtime.registry.register({
          repositoryId,
          localPath: input.localPath,
          role: input.role,
          ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
        });
        registered.set(repository.repositoryId, repository);
      } catch (error) {
        // The only identifier available to UI clients is a registered ID, so
        // an unregistered local-path error stays in the trusted host log.
        this.logFailure('register code intelligence repository', error);
        registrationFailed = true;
      }
    }

    const scannedRepositoryIds: RepositoryId[] = [];
    if (request.scan !== false) {
      for (const repository of registered.values()) {
        try {
          await runtime.coordinator.run({
            repositoryId: repository.repositoryId,
            mode: request.forceFull || !repository.activeRevision ? 'full' : 'incremental',
          });
          scannedRepositoryIds.push(repository.repositoryId);
        } catch (error) {
          failedRepositoryIds.push(repository.repositoryId);
          this.logFailure(`index repository ${repository.repositoryId}`, error);
        }
      }
    }

    this.#lastFailure = registrationFailed || failedRepositoryIds.length > 0;
    let presentation: CodeIntelligencePresentation;
    try {
      presentation = await this.presentationFor(runtime);
    } catch (error) {
      this.#lastFailure = true;
      this.logFailure('read synchronized code intelligence status', error);
      presentation = this.emptyPresentation('error', genericRuntimeFailure());
    }
    this.#output?.appendLine(
      `[forexplore] code intelligence synchronization complete: ${scannedRepositoryIds.length} scanned, ${failedRepositoryIds.length} failed.`,
    );
    return { presentation, scannedRepositoryIds, failedRepositoryIds };
  }

  private async runtime(): Promise<CodeIntelligenceRuntime> {
    if (!this.#runtimePromise) {
      this.#runtimePromise = this.#runtimeFactory(this.#runtimeOptions);
    }
    return this.#runtimePromise;
  }

  private async repositoryIdFor(localPath: string): Promise<RepositoryId> {
    const key = stableIdentityKey(localPath);
    const stored = this.#identityStore?.get<RepositoryId>(key) ?? this.#ephemeralRepositoryIds.get(key);
    if (stored) return stored;
    const generated = `repo-${randomUUID()}`;
    this.#ephemeralRepositoryIds.set(key, generated);
    await this.#identityStore?.update(key, generated);
    return generated;
  }

  private async existingRepositoryIdFor(localPath: string): Promise<RepositoryId | null> {
    const key = stableIdentityKey(localPath);
    return this.#identityStore?.get<RepositoryId>(key) ?? this.#ephemeralRepositoryIds.get(key) ?? null;
  }

  private async presentationFor(runtime: CodeIntelligenceRuntime): Promise<CodeIntelligencePresentation> {
    const listed = await runtime.queryPort.listRepositories();
    const repositories = await Promise.all(listed.repositories.map(async (repository) => {
      const activeRevision = repository.analysisRevision;
      const availableRevisions = await this.revisionPresentations(
        runtime,
        repository.repositoryId,
        activeRevision,
      );
      const selectedRevision = this.selectedRevisionForDisplay(
        repository.repositoryId,
        activeRevision,
        availableRevisions,
      );
      const revisions = availableRevisions.map((revision) => ({
        ...revision,
        isSelected: revision.analysisRevision === selectedRevision?.analysisRevision,
      }));
      if (!selectedRevision) {
        return {
          repositoryId: repository.repositoryId,
          displayName: safeRepositoryDisplayName(repository.displayName),
          role: repository.role,
          analysisStatus: repository.analysisStatus,
          activeRevision,
          selectedRevision: null,
          revisions,
          languages: [],
          summary: { status: 'missing' },
        } satisfies CodeIntelligenceRepositoryPresentation;
      }
      const scope = {
        repositoryId: repository.repositoryId,
        analysisRevision: selectedRevision.analysisRevision,
      };
      const overview = await runtime.queryPort.getRepositoryOverview(scope);
      return {
        repositoryId: repository.repositoryId,
        displayName: safeRepositoryDisplayName(repository.displayName),
        role: repository.role,
        analysisStatus: repository.analysisStatus,
        activeRevision,
        selectedRevision: selectedRevision.analysisRevision,
        revisions,
        languages: overview.overview.value.languages.map((language) => ({ ...language })),
        summary: await this.summaryPresentation(
          runtime,
          scope,
          activeRevision
            ? { repositoryId: repository.repositoryId, analysisRevision: activeRevision }
            : null,
        ),
      } satisfies CodeIntelligenceRepositoryPresentation;
    }));
    const message = this.#lastFailure
      ? '部分仓库索引失败；请检查扩展输出日志。'
      : this.#storageKind === 'memory'
        ? memoryStorageNotice()
        : undefined;
    return {
      status: this.#lastFailure ? 'error' : 'ready',
      storage: this.#storageKind,
      repositories: repositories.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
      ...(message ? { message } : {}),
    };
  }

  private async revisionPresentations(
    runtime: CodeIntelligenceRuntime,
    repositoryId: RepositoryId,
    activeRevision: string | null,
  ): Promise<CodeIntelligenceRepositoryPresentation['revisions']> {
    const records = await runtime.store.listRevisions(repositoryId);
    const candidates = await Promise.all(records.map(async (revision) => {
      if (!isReadOnlyQueryableRevision(revision)) return null;
      const index = await runtime.store.getStructuralIndex(revision);
      if (!index || index.analysisHash !== revision.analysisHash) return null;
      return {
        analysisRevision: revision.analysisRevision,
        analysisHash: revision.analysisHash,
        status: revision.status,
        createdAt: revision.createdAt,
        ...(revision.completedAt ? { completedAt: revision.completedAt } : {}),
        isActive: revision.analysisRevision === activeRevision,
        isSelected: false,
      } satisfies CodeIntelligenceRepositoryPresentation['revisions'][number];
    }));
    return candidates
      .filter((revision): revision is NonNullable<typeof revision> => revision !== null)
      .sort((left, right) => (
        Number(right.isActive) - Number(left.isActive) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.analysisRevision.localeCompare(right.analysisRevision)
      ));
  }

  private selectedRevisionForDisplay(
    repositoryId: RepositoryId,
    activeRevision: string | null,
    revisions: CodeIntelligenceRepositoryPresentation['revisions'],
  ): CodeIntelligenceRepositoryPresentation['revisions'][number] | null {
    const requested = this.#selectedRevisions.get(repositoryId);
    const selected = requested
      ? revisions.find((revision) => revision.analysisRevision === requested)
      : undefined;
    if (requested && !selected) this.#selectedRevisions.delete(repositoryId);
    return selected ?? revisions.find((revision) => revision.analysisRevision === activeRevision) ?? null;
  }

  private async summaryPresentation(
    runtime: CodeIntelligenceRuntime,
    displayedScope: RepositoryRevisionScope,
    activeScope: RepositoryRevisionScope | null,
  ): Promise<CodeIntelligenceSummaryPresentation> {
    const displayedRevision = await runtime.store.getRevision(displayedScope);
    if (!displayedRevision) return { status: 'missing' };
    const displayedArtifacts = await runtime.store.listModuleArtifacts(displayedScope);

    // Historical revision selection is a view/query concern only. Its summary
    // cannot be presented as current when a different active revision exists.
    if (!activeScope || activeScope.analysisRevision !== displayedScope.analysisRevision) {
      const historical = latestSummaryArtifact(displayedArtifacts, displayedRevision);
      if (!historical) return { status: 'missing' };
      return {
        status: 'stale',
        analysisRevision: displayedScope.analysisRevision,
        analysisHash: historical.analysisHash,
        planHash: historical.planHash,
        updatedAt: historical.updatedAt,
      };
    }

    const current = summaryArtifact(displayedArtifacts, displayedRevision);
    if (current) {
      return {
        status: 'current',
        analysisRevision: displayedScope.analysisRevision,
        analysisHash: current.analysisHash,
        planHash: current.planHash,
        updatedAt: current.updatedAt,
      };
    }

    const revisions = await runtime.store.listRevisions(displayedScope.repositoryId);
    for (const revision of revisions) {
      if (revision.analysisRevision === displayedScope.analysisRevision) continue;
      const artifacts = await runtime.store.listModuleArtifacts(revision);
      const stale = latestSummaryArtifact(artifacts, revision);
      if (stale) {
        return {
          status: 'stale',
          analysisRevision: revision.analysisRevision,
          analysisHash: stale.analysisHash,
          planHash: stale.planHash,
          updatedAt: stale.updatedAt,
        };
      }
    }
    return { status: 'missing' };
  }

  private emptyPresentation(
    status: Extract<CodeIntelligencePresentation['status'], 'initializing' | 'error'>,
    message?: string,
  ): CodeIntelligencePresentation {
    return {
      status,
      storage: this.#storageKind,
      repositories: [],
      ...(message ? { message } : {}),
    };
  }

  private logFailure(action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#output?.appendLine(`[forexplore] ${action}: ${detail}`);
  }
}

/**
 * SeekDB credentials stay in the local extension process environment.  Empty
 * configuration intentionally selects the in-memory development store rather
 * than guessing credentials or turning a Webview setting into a DB capability.
 */
export function codeIntelligenceRuntimeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: CodeIntelligenceEnvironmentOptions = {},
): CreateCodeIntelligenceRuntimeOptions {
  const database = environment.CODE_INTELLIGENCE_SEEKDB_DATABASE?.trim();
  if (!database) {
    if (options.allowInMemory === false) {
      throw new Error(
        'CODE_INTELLIGENCE_SEEKDB_DATABASE must be configured for a production code-intelligence host.',
      );
    }
    return {};
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_DATABASE must be a SQL identifier.');
  }
  const portValue = environment.CODE_INTELLIGENCE_SEEKDB_PORT?.trim();
  const port = portValue === undefined || portValue === '' ? 2881 : Number(portValue);
  const vectorDimensionValue = environment.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION?.trim();
  const vectorDimension = vectorDimensionValue === undefined || vectorDimensionValue === ''
    ? 384
    : Number(vectorDimensionValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_PORT must be a valid TCP port.');
  }
  if (!Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION must be a positive integer.');
  }
  return {
    seekdb: {
      host: environment.CODE_INTELLIGENCE_SEEKDB_HOST?.trim() || '127.0.0.1',
      port,
      user: environment.CODE_INTELLIGENCE_SEEKDB_USER?.trim() || 'root',
      password: environment.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '',
      database,
      vectorDimension,
    },
  };
}

export const codeIntelligenceHostInternals = {
  compilerProbeFilesMatchStructuralIndex,
  contentHash,
  isJavaCsharpLegacyFile,
  memoryStorageNotice,
  preferredRepositoryInputs,
  repositoryInputKey,
  safeRepositoryDisplayName,
  stableIdentityKey,
  summaryArtifact,
};
