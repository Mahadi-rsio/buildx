import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SignInForm } from "@/components/auth/sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    redirect("/");
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back to buildx.</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={null}>
          <SignInForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
