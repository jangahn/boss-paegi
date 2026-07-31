import {
  AUTH_RECONCILE_CAPABILITY_COOKIE,
  authReconcileCapabilityDigest,
  parseAuthReconcileSearchParams,
  type AuthReconcileInput,
} from "@/lib/auth-reconcile";
import { AuthReconcileClient } from "./AuthReconcileClient";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export default async function AuthReconcilePage({
  searchParams,
}: {
  searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const parsed = parseAuthReconcileSearchParams(
    await searchParams,
  );
  const capabilityCookies = (
    await cookies()
  ).getAll(AUTH_RECONCILE_CAPABILITY_COOKIE);
  let input: AuthReconcileInput | null = null;
  if (parsed !== null && capabilityCookies.length === 1) {
    try {
      const expected =
        await authReconcileCapabilityDigest(parsed);
      if (capabilityCookies[0].value === expected) {
        input = parsed;
      }
    } catch {
      // A malformed or unavailable capability is authorization failure, not
      // a reason to render a mutation-capable client.
    }
  }
  return <AuthReconcileClient input={input} />;
}
