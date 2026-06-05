import { Container, Graphics } from "pixi.js";

type Particle = {
  g: Graphics;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
};

const COLORS = [0xffd166, 0xef476f, 0xff9f1c, 0xfdf6e3];

/**
 * 일회성 파티클 버스트. 탭 위치에서 N개의 작은 원이 튀어나가 중력 받고 페이드.
 * 자체 ticker 없음 — 외부에서 update(delta) 호출.
 */
export class HitEffect extends Container {
  private particles: Particle[] = [];

  burst(x: number, y: number, count = 10) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const r = 4 + Math.random() * 6;
      g.circle(0, 0, r).fill(COLORS[i % COLORS.length]);
      g.x = x;
      g.y = y;
      this.addChild(g);

      const angle = Math.random() * Math.PI * 2;
      const speed = 200 + Math.random() * 250;
      this.particles.push({
        g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 180, // 살짝 위로
        life: 0,
        ttl: 0.6 + Math.random() * 0.3,
      });
    }
  }

  update(deltaSec: number) {
    const gravity = 900;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += deltaSec;
      if (p.life >= p.ttl) {
        this.removeChild(p.g);
        p.g.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += gravity * deltaSec;
      p.g.x += p.vx * deltaSec;
      p.g.y += p.vy * deltaSec;
      p.g.alpha = 1 - p.life / p.ttl;
    }
  }
}
