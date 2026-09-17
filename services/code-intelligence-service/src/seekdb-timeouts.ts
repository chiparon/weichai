/**
 * SeekDB query ceilings.
 *
 * The server default is 10 s (`ob_query_timeout`), and a module search reaches
 * it in practice: one recall fans out over every reference repository (20 repos
 * × 3 views × 2 statements) while the host may be writing a new revision, so a
 * query that waits behind the pool and behind an indexing COMMIT exceeds the
 * default and the whole search fails with "Timeout, query has reached the
 * maximum query timeout: 10000000(us)".  The ceiling is therefore raised on
 * every pooled session, and both client-side limits are aligned with it: a
 * client that gives up first would hide the server's own diagnosis.
 */
export const seekDbQueryTimeoutMs = 60_000;

/** One statement's client-side ceiling, kept just above the server's. */
export const seekDbClientQueryTimeoutMs = seekDbQueryTimeoutMs + 5_000;

/** Whole multi-repository search budget; one slow query must not be cut short. */
export const moduleSearchBudgetMs = seekDbQueryTimeoutMs;
