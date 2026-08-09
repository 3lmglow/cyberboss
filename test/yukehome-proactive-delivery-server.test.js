const test = require("node:test");
const assert = require("node:assert/strict");

const { createYukehomeProactiveDeliveryServer } = require("../src/app/yukehome-proactive-delivery-server");
const { CyberbossApp } = require("../src/core/app");

const TOKEN = "test-token-with-at-least-thirty-two-characters";

test("loopback delivery server authenticates, normalizes, and deduplicates messages", async (t) => {
  const delivered = [];
  const server = createYukehomeProactiveDeliveryServer({
    port: 0,
    token: TOKEN,
    async deliver(payload) {
      delivered.push(payload);
      return { delivered: true };
    },
  });
  await server.start();
  t.after(() => server.close());
  const url = `http://${server.host}:${server.port}/deliveries`;

  const unauthorized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delivery_id: "run-1", text: "想你了" }),
  });
  assert.equal(unauthorized.status, 401);

  const request = () => fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      delivery_id: " run-1 ",
      user_id: " user-1 ",
      text: " 想你了 ",
    }),
  });
  const first = await request();
  const second = await request();

  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    accepted: true,
    duplicate: false,
    delivery_id: "run-1",
    deferred: false,
  });
  assert.equal(second.status, 202);
  assert.equal((await second.json()).duplicate, true);
  assert.deepEqual(delivered, [{ deliveryId: "run-1", userId: "user-1", text: "想你了" }]);
});

test("loopback delivery server rejects malformed payloads", async (t) => {
  const server = createYukehomeProactiveDeliveryServer({
    port: 0,
    token: TOKEN,
    async deliver() {},
  });
  await server.start();
  t.after(() => server.close());

  const response = await fetch(`http://${server.host}:${server.port}/deliveries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ delivery_id: "run-2", text: "" }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "delivery_text_invalid" });
});

test("Yuke Home proactive messages send immediately when WeChat context is fresh", async () => {
  const calls = [];
  const app = {
    config: { allowedUserIds: ["user-1"] },
    channelAdapter: {
      resolveAccount: () => ({ accountId: "account-1" }),
      getKnownContextTokens: () => ({ "user-1": "ctx-1" }),
    },
    runtimeAdapter: { getSessionStore: () => ({}) },
    streamDelivery: {
      async deliverSystemText(payload) {
        calls.push(payload);
        return { delivered: true };
      },
    },
  };

  const result = await CyberbossApp.prototype.deliverYukehomeProactiveMessage.call(app, {
    deliveryId: "direct-proactive:run-3",
    text: "外面下雨啦。",
  });

  assert.deepEqual(result, { delivered: true });
  assert.deepEqual(calls, [{
    deliveryId: "direct-proactive:run-3",
    userId: "user-1",
    text: "外面下雨啦。",
    contextToken: "ctx-1",
  }]);
});

test("Yuke Home proactive messages wait for the next inbound turn without a context token", async () => {
  const deferred = [];
  const app = {
    config: { allowedUserIds: ["user-1"] },
    channelAdapter: {
      resolveAccount: () => ({ accountId: "account-1" }),
      getKnownContextTokens: () => ({}),
    },
    runtimeAdapter: { getSessionStore: () => ({}) },
    async deferSystemReply(payload) {
      deferred.push(payload);
    },
  };

  const result = await CyberbossApp.prototype.deliverYukehomeProactiveMessage.call(app, {
    deliveryId: "direct-proactive:run-4",
    text: "忙完来找我。",
  });

  assert.deepEqual(result, { delivered: false, deferred: true });
  assert.deepEqual(deferred, [{
    threadId: "yukehome-proactive:direct-proactive:run-4",
    userId: "user-1",
    text: "忙完来找我。",
    kind: "system_reply",
  }]);
});
