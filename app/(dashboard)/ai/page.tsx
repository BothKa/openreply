"use client";

/**
 * AI Replies Page
 *
 * Per-account settings for the AI fallback (on/off, brand instructions,
 * knowledge base) and the conversations it is handling, with a switch to take
 * a conversation over or hand it back to the bot.
 */

import { useI18n } from "@/lib/i18n/provider";
import { useCallback, useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";

interface AiSettings {
  enabled: boolean;
  systemPrompt: string;
  knowledgeBase: string;
}

interface AiConversation {
  id: string;
  senderId: string;
  mode: "BOT" | "HUMAN";
  handoffReason: string | null;
  updatedAt: string;
  lastMessage: { role: string; content: string } | null;
}

export default function AiRepliesPage() {
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (id: string | null) => {
    try {
      const params = id ? `?instagramAccountId=${encodeURIComponent(id)}` : "";
      const res = await fetch(`/api/ai${params}`);
      const payload = await res.json();
      if (payload.success) {
        setAccounts(payload.data.accounts);
        setAccountId(payload.data.selectedAccountId);
        setSettings(payload.data.settings);
        setConversations(payload.data.conversations);
      }
    } catch (err) {
      console.error("Failed to load AI settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function save() {
    if (!accountId || !settings) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId: accountId, ...settings }),
      });
      const payload = await res.json();
      setNotice(payload.success ? t("Saved") : t("Could not save"));
    } finally {
      setSaving(false);
    }
  }

  async function setMode(conversationId: string, mode: "BOT" | "HUMAN") {
    const res = await fetch("/api/ai", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, mode }),
    });
    if ((await res.json()).success) {
      setConversations((list) =>
        list.map((c) =>
          c.id === conversationId
            ? { ...c, mode, handoffReason: mode === "BOT" ? null : c.handoffReason }
            : c
        )
      );
    }
  }

  if (loading) {
    return <div className="text-sm text-muted">{t("Loading...")}</div>;
  }

  if (!accountId || !settings) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
        {t("Connect an Instagram account to use AI replies.")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AccountSelect
        accounts={accounts}
        value={accountId}
        includeAll={false}
        onChange={(id) => {
          setLoading(true);
          void load(id);
        }}
      />

      <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <div>
          <h2 className="text-base font-semibold">{t("AI replies")}</h2>
          <p className="mt-1 text-sm text-muted">
            {t("DMs that match no campaign keyword are answered by Claude, using only your knowledge base. Complaints, refunds and unanswerable questions are handed to you.")}
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
          />
          {t("Answer unmatched DMs with AI")}
        </label>

        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">{t("Brand voice and rules")}</span>
          <textarea
            value={settings.systemPrompt}
            onChange={(e) => setSettings({ ...settings, systemPrompt: e.target.value })}
            rows={4}
            maxLength={4000}
            className="rounded-xl border border-border bg-background px-3 py-2 outline-none focus:border-accent/40"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">{t("Knowledge base (FAQ, products, shipping, policies)")}</span>
          <textarea
            value={settings.knowledgeBase}
            onChange={(e) => setSettings({ ...settings, knowledgeBase: e.target.value })}
            rows={12}
            maxLength={50000}
            className="rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-accent/40"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? t("Saving...") : t("Save")}
          </button>
          {notice && <span className="text-sm text-muted">{notice}</span>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface">
        <h2 className="border-b border-border px-5 py-4 text-base font-semibold">
          {t("AI conversations")}
        </h2>
        {conversations.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">{t("No AI conversations yet")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {conversations.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-muted">{c.senderId}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        c.mode === "HUMAN"
                          ? "bg-amber-500/15 text-amber-600"
                          : "bg-accent/15 text-accent"
                      }`}
                    >
                      {c.mode === "HUMAN" ? t("Human") : t("AI")}
                    </span>
                    <span className="text-xs text-muted">
                      {new Date(c.updatedAt).toLocaleString(locale)}
                    </span>
                  </div>
                  {c.lastMessage && (
                    <p className="truncate text-sm">{c.lastMessage.content}</p>
                  )}
                  {c.mode === "HUMAN" && c.handoffReason && (
                    <p className="text-xs text-muted">{c.handoffReason}</p>
                  )}
                </div>
                <button
                  onClick={() => void setMode(c.id, c.mode === "HUMAN" ? "BOT" : "HUMAN")}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-border-hover"
                >
                  {c.mode === "HUMAN" ? t("Hand back to AI") : t("Take over")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
