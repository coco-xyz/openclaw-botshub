import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// Dynamic import for SDK (ESM compatibility)
let HxaConnectClient: any;

// ─── Runtime singleton ───────────────────────────────────────
let pluginRuntime: PluginRuntime | null = null;
function getRuntime(): PluginRuntime {
  if (!pluginRuntime) throw new Error("HXA-Connect runtime not initialized");
  return pluginRuntime;
}

// ─── Types ───────────────────────────────────────────────────
interface HxaConnectChannelConfig {
  enabled?: boolean;
  hubUrl?: string;
  agentToken?: string;
  orgId?: string;
  webhookPath?: string;
  webhookSecret?: string;
  // Mode: 'sdk' (default, WebSocket via SDK) | 'webhook' (HTTP only) | 'auto'
  mode?: 'sdk' | 'webhook' | 'auto';
}

function resolveHxaConnectConfig(cfg: any): HxaConnectChannelConfig {
  return (cfg?.channels?.['hxa-connect'] ?? {}) as HxaConnectChannelConfig;
}

// ─── SDK Client Instance ─────────────────────────────────────
let sdkClient: any = null;

/** Initialize SDK client */
async function initSdkClient(cfg: HxaConnectChannelConfig, runtime: PluginRuntime): Promise<any> {
  if (!cfg.hubUrl || !cfg.agentToken) {
    throw new Error("HXA-Connect not configured (missing hubUrl or agentToken)");
  }

  // Lazy load SDK
  if (!HxaConnectClient) {
    const sdk = await import('hxa-connect-sdk');
    HxaConnectClient = sdk.HxaConnectClient;
  }

  const client = new HxaConnectClient({
    url: cfg.hubUrl,
    token: cfg.agentToken,
    orgId: cfg.orgId,
  });

  // Set up event handlers before connecting
  client.on('message', (event: any) => {
    handleSdkMessage(event, runtime, cfg);
  });

  client.on('thread_message', (event: any) => {
    runtime.logger?.info?.(`[hxa-connect] thread message in ${event.thread_id}`);
    // Could be extended to support threads
  });

  client.on('bot_online', (event: any) => {
    runtime.logger?.debug?.(`[hxa-connect] ${event.bot.name} came online`);
  });

  client.on('bot_offline', (event: any) => {
    runtime.logger?.debug?.(`[hxa-connect] ${event.bot.name} went offline`);
  });

  client.on('error', (event: any) => {
    runtime.logger?.error?.(`[hxa-connect] SDK error:`, event.message);
  });

  client.on('close', () => {
    runtime.logger?.warn?.('[hxa-connect] WebSocket disconnected');
    runtime.setStatus?.({ accountId: 'default', status: 'disconnected' });
  });

  // Connect to Hub (sets bot online)
  await client.connect();
  runtime.logger?.info?.('[hxa-connect] SDK connected, bot is online');
  runtime.setStatus?.({ accountId: 'default', status: 'connected' });

  return client;
}

/** Disconnect SDK client */
async function disconnectSdkClient(): Promise<void> {
  if (sdkClient) {
    sdkClient.disconnect();
    sdkClient = null;
  }
}

// ─── SDK Message Handler ─────────────────────────────────────
async function handleSdkMessage(
  event: any,
  runtime: PluginRuntime,
  cfg: HxaConnectChannelConfig
): Promise<void> {
  const { channel_id, message, sender_name, sender_id } = event;
  const content = message?.content;
  const message_id = message?.id;

  if (!content || !sender_name) {
    runtime.logger?.warn?.('[hxa-connect] received message without content or sender');
    return;
  }

  runtime.logger?.info?.(`[hxa-connect] message from ${sender_name}: ${content.slice(0, 100)}`);

  // Get channel info for chat type
  let chat_type = 'direct';
  let group_name: string | undefined;
  
  if (channel_id && sdkClient) {
    try {
      const channel = await sdkClient.getChannel(channel_id);
      chat_type = channel?.type || 'direct';
      group_name = channel?.name;
    } catch (err) {
      runtime.logger?.warn?.(`[hxa-connect] failed to get channel info for ${channel_id}`);
    }
  }

  const isGroup = chat_type === 'group';
  await dispatchInboundMessage({
    runtime,
    cfg,
    channel_id,
    sender_name,
    sender_id,
    content,
    message_id,
    chat_type,
    group_name,
    isGroup,
  });
}

// ─── Outbound: send message to HXA-Connect ───────────────────────
const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Send a DM to an agent by name (uses SDK if available, else HTTP) */
async function sendToHxaConnect(params: {
  cfg: any;
  to: string;
  text: string;
}): Promise<{ ok: boolean; messageId?: string }> {
  const bh = resolveHxaConnectConfig(params.cfg);
  
  // Use SDK if connected
  if (sdkClient) {
    const result = await sdkClient.send(params.to, params.text);
    return { ok: true, messageId: result?.message?.id };
  }
  
  // Fallback to HTTP API
  const resp = await hubFetch(bh, "/api/send", {
    method: "POST",
    body: JSON.stringify({ to: params.to, content: params.text, content_type: "text" }),
  });
  const result = (await resp.json()) as any;
  return { ok: true, messageId: result?.message?.id };
}

/** Send a message to a specific channel */
async function sendToChannel(params: {
  cfg: any;
  channelId: string;
  text: string;
}): Promise<{ ok: boolean; messageId?: string }> {
  const bh = resolveHxaConnectConfig(params.cfg);
  
  // Use SDK if connected
  if (sdkClient) {
    const result = await sdkClient.sendMessage(params.channelId, params.text);
    return { ok: true, messageId: result?.message?.id };
  }
  
  // Fallback to HTTP API
  assertSafeChannelId(params.channelId);
  const resp = await hubFetch(bh, `/api/channels/${params.channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: params.text, content_type: "text" }),
  });
  const result = (await resp.json()) as any;
  return { ok: true, messageId: result?.message?.id };
}

/** HTTP fallback for when SDK is not connected */
async function hubFetch(
  bh: HxaConnectChannelConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${bh.hubUrl!.replace(/\/$/, "")}${path}`;
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

  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HXA-Connect ${path} failed: ${resp.status} ${body}`);
  }
  return resp;
}

/** Validate channel_id */
function assertSafeChannelId(channelId: string): void {
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new Error(`Invalid channel_id: ${channelId.slice(0, 40)}`);
  }
}

// ─── Inbound Message Dispatch ────────────────────────────────
async function dispatchInboundMessage(params: {
  runtime: PluginRuntime;
  cfg: any;
  channel_id?: string;
  sender_name: string;
  sender_id?: string;
  content: string;
  message_id?: string;
  chat_type?: string;
  group_name?: string;
  isGroup: boolean;
}): Promise<void> {
  const { runtime, cfg, channel_id, sender_name, sender_id, content, message_id, group_name, isGroup } = params;

  const from = `hxa-connect:${sender_id || sender_name}`;
  const to = "hxa-connect:cococlaw";

  const route = runtime.channel.routing.resolveAgentRoute({
    channel: "hxa-connect",
    from,
    chatType: isGroup ? "group" : "direct",
    groupSubject: isGroup ? (group_name || channel_id) : undefined,
    cfg,
  });

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const formattedBody = runtime.channel.reply.formatAgentEnvelope({
    channel: "HXA-Connect",
    from: sender_name,
    timestamp: new Date(),
    envelope: envelopeOptions,
    body: content,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
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
    Provider: "hxa-connect" as const,
    Surface: "hxa-connect" as const,
    MessageSid: message_id || `hxa-connect-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "hxa-connect" as const,
    OriginatingTo: to,
    ConversationLabel: isGroup ? (group_name || channel_id || sender_name) : sender_name,
  });

  const replyChannelId = isGroup ? channel_id : undefined;
  const replySenderName = sender_name;

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: any) => {
        const text = typeof payload === "string" ? payload : payload?.text ?? payload?.body ?? String(payload);
        if (!text?.trim()) return;

        try {
          if (replyChannelId) {
            await sendToChannel({ cfg, channelId: replyChannelId, text });
          } else {
            await sendToHxaConnect({ cfg, to: replySenderName, text });
          }
        } catch (err: any) {
          console.error(`[hxa-connect] reply failed:`, err);
        }
      },
      onError: (err: any, info: any) => {
        console.error(`[hxa-connect] ${info?.kind ?? "unknown"} reply error:`, err);
      },
    },
    replyOptions: {},
  });
}

// ─── Inbound webhook handler (fallback mode) ─────────────────
async function handleInboundWebhook(req: any, res: any) {
  const runtime = getRuntime();
  const cfg = await runtime.config.loadConfig();
  const bh = resolveHxaConnectConfig(cfg);

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

  // Handle v1 and legacy formats
  let channel_id: string | undefined;
  let sender_name: string | undefined;
  let sender_id: string | undefined;
  let content: string | undefined;
  let message_id: string | undefined;
  let chat_type: string | undefined;
  let group_name: string | undefined;

  if (body.webhook_version === '1') {
    const msg = body.message;
    channel_id = body.channel_id;
    sender_name = body.sender_name;
    sender_id = msg?.sender_id;
    content = msg?.content;
    message_id = msg?.id;

    if (channel_id) {
      try {
        if (sdkClient) {
          const channel = await sdkClient.getChannel(channel_id);
          chat_type = channel?.type;
          group_name = channel?.name;
        } else {
          chat_type = "group";
        }
      } catch {
        chat_type = "group";
      }
    }
  } else {
    channel_id = body.channel_id;
    sender_name = body.sender_name;
    sender_id = body.sender_id;
    content = body.content;
    message_id = body.message_id;
    chat_type = body.chat_type;
    group_name = body.group_name;
  }

  if (!content || !sender_name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing content or sender_name" }));
    return;
  }

  console.log(`[hxa-connect] webhook inbound from ${sender_name}: ${content.slice(0, 100)}`);

  await dispatchInboundMessage({
    runtime,
    cfg,
    channel_id,
    sender_name,
    sender_id,
    content,
    message_id,
    chat_type,
    group_name,
    isGroup: chat_type === "group",
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ─── Channel Plugin ──────────────────────────────────────────
const hxaConnectChannel = {
  id: "hxa-connect" as const,
  meta: {
    id: "hxa-connect" as const,
    label: "HXA-Connect",
    selectionLabel: "HXA-Connect (Agent-to-Agent)",
    docsPath: "/channels/hxa-connect",
    docsLabel: "hxa-connect",
    blurb: "Agent-to-agent messaging via HXA-Connect.",
    aliases: ["hxa-connect", "hub"],
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
      const bh = resolveHxaConnectConfig(cfg);
      return {
        accountId: "default",
        enabled: bh.enabled !== false,
        configured: !!(bh.hubUrl && bh.agentToken),
        hubUrl: bh.hubUrl,
        agentToken: bh.agentToken,
        mode: bh.mode || 'sdk',
        webhookPath: bh.webhookPath ?? "/hxa-connect/inbound",
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
      const isChannelId = CHANNEL_ID_RE.test(params.to) && params.to.length > 20;
      const result = isChannelId
        ? await sendToChannel({ cfg: params.cfg, channelId: params.to, text: params.text })
        : await sendToHxaConnect({ cfg: params.cfg, to: params.to, text: params.text });
      return { channel: "hxa-connect" as const, ...result };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const bh = resolveHxaConnectConfig(ctx.cfg);
      const mode = bh.mode || 'sdk';
      
      ctx.log?.info?.(`[hxa-connect] starting channel (mode: ${mode})`);
      ctx.setStatus?.({ accountId: "default" });

      if (mode === 'sdk' || mode === 'auto') {
        try {
          sdkClient = await initSdkClient(bh, ctx);
          ctx.log?.info?.('[hxa-connect] SDK mode active, bot is online');
        } catch (err) {
          ctx.log?.error?.('[hxa-connect] SDK connection failed:', err);
          if (mode === 'auto') {
            ctx.log?.info?.('[hxa-connect] falling back to webhook mode');
          } else {
            throw err;
          }
        }
      }

      return () => {
        disconnectSdkClient();
        ctx.log?.info?.("[hxa-connect] stopped");
      };
    },
  },
};

// ─── Plugin entry ────────────────────────────────────────────
const plugin = {
  id: "hxa-connect",
  name: "HXA-Connect",
  description: "Agent-to-agent messaging via HXA-Connect with SDK (WebSocket) support",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;

    // Register the channel
    api.registerChannel({ plugin: hxaConnectChannel });

    // Register HTTP route for inbound webhooks (fallback mode)
    const bh = resolveHxaConnectConfig(api.config);
    const webhookPath = bh.webhookPath ?? "/hxa-connect/inbound";
    api.registerHttpRoute({
      path: webhookPath,
      handler: handleInboundWebhook,
    });

    const mode = bh.mode || 'sdk';
    api.logger.info(`[hxa-connect] plugin loaded (mode: ${mode}, webhook: ${webhookPath})`);
  },
};

export default plugin;
