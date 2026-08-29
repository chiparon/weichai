import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import type {
  AdaptationResult,
  ClassSnapshot,
  EditorTarget,
  FilePatch,
  ModuleTarget,
  SearchCandidate,
  TranslationAttempt,
  ValidationRecord,
  ValidatorFeedback,
} from '@forexplore/contracts';
import {
  applyHunksStrict,
  canApplyAdaptation,
  evaluateValidationGate,
  type LanguageIntelligencePort,
} from '@forexplore/workflow-core';
import { WorkspaceBackfill } from './backfill';
import { canonicalWorkspacePath } from './diff-apply';
import {
  ModuleMigrationHost,
  ModuleMigrationPreviewProvider,
  moduleMigrationPreviewScheme,
} from './module-migration-host';
import type { ModuleWaveExecutionPort } from './module-wave-execution-host';
import type { ModuleMigrationWaveRecoveryPort } from './module-migration-recovery';
import { TranslationPanel } from './panel';
import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from './protocol/messages';
import { RepositoryHealthCheck } from './repository-health';
import { decorateRepositoryStatuses } from './repository-status';
import { ServiceManager } from './service-manager';
import { loadSettings } from './settings';
import { configureModelApiKey, requireModelApiKey } from './model-credentials';
import {
  buildClassModuleTarget,
  languageFromLanguageId,
} from './target-builder';
import type { RepositoryStatus } from './ui-types';
import { VscodeLanguageIntelligencePort } from './vscode-language-intelligence';

// Keep the transaction implementation bundled by esbuild without making the
// extension's strict typecheck re-check the service's broader source tree.
const GitWaveTransaction = require('@forexplore/adaptation-service/git-wave-transaction').GitWaveTransaction as {
  new (): ModuleMigrationWaveRecoveryPort;
};

// The narrow service entrypoint keeps the trusted wave coordinator available
// to the extension without bundling the HTTP/model service composition.
const ModuleWaveExecutionCoordinator = require('@forexplore/adaptation-service/module-wave-execution').ModuleWaveExecutionCoordinator as {
  new (): ModuleWaveExecutionPort;
};

interface LocalClassTranslationRequest {
  adaptation: {
    target: ModuleTarget;
    candidate: SearchCandidate;
    requirement: string;
    strategy: 'translate';
    decisionNotes: string;
  };
  targetEditor: EditorTarget;
  candidateEditor: EditorTarget;
  targetDocumentSource: string;
}

interface LocalClassTranslationRuntime {
  adapt(request: LocalClassTranslationRequest, signal?: AbortSignal): Promise<AdaptationResult>;
}

const ClassTranslationOrchestrator = require('@forexplore/adaptation-service/class-translation').ClassTranslationOrchestrator as {
  new (options: {
    languageIntelligence: LanguageIntelligencePort;
    apiKey: string;
    analyzerOptions: { modelConfig: { apiBase: string; model: string } };
    translatorOptions: { modelConfig: { apiBase: string; model: string } };
    timeoutMs: number;
    maxAttempts: number;
    onProgress(progress: { attempt: TranslationAttempt; remainingMs: number }): void;
  }): LocalClassTranslationRuntime;
};

const validatorCommand = 'forexplore.validator.validateHandoff';

interface ExtensionHost {
  context: vscode.ExtensionContext;
  services: ServiceManager;
  health: RepositoryHealthCheck;
  languageIntelligence: LanguageIntelligencePort;
}

interface ActiveMigrationRun {
  workspaceFolder: vscode.WorkspaceFolder;
  targetUri: vscode.Uri;
  target: ModuleTarget;
  targetClass: ClassSnapshot;
  targetEditor: EditorTarget;
  /** Exact bytes read before retrieval / adaptation began. */
  originalSha256: string;
  originalContent: string;
  requirement: string;
  candidates: SearchCandidate[];
  /** Null until the user expressly clicks a candidate in this run. */
  selectedCandidateId: string | null;
  adaptation: AdaptationResult | null;
}

interface LastCheckpoint {
  checkpointId: string;
  workspaceUri: string;
  targetPath: string;
}

let activeRun: ActiveMigrationRun | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ForeXplore');
  const services = new ServiceManager(output);
  const health = new RepositoryHealthCheck();
  const languageIntelligence = new VscodeLanguageIntelligencePort();
  const moduleMigrationPreviews = new ModuleMigrationPreviewProvider();
  const moduleMigration = new ModuleMigrationHost({
    context,
    services,
    output,
    previews: moduleMigrationPreviews,
    waveRecovery: new GitWaveTransaction(),
    waveExecution: new ModuleWaveExecutionCoordinator(),
  });

  context.subscriptions.push(
    output,
    services,
    vscode.workspace.registerTextDocumentContentProvider(
      moduleMigrationPreviewScheme,
      moduleMigrationPreviews,
    ),
    vscode.commands.registerCommand('forexplore.startTranslation', () =>
      startTranslation(context, services, health, languageIntelligence),
    ),
    vscode.commands.registerCommand('forexplore.showPanel', () =>
      showPanel(context, services, health, languageIntelligence),
    ),
    vscode.commands.registerCommand('forexplore.checkRepositories', async () => {
      const statuses = await refreshRepositoryStatus(services, health);
      const summary = summarizeRepositoryStatus(statuses);
      void vscode.window.showInformationMessage(
        summary ?? '未配置本地仓库路径；检索范围由当前运行模式决定。',
      );
    }),
    vscode.commands.registerCommand('forexplore.reindex', async () => {
      await services.refresh();
      const repositories = await refreshRepositoryStatus(services, health);
      void vscode.window.showInformationMessage(
        '扩展不会把本地目录误标为已索引。请在检索服务部署环境运行索引器，然后重新检查服务状态。',
      );
      void repositories;
    }),
    vscode.commands.registerCommand('forexplore.configureModelKey', () =>
      configureModelApiKey(context),
    ),
    vscode.commands.registerCommand('forexplore.restoreLastCheckpoint', () =>
      restoreLastCheckpoint(context),
    ),
    vscode.commands.registerCommand('forexplore.indexModuleMigrationRepository', () =>
      moduleMigration.indexRepository(),
    ),
    vscode.commands.registerCommand('forexplore.reviewModuleMigrationPlan', () =>
      moduleMigration.reviewPlan(),
    ),
    vscode.commands.registerCommand('forexplore.reviewModuleMigrationWave', () =>
      moduleMigration.reviewNextWave(),
    ),
    vscode.commands.registerCommand('forexplore.prepareModuleMigrationWave', () =>
      moduleMigration.prepareNextWaveFromLocalBundle(),
    ),
    vscode.commands.registerCommand('forexplore.approveModuleMigrationWave', () =>
      moduleMigration.approveAndCommitPreparedWave(),
    ),
    vscode.commands.registerCommand('forexplore.recoverModuleMigrationReview', () =>
      moduleMigration.recoverReviewState(),
    ),
  );

  // Keep status informative, but never start servers or silently switch modes.
  void services
    .refresh()
    .then(() => refreshRepositoryStatus(services, health))
    .catch((error) => {
      output.appendLine(`[forexplore] preflight failed: ${String(error)}`);
    });
}

export function deactivate(): void {
  activeRun = null;
}

async function startTranslation(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
  languageIntelligence: LanguageIntelligencePort,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('请先打开 Java 或 C# 类，并把光标放在类内。');
    return;
  }

  const document = editor.document;
  if (document.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('仅支持工作区中的本地受支持语言文件。');
    return;
  }
  if (document.isDirty) {
    void vscode.window.showWarningMessage('请先保存目标文件，再开始迁移，以便建立可校验的文件快照。');
    return;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('目标文件必须位于已打开的工作区文件夹中。');
    return;
  }

  const language = languageFromLanguageId(document.languageId);
  if (!language) {
    void vscode.window.showErrorMessage(`当前语言 ${document.languageId} 没有可用的 ForeXplore LSP 映射。`);
    return;
  }
  const targetEditor: EditorTarget = {
    uri: document.uri.toString(),
    language,
    position: {
      line: editor.selection.active.line,
      character: editor.selection.active.character,
    },
    documentVersion: document.version,
  };
  let targetClass: ClassSnapshot;
  try {
    targetClass = await languageIntelligence.resolveContainingClass(targetEditor);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, 'LSP 无法定位光标所在类'));
    return;
  }
  if (targetClass.declarationKind === 'interface') {
    void vscode.window.showWarningMessage('接口仅作为契约上下文；请把光标放在 class 或 record 实现中。');
    return;
  }
  const target = buildClassModuleTarget({
    snapshot: targetClass,
    filePath: document.uri.fsPath,
    workspaceRoot: workspaceFolder.uri.fsPath,
  });
  if (!target) {
    void vscode.window.showErrorMessage(
      `LSP 返回的目标类不在当前工作区内（当前为 ${document.languageId}）。`,
    );
    return;
  }

  const originalBytes = await vscode.workspace.fs.readFile(document.uri);
  activeRun = {
    workspaceFolder,
    targetUri: document.uri,
    target,
    targetClass,
    targetEditor,
    originalSha256: sha256(originalBytes),
    originalContent: Buffer.from(originalBytes).toString('utf8'),
    requirement: '',
    candidates: [],
    selectedCandidateId: null,
    adaptation: null,
  };

  const serviceStatus = await services.refresh();
  const statuses = await refreshRepositoryStatus(services, health);
  const runtime = services.getRuntimePresentation();

  await TranslationPanel.createOrShow(
    context,
    {
      target,
      workspaceRoot: workspaceFolder.uri.fsPath,
      repositoryStatuses: statuses,
      serviceStatus,
      searchProvider: runtime.searchProvider,
      adaptationProvider: runtime.adaptationProvider,
    },
    {
      onMessage: (message) => {
        void handlePanelMessage({ context, services, health, languageIntelligence }, message);
      },
    },
  );
}

async function showPanel(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
  languageIntelligence: LanguageIntelligencePort,
): Promise<void> {
  if (TranslationPanel.current && activeRun) {
    TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await startTranslation(context, services, health, languageIntelligence);
    return;
  }
  void vscode.window.showInformationMessage('请先打开 Java 或 C# 类，并把光标放在类内。');
}

async function handlePanelMessage(
  host: ExtensionHost,
  message: WebviewToHostMessage,
): Promise<void> {
  switch (message.type) {
    case 'READY':
      return;
    case 'START_SEARCH':
      await startSearch(host, message);
      return;
    case 'SELECT_CANDIDATE':
      selectCandidate(message.candidateId);
      return;
    case 'START_ADAPT':
      await startAdaptation(host, message.decisionNotes);
      return;
    case 'APPLY_CURRENT_RUN':
      await applyCurrentRun(host.context);
      return;
    case 'SEND_TO_VALIDATOR':
      await sendToValidator();
      return;
    case 'CHECK_REPOSITORIES':
      await refreshPanelStatus(host);
      return;
    case 'OPEN_TARGET':
      await openTarget();
      return;
  }
}

async function startSearch(
  host: ExtensionHost,
  message: Extract<WebviewToHostMessage, { type: 'START_SEARCH' }>,
): Promise<void> {
  try {
    const run = requireActiveRun();
    await assertTargetUnchanged(run);
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const candidates = (await host.services.getSearchPort().search({
      target: run.target,
      requirement: message.requirement.trim(),
      topK: message.topK,
      // Local paths are presentation-only checks; only the server can state
      // which repositories were indexed. An empty scope means its configured
      // authorized index, not a fake "configured-repositories" filter.
      repositoryScopes: [],
    })).filter((candidate) => candidate.kind === 'class');
    if (candidates.length === 0) {
      throw new Error('检索服务没有返回完整类候选；方法片段不会进入类级翻译。');
    }
    run.requirement = message.requirement.trim();
    run.candidates = candidates;
    run.selectedCandidateId = null;
    run.adaptation = null;
    publish({ type: 'SEARCH_RESULT', candidates: run.candidates });
  } catch (error) {
    publishError(errorMessage(error, '检索失败'));
  }
}

function selectCandidate(candidateId: string): void {
  try {
    const run = requireActiveRun();
    const candidate = run.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new Error('该候选不属于当前检索结果。');
    }
    // This is deliberately the only operation that changes this field. A
    // retrieval ranking never becomes consent by itself.
    run.selectedCandidateId = candidateId;
    run.adaptation = null;
  } catch (error) {
    publishError(errorMessage(error, '候选选择无效'));
  }
}

async function startAdaptation(host: ExtensionHost, decisionNotes: string): Promise<void> {
  try {
    const run = requireActiveRun();
    const candidate = selectedRunCandidate(run);
    await assertTargetUnchanged(run);
    const settings = loadSettings();
    const apiKey = await requireModelApiKey(host.context);
    const candidateEditor = await candidateEditorTarget(candidate, settings.repositoryPaths);
    const modelConfig = { apiBase: settings.modelApiUrl, model: settings.model };
    const orchestrator = new ClassTranslationOrchestrator({
      languageIntelligence: host.languageIntelligence,
      apiKey,
      analyzerOptions: { modelConfig },
      translatorOptions: { modelConfig },
      timeoutMs: settings.translationTimeoutSeconds * 1_000,
      maxAttempts: settings.maxTranslationAttempts,
      onProgress: ({ attempt, remainingMs }) => {
        publish({ type: 'TRANSLATION_ATTEMPT', attempt, remainingMs });
      },
    });
    const rawResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ForeXplore：翻译 ${run.target.name} 并等待 LSP 诊断`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await orchestrator.adapt({
            adaptation: {
              target: run.target,
              candidate,
              requirement: run.requirement,
              strategy: 'translate',
              decisionNotes,
            },
            targetEditor: run.targetEditor,
            candidateEditor,
            targetDocumentSource: run.originalContent,
          }, controller.signal);
        } finally {
          subscription.dispose();
        }
      },
    );
    const result = validateHostOwnedResult(run, rawResult);
    run.adaptation = result;
    publish({ type: 'ADAPT_RESULT', result });
  } catch (error) {
    publishError(errorMessage(error, '翻译失败'));
  }
}

async function candidateEditorTarget(
  candidate: SearchCandidate,
  repositoryPaths: string[],
): Promise<EditorTarget> {
  const languageId = languageIdFor(candidate.language);
  const localUri = await resolveCandidateUri(candidate, repositoryPaths);
  if (localUri) {
    const document = await vscode.workspace.openTextDocument(localUri);
    const sourceLine = candidate.line ?? sourceLineFromCandidateId(candidate.id);
    return {
      uri: localUri.toString(),
      language: candidate.language,
      ...(sourceLine
        ? { position: { line: Math.max(0, sourceLine - 1), character: 0 } }
        : { symbolName: candidate.title }),
      documentVersion: document.version,
    };
  }

  const plain = await vscode.workspace.openTextDocument({ content: candidate.preview });
  const document = await vscode.languages.setTextDocumentLanguage(plain, languageId);
  return {
    uri: document.uri.toString(),
    language: candidate.language,
    documentVersion: document.version,
  };
}

async function resolveCandidateUri(
  candidate: SearchCandidate,
  repositoryPaths: string[],
): Promise<vscode.Uri | null> {
  const repositoryName = candidate.repository.replace(/^fixture\//, '');
  for (const configuredRoot of repositoryPaths) {
    const root = path.resolve(configuredRoot);
    const candidates = [
      path.resolve(root, candidate.path),
      path.resolve(root, repositoryName, candidate.path),
    ];
    for (const filePath of candidates) {
      if (!isInsidePath(root, filePath)) continue;
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        if ((stat.type & vscode.FileType.File) !== 0) return vscode.Uri.file(filePath);
      } catch {
        // Continue to the next authorized local candidate path.
      }
    }
  }
  return null;
}

function sourceLineFromCandidateId(id: string): number | undefined {
  const match = id.match(/:(\d+):[^:]+$/);
  const line = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function languageIdFor(language: SearchCandidate['language']): string {
  const ids: Record<SearchCandidate['language'], string> = {
    TypeScript: 'typescript',
    Python: 'python',
    Java: 'java',
    'C#': 'csharp',
    Rust: 'rust',
    Go: 'go',
  };
  return ids[language];
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function sendToValidator(): Promise<void> {
  try {
    const run = requireActiveRun();
    const adaptation = run.adaptation;
    const handoff = adaptation?.validatorHandoff;
    if (!adaptation || !handoff) {
      throw new Error('当前结果尚未通过 LSP，不能交给 Validator。');
    }
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(validatorCommand)) {
      throw new Error(`未安装提供 ${validatorCommand} 的 Validator 扩展。`);
    }
    const feedback = await vscode.commands.executeCommand<ValidatorFeedback>(validatorCommand, handoff);
    if (!isValidatorFeedback(feedback, handoff.traceId)) {
      throw new Error('Validator 返回了无效或不匹配的结构化反馈。');
    }
    const validatorRecord: ValidationRecord = {
      id: 'validator-integration',
      label: 'Validator integration tests',
      status: feedback.verdict === 'pass' ? 'pass' : feedback.verdict === 'fail' ? 'fail' : 'unverified',
      required: true,
      summary: feedback.verdict === 'pass'
        ? 'Validator reported that behavioral and integration checks passed.'
        : feedback.issues.map((issue) => issue.message).join('; ') || `Validator verdict: ${feedback.verdict}.`,
      failureReason: feedback.verdict === 'pass' ? undefined : `validator-${feedback.verdict}`,
    };
    const validation = deduplicateValidation([
      ...adaptation.validation.filter((record) => record.id !== validatorRecord.id),
      validatorRecord,
      ...feedback.checks,
    ]);
    run.adaptation = {
      ...adaptation,
      validation,
      validatorHandoff: { ...handoff, preValidation: validation },
    };
    publish({ type: 'ADAPT_RESULT', result: run.adaptation });
  } catch (error) {
    publishError(errorMessage(error, 'Validator 交接失败'));
  }
}

function isValidatorFeedback(value: unknown, traceId: string): value is ValidatorFeedback {
  if (!value || typeof value !== 'object') return false;
  const feedback = value as Partial<ValidatorFeedback>;
  return feedback.schemaVersion === '1.0' &&
    feedback.traceId === traceId &&
    (feedback.verdict === 'pass' || feedback.verdict === 'fail' || feedback.verdict === 'blocked') &&
    Array.isArray(feedback.checks) && feedback.checks.every(isValidationRecord) &&
    Array.isArray(feedback.issues) && feedback.issues.every((issue) =>
      Boolean(issue) && typeof issue === 'object' &&
      typeof (issue as { code?: unknown }).code === 'string' &&
      typeof (issue as { message?: unknown }).message === 'string' &&
      ((issue as { severity?: unknown }).severity === 'error' ||
        (issue as { severity?: unknown }).severity === 'warning'));
}

function isValidationRecord(value: unknown): value is ValidationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ValidationRecord>;
  return typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    (record.status === 'pass' || record.status === 'warn' ||
      record.status === 'fail' || record.status === 'unverified') &&
    typeof record.required === 'boolean' &&
    typeof record.summary === 'string';
}

async function applyCurrentRun(context: vscode.ExtensionContext): Promise<void> {
  try {
    const run = requireActiveRun();
    const adaptation = run.adaptation;
    if (!adaptation) throw new Error('尚未生成当前迁移运行的补丁。');
    const gate = evaluateValidationGate(adaptation.validation);
    if (!canApplyAdaptation(adaptation)) {
      const labels = gate.blockers.map((record) => record.label).join('、');
      throw new Error(`必需验证未通过或尚未验证：${labels || '缺少可写回补丁'}。`);
    }
    await assertTargetUnchanged(run);
    const referenceFree = adaptation.validation.some(
      (record) => record.id === 'reference-candidate',
    );
    const confirmation = referenceFree
      ? `Analyzer 已拒绝所选参考实现；当前 ${run.target.language} 代码仅依据目标上下文和需求自主生成。请重点审查后再写入 ${run.target.language} 文件。确认继续？`
      : `将把已预览的补丁写入当前选中的 ${run.target.language} 文件，并创建可恢复检查点。确认继续？`;
    const choice = await vscode.window.showWarningMessage(
      confirmation,
      { modal: true },
      '应用补丁',
    );
    if (choice !== '应用补丁') {
      publishError('已取消应用补丁。');
      return;
    }

    const result = await new WorkspaceBackfill({
      workspaceFolder: run.workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPath: run.target.path,
    }).apply(adaptation.files);
    await context.workspaceState.update('forexplore.lastCheckpoint', {
      checkpointId: result.checkpointId,
      workspaceUri: run.workspaceFolder.uri.toString(),
      targetPath: run.target.path,
    });
    publish({ type: 'APPLY_RESULT', result });
  } catch (error) {
    publishError(errorMessage(error, '回填失败'));
  }
}

async function restoreLastCheckpoint(context: vscode.ExtensionContext): Promise<void> {
  const checkpoint = context.workspaceState.get<LastCheckpoint>('forexplore.lastCheckpoint');
  const run = activeRun;
  if (!checkpoint || !run) {
    void vscode.window.showInformationMessage('没有与当前迁移运行关联的可恢复检查点。');
    return;
  }
  if (
    checkpoint.workspaceUri !== run.workspaceFolder.uri.toString() ||
    checkpoint.targetPath !== run.target.path
  ) {
    void vscode.window.showWarningMessage('恢复点不属于当前选中的迁移目标，已拒绝恢复。');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    '将恢复最近一次 ForeXplore 写入前的文件内容；若文件后来又被编辑，恢复会被拒绝。确认继续？',
    { modal: true },
    '恢复检查点',
  );
  if (choice !== '恢复检查点') return;
  try {
    const result = await new WorkspaceBackfill({
      workspaceFolder: run.workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPath: run.target.path,
    }).restore(checkpoint.checkpointId);
    await context.workspaceState.update('forexplore.lastCheckpoint', undefined);
    void vscode.window.showInformationMessage(`已恢复 ${result.appliedFiles.join('、')}。`);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '恢复失败'));
  }
}

async function refreshPanelStatus(host: ExtensionHost): Promise<void> {
  try {
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const statuses = await refreshRepositoryStatus(host.services, host.health);
    publish({ type: 'REPOSITORY_STATUS', statuses });
  } catch (error) {
    publishError(errorMessage(error, '状态检查失败'));
  }
}

async function openTarget(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.window.showTextDocument(run.targetUri, {
      preview: true,
      selection: new vscode.Range(
        Math.max(0, (run.target.line ?? 1) - 1),
        0,
        Math.max(0, (run.target.line ?? 1) - 1),
        0,
      ),
    });
  } catch (error) {
    publishError(errorMessage(error, '无法打开当前目标文件'));
  }
}

function validateHostOwnedResult(
  run: ActiveMigrationRun,
  result: AdaptationResult,
): AdaptationResult {
  const validation = [...result.validation];
  const failures: string[] = [];
  let files: FilePatch[] = result.files;

  if (result.strategy !== 'translate' || result.targetLanguage !== run.target.language) {
    failures.push('服务返回的策略或目标语言与当前选中的目标不一致。');
  }
  if (result.lspValidation?.status !== 'passed') {
    failures.push(`LSP 类级门禁未通过（${result.lspValidation?.status ?? 'missing'}）。`);
  }
  if (!result.validatorHandoff || result.validatorHandoff.targetClass.uri !== run.targetClass.uri) {
    failures.push('结果缺少与当前 LSP 类快照绑定的 Validator handoff。');
  }
  if (files.length !== 1) {
    failures.push('写回只接受当前目标文件的一个修改补丁。');
  }

  const patch = files[0];
  if (patch) {
    const expectedPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, run.target.path);
    let returnedPath: string | undefined;
    try {
      returnedPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, patch.path);
    } catch {
      failures.push('服务返回的补丁路径不是工作区内的相对路径。');
    }
    if (patch.status !== 'modified' || returnedPath !== expectedPath) {
      failures.push('服务返回的补丁不严格对应当前选中的目标文件。');
    }
    if (patch.status === 'modified') {
      if (patch.expectedOriginalSha256 !== run.originalSha256) {
        failures.push('服务补丁的原始文件哈希与扩展宿主快照不一致。');
      }
      try {
        const next = applyHunksStrict(run.originalContent, patch.hunks);
        if (!changesOnlyClassLines(run.originalContent, next, run.targetClass)) {
          failures.push('补丁修改了 LSP 目标类范围之外的内容。');
        }
      } catch (error) {
        failures.push(
          `补丁不能精确应用到本次目标快照：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  validation.push({
    id: 'extension-target-snapshot',
    label: '扩展目标快照',
    status: failures.length === 0 ? 'pass' : 'fail',
    required: true,
    command: 'VS Code workspace.fs.readFile + SHA-256',
    summary:
      failures.length === 0
        ? '补丁路径、原始哈希和 hunk 均与本次编辑器目标快照一致。'
        : failures.join(' '),
    failureReason: failures.length === 0 ? undefined : 'host-owned-patch-validation-failed',
  });

  if (failures.length > 0) {
    validation.push({
      id: 'extension-patch-scope',
      label: '补丁范围与前置条件',
      status: 'fail',
      required: true,
      summary: failures.join(' '),
      failureReason: 'unsafe-or-stale-patch',
    });
    files = [];
  }

  const finalValidation = deduplicateValidation(validation);
  return {
    ...result,
    validation: finalValidation,
    files,
    validatorHandoff: failures.length === 0 && result.validatorHandoff
      ? { ...result.validatorHandoff, preValidation: finalValidation, files }
      : undefined,
  };
}

function changesOnlyClassLines(
  original: string,
  next: string,
  targetClass: ClassSnapshot,
): boolean {
  const originalLines = original.replace(/\r\n/g, '\n').split('\n');
  const nextNormalized = next.replace(/\r\n/g, '\n');
  const startLine = targetClass.range.start.line;
  const endLine = targetClass.range.end.character === 0
    ? Math.max(startLine, targetClass.range.end.line - 1)
    : targetClass.range.end.line;
  const prefix = originalLines.slice(0, startLine).join('\n');
  const suffix = originalLines.slice(endLine + 1).join('\n');
  const prefixMatches = prefix ? nextNormalized.startsWith(`${prefix}\n`) : true;
  const suffixMatches = suffix ? nextNormalized.endsWith(`\n${suffix}`) : true;
  return prefixMatches && suffixMatches;
}

function deduplicateValidation(records: ValidationRecord[]): ValidationRecord[] {
  const ids = new Set<string>();
  return records.filter((record) => {
    if (ids.has(record.id)) return false;
    ids.add(record.id);
    return true;
  });
}

function requireActiveRun(): ActiveMigrationRun {
  if (!activeRun) throw new Error('请先从已保存的目标方法启动一次迁移。');
  return activeRun;
}

function selectedRunCandidate(run: ActiveMigrationRun): SearchCandidate {
  if (!run.selectedCandidateId) {
    throw new Error('请先明确点击并选择一个候选实现。');
  }
  const candidate = run.candidates.find((item) => item.id === run.selectedCandidateId);
  if (!candidate) {
    throw new Error('当前候选已失效；请重新检索并明确选择。');
  }
  return candidate;
}

async function assertTargetUnchanged(run: ActiveMigrationRun): Promise<void> {
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === run.targetUri.toString(),
  );
  if (openDocument?.isDirty) {
    throw new Error('目标文件有未保存的编辑；请先保存并重新启动迁移以建立新快照。');
  }
  const current = await vscode.workspace.fs.readFile(run.targetUri);
  if (sha256(current) !== run.originalSha256) {
    throw new Error('目标文件已在本次迁移开始后发生变化；请重新启动迁移以生成新快照。');
  }
}

function refreshRepositoryStatus(
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<RepositoryStatus[]> {
  return health
    .checkConfigured()
    .then((statuses) => decorateRepositoryStatuses(statuses, services.serviceStatus));
}

function publish(message: HostToWebviewMessage): void {
  TranslationPanel.current?.post(message);
}

function publishError(message: string): void {
  publish({ type: 'ERROR', message });
}

function summarizeRepositoryStatus(statuses: RepositoryStatus[]): string | null {
  if (statuses.length === 0) return null;
  const unavailable = statuses.filter((status) => !status.exists || !status.readable).length;
  return `本地仓库路径：${statuses.length} 个，${unavailable} 个不可用。索引状态由检索服务确认。`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}
