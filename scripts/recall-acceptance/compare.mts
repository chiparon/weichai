/**
 * Diffs two frozen retrieval snapshots produced by capture.mts.
 *
 * Acceptance rules for the shared-recall-kernel refactor:
 *   NL2Code  -> must be identical (the kernel reproduces the inline fusion).
 *   Code2Code-> must not lose a candidate; ranking may move, and every move is
 *               reported so it can be explained rather than assumed benign.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

interface Result { granularity: string; name: string; repositoryId: string; relativePath: string; symbolKey: string | null; score: number }
interface Nl2Case { name: string; status: string; tokens: number; routing: unknown; results: Result[]; evidenceFocus: unknown[]; relations: unknown[]; gaps: string[] }
interface C2cCandidate { id: string; title: string; kind: string; repository: string; path: string; overall: number; semantic: number; symbol: number; contract: number; moduleId: string | null }
interface C2cCase { name: string; targetKind: string; targetPath: string; candidates: C2cCandidate[] }
interface Snapshot { label: string; generatedAt: string; nl2code: Nl2Case[]; code2code: C2cCase[] }

const { values } = parseArgs({ options: {
  before: { type: 'string', default: 'tmp/recall-baseline/before.json' },
  after: { type: 'string', default: 'tmp/recall-baseline/after.json' },
  output: { type: 'string', default: 'tmp/recall-baseline/diff.json' },
} });
const read = async (file: string): Promise<Snapshot> => JSON.parse(await readFile(path.resolve(file), 'utf8')) as Snapshot;
const before = await read(values.before!);
const after = await read(values.after!);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const key = (result: Result): string => `${result.granularity}|${result.repositoryId}|${result.relativePath}|${result.symbolKey ?? result.name}`;
const candidateKey = (candidate: C2cCandidate): string => candidate.id;

const nl2code = before.nl2code.map((oldCase) => {
  const newCase = after.nl2code.find((item) => item.name === oldCase.name)!;
  const oldKeys = oldCase.results.map(key);
  const newKeys = newCase.results.map(key);
  return {
    name: oldCase.name,
    status: `${oldCase.status} -> ${newCase.status}`,
    tokens: `${oldCase.tokens} -> ${newCase.tokens}`,
    resultCount: `${oldCase.results.length} -> ${newCase.results.length}`,
    routingIdentical: same(oldCase.routing, newCase.routing),
    orderedResultsIdentical: same(oldKeys, newKeys),
    scoresIdentical: same(oldCase.results.map((item) => item.score), newCase.results.map((item) => item.score)),
    evidenceIdentical: same(oldCase.evidenceFocus, newCase.evidenceFocus),
    relationsIdentical: same(oldCase.relations, newCase.relations),
    gapsIdentical: same(oldCase.gaps, newCase.gaps),
    lostResults: oldKeys.filter((item) => !newKeys.includes(item)),
    gainedResults: newKeys.filter((item) => !oldKeys.includes(item)),
  };
});

const code2code = before.code2code.map((oldCase) => {
  const newCase = after.code2code.find((item) => item.name === oldCase.name)!;
  const oldKeys = oldCase.candidates.map(candidateKey);
  const newKeys = newCase.candidates.map(candidateKey);
  const movers = oldCase.candidates.flatMap((candidate) => {
    const next = newCase.candidates.find((item) => item.id === candidate.id);
    if (!next) return [];
    const from = oldKeys.indexOf(candidate.id);
    const to = newKeys.indexOf(candidate.id);
    return from === to && candidate.overall === next.overall ? [] : [{
      id: candidate.id, title: candidate.title,
      rank: `${from} -> ${to}`,
      overall: `${candidate.overall} -> ${next.overall}`,
      semantic: `${candidate.semantic} -> ${next.semantic}`,
      contract: `${candidate.contract} -> ${next.contract}`,
    }];
  });
  return {
    name: oldCase.name,
    count: `${oldCase.candidates.length} -> ${newCase.candidates.length}`,
    orderedIdentical: same(oldKeys, newKeys),
    lostCandidates: oldCase.candidates.filter((candidate) => !newKeys.includes(candidate.id))
      .map((candidate) => ({ id: candidate.id, title: candidate.title, repository: candidate.repository, path: candidate.path, moduleId: candidate.moduleId })),
    gainedCandidates: newCase.candidates.filter((candidate) => !oldKeys.includes(candidate.id))
      .map((candidate) => ({ id: candidate.id, title: candidate.title, repository: candidate.repository, path: candidate.path, moduleId: candidate.moduleId })),
    movers,
  };
});

const report = {
  before: values.before, after: values.after,
  beforeGeneratedAt: before.generatedAt, afterGeneratedAt: after.generatedAt,
  nl2code, code2code,
  verdict: {
    nl2codeIdentical: nl2code.every((item) => item.status.split(' -> ')[0] === item.status.split(' -> ')[1] &&
      item.orderedResultsIdentical && item.scoresIdentical && item.evidenceIdentical && item.relationsIdentical && item.gapsIdentical),
    code2codeLostCandidates: code2code.reduce((sum, item) => sum + item.lostCandidates.length, 0),
    code2codeRankMoves: code2code.reduce((sum, item) => sum + item.movers.length, 0),
  },
};
await writeFile(path.resolve(values.output!), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.info(JSON.stringify(report, null, 2));
