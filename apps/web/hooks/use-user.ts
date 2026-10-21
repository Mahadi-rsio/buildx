"use client";

import { useSession } from "@/lib/auth/client";

export interface ShellUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/**
 * The signed-in user for chrome. Better Auth owns the real session; this hook
 * adds a stable local shape and a demo fallback so previews and local builds
 * without a session still render a usable menu.
 */
export function useUser(): {
  user: ShellUser | null;
  isLoading: boolean;
} {
  const { data, isPending } = useSession();
  const sessionUser = data?.user;

  if (sessionUser) {
    return {
      user: {
        id: sessionUser.id,
        name: sessionUser.name || sessionUser.email.split("@")[0] || "You",
        email: sessionUser.email,
        image: sessionUser.image,
      },
      isLoading: false,
    };
  }

  if (isPending) return { user: null, isLoading: true };

  return {
    user: {
      id: "demo",
      name: "Demo user",
      email: "demo@buildx.local",
      image: null,
    },
    isLoading: false,
  };
}

export function initialsFor(user: ShellUser): string {
  const source = user.name.trim() || user.email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}
