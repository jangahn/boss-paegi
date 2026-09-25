import { z } from "zod";
import { EVENT_TYPES } from "./types.ts";

// 소식 저장 · 표지 경로 검증 schema(v1.64 분리) — zod 는 서버(어드민 저장 · 공개 읽기 투영)에서만 쓴다. 타입 · 라벨 · 노출 판정은
// `./types`(소식 · 배너 클라 번들에 들어간다).

/**
 * cover_image_path 검증(zod) — events 버킷 **상대경로**만(URL·절대경로·경로탈출·SVG 금지).
 * RPC·테이블 CHECK 와 동일 규칙(3중 방어). 빈 문자열/undefined → null.
 */
export const coverPathSchema = z
  .string()
  .trim()
  .max(300)
  .nullish()
  .transform((v) => (v ? v : null))
  .refine(
    (v) =>
      v === null ||
      (!v.includes("://") &&
        !v.startsWith("/") &&
        !v.includes("..") &&
        !/\.svg$/i.test(v)),
    "invalid_cover"
  );

function isValidKstLocalDateTime(value: string): boolean {
  const match =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/.exec(
      value,
    );
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59
  ) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= days[month - 1];
}

/** KST 로컬 datetime-local(YYYY-MM-DDTHH:mm) 또는 null/빈값 허용. 서버에서 timestamptz 로 변환. */
const optionalDateTime = z
  .string()
  .trim()
  .max(16)
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidKstLocalDateTime(v), "invalid_datetime");

/** 어드민 저장 페이로드(에디터 → /api/admin/events save). */
export const eventSaveSchema = z.object({
  id: z.string().uuid().nullish(),
  type: z.enum(EVENT_TYPES),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(50000),
  coverImagePath: coverPathSchema,
  startsAt: optionalDateTime,
  endsAt: optionalDateTime,
  popupActive: z.boolean().default(false),
  bannerHomeActive: z.boolean().default(false),
  bannerGalleryActive: z.boolean().default(false),
  bannerLeaderboardActive: z.boolean().default(false),
  priority: z.number().int().min(-1000).max(1000).default(0),
  pinned: z.boolean().default(false),
  noindex: z.boolean().default(false),
  popupDismissDays: z.number().int().min(1).max(365).default(7),
});
export type EventSaveInput = z.infer<typeof eventSaveSchema>;
