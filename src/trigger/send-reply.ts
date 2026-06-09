import { task } from "@trigger.dev/sdk/v3";

const TELEGRAM_MAX_LENGTH = 4096;

type SendReplyPayload = {
  chat_id: string;
  text: string;
};

export const sendReply = task({
  id: "pal-architect/send-reply",
  retry: { maxAttempts: 3 },
  run: async (payload: SendReplyPayload) => {
    const { chat_id, text } = payload;

    console.log(`[send-reply] Preparing reply for chat_id=${chat_id} (${text.length} chars)`);

    const chunks = splitMessage(text);
    console.log(`[send-reply] Sending ${chunks.length} chunk(s) to chat_id=${chat_id}`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`[send-reply] Sending chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);

      const res = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id,
            text: chunk,
            parse_mode: "Markdown",
          }),
        }
      );

      let result = (await res.json()) as { ok: boolean; description?: string };

      if (!result.ok) {
        const isParseError =
          result.description?.toLowerCase().includes("parse") ||
          result.description?.toLowerCase().includes("can't parse");

        if (isParseError) {
          console.warn(`[send-reply] Markdown failed, retrying as plain text (chunk ${i + 1})`);

          const plainRes = await fetch(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id, text: chunk }),
            }
          );
          result = (await plainRes.json()) as { ok: boolean; description?: string };
        }

        if (!result.ok) {
          console.error(`[send-reply] Telegram error on chunk ${i + 1}:`, result.description);
          throw new Error(`Telegram sendMessage failed: ${result.description}`);
        }
      }

      console.log(`[send-reply] Chunk ${i + 1}/${chunks.length} delivered`);
    }

    console.log(`[send-reply] All chunks delivered to chat_id=${chat_id}`);
  },
});

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Prefer splitting on a paragraph break, then a newline, then a space
    let breakPoint = TELEGRAM_MAX_LENGTH;

    const doubleNewline = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_LENGTH);
    const newline = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    const space = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);

    if (doubleNewline > TELEGRAM_MAX_LENGTH * 0.5) {
      breakPoint = doubleNewline;
    } else if (newline > TELEGRAM_MAX_LENGTH * 0.5) {
      breakPoint = newline;
    } else if (space > TELEGRAM_MAX_LENGTH * 0.5) {
      breakPoint = space;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}
