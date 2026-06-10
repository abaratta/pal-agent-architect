import { task, tasks } from "@trigger.dev/sdk";

const AIRTABLE_BASE_ID = "appV4SwdhwJJeby23";
const AIRTABLE_TABLE_ID = "tbl6bBVvPieFwIomB";
const BOT_NAME = "pal-architect";

type ReceiveMessagePayload = {
  chat_id: string;
  text: string | undefined;
  first_name: string;
  message_id?: number;
};

type AirtableRecord = {
  id: string;
  fields: {
    chat_id?: string;
    session_id?: string;
    bot_name?: string;
    trigger?: string;
    status?: string;
    first_seen?: string;
    last_active?: string;
    message_count?: number;
  };
};

export const receiveMessage = task({
  id: "pal-architect/receive-message",
  retry: { maxAttempts: 3 },
  run: async (payload: ReceiveMessagePayload) => {
    const { chat_id, text, first_name, message_id } = payload;

    // 1. Ignore non-text messages silently
    if (!text) {
      console.log(`[receive-message] Ignoring non-text message from chat_id=${chat_id}`);
      return;
    }

    // 2. Handle /start and /reset commands
    if (text === "/start" || text === "/reset") {
      console.log(`[receive-message] Handling reset command from chat_id=${chat_id}`);

      const existingRecord = await findAirtableRecord(chat_id);

      if (existingRecord) {
        await updateAirtableRecord(existingRecord.id, { status: "reset" });
        console.log(`[receive-message] Reset record ${existingRecord.id} to status=reset`);
      } else {
        console.log(`[receive-message] No existing record found for chat_id=${chat_id}, skipping update`);
      }

      await tasks.trigger("pal-architect/send-reply", {
        chat_id,
        text: "Session reset. Starting fresh.",
      });

      console.log(`[receive-message] Reset reply queued for chat_id=${chat_id}`);
      return;
    }

    // 3. Handle regular messages
    console.log(`[receive-message] Processing message from chat_id=${chat_id}: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);

    // Send typing indicator + 👀 reaction so the user gets feedback while we
    // work. Non-blocking — runs in a long-lived worker, so it's reliable
    // without delaying the agent call. The reaction is cleared once the
    // response is ready (below).
    await sendTypingIndicator(chat_id);
    if (message_id !== undefined) {
      setMessageReaction(chat_id, message_id, "👀").catch((err) =>
        console.error("[receive-message] Failed to set reaction:", err)
      );
    }

    // Look up active session in Airtable
    const activeRecord = await findActiveAirtableRecord(chat_id);
    let session_id: string;

    if (!activeRecord) {
      // No active session — create new Claude Managed Agent session
      console.log(`[receive-message] No active session for chat_id=${chat_id}, creating new session`);

      session_id = await createAgentSession();
      console.log(`[receive-message] Created agent session_id=${session_id}`);

      const today = todayISO();
      await createAirtableRecord({
        chat_id,
        session_id,
        bot_name: BOT_NAME,
        trigger: "telegram",
        status: "active",
        first_seen: today,
        last_active: today,
        message_count: 1,
      });
      console.log(`[receive-message] Created Airtable record for chat_id=${chat_id}`);
    } else {
      session_id = (activeRecord.fields.session_id as string) ?? "";
      const currentCount = (activeRecord.fields.message_count as number) ?? 0;

      console.log(`[receive-message] Found active session_id=${session_id} for chat_id=${chat_id}, message_count=${currentCount}`);

      await updateAirtableRecord(activeRecord.id, {
        last_active: todayISO(),
        message_count: currentCount + 1,
      });
      console.log(`[receive-message] Updated Airtable record ${activeRecord.id}, message_count=${currentCount + 1}`);
    }

    // Send the user message to the agent and collect the streamed response
    console.log(`[receive-message] Sending message to agent session_id=${session_id}`);
    const agentResponse = await sendMessageToAgent(session_id, text);
    console.log(`[receive-message] Agent responded with ${agentResponse.length} chars`);

    // Response is ready — clear the 👀 reaction (empty array removes the bot's
    // reaction). Non-blocking; the reply is sent right after.
    if (message_id !== undefined) {
      setMessageReaction(chat_id, message_id, null).catch((err) =>
        console.error("[receive-message] Failed to clear reaction:", err)
      );
    }

    // Trigger send-reply (fire-and-forget — it has its own retry)
    await tasks.trigger("pal-architect/send-reply", {
      chat_id,
      text: agentResponse,
    });

    console.log(`[receive-message] Triggered send-reply for chat_id=${chat_id}`);
  },
});

// ── Airtable helpers ──────────────────────────────────────────────────────────

function airtableHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
    "Content-Type": "application/json",
  };
}

async function findAirtableRecord(chat_id: string): Promise<AirtableRecord | null> {
  const formula = encodeURIComponent(
    `AND({chat_id}="${chat_id}",{bot_name}="${BOT_NAME}")`
  );
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}?filterByFormula=${formula}`,
    { headers: airtableHeaders() }
  );
  const data = (await res.json()) as { records: AirtableRecord[] };
  return data.records[0] ?? null;
}

async function findActiveAirtableRecord(chat_id: string): Promise<AirtableRecord | null> {
  const formula = encodeURIComponent(
    `AND({chat_id}="${chat_id}",{bot_name}="${BOT_NAME}",{status}="active")`
  );
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}?filterByFormula=${formula}`,
    { headers: airtableHeaders() }
  );
  const data = (await res.json()) as { records: AirtableRecord[] };
  return data.records[0] ?? null;
}

async function createAirtableRecord(fields: Record<string, unknown>): Promise<void> {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`,
    {
      method: "POST",
      headers: airtableHeaders(),
      body: JSON.stringify({ fields }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable create failed: ${res.status} ${err}`);
  }
}

async function updateAirtableRecord(
  recordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}/${recordId}`,
    {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify({ fields }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable update failed: ${res.status} ${err}`);
  }
}

// ── Anthropic Managed Agents helpers ─────────────────────────────────────────

function anthropicHeaders() {
  return {
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "managed-agents-2026-04-01",
    "Content-Type": "application/json",
  };
}

async function createAgentSession(): Promise<string> {
  const body: Record<string, unknown> = {
    agent: process.env.PAL_ARCHITECT_AGENT_ID,
    environment_id: process.env.PAL_ARCHITECT_ENVIRONMENT_ID,
  };

  // The agent declares MCP servers (e.g. `airtable`), but MCP credentials live
  // in a vault that must be attached to the session at create time — they can't
  // live on the agent. Without this, MCP init fails with "no credential is
  // stored for this server URL". Supports comma-separated IDs for multiple vaults.
  const vaultIds = (process.env.PAL_ARCHITECT_VAULT_ID ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (vaultIds.length > 0) body.vault_ids = vaultIds;

  const res = await fetch("https://api.anthropic.com/v1/sessions", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create agent session: ${res.status} ${err}`);
  }

  // The Session object's identifier is `id` (e.g. "sesn_…"), not `session_id`.
  const data = (await res.json()) as { id: string };
  return data.id;
}

type AgentEvent = {
  type: string;
  content?: { type: string; text?: string }[];
  stop_reason?: { type: string };
  error?: { message?: string };
};

async function sendMessageToAgent(
  session_id: string,
  userMessage: string
): Promise<string> {
  // Managed Agents are asynchronous: POSTing the message only *enqueues* it.
  // The agent's reply arrives as `agent.message` events on the SSE stream, so
  // we must open the stream and read until the session goes idle/terminates.
  //
  // Stream-first ordering: open the stream BEFORE sending so we don't miss any
  // events (the stream has no replay and only delivers events emitted after it
  // opens).
  const streamRes = await fetch(
    `https://api.anthropic.com/v1/sessions/${session_id}/events/stream`,
    { headers: anthropicHeaders() }
  );

  if (!streamRes.ok || !streamRes.body) {
    const err = await streamRes.text();
    throw new Error(`Failed to open session stream: ${streamRes.status} ${err}`);
  }

  // Enqueue the user message.
  const sendRes = await fetch(
    `https://api.anthropic.com/v1/sessions/${session_id}/events`,
    {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: userMessage }] }],
      }),
    }
  );

  if (!sendRes.ok) {
    const err = await sendRes.text();
    // Drain the stream we opened so the connection doesn't dangle.
    await streamRes.body.cancel().catch(() => {});
    throw new Error(`Agent API error: ${sendRes.status} ${err}`);
  }

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;

          let event: AgentEvent;
          try {
            event = JSON.parse(payload) as AgentEvent;
          } catch {
            continue; // skip heartbeats / non-JSON lines
          }

          if (event.type === "agent.message") {
            for (const block of event.content ?? []) {
              if (block.type === "text" && block.text) fullText += block.text;
            }
          } else if (event.type === "session.error") {
            throw new Error(`Session error: ${event.error?.message ?? "unknown"}`);
          } else if (event.type === "session.status_terminated") {
            done = true;
          } else if (
            event.type === "session.status_idle" &&
            event.stop_reason?.type !== "requires_action"
          ) {
            // Idle with a terminal stop_reason (end_turn / retries_exhausted).
            done = true;
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return fullText;
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function sendTypingIndicator(chat_id: string): Promise<void> {
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, action: "typing" }),
    }
  );
}

// Set (or clear) a reaction on the user's message. Pass an emoji to react, or
// `null` to remove the bot's reaction (Telegram clears it on an empty array).
async function setMessageReaction(
  chat_id: string,
  message_id: number,
  emoji: string | null
): Promise<void> {
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setMessageReaction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        message_id,
        reaction: emoji ? [{ type: "emoji", emoji }] : [],
      }),
    }
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}
