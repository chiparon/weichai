import * as vscode from 'vscode';
import { AdaptationHttpAdapter } from '@forexplore/adaptation-http-adapter';
import type { WorkflowPorts } from '@forexplore/workflow-core';
import { checkServiceHealth } from './service-health';
import { localFetch } from './local-fetch';
import { loadSettings } from './settings';
import type { ExecutionMode, ServiceStatus } from './ui-types';
import type { BackendProcess } from './backend-process';

export interface RuntimePorts {
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
  executionMode: ExecutionMode;
}

/**
 * Owns the external adaptation runtime. Candidate retrieval is provided by
 * the extension's local code-intelligence runtime over its versioned SeekDB
 * projection, so it does not depend on the legacy retrieval HTTP service.
 */
export class ServiceManager implements vscode.Disposable {
  private status: ServiceStatus = {
    moduleSearch: 'unconfigured',
    adaptation: 'unconfigured',
    executionMode: 'real',
  };

  constructor(private readonly output: vscode.OutputChannel, private readonly backend?: BackendProcess) {}

  get serviceStatus(): ServiceStatus {
    return { ...this.status };
  }
  setModuleSearchReady(ready: boolean): void {
    this.status = { ...this.status, moduleSearch: ready ? 'connected' : 'error' };
  }

  /** Display-only provider labels that do not create or replace any port. */
  getRuntimePresentation(): RuntimePorts {
    return {
      searchProvider: 'SeekDB',
      adaptationProvider: 'DeepSeek',
      executionMode: 'real',
    };
  }

  async refresh(): Promise<ServiceStatus> {
    const settings = loadSettings();
    const adaptation = await checkServiceHealth(settings.adaptationApiUrl, localFetch);
    this.status = {
      moduleSearch: this.status.moduleSearch,
      adaptation: adaptation.healthy ? 'connected' : 'error',
      executionMode: 'real',
      message: !adaptation.healthy ? `翻译：${adaptation.detail}` : undefined,
    };
    this.output.appendLine(
      `[forexplore] runtime refreshed: moduleSearch=${this.status.moduleSearch}, adaptation=${this.status.adaptation}`,
    );
    return this.serviceStatus;
  }

  async ensureStarted(): Promise<ServiceStatus> {
    try { await this.backend?.ensure(); }
    catch (error) {
      this.status = { ...this.status, adaptation: 'error', message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
    return this.refresh();
  }

  getAdaptationPort(): WorkflowPorts['adaptation'] {
    if (this.status.adaptation !== 'connected') {
      throw new Error(this.status.message ?? '真实适配服务尚未就绪。');
    }
    return new AdaptationHttpAdapter({
      baseUrl: loadSettings().adaptationApiUrl,
      fetch: localFetch,
    });
  }

  dispose(): void {
    this.backend?.dispose();
  }
}
