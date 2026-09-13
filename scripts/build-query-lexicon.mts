/**
 * Offline builder for the query-expansion lexicon.
 *
 * Fairness contract (docs/query-expansion-acceptance.zh-CN.md §5.1):
 *  - allowed inputs: repository source identifiers/word forms, a generic
 *    Chinese software terminology seed list, and general model knowledge;
 *  - forbidden inputs: any evaluation task requirement text, target symbol
 *    name, target path, evaluation report or human label.
 *
 * The generated table is word level only: entries never contain a full
 * multi-word identifier such as `checkFileName`.
 *
 * Run: node --import tsx scripts/build-query-lexicon.mts [--out <file>]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  out: { type: 'string', default: 'services/code-intelligence-service/src/query-lexicon.json' },
  'inputs-out': { type: 'string', default: '' },
  model: { type: 'string' },
  'max-tokens': { type: 'string', default: '8000' },
  'chunk-domains': { type: 'string', default: '4' },
  /** Regenerate only the TS module from an existing frozen JSON artifact. */
  from: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
} });

const root = process.cwd();
const repositories = [
  'fixtures/code-corpus/commons-fileupload-ts',
  'E:/CS/文章/x2cangjie/x2cangjie/projects/original_projects/commons-fileupload',
];

/** Generic software domains only. Evaluation task texts are never included. */
const DOMAINS = [
  '文件上传与表单提交', '输入输出流与缓冲区', '编解码与字符集', 'MIME、协议头与分段边界',
  '字符串处理与格式化', '集合、映射与缓存', '错误、异常与校验', '生命周期、资源释放与清理',
  '大小、数量与阈值限制', '标识、编号与唯一性', '并发、异步与取消', '配置、环境与依赖注入',
  '日志、诊断与统计', '时间与定时', '文件系统与临时文件', '网络与 HTTP', '测试与断言', '序列化与持久化',
  '核心动词与名词（必须逐条给出条目，均为 2~3 字）：检查、校验、验证、读取、写入、返回、抛出、删除、创建、' +
  '设置、获取、解析、转换、复制、关闭、上传、下载、限制、超限、阈值、大小、长度、字符、空值、空格、非法、无效、' +
  '唯一、编号、标识、内存、磁盘、临时、缓存、超时、重试、日志、配置、依赖、接口、参数、异常、错误、失败、分段、' +
  '请求、响应、文件、路径、目录、流、缓冲区、集合、数组、映射、队列、排序、过滤、合并、拆分、初始化、注册、释放、' +
  '清理、恢复、回滚、增量、批量、分页、事务、锁、线程、任务、调度、进度、统计、监控、采样、编码、解码、字符集、' +
  '头部、内容类型、输入流、输出流、临时文件',
  // The core verb list above is covered, but a requirement that phrases the same
  // action as a *variant* (写出 rather than 写入) matched no entry at all and the
  // recall query lost the verb entirely. Variant and companion word forms are
  // listed here so generation covers them. Generic software vocabulary only.
  '动词变体与配套词形（必须逐条给出条目，均为 2~3 字）：写出、写回、读出、读入、加载、保存、移除、清除、重置、' +
  '追加、截断、跳过、遍历、迭代、分组、归组、去重、合并、拆分、转换、还原、展开、包装、解包、输出、输入、字节、' +
  '比特、边界、分隔符、终止符、偏移、位置、序号、索引、哈希、摘要、副本、快照、状态、步骤、阶段、来源、目标、' +
  '条件、分支、循环、重载、代理、包装器、回调、钩子、装饰、适配、桥接、注册表、清单、清单文件',
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Word forms of corpus identifiers; used as an audit trail, never as entries. */
function identifierWords(identifiers: readonly string[]): string[] {
  const words = new Set<string>();
  for (const identifier of identifiers) {
    for (const part of identifier.split(/[^A-Za-z0-9]+/)) {
      if (!part) continue;
      for (const word of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ')) {
        const normalized = word.toLowerCase();
        if (normalized.length >= 3 && normalized.length <= 24) words.add(normalized);
      }
    }
  }
  return [...words].sort();
}

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  const { readdir } = await import('node:fs/promises');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target' || entry.name === 'obj') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(absolute);
    else if (/\.(ts|tsx|js|mjs|java|kt|c|cc|cpp|h|hpp|py|cs|go|rs)$/.test(entry.name)) yield absolute;
  }
}

async function corpusIdentifiers(): Promise<{ identifiers: string[]; files: number; digest: string }> {
  const identifiers = new Set<string>();
  let files = 0;
  for (const repository of repositories) {
    for await (const file of sourceFiles(path.resolve(root, repository))) {
      files++;
      const text = await readFile(file, 'utf8').catch(() => '');
      if (!text) continue;
      for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) identifiers.add(match[0]);
      for (const part of file.split(/[\\/]/)) identifiers.add(part.replace(/\.[A-Za-z0-9]+$/, ''));
    }
  }
  const sorted = [...identifiers].sort();
  return { identifiers: sorted, files, digest: sha256(sorted.join('\n')) };
}

function prompt(domains: readonly string[], target: number): string {
  return [
    '为“中文开发需求 → 英文代码标识符词”的检索扩展词典生成词条。',
    '',
    '要求：',
    '1. 只输出一个 JSON 数组，不要任何解释、不要代码块围栏。',
    '2. 每条格式：{"zh": "中文术语", "en": ["英文代码词", ...]}。',
    '3. zh 为 2~6 个汉字、开发者在需求里会写的术语；en 为该术语在代码里最常见的 2~4 个英文词形。',
    '4. en 必须是单词级词形（可含驼峰，如 fileName、contentType、inputStream），长度 2~24 个字母。',
    '5. 禁止输出由多个词拼接而成的完整符号名（例如禁止 checkFileName、getOriginalFilename 这类整名）。',
    '6. 覆盖下列通用领域，每个领域都要有足够条目：',
    domains.map((domain, index) => `   ${index + 1}) ${domain}`).join('\n'),
    `7. 本批共输出 ${target} 条左右；同一中文术语只出现一次；不同术语之间 en 可以有重叠。`,
    '8. 术语面向通用软件工程，不要偏向任何具体项目、文件或函数。',
  ].join('\n');
}

interface Entry { zh: string; en: string[] }

function parseEntries(content: string): Entry[] {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`Model did not return a JSON array: ${trimmed.slice(0, 200)}`);
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Lexicon payload is not an array.');
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const zh = typeof record.zh === 'string' ? record.zh.trim() : '';
    const en = Array.isArray(record.en) ? record.en.filter((value): value is string => typeof value === 'string') : [];
    if (!/^[\u4e00-\u9fff]{2,8}$/.test(zh)) continue;
    const words = [...new Set(en.map((value) => value.trim()).filter((value) => /^[A-Za-z][A-Za-z0-9]{1,23}$/.test(value)))];
    if (!words.length || seen.has(zh)) continue;
    seen.add(zh);
    entries.push({ zh, en: words.slice(0, 4) });
  }
  return entries.sort((left, right) => left.zh.localeCompare(right.zh, 'zh-Hans-CN'));
}

const environment = { ...process.env };
if (!environment.DEEPSEEK_API_KEY) {
  try {
    const legacy = await readFile(path.join(root, 'services/adaptation-service/.env'), 'utf8');
    for (const line of legacy.split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index <= 0 || line.trim().startsWith('#')) continue;
      const key = line.slice(0, index).trim();
      if (key.startsWith('DEEPSEEK_')) environment[key] ??= line.slice(index + 1).trim();
    }
  } catch { /* environment-only runs */ }
}
const apiBase = (environment.DEEPSEEK_API_BASE?.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const model = values.model ?? environment.DEEPSEEK_MODEL?.trim() ?? 'deepseek-v4-flash';
const chunkSize = Math.max(1, Number(values['chunk-domains']));
const domainChunks: string[][] = [];
for (let offset = 0; offset < DOMAINS.length; offset += chunkSize) domainChunks.push(DOMAINS.slice(offset, offset + chunkSize));
const targetPerChunk = Math.round(360 / domainChunks.length);
const prompts = domainChunks.map((domains) => prompt(domains, targetPerChunk));
const corpus = await corpusIdentifiers();
const words = identifierWords(corpus.identifiers);
const inputs = [
  { kind: 'repository-identifiers', detail: repositories, files: corpus.files, identifiers: corpus.identifiers.length, wordForms: words.length, sha256: corpus.digest },
  { kind: 'generic-domains', detail: DOMAINS, sha256: sha256(DOMAINS.join('\n')) },
  { kind: 'prompts', model, chunks: prompts.length, sha256: sha256(prompts.join('\n---\n')) },
  { kind: 'forbidden-inputs', detail: ['evaluation requirement text', 'evaluation target symbol', 'evaluation target path', 'evaluation report'], sha256: sha256('none') },
];
const inputsOut = values['inputs-out'];
if (inputsOut) {
  await mkdir(path.dirname(path.resolve(root, inputsOut)), { recursive: true });
  await writeFile(path.resolve(root, inputsOut), `${JSON.stringify({ generatedAt: new Date().toISOString(), inputs }, null, 2)}\n`);
}
console.info(JSON.stringify({ stage: 'inputs', model, corpusFiles: corpus.files, identifierWords: words.length, chunks: prompts.length, promptSha256: inputs[2]!.sha256 }));
if (values['dry-run']) process.exit(0);

if (values.from) {
  const frozen = JSON.parse(await readFile(path.resolve(root, values.from), 'utf8')) as
    { version: string; model: string; promptSha256: string; lexiconSha256: string; entries: Entry[] };
  await writeModule(path.resolve(root, values.out), frozen, frozen.entries);
  console.info(JSON.stringify({ stage: 'from-frozen', from: values.from, entries: frozen.entries.length, lexiconSha256: frozen.lexiconSha256 }));
  process.exit(0);
}

if (!environment.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for offline lexicon generation.');
const started = Date.now();
const merged = new Map<string, Entry>();
const chunkStats: Array<Record<string, unknown>> = [];
for (const [index, requestPrompt] of prompts.entries()) {
  const response = await fetch(`${apiBase}/chat/completions`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${environment.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: Number(values['max-tokens']),
      ...(environment.DEEPSEEK_THINKING === 'on' ? {} : { thinking: { type: 'disabled' } }),
      messages: [{ role: 'system', content: '你是软件工程术语专家。只输出 JSON 数组。' }, { role: 'user', content: requestPrompt }] }) });
  if (!response.ok) throw new Error(`Lexicon generation failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
    usage?: { completion_tokens?: number } };
  const choice = body.choices?.[0];
  const content = choice?.message?.content ?? '';
  const chunk = parseEntries(content);
  for (const entry of chunk) if (!merged.has(entry.zh)) merged.set(entry.zh, entry);
  chunkStats.push({ chunk: index + 1, domains: domainChunks[index]!.length, entries: chunk.length,
    finish: choice?.finish_reason ?? null, completionTokens: body.usage?.completion_tokens ?? null,
    contentChars: content.length, reasoningChars: String(choice?.message?.reasoning_content ?? '').length });
  console.info(JSON.stringify({ stage: 'chunk', ...chunkStats.at(-1) }));
}
const entries = [...merged.values()].sort((left, right) => left.zh.localeCompare(right.zh, 'zh-Hans-CN'));
if (entries.length < 200) throw new Error(`Lexicon too small: ${entries.length} entries.`);
const lexicon = {
  version: 'query-lexicon/v1',
  model,
  promptSha256: sha256(prompts.join('\n---\n')),
  generatedAt: new Date().toISOString(),
  chunks: chunkStats,
  entries,
};
const payload = { ...lexicon, lexiconSha256: sha256(JSON.stringify(entries)) };
const outPath = path.resolve(root, values.out);

/** Emit the runtime TS module that tsx, tsc and esbuild all consume identically. */
async function writeModule(target: string, data: { version: string; model: string; promptSha256: string; lexiconSha256: string }, table: readonly Entry[]): Promise<void> {
  const modulePath = target.replace(/\.json$/, '-data.ts');
  const moduleSource = [
    '// Generated by scripts/build-query-lexicon.mts. Do not edit by hand.',
    `// ${data.version} model=${data.model} entries=${table.length} sha256=${data.lexiconSha256}`,
    '',
    'export interface QueryLexiconEntry { readonly zh: string; readonly en: readonly string[] }',
    'export const QUERY_LEXICON = {',
    `  version: ${JSON.stringify(data.version)},`,
    `  model: ${JSON.stringify(data.model)},`,
    `  lexiconSha256: ${JSON.stringify(data.lexiconSha256)},`,
    `  promptSha256: ${JSON.stringify(data.promptSha256)},`,
    '  entries: [',
    ...table.map((entry) => `    { zh: ${JSON.stringify(entry.zh)}, en: [${entry.en.map((word) => JSON.stringify(word)).join(', ')}] },`),
    '  ],',
    '} as const;',
    '',
  ].join('\n');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await writeFile(modulePath, moduleSource);
  console.info(JSON.stringify({ stage: 'module', module: path.relative(root, modulePath), entries: table.length }));
}

if (values.from) process.exit(0);

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
await writeModule(outPath, lexicon, entries);
console.info(JSON.stringify({ stage: 'written', out: values.out, entries: entries.length,
  elapsedMs: Date.now() - started, lexiconSha256: payload.lexiconSha256 }));
