import { task, tasks } from "@trigger.dev/sdk";

const AIRTABLE_BASE_ID = "appV4SwdhwJJeby23";
const AIRTABLE_TABLE_ID = "tbl6bBVvPieFwIomB";
const BOT_NAME = "pal-architect";

type ReceiveMessagePayload = {
  chat_id: string;
  text: string | undefined;
  first_name: string;
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
    const { chat_id, text, first_name } = payload;

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

    // Send typing indicator while we work
    await sendTypingIndicator(chat_id);

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
  const res = await fetch("https://api.anthropic.com/v1/managed-agents/sessions", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({ agent_id: process.env.PAL_ARCHITECT_AGENT_ID }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create agent session: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

async function sendMessageToAgent(
  session_id: string,
  userMessage: string
): Promise<string> {
  const res = await fetch(
    `https://api.anthropic.com/v1/managed-agents/sessions/${session_id}/events`,
    {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        event: {
          type: "human_turn",
          content: [{ type: "text", text: userMessage }],
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Agent API error: ${res.status} ${err}`);
  }

  // Parse SSE stream — accumulate text_delta events
  const raw = await res.text();
  let fullText = "";

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6)) as {
        type: string;
        delta?: { type: string; text?: string };
      };
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text
      ) {
        fullText += event.delta.text;
      }
    } catch {
      // skip non-JSON lines (comments, empty data, etc.)
    }
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

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}
