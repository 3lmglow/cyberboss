const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

class ReminderQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.dbPath = path.join(path.dirname(filePath), "reminder-outbox.sqlite");
  }

  // The MCP process creates timers while the bridge settles others. Never
  // implement this as read/modify/rewrite of one shared JSON array.
  transaction(fn) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      if (!db.prepare("PRAGMA user_version").get().user_version) {
        db.exec(`CREATE TABLE reminders (id TEXT PRIMARY KEY, account TEXT NOT NULL, due INTEGER NOT NULL,
          check_at INTEGER NOT NULL, sending INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
          CREATE INDEX reminder_check ON reminders(account,sending,check_at); PRAGMA user_version=1;`);
        if (fs.existsSync(this.filePath)) {
          const { reminders } = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
          for (const item of reminders) this.insert(db, item);
        }
      }
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } finally {
      db.close(); // rolls back an incomplete transaction, including the one-time import
    }
  }

  insert(db, reminder) {
    const normalized = normalizeReminder(reminder);
    if (!normalized) throw new Error("invalid reminder");
    db.prepare("INSERT INTO reminders(id,account,due,check_at,payload) VALUES(?,?,?,?,?)")
      .run(normalized.id, normalized.accountId, normalized.dueAtMs, 0, JSON.stringify(normalized));
    return normalized;
  }

  enqueue(reminder) { return this.transaction(db => this.insert(db, reminder)); }

  listDue(nowMs, account) {
    return this.transaction(db => db.prepare("DELETE FROM reminders WHERE account=? AND due<=? AND sending=0 RETURNING payload")
      .all(account, nowMs).map(r => JSON.parse(r.payload)));
  }

  listChecks(account, nowMs) {
    return this.transaction(db => db.prepare("SELECT payload FROM reminders WHERE account=? AND sending=0 AND check_at<=? ORDER BY due,id LIMIT 16")
      .all(account, nowMs).map(r => JSON.parse(r.payload)));
  }

  retryAt(id, at) {
    this.transaction(db => db.prepare("UPDATE reminders SET check_at=? WHERE id=? AND sending=0").run(at,id));
  }
  claimDelivery(id) {
    return this.transaction(db => db.prepare("UPDATE reminders SET sending=1,payload='{}' WHERE id=? AND sending=0").run(id).changes === 1);
  }
  retryRejected(item, at) {
    this.transaction(db => db.prepare("UPDATE reminders SET sending=0,payload=?,check_at=? WHERE id=? AND sending=1")
      .run(JSON.stringify(item), at, item.id));
  }
  finish(id) {
    this.transaction(db => db.prepare("DELETE FROM reminders WHERE id=?").run(id));
  }
  peekNextDueAtMs(account, managed) {
    return this.transaction(db => db.prepare(`SELECT min(${managed ? "max(check_at,1)" : "due"}) AS t FROM reminders WHERE account=? AND sending=0`)
      .get(account || "").t || 0);
  }
}

function normalizeReminder(reminder) {
  if (!reminder || typeof reminder !== "object") {
    return null;
  }
  const id = typeof reminder.id === "string" ? reminder.id.trim() : "";
  const accountId = typeof reminder.accountId === "string" ? reminder.accountId.trim() : "";
  const senderId = typeof reminder.senderId === "string" ? reminder.senderId.trim() : "";
  const contextToken = typeof reminder.contextToken === "string" ? reminder.contextToken.trim() : "";
  const text = typeof reminder.text === "string" ? reminder.text.trim() : "";
  const dueAtMs = Number(reminder.dueAtMs);
  const createdAt = typeof reminder.createdAt === "string" ? reminder.createdAt.trim() : "";
  if (!id || !accountId || !senderId || !contextToken || !text || !Number.isFinite(dueAtMs) || dueAtMs <= 0) {
    return null;
  }
  return {
    id,
    accountId,
    senderId,
    contextToken,
    text,
    dueAtMs,
    createdAt: createdAt || new Date().toISOString(),
  };
}

module.exports = { ReminderQueueStore };
