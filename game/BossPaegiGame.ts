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
  /** 현재 점수 전달 — 임계 넘으면 캐릭터 꼬질꼬질 데칼 추가, 0 이면 초기화 */
  setDamageScore: (score: number) => void;
  /** 궁극기 발동 — 난사타 연출 */
  triggerUltimate: () => void;
  /** 게임 종료/중단 시 궁극기 난타 즉시 정지 */
  stopUltimate: () => void;
  /** 하이라이트 녹화용 — 캔버스 MediaStream (미지원 브라우저면 null) */
  captureStream: (fps?: number) => MediaStream | null;
  /** 렉 진단용 perf 통계 — DPR·추정 주사율·평균/p95 프레임타임(ms). 종료 시 텔레메트리로. */
  getPerfStats: () => { dpr: number; refreshHz: number; avgFrameMs: number; p95FrameMs: number };
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
  // 렌더 fill-rate 완화(모바일 고DPI 3x 가 30fps 강락되던 문제). backbuffer 픽셀이 DPR² 로 늘어
  //   GPU fill-rate 한계 → 렉. 일관 단일 캡(분기 없음):
  //   ① DPR 캡 1.75(2→1.75, 픽셀 −23%) ② antialias off(DPR 높아 계단 거의 안 보임) ③ high-performance.
  //   선명도/하이라이트 영상 약간 ↓ 감수. 모바일 ~45fps 목표 — /admin/analytics 로 측정 후 부족 시 1.5 로.
  //   데스크탑은 fill-rate 여유라 무영향(약간 덜 선명할 뿐).
  // preserveDrawingBuffer: WebGL 캡처(하이라이트 captureStream)가 합성 후 비워진 버퍼를 잡아
  //   Whale/Mac·iOS 에서 검은 프레임이 되는 문제 방지(전 기기). perf 비용 있으나 녹화 위해 유지.
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 1.75) : 1;
  await app.init({
    background: 0x111418,
    antialias: false,
    resolution: dpr,
    autoDensity: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
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
  // **정수 floor**: getBoundingClientRect 의 소수점 폭을 그대로 renderer.resize 에 먹이면 autoDensity 가
  //   캔버스 CSS 를 되쓰며 ±1px 오버플로 → 스크롤바 출현/소멸이 컨테이너 폭을 흔들어 ResizeObserver
  //   피드백 루프(특정 창 폭·분수 DPR 에서 좌우 진동, 줌으로 정상화)가 발생. floor 로 캔버스를 항상
  //   컨테이너 이하로 만들어 오버플로·스크롤바 자체를 차단(round 면 올림 시 여전히 넘쳐 루프 잔존).
  const measure = () => {
    const rect = container.getBoundingClientRect();
    return { w: Math.floor(rect.width), h: Math.floor(rect.height) };
  };
  const initial = measure();
  let lastW = initial.w;
  let lastH = initial.h;
  app.renderer.resize(initial.w, initial.h);
  scene.layout(initial.w, initial.h);

  // 프레임타임 표본(렉 진단용) — 초기 N프레임(에셋 디코드 잰크) 스킵 후 deltaMS 수집(캡).
  const frameSamples: number[] = [];
  let frameSkip = 30;
  const onTick = (ticker: Ticker) => {
    scene.update(ticker.deltaMS / 1000);
    if (frameSkip > 0) {
      frameSkip -= 1;
    } else if (frameSamples.length < 5000) {
      frameSamples.push(ticker.deltaMS);
    }
  };
  app.ticker.add(onTick);

  // 컨테이너 크기 변화 → renderer/layout 동기화. 두 경로 병행(같은 dedup 경로라 중복 호출 무해):
  //   ① ResizeObserver: 컨테이너 직접 변화(모바일 주소창 수축·레이아웃 시프트 — window resize 가 못 잡는 것)
  //   ② window/visualViewport resize: PC 창 크기 조절(일부 환경/타이밍에서 RO 가 늦거나 미발화하는 경우 대비)
  const applyResize = () => {
    const m = measure();
    if (m.w <= 0 || m.h <= 0) return;
    // 정수 dims 가 직전 적용값과 같으면 skip — 소수점 리플로우·스크롤바 oscillation 의 피드백 루프 차단.
    if (m.w === lastW && m.h === lastH) return;
    lastW = m.w;
    lastH = m.h;
    app.renderer.resize(m.w, m.h);
    scene.layout(m.w, m.h);
  };
  const ro = new ResizeObserver(applyResize);
  ro.observe(container);
  window.addEventListener("resize", applyResize);
  window.visualViewport?.addEventListener("resize", applyResize);

  // pixi 8.19 는 native pointercancel 을 display object 로 전달하지 않음 —
  // 브라우저가 제스처를 가로채 cancel 하면 진행 중이던 드래그 상태(fling 등)가
  // 영영 안 풀리므로 DOM 레벨에서 직접 받아 리셋.
  const onPointerCancel = () => scene.cancelActivePointers();
  app.canvas.addEventListener("pointercancel", onPointerCancel);

  return {
    destroy: () => {
      ro.disconnect();
      window.removeEventListener("resize", applyResize);
      window.visualViewport?.removeEventListener("resize", applyResize);
      app.canvas.removeEventListener("pointercancel", onPointerCancel);
      app.ticker.remove(onTick);
      scene.destroy();
      app.destroy(true, { children: true });
    },
    setWeapon: (w: Weapon) => scene.setWeapon(w),
    setBackground: (t: Texture) => scene.setBackground(t),
    clearDrawing: () => scene.clearDrawing(),
    setDamageScore: (score: number) => scene.setDamageScore(score),
    triggerUltimate: () => scene.triggerUltimate(),
    stopUltimate: () => scene.stopUltimate(),
    captureStream: (fps = 30) => {
      const c = app.canvas as HTMLCanvasElement & {
        captureStream?: (fps?: number) => MediaStream;
      };
      return typeof c.captureStream === "function" ? c.captureStream(fps) : null;
    },
    getPerfStats: () => {
      // 진단상 원본 DPR(캡 전) 보고 — 3x 디스플레이가 2로 캡됐는지 확인용(렌더 DPR=min(raw,2)).
      const rawDpr =
        typeof window !== "undefined" ? Math.round((window.devicePixelRatio || 1) * 100) / 100 : 1;
      const n = frameSamples.length;
      if (n === 0) return { dpr: rawDpr, refreshHz: 0, avgFrameMs: 0, p95FrameMs: 0 };
      const sorted = [...frameSamples].sort((a, b) => a - b);
      const sum = sorted.reduce((s, x) => s + x, 0);
      const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
      const minFrame = sorted[0] || 16.7;
      return {
        dpr: rawDpr,
        refreshHz: Math.min(360, Math.round(1000 / minFrame)), // 가장 빠른 프레임 ≈ 주사율 주기
        avgFrameMs: Math.round((sum / n) * 10) / 10,
        p95FrameMs: Math.round(p95 * 10) / 10,
      };
    },
  };
}
