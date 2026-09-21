// keyboard-input.test.ts — PC 키보드 조작(v1.50): 키 해석 · 무기별 스페이스/방향키 동작 · 포인터와 같은 세기·빈도 상한 · 피격 가능 범위 · 라이프사이클.
//   실행: node --experimental-strip-types --test __tests__/game/keyboard-input.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { register } from "node:module";

register("./node-loader.mjs", import.meta.url);

const { PlayScene } = await import("../../game/scenes/PlayScene.ts");
const { Body } = await import("matter-js"); // 로더가 실제 Matter 로 연결(씬과 같은 객체) — 놓는 순간 속도 관측용
const { bindGameVisibilityLifecycle } = await import("../../game/BossPaegiGame.ts");
const { WEAPONS, weaponsForMap } = await import("../../lib/weapons.ts");
const { BACKGROUNDS } = await import("../../lib/backgrounds.ts");
const { KEYBOARD_TUNING } = await import("../../lib/game-tuning.ts");
const { useGameStore, selectIntervalCV } = await import("../../store/gameStore.ts");
const { INTERVAL_CV_MIN } = await import("../../lib/anti-abuse-rules.ts");
const { HITS_PER_SEC_SUSTAINED, SCORE_PER_SEC_MAX } = await import("../../lib/anti-abuse-rules.ts");
const { HIT_COOLDOWN_MS: POINTER_SLAP_COOLDOWN_MS } = await import("../../game/input/SwipeInput.ts");
const { SWIPE_FACTOR_MAX } = await import("../../lib/weapons.ts");
const { MAX_COMBO_MULTIPLIER } = await import("../../lib/score-limits.ts");
const { VARIETY_CAP, MAP_VARIETY_CAP } = await import("../../lib/game-tuning.ts");
const {
  KEYBOARD_HELP,
  MAP_KEY_LABELS,
  WEAPON_KEY_COUNT,
  keyboardHint,
  resolveGameKey,
  shouldIgnoreKeyEvent,
} = await import("../../lib/keyboard-controls.ts");

type Hit = { x: number; y: number; strength: number; weapon: string; chargeUlt?: boolean };
type Key = "space" | "up" | "down" | "left" | "right";

function weapon(key: string) {
  const found = WEAPONS.find((candidate) => candidate.key === key);
  assert.ok(found, `missing weapon ${key}`);
  return found;
}

/**
 * 시간(performance.now)을 손에 쥔 씬 — 프레임마다 시계와 update 를 같이 굴린다.
 * 일시 데칼(홍조·혹·손자국)·궁극기 도장은 canvas(document)를 요구해 Node 에서는 no-op 으로 둔다(점수·입력과 무관한 연출).
 * 캐릭터 표시 위치(doll.x/y)는 update 가 물리 몸체에서 동기화하므로 첫 프레임을 돌린 뒤 키를 받는다(실게임은 ticker 가 상시 돈다).
 */
function harness(t: TestContext, weaponKey: string, width = 800, height = 600) {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const hits: Hit[] = [];
  const hitTimes: number[] = [];
  let drawing = false;
  let actions = 0;
  const scene = new PlayScene({
    app: {} as never,
    onHit: (info: Hit) => {
      hits.push(info);
      hitTimes.push(now);
      return info.strength;
    },
    onDrawingChange: (value: boolean) => {
      drawing = value;
    },
    onKeyAction: () => {
      actions += 1;
    },
  });
  const decals = Reflect.get(scene, "transientDecals") as Record<string, unknown>;
  for (const method of ["blush", "welt", "bump", "handprint", "stain"]) {
    if (typeof decals[method] === "function") decals[method] = () => {};
  }
  (Reflect.get(scene, "fx") as Record<string, unknown>).stampPop = () => {}; // 궁극기 피니시 도장도 canvas 를 쓴다
  // 키보드 쪽 무작위(랜덤 부위·각도·낙서 경로)는 시드 고정 — 테스트가 실행마다 같은 경로를 본다(플레이크 방지).
  let seed = 0x2f6e2b1;
  Reflect.set(Reflect.get(scene, "keyboardInput") as object, "rng", () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  });
  scene.layout(width, height);
  scene.setWeapon(weapon(weaponKey));
  scene.update(1 / 60);
  const doll = Reflect.get(scene, "doll") as {
    x: number;
    y: number;
    scale: { x: number };
    getBodyBounds(): { x0: number; y0: number; x1: number; y1: number };
  };
  assert.ok(doll.x > 0 && doll.y > 0, "캐릭터 위치 동기화");
  /** 실루엣 경계 상자의 중심(stage 좌표) — "그 방향 부위" 판정 기준(머리가 크고 몸이 아래로 길어 캐릭터 원점과 다르다). */
  const bodyCenter = () => {
    const b = doll.getBodyBounds();
    return { x: doll.x + ((b.x0 + b.x1) / 2) * doll.scale.x, y: doll.y + ((b.y0 + b.y1) / 2) * doll.scale.x };
  };
  return {
    scene,
    hits,
    doll,
    bodyCenter,
    hitTimes,
    /** ms 동안 period 마다 키를 눌렀다 떼며(연타) 프레임을 굴린다 */
    mash(key: Key, ms: number, period: number) {
      let nextPress = 0;
      for (let elapsed = 0; elapsed < ms; elapsed += 1000 / 60) {
        if (elapsed >= nextPress) {
          scene.keyAction(key, "down");
          scene.keyAction(key, "up");
          nextPress += period;
        }
        now += 1000 / 60;
        scene.update(1 / 60);
      }
    },
    hasDrawing: () => drawing,
    actions: () => actions,
    /** 한 번 누르고 끝나는 방향키 동작 — 동시 입력 대기(chordMs)가 지나야 발사된다. 키 여러 개 = 대각선. */
    tapKeys(...keys: Key[]) {
      for (const key of keys) scene.keyAction(key, "down");
      for (let elapsed = 0; elapsed <= KEYBOARD_TUNING.chordMs + 20; elapsed += 1000 / 60) {
        now += 1000 / 60;
        scene.update(1 / 60);
      }
      for (const key of keys) scene.keyAction(key, "up");
    },
    gesture: () => Reflect.get(Reflect.get(scene, "keyboardInput") as object, "gesture") as Record<string, never> | null,
    /** ms 만큼 시계를 돌리며 60fps 로 update */
    run(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 1000 / 60) {
        now += 1000 / 60;
        scene.update(1 / 60);
      }
    },
    advance(ms: number) {
      now += ms;
    },
    keyboardActive: () => (Reflect.get(scene, "keyboardInput") as { active: boolean }).active,
  };
}

test("키 해석: 숫자 1~9 = 무기 9칸 · Q W E R T Y = 맵 6종 · 스페이스·방향키 = 공격, 그 외는 받지 않는다", () => {
  for (let i = 1; i <= 9; i++) assert.deepEqual(resolveGameKey(`Digit${i}`), { kind: "weapon", slot: i - 1 });
  assert.equal(WEAPON_KEY_COUNT, 9);
  for (const map of BACKGROUNDS) assert.equal(weaponsForMap(map.key).length, WEAPON_KEY_COUNT, `${map.key}: 칸 수 = 숫자키 수`);
  assert.deepEqual([...MAP_KEY_LABELS], ["Q", "W", "E", "R", "T", "Y"]);
  assert.equal(MAP_KEY_LABELS.length, BACKGROUNDS.length, "맵 수 = 맵 키 수");
  MAP_KEY_LABELS.forEach((label: string, index: number) =>
    assert.deepEqual(resolveGameKey(`Key${label}`), { kind: "map", index }),
  );
  assert.deepEqual(resolveGameKey("Space"), { kind: "attack", key: "space" });
  assert.deepEqual(resolveGameKey("ArrowUp"), { kind: "attack", key: "up" });
  assert.deepEqual(resolveGameKey("ArrowDown"), { kind: "attack", key: "down" });
  assert.deepEqual(resolveGameKey("ArrowLeft"), { kind: "attack", key: "left" });
  assert.deepEqual(resolveGameKey("ArrowRight"), { kind: "attack", key: "right" });
  // 사용자 결정: 네 묶음 외에는 인식하지 않는다. 넘패드는 NumLock 이 꺼지면 방향키라 제외, 0 번 칸은 없다.
  for (const code of ["Digit0", "Numpad1", "Numpad8", "KeyA", "KeyU", "Escape", "Enter", "KeyM", "Tab", ""]) {
    assert.equal(resolveGameKey(code), null, code);
  }
});

test("키 무시 조건: 브라우저 단축키(Ctrl/Cmd/Alt)와 글자 입력 중에는 게임 키가 아니다", () => {
  assert.equal(shouldIgnoreKeyEvent({}), false);
  assert.equal(shouldIgnoreKeyEvent({ target: { tagName: "BUTTON" } }), false, "포커스된 버튼 위에서도 게임 키");
  assert.equal(shouldIgnoreKeyEvent({ ctrlKey: true }), true);
  assert.equal(shouldIgnoreKeyEvent({ metaKey: true }), true);
  assert.equal(shouldIgnoreKeyEvent({ altKey: true }), true);
  for (const tagName of ["INPUT", "textarea", "SELECT"]) assert.equal(shouldIgnoreKeyEvent({ target: { tagName } }), true, tagName);
  assert.equal(shouldIgnoreKeyEvent({ target: { tagName: "DIV", isContentEditable: true } }), true);
});

test("안내 문구: 무기 7종류 모두 스페이스·방향키 동작이 있다", () => {
  const categories = [...new Set(WEAPONS.map((w: { category: string }) => w.category))].sort();
  assert.deepEqual(Object.keys(KEYBOARD_HELP).sort(), categories);
  for (const help of Object.values(KEYBOARD_HELP) as { space: string; arrows: string }[]) {
    assert.ok(help.space.length > 0 && help.arrows.length > 0);
  }
  // 문구는 사용자 확정(2026-09-21) — 동작만 적고 「주먹」「뿅망치」처럼 무기 이름을 앞에 붙이지 않는다.
  assert.deepEqual(KEYBOARD_HELP, {
    tap: { space: "랜덤 부위 타격", arrows: "그 방향 부위 타격" },
    swipe: { space: "상하좌우 랜덤으로 싸대기", arrows: "그 방향으로 싸대기" },
    grab: { space: "랜덤 방향으로 던지기", arrows: "그 방향으로 던지기" },
    pinch: { space: "누르는 동안 이리저리 꼬집기", arrows: "그 방향으로 꼬집기" },
    throw: { space: "랜덤한 곳에서 던지기", arrows: "그 방향으로 던지기" },
    shoot: { space: "누르는 동안 자동으로 쏘기", arrows: "그 방향으로 쏘기" },
    draw: { space: "누르는 동안 자동으로 낙서", arrows: "누르는 동안 직접 낙서" },
  });
  assert.equal(keyboardHint("tap"), "스페이스: 랜덤 부위 타격 · 방향키: 그 방향 부위 타격");
  for (const w of WEAPONS) {
    const help = KEYBOARD_HELP[w.category];
    assert.ok(!help.space.startsWith(w.label) && !help.arrows.startsWith(w.label), w.label);
  }
});

test("주먹: 스페이스 = 즉시 랜덤 부위, 방향키 = 그 방향 부위(8방향 — 두 키 = 대각선). 점수는 포인터 탭과 같고 최소 간격 80ms", (t) => {
  const h = harness(t, "fist");
  h.scene.keyAction("space", "down");
  assert.equal(h.hits.length, 1, "스페이스는 기다리지 않는다");
  assert.deepEqual([h.hits[0].weapon, h.hits[0].strength], ["fist", 12]);
  // 80ms 안의 다음 입력은 버린다(큐 없음) — 12.5회/초 < S1 지속 18회/초.
  h.advance(KEYBOARD_TUNING.tapMinMs - 1);
  h.scene.keyAction("space", "down");
  assert.equal(h.hits.length, 1);
  assert.ok(1000 / KEYBOARD_TUNING.tapMinMs < HITS_PER_SEC_SUSTAINED);

  // 맞으면 캐릭터가 밀렸다 돌아오므로, 매번 자리 잡기를 기다린 뒤 그 순간의 실루엣 중심과 비교한다(여유 12px).
  type C = { x: number; y: number };
  const T = 12;
  const cases: [Key[], (hit: Hit, c: C) => boolean][] = [
    [["up"], (hit, c) => hit.y < c.y + T],
    [["down"], (hit, c) => hit.y > c.y - T],
    [["left"], (hit, c) => hit.x < c.x + T],
    [["right"], (hit, c) => hit.x > c.x - T],
    [["up", "left"], (hit, c) => hit.y < c.y + T && hit.x < c.x + T],
    [["up", "right"], (hit, c) => hit.y < c.y + T && hit.x > c.x - T],
    [["down", "left"], (hit, c) => hit.y > c.y - T && hit.x < c.x + T],
    [["down", "right"], (hit, c) => hit.y > c.y - T && hit.x > c.x - T],
  ];
  for (const [keys, inRegion] of cases) {
    for (let i = 0; i < 6; i++) {
      h.run(700);
      const c = h.bodyCenter();
      const before: number = h.hits.length;
      h.tapKeys(...keys);
      assert.equal(h.hits.length, before + 1, `${keys.join("+")}: 두 키를 같이 눌러도 한 동작`);
      assert.ok(inRegion(h.hits.at(-1)!, c), `${keys.join("+")}: ${JSON.stringify(h.hits.at(-1))} vs body center ${c.x},${c.y}`);
    }
  }
  assert.equal(h.actions(), h.hits.length, "받아들여진 동작만 센다(텔레메트리 keyActions)");
  h.scene.destroy();
});

test("투척: 어떤 화면 크기에서도 피격 가능 범위에서 던져 반드시 맞고, 방향키(8방향)는 그 방향 부위에 맞는다(탭 발사와 같은 세기)", (t) => {
  const combos: Key[][] = [["space"], ["up"], ["down"], ["left"], ["right"], ["up", "left"], ["down", "right"]];
  for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    for (const keys of combos) {
      const h = harness(t, "book", width, height);
      h.tapKeys(...keys);
      h.run(2_000);
      const name = `${width}x${height} ${keys.join("+")}`;
      assert.equal(h.hits.length, 1, `${name}: 명중 1회`);
      const hit = h.hits[0];
      assert.equal(hit.weapon, "book");
      assert.ok(hit.strength >= 12 && hit.strength <= 16, `탭 발사 세기(보통 이하): ${hit.strength}`);
      if (keys.includes("up")) assert.ok(hit.y < h.doll.y, `${name}: 위쪽 부위`);
      if (keys.includes("down")) assert.ok(hit.y > h.doll.y, `${name}: 아래쪽 부위`);
      if (keys.includes("left")) assert.ok(hit.x < h.doll.x, `${name}: 왼쪽 부위`);
      if (keys.includes("right")) assert.ok(hit.x > h.doll.x, `${name}: 오른쪽 부위`);
      h.scene.destroy();
      t.mock.restoreAll();
    }
  }
});

test("투척: 발사 지점은 캐릭터 중심에서 최대 450px·화면 안쪽 — 그 밖(화면 가장자리)에서는 낙차로 빗나간다", (t) => {
  const h = harness(t, "book", 3840, 2160);
  const launch = (distance: number) => {
    const before = h.hits.length;
    Reflect.apply(Reflect.get(h.scene, "handleThrowLaunch") as (info: unknown) => void, h.scene, [
      { x: h.doll.x - distance, y: h.doll.y, vx: 0, vy: 0, power: 0, weapon: weapon("book") },
    ]);
    h.run(3_000);
    return h.hits.length - before;
  };
  assert.equal(launch(KEYBOARD_TUNING.spawnMaxPx), 1, "450px 수평 비행은 맞는다");
  assert.equal(launch(1_800), 0, "큰 화면 가장자리(1800px)에서는 빗나간다 — 범위를 묶는 이유");

  const keyboard = Reflect.get(h.scene, "keyboardInput") as object;
  const spawnPoint = Reflect.get(keyboard, "spawnPoint") as (dir: { x: number; y: number }) => { x: number; y: number };
  for (const [width, height] of [[1280, 720], [3840, 2160], [400, 300]]) {
    h.scene.layout(width, height);
    h.run(17); // 새 배치의 캐릭터 위치는 다음 프레임에 동기화된다
    for (let step = 0; step < 8; step++) {
      const angle = (step * Math.PI) / 4;
      const p = Reflect.apply(spawnPoint, keyboard, [{ x: Math.cos(angle), y: Math.sin(angle) }]);
      assert.ok(Math.hypot(p.x - h.doll.x, p.y - h.doll.y) <= KEYBOARD_TUNING.spawnMaxPx + 1e-6, `${width}x${height} ${step}: 범위`);
      const m = KEYBOARD_TUNING.spawnMarginPx;
      assert.ok(p.x >= m && p.x <= width - m && p.y >= m && p.y <= height - m, `${width}x${height} ${step}: 화면 안`);
    }
  }
  h.scene.destroy();
});

const total = (segs: readonly { ms: number }[]) => segs.reduce((ms, seg) => ms + seg.ms, 0);
const SWIPE_TOTAL_MS = total(KEYBOARD_TUNING.swipeFull);
const GRAB_TOTAL_MS = KEYBOARD_TUNING.grabWindupMs + KEYBOARD_TUNING.grabThrowMs;
/** 포인터 싸대기의 최대 처리량(점/초) = 최대 세기 × 쿨다운 빈도 — 키보드 싸대기가 넘으면 안 되는 선. */
const POINTER_SLAP_MAX_PER_SEC = (14 * SWIPE_FACTOR_MAX * 1000) / POINTER_SLAP_COOLDOWN_MS;

test("싸대기: 키 한 번 = 왕복 2타(정타 28 → 역타 22). 준비 동작 → 가속 → 임팩트, 8방향·스페이스는 상하좌우 랜덤", (t) => {
  const h = harness(t, "slap");
  const palm = () => Reflect.get(Reflect.get(h.scene, "swipeInput") as object, "palm") as { x: number; y: number; visible: boolean };
  h.scene.keyAction("right", "down");
  h.run(KEYBOARD_TUNING.chordMs + 17);
  assert.deepEqual(h.gesture()?.dir, { x: 1, y: 0 });
  assert.equal(palm().visible, true, "손바닥이 보인다");
  // 프레임마다 손 위치: 먼저 뒤로 빠지고(준비 동작), 타격 구간에서는 프레임 이동 거리가 계속 커지고(가속), 얼굴을 지나갔다 되돌아온다(역타).
  const xs: number[] = [palm().x];
  for (let frame = 0; h.gesture(); frame++) {
    h.run(1000 / 60);
    xs.push(palm().x);
    assert.ok(frame < 60, "동작이 끝난다");
  }
  h.scene.keyAction("right", "up");
  const c = h.bodyCenter();
  assert.ok(Math.min(...xs) < xs[0] - 60, `준비 동작으로 뒤로 뺀다: ${xs.map((x) => Math.round(x)).join(",")}`);
  const backAt = xs.indexOf(Math.min(...xs));
  const strike = xs.slice(backAt, backAt + 5).map((x, i, arr) => (i ? x - arr[i - 1] : 0)).slice(1);
  assert.ok(strike.every((d, i) => i === 0 || d > strike[i - 1]), `타격 구간은 가속: ${strike.map((d) => Math.round(d)).join(",")}`);
  assert.ok(Math.max(...strike) * 60 > 2200, `임팩트 직전 속도 2,200px/s 초과: ${Math.round(Math.max(...strike) * 60)}`);
  const farAt = xs.indexOf(Math.max(...xs));
  assert.ok(farAt > backAt && xs[farAt] > c.x + 60 && xs.at(-1)! < c.x, "얼굴을 지나갔다가 되돌아온다(왕복)");
  assert.equal(palm().visible, false, "끝나면 손바닥을 숨긴다");
  assert.deepEqual(h.hits.map((hit) => [hit.weapon, hit.strength]), [["slap", 28], ["slap", 22]], "정타 = 14 × 상한 2.0, 역타 = 14 × 1.6");
  assert.ok(h.hitTimes[1] - h.hitTimes[0] >= KEYBOARD_TUNING.swipeChainMinMs - 17, `두 타 간격 ≈ 120ms: ${h.hitTimes[1] - h.hitTimes[0]}`);
  assert.ok(h.hits.every((hit) => Math.abs(hit.x - c.x) < 60 && hit.y < c.y), "머리에 맞는다(허공이 아니라)");

  h.run(400);
  h.tapKeys("up", "left");
  const diagonal = h.gesture()?.dir as unknown as { x: number; y: number } | undefined;
  assert.ok(diagonal && Math.abs(diagonal.x + Math.SQRT1_2) < 1e-9 && Math.abs(diagonal.y + Math.SQRT1_2) < 1e-9, "두 키 = 대각선");
  h.run(SWIPE_TOTAL_MS + 40);

  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    h.run(400);
    h.scene.keyAction("space", "down");
    const dir = h.gesture()?.dir as unknown as { x: number; y: number };
    assert.equal(Math.abs(dir.x) + Math.abs(dir.y), 1, "스페이스는 상하좌우 중 하나");
    seen.add(`${dir.x},${dir.y}`);
    h.scene.keyAction("space", "up");
    h.run(SWIPE_TOTAL_MS);
  }
  assert.equal(seen.size, 4, "네 방향이 모두 나온다");
  h.scene.destroy();
});

test("싸대기 연타: 입력이 씹히지 않고 여운을 끊어 이어 친다 — 8.3타/초, 첫 타만 28·나머지 22, 처리량은 포인터 최대 이하", (t) => {
  const h = harness(t, "slap");
  h.mash("right", 3_000, 40);
  const perSec = h.hits.length / 3;
  assert.ok(perSec > 7.6 && perSec <= 1000 / KEYBOARD_TUNING.swipeChainMinMs + 0.1, `타격 빈도 ${perSec.toFixed(2)}/초 (240ms 동작 시절 4.2/초의 2배)`);
  assert.equal(h.hits[0].strength, 28, "첫 타는 온전한 준비 동작");
  assert.ok(h.hits.slice(1).every((hit) => hit.strength === 22), "이어지는 타는 계수 1.6");
  const gaps = h.hitTimes.slice(1).map((time, i) => time - h.hitTimes[i]);
  assert.ok(Math.min(...gaps) >= KEYBOARD_TUNING.swipeChainMinMs - 17, `임팩트 간격 하한(프레임 1개 오차): ${Math.min(...gaps).toFixed(0)}ms`);
  const throughput = h.hits.reduce((sum, hit) => sum + hit.strength, 0) / 3;
  assert.ok(throughput <= POINTER_SLAP_MAX_PER_SEC + 10, `처리량 ${throughput.toFixed(0)} ≤ 포인터 최대 ${POINTER_SLAP_MAX_PER_SEC.toFixed(0)}점/초(첫 타 28 의 여유 10)`);
  assert.ok((KEYBOARD_TUNING.swipeChainSpeed / 1100) * 14 * (1000 / KEYBOARD_TUNING.swipeChainMinMs) <= POINTER_SLAP_MAX_PER_SEC + 1e-6, "지속 처리량 22 × 8.3 ≤ 28 × 6.7");
  h.scene.destroy();
});

test("주먹 연타: 최소 간격 안의 입력은 버리지 않고 기억했다가 낸다 — 50ms 간격으로 눌러도 12.5타/초가 그대로 나온다", (t) => {
  const h = harness(t, "fist");
  h.mash("space", 2_000, 50);
  const perSec = h.hits.length / 2;
  assert.ok(perSec >= 11.5 && perSec <= 1000 / KEYBOARD_TUNING.tapMinMs + 0.5, `${perSec}/초`);
  assert.ok(perSec < HITS_PER_SEC_SUSTAINED);
  h.run(KEYBOARD_TUNING.bufferMs + 100);
  const settled = h.hits.length;
  h.run(1_000);
  assert.equal(h.hits.length, settled, "기억해 둔 입력은 한 개뿐 — 뗀 뒤에 혼자 계속 나가지 않는다");
  h.scene.destroy();
});

test("잡아던지기: 살짝 당겼다 가속해서 놓는다 — 던져지는 속도는 물리 상한(28px/step), 세기 power 1.0(50점)·8방향·시작 간격 300ms", (t) => {
  const h = harness(t, "grab", 1600, 900); // 242px 를 끌어도 벽에 닿지 않는 PC 폭
  const body = Reflect.get(h.scene, "dollBody") as { position: { x: number; y: number }; velocity: { x: number; y: number } };
  const x0 = body.position.x;
  const setVelocity = t.mock.method(Body, "setVelocity");
  h.scene.keyAction("left", "down");
  const xs: number[] = [];
  for (let frame = 0; h.hits.length === 0; frame++) {
    h.run(1000 / 60);
    xs.push(body.position.x);
    assert.ok(frame < 40, "던진다");
  }
  h.scene.keyAction("left", "up");
  assert.ok(Math.max(...xs) > x0 + 15, `준비 동작으로 반대쪽(오른쪽)으로 살짝 당긴다: ${xs.map((x) => Math.round(x - x0)).join(",")}`);
  const pullAt = xs.indexOf(Math.max(...xs));
  const throwing = xs.slice(pullAt, -1).map((x, i, arr) => (i ? arr[i - 1] - x : 0)).slice(1);
  assert.ok(throwing.length >= 6 && throwing.every((d, i) => i === 0 || d > throwing[i - 1]), `던지는 구간은 가속: ${throwing.map((d) => Math.round(d)).join(",")}`);
  assert.ok(x0 - xs.at(-2)! > KEYBOARD_TUNING.grabThrowPx - 40, "끄는 범위 ≈ 242px");
  assert.deepEqual([h.hits[0].weapon, h.hits[0].strength], ["grab", 50], "20 + power 1.0 × 30");
  // 놓는 순간 씬이 준 속도 = 마지막 80ms 평균(≈2,300px/s)이 벽 관통 방지 상한 28px/step 에 걸린 값.
  const released = setVelocity.mock.calls.map((call) => call.arguments).filter(([b, v]) => b === body && (v as { x: number }).x !== 0).at(-1)![1] as { x: number; y: number };
  assert.ok(Math.abs(released.x + 28) < 0.01 && Math.abs(released.y) < 0.5, `왼쪽으로 물리 상한 속도로 던져진다: ${JSON.stringify(released)}`);
  assert.ok(body.velocity.x < 0, "왼쪽으로 날아가는 중");

  h.run(1_500); // 스프링 복귀
  h.tapKeys("up", "right");
  h.run(GRAB_TOTAL_MS);
  assert.equal(h.hits.at(-1)!.strength, 50);
  assert.ok(body.velocity.x > 0 && body.velocity.y < 0, "오른쪽 위로 날아간다");
  h.scene.destroy();
});

test("잡아던지기 연타: 입력을 기억했다가 300ms 간격으로 이어 던진다(3.3회/초) — 500ms 시절의 1.67배, 매번 50점", (t) => {
  const h = harness(t, "grab", 1600, 900);
  h.mash("up", 3_000, 50);
  const throws = h.hits.filter((hit) => hit.strength === 50);
  const times = h.hitTimes.filter((_, i) => h.hits[i].strength === 50);
  assert.ok(throws.length >= 9 && throws.length <= 3_000 / KEYBOARD_TUNING.grabMinMs + 1, `3초에 ${throws.length}회`);
  // 간격 제한은 **시작** 기준(300ms). 놓는 시점은 온전한 동작(270ms) 뒤에 짧은 동작(190ms)이 오면 그 차이만큼 당겨진다.
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  const shortest = KEYBOARD_TUNING.grabMinMs - (GRAB_TOTAL_MS - KEYBOARD_TUNING.grabChainWindupMs - KEYBOARD_TUNING.grabChainThrowMs);
  assert.ok(Math.min(...gaps) >= shortest - 17, `던지기 간격 하한 ${shortest}ms: ${Math.min(...gaps).toFixed(0)}ms`);
  assert.ok(gaps.slice(1).every((gap) => gap >= KEYBOARD_TUNING.grabMinMs - 17), `이어지는 던지기는 300ms 간격: ${gaps.map((g) => g.toFixed(0)).join(",")}`);
  h.scene.destroy();
});

test("봉투: 키보드 연타의 이론 최대 처리량 × 최대 배율(×16) × 무기 돌려쓰기 90% 가 점수/초 신호(S3) 아래다", () => {
  const multiplier = MAX_COMBO_MULTIPLIER * (1 + VARIETY_CAP) * (1 + MAP_VARIETY_CAP);
  assert.equal(multiplier, 16);
  const basePerSec = {
    tap: 12 * (1000 / KEYBOARD_TUNING.tapMinMs),
    throw: 18 * (1000 / KEYBOARD_TUNING.throwMinMs), // 탭 발사 세기(중 투척 20 × 0.88)
    swipe: (KEYBOARD_TUNING.swipeChainSpeed / 1100) * 14 * (1000 / KEYBOARD_TUNING.swipeChainMinMs),
    grab: 50 * (1000 / KEYBOARD_TUNING.grabMinMs),
  };
  for (const [name, value] of Object.entries(basePerSec)) {
    // 무기변경 배율 ×2 는 10초 창 안에 5종을 써야 유지된다 — 한 무기만 연타할 수 있는 시간은 많아야 90%.
    assert.ok(value * multiplier * 0.9 <= SCORE_PER_SEC_MAX, `${name}: ${Math.round(value * multiplier * 0.9)} ≤ ${SCORE_PER_SEC_MAX}`);
  }
});

test("꼬집기: 누르는 동안 방향키로 당기는 방향을 바꿔 가며 늘리고(8방향), 스페이스는 방향을 계속 바꾸는 자동 움직임. 떼면 놓는다", (t) => {
  const h = harness(t, "pinch");
  h.scene.keyAction("up", "down");
  h.run(16);
  h.scene.keyAction("up", "up");
  assert.equal(h.hits.length, 0, "당긴 비율 0.12 이하 = 무점수(포인터와 같은 규칙)");

  const pull = () => (h.gesture() as unknown as { pull: { x: number; y: number } }).pull;
  h.scene.keyAction("right", "down");
  // 관성 있는 가속 — 정지에서 출발해 프레임 이동 거리가 커지다가 최고 속도(1,300px/s ≈ 21.7px/프레임)에 붙는다.
  const steps: number[] = [];
  for (let i = 0, last = 0; i < 8; i++) {
    h.run(1000 / 60);
    steps.push(pull().x - last);
    last = pull().x;
  }
  assert.ok(steps.slice(0, 5).every((d, i) => i === 0 || d > steps[i - 1]), `가속: ${steps.map((d) => d.toFixed(1)).join(",")}`);
  assert.ok(steps[0] < 8 && Math.max(...steps) <= KEYBOARD_TUNING.pinchPullSpeed / 60 + 0.01, "첫 프레임은 느리고 최고 속도를 넘지 않는다");
  h.run(1_000);
  const right = { ...pull() };
  assert.ok(right.x > 150 && Math.abs(right.y) < 1, `오른쪽으로 끝까지: ${JSON.stringify(right)}`);
  // 방향키를 바꾸면(오른쪽을 떼기 전에 위를 누른다) 같은 꼬집기에서 당기는 방향이 바뀐다.
  h.scene.keyAction("up", "down");
  h.run(300);
  const diagonal = { ...pull() };
  assert.ok(diagonal.y < -20 && diagonal.x > 50, `오른쪽 위 대각선으로: ${JSON.stringify(diagonal)}`);
  h.scene.keyAction("right", "up");
  assert.equal(h.keyboardActive(), true, "키가 하나라도 눌려 있으면 계속 쥐고 있다");
  h.run(1_500);
  const up = { ...pull() };
  assert.ok(up.y < -150 && Math.abs(up.x) < 60, `위쪽으로 돌아간다: ${JSON.stringify(up)}`);
  h.scene.keyAction("up", "up");
  assert.equal(h.keyboardActive(), false);
  const release = h.hits.at(-1)!;
  assert.deepEqual([release.weapon, release.strength], ["pinch", 36], "끝까지 당김 = 10 + 1.0 × 26");
  assert.ok(h.hits.every((hit) => hit.weapon === "pinch"));

  // 스페이스 — 당기는 방향이 계속 바뀐다(한 방향으로만 끌지 않는다).
  h.scene.keyAction("space", "down");
  const angles: number[] = [];
  for (let i = 0; i < 12; i++) {
    h.run(400);
    angles.push(Math.atan2(pull().y, pull().x));
  }
  const spread = Math.max(...angles.map((a) => Math.cos(a))) - Math.min(...angles.map((a) => Math.cos(a)));
  assert.ok(spread > 0.8, `방향이 돈다: ${angles.map((a) => a.toFixed(2)).join(",")}`);
  h.scene.keyAction("space", "up");
  assert.equal(h.keyboardActive(), false);
  h.scene.destroy();
});

test("비비탄총: 누르는 동안 한 줄기로 자동 발사(포인터와 같은 0.18초 간격), 방향키를 바꾸면 총구가 옮겨 가고 떼면 멈춘다", (t) => {
  const h = harness(t, "gun");
  const muzzle = () => ({ ...(Reflect.get(Reflect.get(h.scene, "shootInput") as object, "holdPos") as { x: number; y: number }) });
  h.scene.keyAction("up", "down");
  const top = muzzle();
  assert.ok(top.y < h.doll.y && Math.abs(top.x - h.doll.x) < 1, "위쪽 부위 = 위에서 쏜다");
  h.scene.keyAction("left", "down");
  const topLeft = muzzle();
  assert.ok(topLeft.x < h.doll.x && topLeft.y < h.doll.y, "두 키 = 대각선으로 총구 이동(발사 줄기는 하나)");
  h.run(1_000);
  h.scene.keyAction("up", "up");
  assert.ok(muzzle().x < h.doll.x && Math.abs(muzzle().y - h.doll.y) < 1, "남은 키 기준으로 총구를 다시 잡는다");
  h.scene.keyAction("left", "up");
  h.run(500);
  const fired = h.hits.length;
  assert.ok(fired >= 5 && fired <= 7, `1초 ≈ 5.6발: ${fired}`);
  assert.ok(h.hits.every((hit) => hit.weapon === "gun" && hit.strength === 7));
  h.run(1_000);
  assert.equal(h.hits.length, fired, "뗀 뒤에는 더 나가지 않는다");
  assert.equal(h.actions(), 1, "누르고 있는 동작은 시작할 때 한 번만 센다");
  h.scene.destroy();
});

test("펜: 스페이스를 누르는 동안 끊기지 않는 곡선, 방향키는 펜촉 조종(8방향, 가장자리에서 멈춤)", (t) => {
  const h = harness(t, "pen");
  h.scene.keyAction("space", "down");
  h.run(2_000);
  h.scene.keyAction("space", "up");
  assert.equal(h.keyboardActive(), false);
  assert.equal(h.hasDrawing(), true);
  const auto = h.hits.length;
  // 평균 300px/s ÷ 40px = 7.5타/초 → 2초 ≈ 15타. 속도 물결·선회로 덜 나올 수 있다.
  assert.ok(auto >= 8 && auto <= 20, `자동 곡선 2초: ${auto}타`);
  assert.ok(h.hits.every((hit) => hit.weapon === "pen" && hit.strength === 3));

  // 조종 — 자동 낙서가 끝난 자리는 랜덤이라(가장자리 근처면 가로 폭이 짧다) 펜촉을 머리 중심 높이에 두고 시작한다:
  // 왼쪽 끝까지 간 뒤 오른쪽으로 지름(240 local × 1.4 = 336px)을 가로지른다 = 결정적 거리.
  Reflect.set(Reflect.get(h.scene, "keyboardInput") as object, "penLast", { x: 0, y: 0 });
  h.scene.keyAction("left", "down");
  h.run(3_000);
  h.scene.keyAction("right", "down"); // 떼기 전에 다음 키 — 같은 획이 이어진다
  h.scene.keyAction("left", "up");
  const beforeCross = h.hits.length;
  h.run(3_000);
  const crossed = h.hits.length - beforeCross;
  assert.ok(crossed >= 7 && crossed <= 9, `머리 지름 336px ÷ 40px ≈ 8타: ${crossed}타`);
  h.run(2_000);
  assert.equal(h.hits.length - beforeCross, crossed, "가장자리에 닿으면 멈춘다(실루엣 밖으로 나가 점수가 끝없이 쌓이지 않는다)");
  h.scene.keyAction("right", "up");
  assert.equal(h.keyboardActive(), false, "키를 전부 떼면 획이 끝난다");

  Reflect.set(Reflect.get(h.scene, "keyboardInput") as object, "penLast", { x: 0, y: 0 });
  h.scene.keyAction("up", "down");
  h.scene.keyAction("left", "down");
  h.run(400);
  const tip = (h.gesture() as unknown as { local: { x: number; y: number } }).local;
  assert.ok(tip.x < -20 && tip.y < -20 && Math.abs(tip.x - tip.y) < 2, `두 키 = 대각선: ${JSON.stringify(tip)}`);
  h.scene.keyAction("up", "up");
  h.scene.keyAction("left", "up");
  h.scene.destroy();
});

test("자동 동작(펜·꼬집기 스페이스)은 등간격 기계 입력이 아니다 — 타격 간격 CV 가 S5 임계를 넉넉히 넘는다", (t) => {
  for (const key of ["pen", "pinch"]) {
    const h = harness(t, key);
    useGameStore.getState().reset();
    useGameStore.getState().start();
    Reflect.set(h.scene, "onHit", (info: Hit) => useGameStore.getState().hit(info.strength, info.weapon, info.chargeUlt));
    h.scene.keyAction("space", "down");
    h.run(30_000);
    h.scene.keyAction("space", "up");
    const state = useGameStore.getState();
    const cv = selectIntervalCV(state);
    assert.ok(state.hitCount >= 100, `${key}: S5 표본(100타) 이상 ${state.hitCount}`);
    assert.ok(cv !== null && cv > INTERVAL_CV_MIN * 1.5, `${key}: CV ${cv} > ${INTERVAL_CV_MIN} × 1.5`);
    assert.ok(state.hitCount / 30 < HITS_PER_SEC_SUSTAINED, `${key}: 타격 빈도 ${state.hitCount / 30}/s`);
    useGameStore.getState().reset();
    h.scene.destroy();
    t.mock.restoreAll();
  }
});

test("궁극기: 발동 중 키 연타는 예산을 앞당길 뿐 — 총 타격 수는 연타와 무관하게 같다", (t) => {
  const total = (mash: boolean) => {
    const h = harness(t, "fist");
    h.scene.triggerUltimate();
    for (let i = 0; i < 300; i++) {
      if (mash) h.scene.keyAction(i % 2 ? "space" : "left", "down");
      h.run(1000 / 60);
    }
    const blows = h.hits.filter((hit) => hit.chargeUlt === false).length;
    h.scene.destroy();
    t.mock.restoreAll();
    return blows;
  };
  const auto = total(false);
  assert.ok(auto > 0);
  assert.equal(total(true), auto);
});

test("라이프사이클: 종료 뒤·blur 에는 키가 먹지 않고, 진행 중 제스처·대기 동작은 blur·무기 전환에 취소된다", (t) => {
  const h = harness(t, "gun");
  const win = new EventTarget();
  const doc = new EventTarget();
  const unbind = bindGameVisibilityLifecycle(h.scene, win, doc, () => "visible");
  h.scene.keyAction("space", "down");
  assert.equal(h.keyboardActive(), true);
  win.dispatchEvent(new Event("blur"));
  assert.equal(h.keyboardActive(), false, "blur = 제스처 취소(keyup 이 오지 않는다)");
  h.scene.keyAction("space", "down");
  assert.equal(h.keyboardActive(), false, "일시정지 중에는 받지 않는다");
  win.dispatchEvent(new Event("focus"));

  h.scene.keyAction("space", "down");
  assert.equal(h.keyboardActive(), true);
  h.scene.setWeapon(weapon("fist"));
  assert.equal(h.keyboardActive(), false, "무기 전환 = 제스처 취소");
  h.scene.keyAction("up", "down");
  assert.equal(h.keyboardActive(), true, "동시 입력 대기 중");
  h.scene.setWeapon(weapon("hammer"));
  assert.equal(h.keyboardActive(), false, "무기 전환 = 대기 동작도 취소");

  h.scene.end();
  const before = h.hits.length;
  const actionsBefore = h.actions();
  for (const key of ["space", "up", "down", "left", "right"] as const) h.scene.keyAction(key, "down");
  h.run(500);
  assert.equal(h.hits.length, before, "종료 뒤 무점수");
  assert.equal(h.actions(), actionsBefore, "종료 뒤에는 동작으로 세지도 않는다");
  assert.equal(h.keyboardActive(), false);
  unbind();
  h.scene.destroy();
});

test("React 훅 계약: 키 반복 무시 · 기본 동작 차단 · 스페이스는 궁극기 우선(버튼과 같은 경로) · blur 에 눌림 비움", () => {
  const hook = readFileSync(new URL("../../app/play/useKeyboardControls.ts", import.meta.url), "utf8");
  const down = hook.slice(hook.indexOf("const onKeyDown"), hook.indexOf("const onKeyUp"));
  assert.match(down, /if \(shouldIgnoreKeyEvent\(e\)\) return;[\s\S]*resolveGameKey\(e\.code\)[\s\S]*e\.preventDefault\(\);\s*if \(e\.repeat\) return;/);
  assert.match(down, /key\.key === "space" && useGameStore\.getState\(\)\.ultReady[\s\S]*latest\.current\.onUltimate\(\);/);
  assert.match(hook, /window\.addEventListener\("blur", releaseAll\);/);
  assert.match(hook, /document\.addEventListener\("visibilitychange", onVisibility\);/);
  const page = readFileSync(new URL("../../app/play/page.tsx", import.meta.url), "utf8");
  assert.match(page, /enabled: gameReady && !over,/);
  assert.match(page, /onUltimate: handleUltimate,/, "직접 triggerUltimate 호출 금지(S10: 궁극기 점수는 있는데 사용 0)");
  assert.match(page, /onKeyAction: telemetry\.onKeyAction,/, "게임이 받아들인 동작을 텔레메트리로");
  assert.match(page, /onUltimateKey: telemetry\.onKeyAction,/, "스페이스 궁극기 발동도 키보드 동작");
  assert.match(page, /if \(isEraserSlot\(w, hasDrawing\)\) gameRef\.current\?\.clearDrawing\(\);\s*else handleWeapon\(w\);/);
});
