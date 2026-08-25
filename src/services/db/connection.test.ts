import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Database before importing module under test
const mockExecute = vi.fn();
const mockSelect = vi.fn();
const mockDb = { execute: mockExecute, select: mockSelect };

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(() => Promise.resolve(mockDb)),
  },
}));

// Use dynamic import so mocks are in place
const { withTransaction, getDb } = await import("./connection");

describe("withTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("runs the callback without issuing a manual BEGIN/COMMIT", async () => {
    // The sqlx pool has no transaction affinity, so we deliberately avoid
    // manual BEGIN/COMMIT (they would poison the pool). The callback should
    // just run as-is.
    const callOrder: string[] = [];
    mockExecute.mockImplementation(async (sql: string) => {
      callOrder.push(sql);
    });

    await withTransaction(async () => {
      callOrder.push("callback");
      await mockExecute("UPDATE messages SET is_read = 1");
    });

    // getDb() runs setup PRAGMAs on first init; ignore those for ordering.
    const userCalls = callOrder.filter((s) => !s.startsWith("PRAGMA"));
    expect(userCalls).toEqual(["callback", "UPDATE messages SET is_read = 1"]);
    // No manual transaction statements should ever be issued.
    expect(callOrder.some((s) => s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK")).toBe(false);
  });

  it("propagates callback errors", async () => {
    await expect(
      withTransaction(async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
  });

  it("serialises concurrent transactions via the global mutex", async () => {
    const executionLog: string[] = [];

    // tx1 and tx2 are launched concurrently; the mutex must make tx2 wait
    // until tx1 has fully finished.
    const tx1 = withTransaction(async () => {
      executionLog.push("tx1-work");
      await new Promise((r) => setTimeout(r, 10));
      executionLog.push("tx1-done");
    });

    const tx2 = withTransaction(async () => {
      executionLog.push("tx2-work");
    });

    await Promise.all([tx1, tx2]);

    const tx1WorkIdx = executionLog.indexOf("tx1-work");
    const tx1DoneIdx = executionLog.indexOf("tx1-done");
    const tx2WorkIdx = executionLog.indexOf("tx2-work");

    expect(tx1WorkIdx).toBeLessThan(tx1DoneIdx);
    expect(tx1DoneIdx).toBeLessThan(tx2WorkIdx);
  });

  it("unblocks the next transaction even if the current one fails", async () => {
    const tx1 = withTransaction(async () => {
      throw new Error("tx1 failed");
    }).catch(() => {
      /* expected */
    });

    let tx2Ran = false;
    const tx2 = withTransaction(async () => {
      tx2Ran = true;
    });

    await Promise.all([tx1, tx2]);

    expect(tx2Ran).toBe(true);
  });

  it("does NOT deadlock when the callback uses the wrapped db's execute/select", async () => {
    // Regression guard for the re-entrant serialize deadlock: a callback that
    // performs its own DB writes via the wrapped database must complete rather
    // than hang forever (which would also freeze every other DB user).
    const db = await getDb();
    let completed = false;
    await withTransaction(async () => {
      await db.execute("INSERT INTO threads (id) VALUES (1)");
      await db.select("SELECT 1");
      await db.execute("INSERT INTO messages (id) VALUES (1)");
      completed = true;
    });
    expect(completed).toBe(true);
  });
});

describe("getDb", () => {
  it("returns the same (wrapped) instance on repeated calls", async () => {
    const db1 = await getDb();
    const db2 = await getDb();
    expect(db1).toBe(db2);
  });

  it("funnels execute/select through the serialization queue", async () => {
    const db = await getDb();
    // Every DB method call should arrive at the underlying mock.
    await db.execute("SELECT 1");
    await db.select("SELECT 1");
    expect(mockExecute).toHaveBeenCalledWith("SELECT 1", undefined);
    expect(mockSelect).toHaveBeenCalledWith("SELECT 1", undefined);
  });
});
