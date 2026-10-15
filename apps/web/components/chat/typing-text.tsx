"use client";

import { useSyncExternalStore } from "react";
import { TypingAnimation } from "@/components/ui/terminal";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * `TypingAnimation` for people who like motion; the full text immediately for
 * people who asked for reduced motion.
 */
export function TypingText({
  text,
  as = "span",
  className,
  duration = 45,
  delay = 0,
}: {
  text: string;
  as?: "h1" | "h2" | "p" | "span";
  className?: string;
  duration?: number;
  delay?: number;
}) {
  const reduced = usePrefersReducedMotion();

  if (reduced) {
    const Tag = as;
    return <Tag className={className}>{text}</Tag>;
  }

  return (
    <TypingAnimation
      as={as}
      className={className}
      duration={duration}
      delay={delay}
      startOnView
    >
      {text}
    </TypingAnimation>
  );
}
