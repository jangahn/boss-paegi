/**
 * Multi-reference edit (FLUX-2 등) 용 prompt 빌더.
 * 의도: @image1 의 구도/비율/스타일/배경 + @image2 의 face identity 만.
 *
 * 핵심: identity 와 composition 분리를 명시적으로 prompt 에 박아둠.
 */

const BASE = [
  "@image1 is the strict character template — exactly copy its composition, full body chibi proportions, standing front-facing pose, dark business suit and tie outfit, shoes, plain white background, square 1:1 aspect ratio, and overall art style.",
  "@image2 provides ONLY the facial identity (face shape, eye spacing, eyebrows, nose shape, skin tone, ethnicity) of the character.",
  "Replace the face on the template in @image1 with the facial identity derived from @image2, keeping all other template properties (style, body, pose, outfit, background) intact.",
  "Do NOT copy from @image2: its background, lighting, camera angle, original hair, clothing, body, or aspect ratio.",
  "Output: square 1:1 full-body chibi character avatar on plain white background, consistent with the @image1 template.",
].join(" ");

export function buildMultiRefPrompt(opts: {
  styleHint?: string;
  promptHints?: string;
}): string {
  const parts = [BASE];
  if (opts.styleHint) parts.push(`Style emphasis: ${opts.styleHint}.`);
  if (opts.promptHints) parts.push(`Additional: ${opts.promptHints}.`);
  return parts.join(" ");
}
