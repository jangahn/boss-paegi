import {
  BitmapFont,
  BitmapText,
  Container,
  Graphics,
  GraphicsContext,
  Text,
} from "pixi.js";

/** 5각 별 꼭짓점 (외경 r) */
function starPoints(r: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    pts.push(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  return pts;
}

const DEBRIS_CHARS = "ㄱㄴㄷㄹㅁㅂㅅㅇㅋㅌ@#!?";
/** 글자 파편 폰트 크기 버킷 — 풀 키 수를 제한 */
const DEBRIS_SIZES = [16, 20, 24];

/**
 * 공유 지오메트리(2026-09 성능) — 파티클 종류별 GraphicsContext 를 1회 빌드하고
 * 인스턴스는 `new Graphics({ context })` 로 공유한다(지오메트리 재빌드·GPU 업로드 0).
 * 색은 tint, 크기는 scale 로 — 시각 결과는 종전과 동일.
 */
const SHARED = {
  /** 반경 6 흰 원 — burst 파티클(tint=팔레트, scale=r/6) */
  circle: new GraphicsContext().circle(0, 0, 6).fill(0xffffff),
  /** 외경 12 별(노랑+연노랑 코어 베이크) — scale=r/12 */
  star: new GraphicsContext()
    .poly(starPoints(12))
    .fill(0xffd166)
    .poly(starPoints(12 * 0.45))
    .fill(0xfff3c4),
  /** 반경 5 눈물(하이라이트 포함) — scale=r/5 */
  tear: new GraphicsContext()
    .circle(0, 0, 5)
    .fill({ color: 0x7cc7ff, alpha: 0.95 })
    .circle(-1.5, -1.5, 1.75)
    .fill({ color: 0xffffff, alpha: 0.8 }),
  /** 반경 4 진땀 — scale=r/4 */
  sweat: new GraphicsContext().circle(0, 0, 4).fill({ color: 0xbfe6ff, alpha: 0.9 }),
  /** 탄환 파편(흰 캡슐, tint=무기색) */
  rico: new GraphicsContext()
    .roundRect(-6, -1.8, 12, 3.6, 1.8)
    .fill(0xffffff)
    .roundRect(-3, -0.9, 6, 1.8, 0.9)
    .fill({ color: 0xffffff, alpha: 0.85 }),
};

/** 점수 팝 비트맵 폰트 — 브라우저에서 1회 설치(글리프 아틀라스 캐시, 팝마다 래스터화 없음). node 테스트는 Text 폴백. */
const SCORE_FONT = "BossPaegiScorePop";
let scoreFontState: "unknown" | "ready" | "unavailable" = "unknown";
function scoreFontReady(): boolean {
  if (scoreFontState !== "unknown") return scoreFontState === "ready";
  if (typeof document === "undefined") {
    scoreFontState = "unavailable";
    return false;
  }
  try {
    BitmapFont.install({
      name: SCORE_FONT,
      style: {
        fontSize: 22,
        fontWeight: "900",
        fill: 0xffffff, // tint 로 무기색 착색(검은 스트로크는 tint 무영향)
        stroke: { color: 0x000000, width: 4 },
      },
    });
    scoreFontState = "ready";
  } catch {
    scoreFontState = "unavailable";
  }
  return scoreFontState === "ready";
}

type Particle = {
  g: Graphics;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
};

type Shockwave = {
  g: Graphics;
  life: number;
  ttl: number;
  startR: number;
  endR: number;
  color: number;
};

type ScorePop = {
  g: Container;
  key: string;
  life: number;
  ttl: number;
  vy: number;
};

type PaperPiece = {
  g: Graphics;
  vx: number;
  vy: number;
  spin: number;
  wobblePhase: number;
  life: number;
  ttl: number;
};

type EmojiPop = {
  t: Text;
  key: string;
  life: number;
  ttl: number;
  /** true 면 -0.9rad 에서 0 으로 휘두르는 스윙 (뿅망치) */
  swing: boolean;
};

type Flash = {
  g: Graphics;
  life: number;
  ttl: number;
  peak: number;
};

/** 회전/개별중력 있는 자유 파편 — 별·눈물·땀·글자 (Graphics/Text 공용). key = 풀 반환 키 */
type Debris = {
  node: Container;
  key: string;
  vx: number;
  vy: number;
  spin: number;
  grav: number;
  life: number;
  ttl: number;
};

/** 짧은 스케일-페이드 플레어 — 임팩트 라인·히트마커·싸대기 궤적 */
type Flare = {
  g: Graphics;
  life: number;
  ttl: number;
  /** 스케일 시작→끝 */
  s0: number;
  s1: number;
};

const DEFAULT_COLORS = [0xffd166, 0xef476f, 0xff9f1c, 0xfdf6e3];

/**
 * 일회성 파티클 + shockwave + score popup. 자체 ticker 없음 — 외부 update(delta).
 */
export class HitEffect extends Container {
  private particles: Particle[] = [];
  private shockwaves: Shockwave[] = [];
  private scorePops: ScorePop[] = [];
  private paperPieces: PaperPiece[] = [];
  private emojiPops: EmojiPop[] = [];
  private flashes: Flash[] = [];
  private debris: Debris[] = [];
  private flares: Flare[] = [];
  /** 궁극기 집중선 — 두 프레임을 번갈아 깜빡이는 만화 스피드라인 */
  private speedLineFrames: Graphics[] | null = null;
  private speedLineTick = 0;
  private stamps: { node: Container; key: string; life: number; ttl: number }[] = [];
  /** 투척물 잔상 — 비행 중 뒤에 남는 반투명 이모지 */
  private ghosts: { t: Text; key: string; life: number; ttl: number }[] = [];
  /** 노드 풀 — 키별 free list. 파티클·이모지·글자·점수 팝을 파괴 대신 반환해 재사용 */
  private pools = new Map<string, Container[]>();

  /** 사전 래스터화 대기 노드 — 첫 update 에서 한 프레임 그려진 뒤 풀로 반환 */
  private warmups: { key: string; node: Container }[] = [];

  constructor() {
    super();
    // 워밍업 — 첫 점수 팝에서 폰트 설치·글리프 생성 비용(콜드 30~40ms)이 프레임에 얹히지 않게
    scoreFontReady();
  }

  /**
   * 이모지 텍스트 사전 래스터화 — 궁극기가 9개 무기 이모지를 랜덤으로 쓰면서 처음 쓰는 이모지의
   * 텍스처 생성이 난타 중반 프레임에 몰려 ~120ms 스파이크가 나던 것(실측)을 씬 시작 시로 옮긴다.
   * 노드를 거의 투명하게 한 프레임 그린 뒤 풀로 돌려 텍스처 캐시를 데운다.
   */
  prewarm(entries: { emoji: string; size: number }[]) {
    if (typeof document === "undefined") return;
    for (const e of entries) {
      const size = Math.round(e.size);
      const key = `emoji:${e.emoji}:${size}`;
      const node = this.acquire(key, () => this.makeEmoji(e.emoji, size));
      node.alpha = 0.02;
      node.x = -9999;
      this.warmups.push({ key, node });
    }
    if (scoreFontReady()) {
      const key = "score:bitmap";
      const t = this.acquire(key, () => {
        const bt = new BitmapText({ text: "+0123456789", style: { fontFamily: SCORE_FONT, fontSize: 22 } });
        bt.anchor.set(0.5);
        return bt;
      });
      t.text = "+0123456789";
      t.alpha = 0.02;
      t.x = -9999;
      this.warmups.push({ key, node: t });
    }
  }

  /** 풀에서 꺼내거나 생성해 자식으로 부착. 공통 transform 은 초기화(anchor 등 고정 속성은 유지). */
  private acquire<T extends Container>(key: string, make: () => T): T {
    const list = this.pools.get(key);
    const pooled = list?.pop() as T | undefined;
    const node = pooled ?? make();
    node.visible = true;
    node.alpha = 1;
    node.rotation = 0;
    node.scale.set(1);
    this.addChild(node);
    return node;
  }

  private release(key: string, node: Container) {
    this.removeChild(node);
    node.visible = false;
    let list = this.pools.get(key);
    if (!list) {
      list = [];
      this.pools.set(key, list);
    }
    if (list.length < 256) list.push(node);
    else node.destroy({ children: true });
  }

  private makeShared(ctx: GraphicsContext): Graphics {
    return new Graphics({ context: ctx });
  }

  private makeEmoji(emoji: string, size: number): Text {
    const t = new Text({ text: emoji, style: { fontSize: size } });
    t.anchor.set(0.5);
    return t;
  }

  destroy(options?: Parameters<Container["destroy"]>[0]) {
    for (const list of this.pools.values()) {
      for (const node of list) node.destroy({ children: true });
    }
    this.pools.clear();
    super.destroy(options);
  }

  /** 화면 전체 플래시 — 궁극기 마무리 등 임팩트용 (좌표 0,0 ~ viewW,viewH) */
  flash(viewW: number, viewH: number, color = 0xffffff, peak = 0.7, ttl = 0.4) {
    const g = new Graphics();
    g.rect(0, 0, viewW, viewH).fill(color);
    g.alpha = peak;
    this.addChild(g);
    this.flashes.push({ g, life: 0, ttl, peak });
  }

  burst(x: number, y: number, count = 10, baseColor?: number) {
    const palette = baseColor !== undefined
      ? [baseColor, baseColor, ...DEFAULT_COLORS]
      : DEFAULT_COLORS;
    for (let i = 0; i < count; i++) {
      const g = this.acquire("circle", () => this.makeShared(SHARED.circle));
      const r = 4 + Math.random() * 6;
      g.scale.set(r / 6);
      g.tint = palette[i % palette.length];
      g.x = x;
      g.y = y;

      const angle = Math.random() * Math.PI * 2;
      const speed = 200 + Math.random() * 250;
      this.particles.push({
        g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 180,
        life: 0,
        ttl: 0.6 + Math.random() * 0.3,
      });
    }
  }

  /** 임팩트 — 큰 ring 1개 + 발산 페이드. 타격감 강조용. */
  shockwave(x: number, y: number, startR = 20, endR = 140, color = 0xffffff) {
    const g = new Graphics();
    g.x = x;
    g.y = y;
    this.addChild(g);
    this.shockwaves.push({ g, life: 0, ttl: 0.35, startR, endR, color });
  }

  /** 종이 흩뿌려짐 — 조각들이 팔랑팔랑 흩어지며 낙하. (책 = 베이지 책장) */
  paperScatter(x: number, y: number, count = 10, color = 0xffffff) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const w = 8 + Math.random() * 10;
      const h = 10 + Math.random() * 14;
      g.roundRect(-w / 2, -h / 2, w, h, 2).fill({
        color,
        alpha: 0.95,
      });
      g.x = x;
      g.y = y;
      g.rotation = Math.random() * Math.PI * 2;
      this.addChild(g);

      const angle = Math.random() * Math.PI * 2;
      const speed = 120 + Math.random() * 220;
      this.paperPieces.push({
        g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 120,
        spin: (Math.random() - 0.5) * 10,
        wobblePhase: Math.random() * Math.PI * 2,
        life: 0,
        ttl: 0.9 + Math.random() * 0.6,
      });
    }
  }

  /** 타격 지점에 무기 이모지가 뿅 나타났다 사라짐 (주먹/뿅망치 등) */
  emojiPop(
    x: number,
    y: number,
    emoji: string,
    opts?: { size?: number; swing?: boolean }
  ) {
    const size = Math.round(opts?.size ?? 56);
    const key = `emoji:${emoji}:${size}`;
    const t = this.acquire(key, () => this.makeEmoji(emoji, size));
    t.x = x;
    t.y = y;
    t.scale.set(0.5);
    if (opts?.swing) t.rotation = -0.9;
    this.emojiPops.push({ t, key, life: 0, ttl: 0.32, swing: !!opts?.swing });
  }

  /** 궁극기 집중선 시작 — 화면 가장자리에서 중심을 향하는 쐐기 2세트 교차 깜빡임 */
  startSpeedLines(viewW: number, viewH: number) {
    this.stopSpeedLines();
    const cx = viewW / 2;
    const cy = viewH * 0.55;
    const maxR = Math.hypot(viewW, viewH);
    const frames: Graphics[] = [];
    for (let f = 0; f < 2; f++) {
      const g = new Graphics();
      const count = 26;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + f * (Math.PI / count) + Math.random() * 0.08;
        const inner = maxR * (0.34 + Math.random() * 0.14);
        const outer = maxR;
        const half = 0.012 + Math.random() * 0.012;
        g.poly([
          cx + Math.cos(a - half) * outer, cy + Math.sin(a - half) * outer,
          cx + Math.cos(a + half) * outer, cy + Math.sin(a + half) * outer,
          cx + Math.cos(a) * inner, cy + Math.sin(a) * inner,
        ]).fill({ color: 0xffffff, alpha: 0.28 + Math.random() * 0.18 });
      }
      g.visible = f === 0;
      this.addChild(g);
      frames.push(g);
    }
    this.speedLineFrames = frames;
    this.speedLineTick = 0;
  }

  stopSpeedLines() {
    if (!this.speedLineFrames) return;
    for (const g of this.speedLineFrames) {
      this.removeChild(g);
      g.destroy();
    }
    this.speedLineFrames = null;
  }

  /** 도장 쾅 — 궁극기 피니시 "반려" 스탬프 (도시에 인사기록부 톤) */
  stampPop(x: number, y: number, text: string) {
    const key = `stamp:${text}`;
    const wrap = this.acquire(key, () => {
      const node = new Container();
      const t = new Text({
        text,
        style: {
          fontSize: 72,
          fontWeight: "900",
          fill: 0xd72638,
          letterSpacing: 6,
        },
      });
      t.anchor.set(0.5);
      const pad = 22;
      const frame = new Graphics();
      frame
        .roundRect(-t.width / 2 - pad, -t.height / 2 - pad * 0.55, t.width + pad * 2, t.height + pad * 1.1, 10)
        .stroke({ color: 0xd72638, width: 7, alpha: 0.95 });
      node.addChild(frame);
      node.addChild(t);
      return node;
    });
    wrap.rotation = -0.18;
    wrap.x = x;
    wrap.y = y;
    wrap.scale.set(2.2);
    wrap.alpha = 0;
    this.stamps.push({ node: wrap, key, life: 0, ttl: 1.25 });
  }

  /** 타격 방사선 — 만화식 임팩트 라인이 바깥으로 확 퍼지며 사라짐 */
  impactLines(x: number, y: number, color = 0xffffff, count = 8) {
    const g = new Graphics();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.35;
      const r0 = 22 + Math.random() * 6;
      const r1 = r0 + 26 + Math.random() * 18;
      const wHalf = 2.2 + Math.random() * 1.6;
      const px = Math.cos(a);
      const py = Math.sin(a);
      const ox = -py * wHalf;
      const oy = px * wHalf;
      g.poly([
        px * r0 + ox, py * r0 + oy,
        px * r0 - ox, py * r0 - oy,
        px * r1, py * r1,
      ]).fill({ color, alpha: 0.9 });
    }
    g.x = x;
    g.y = y;
    this.addChild(g);
    this.flares.push({ g, life: 0, ttl: 0.18, s0: 0.6, s1: 1.35 });
  }

  /** 탄도 트레이서 — 총구에서 탄 방향으로 짧은 광선이 번쩍 (히트스캔 느낌) */
  tracer(x0: number, y0: number, x1: number, y1: number, color = 0xfff1a8) {
    const g = new Graphics();
    g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color, width: 2.5, alpha: 0.85, cap: "round" });
    g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: 0xffffff, width: 1, alpha: 0.9, cap: "round" });
    this.addChild(g);
    this.flares.push({ g, life: 0, ttl: 0.09, s0: 1, s1: 1 });
  }

  /** 총구 섬광 — 짧은 노란 스파이크 */
  muzzleFlash(x: number, y: number, dirX: number, dirY: number) {
    const g = new Graphics();
    const ang = Math.atan2(dirY, dirX);
    for (let i = -1; i <= 1; i++) {
      const a = ang + i * 0.45;
      const len = i === 0 ? 26 : 16;
      g.moveTo(Math.cos(a) * 6, Math.sin(a) * 6)
        .lineTo(Math.cos(a) * len, Math.sin(a) * len)
        .stroke({ color: 0xffe066, width: i === 0 ? 5 : 3, alpha: 0.95, cap: "round" });
    }
    g.circle(0, 0, 5).fill({ color: 0xffffff, alpha: 0.9 });
    g.x = x;
    g.y = y;
    this.addChild(g);
    this.flares.push({ g, life: 0, ttl: 0.07, s0: 0.8, s1: 1.3 });
  }

  /** 탄환 튕김 — 맞은 자리에서 입사 반대쪽으로 팍 튀어 회전하며 낙하 */
  ricochet(x: number, y: number, vx: number, vy: number, color: number) {
    const speed = Math.hypot(vx, vy) || 1;
    const nx = vx / speed;
    const ny = vy / speed;
    for (let i = 0; i < 2; i++) {
      const g = this.acquire("rico", () => this.makeShared(SHARED.rico));
      g.tint = color;
      g.x = x;
      g.y = y;
      // 반사 + 랜덤 산란 + 위쪽 편향
      const scatter = (Math.random() - 0.5) * 1.4;
      const ca = Math.cos(scatter);
      const sa = Math.sin(scatter);
      const rx = -nx * ca + ny * sa;
      const ry = -ny * ca - nx * sa;
      const out = 260 + Math.random() * 220;
      this.debris.push({
        node: g,
        key: "rico",
        vx: rx * out,
        vy: ry * out - 140,
        spin: (Math.random() - 0.5) * 30,
        grav: 1400,
        life: 0,
        ttl: 0.42 + Math.random() * 0.2,
      });
    }
  }

  /** 투척 잔상 — 반투명 이모지가 그 자리에 잠깐 남았다 사라짐 */
  ghost(x: number, y: number, emoji: string, size: number, rotation: number) {
    const px = Math.round(size);
    const key = `emoji:${emoji}:${px}`;
    const t = this.acquire(key, () => this.makeEmoji(emoji, px));
    t.x = x;
    t.y = y;
    t.rotation = rotation;
    t.alpha = 0.45;
    this.ghosts.push({ t, key, life: 0, ttl: 0.16 });
  }

  /** 비비탄 히트마커 — X자 4선 */
  hitMarker(x: number, y: number, color = 0xffffff) {
    const g = new Graphics();
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const px = Math.cos(a);
      const py = Math.sin(a);
      g.moveTo(px * 7, py * 7)
        .lineTo(px * 16, py * 16)
        .stroke({ color, width: 3.5, cap: "round" });
    }
    g.x = x;
    g.y = y;
    this.addChild(g);
    this.flares.push({ g, life: 0, ttl: 0.16, s0: 0.7, s1: 1.25 });
  }

  /** 싸대기 궤적 — 진행 방향 호 스워시 */
  slapArc(x: number, y: number, dirX: number, dirY: number, color = 0xffffff) {
    const g = new Graphics();
    const ang = Math.atan2(dirY, dirX);
    g.arc(0, 0, 34, -0.85, 0.85).stroke({ color, width: 7, alpha: 0.75, cap: "round" });
    g.arc(0, 0, 48, -0.6, 0.6).stroke({ color, width: 4, alpha: 0.45, cap: "round" });
    g.rotation = ang;
    g.x = x;
    g.y = y;
    this.addChild(g);
    this.flares.push({ g, life: 0, ttl: 0.22, s0: 0.7, s1: 1.5 });
  }

  /** 별 파편 — 뿅망치/해롱. 노란 별이 튀어오르며 회전 낙하 */
  starBurst(x: number, y: number, count = 6) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire("star", () => this.makeShared(SHARED.star));
      const r = 9 + Math.random() * 8;
      g.scale.set(r / 12);
      g.x = x;
      g.y = y;
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const speed = 190 + Math.random() * 260;
      this.debris.push({
        node: g,
        key: "star",
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        spin: (Math.random() - 0.5) * 9,
        grav: 760,
        life: 0,
        ttl: 0.6 + Math.random() * 0.35,
      });
    }
  }

  /** 키보드 파편 — 자모/특수문자가 튀어나옴 */
  letterDebris(x: number, y: number, count = 7) {
    for (let i = 0; i < count; i++) {
      const ch = DEBRIS_CHARS[Math.floor(Math.random() * DEBRIS_CHARS.length)];
      const size = DEBRIS_SIZES[Math.floor(Math.random() * DEBRIS_SIZES.length)];
      const key = `ch:${ch}:${size}`;
      const t = this.acquire(key, () => {
        const node = new Text({
          text: ch,
          style: { fontSize: size, fontWeight: "900", fill: 0x37352f },
        });
        node.anchor.set(0.5);
        return node;
      });
      t.x = x;
      t.y = y;
      const a = Math.random() * Math.PI * 2;
      const speed = 150 + Math.random() * 220;
      this.debris.push({
        node: t,
        key,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 190,
        spin: (Math.random() - 0.5) * 11,
        grav: 900,
        life: 0,
        ttl: 0.55 + Math.random() * 0.3,
      });
    }
  }

  /** 눈물 방울 — 얼굴 양옆으로 포물선 낙하 */
  tearDrops(x: number, y: number, count = 4) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire("tear", () => this.makeShared(SHARED.tear));
      const r = 4 + Math.random() * 3.5;
      g.scale.set(r / 5);
      g.x = x + (Math.random() - 0.5) * 14;
      g.y = y;
      const side = i % 2 === 0 ? -1 : 1;
      this.debris.push({
        node: g,
        key: "tear",
        vx: side * (70 + Math.random() * 130),
        vy: -160 - Math.random() * 130,
        spin: 0,
        grav: 980,
        life: 0,
        ttl: 0.6 + Math.random() * 0.25,
      });
    }
  }

  /** 진땀 방울 — 꼬집기 한계 근처 긴장 */
  sweatDrops(x: number, y: number, count = 3) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire("sweat", () => this.makeShared(SHARED.sweat));
      const r = 3 + Math.random() * 2.5;
      g.scale.set(r / 4);
      g.x = x + (Math.random() - 0.5) * 30;
      g.y = y + (Math.random() - 0.5) * 16;
      this.debris.push({
        node: g,
        key: "sweat",
        vx: (Math.random() - 0.5) * 120,
        vy: -220 - Math.random() * 90,
        spin: 0,
        grav: 1050,
        life: 0,
        ttl: 0.45 + Math.random() * 0.2,
      });
    }
  }

  /** +N 점수 popup — 위로 떠오르며 페이드. */
  scorePop(x: number, y: number, points: number, color = 0xffd166) {
    const label = `+${points}`;
    let node: Container;
    let key: string;
    if (scoreFontReady()) {
      key = "score:bitmap";
      const t = this.acquire(key, () => {
        const bt = new BitmapText({ text: label, style: { fontFamily: SCORE_FONT, fontSize: 22 } });
        bt.anchor.set(0.5);
        return bt;
      });
      t.text = label;
      t.tint = color;
      node = t;
    } else {
      // 비트맵 폰트 불가 환경(node 테스트 등) — 종전 Text 경로
      key = "score:text";
      const t = this.acquire(key, () => {
        const tx = new Text({
          text: label,
          style: { fontSize: 22, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x000000, width: 4 } },
        });
        tx.anchor.set(0.5);
        return tx;
      });
      t.text = label;
      t.tint = color;
      node = t;
    }
    node.x = x;
    node.y = y;
    this.scorePops.push({ g: node, key, life: 0, ttl: 0.7, vy: -120 });
  }

  update(deltaSec: number) {
    // 사전 래스터화 노드 — 한 프레임 그려진 뒤(= 첫 update 이후) 풀로 반환
    if (this.warmups.length) {
      const done = this.warmups;
      this.warmups = [];
      for (const w of done) this.release(w.key, w.node);
    }
    const gravity = 900;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += deltaSec;
      if (p.life >= p.ttl) {
        this.release("circle", p.g);
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += gravity * deltaSec;
      p.g.x += p.vx * deltaSec;
      p.g.y += p.vy * deltaSec;
      p.g.alpha = 1 - p.life / p.ttl;
    }

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.life += deltaSec;
      const t = s.life / s.ttl;
      if (t >= 1) {
        this.removeChild(s.g);
        s.g.destroy();
        this.shockwaves.splice(i, 1);
        continue;
      }
      const r = s.startR + (s.endR - s.startR) * t;
      s.g.clear();
      s.g.circle(0, 0, r).stroke({ color: s.color, width: 6 * (1 - t), alpha: 1 - t });
    }

    for (let i = this.scorePops.length - 1; i >= 0; i--) {
      const p = this.scorePops[i];
      p.life += deltaSec;
      const t = p.life / p.ttl;
      if (t >= 1) {
        this.release(p.key, p.g);
        this.scorePops.splice(i, 1);
        continue;
      }
      p.g.y += p.vy * deltaSec;
      p.vy *= 0.93;
      p.g.alpha = 1 - t * t;
      p.g.scale.set(1 + t * 0.3);
    }

    for (let i = this.emojiPops.length - 1; i >= 0; i--) {
      const p = this.emojiPops[i];
      p.life += deltaSec;
      const t = p.life / p.ttl;
      if (t >= 1) {
        this.release(p.key, p.t);
        this.emojiPops.splice(i, 1);
        continue;
      }
      // scale 0.5 → 1.15 (ease-out), 마지막 40% 페이드
      const grow = 1 - Math.pow(1 - Math.min(1, t / 0.6), 2);
      p.t.scale.set(0.5 + 0.65 * grow);
      if (p.swing) {
        p.t.rotation = -0.9 * (1 - Math.min(1, t / 0.55));
      }
      p.t.alpha = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    }

    for (let i = this.paperPieces.length - 1; i >= 0; i--) {
      const p = this.paperPieces[i];
      p.life += deltaSec;
      const t = p.life / p.ttl;
      if (t >= 1) {
        this.removeChild(p.g);
        p.g.destroy();
        this.paperPieces.splice(i, 1);
        continue;
      }
      // 팔랑팔랑 — 낮은 중력 + 좌우 wobble + 공기저항
      p.vy += 320 * deltaSec;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.wobblePhase += deltaSec * 7;
      p.g.x += (p.vx + Math.sin(p.wobblePhase) * 60) * deltaSec;
      p.g.y += p.vy * deltaSec;
      p.g.rotation += p.spin * deltaSec;
      p.g.alpha = 1 - t * t;
    }

    if (this.speedLineFrames) {
      this.speedLineTick += deltaSec;
      const on = Math.floor(this.speedLineTick / 0.07) % 2;
      this.speedLineFrames[0].visible = on === 0;
      this.speedLineFrames[1].visible = on === 1;
    }

    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i];
      gh.life += deltaSec;
      const t = gh.life / gh.ttl;
      if (t >= 1) {
        this.release(gh.key, gh.t);
        this.ghosts.splice(i, 1);
        continue;
      }
      gh.t.alpha = 0.45 * (1 - t);
      gh.t.scale.set(1 - t * 0.25);
    }

    for (let i = this.stamps.length - 1; i >= 0; i--) {
      const st = this.stamps[i];
      st.life += deltaSec;
      const t = st.life / st.ttl;
      if (t >= 1) {
        this.release(st.key, st.node);
        this.stamps.splice(i, 1);
        continue;
      }
      // 0~0.12s: 2.2→0.95 쾅(ease-in) → 미세 오버슛 → 유지 → 마지막 30% 페이드
      if (t < 0.12) {
        const k = t / 0.12;
        st.node.scale.set(2.2 - 1.25 * k * k);
        st.node.alpha = Math.min(1, k * 1.5);
      } else if (t < 0.2) {
        const k = (t - 0.12) / 0.08;
        st.node.scale.set(0.95 + 0.05 * Math.sin(k * Math.PI));
        st.node.alpha = 1;
      } else {
        st.node.scale.set(1);
        st.node.alpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      }
    }

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life += deltaSec;
      if (d.life >= d.ttl) {
        this.release(d.key, d.node);
        this.debris.splice(i, 1);
        continue;
      }
      d.vy += d.grav * deltaSec;
      d.node.x += d.vx * deltaSec;
      d.node.y += d.vy * deltaSec;
      d.node.rotation += d.spin * deltaSec;
      d.node.alpha = 1 - Math.pow(d.life / d.ttl, 2);
    }

    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life += deltaSec;
      const t = f.life / f.ttl;
      if (t >= 1) {
        this.removeChild(f.g);
        f.g.destroy();
        this.flares.splice(i, 1);
        continue;
      }
      const grow = 1 - Math.pow(1 - t, 2);
      f.g.scale.set(f.s0 + (f.s1 - f.s0) * grow);
      f.g.alpha = 1 - t * t;
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += deltaSec;
      const t = f.life / f.ttl;
      if (t >= 1) {
        this.removeChild(f.g);
        f.g.destroy();
        this.flashes.splice(i, 1);
        continue;
      }
      f.g.alpha = f.peak * (1 - t);
    }
  }
}
