import { Suspense } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SignInForm } from "@/components/auth/sign-in-form";

export const dynamic = "force-dynamic";

export default function SignInPage() {
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
