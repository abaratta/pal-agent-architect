import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import type { receiveMessage } from "../../src/trigger/receive-message";
//     👆 type-only import — keeps the worker code out of the serverless bundle

// Vercel serverless function. Telegram POSTs updates here; we shape the
// payload and hand off to the Trigger.dev task, then return 200.
//
// NOTE: on serverless we must `await tasks.trigger()` BEFORE responding.
// The runtime freezes the function once the response is sent, so a
// "respond-first, trigger-after" pattern would drop the work. `tasks.trigger`
// only enqueues the run (a fast API call), so this stays well within
// Telegram's webhook timeout.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const message = req.body?.message;

  // No message in the update (edited messages, channel posts, etc.) — ack and move on.
  if (!message) {
    console.log("[webhook] Update has no message, acking");
    res.status(200).json({ ok: true });
    return;
  }

  const chat_id = String(message.chat?.id ?? "");
  const text: string | undefined = message.text;
  const first_name: string = message.from?.first_name ?? "User";
  const message_id: number = message.message_id;

  if (!chat_id) {
    console.log("[webhook] No chat_id found, acking");
    res.status(200).json({ ok: true });
    return;
  }

  console.log(`[webhook] Received update from chat_id=${chat_id} first_name=${first_name}`);

  try {
    const handle = await tasks.trigger<typeof receiveMessage>(
      "pal-architect/receive-message",
      { chat_id, text, first_name, message_id }
    );
    console.log(`[webhook] Triggered receive-message, run_id=${handle.id}`);
  } catch (err) {
    // Log but still ack — Telegram retries non-200s, and a retry storm won't
    // help if Trigger.dev is briefly unavailable.
    console.error("[webhook] Failed to trigger receive-message task:", err);
  }

  res.status(200).json({ ok: true });
}
