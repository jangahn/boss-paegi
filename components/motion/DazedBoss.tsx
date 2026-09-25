import { BASE_DOLLS, DEFAULT_BASE_DOLL } from "@/lib/base-dolls";

/**
 * 해롱 캐릭터(v1.65) — 404 · 오류 화면. 게임 속 해롱해롱(연타 뒤 별이 머리 위를 돌고 고개가 흔들리는 DazeFx)을 화면 밖으로 가져온
 * 표현: 기본 캐릭터 얼굴이 좌우로 흔들리고 별 세 개가 머리 위를 돈다. 서버 컴포넌트(훅 없음), CSS 만(motion-daze-*),
 * 모션 감소면 정지. 장식이라 화면낭독기에서 뺀다.
 */
export function DazedBoss() {
  const face = BASE_DOLLS[DEFAULT_BASE_DOLL].face;
  return (
    <div aria-hidden className="relative h-24 w-24">
      <div className="motion-daze-sway h-full w-full">
        {/* eslint-disable-next-line @next/next/no-img-element -- 정적 얼굴 썸네일(144px), 자리 고정 */}
        <img src={face} alt="" width={96} height={96} className="h-24 w-24 rounded-full border border-foreground/10" />
      </div>
      <div className="motion-daze-orbit pointer-events-none absolute -top-3 left-1/2 h-6 w-20 -translate-x-1/2">
        {[0, 1, 2].map((i) => (
          <span key={i} className="motion-daze-star absolute left-1/2 top-1/2 text-sm" style={{ animationDelay: `${i * -0.5}s` }}>
            ⭐
          </span>
        ))}
      </div>
    </div>
  );
}
