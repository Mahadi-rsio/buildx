"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, LogOut, Settings, Sparkles } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ThemeSwitch } from "@/components/shell/theme-switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { initialsFor, useUser, type ShellUser } from "@/hooks/use-user";
import { authClient } from "@/lib/auth/client";

function UserAvatar({ user, size = "default" }: { user: ShellUser; size?: "default" | "sm" | "lg" }) {
  return (
    <Avatar size={size}>
      {user.image ? <AvatarImage src={user.image} alt="" /> : null}
      <AvatarFallback className="font-mono text-[10px] font-semibold tracking-wide text-foreground">
        {initialsFor(user)}
      </AvatarFallback>
    </Avatar>
  );
}

function ThemeRow() {
  return (
    <div className="px-1 py-1.5">
      <p className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">
        Appearance
      </p>
      <ThemeSwitch compact />
    </div>
  );
}

function AccountHeader({ user }: { user: ShellUser }) {
  return (
    <div className="flex items-center gap-2.5 px-1 py-1.5">
      <UserAvatar user={user} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {user.email}
        </p>
      </div>
    </div>
  );
}

function useLogout() {
  const router = useRouter();
  return async () => {
    try {
      await authClient.signOut();
    } finally {
      router.push("/sign-in");
      router.refresh();
    }
  };
}

function DesktopMenu({ user }: { user: ShellUser }) {
  const logout = useLogout();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-label="Account menu"
            className="rounded-full p-0.5"
          />
        }
      >
        <UserAvatar user={user} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-72 p-1.5">
        <AccountHeader user={user} />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 text-[13px]"
          render={<Link href="/settings" />}
        >
          <Settings className="size-3.5" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2 text-[13px]" render={<Link href="/pricing" />}>
          <Sparkles className="size-3.5" />
          Plans &amp; credits
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 text-[13px]"
          render={
            <a
              href="https://github.com/Mahadi-rsio/buildx#readme"
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          <BookOpen className="size-3.5" />
          Docs
        </DropdownMenuItem>
        <ThemeRow />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          className="gap-2 text-[13px]"
          onClick={() => void logout()}
        >
          <LogOut className="size-3.5" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileMenu({ user }: { user: ShellUser }) {
  const logout = useLogout();
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-label="Account menu"
            className="rounded-full p-0.5"
          />
        }
      >
        <UserAvatar user={user} />
      </SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 rounded-t-2xl pb-safe"
      >
        <SheetTitle className="sr-only">Account</SheetTitle>
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="px-3 pb-2 pt-2">
          <AccountHeader user={user} />
          <div className="mt-1 divide-y divide-border/60">
            <SheetClose
              render={<Link href="/settings" />}
              className="flex h-11 items-center gap-2.5 px-1 text-[13px] text-foreground transition-colors hover:text-muted-foreground"
            >
              <Settings className="size-4 text-muted-foreground" />
              Settings
            </SheetClose>
            <SheetClose
              render={<Link href="/pricing" />}
              className="flex h-11 items-center gap-2.5 px-1 text-[13px] text-foreground transition-colors hover:text-muted-foreground"
            >
              <Sparkles className="size-4 text-muted-foreground" />
              Plans &amp; credits
            </SheetClose>
            <a
              href="https://github.com/Mahadi-rsio/buildx#readme"
              target="_blank"
              rel="noreferrer"
              className="flex h-11 items-center gap-2.5 px-1 text-[13px] text-foreground transition-colors hover:text-muted-foreground"
            >
              <BookOpen className="size-4 text-muted-foreground" />
              Docs
            </a>
            <ThemeRow />
            <SheetClose
              render={<button type="button" onClick={() => void logout()} />}
              className="flex h-11 w-full items-center gap-2.5 px-1 text-left text-[13px] text-foreground transition-colors hover:text-muted-foreground"
            >
              <LogOut className="size-4 text-muted-foreground" />
              Log out
            </SheetClose>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Profile avatar with an account menu on desktop and a bottom sheet on mobile. */
export function ProfileMenu() {
  const isMobile = useIsMobile();
  const { user } = useUser();

  if (!user) return <span className="size-11" aria-hidden />;

  return (
    <div aria-label="Account">
      {isMobile ? <MobileMenu user={user} /> : <DesktopMenu user={user} />}
    </div>
  );
}
