"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/chat-messages";
import { ChatMessageView } from "@/components/chat/chat-message";
import { Skeleton } from "@/components/ui/skeleton";

export function ChatThread({
  messages,
  loading,
  showThinking,
  onRetry,
  onEdit,
}: {
  messages: ChatMessage[];
  loading?: boolean;
  showThinking?: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, showThinking]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
        <Skeleton className="ml-auto h-20 w-3/4 rounded-2xl" />
        <Skeleton className="h-28 w-4/5 rounded-2xl" />
        <Skeleton className="h-16 w-2/3 rounded-2xl" />
      </div>
    );
  }

  return (
    <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
        {messages.map((message, index) => (
          <ChatMessageView
            key={message.id}
            message={message}
            showThinking={
              showThinking &&
              message.role === "assistant" &&
              index === messages.length - 1
            }
            onRetry={message.role === "assistant" ? onRetry : undefined}
            onEdit={message.role === "user" ? onEdit : undefined}
          />
        ))}
      </div>
    </div>
  );
}
