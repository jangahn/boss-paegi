import "server-only";
import { unstable_cache } from "next/cache";
import type { ZodType } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import type { DomainKey } from "./keys";

/** 도메인별 캐시 태그 — 쓰기 시 revalidateTag 로 무효화. */
export function configTag(key: DomainKey): string {
  return `config:${key}`;
}

type Row = { value: unknown; version: number };

// service_role 직접 조회(서버 전용). app_settings 는 RLS 정책 없음 → service_role 만 읽힘.
async function readRow(key: DomainKey): Promise<Row | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("app_settings")
    .select("value, version")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    log.warn("config.read_fail", { key, ...errInfo(error) });
    return null;
  }
  return data ? { value: data.value, version: data.version as number } : null;
}

// unstable_cache: 도메인 태그로 캐시(전역, per-user 아님). 쓰기 시 revalidateTag(configTag,'max') 로 태그 stale 표시
// → 다음 읽기에 갱신(stale-while-revalidate). 즉시 read-your-writes 아님.
// revalidate(backstop TTL): tag 무효화가 어떤 이유로 안 들어도 ≤1h 내 자동 갱신(발행 미반영 영구화 방지).
//   3600 인 이유: 루트 레이아웃(app/layout.tsx)이 이 캐시를 읽어 전 페이지의 ISR revalidate 가 이 값을 상속.
//   60 이면 /(홈)·/gallery·/leaderboard 등이 60초마다 재생성 → ISR write·Fluid CPU 폭증
//   (2026-07-07 실측: 홈 / 이 ISR write·Active CPU 양쪽 1위). config 는 예약 개념이 없고 발행은 항상
//   revalidateTag('config:*') 로 즉시 반영되므로 backstop 을 길게 잡아도 신선도 손실 없음.
function cachedRead(key: DomainKey): Promise<Row | null> {
  return unstable_cache(() => readRow(key), ["app_settings", key], {
    tags: [configTag(key)],
    revalidate: 3600,
  })();
}

export type WithMeta<T> = {
  value: T;
  /** db = 검증 통과한 설정값, default = 코드 기본값(미설정 또는 검증실패 폴백). */
  source: "db" | "default";
  version: number | null;
  /** db row 가 있었지만 schema 검증 실패 → 코드 기본값으로 폴백 중. 에디터 경고용. */
  invalid?: boolean;
};

/**
 * 어드민 진단용 getter — 폴백 여부(source/invalid)까지 반환.
 * **핫패스는 throw 금지** 불변식: 읽기 실패/검증 실패 어떤 경우에도 코드 기본값으로 폴백.
 */
export async function getSettingWithMeta<T>(
  key: DomainKey,
  schema: ZodType<T>,
  codeDefault: T
): Promise<WithMeta<T>> {
  let row: Row | null = null;
  try {
    row = await cachedRead(key);
  } catch (e) {
    log.warn("config.read_throw", { key, ...errInfo(e) });
  }
  if (!row) return { value: codeDefault, source: "default", version: null };

  const parsed = schema.safeParse(row.value);
  if (!parsed.success) {
    // 검증 실패 = 폴백 + Sentry(log.error 가 브릿지). 핫패스 throw 방지.
    log.error("config.invalid", { key, version: row.version, issues: parsed.error.issues.length });
    return { value: codeDefault, source: "default", version: row.version, invalid: true };
  }
  return { value: parsed.data, source: "db", version: row.version };
}

/** 핫패스용 value-only getter. */
export async function getSetting<T>(
  key: DomainKey,
  schema: ZodType<T>,
  codeDefault: T
): Promise<T> {
  return (await getSettingWithMeta(key, schema, codeDefault)).value;
}
