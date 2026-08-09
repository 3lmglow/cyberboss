const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  createYukehomeRuntimeAdapter,
  deterministicClientMessageId,
  encodeRuntimeAttachments,
  logicalMainThreadId,
  mapBridgePacketToRuntimeEvents,
} = require("../src/adapters/runtime/yukehome");

test("managed thread ids are stable per binding and message ids are idempotent", () => {
  assert.equal(logicalMainThreadId("binding-a"), logicalMainThreadId("binding-a"));
  assert.notEqual(logicalMainThreadId("binding-a"), logicalMainThreadId("binding-b"));
  const first = deterministicClientMessageId({
    bindingKey: "binding-a",
    originMessageId: "wechat-123",
    text: "hello",
  });
  assert.equal(first, deterministicClientMessageId({
    bindingKey: "binding-a",
    originMessageId: "wechat-123",
    text: "a redelivery may reconstruct different presentation text",
  }));
  assert.match(first, /^[0-9a-f-]{36}$/u);
});

test("bridge packets map only the owned response into runtime events", () => {
  const events = mapBridgePacketToRuntimeEvents({
    event: "done",
    data: {
      reply: "shared-memory reply",
      assistant_message: { input_tokens: 120, context_window_tokens: 1000 },
    },
  }, { threadId: "logical-main", turnId: "turn-1" });
  assert.deepEqual(events.map((event) => event.type), [
    "runtime.reply.completed",
    "runtime.context.updated",
    "runtime.turn.completed",
  ]);
  assert.equal(events[0].payload.text, "shared-memory reply");
  assert.deepEqual(
    mapBridgePacketToRuntimeEvents({ event: "ping", data: {} }, {
      threadId: "logical-main",
      turnId: "turn-1",
    }),
    [],
  );
});

test("runtime adapter streams one Yuke Home turn and keeps CyberBoss session routing", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/status")) {
      return new Response(JSON.stringify({
        ready: true,
        main_session_id: 9,
        models: [{ value: "gpt-test", label: "GPT Test" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response([
      JSON.stringify({ event: "text_delta", data: { text: "hello" } }),
      JSON.stringify({ event: "done", data: { reply: "hello" } }),
      "",
    ].join("\n"), { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };
  const stored = {};
  const sessionStore = {
    setAvailableModelCatalog(models) { stored.models = models; },
    setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata) {
      stored.binding = { bindingKey, workspaceRoot, threadId, metadata };
    },
    setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, params) {
      stored.params = { bindingKey, workspaceRoot, params };
    },
  };
  const adapter = createYukehomeRuntimeAdapter({
    sessionsFile: "unused",
    yukehomeBaseUrl: "http://127.0.0.1:3000",
    yukehomeToken: "x".repeat(32),
  }, { fetchImpl, sessionStore });
  const events = [];
  adapter.onEvent((event) => events.push(event));
  const turn = await adapter.sendTurn({
    bindingKey: "binding-a",
    workspaceRoot: "/workspace",
    text: "hello",
    metadata: { messageId: "wechat-123", originKind: "user" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turn.threadId, stored.binding.threadId);
  assert.equal(turn.turnId, deterministicClientMessageId({
    bindingKey: "binding-a",
    originMessageId: "wechat-123",
  }));
  assert.deepEqual(events.map((event) => event.type), [
    "runtime.turn.started",
    "runtime.reply.delta",
    "runtime.reply.completed",
    "runtime.turn.completed",
  ]);
  const requestBody = JSON.parse(calls[1].init.body);
  assert.equal(requestBody.client_message_id, turn.turnId);
  assert.equal(requestBody.origin_message_id, "wechat-123");
  assert.equal(stored.models[0].id, "gpt-test");
});

test("runtime attachments are carried as bounded base64 inputs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-yukehome-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, "photo.png");
  await fs.writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
  const [encoded] = await encodeRuntimeAttachments([{
    absolutePath: imagePath,
    fileName: "photo.png",
    contentType: "image/png",
    isImage: true,
  }]);
  assert.equal(encoded.kind, "image");
  assert.equal(encoded.media_type, "image/png");
  assert.equal(encoded.data, Buffer.from([1, 2, 3, 4]).toString("base64"));
});
