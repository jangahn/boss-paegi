import "server-only";
import { FluxPulidProvider } from "./providers/flux-pulid";
import { CharacterProvider } from "./types";

/**
 * provider 추상화 — 새 모델 도입 시 providers/<name>.ts 작성 후 selectProvider 에
 * case 추가. 현재는 PuLID 단일.
 */
export function selectProvider(_key?: string | null): CharacterProvider {
  // 향후 multi-provider 비교 필요시 _key 로 분기. 지금은 PuLID 만.
  return new FluxPulidProvider();
}

export type { CharacterProvider, CharacterGenInput, CharacterGenResult } from "./types";
