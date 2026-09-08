"use client";

import { useState } from "react";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { ROLE_IDS, type RoleId } from "@/lib/roles";

/** 역할별 선택 카드 — 이모지(코드) + 호칭·한 줄 설명(DB 발행 config `roleFrom`, ROLE_META 는 fallback). */
const ROLE_EMOJI: Record<RoleId, string> = {
  boss: "💼",
  ceo: "👑",
  exec: "🏢",
  teamlead: "📋",
  client: "🤝",
  junior: "🎧",
  friend: "😏",
};

/**
 * 생성 직전 롤 선택 — 고른 롤이 fal 프롬프트(복장·표정·분위기)와 doll.role 에 반영된다.
 * 생성 1회당 생성권을 소모하므로, 카드 선택(하이라이트) → 확인 버튼의 2-스텝으로 오발 방지.
 */
export function RoleSelectStage({
  onConfirm,
  initialRole = "boss",
}: {
  onConfirm: (role: RoleId) => void;
  initialRole?: RoleId;
}) {
  const [selected, setSelected] = useState<RoleId>(initialRole);
  const cfg = useRoleConfig(); // DB 발행 호칭·설명

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6">
      <div className="text-center">
        <h2 className="text-xl font-bold">누구로 만들까요?</h2>
        <p className="mt-1 text-sm text-zinc-500">
          고른 역할에 따라 표정·복장·대사가 달라져요
        </p>
      </div>

      <div className="grid w-full grid-cols-2 gap-3">
        {ROLE_IDS.map((rid) => {
          const active = rid === selected;
          const role = roleFrom(rid, cfg);
          return (
            <button
              key={rid}
              type="button"
              onClick={() => setSelected(rid)}
              aria-pressed={active}
              className={`flex flex-col items-center gap-1.5 rounded-2xl border p-4 text-center transition ${
                active
                  ? "border-foreground bg-foreground/10 ring-2 ring-foreground"
                  : "border-foreground/15 hover:bg-foreground/5"
              }`}
            >
              <span className="text-3xl" aria-hidden>
                {ROLE_EMOJI[rid]}
              </span>
              <span className="text-sm font-semibold">{role.label}</span>
              <span className="text-[11px] leading-tight text-zinc-500">
                {role.desc}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onConfirm(selected)}
        className="w-full rounded-full bg-foreground py-3 font-semibold text-paper-2 transition hover:opacity-90"
      >
        이 역할로 캐릭터 만들기
      </button>
    </div>
  );
}
