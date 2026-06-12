import { Application, Texture, Ticker } from "pixi.js";
import { PlayScene, HitInfo } from "@/game/scenes/PlayScene";
import { Weapon } from "@/lib/weapons";

export type GameEvents = {
  onHit?: (info: HitInfo) => void;
  /** 낙서 비어있음 ↔ 있음 전이 시 호출 — picker 의 펜/지우개 토글용 */
  onDrawingChange?: (hasDrawing: boolean) => void;
};

export type CreateGameOptions = GameEvents & {
  dollTexture?: Texture;
  bgTexture?: Texture;
  weapon?: Weapon;
};

export type GameHandle = {
  destroy: () => void;
  setWeapon: (w: Weapon) => void;
  /** 배경 텍스처만 교체 — 점수/낙서 등 게임 상태 유지 */
  setBackground: (t: Texture) => void;
  /** 낙서 전체 삭제 — 점수 영향 없음 */
  clearDrawing: () => void;
};

/**
 * PixiJS Application 생성 + PlayScene 마운트.
 * 호출자(React) 는 cleanup 시 destroy() 호출, 무기 변경 시 setWeapon().
 *
 * @param isCancelled init(비동기) 완료 시점에 이 호출이 이미 취소됐는지.
 *   StrictMode 더블 마운트에서 늦게 끝난 취소본이 container.replaceChildren 으로
 *   살아있는 게임의 canvas 를 지워버리는 race 방지 — 취소됐으면 DOM 을 건드리지
 *   않고 자가 정리 후 null 반환.
 */
export async function createGame(
  container: HTMLElement,
  opts: CreateGameOptions = {},
  isCancelled?: () => boolean
): Promise<GameHandle | null> {
  // resizeTo 는 window resize 이벤트에만 반응해 container 크기 변화를 놓침
  // (모바일 주소창 수축, 회전 등) → renderer 와 layout 좌표계가 어긋나
  // 입력 hit-test 가 통째로 빗나감. ResizeObserver 에서 직접 resize 한다.
  const app = new Application();
  await app.init({
    background: 0x111418,
    antialias: true,
    resolution: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    autoDensity: true,
  });

  if (isCancelled?.()) {
    app.destroy(true, { children: true });
    return null;
  }

  // 이전 게임의 잔존 canvas 가 있다면 모두 제거 (race 안전망)
  container.replaceChildren();
  container.appendChild(app.canvas);
  // touch-action 은 PIXI EventSystem 이 init 에서 "none" 으로 설정 — 덮어쓰지 않음.
  // ("manipulation" 은 pan/pinch 를 허용해 모바일 드래그를 브라우저가 가로챔)
  app.canvas.style.display = "block";

  const scene = new PlayScene({
    app,
    dollTexture: opts.dollTexture,
    bgTexture: opts.bgTexture,
    weapon: opts.weapon,
    onHit: opts.onHit,
    onDrawingChange: opts.onDrawingChange,
  });
  app.stage.addChild(scene);
  // app.screen.width 가 DPR 가산값 반환하는 경우가 있어, container CSS 크기 명시 사용.
  const measure = () => {
    const rect = container.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  };
  const initial = measure();
  app.renderer.resize(initial.w, initial.h);
  scene.layout(initial.w, initial.h);

  const onTick = (ticker: Ticker) => {
    scene.update(ticker.deltaMS / 1000);
  };
  app.ticker.add(onTick);

  const ro = new ResizeObserver(() => {
    const m = measure();
    if (m.w <= 0 || m.h <= 0) return;
    app.renderer.resize(m.w, m.h);
    scene.layout(m.w, m.h);
  });
  ro.observe(container);

  // pixi 8.19 는 native pointercancel 을 display object 로 전달하지 않음 —
  // 브라우저가 제스처를 가로채 cancel 하면 진행 중이던 드래그 상태(fling 등)가
  // 영영 안 풀리므로 DOM 레벨에서 직접 받아 리셋.
  const onPointerCancel = () => scene.cancelActivePointers();
  app.canvas.addEventListener("pointercancel", onPointerCancel);

  return {
    destroy: () => {
      ro.disconnect();
      app.canvas.removeEventListener("pointercancel", onPointerCancel);
      app.ticker.remove(onTick);
      scene.destroy();
      app.destroy(true, { children: true });
    },
    setWeapon: (w: Weapon) => scene.setWeapon(w),
    setBackground: (t: Texture) => scene.setBackground(t),
    clearDrawing: () => scene.clearDrawing(),
  };
}
