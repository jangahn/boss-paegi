"use client";

import Link from "next/link";
import { FadeImg } from "@/components/FadeImg";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { BASE_DOLL_KEYS, BASE_DOLLS, playHrefFor, type BaseDollKey } from "@/lib/base-dolls";
import { FOR_MEMBER_CLASS, FOR_NONMEMBER_CLASS } from "@/lib/member-hint";

const FACE = "h-12 w-12 rounded-full border border-foreground/10";

/** 홈의 로그인 상태 — 두 상태를 정적 HTML 에 같이 넣고 회원 힌트(lib/member-hint.ts 의 표시 클래스)로 하나만 보인다. */
export type HomeState = "nonmember" | "member";

/**
 * 홈 캐릭터 줄(v1.49) — 기본 캐릭터 5종 얼굴 한 줄. 정적 자산(`BaseDoll.face` = 프사 프리셋)이라 조회가 없다.
 * - 열린 캐릭터: 얼굴 탭 = 그 캐릭터로 바로 플레이(갤러리 카드와 같은 규칙, `playHrefFor`).
 * - 잠긴 캐릭터(비회원의 추가 4종): 갤러리 잠금 카드(`BaseDollCard`)와 같은 표현의 **무상호작용** 티저(v1.44 결정) —
 *   가입 유도는 아래 캡션(`home.lockedCaption`)과 2차 버튼이 맡는다.
 * 48px × 5 + 간격 6px × 4 = 264px — 375px 화면의 카드 안쪽 폭(271px)에 들어온다.
 * v1.51: 비회원용·회원용 줄을 둘 다 렌더한다 — 홈은 정적 페이지라 서버 HTML 이 로그인 상태를 모르므로, 첫 페인트 전에 붙는
 *   회원 힌트가 맞는 줄만 보이게 한다(새로고침 때 회원에게 비회원 줄이 잠깐 보이던 문제, lib/member-hint.ts).
 */
export function HomeCharacterRow({
  lockedCaption,
  onPlay,
}: {
  lockedCaption: string;
  onPlay: (key: BaseDollKey, state: HomeState) => void;
}) {
  return (
    <>
      <div className={`${FOR_NONMEMBER_CLASS} flex w-full flex-col items-center gap-2`}>
        <CharacterFaces state="nonmember" onPlay={onPlay} />
        <p className="text-xs text-zinc-500">{lockedCaption}</p>
      </div>
      <div className={`${FOR_MEMBER_CLASS} flex w-full flex-col items-center gap-2`}>
        <CharacterFaces state="member" onPlay={onPlay} />
      </div>
    </>
  );
}

function CharacterFaces({
  state,
  onPlay,
}: {
  state: HomeState;
  onPlay: (key: BaseDollKey, state: HomeState) => void;
}) {
  const roleCfg = useRoleConfig();
  return (
    <ul className="flex justify-center gap-1.5">
      {BASE_DOLL_KEYS.map((key) => {
        const doll = BASE_DOLLS[key];
        const label = roleFrom(doll.role, roleCfg).label; // DB 발행 호칭(부장님·사장님·팀장님·신입)
        const locked = state === "nonmember" && doll.extra;
        return (
          <li key={key} className="w-12">
            {locked ? (
              <div className="flex flex-col items-center gap-1" aria-label={`${label} — 가입하면 열림`}>
                <span className="relative block">
                  <FadeImg src={doll.face} className={`${FACE} opacity-60 blur-[2px] grayscale-[35%]`} />
                  <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
                    🔒
                  </span>
                </span>
                <span className="w-full truncate text-center text-[11px] font-semibold text-zinc-500">{label}</span>
              </div>
            ) : (
              <Link
                href={playHrefFor(key)}
                onClick={() => onPlay(key, state)}
                aria-label={`${label} 패기`}
                className="group flex flex-col items-center gap-1"
              >
                <FadeImg src={doll.face} loading="eager" className={`${FACE} transition duration-300 group-hover:scale-105`} />
                <span className="w-full truncate text-center text-[11px] font-semibold">{label}</span>
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
