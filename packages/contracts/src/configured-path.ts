/**
 * A local path reaches this product as text a human typed, pasted from a file
 * manager, or hand-wrote into `settings.json`, so the same directory arrives in
 * several equivalent spellings. Windows' "Copy as path" always wraps the value in
 * double quotes, and a hand-written array can hold `""` or only whitespace.
 *
 * Both used to travel onwards as a literal path, where `path.resolve` turned them
 * into a directory that does not exist — or, for the empty string, into the
 * extension host's own working directory, which then got indexed as if the user
 * had chosen it. Quoting is decoration and an empty entry carries no meaning, so
 * both are resolved here, once, for the host and the Webview alike.
 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
];

/** One layer of matching quotes is decoration, never part of a path. */
export function normaliseConfiguredPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let candidate = value.trim();
  const pair = QUOTE_PAIRS.find(([open, close]) => (
    candidate.length >= 2 && candidate.startsWith(open) && candidate.endsWith(close)
  ));
  if (pair) candidate = candidate.slice(pair[0].length, candidate.length - pair[1].length).trim();
  return candidate.length > 0 ? candidate : undefined;
}

/** Unquoted, trimmed, non-empty paths in their original order and without repeats. */
export function normaliseConfiguredPaths(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const path = normaliseConfiguredPath(value);
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
