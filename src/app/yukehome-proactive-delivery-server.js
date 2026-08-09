const crypto = require("crypto");
const http = require("http");

const MAX_BODY_BYTES = 64 * 1024;

function createYukehomeProactiveDeliveryServer({
  host = "127.0.0.1",
  port = 4320,
  token = "",
  deliver,
} = {}) {
  if (host !== "127.0.0.1") throw new Error("proactive delivery server must stay on loopback");
  if (normalizeText(token).length < 32) throw new Error("Yuke Home delivery token must contain at least 32 characters");
  if (typeof deliver !== "function") throw new Error("proactive delivery handler is required");

  let server = null;
  const deliveries = new Map();
  const api = {
    host,
    port: Number(port),
    async start() {
      if (server) return api;
      server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/deliveries") {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        if (!secureToken(req.headers.authorization, token)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const payload = normalizeDelivery(body);
          let current = deliveries.get(payload.deliveryId);
          const duplicate = Boolean(current);
          if (!current) {
            current = Promise.resolve(deliver(payload));
            deliveries.set(payload.deliveryId, current);
            trimDeliveryCache(deliveries);
            current.catch(() => deliveries.delete(payload.deliveryId));
          }
          const result = await current;
          sendJson(res, 202, {
            accepted: true,
            duplicate,
            delivery_id: payload.deliveryId,
            deferred: result?.deferred === true,
          });
        } catch (error) {
          sendJson(res, error?.status || 503, { error: error?.code || "delivery_failed" });
        }
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(port), host, resolve);
      });
      const address = server.address();
      api.port = typeof address === "object" && address ? address.port : Number(port);
      return api;
    },
    async close() {
      const current = server;
      server = null;
      if (!current) return;
      await new Promise((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
    },
  };
  return api;
}

function normalizeDelivery(value) {
  const deliveryId = normalizeText(value?.delivery_id);
  const userId = normalizeText(value?.user_id);
  const text = normalizeText(value?.text);
  if (!deliveryId || deliveryId.length > 256 || /[\u0000-\u001f\u007f]/u.test(deliveryId)) {
    throw requestError("delivery_id_invalid");
  }
  if (userId.length > 256 || /[\u0000-\u001f\u007f]/u.test(userId)) {
    throw requestError("user_id_invalid");
  }
  if (!text || text.length > 1_000) throw requestError("delivery_text_invalid");
  return { deliveryId, userId, text };
}

function requestError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 400;
  return error;
}

function secureToken(authorization, expected) {
  const value = String(authorization || "");
  const actual = Buffer.from(value.startsWith("Bearer ") ? value.slice(7) : "");
  const target = Buffer.from(normalizeText(expected));
  return actual.length === target.length && actual.length > 0 && crypto.timingSafeEqual(actual, target);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw requestError("delivery_body_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw requestError("delivery_json_invalid");
  }
}

function trimDeliveryCache(deliveries) {
  while (deliveries.size > 1_000) {
    deliveries.delete(deliveries.keys().next().value);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { createYukehomeProactiveDeliveryServer };
