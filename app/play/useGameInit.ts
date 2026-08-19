"use client";

import { useEffect, type RefObject, type MutableRefObject } from "react";
import { createClient } from "@/lib/supabase/client";
import { log, errInfo } from "@/lib/log";
import type { RoleId } from "@/lib/roles";
import {
  PlayDollInitError,
  parsePlayDollLookup,
  parsePlayDollSignedUrl,
} from "@/lib/play-doll-init";
import type { Weapon } from "@/lib/weapons";
import type { GameHandle, CreateGameOptions } from "@/game/BossPaegiGame";
import { runBoundedClientJsonFetch } from "@/lib/client-mutation";
import { loadClientAssetWithDeadline } from "@/lib/client-asset-load";
import { runBoundedClientOperation } from "@/lib/client-operation";

/**
 * Pixi 게임 인스턴스 생성/해제 — 캐릭터·배경 텍스처 로드 후 createGame, 언마운트 시 destroy.
 * 게임 세션 생명주기(start/log/context)는 호출부(play page)에 별도로 둔다 — 여긴 Pixi 만.
 *
 * 무기/배경 변경은 재마운트가 아니라 hot-swap effect 에서 처리하므로 deps 는 dollId 만.
 * (start/hit 은 zustand 안정 액션, onHit/onDrawingChange 는 안정 setter 래퍼라 마운트 캡처로 충분.)
 */
export function useGameInit(opts: {
  dollId: string | null;
  initAttempt: number;
  stageRef: RefObject<HTMLDivElement | null>;
  gameRef: MutableRefObject<GameHandle | null>;
  weaponRef: MutableRefObject<Weapon>;
  bgKeyRef: MutableRefObject<string>;
  initialBgUrlRef: MutableRefObject<string | null>;
  onHit: NonNullable<CreateGameOptions["onHit"]>;
  onDrawingChange: (v: boolean) => void;
  setGameReady: (v: boolean) => void;
  setGameInitError: (message: string | null) => void;
  setDollImageUrl: (url: string) => void;
  /** doll 의 롤을 호출부에 전달 (시비 멘트·게임오버 보고서 분기용). 기본 플레이(dollId 없음)는 미호출 → boss 유지. */
  setDollRole: (role: RoleId) => void;
  onInitialBackgroundReady: (key: string) => void;
}): void {
  const {
    dollId,
    initAttempt,
    stageRef,
    gameRef,
    weaponRef,
    bgKeyRef,
    initialBgUrlRef,
    onHit,
    onDrawingChange,
    setGameReady,
    setGameInitError,
    setDollImageUrl,
    setDollRole,
    onInitialBackgroundReady,
  } = opts;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    let cancelled = false;
    let myHandle: GameHandle | undefined;
    const operationAbort = new AbortController();
    const initialBackgroundKey = bgKeyRef.current;
    setGameReady(false);
    setGameInitError(null);

    (async () => {
      const { Assets } = await import("pixi.js");

      const [dollTexture, bgTexture] = await Promise.all([
        (async () => {
          // 기본 플레이만 public 기본 이미지를 사용한다. 커스텀 캐릭터의 조회·
          // 서명·텍스처 오류를 기본 이미지로 위장하지 않는다.
          if (!dollId) {
            return loadClientAssetWithDeadline(
              () => Assets.load("/sprites/boss-default.png"),
              { signal: operationAbort.signal },
            );
          }
          const lookup = await runBoundedClientOperation(
            (signal) =>
              createClient()
                .from("dolls")
                .select("image_url, role")
                .eq("id", dollId)
                .abortSignal(signal)
                .maybeSingle(),
            { signal: operationAbort.signal },
          );
          const doll = parsePlayDollLookup(lookup.data, lookup.error);
          if (cancelled) return undefined;
          setDollRole(doll.role);
          // private 버킷 — image_url 은 경로. 서명 API로 signed URL 획득(본인 캐릭터·장기세션 ttl 3600).
          //   텍스처(게임 화면·녹화)는 **원본**, 게임종료 표시(ScoreReport)는 **384px 썸네일**(2개 병렬 서명).
          const sign = async (thumb: boolean): Promise<string> => {
            const delivery = await runBoundedClientJsonFetch({
              input: "/api/doll/signed-urls",
              init: {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ids: [dollId],
                  ttl: 3600,
                  ...(thumb ? { thumb: true } : {}),
                }),
              },
              signal: operationAbort.signal,
            });
            if (delivery.kind !== "confirmed") {
              throw new Error("play_doll_sign_response_unconfirmed");
            }
            const { response, body } = delivery.value;
            if (!response.ok) {
              throw new Error(`play_doll_sign_http_${response.status}`);
            }
            return parsePlayDollSignedUrl(dollId, body);
          };
          const [fullUrl, thumbUrl] = await Promise.all([
            sign(false),
            sign(true),
          ]);
          if (cancelled) return undefined;
          setDollImageUrl(thumbUrl);
          return loadClientAssetWithDeadline(
            () => Assets.load(fullUrl),
            { signal: operationAbort.signal },
          ); // 텍스처는 원본 유지
        })(),
        (async () => {
          const backgroundUrl = initialBgUrlRef.current;
          if (!backgroundUrl) throw new Error("play_background_not_decided");
          return loadClientAssetWithDeadline(
            () => Assets.load(backgroundUrl),
            { signal: operationAbort.signal },
          );
        })(),
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
      onInitialBackgroundReady(initialBackgroundKey);
      setGameReady(true);
      log.info("play.game_ready", { dollId: dollId ?? "default" });

      // 생성하는 동안 사용자가 바꾼 무기는 즉시 재적용한다. 배경은 페이지의
      // 성공-확정 hot-swap effect가 처리해 로드 실패 시 상태를 롤백한다.
      created.setWeapon(weaponRef.current);
    })().catch((e) => {
      log.error("play.game_init_fail", { dollId: dollId ?? "default", ...errInfo(e) });
      if (!cancelled) {
        setGameReady(false);
        // doll_unavailable 은 결정적 상태(다른 사용자의 캐릭터 링크·삭제된 캐릭터)
        // — "연결 확인 후 재시도"로 안내하면 헛된 재시도만 유도한다(2026-08-19
        // 실관측: 같은 사용자가 남의 캐릭터 URL 로 3회 연속 재시도).
        setGameInitError(
          e instanceof PlayDollInitError && e.message === "doll_unavailable"
            ? "이 캐릭터는 내 계정에서 플레이할 수 없어요. 삭제됐거나 다른 사용자의 캐릭터 주소예요. 내 갤러리에서 캐릭터를 선택해주세요."
            : "게임을 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.",
        );
      }
    });

    return () => {
      cancelled = true;
      operationAbort.abort(new Error("game_init_inactive"));
      if (myHandle) {
        myHandle.destroy();
        if (gameRef.current === myHandle) gameRef.current = null;
      }
    };
    // weapon/bg 변경은 별도 effect 에서 hot-swap (재마운트 X)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dollId, initAttempt]);
}
