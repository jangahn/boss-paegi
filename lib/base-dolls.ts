import type { RoleId } from "./roles/ids";
import type { Gender } from "./gender";

/**
 * 기본 캐릭터(정적 스프라이트) 어휘 — v1.42.
 *
 * 기본 부장님(`boss-m`) + 회원 추가 4종(`ceo-m`·`boss-f`·`teamlead-f`·`junior-m`). DB 행이 없는 코드 자산이며
 * `public/sprites/` 의 768×1024 누끼 PNG(캐릭터 높이 82%, 기본 부장님과 같은 규격, 256색 팔레트). 플레이 URL 은
 * `/play?doll=<key>` — 링크만 있으면 비회원도 플레이 가능, 갤러리 노출은 회원(비회원은 🔒 잠금 티저). 커스텀 캐릭터와 달리
 * 공유·삭제·역할 변경 메뉴가 없고 어드민 목록에도 나오지 않는다. 점수는 `scores.base_doll` 에 키를 기록(마이그레이션 0127,
 * null = 구 기록 = 기본 부장님). 롤·성별은 시비 멘트·보고서 보이스·공유 문구의 {호칭} 을 정한다.
 * 런타임 import 0(타입만) — 서버·클라·node --test 공용, DB CHECK 어휘(0127)와 같은 5종.
 */
export const BASE_DOLL_KEYS = ["boss-m", "ceo-m", "boss-f", "teamlead-f", "junior-m"] as const;
export type BaseDollKey = (typeof BASE_DOLL_KEYS)[number];
/** 파라미터 없는 `/play` = 기본 부장님. */
export const DEFAULT_BASE_DOLL: BaseDollKey = "boss-m";

export type BaseDoll = {
  key: BaseDollKey;
  role: RoleId;
  gender: Gender;
  /** public 정적 스프라이트 경로(서명 불필요) */
  image: string;
  /** 머리 크롭(256px 알파 PNG) — 홈 캐릭터 줄용. 프사 프리셋(v1.41, `lib/avatar-presets`)이 이 5종의 머리라 같은 자산을 쓴다. */
  face: string;
  /** 회원 추가 캐릭터(갤러리 '추가' 카드, 비회원은 잠금 티저). 기본 부장님만 false. */
  extra: boolean;
};

export const BASE_DOLLS: Readonly<Record<BaseDollKey, BaseDoll>> = {
  "boss-m": { key: "boss-m", role: "boss", gender: "male", image: "/sprites/boss-default.png", face: "/avatars/preset-1.png", extra: false },
  "ceo-m": { key: "ceo-m", role: "ceo", gender: "male", image: "/sprites/base/ceo-m.png", face: "/avatars/preset-5.png", extra: true },
  "boss-f": { key: "boss-f", role: "boss", gender: "female", image: "/sprites/base/boss-f.png", face: "/avatars/preset-3.png", extra: true },
  "teamlead-f": { key: "teamlead-f", role: "teamlead", gender: "female", image: "/sprites/base/teamlead-f.png", face: "/avatars/preset-4.png", extra: true },
  "junior-m": { key: "junior-m", role: "junior", gender: "male", image: "/sprites/base/junior-m.png", face: "/avatars/preset-2.png", extra: true },
};

/** 갤러리 '추가' 카드 순서 = 어휘 순서(사장님·부장님(여)·팀장님(여)·신입). */
export const EXTRA_BASE_DOLLS: readonly BaseDoll[] = BASE_DOLL_KEYS.map((k) => BASE_DOLLS[k]).filter((d) => d.extra);

const KEY_SET: ReadonlySet<string> = new Set(BASE_DOLL_KEYS);

export function isBaseDollKey(v: unknown): v is BaseDollKey {
  return typeof v === "string" && KEY_SET.has(v);
}

/** 키 → 기본 캐릭터. null·미지값(구 기록·잘못된 링크)은 기본 부장님. */
export function baseDollOf(key: string | null | undefined): BaseDoll {
  return isBaseDollKey(key) ? BASE_DOLLS[key] : BASE_DOLLS[DEFAULT_BASE_DOLL];
}

/** `/play?doll=` 값 해석 — 기본 캐릭터 키면 그 키, 없으면 boss-m, 그 외(uuid 등)는 null(커스텀 캐릭터). */
export function baseDollKeyFromParam(param: string | null | undefined): BaseDollKey | null {
  if (!param) return DEFAULT_BASE_DOLL;
  return isBaseDollKey(param) ? param : null;
}

export function playHrefFor(key: BaseDollKey): string {
  return key === DEFAULT_BASE_DOLL ? "/play" : `/play?doll=${key}`;
}

/** 텔레메트리·로그의 dollId 표기 — 기본 부장님은 종전 "default" 유지(롤업 호환), 추가 캐릭터는 키. */
export function telemetryBaseDollLabel(key: BaseDollKey | null | undefined): string {
  return !key || key === DEFAULT_BASE_DOLL ? "default" : key;
}
