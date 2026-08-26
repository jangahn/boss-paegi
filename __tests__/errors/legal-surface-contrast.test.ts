import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function cssHex(css: string, token: string): [number, number, number] {
  const match = css.match(
    new RegExp(`--${token}:\\s*#([0-9a-fA-F]{6})\\b`),
  );
  assert.ok(match, token);
  const hex = match[1]!;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(
  foreground: [number, number, number],
  background: [number, number, number],
): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

test("footer and home small legal text meet WCAG AA normal-text contrast", () => {
  const css = source("app/globals.css");
  const footer = source("components/SiteFooter.tsx");
  const home = source("app/page.tsx");
  const paper = cssHex(css, "color-paper");
  const zinc500 = cssHex(css, "color-zinc-500");
  const zinc600 = cssHex(css, "color-zinc-600");

  assert.match(footer, /text-\[11px\][^"]*text-zinc-600/);
  assert.doesNotMatch(footer, /text-\[11px\][^"]*text-zinc-(?:400|500)/);
  // 라벨-값 목록의 dt 라벨은 11px를 상속하므로 AA 하한인 zinc-500까지만 허용(zinc-400=2.2:1 미달).
  assert.match(footer, /<dt className="text-zinc-500">/);
  assert.doesNotMatch(footer, /text-zinc-400/);
  assert.match(home, /text-xs[^"]*text-zinc-600/);
  assert.match(home, /text-\[11px\][^"]*text-zinc-600/);
  assert.ok(
    contrast(zinc600, paper) >= 4.5,
    `contrast=${contrast(zinc600, paper).toFixed(3)}`,
  );
  assert.ok(
    contrast(zinc500, paper) >= 4.5,
    `label contrast=${contrast(zinc500, paper).toFixed(3)}`,
  );
});
