/**
 * Handoff notifications.
 *
 * When the AI hands a conversation to a human, email the workspace's owners and
 * admins so it doesn't sit unanswered. Uses the same mail path as sign-in links:
 * EMAIL_SERVER (SMTP) when set, otherwise Resend.
 */
import nodemailer from "nodemailer";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";

export interface HandoffNotice {
  workspaceId: string;
  username: string;
  senderId: string;
  reason: string;
  lastMessage: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildHandoffEmail(notice: HandoffNotice) {
  const link = `${getBaseUrl()}/ai`;
  const subject = `[OpenReply] @${notice.username} 有對話需要真人回覆`;
  const text = [
    `AI 把一則 Instagram 私訊轉給真人處理。`,
    ``,
    `帳號：@${notice.username}`,
    `對方 ID：${notice.senderId}`,
    `原因：${notice.reason}`,
    `最後一則訊息：${notice.lastMessage}`,
    ``,
    `請到 Instagram 回覆對方。處理完後，可到後台交還給 AI：${link}`,
  ].join("\n");
  const html = `<p>AI 把一則 Instagram 私訊轉給真人處理。</p>
<ul>
<li>帳號：@${escapeHtml(notice.username)}</li>
<li>對方 ID：${escapeHtml(notice.senderId)}</li>
<li>原因：${escapeHtml(notice.reason)}</li>
<li>最後一則訊息：${escapeHtml(notice.lastMessage)}</li>
</ul>
<p>請到 Instagram 回覆對方。處理完後，可到<a href="${escapeHtml(link)}">後台</a>交還給 AI。</p>`;
  return { subject, text, html };
}

async function sendMail(to: string[], mail: ReturnType<typeof buildHandoffEmail>) {
  const from = process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";

  if (process.env.EMAIL_SERVER) {
    await nodemailer
      .createTransport(process.env.EMAIL_SERVER)
      .sendMail({ from, to, ...mail });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("No mail transport: set EMAIL_SERVER or RESEND_API_KEY");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, ...mail }),
  });
  if (!res.ok) {
    throw new Error(`Resend rejected the handoff email: ${res.status} ${await res.text()}`);
  }
}

/** Never throws: a failed email must not undo or retry the handoff itself. */
export async function notifyHandoff(notice: HandoffNotice): Promise<boolean> {
  if (process.env.AI_HANDOFF_EMAIL === "off") return false;
  try {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: notice.workspaceId, role: { in: ["OWNER", "ADMIN"] } },
      select: { user: { select: { email: true } } },
    });
    const to = [
      ...new Set(members.map((m) => m.user.email).filter((e): e is string => !!e)),
    ];
    if (!to.length) return false;
    await sendMail(to, buildHandoffEmail(notice));
    return true;
  } catch (error) {
    console.error("[ai] handoff email failed:", error);
    return false;
  }
}
