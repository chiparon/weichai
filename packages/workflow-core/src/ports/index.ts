import type { CodeAdaptationPort } from './code-adaptation.port';
import type { CodeBackfillPort } from './code-backfill.port';
import type { RepositoryArchitecturePort } from './repository-architecture.port';

export type { CodeAdaptationPort } from './code-adaptation.port';
export type { CodeBackfillPort } from './code-backfill.port';
export type { ModuleSymbolPort } from './module-symbol.port';
export type { RepositoryArchitecturePort } from './repository-architecture.port';

export interface WorkflowPorts {
  adaptation: CodeAdaptationPort;
  backfill: CodeBackfillPort;
}

/** Ports for the independent repository/module planning workflow. */
export interface ModuleMigrationPorts {
  architecture: RepositoryArchitecturePort;
}
