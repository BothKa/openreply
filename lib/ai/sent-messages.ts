/**
 * Message ids OpenReply itself sent.
 *
 * Instagram echoes every outbound DM back through the webhook, whether it came
 * from this app or from someone typing in the Instagram app. Remembering our
 * own ids lets the echo handler tell the two apart: an echo we didn't send
 * means a person replied by hand, so the AI should step back.
 */
import { getRedisConnection } from "@/lib/queue/client";

// Echoes arrive within seconds; a day leaves room for webhook retries.
const TTL_SECONDS = 24 * 60 * 60;

function key(messageId: string) {
  return `sent:mid:${messageId}`;
}

/** Best effort: a Redis hiccup must never fail a send that already went out. */
export async function rememberSent<T extends { message_id?: string }>(
  send: Promise<T>
): Promise<T> {
  const result = await send;
  if (result?.message_id) {
    try {
      await getRedisConnection().set(key(result.message_id), "1", "EX", TTL_SECONDS);
    } catch (error) {
      console.error("[ai] could not record sent mid:", error);
    }
  }
  return result;
}

export async function wasSentByUs(messageId: string): Promise<boolean> {
  return (await getRedisConnection().exists(key(messageId))) === 1;
}
