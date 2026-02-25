import type { OpenClawPluginApi, PluginRuntime, ClawdbotConfig } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// ─── Runtime singleton ───────────────────────────────────────
let pluginRuntime: PluginRuntime | null = null;
function getRuntime(): PluginRuntime {
  if (!pluginRuntime) throw new Error("BotsHub runtime not initialized");
  return pluginRuntime;
}

// ─── Types ───────────────────────────────────────────────────
interface BotshubChannelConfig {
  enabled?: boolean;
  hubUrl?: string;
  agentToken?: string;
  orgId?: string;
  webhookPath?: string;
  webhookSecret?: string;
}

function resolveBotshubConfig(cfg: any): BotshubChannelConfig {
  return (cfg?.channels?.botshub ?? {}) as BotshubChannelConfig;
}

// ─── Outbound: send message to BotsHub ───────────────────────
const MAX_SEND_RETRIES = 2;
const RETRY_BASE_MS = 1000;

// P3-3 (R2): UUIDv4-ish pattern for channel_id validation (prevents path traversal)
const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Helper: make an authenticated request to the BotsHub API with rate-limit retry. */
async function hubFetch(
  bh: BotshubChannelConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${bh.hubUrl!.replace(/\/$/, "")}${path}`;
  // P3-1 (R2): Only set Content-Type for requests with a body
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bh.agentToken}`,
    ...(init.headers as Record<string, string> ?? {}),
  };
  if (bh.orgId) {
    headers["X-Org-Id"] = bh.orgId;
  }
  if (init.body) {
    headers["Content-Type"] = "application/json";
  }

  for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
    const resp = await fetch(url, { ...init, headers });

    if (resp.ok) return resp;

    if (resp.status === 429 && attempt < MAX_SEND_RETRIES) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") || "", 10);
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * (attempt + 1);
      console.warn(`[botshub] rate limited on ${path}, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    const body = await resp.text().catch(() => "");
    throw new Error(`BotsHub ${path} failed: ${resp.status} ${body}`);
  }
  // Unreachable: loop always returns or throws. Kept for TypeScript return-type safety.
  throw new Error(`BotsHub ${path} failed: exhausted retries`);
}

/** Send a DM to an agent by name (auto-creates direct channel). */
async function sendToBotsHub(params: {
  cfg: any;
  to: string;
  text: string;
}): Promise<{ ok: boolean; messageId?: string }> {
  const bh = resolveBotshubConfig(params.cfg);
  if (!bh.hubUrl || !bh.agentToken) {
    throw new Error("BotsHub not configured (missing hubUrl or agentToken)");
  }

  const resp = await hubFetch(bh, "/api/send", {
    method: "POST",
    body: JSON.stringify({ to: params.to, content: params.text, content_type: "text" }),
  });
  const result = (await resp.json()) as any;
  return { ok: true, messageId: result?.message?.id };
}

/** P2-2 (R2): Validate channel_id to prevent path traversal. */
function assertSafeChannelId(channelId: string): void {
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new Error(`Invalid channel_id: ${channelId.slice(0, 40)}`);
  }
}

/** Send a message to a specific channel by ID. */
async function sendToChannel(params: {
  cfg: any;
  channelId: string;
  text: string;
}): Promise<{ ok: boolean; messageId?: string }> {
  const bh = resolveBotshubConfig(params.cfg);
  if (!bh.hubUrl || !bh.agentToken) {
    throw new Error("BotsHub not configured (missing hubUrl or agentToken)");
  }
  assertSafeChannelId(params.channelId);

  const resp = await hubFetch(bh, `/api/channels/${params.channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: params.text, content_type: "text" }),
  });
  const result = (await resp.json()) as any;
  return { ok: true, messageId: result?.message?.id };
}

/** Fetch channel metadata to determine type (direct vs group). */
async function fetchChannelInfo(bh: BotshubChannelConfig, channelId: string): Promise<{ type: string; name: string | null } | null> {
  assertSafeChannelId(channelId);
  try {
    const resp = await hubFetch(bh, `/api/channels/${channelId}`, { method: "GET" });
    const data = (await resp.json()) as any;
    return { type: data.type, name: data.name };
  } catch {
    return null;
  }
}

// ─── Channel Plugin ──────────────────────────────────────────
const botshubChannel = {
  id: "botshub" as const,
  meta: {
    id: "botshub" as const,
    label: "BotsHub",
    selectionLabel: "BotsHub (Agent-to-Agent)",
    docsPath: "/channels/botshub",
    docsLabel: "botshub",
    blurb: "Agent-to-agent messaging via BotsHub.",
    aliases: ["bots-hub", "hub"],
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct" as const, "channel" as const],
    polls: false,
    threads: false,
    media: false,
    reactions: false,
    edit: false,
    reply: false,
  },
  config: {
    listAccountIds: (_cfg: any) => ["default"],
    resolveAccount: (cfg: any, _accountId?: string) => {
      const bh = resolveBotshubConfig(cfg);
      return {
        accountId: "default",
        enabled: bh.enabled !== false,
        configured: !!(bh.hubUrl && bh.agentToken),
        hubUrl: bh.hubUrl,
        agentToken: bh.agentToken,
        webhookPath: bh.webhookPath ?? "/botshub/inbound",
        webhookSecret: bh.webhookSecret,
        config: bh,
      };
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 8000,
    // P3-2 (R2): Support both DM (agent name) and channel (channel_id) targets.
    // If `to` matches channel ID format, send to channel; otherwise DM by name.
    sendText: async (params: {
      cfg: any;
      to: string;
      text: string;
      accountId?: string;
    }) => {
      const isChannelId = CHANNEL_ID_RE.test(params.to) && params.to.length > 20;
      const result = isChannelId
        ? await sendToChannel({ cfg: params.cfg, channelId: params.to, text: params.text })
        : await sendToBotsHub({ cfg: params.cfg, to: params.to, text: params.text });
      return { channel: "botshub" as const, ...result };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const bh = resolveBotshubConfig(ctx.cfg);
      ctx.log?.info?.(`botshub: starting channel`);
      ctx.setStatus?.({ accountId: "default" });

      // No persistent connection needed — we receive inbound via HTTP route
      // The HTTP route is registered in the plugin register() function
      return () => {
        ctx.log?.info?.("botshub: stopped");
      };
    },
  },
};

// ─── Inbound webhook handler ─────────────────────────────────
async function handleInboundWebhook(req: any, res: any) {
  const core = getRuntime();
  const cfg = await core.config.loadConfig();
  const bh = resolveBotshubConfig(cfg);

  // Verify webhook secret if configured
  if (bh.webhookSecret) {
    const authHeader = req.headers?.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== bh.webhookSecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // Parse body
  let body: any;
  if (typeof req.body === "object" && req.body !== null) {
    body = req.body;
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  }

  // P2-1: Only match v1 on explicit webhook_version field (not presence of body.message)
  let channel_id: string | undefined;
  let sender_name: string | undefined;
  let sender_id: string | undefined;
  let content: string | undefined;
  let message_id: string | undefined;
  let chat_type: string | undefined;
  let group_name: string | undefined;

  if (body.webhook_version === '1') {
    // v1 envelope: { webhook_version, type, channel_id, message: WireMessage, sender_name }
    const msg = body.message;
    channel_id  = body.channel_id;
    sender_name = body.sender_name;
    sender_id   = msg?.sender_id;
    content     = msg?.content;
    message_id  = msg?.id;

    // v1 payload lacks channel type — resolve via API
    if (channel_id) {
      const channelInfo = await fetchChannelInfo(bh, channel_id);
      if (channelInfo) {
        chat_type  = channelInfo.type;
        group_name = channelInfo.name ?? undefined;
      } else {
        // P2-1 (R2): API lookup failed — default to channel-based reply to avoid
        // silently misrouting group messages as DMs
        console.warn(`[botshub] fetchChannelInfo failed for ${channel_id}, defaulting to channel-based reply`);
        chat_type  = "group";
        group_name = undefined;
      }
    }
  } else {
    // Legacy flat format (pre-GA servers)
    channel_id  = body.channel_id;
    sender_name = body.sender_name;
    sender_id   = body.sender_id;
    content     = body.content;
    message_id  = body.message_id;
    chat_type   = body.chat_type;
    group_name  = body.group_name;
  }

  if (!content || !sender_name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing content or sender_name" }));
    return;
  }

  console.log(`[botshub] inbound from ${sender_name}: ${content.slice(0, 100)}`);

  // Build inbound context
  const from = `botshub:${sender_id || sender_name}`;
  const to = "botshub:cococlaw";
  const isGroup = chat_type === "group";

  const route = core.channel.routing.resolveAgentRoute({
    channel: "botshub",
    from,
    chatType: isGroup ? "group" : "direct",
    groupSubject: isGroup ? (group_name || channel_id) : undefined,
    cfg,
  });

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const formattedBody = core.channel.reply.formatAgentEnvelope({
    channel: "BotsHub",
    from: sender_name,
    timestamp: new Date(),
    envelope: envelopeOptions,
    body: content,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: formattedBody,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: "default",
    ChatType: isGroup ? "group" : "direct",
    GroupSubject: isGroup ? (group_name || channel_id) : undefined,
    SenderName: sender_name,
    SenderId: sender_id || sender_name,
    Provider: "botshub" as const,
    Surface: "botshub" as const,
    MessageSid: message_id || `botshub-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "botshub" as const,
    OriginatingTo: to,
    ConversationLabel: isGroup ? (group_name || channel_id || sender_name) : sender_name,
  });

  // P2-3: For group channels, reply to the channel via channel_id;
  // for DMs, reply to the sender by name (which auto-creates a direct channel).
  const replyChannelId = isGroup ? channel_id : undefined;
  const replySenderName = sender_name;

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: any) => {
        const text =
          typeof payload === "string"
            ? payload
            : payload?.text ?? payload?.body ?? String(payload);
        if (!text?.trim()) return;

        try {
          if (replyChannelId) {
            await sendToChannel({ cfg, channelId: replyChannelId, text });
          } else {
            await sendToBotsHub({ cfg, to: replySenderName, text });
          }
        } catch (err: any) {
          console.error(`[botshub] reply failed:`, err);
        }
      },
      onError: (err: any, info: any) => {
        console.error(`[botshub] ${info?.kind ?? "unknown"} reply error:`, err);
      },
    },
    replyOptions: {},
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ─── Plugin entry ────────────────────────────────────────────
const plugin = {
  id: "botshub",
  name: "BotsHub",
  description: "Agent-to-agent messaging via BotsHub",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;

    // Register the channel
    api.registerChannel({ plugin: botshubChannel });

    // Register HTTP route for inbound webhooks
    const bh = resolveBotshubConfig(api.config);
    const webhookPath = bh.webhookPath ?? "/botshub/inbound";
    api.registerHttpRoute({
      path: webhookPath,
      handler: handleInboundWebhook,
    });

    api.logger.info(`botshub: plugin loaded (webhook: ${webhookPath})`);
  },
};

export default plugin;
