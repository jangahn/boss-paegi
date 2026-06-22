"use client";

import { useEffect, type RefObject, type MutableRefObject } from "react";
import { createClient } from "@/lib/supabase/client";
import { resolveBackground } from "@/lib/backgrounds";
import { log, errInfo } from "@/lib/log";
import { asRole, type RoleId } from "@/lib/roles";
import type { Weapon } from "@/lib/weapons";
import type { GameHandle, CreateGameOptions } from "@/game/BossPaegiGame";

/**
 * Pixi 게임 인스턴스 생성/해제 — 인형·배경 텍스처 로드 후 createGame, 언마운트 시 destroy.
 * 게임 세션 생명주기(start/log/context)는 호출부(play page)에 별도로 둔다 — 여긴 Pixi 만.
 *
 * 무기/배경 변경은 재마운트가 아니라 hot-swap effect 에서 처리하므로 deps 는 dollId 만.
 * (start/hit 은 zustand 안정 액션, onHit/onDrawingChange 는 안정 setter 래퍼라 마운트 캡처로 충분.)
 */
export function useGameInit(opts: {
  dollId: string | null;
  stageRef: RefObject<HTMLDivElement | null>;
  gameRef: MutableRefObject<GameHandle | null>;
  weaponRef: MutableRefObject<Weapon>;
  bgKeyRef: MutableRefObject<string>;
  initialBgUrlRef: MutableRefObject<string | null>;
  onHit: NonNullable<CreateGameOptions["onHit"]>;
  onDrawingChange: (v: boolean) => void;
  setGameReady: (v: boolean) => void;
  setDollImageUrl: (url: string) => void;
  /** doll 의 롤을 호출부에 전달 (시비 멘트·게임오버 보고서 분기용). 기본 플레이(dollId 없음)는 미호출 → boss 유지. */
  setDollRole: (role: RoleId) => void;
}): void {
  const {
    dollId,
    stageRef,
    gameRef,
    weaponRef,
    bgKeyRef,
    initialBgUrlRef,
    onHit,
    onDrawingChange,
    setGameReady,
    setDollImageUrl,
    setDollRole,
  } = opts;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    let cancelled = false;
    let myHandle: GameHandle | undefined;

    (async () => {
      const { Assets } = await import("pixi.js");

      const [dollTexture, bgTexture] = await Promise.all([
        (async () => {
          // dollId 없으면 기본 부장님 이미지 — 실패 시 undefined (Graphics placeholder fallback)
          if (!dollId) {
            try {
              return await Assets.load("/sprites/boss-default.png");
            } catch (e) {
              log.warn("play.default_texture_fail", errInfo(e));
              return undefined;
            }
          }
          const sb = createClient();
          const { data } = await sb
            .from("dolls")
            .select("image_url, role")
            .eq("id", dollId)
            .single();
          if (!data?.image_url) return undefined;
          setDollImageUrl(data.image_url);
          setDollRole(asRole((data as { role?: string }).role));
          try {
            return await Assets.load(data.image_url);
          } catch (e) {
            log.warn("play.doll_texture_fail", { dollId, ...errInfo(e) });
            return undefined;
          }
        })(),
        Assets.load(initialBgUrlRef.current!).catch((e) => {
          log.warn("play.bg_texture_fail", errInfo(e));
          return undefined;
        }),
      ]);
      if (cancelled) return;

      const { createGame } = await import("@/game/BossPaegiGame");
      if (cancelled) return;
      const created = await createGame(
        el,
        {
          dollTexture,
          bgTexture,
          weapon: weaponRef.current,
          onHit,
          onDrawingChange,
        },
        () => cancelled
      );
      // 취소된 호출은 createGame 이 DOM 안 건드리고 null 반환 (자가 정리)
      if (!created) return;
      // race 안전망: createGame 반환 직후 cleanup 됐다면 즉시 destroy
      if (cancelled) {
        created.destroy();
        return;
      }
      myHandle = created;
      gameRef.current = created;
      setGameReady(true);
      log.info("play.game_ready", { dollId: dollId ?? "default" });

      // 생성하는 동안 사용자가 바꾼 무기/배경 재적용 (로딩 중 변경은
      // gameRef 가 null 이라 hot-swap effect 에서 조용히 유실됨)
      created.setWeapon(weaponRef.current);
      const latestBg = resolveBackground(bgKeyRef.current);
      if (latestBg.url !== initialBgUrlRef.current) {
        Assets.load(latestBg.url)
          .then((tex) => {
            if (!cancelled && tex && gameRef.current === created) {
              created.setBackground(tex);
            }
          })
          .catch(() => {});
      }
    })().catch((e) => {
      // 게임 init 자체 실패 — 로딩 화면이 안 풀림. 반드시 추적
      log.error("play.game_init_fail", { dollId: dollId ?? "default", ...errInfo(e) });
    });

    return () => {
      cancelled = true;
      if (myHandle) {
        myHandle.destroy();
        if (gameRef.current === myHandle) gameRef.current = null;
      }
    };
    // weapon/bg 변경은 별도 effect 에서 hot-swap (재마운트 X)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dollId]);
}
