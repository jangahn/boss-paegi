"use client";

import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";

export type MyProfile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  /** 멤버(=비익명, OAuth 로그인) 여부. 익명이면 false. */
  isMember: boolean;
  /** 잔여 생성권. 멤버만, 비멤버/조회실패는 null. */
  genCredits: number | null;
};

const NICKNAME_MAX = 12;
/** 이 이상이면 사실상 무제한(운영계정) 으로 표시. */
const UNLIMITED_THRESHOLD = 9999;

/** 생성권 표시 문구 — 무제한 임계 이상이면 "무제한". */
export function formatCredits(n: number): string {
  return n >= UNLIMITED_THRESHOLD ? "무제한" : `${n}개`;
}

/** 내 프로필 조회 — 세션 없으면 익명 세션 생성 후 조회. 멤버면 잔여 생성권도 함께. */
export async function getMyProfile(): Promise<MyProfile | null> {
  const session = await ensureAuth();
  const sb = createClient();
  const { data } = await sb
    .from("profiles")
    .select("id, display_name, avatar_url")
    .eq("id", session.user.id)
    .single();
  if (!data) return null;

  const isMember = session.user.is_anonymous !== true;
  let genCredits: number | null = null;
  if (isMember) {
    // member_accounts self-read RLS 로 본인 행만 조회. 실패 시 null(클라가 과하게 막지 않게).
    const { data: m } = await sb
      .from("member_accounts")
      .select("gen_credits")
      .eq("user_id", session.user.id)
      .maybeSingle();
    genCredits = (m?.gen_credits as number | undefined) ?? null;
  }

  return {
    id: data.id as string,
    display_name: data.display_name as string,
    avatar_url: (data.avatar_url as string | null) ?? null,
    isMember,
    genCredits,
  };
}

/**
 * 닉네임 수정 — RLS self update. 랭킹/공유는 profiles join 이라 즉시 반영.
 * @returns 정규화되어 저장된 닉네임
 */
export async function updateNickname(raw: string): Promise<string> {
  const name = raw.trim().slice(0, NICKNAME_MAX);
  if (name.length < 2) {
    throw new Error("닉네임은 2자 이상이어야 해요");
  }
  const session = await ensureAuth();
  const sb = createClient();
  const { error } = await sb
    .from("profiles")
    .update({ display_name: name })
    .eq("id", session.user.id);
  if (error) throw new Error("닉네임 저장 실패 — 잠시 후 다시 시도해주세요");
  return name;
}

export { NICKNAME_MAX };
