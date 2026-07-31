import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getCurrentLegalDocumentStrict,
  getCurrentLegalVersionsStrict,
  type ConsentLegalDocument,
} from "@/lib/legal/strict-versions";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { safeNext } from "@/lib/oauth-metadata";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  resolveDbRead,
  resolveAuthUserRead,
  resolveRequiredDbRead,
} from "@/lib/auth-read-policy";
import { SERVICE_NAME } from "@/lib/policy";
import { log, errInfo } from "@/lib/log";
import { ConsentForm, type LegalDocLite } from "./ConsentForm";
import { readCurrentAuthSessionState } from "@/lib/auth-session-live";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "이용 동의",
  robots: { index: false, follow: true },
  alternates: { canonical: "/consent" },
};

type MigrationFlowRead =
  | { ok: true; flowId: string | null }
  | { ok: false };

function parseExactMigrationFlow(
  value: string | string[] | undefined,
): MigrationFlowRead {
  if (value === undefined) return { ok: true, flowId: null };
  if (typeof value !== "string" || !isOAuthFlowId(value)) {
    return { ok: false };
  }
  return { ok: true, flowId: value };
}

function ConsentReadUnavailable({
  next,
  migrationFlow,
}: {
  next: string;
  migrationFlow: string | null;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <p className="text-sm font-medium text-zinc-500">{SERVICE_NAME}</p>
          <h1 className="mt-2 text-2xl font-bold">
            동의 정보를 불러오지 못했어요
          </h1>
          <p role="alert" className="mt-3 text-sm leading-relaxed text-zinc-500">
            계정과 약관 상태를 확인할 수 없어 안전하게 진행을 멈췄어요.
            잠시 후 다시 시도해주세요.
          </p>
        </div>
        <form action="/consent" method="get">
          <input type="hidden" name="next" value={next} />
          {migrationFlow !== null ? (
            <input
              type="hidden"
              name="migrationFlow"
              value={migrationFlow}
            />
          ) : null}
          <button
            type="submit"
            className="w-full rounded-full bg-foreground py-4 font-semibold text-paper-2 transition hover:opacity-90"
          >
            다시 시도
          </button>
        </form>
      </div>
    </main>
  );
}

function readUnavailable(
  next: string,
  migrationFlow: string | null,
  source: string,
  error: unknown,
  userId?: string,
) {
  log.error("account.consent_page_read_fail", {
    userId,
    source,
    ...errInfo(error),
  });
  return (
    <ConsentReadUnavailable
      next={next}
      migrationFlow={migrationFlow}
    />
  );
}

/**
 * 통합 동의 화면 — **로그인의 마지막·필수 단계**(신규가입·재활성·레거시·구버전 재동의 공용).
 * 경량 가드(I6, authed·비익명·비탈퇴 — requireMember 안 씀 → row 없는 in-between 도 통과).
 * profile/member/legal 읽기가 모두 성공한 뒤에만 항목을 산출하며, 오류는 재시도 UI로 fail-closed.
 * 빠진/구버전 동의 항목만 서버 산출(`lib/consent` 단일 규칙). 0개면(이미 회원) 목적지로 가되,
 * 익명 이전 복구 flow가 있으면 빈 idempotent 폼을 제출해 미완료 이전을 수렴시킨다.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string;
    migrationFlow?: string | string[];
  }>;
}) {
  const { next, migrationFlow: migrationFlowParam } =
    await searchParams;
  const dest = safeNext(next);
  const migrationFlowRead = parseExactMigrationFlow(
    migrationFlowParam,
  );
  if (!migrationFlowRead.ok) {
    return readUnavailable(
      dest,
      null,
      "migration_flow",
      new Error("migration_flow_invalid"),
    );
  }
  const migrationFlow = migrationFlowRead.flowId;
  const unavailable = (
    source: string,
    error: unknown,
    userId?: string,
  ) => readUnavailable(dest, migrationFlow, source, error, userId);

  const supabase = await createClient();
  let authResult;
  try {
    authResult = await supabase.auth.getUser();
  } catch (error) {
    return unavailable("auth", error);
  }
  const authRead = resolveAuthUserRead(authResult);
  if (!authRead.ok && authRead.kind === "unavailable") {
    return unavailable("auth", authRead.error);
  }
  if (!authRead.ok || authRead.user.is_anonymous) {
    redirect(`/login?next=${encodeURIComponent(dest)}`);
  }
  const user = authRead.user;
  const sessionState = await readCurrentAuthSessionState(() =>
    supabase.rpc("oauth_current_auth_session_live"),
  );
  if (sessionState.kind === "revoked") {
    redirect(`/login?next=${encodeURIComponent(dest)}`);
  }
  if (sessionState.kind === "unavailable") {
    return unavailable("auth", sessionState.error, user.id);
  }

  const admin = createAdminClient();
  let profileResult;
  try {
    profileResult = await admin
      .from("profiles")
      .select("deleted_at")
      .eq("id", user.id)
      .maybeSingle();
  } catch (error) {
    return unavailable("profile", error, user.id);
  }
  const profileRead = resolveRequiredDbRead("profile", {
    data: profileResult.data as { deleted_at: string | null } | null,
    error: profileResult.error,
  });
  if (!profileRead.ok) {
    return unavailable(
      profileRead.source,
      profileRead.error,
      user.id,
    );
  }
  if (profileRead.data.deleted_at) {
    redirect("/login?error=account_deleted");
  }

  const [memberSettled, legalSettled] = await Promise.allSettled([
    admin
      .from("member_accounts")
      .select("age_confirmed_at, terms_version, privacy_version")
      .eq("user_id", user.id)
      .maybeSingle(),
    getCurrentLegalVersionsStrict(),
  ]);
  if (memberSettled.status === "rejected") {
    return unavailable("member", memberSettled.reason, user.id);
  }
  const memberRead = resolveDbRead("member", {
    data: memberSettled.value.data as Exclude<ConsentMember, null> | null,
    error: memberSettled.value.error,
  });
  if (!memberRead.ok) {
    return unavailable(
      memberRead.source,
      memberRead.error,
      user.id,
    );
  }
  if (legalSettled.status === "rejected") {
    return unavailable(
      "legal_versions",
      legalSettled.reason,
      user.id,
    );
  }
  const member = (memberRead.data as ConsentMember) ?? null;
  const curr = legalSettled.value;
  const items = missingConsentItems(member, curr);
  if (items.length === 0 && migrationFlow === null) {
    redirect(dest); // 이미 동의 완료(member), 이전 복구도 불필요
  }

  // 표시 항목의 약관/방침 전문(sections)을 함께 내려 "보기"를 인라인 모달로(네비게이션 없음).
  const [termsSettled, privacySettled] = await Promise.allSettled([
    items.includes("terms") && curr.terms !== null
      ? getCurrentLegalDocumentStrict("terms", curr.terms)
      : Promise.resolve(null),
    items.includes("privacy") && curr.privacy !== null
      ? getCurrentLegalDocumentStrict("privacy", curr.privacy)
      : Promise.resolve(null),
  ]);
  if (termsSettled.status === "rejected") {
    return unavailable(
      "legal_document.terms",
      termsSettled.reason,
      user.id,
    );
  }
  if (privacySettled.status === "rejected") {
    return unavailable(
      "legal_document.privacy",
      privacySettled.reason,
      user.id,
    );
  }
  if (
    (items.includes("terms") && termsSettled.value === null) ||
    (items.includes("privacy") && privacySettled.value === null)
  ) {
    return unavailable(
      "legal_document",
      new Error("required_legal_document_missing"),
      user.id,
    );
  }
  const termsDoc = termsSettled.value;
  const privacyDoc = privacySettled.value;
  const toLite = (d: ConsentLegalDocument | null): LegalDocLite | null =>
    d
      ? {
          title: d.title,
          sections: d.sections,
          version: d.version,
          effectiveDate: d.effective_date,
        }
      : null;

  return (
    <ConsentForm
      items={items}
      next={dest}
      docs={{ terms: toLite(termsDoc), privacy: toLite(privacyDoc) }}
      migrationFlow={migrationFlow}
    />
  );
}
