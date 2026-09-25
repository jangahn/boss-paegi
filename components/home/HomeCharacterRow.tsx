"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FadeImg } from "@/components/FadeImg";
import { useExitClone } from "@/components/motion/useExitClone";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom, roleVoice } from "@/lib/config/domains/roles";
import { playJelly, prefersReducedMotion } from "@/lib/motion";
import { clearPlayDollSource, markPlayDollSource, PLAY_TRANSITION } from "@/lib/view-transition";
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
 * v1.65: 열린 얼굴은 누르는 순간 게임 인형과 같은 젤리 곡선으로 출렁이고(lib/jelly.ts), 화면에 보이는 동안 가끔 한 얼굴이
 *   시비 멘트(롤 콘텐츠 시비 멘트 0단계 — 게임 속 도발과 같은 문구, 새 문구 없음)로 도발한다. 잠긴 얼굴은 그대로 무상호작용.
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

/** 도발 말풍선 — 첫 도발까지 · 도발 사이 · 보이는 시간(ms). */
const TAUNT_FIRST_MS = 2500;
const TAUNT_EVERY_MS = 7000;
const TAUNT_SHOW_MS = 2800;

function CharacterFaces({
  state,
  onPlay,
}: {
  state: HomeState;
  onPlay: (key: BaseDollKey, state: HomeState) => void;
}) {
  const roleCfg = useRoleConfig();
  const rowRef = useRef<HTMLDivElement>(null);
  const [taunt, setTaunt] = useState<{ id: number; text: string; x: number } | null>(null);

  // 가끔 한 얼굴이 도발 — 이 줄이 화면에 보일 때만(회원 힌트로 숨은 줄 · 탭 숨김 · 스크롤 밖이면 쉼). 모션 감소면 하지 않는다.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const openKeys = BASE_DOLL_KEYS.filter((key) => !(state === "nonmember" && BASE_DOLLS[key].extra));
    let hideTimer = 0;
    let lastText = "";
    let id = 0;
    const tick = () => {
      const row = rowRef.current;
      if (!row || document.visibilityState !== "visible" || row.offsetParent === null) return;
      const rect = row.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;
      const key = openKeys[Math.floor(Math.random() * openKeys.length)];
      const doll = BASE_DOLLS[key];
      const lines = (roleVoice(roleFrom(doll.role, roleCfg), doll.gender).taunts[0] ?? []).filter((l) => l !== lastText);
      if (!lines.length) return;
      const text = lines[Math.floor(Math.random() * lines.length)];
      lastText = text;
      const face = row.querySelector(`[data-face="${key}"]`);
      const faceRect = face?.getBoundingClientRect();
      const x = faceRect ? faceRect.left + faceRect.width / 2 - rect.left : rect.width / 2;
      id += 1;
      setTaunt({ id, text, x });
      playJelly(face?.querySelector("[data-jelly]") ?? null, { amp: 0.09 });
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setTaunt(null), TAUNT_SHOW_MS);
    };
    const first = window.setTimeout(tick, TAUNT_FIRST_MS);
    const every = window.setInterval(tick, TAUNT_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
      window.clearTimeout(hideTimer);
    };
  }, [roleCfg, state]);

  return (
    <div ref={rowRef} className="relative">
    {taunt && <TauntBubble key={taunt.id} text={taunt.text} x={taunt.x} rowRef={rowRef} />}
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
                  <FadeImg src={doll.face} loading="eager" className={`${FACE} opacity-60 blur-[2px] grayscale-[35%]`} />
                  <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
                    🔒
                  </span>
                </span>
                <span className="w-full truncate text-center text-[11px] font-semibold text-zinc-500">{label}</span>
              </div>
            ) : (
              <Link
                href={playHrefFor(key)}
                transitionTypes={[PLAY_TRANSITION]}
                onClick={() => onPlay(key, state)}
                onPointerDown={(e) => {
                  const face = e.currentTarget.querySelector<HTMLElement>("[data-jelly]");
                  playJelly(face);
                  markPlayDollSource(face, key); // 이 얼굴이 게임 로딩 막의 캐릭터로 이어진다(lib/view-transition.ts)
                }}
                onPointerCancel={clearPlayDollSource}
                data-face={key}
                aria-label={`${label} 패기`}
                className="group flex flex-col items-center gap-1"
              >
                {/* 찌르기 출렁임은 바깥 틀에(호버 확대는 이미지의 scale) — lib/motion.ts playJelly */}
                <span data-jelly className="block">
                  <FadeImg src={doll.face} loading="eager" className={`${FACE} transition duration-300 group-hover:scale-105`} />
                </span>
                <span className="w-full truncate text-center text-[11px] font-semibold">{label}</span>
              </Link>
            )}
          </li>
        );
      })}
    </ul>
    </div>
  );
}

/**
 * 도발 말풍선(v1.65) — 얼굴 위 가운데, 줄 폭 안으로 당기고 꼬리는 얼굴을 가리킨다(폭은 글에 따라 달라 그린 뒤 잰다).
 * 톡 튀어나오고(motion-bubble, 크기만 — 글자 opacity 없음) 사라질 때는 복제본이 줄어든다(useExitClone). 장식이라 화면낭독기에서 뺀다.
 */
function TauntBubble({ text, x, rowRef }: { text: string; x: number; rowRef: RefObject<HTMLDivElement | null> }) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const row = rowRef.current;
    if (!bubble || !row) return;
    const w = bubble.offsetWidth;
    const left = Math.min(Math.max(x - w / 2, -8), row.clientWidth - w + 8);
    bubble.style.left = `${left}px`;
    const tail = bubble.querySelector<HTMLElement>("[data-tail]");
    if (tail) tail.style.left = `${x - left}px`;
  }, [x, rowRef]);
  useExitClone(bubbleRef, (clone) => {
    clone.style.transformOrigin = "50% 100%";
    return clone.animate([{ scale: "1" }, { scale: "0" }], { duration: 120, easing: "ease-in", fill: "forwards" });
  });
  return (
    <div
      ref={bubbleRef}
      aria-hidden
      className="motion-bubble pointer-events-none absolute bottom-full z-10 mb-2 w-max max-w-[15.5rem] rounded-2xl bg-white px-3 py-1.5 text-center text-xs font-semibold text-balance text-zinc-900 shadow-lg"
    >
      {text}
      <span data-tail className="absolute -bottom-1 -ml-1.5 h-3 w-3 rotate-45 bg-white" />
    </div>
  );
}
