import Database from "@tauri-apps/plugin-sql";

let rawDb: Database | null = null;
let wrappedDb: Database | null = null;

/**
 * Global serialization queue for ALL SQLite access (reads AND writes).
 *
 * Why this exists:
 * `@tauri-apps/plugin-sql` (v2.3.2) opens an sqlx connection pool of 10
 * connections with NO busy_timeout and NO per-connection pragma hook. Two
 * consequences:
 *   1. `PRAGMA busy_timeout` set once in `getDb()` only applies to whichever
 *      single connection happened to be borrowed — the other 9 stay at the
 *      default `busy_timeout = 0`, so the next writer fails immediately with
 *      SQLITE_BUSY (code 5) instead of waiting.
 *   2. A manual JS `BEGIN` / `COMMIT` wraps statements that the pool spreads
 *      across DIFFERENT physical connections, so the "transaction" never
 *      actually covers its own writes and the dangling `BEGIN` connection
 *      contends for the write lock at `COMMIT` time -> BUSY / deadlock.
 *
 * The fix is to serialize every DB call on a single async chain. With at most
 * one operation in flight, the pool keeps reusing the same hot connection, so
 * the once-set pragmas (WAL / busy_timeout / foreign_keys) stay effective, and
 * there is never a second writer to contend with. Writes use autocommit
 * (idempotent upserts), which is safe for our sync flows.
 */
let serialTail: Promise<void> = Promise.resolve();

/**
 * Tracks whether we are currently executing inside a `withTransaction` callback.
 *
 * The global `serialize` queue funnels every DB call into a single async chain.
 * A `withTransaction` callback already runs *inside* that exclusive region
 * (the whole callback is wrapped in `serialize`). If the callback's own DB
 * calls (`db.execute`/`db.select`) were ALSO routed through `serialize`, the
 * nested call would be queued *after* the callback's own slot — but the
 * callback's slot cannot resolve until that nested call finishes. That is a
 * classic re-entrant deadlock that permanently freezes the entire DB chain
 * (and therefore every feature that touches the DB, e.g. opening settings).
 *
 * So while `inTransaction` is true, the wrapped DB methods bypass the queue and
 * execute directly on the raw connection — the outer `withTransaction` already
 * guarantees no other operation can interleave.
 */
let inTransaction = false;

function serialize<T>(op: () => Promise<T>): Promise<T> {
  // Run `op` strictly after the previous operation settles (success OR failure).
  const next = serialTail.then(op, op);
  // Keep the chain alive even if `op` rejects, without swallowing the error:
  // `next` still rejects for its own caller, we only detach the tail.
  serialTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Wrap a raw Database so that `execute` / `select` (and any batch variants)
 * are funneled through the global serialization queue. This is what makes the
 * connection-pool busy_timeout problem disappear without touching the library.
 */
function wrapDb(raw: Database): Database {
  const wrapped: any = Object.create(raw);

  wrapped.execute = (sql: string, params?: unknown[]) =>
    inTransaction ? raw.execute(sql, params) : serialize(() => raw.execute(sql, params));

  wrapped.select = function <T = unknown>(sql: string, params?: unknown[]) {
    return inTransaction
      ? raw.select<T>(sql, params)
      : serialize(() => raw.select<T>(sql, params));
  };

  for (const name of ["selectObject", "executeBatch", "batchExecute"]) {
    const fn = (raw as any)[name];
    if (typeof fn === "function") {
      wrapped[name] = (sql: string, params?: unknown[]) =>
        inTransaction ? fn.call(raw, sql, params) : serialize(() => fn.call(raw, sql, params));
    }
  }

  return wrapped as Database;
}

export async function getDb(): Promise<Database> {
  if (!wrappedDb) {
    rawDb = await Database.load("sqlite:velo.db");
    // Best-effort pragmas. With the global serialization queue keeping a single
    // connection hot, these connection-level settings remain effective for the
    // life of the app. journal_mode=WAL is file-level and persists regardless.
    try {
      await rawDb.execute("PRAGMA journal_mode = WAL", []);
      await rawDb.execute("PRAGMA busy_timeout = 10000", []);
      await rawDb.execute("PRAGMA synchronous = NORMAL", []);
      await rawDb.execute("PRAGMA foreign_keys = ON", []);
    } catch {
      // pragmas are best-effort; never block DB load
    }
    wrappedDb = wrapDb(rawDb);
  }
  return wrappedDb;
}

/**
 * Build a dynamic SQL UPDATE statement from a set of field updates.
 * Returns null if no fields to update.
 */
export function buildDynamicUpdate(
  table: string,
  idColumn: string,
  id: unknown,
  fields: [string, unknown][],
): { sql: string; params: unknown[] } | null {
  if (fields.length === 0) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [column, value] of fields) {
    sets.push(`${column} = $${idx++}`);
    params.push(value);
  }

  params.push(id);
  return {
    sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${idColumn} = $${idx}`,
    params,
  };
}

/**
 * Run a batch of writes as a serialized unit. We intentionally do NOT use a
 * manual `BEGIN`/`COMMIT`: under the sqlx pool those statements land on
 * different physical connections (see the note on `serialize` above), so they
 * neither provide atomicity nor help — they only create lock contention. The
 * global serialization queue guarantees no other operation interleaves, which
 * is the real isolation we need. Idempotent upserts make the loss of
 * statement-level rollback acceptable for our sync flows.
 */
export async function withTransaction(
  fn: (db: Database) => Promise<void>,
): Promise<void> {
  const database = await getDb();
  // Mark the exclusive region so the callback's own DB calls (which use the
  // wrapped db) execute directly on the raw connection instead of re-queuing
  // behind this very slot — otherwise the re-entrant serialize deadlocks.
  inTransaction = true;
  try {
    await serialize(() => fn(database));
  } finally {
    inTransaction = false;
  }
}

/**
 * Execute a SELECT query and return the first result or null.
 */
export async function selectFirstBy<T>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const db = await getDb();
  const rows = await db.select<T[]>(query, params);
  return rows[0] ?? null;
}

/**
 * Execute a COUNT(*) query and return whether any rows exist.
 */
export async function existsBy(
  query: string,
  params: unknown[] = [],
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(query, params);
  return (rows[0]?.count ?? 0) > 0;
}

/**
 * Convert a boolean to SQLite integer (0 or 1).
 */
export function boolToInt(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}
