import { describe, expect, it } from 'vitest';
import { isTestOnlyModule, orderModulesByDependency } from './module-order';

const module = (id: string, dependsOn: string[] = [], files = [`src/main/${id}.java`]) =>
  ({ id, files, dependsOn });

describe('orderModulesByDependency', () => {
  it('orders siblings by what must exist first, whatever the plan listed', () => {
    // The java-fileupload plan lists the core engine first although it depends
    // on modules listed after it.
    const ordered = orderModulesByDependency([
      module('core', ['multipart', 'util']),
      module('multipart', ['util']),
      module('contract'),
      module('storage', ['contract', 'util']),
      module('util', ['contract']),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['contract', 'util', 'multipart', 'core', 'storage']);
  });

  it('keeps independent siblings in their original order', () => {
    const ordered = orderModulesByDependency([module('beta'), module('alpha'), module('gamma')]);
    expect(ordered.map((item) => item.id)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('places a dependency cycle side by side and everything depending on it after', () => {
    const ordered = orderModulesByDependency([
      module('adapter', ['left', 'right']),
      module('left', ['right']),
      module('right', ['left']),
    ]);
    // The cycle stays one tier in its original order; the adapter follows it.
    expect(ordered.map((item) => item.id)).toEqual(['left', 'right', 'adapter']);
  });

  it('ignores dependencies that belong to another sibling level', () => {
    const ordered = orderModulesByDependency([
      { ...module('child', ['parent']), dependsOn: ['other-level'] },
      module('sibling'),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['child', 'sibling']);
  });

  it('keeps test modules and the unassigned bucket at the bottom', () => {
    const ordered = orderModulesByDependency([
      { id: 'tests', files: ['src/test/java/example/UploadTest.java'], dependsOn: [] },
      module('storage', ['contract']),
      { id: 'unassigned', files: ['tools/compile.mjs'], dependsOn: [], unassigned: true },
      module('contract'),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['contract', 'storage', 'tests', 'unassigned']);
  });

  it('treats only wholly-test modules as acceptance', () => {
    expect(isTestOnlyModule(['src/test/java/a/BTest.java'])).toBe(true);
    expect(isTestOnlyModule(['tests/b_test.py'])).toBe(true);
    expect(isTestOnlyModule(['src/main/java/a/B.java', 'src/test/java/a/BTest.java'])).toBe(false);
    expect(isTestOnlyModule([])).toBe(false);
  });

  it('never loses or duplicates a module', () => {
    const input = [module('a', ['b']), module('b', ['a']), module('c'), module('d', ['missing'])];
    const ordered = orderModulesByDependency(input);
    expect(ordered).toHaveLength(input.length);
    expect([...ordered].map((item) => item.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
