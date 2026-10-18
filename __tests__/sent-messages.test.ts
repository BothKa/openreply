import { describe, it, expect, vi, beforeEach } from "vitest";

const { redis } = vi.hoisted(() => ({
  redis: { set: vi.fn(), exists: vi.fn() },
}));

vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis }));

import { rememberSent, wasSentByUs } from "@/lib/ai/sent-messages";

describe("sent message ids", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the id of a successful send and returns its result", async () => {
    const result = { recipient_id: "u", message_id: "mid_1" };
    await expect(rememberSent(Promise.resolve(result))).resolves.toBe(result);
    expect(redis.set).toHaveBeenCalledWith("sent:mid:mid_1", "1", "EX", 86400);
  });

  it("never fails a send because Redis is down", async () => {
    redis.set.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      rememberSent(Promise.resolve({ message_id: "mid_2" }))
    ).resolves.toEqual({ message_id: "mid_2" });
  });

  it("reports whether an id was ours", async () => {
    redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await wasSentByUs("mid_1")).toBe(true);
    expect(await wasSentByUs("mid_x")).toBe(false);
  });
});
