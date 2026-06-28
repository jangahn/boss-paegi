import { z } from "zod";

// 이벤트/공지 — config 도메인이 아니라 전용 테이블(0043 events). 게시판(b)·팝업(a)·배너(c) 단일 소스.
export const EVENT_TYPES = ["notice", "event"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export function isEventType(s: string): s is EventType {
  return (EVENT_TYPES as readonly string[]).includes(s);
}
export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  notice: "공지",
  event: "이벤트",
};

export type EventStatus = "draft" | "published";

/** 배너 노출 지면 — 각 독립 제어(홈·갤러리·랭킹). */
export const BANNER_SURFACES = ["home", "gallery", "leaderboard"] as const;
export type BannerSurface = (typeof BANNER_SURFACES)[number];
/** 지면 → events 테이블 플래그 컬럼. */
export const BANNER_FLAG: Record<
  BannerSurface,
  "banner_home_active" | "banner_gallery_active" | "banner_leaderboard_active"
> = {
  home: "banner_home_active",
  gallery: "banner_gallery_active",
  leaderboard: "banner_leaderboard_active",
};
export const BANNER_SURFACE_LABEL: Record<BannerSurface, string> = {
  home: "홈",
  gallery: "갤러리",
  leaderboard: "랭킹",
};

/** 목록 페이지 크기(공개·어드민 공용). */
export const NEWS_PAGE_SIZE = 10;

/** DB 행(service_role getter 가 읽는 컬럼) — cover_image_path 는 상대경로, public URL 은 getter 가 파생. */
export type EventRow = {
  id: string;
  type: EventType;
  status: EventStatus;
  title: string;
  summary: string;
  body: string;
  cover_image_path: string | null;
  starts_at: string | null;
  ends_at: string | null;
  popup_active: boolean;
  banner_home_active: boolean;
  banner_gallery_active: boolean;
  banner_leaderboard_active: boolean;
  priority: number;
  pinned: boolean;
  noindex: boolean;
  popup_dismiss_days: number;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** 공개/뷰 투영 — cover_image_path → coverUrl(풀, og용)·coverThumbUrl(1.91:1 리사이즈, 목록 썸네일용) 파생. */
export type EventView = EventRow & {
  coverUrl: string | null;
  coverThumbUrl: string | null;
};

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

/** KST 로컬 datetime-local(YYYY-MM-DDTHH:mm) 또는 null/빈값 허용. 서버에서 timestamptz 로 변환. */
const optionalDateTime = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

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
