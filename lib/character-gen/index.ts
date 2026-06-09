import "server-only";
import { Flux2ProEditProvider } from "./providers/flux2-pro-edit";
import { FluxPulidProvider } from "./providers/flux-pulid";
import { CharacterProvider } from "./types";

// 테스트 단계 default — face fidelity 우선. flux2-pro-edit 로 되돌리려면 여기만 바꾸면 됨.
const DEFAULT_PROVIDER = "flux-pulid";

/**
 * provider 추상화 layer. 새 provider 추가 시:
 *  1. providers/<name>.ts 에 CharacterProvider 구현체 작성
 *  2. 아래 switch 에 case 추가
 *  3. (선택) env CHARACTER_PROVIDER 또는 ?provider= query 로 토글
 */
export function selectProvider(key?: string | null): CharacterProvider {
  const name = key ?? process.env.CHARACTER_PROVIDER ?? DEFAULT_PROVIDER;
  switch (name) {
    case "flux-pulid":
      return new FluxPulidProvider();
    case "flux2-pro-edit":
    default:
      return new Flux2ProEditProvider();
  }
}

export type { CharacterProvider, CharacterGenInput, CharacterGenResult } from "./types";
