import { Application, Texture, Ticker } from "pixi.js";
import { PlayScene, HitInfo } from "@/game/scenes/PlayScene";
import { Weapon } from "@/lib/weapons";

export type GameEvents = {
  onHit?: (info: HitInfo) => void;
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
};

/**
 * PixiJS Application 생성 + PlayScene 마운트.
 * 호출자(React) 는 cleanup 시 destroy() 호출, 무기 변경 시 setWeapon().
 */
export async function createGame(
  container: HTMLElement,
  opts: CreateGameOptions = {}
): Promise<GameHandle> {
  const app = new Application();
  await app.init({
    background: 0x111418,
    resizeTo: container,
    antialias: true,
    resolution: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    autoDensity: true,
  });

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
  });
  app.stage.addChild(scene);
  // app.screen.width 가 DPR 가산값 반환하는 경우가 있어, container CSS 크기 명시 사용.
  const measure = () => {
    const rect = container.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  };
  const initial = measure();
  scene.layout(initial.w, initial.h);

  const onTick = (ticker: Ticker) => {
    scene.update(ticker.deltaMS / 1000);
  };
  app.ticker.add(onTick);

  const ro = new ResizeObserver(() => {
    const m = measure();
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
  };
}
