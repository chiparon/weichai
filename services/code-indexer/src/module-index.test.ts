import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractModuleCorpus } from './module-index.js';

const roots: string[] = [];

async function fixture(manifest: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-modules-'));
  roots.push(root);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('module corpus extraction', () => {
  it('infers cohesive modules below a common language package root', async () => {
    const root = await fixture({
      repository: 'payments-java',
      language: 'Java',
      sourceRoot: 'src/main/java',
      license: 'MIT',
    });
    const packageRoot = path.join(root, 'src', 'main', 'java', 'com', 'example');
    await mkdir(path.join(packageRoot, 'payment'), { recursive: true });
    await mkdir(path.join(packageRoot, 'orders'), { recursive: true });
    await writeFile(path.join(packageRoot, 'payment', 'PaymentService.java'),
      'public class PaymentService { public void pay() {} }');
    await writeFile(path.join(packageRoot, 'orders', 'OrderService.java'),
      'public class OrderService { public void create() {} }');

    const modules = await extractModuleCorpus(root);

    expect(modules.map((module) => module.moduleId)).toEqual(['orders', 'payment']);
    expect(modules.every((module) => module.repository === 'fixture/payments-java')).toBe(true);
    expect(modules.find((module) => module.moduleId === 'payment')?.coreApis.join(' ')).toContain('PaymentService');
  });

  it('prefers an approved module summary and preserves its functional boundary', async () => {
    const root = await fixture({ repository: 'approved-ts', language: 'TypeScript', sourceRoot: 'src' });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.forexplore'), { recursive: true });
    await writeFile(path.join(root, 'src', 'payment.ts'), 'export function pay() { return true; }');
    await writeFile(path.join(root, 'src', 'order.ts'), 'export function order() { return true; }');
    await writeFile(path.join(root, '.forexplore', 'module-summary.json'), JSON.stringify({
      generated: {
        status: 'approved',
        modules: [{
          id: 'checkout', name: 'Checkout', kind: 'feature', description: 'Completes orders and payments.',
          sourceFiles: ['src/payment.ts', 'src/order.ts'], symbolIds: [], dependsOn: [], writeSet: [],
          resourceLocks: [], evidenceIds: [],
        }],
      },
      human: { approvalsCurrent: true },
    }));

    const modules = await extractModuleCorpus(root);

    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({ moduleId: 'checkout', name: 'Checkout', kind: 'feature' });
    expect(modules[0]?.sourceFiles).toEqual(['src/order.ts', 'src/payment.ts']);
  });
});
