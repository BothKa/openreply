import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  instagramAccountId: z.string().min(1),
  enabled: z.boolean(),
  systemPrompt: z.string().max(4000),
  knowledgeBase: z.string().max(50000),
});

const modeSchema = z.object({
  conversationId: z.string().min(1),
  mode: z.enum(["BOT", "HUMAN"]),
});

function fail(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status });
}

async function ownedAccount(workspaceId: string, instagramAccountId: string) {
  return prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId },
    select: { id: true },
  });
}

export async function GET(request: NextRequest) {
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) return fail("Unauthorized", 401);

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, username: true, instagramId: true, name: true },
    orderBy: { connectedAt: "asc" },
  });

  const requested = request.nextUrl.searchParams.get("instagramAccountId");
  const selected = accounts.find((a) => a.id === requested) ?? accounts[0];
  if (!selected) {
    return NextResponse.json({
      success: true,
      data: { accounts, selectedAccountId: null, settings: null, conversations: [] },
    });
  }

  const [settings, conversations] = await Promise.all([
    prisma.aiSettings.findUnique({ where: { instagramAccountId: selected.id } }),
    prisma.aiConversation.findMany({
      where: { instagramAccountId: selected.id },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      accounts,
      selectedAccountId: selected.id,
      settings: settings ?? {
        enabled: false,
        systemPrompt: "",
        knowledgeBase: "",
      },
      conversations: conversations.map((c) => ({
        id: c.id,
        senderId: c.senderId,
        mode: c.mode,
        handoffReason: c.handoffReason,
        updatedAt: c.updatedAt,
        lastMessage: c.messages[0]
          ? { role: c.messages[0].role, content: c.messages[0].content }
          : null,
      })),
    },
  });
}

export async function PUT(request: NextRequest) {
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) return fail("Unauthorized", 401);
  if (!canManageWorkspace(ctx.role)) return fail("Forbidden", 403);

  const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid request", 400);
  const { instagramAccountId, ...data } = parsed.data;

  if (!(await ownedAccount(ctx.workspaceId, instagramAccountId))) {
    return fail("Account not found", 404);
  }

  const settings = await prisma.aiSettings.upsert({
    where: { instagramAccountId },
    create: { instagramAccountId, ...data },
    update: data,
  });
  return NextResponse.json({ success: true, data: settings });
}

export async function PATCH(request: NextRequest) {
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) return fail("Unauthorized", 401);

  const parsed = modeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid request", 400);

  const conversation = await prisma.aiConversation.findFirst({
    where: {
      id: parsed.data.conversationId,
      instagramAccount: { workspaceId: ctx.workspaceId },
    },
    select: { id: true },
  });
  if (!conversation) return fail("Conversation not found", 404);

  await prisma.aiConversation.update({
    where: { id: conversation.id },
    data: {
      mode: parsed.data.mode,
      ...(parsed.data.mode === "BOT" ? { handoffReason: null } : {}),
    },
  });
  return NextResponse.json({ success: true });
}
