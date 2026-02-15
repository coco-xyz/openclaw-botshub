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
  webhookPath?: string;
  webhookSecret?: string;
}

function resolveBotshubConfig(cfg: any): BotshubChannelConfig {
  return (cfg?.channels?.botshub ?? {}) as BotshubChannelConfig;
}

// ─── Outbound: send message to BotsHub ───────────────────────
async function sendToBotsHub(params: {
  cfg: any;
  to: string;
  text: string;
}): Promise<{ ok: boolean; messageId?: string }> {
  const bh = resolveBotshubConfig(params.cfg);
  if (!bh.hubUrl || !bh.agentToken) {
    throw new Error("BotsHub not configured (missing hubUrl or agentToken)");
  }

  const url = `${bh.hubUrl.replace(/\/$/, "")}/api/send`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bh.agentToken}`,
    },
    body: JSON.stringify({
      to: params.to,
      content: params.text,
      content_type: "text",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`BotsHub send failed: ${resp.status} ${body}`);
  }

  const result = (await resp.json()) as any;
  return { ok: true, messageId: result?.message?.id };
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
    sendText: async (params: {
      cfg: any;
      to: string;
      text: string;
      accountId?: string;
    }) => {
      const result = await sendToBotsHub({
        cfg: params.cfg,
        to: params.to,
        text: params.text,
      });
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

  const {
    channel_id,
    sender_name,
    sender_id,
    content,
    message_id,
    chat_type,
    group_name,
  } = body;

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
    ConversationLabel: sender_name,
  });

  // Dispatch to agent using the buffered block dispatcher
  const replyTarget = sender_name;

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

        await sendToBotsHub({ cfg, to: replyTarget, text }).catch((err: any) =>
          console.error(`[botshub] reply to ${replyTarget} failed:`, err),
        );
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
