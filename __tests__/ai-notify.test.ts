import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma, mockSendMail } = vi.hoisted(() => ({
  mockPrisma: { workspaceMember: { findMany: vi.fn() } },
  mockSendMail: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
}));

import { buildHandoffEmail, notifyHandoff } from "@/lib/ai/notify";

const notice = {
  workspaceId: "ws_1",
  username: "mybrand",
  senderId: "user_1",
  reason: "退款",
  lastMessage: "<b>我要退款</b>",
};

describe("buildHandoffEmail", () => {
  it("escapes customer text in the HTML body", () => {
    const mail = buildHandoffEmail(notice);
    expect(mail.subject).toContain("@mybrand");
    expect(mail.html).toContain("&lt;b&gt;我要退款&lt;/b&gt;");
    expect(mail.text).toContain("<b>我要退款</b>");
  });
});

describe("notifyHandoff", () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EMAIL_SERVER = "smtp://localhost:25";
    delete process.env.AI_HANDOFF_EMAIL;
    mockPrisma.workspaceMember.findMany.mockResolvedValue([
      { user: { email: "owner@example.com" } },
      { user: { email: "owner@example.com" } },
      { user: { email: null } },
    ]);
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it("emails each owner and admin once", async () => {
    expect(await notifyHandoff(notice)).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["owner@example.com"] })
    );
  });

  it("can be turned off", async () => {
    process.env.AI_HANDOFF_EMAIL = "off";
    expect(await notifyHandoff(notice)).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("swallows mail failures", async () => {
    mockSendMail.mockRejectedValue(new Error("smtp down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifyHandoff(notice)).toBe(false);
  });
});
