-- AI fallback replies: per-account settings, conversations with a bot/human
-- mode, and the message history Claude is given as context.

-- CreateEnum
CREATE TYPE "AiConversationMode" AS ENUM ('BOT', 'HUMAN');

-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "knowledgeBase" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "mode" "AiConversationMode" NOT NULL DEFAULT 'BOT',
    "handoffReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "externalId" TEXT,
    "replyTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSettings_instagramAccountId_key" ON "AiSettings"("instagramAccountId");
CREATE INDEX "AiConversation_mode_idx" ON "AiConversation"("mode");
CREATE UNIQUE INDEX "AiConversation_instagramAccountId_senderId_key" ON "AiConversation"("instagramAccountId", "senderId");
CREATE UNIQUE INDEX "AiMessage_externalId_key" ON "AiMessage"("externalId");
CREATE UNIQUE INDEX "AiMessage_replyTo_key" ON "AiMessage"("replyTo");
CREATE INDEX "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
