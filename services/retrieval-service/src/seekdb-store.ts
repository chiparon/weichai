import mysql, {
  type Pool,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { RetrievalConfig } from './config.js';
import type {
  IndexedCodeDocument,
  IndexedModuleDocument,
  ModuleSearchFilters,
  ModuleSearchStore,
  RetrievedCodeDocument,
  RetrievedModuleDocument,
  SearchFilters,
  SearchStore,
} from './types.js';
import { expandedSearchText } from './text-analysis.js';
import { requireRepositoryScopes } from './repository-scope.js';

interface CodeSymbolRow extends RowDataPacket {
  id: string | Buffer;
  title: string;
  repository: string;
  license: string;
  language: IndexedCodeDocument['language'];
  kind: IndexedCodeDocument['kind'];
  path: string;
  signature: string;
  summary: string;
  preview: string;
  dependencies: string | string[];
  compatibility: string | string[];
  risks: string | string[];
  semantic_score?: number | string;
  text_score?: number | string;
}

interface CodeModuleRow extends RowDataPacket {
  id: string | Buffer;
  repository: string;
  module_id: string;
  name: string;
  module_kind: IndexedModuleDocument['kind'];
  language: IndexedModuleDocument['language'];
  license: string;
  purpose: string;
  domain: string;
  core_apis: string | string[];
  source_files: string | string[];
  symbol_ids: string | string[];
  dependencies: string | string[];
  structure_terms: string | string[];
  representative_symbols: string | IndexedModuleDocument['representativeSymbols'];
  compatibility: string | string[];
  risks: string | string[];
  snapshot_id: string;
  content_hash: string;
  semantic_score?: number | string;
  text_score?: number | string;
  structural_score?: number | string;
}

function quoteIdentifier(value: string): string {
  return `\`${value}\``;
}

function vectorHex(vector: number[]): string {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return `X'${buffer.toString('hex')}'`;
}

function parseStringArray(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function number(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapRow(row: CodeSymbolRow): RetrievedCodeDocument {
  return {
    id: Buffer.isBuffer(row.id) ? row.id.toString('utf8') : String(row.id),
    title: row.title,
    repository: row.repository,
    license: row.license,
    language: row.language,
    kind: row.kind,
    path: row.path,
    signature: row.signature,
    summary: row.summary,
    preview: row.preview,
    dependencies: parseStringArray(row.dependencies),
    compatibility: parseStringArray(row.compatibility),
    risks: parseStringArray(row.risks),
    semanticScore: number(row.semantic_score),
    textScore: number(row.text_score),
  };
}

function parseEvidence(
  value: CodeModuleRow['representative_symbols'],
): IndexedModuleDocument['representativeSymbols'] {
  if (Array.isArray(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === 'object' && item !== null) as IndexedModuleDocument['representativeSymbols']
      : [];
  } catch {
    return [];
  }
}

function mapModuleRow(row: CodeModuleRow): RetrievedModuleDocument {
  return {
    id: Buffer.isBuffer(row.id) ? row.id.toString('utf8') : String(row.id),
    repository: row.repository,
    moduleId: row.module_id,
    name: row.name,
    kind: row.module_kind,
    language: row.language,
    license: row.license,
    purpose: row.purpose,
    domain: row.domain,
    coreApis: parseStringArray(row.core_apis),
    sourceFiles: parseStringArray(row.source_files),
    symbolIds: parseStringArray(row.symbol_ids),
    dependencies: parseStringArray(row.dependencies),
    structureTerms: parseStringArray(row.structure_terms),
    representativeSymbols: parseEvidence(row.representative_symbols),
    compatibility: parseStringArray(row.compatibility),
    risks: parseStringArray(row.risks),
    snapshotId: row.snapshot_id,
    contentHash: row.content_hash,
    semanticScore: number(row.semantic_score),
    textScore: number(row.text_score),
    structuralScore: number(row.structural_score),
  };
}

function filterSql(filters: SearchFilters): { sql: string; parameters: string[] } {
  const clauses: string[] = [];
  const parameters: string[] = [];
  const repositories = requireRepositoryScopes(filters.repositories);
  clauses.push(`repository IN (${repositories.map(() => '?').join(', ')})`);
  parameters.push(...repositories);
  if (filters.languages.length > 0) {
    clauses.push(`language IN (${filters.languages.map(() => '?').join(', ')})`);
    parameters.push(...filters.languages);
  }
  if (filters.kinds.length > 0) {
    clauses.push(`kind IN (${filters.kinds.map(() => '?').join(', ')})`);
    parameters.push(...filters.kinds);
  }
  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    parameters,
  };
}

function moduleFilterSql(filters: ModuleSearchFilters): { sql: string; parameters: string[] } {
  const clauses: string[] = [];
  const parameters: string[] = [];
  const repositories = requireRepositoryScopes(filters.repositories);
  clauses.push(`repository IN (${repositories.map(() => '?').join(', ')})`);
  parameters.push(...repositories);
  if (filters.languages.length > 0) {
    clauses.push(`language IN (${filters.languages.map(() => '?').join(', ')})`);
    parameters.push(...filters.languages);
  }
  if (filters.excludeRepositories.length > 0) {
    clauses.push(`repository NOT IN (${filters.excludeRepositories.map(() => '?').join(', ')})`);
    parameters.push(...filters.excludeRepositories);
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, parameters };
}

const selectedColumns = `
  id, title, repository, license, language, kind, path, signature,
  summary, preview, dependencies, compatibility, risks
`;


const selectedModuleColumns = `
  id, repository, module_id, name, module_kind, language, license, purpose, domain,
  core_apis, source_files, symbol_ids, dependencies, structure_terms,
  representative_symbols, compatibility, risks, snapshot_id, content_hash
`;

export class SeekDbStore implements SearchStore, ModuleSearchStore {
  private readonly pool: Pool;
  private readonly qualifiedTable: string;
  private readonly qualifiedModuleTable: string;
  private readonly database: string;
  private readonly table: string;
  private readonly dimension: number;

  constructor(config: RetrievalConfig['seekdb'], pool?: Pool) {
    this.database = config.database;
    this.table = config.table;
    this.dimension = config.vectorDimension;
    this.qualifiedTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(config.table)}`;
    this.qualifiedModuleTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(`${config.table}_modules`)}`;
    const options: PoolOptions = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      connectionLimit: 8,
      enableKeepAlive: true,
      decimalNumbers: true,
    };
    this.pool = pool ?? mysql.createPool(options);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async initialize(): Promise<void> {
    await this.pool.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(this.database)}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (
        id VARBINARY(512) PRIMARY KEY NOT NULL,
        title VARCHAR(512) NOT NULL,
        repository VARCHAR(512) NOT NULL,
        license VARCHAR(128) NOT NULL,
        language VARCHAR(64) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        path VARCHAR(1024) NOT NULL,
        signature TEXT NOT NULL,
        summary TEXT NOT NULL,
        preview TEXT NOT NULL,
        dependencies JSON NOT NULL,
        compatibility JSON NOT NULL,
        risks JSON NOT NULL,
        search_text STRING NOT NULL,
        embedding VECTOR(${this.dimension}) NOT NULL,
        FULLTEXT INDEX idx_code_text(search_text) WITH PARSER ik,
        VECTOR INDEX idx_code_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qualifiedModuleTable} (
        id VARBINARY(512) PRIMARY KEY NOT NULL,
        repository VARCHAR(512) NOT NULL,
        module_id VARCHAR(256) NOT NULL,
        name VARCHAR(512) NOT NULL,
        module_kind VARCHAR(64) NOT NULL,
        language VARCHAR(64) NOT NULL,
        license VARCHAR(128) NOT NULL,
        purpose TEXT NOT NULL,
        domain TEXT NOT NULL,
        core_apis JSON NOT NULL,
        source_files JSON NOT NULL,
        symbol_ids JSON NOT NULL,
        dependencies JSON NOT NULL,
        structure_terms JSON NOT NULL,
        representative_symbols JSON NOT NULL,
        compatibility JSON NOT NULL,
        risks JSON NOT NULL,
        snapshot_id VARCHAR(128) NOT NULL,
        content_hash VARCHAR(128) NOT NULL,
        search_text STRING NOT NULL,
        structure_text STRING NOT NULL,
        embedding VECTOR(${this.dimension}) NOT NULL,
        FULLTEXT INDEX idx_module_text(search_text) WITH PARSER ik,
        FULLTEXT INDEX idx_module_structure(structure_text) WITH PARSER ik,
        VECTOR INDEX idx_module_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
      ) ORGANIZATION = HEAP
    `);
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.qualifiedTable}`);
  }

  async clearModules(repositories?: string[]): Promise<void> {
    if (repositories === undefined) {
      await this.pool.query(`DELETE FROM ${this.qualifiedModuleTable}`);
      return;
    }
    const authorized = requireRepositoryScopes(repositories);
    await this.pool.query(
      `DELETE FROM ${this.qualifiedModuleTable} WHERE repository IN (${authorized.map(() => '?').join(', ')})`,
      authorized,
    );
  }

  async upsertModules(
    documents: Array<IndexedModuleDocument & { embedding: number[] }>,
  ): Promise<void> {
    if (documents.length === 0) return;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const document of documents) {
        if (document.embedding.length !== this.dimension) {
          throw new Error(
            `Embedding for module ${document.id} has ${document.embedding.length} dimensions; expected ${this.dimension}.`,
          );
        }
        const searchableSource = [
          document.name,
          document.repository,
          document.purpose,
          document.domain,
          document.coreApis.join(' '),
          document.dependencies.join(' '),
          document.representativeSymbols.map((symbol) => `${symbol.title} ${symbol.signature} ${symbol.summary}`).join('\n'),
        ].join('\n');
        const searchable = `${searchableSource}\n${expandedSearchText(searchableSource)}`;
        const structureSource = [
          document.kind,
          document.structureTerms.join(' '),
          document.coreApis.join(' '),
          document.dependencies.join(' '),
        ].join('\n');
        const structureText = `${structureSource}\n${expandedSearchText(structureSource)}`;
        const values = [
          document.id, document.repository, document.moduleId, document.name, document.kind,
          document.language, document.license, document.purpose, document.domain,
          JSON.stringify(document.coreApis), JSON.stringify(document.sourceFiles),
          JSON.stringify(document.symbolIds), JSON.stringify(document.dependencies),
          JSON.stringify(document.structureTerms), JSON.stringify(document.representativeSymbols),
          JSON.stringify(document.compatibility), JSON.stringify(document.risks),
          document.snapshotId, document.contentHash, searchable, structureText,
        ];
        await connection.query<ResultSetHeader>(
          `
            INSERT INTO ${this.qualifiedModuleTable} (
              id, repository, module_id, name, module_kind, language, license, purpose, domain,
              core_apis, source_files, symbol_ids, dependencies, structure_terms,
              representative_symbols, compatibility, risks, snapshot_id, content_hash,
              search_text, structure_text, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${vectorHex(document.embedding)})
            ON DUPLICATE KEY UPDATE
              repository = VALUES(repository), module_id = VALUES(module_id), name = VALUES(name),
              module_kind = VALUES(module_kind), language = VALUES(language), license = VALUES(license),
              purpose = VALUES(purpose), domain = VALUES(domain), core_apis = VALUES(core_apis),
              source_files = VALUES(source_files), symbol_ids = VALUES(symbol_ids),
              dependencies = VALUES(dependencies), structure_terms = VALUES(structure_terms),
              representative_symbols = VALUES(representative_symbols), compatibility = VALUES(compatibility),
              risks = VALUES(risks), snapshot_id = VALUES(snapshot_id), content_hash = VALUES(content_hash),
              search_text = VALUES(search_text), structure_text = VALUES(structure_text), embedding = VALUES(embedding)
          `,
          values,
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async upsert(documents: Array<IndexedCodeDocument & { embedding: number[] }>): Promise<void> {
    if (documents.length === 0) return;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const document of documents) {
        if (document.embedding.length !== this.dimension) {
          throw new Error(
            `Embedding for ${document.id} has ${document.embedding.length} dimensions; expected ${this.dimension}.`,
          );
        }
        const searchableSource = [
          document.title,
          document.repository,
          document.path,
          document.signature,
          document.summary,
          document.content || document.preview,
          document.dependencies.join(' '),
        ].join('\n');
        const searchable = `${searchableSource}\n${expandedSearchText(searchableSource)}`;
        const values = [
          document.id,
          document.title,
          document.repository,
          document.license,
          document.language,
          document.kind,
          document.path,
          document.signature,
          document.summary,
          document.preview,
          JSON.stringify(document.dependencies),
          JSON.stringify(document.compatibility),
          JSON.stringify(document.risks),
          searchable,
        ];
        await connection.query<ResultSetHeader>(
          `
            INSERT INTO ${this.qualifiedTable} (
              id, title, repository, license, language, kind, path, signature,
              summary, preview, dependencies, compatibility, risks, search_text, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${vectorHex(document.embedding)})
            ON DUPLICATE KEY UPDATE
              title = VALUES(title),
              repository = VALUES(repository),
              license = VALUES(license),
              language = VALUES(language),
              kind = VALUES(kind),
              path = VALUES(path),
              signature = VALUES(signature),
              summary = VALUES(summary),
              preview = VALUES(preview),
              dependencies = VALUES(dependencies),
              compatibility = VALUES(compatibility),
              risks = VALUES(risks),
              search_text = VALUES(search_text),
              embedding = VALUES(embedding)
          `,
          values,
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async refreshIndex(): Promise<void> {
    await this.pool.query('CALL dbms_index_manager.refresh()');
  }

  async semanticSearch(
    embedding: number[],
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]> {
    if (embedding.length !== this.dimension) {
      throw new Error(`Query embedding has ${embedding.length} dimensions; expected ${this.dimension}.`);
    }
    const where = filterSql(filters);
    const vector = vectorHex(embedding);
    const [rows] = await this.pool.query<CodeSymbolRow[]>(
      `
        SELECT ${selectedColumns},
               GREATEST(0, 1 - cosine_distance(embedding, ${vector})) AS semantic_score
        FROM ${this.qualifiedTable}
        ${where.sql}
        ORDER BY cosine_distance(embedding, ${vector})
        APPROXIMATE
        LIMIT ?
      `,
      [...where.parameters, limit],
    );
    return rows.map(mapRow);
  }

  async textSearch(
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]> {
    const where = filterSql(filters);
    const match = 'MATCH(search_text) AGAINST (? IN NATURAL LANGUAGE MODE)';
    const prefix = where.sql ? `${where.sql} AND` : 'WHERE';
    const [rows] = await this.pool.query<CodeSymbolRow[]>(
      `
        SELECT ${selectedColumns}, ${match} AS text_score
        FROM ${this.qualifiedTable}
        ${prefix} ${match}
        ORDER BY text_score DESC
        LIMIT ?
      `,
      [query, ...where.parameters, query, limit],
    );
    const maxScore = Math.max(...rows.map((row) => Number(row.text_score) || 0), 1);
    return rows.map((row) =>
      mapRow({
        ...row,
        text_score: Math.min(1, (Number(row.text_score) || 0) / maxScore),
      } as CodeSymbolRow),
    );
  }

  async semanticModuleSearch(
    embedding: number[],
    filters: ModuleSearchFilters,
    limit: number,
  ): Promise<RetrievedModuleDocument[]> {
    if (embedding.length !== this.dimension) {
      throw new Error(`Module query embedding has ${embedding.length} dimensions; expected ${this.dimension}.`);
    }
    const where = moduleFilterSql(filters);
    const vector = vectorHex(embedding);
    const [rows] = await this.pool.query<CodeModuleRow[]>(
      `
        SELECT ${selectedModuleColumns},
               GREATEST(0, 1 - cosine_distance(embedding, ${vector})) AS semantic_score
        FROM ${this.qualifiedModuleTable}
        ${where.sql}
        ORDER BY cosine_distance(embedding, ${vector})
        APPROXIMATE
        LIMIT ?
      `,
      [...where.parameters, limit],
    );
    return rows.map(mapModuleRow);
  }

  async textModuleSearch(
    query: string,
    filters: ModuleSearchFilters,
    limit: number,
  ): Promise<RetrievedModuleDocument[]> {
    return this.fullTextModuleSearch('search_text', 'text_score', query, filters, limit);
  }

  async structuralModuleSearch(
    query: string,
    filters: ModuleSearchFilters,
    limit: number,
  ): Promise<RetrievedModuleDocument[]> {
    return this.fullTextModuleSearch('structure_text', 'structural_score', query, filters, limit);
  }

  private async fullTextModuleSearch(
    column: 'search_text' | 'structure_text',
    scoreAlias: 'text_score' | 'structural_score',
    query: string,
    filters: ModuleSearchFilters,
    limit: number,
  ): Promise<RetrievedModuleDocument[]> {
    const where = moduleFilterSql(filters);
    const match = `MATCH(${column}) AGAINST (? IN NATURAL LANGUAGE MODE)`;
    const [rows] = await this.pool.query<CodeModuleRow[]>(
      `
        SELECT ${selectedModuleColumns}, ${match} AS ${scoreAlias}
        FROM ${this.qualifiedModuleTable}
        ${where.sql} AND ${match}
        ORDER BY ${scoreAlias} DESC
        LIMIT ?
      `,
      [query, ...where.parameters, query, limit],
    );
    const maxScore = Math.max(
      ...rows.map((row) => Number(row[scoreAlias]) || 0),
      1,
    );
    return rows.map((row) => mapModuleRow({
      ...row,
      [scoreAlias]: Math.min(1, (Number(row[scoreAlias]) || 0) / maxScore),
    } as CodeModuleRow));
  }

  async moduleById(
    id: string,
    repositories: string[],
  ): Promise<RetrievedModuleDocument | null> {
    const authorized = requireRepositoryScopes(repositories);
    const [rows] = await this.pool.query<CodeModuleRow[]>(
      `
        SELECT ${selectedModuleColumns}
        FROM ${this.qualifiedModuleTable}
        WHERE id = ? AND repository IN (${authorized.map(() => '?').join(', ')})
        LIMIT 1
      `,
      [id, ...authorized],
    );
    const row = rows[0];
    return row ? mapModuleRow(row) : null;
  }

  async symbolsByIds(ids: string[], repositories: string[]): Promise<RetrievedCodeDocument[]> {
    if (ids.length === 0) return [];
    const authorized = requireRepositoryScopes(repositories);
    const uniqueIds = [...new Set(ids)].slice(0, 1_000);
    const [rows] = await this.pool.query<CodeSymbolRow[]>(
      `
        SELECT ${selectedColumns}
        FROM ${this.qualifiedTable}
        WHERE id IN (${uniqueIds.map(() => '?').join(', ')})
          AND repository IN (${authorized.map(() => '?').join(', ')})
      `,
      [...uniqueIds, ...authorized],
    );
    return rows.map(mapRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const seekDbInternals = { vectorHex, filterSql, moduleFilterSql };
