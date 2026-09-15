/**
 * Sibling module order for the workbench tree.
 *
 * The tree used to render modules in whatever order the modelling agent listed
 * them, which reads as a dependency order without being one: the plan of the
 * java-fileupload target lists 核心上传解析引擎 first although it depends on
 * modules listed at position 2 and 7. Siblings are now ordered by their declared
 * dependencies, so the tree reads top-down as "what must exist first".
 *
 * A dependency cycle cannot be ordered, and the plan does not forbid one: the
 * members of a cycle are placed side by side as one tier, in their original
 * order, and everything that depends on them follows.
 */

/** One sibling level of the module forest, plus the synthetic unassigned bucket. */
export interface OrderableModule {
  id: string;
  /** Files this module owns; `sourceFiles` is accepted so a ProjectModule fits directly. */
  files?: readonly string[];
  sourceFiles?: readonly string[];
  dependsOn?: readonly string[];
  /** The bucket holding every file no module claims; always rendered last. */
  unassigned?: boolean;
}

const filesOf = (module: OrderableModule): readonly string[] => module.files ?? module.sourceFiles ?? [];

const testFilePattern =
  /(?:^|\/)(?:test|tests|__tests__|spec)\/|(?:^|\/)[^/]*Tests?\.(?:java|kt|kts|cs|ts|tsx|js|jsx|py|go|rs|mjs|cjs)$/i;

/** A module whose every file looks like a test: acceptance depends on all the rest. */
export function isTestOnlyModule(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => testFilePattern.test(file));
}

/**
 * Orders one sibling level by dependency.  Dependencies on modules outside this
 * level are ignored: the caller orders each level of the forest on its own.
 */
export function orderModulesByDependency<T extends OrderableModule>(modules: readonly T[]): T[] {
  const position = new Map(modules.map((module, index) => [module.id, index]));
  const dependencies = modules.map((module) => new Set(
    (module.dependsOn ?? [])
      .filter((dependency) => dependency !== module.id && position.has(dependency))
      .map((dependency) => position.get(dependency)!),
  ));

  // Tarjan: strongly connected components collapse a cycle into one tier.
  const componentOf = new Array<number>(modules.length).fill(-1);
  const components: number[][] = [];
  const index = new Array<number>(modules.length).fill(-1);
  const low = new Array<number>(modules.length).fill(0);
  const onStack = new Array<boolean>(modules.length).fill(false);
  const stack: number[] = [];
  let counter = 0;

  const connect = (node: number): void => {
    index[node] = low[node] = counter++;
    stack.push(node);
    onStack[node] = true;
    for (const dependency of dependencies[node]!) {
      if (index[dependency] === -1) {
        connect(dependency);
        low[node] = Math.min(low[node]!, low[dependency]!);
      } else if (onStack[dependency]) {
        low[node] = Math.min(low[node]!, index[dependency]!);
      }
    }
    if (low[node] !== index[node]) return;
    const component = components.length;
    const members: number[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack[member] = false;
      componentOf[member] = component;
      members.push(member);
      if (member === node) break;
    }
    components.push(members);
  };
  for (let node = 0; node < modules.length; node += 1) if (index[node] === -1) connect(node);

  // A dependency between components puts the depended-upon component first; a
  // cycle inside one component has already collapsed into a single node here.
  const componentDependencies = components.map(() => new Set<number>());
  components.forEach((members, component) => {
    for (const member of members) {
      for (const dependency of dependencies[member]!) {
        const other = componentOf[dependency]!;
        if (other !== component) componentDependencies[component]!.add(other);
      }
    }
  });
  const firstMember = components.map((members) => Math.min(...members));
  const ordered: number[] = [];
  const placed = new Set<number>();
  while (ordered.length < components.length) {
    const ready = components
      .map((_, component) => component)
      .filter((component) => !placed.has(component)
        && [...componentDependencies[component]!].every((dependency) => placed.has(dependency)));
    // A cycle between components is impossible after condensation, so `ready`
    // only stays empty if the graph cannot be built; fall back to input order.
    const candidates = ready.length > 0 ? ready : components.map((_, component) => component)
      .filter((component) => !placed.has(component));
    candidates.sort((left, right) => firstMember[left]! - firstMember[right]!);
    const next = candidates[0]!;
    placed.add(next);
    ordered.push(next);
  }

  const result = ordered.flatMap((component) => [...components[component]!]
    .sort((left, right) => left - right)
    .map((member) => modules[member]!));
  const acceptance = result.filter((module) => !module.unassigned && isTestOnlyModule(filesOf(module)));
  return [
    ...result.filter((module) => !module.unassigned && !isTestOnlyModule(filesOf(module))),
    ...acceptance,
    ...result.filter((module) => module.unassigned === true),
  ];
}
