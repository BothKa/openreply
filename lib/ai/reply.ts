/**
 * AI fallback replies.
 *
 * A DM that matches no campaign keyword is queued here. If the account has AI
 * replies enabled and the conversation is still in BOT mode, Claude answers
 * from the account's knowledge base. When Claude calls `handoff_to_human` (or
 * declines), the conversation switches to HUMAN and is left alone until
 * someone hands it back from the dashboard.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  sendDirectMessage,
} from "@/lib/instagram/provider";
import type { ProcessAiReplyJob, ProcessEchoJob } from "@/lib/queue/client";
import { wasSentByUs } from "@/lib/ai/sent-messages";
import { notifyHandoff } from "@/lib/ai/notify";

export const DEFAULT_AI_MODEL = "claude-opus-5-5";
export const HISTORY_LIMIT = 10;
// Burst cap per conversation, so two bots (or a spammer) can't loop us.
export const MAX_REPLIES_PER_MINUTE = 3;
// Instagram rejects DM text above 1000 characters.
const MAX_DM_CHARS = 1000;

export const HANDOFF_MESSAGE =
  "這個問題我幫你轉給真人客服，請稍等一下，我們會盡快回覆你 🙏";

const HANDOFF_TOOL: Anthropic.Beta.BetaTool = {
  name: "handoff_to_human",
  description:
    "Hand this conversation to a human staff member. Use it for complaints, refunds, order problems, anything needing account access, or when the knowledge base does not answer the question. After calling it, the bot stops replying in this conversation.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "One short sentence on why a human is needed.",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

const BASE_INSTRUCTIONS = `You reply to Instagram direct messages on behalf of a brand.
- Answer only from the knowledge base below. If it does not cover the question, call handoff_to_human instead of guessing.
- Reply in the customer's language. Keep it short and friendly: plain text, at most 3 short paragraphs, no markdown.
- Never invent prices, stock, dates, discount codes, or policies.
- Call handoff_to_human for complaints, refunds, order or payment problems, or when the customer asks for a person.`;

export function buildSystemPrompt(settings: {
  systemPrompt: string;
  knowledgeBase: string;
}): string {
  const parts = [BASE_INSTRUCTIONS];
  if (settings.systemPrompt.trim()) {
    parts.push(`<brand_instructions>\n${settings.systemPrompt.trim()}\n</brand_instructions>`);
  }
  parts.push(
    `<knowledge_base>\n${settings.knowledgeBase.trim() || "(empty)"}\n</knowledge_base>`
  );
  return parts.join("\n\n");
}

/** Oldest-first history → Messages API turns. The first turn must be a user turn. */
export function buildClaudeMessages(
  history: { role: string; content: string }[]
): Anthropic.Beta.BetaMessageParam[] {
  const firstUser = history.findIndex((m) => m.role === "user");
  if (firstUser === -1) return [];
  return history.slice(firstUser).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
}

export type AiDecision =
  | { kind: "reply"; text: string }
  | { kind: "handoff"; text: string; reason: string };

export function decideFromResponse(response: Anthropic.Beta.BetaMessage): AiDecision {
  if (response.stop_reason === "refusal") {
    return { kind: "handoff", text: HANDOFF_MESSAGE, reason: "Model declined to answer" };
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const handoff = response.content.find(
    (b): b is Anthropic.Beta.BetaToolUseBlock =>
      b.type === "tool_use" && b.name === HANDOFF_TOOL.name
  );
  if (handoff) {
    const input = handoff.input as { reason?: unknown };
    const reason = typeof input?.reason === "string" ? input.reason : "No reason given";
    return { kind: "handoff", text: text || HANDOFF_MESSAGE, reason };
  }

  if (!text) {
    return { kind: "handoff", text: HANDOFF_MESSAGE, reason: "Empty model reply" };
  }
  return { kind: "reply", text };
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export async function generateAiDecision({
  settings,
  history,
}: {
  settings: { systemPrompt: string; knowledgeBase: string };
  history: { role: string; content: string }[];
}): Promise<AiDecision> {
  const response = await getClient().beta.messages.create({
    model: process.env.AI_REPLY_MODEL || DEFAULT_AI_MODEL,
    max_tokens: 2048,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    // Stable per account, so cached across every DM it answers.
    system: [
      {
        type: "text",
        text: buildSystemPrompt(settings),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [HANDOFF_TOOL],
    messages: buildClaudeMessages(history),
  });
  return decideFromResponse(response);
}

function clip(text: string): string {
  return text.length <= MAX_DM_CHARS ? text : `${text.slice(0, MAX_DM_CHARS - 1)}…`;
}

export async function processAiReply(job: Job<ProcessAiReplyJob>): Promise<void> {
  const { instagramAccountId, accountConnectionId, messageId, messageText, senderId } =
    job.data;

  const settings = await prisma.aiSettings.findFirst({
    where: {
      enabled: true,
      instagramAccount: accountConnectionId
        ? { id: accountConnectionId }
        : { instagramId: instagramAccountId },
    },
    include: { instagramAccount: true },
  });
  if (!settings) return;
  const account = settings.instagramAccount;

  const conversation = await prisma.aiConversation.upsert({
    where: {
      instagramAccountId_senderId: { instagramAccountId: account.id, senderId },
    },
    create: { instagramAccountId: account.id, senderId },
    update: {},
  });

  // Store the inbound message once; a retried job finds it already there.
  await prisma.aiMessage.upsert({
    where: { externalId: messageId },
    create: {
      conversationId: conversation.id,
      role: "user",
      content: messageText,
      externalId: messageId,
    },
    update: {},
  });

  if (conversation.mode === "HUMAN") return;

  const alreadyAnswered = await prisma.aiMessage.findUnique({
    where: { replyTo: messageId },
    select: { id: true },
  });
  if (alreadyAnswered) return;

  const recentReplies = await prisma.aiMessage.count({
    where: {
      conversationId: conversation.id,
      role: "assistant",
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
  });
  if (recentReplies >= MAX_REPLIES_PER_MINUTE) return;

  if (!hasInstagramCredentials(account)) return;

  const history = (
    await prisma.aiMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    })
  ).reverse();

  const decision = await generateAiDecision({ settings, history });
  const text = clip(decision.text);

  const context = await createInstagramContext(account, `${job.id}:ai`);
  await sendDirectMessage({
    context,
    instagramAccountId: account.instagramId,
    userId: senderId,
    message: text,
  });

  await prisma.aiMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: text,
      replyTo: messageId,
    },
  });

  if (decision.kind === "handoff") {
    await prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { mode: "HUMAN", handoffReason: decision.reason },
    });
    await notifyHandoff({
      workspaceId: account.workspaceId,
      username: account.username,
      senderId,
      reason: decision.reason,
      lastMessage: messageText,
    });
  }
}

export const MANUAL_REPLY_REASON = "你在 Instagram 手動回覆了這個對話";

/**
 * A DM the account sent that OpenReply didn't send was typed by a person, so
 * that conversation becomes theirs: switch it to HUMAN until handed back.
 */
export async function processEcho(job: Job<ProcessEchoJob>): Promise<void> {
  const { instagramAccountId, accountConnectionId, messageId, recipientId } = job.data;

  if (await wasSentByUs(messageId)) return;

  const settings = await prisma.aiSettings.findFirst({
    where: {
      enabled: true,
      instagramAccount: accountConnectionId
        ? { id: accountConnectionId }
        : { instagramId: instagramAccountId },
    },
    select: { instagramAccountId: true },
  });
  if (!settings) return;

  const where = {
    instagramAccountId_senderId: {
      instagramAccountId: settings.instagramAccountId,
      senderId: recipientId,
    },
  };
  const existing = await prisma.aiConversation.findUnique({
    where,
    select: { mode: true },
  });
  if (existing?.mode === "HUMAN") return;

  await prisma.aiConversation.upsert({
    where,
    create: {
      instagramAccountId: settings.instagramAccountId,
      senderId: recipientId,
      mode: "HUMAN",
      handoffReason: MANUAL_REPLY_REASON,
    },
    update: { mode: "HUMAN", handoffReason: MANUAL_REPLY_REASON },
  });
}
