import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockCreate, mockSendDirectMessage, mockNotifyHandoff, mockWasSentByUs } = vi.hoisted(() => ({
  mockPrisma: {
    aiSettings: { findFirst: vi.fn() },
    aiConversation: { upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    aiMessage: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
  mockCreate: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockNotifyHandoff: vi.fn(),
  mockWasSentByUs: vi.fn(),
}));

vi.mock("@/lib/ai/sent-messages", () => ({ wasSentByUs: mockWasSentByUs }));

vi.mock("@/lib/ai/notify", () => ({ notifyHandoff: mockNotifyHandoff }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(async () => ({ provider: "META", accessToken: "tok" })),
  hasInstagramCredentials: vi.fn(() => true),
  sendDirectMessage: mockSendDirectMessage,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create: mockCreate } };
  },
}));

import {
  buildClaudeMessages,
  buildSystemPrompt,
  decideFromResponse,
  HANDOFF_MESSAGE,
  MANUAL_REPLY_REASON,
  processAiReply,
  processEcho,
} from "@/lib/ai/reply";

type Response = Parameters<typeof decideFromResponse>[0];

function response(partial: Partial<Response>): Response {
  return { stop_reason: "end_turn", content: [], ...partial } as Response;
}

describe("buildClaudeMessages", () => {
  it("drops assistant turns before the first user turn", () => {
    expect(
      buildClaudeMessages([
        { role: "assistant", content: "hi" },
        { role: "user", content: "price?" },
        { role: "assistant", content: "$10" },
      ])
    ).toEqual([
      { role: "user", content: "price?" },
      { role: "assistant", content: "$10" },
    ]);
  });
});

describe("buildSystemPrompt", () => {
  it("includes brand instructions and the knowledge base", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "Be warm.",
      knowledgeBase: "Shipping: 3 days.",
    });
    expect(prompt).toContain("<brand_instructions>\nBe warm.");
    expect(prompt).toContain("<knowledge_base>\nShipping: 3 days.");
  });
});

describe("decideFromResponse", () => {
  it("returns the text as a reply", () => {
    expect(
      decideFromResponse(response({ content: [{ type: "text", text: "We ship in 3 days." }] as Response["content"] }))
    ).toEqual({ kind: "reply", text: "We ship in 3 days." });
  });

  it("hands off when the model calls handoff_to_human", () => {
    const decision = decideFromResponse(
      response({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "handoff_to_human", input: { reason: "refund" } },
        ] as Response["content"],
      })
    );
    expect(decision).toEqual({ kind: "handoff", text: HANDOFF_MESSAGE, reason: "refund" });
  });

  it("hands off on a refusal", () => {
    expect(decideFromResponse(response({ stop_reason: "refusal" })).kind).toBe("handoff");
  });
});

describe("processAiReply", () => {
  const job = {
    id: "job1",
    data: {
      instagramAccountId: "ig_456",
      messageId: "mid_1",
      messageText: "運費多少？",
      senderId: "user_1",
    },
  } as Parameters<typeof processAiReply>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.aiSettings.findFirst.mockResolvedValue({
      systemPrompt: "",
      knowledgeBase: "運費 60 元",
      instagramAccount: {
        id: "acc_1",
        instagramId: "ig_456",
        workspaceId: "ws_1",
        username: "mybrand",
      },
    });
    mockPrisma.aiConversation.upsert.mockResolvedValue({ id: "conv_1", mode: "BOT" });
    mockPrisma.aiMessage.findUnique.mockResolvedValue(null);
    mockPrisma.aiMessage.count.mockResolvedValue(0);
    mockPrisma.aiMessage.findMany.mockResolvedValue([{ role: "user", content: "運費多少？" }]);
    mockCreate.mockResolvedValue(
      response({ content: [{ type: "text", text: "運費是 60 元喔！" }] as Response["content"] })
    );
  });

  it("answers and records the reply against the inbound message", async () => {
    await processAiReply(job);

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", message: "運費是 60 元喔！" })
    );
    expect(mockPrisma.aiMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: "assistant", replyTo: "mid_1" }),
    });
    expect(mockPrisma.aiConversation.update).not.toHaveBeenCalled();
    expect(mockNotifyHandoff).not.toHaveBeenCalled();
  });

  it("does nothing when AI replies are off for the account", async () => {
    mockPrisma.aiSettings.findFirst.mockResolvedValue(null);
    await processAiReply(job);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("stays silent in a conversation a human has taken over", async () => {
    mockPrisma.aiConversation.upsert.mockResolvedValue({ id: "conv_1", mode: "HUMAN" });
    await processAiReply(job);
    expect(mockPrisma.aiMessage.upsert).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does not answer the same message twice", async () => {
    mockPrisma.aiMessage.findUnique.mockResolvedValue({ id: "m" });
    await processAiReply(job);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("stops at the per-minute burst cap", async () => {
    mockPrisma.aiMessage.count.mockResolvedValue(3);
    await processAiReply(job);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("switches the conversation to HUMAN on handoff", async () => {
    mockCreate.mockResolvedValue(
      response({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "handoff_to_human", input: { reason: "退款" } },
        ] as Response["content"],
      })
    );
    await processAiReply(job);

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: HANDOFF_MESSAGE })
    );
    expect(mockPrisma.aiConversation.update).toHaveBeenCalledWith({
      where: { id: "conv_1" },
      data: { mode: "HUMAN", handoffReason: "退款" },
    });
    expect(mockNotifyHandoff).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      username: "mybrand",
      senderId: "user_1",
      reason: "退款",
      lastMessage: "運費多少？",
    });
  });
});

describe("processEcho", () => {
  const job = {
    id: "echo1",
    data: { instagramAccountId: "ig_456", messageId: "mid_out", recipientId: "user_1" },
  } as Parameters<typeof processEcho>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    mockWasSentByUs.mockResolvedValue(false);
    mockPrisma.aiSettings.findFirst.mockResolvedValue({ instagramAccountId: "acc_1" });
    mockPrisma.aiConversation.findUnique.mockResolvedValue({ mode: "BOT" });
  });

  it("switches the conversation to HUMAN when someone replied by hand", async () => {
    await processEcho(job);
    expect(mockPrisma.aiConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { mode: "HUMAN", handoffReason: MANUAL_REPLY_REASON },
        create: expect.objectContaining({ senderId: "user_1", mode: "HUMAN" }),
      })
    );
  });

  it("ignores echoes of messages OpenReply sent", async () => {
    mockWasSentByUs.mockResolvedValue(true);
    await processEcho(job);
    expect(mockPrisma.aiConversation.upsert).not.toHaveBeenCalled();
  });

  it("does nothing when AI replies are off", async () => {
    mockPrisma.aiSettings.findFirst.mockResolvedValue(null);
    await processEcho(job);
    expect(mockPrisma.aiConversation.upsert).not.toHaveBeenCalled();
  });

  it("keeps an existing handoff reason", async () => {
    mockPrisma.aiConversation.findUnique.mockResolvedValue({ mode: "HUMAN" });
    await processEcho(job);
    expect(mockPrisma.aiConversation.upsert).not.toHaveBeenCalled();
  });
});
