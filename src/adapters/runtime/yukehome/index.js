const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { SessionStore } = require("../codex/session-store");

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_ATTACHMENTS = 9;

function createYukehomeRuntimeAdapter(config, options = {}) {
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: "yukehome",
  });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const listeners = new Set();
  const activeTurns = new Map();
  let readyState = null;

  const emit = (event) => {
    if (!event) return;
    for (const listener of listeners) listener(event, null);
  };

  async function requestJson(pathname, init = {}, timeoutMs = 15_000) {
    if (typeof fetchImpl !== "function") throw new Error("yukehome fetch is unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(resolveEndpoint(config.yukehomeBaseUrl, pathname), {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${normalizeText(config.yukehomeToken)}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(normalizeText(payload?.error) || `yukehome request failed (${response.status})`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function initialize() {
    if (readyState) return readyState;
    if (normalizeText(config.yukehomeToken).length < 32) {
      throw new Error("CYBERBOSS_YUKEHOME_TOKEN must contain at least 32 characters");
    }
    const status = await requestJson("/internal/cyberboss/status", { method: "GET" });
    if (status?.ready !== true) throw new Error("Yuke Home main runtime is not ready");
    const models = normalizeModelCatalog(status.models);
    if (models.length) sessionStore.setAvailableModelCatalog(models);
    readyState = {
      endpoint: resolveEndpoint(config.yukehomeBaseUrl, "/internal/cyberboss"),
      models,
      mainSessionId: status.main_session_id,
    };
    return readyState;
  }

  return {
    describe() {
      return {
        id: "yukehome",
        kind: "runtime",
        endpoint: resolveEndpoint(config.yukehomeBaseUrl, "/internal/cyberboss"),
        sessionsFile: config.sessionsFile,
        managedMainThread: true,
        capabilities: { nativeImageInput: true, toolImageRead: false },
      };
    },
    createClient() {
      return null;
    },
    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities() {
      return { nativeImageInput: true, toolImageRead: false };
    },
    initialize,
    async close() {
      const active = Array.from(activeTurns.keys());
      await Promise.allSettled(active.map((turnId) => this.cancelTurn({ turnId })));
      readyState = null;
    },
    async startFreshThreadDraft() {
      return { managedMainThread: true };
    },
    async resumeThread({ threadId }) {
      return { thread: { id: normalizeText(threadId) } };
    },
    async refreshThreadInstructions({ threadId }) {
      return { threadId, managedMainThread: true };
    },
    async compactThread() {
      throw new Error("Yuke Home manages main-thread compaction automatically");
    },
    async respondApproval() {
      throw new Error("Yuke Home tools use their configured approval policy");
    },
    async cancelTurn({ turnId }) {
      const normalizedTurnId = normalizeText(turnId);
      if (!normalizedTurnId) throw new Error("cancelTurn requires turnId");
      await requestJson(
        `/internal/cyberboss/turns/${encodeURIComponent(normalizedTurnId)}/interrupt`,
        { method: "POST", body: "{}" },
      );
      return { turnId: normalizedTurnId };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, model = "" }) {
      await initialize();
      const threadId = logicalMainThreadId(bindingKey);
      const turnId = deterministicClientMessageId({
        bindingKey,
        originMessageId: metadata.messageId,
      });
      sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, { model });

      if (activeTurns.has(turnId)) return { threadId, turnId };
      const body = {
        client_message_id: turnId,
        origin_message_id: normalizeText(metadata.messageId),
        origin_kind: normalizeText(metadata.originKind) || "user",
        message: normalizeText(text),
        attachments: await encodeRuntimeAttachments(attachments),
        ...(normalizeText(model) ? { model: normalizeText(model) } : {}),
      };
      const response = await fetchImpl(resolveEndpoint(config.yukehomeBaseUrl, "/internal/cyberboss/turns"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${normalizeText(config.yukehomeToken)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(normalizeText(payload?.error) || `Yuke Home turn failed (${response.status})`);
      }

      emit({ type: "runtime.turn.started", payload: { threadId, turnId } });
      const completion = consumeNdjsonEvents(response.body, (packet) => {
        mapBridgePacketToRuntimeEvents(packet, { threadId, turnId }).forEach(emit);
      }).catch((error) => {
        emit({
          type: "runtime.turn.failed",
          payload: { threadId, turnId, text: error instanceof Error ? error.message : String(error) },
        });
      }).finally(() => {
        activeTurns.delete(turnId);
      });
      activeTurns.set(turnId, { threadId, completion });
      return { threadId, turnId };
    },
  };
}

function resolveEndpoint(baseUrl, pathname) {
  const normalizedBase = normalizeText(baseUrl) || "http://127.0.0.1:3000";
  return new URL(pathname, normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`).toString();
}

function logicalMainThreadId(bindingKey) {
  const suffix = crypto.createHash("sha256").update(normalizeText(bindingKey) || "default").digest("hex").slice(0, 24);
  return `yukehome-main-${suffix}`;
}

function deterministicClientMessageId({ bindingKey, originMessageId }) {
  if (!normalizeText(originMessageId)) return crypto.randomUUID();
  const source = [normalizeText(bindingKey), normalizeText(originMessageId)].join("\u0000");
  const bytes = crypto.createHash("sha256").update(source).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function encodeRuntimeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`Yuke Home accepts at most ${MAX_ATTACHMENTS} attachments`);
  let totalBytes = 0;
  const encoded = [];
  for (const [index, attachment] of attachments.entries()) {
    const absolutePath = normalizeText(attachment?.absolutePath);
    if (!absolutePath || !path.isAbsolute(absolutePath)) {
      throw new Error(`attachment ${index + 1} has no absolute path`);
    }
    const data = await fs.readFile(absolutePath);
    if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment ${index + 1} has an unsupported size`);
    }
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("Yuke Home accepts at most 30 MB of attachments per turn");
    }
    const mediaType = normalizeText(attachment?.contentType) || "application/octet-stream";
    const isImage = Boolean(attachment?.isImage) || mediaType.startsWith("image/");
    encoded.push({
      name: path.basename(normalizeText(attachment?.fileName) || absolutePath),
      media_type: mediaType,
      kind: isImage ? "image" : "document",
      data: data.toString("base64"),
    });
  }
  return encoded;
}

async function consumeNdjsonEvents(stream, onPacket) {
  if (!stream || typeof stream.getReader !== "function") throw new Error("Yuke Home returned no event stream");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() || "";
    for (const line of lines) emitPacketLine(line, onPacket);
    if (done) break;
  }
  if (buffer.trim()) emitPacketLine(buffer, onPacket);
}

function emitPacketLine(line, onPacket) {
  const normalized = String(line || "").trim();
  if (!normalized) return;
  let packet;
  try {
    packet = JSON.parse(normalized);
  } catch {
    throw new Error("Yuke Home returned an invalid event frame");
  }
  onPacket(packet);
}

function mapBridgePacketToRuntimeEvents(packet, { threadId, turnId }) {
  const event = normalizeText(packet?.event);
  const data = packet?.data || {};
  if (event === "text_delta" && data.text) {
    return [{
      type: "runtime.reply.delta",
      payload: { threadId, turnId, itemId: "assistant", text: String(data.text) },
    }];
  }
  if (event === "done") {
    const reply = String(data.reply || data?.assistant_message?.content || "");
    const events = [];
    if (reply) {
      events.push({
        type: "runtime.reply.completed",
        payload: { threadId, turnId, itemId: "assistant", text: reply },
      });
    }
    const inputTokens = Number(data?.assistant_message?.input_tokens);
    const contextWindow = Number(data?.assistant_message?.context_window_tokens);
    if (Number.isFinite(inputTokens) || Number.isFinite(contextWindow)) {
      events.push({
        type: "runtime.context.updated",
        payload: {
          runtimeId: "yukehome",
          threadId,
          inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
          currentTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
          contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0,
        },
      });
    }
    events.push({ type: "runtime.turn.completed", payload: { threadId, turnId, text: reply } });
    return events;
  }
  if (event === "error") {
    return [{
      type: "runtime.turn.failed",
      payload: { threadId, turnId, text: normalizeText(data.error) || "Yuke Home turn failed" },
    }];
  }
  return [];
}

function normalizeModelCatalog(models) {
  if (!Array.isArray(models)) return [];
  return models.map((model) => ({
    id: normalizeText(model?.value || model?.id),
    displayName: normalizeText(model?.label || model?.displayName || model?.value || model?.id),
    inputModalities: Array.isArray(model?.input_modalities)
      ? model.input_modalities
      : ["text", "image"],
  })).filter((model) => model.id);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  consumeNdjsonEvents,
  createYukehomeRuntimeAdapter,
  deterministicClientMessageId,
  encodeRuntimeAttachments,
  logicalMainThreadId,
  mapBridgePacketToRuntimeEvents,
};
