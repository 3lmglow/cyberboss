const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { RuntimeContextStore } = require("../src/tools/runtime-context-store");

test("tool-process context reloads updates written by the bridge process", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-context-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "runtime-context.json");
  const toolProcessStore = new RuntimeContextStore({ filePath });
  const bridgeProcessStore = new RuntimeContextStore({ filePath });

  bridgeProcessStore.setActiveContext({
    workspaceRoot: "/workspace",
    runtimeId: "yukehome",
    threadId: "shared-main",
    bindingKey: "wechat-binding",
    accountId: "wechat-account",
    senderId: "wechat-user",
  });

  const resolved = toolProcessStore.resolveActiveContext({
    workspaceRoot: "/workspace",
    runtimeId: "yukehome",
  });
  assert.deepEqual({ ...resolved, updatedAt: "timestamp" }, {
    workspaceRoot: "/workspace",
    runtimeId: "yukehome",
    threadId: "shared-main",
    bindingKey: "wechat-binding",
    accountId: "wechat-account",
    senderId: "wechat-user",
    updatedAt: "timestamp",
  });
  assert.match(resolved.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
});
