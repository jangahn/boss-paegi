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

  container.appendChild(app.canvas);
  app.canvas.style.touchAction = "manipulation";
  app.canvas.style.display = "block";

  const scene = new PlayScene({
    dollTexture: opts.dollTexture,
    bgTexture: opts.bgTexture,
    weapon: opts.weapon,
    onHit: opts.onHit,
  });
  app.stage.addChild(scene);
  scene.layout(app.screen.width, app.screen.height);

  const onTick = (ticker: Ticker) => {
    scene.update(ticker.deltaMS / 1000);
  };
  app.ticker.add(onTick);

  const ro = new ResizeObserver(() => {
    scene.layout(app.screen.width, app.screen.height);
  });
  ro.observe(container);

  return {
    destroy: () => {
      ro.disconnect();
      app.ticker.remove(onTick);
      scene.destroy();
      app.destroy(true, { children: true });
    },
    setWeapon: (w: Weapon) => scene.setWeapon(w),
  };
}
