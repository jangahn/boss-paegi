@AGENTS.md

# boss-paegi 작업 룰

상위 `Personal/CLAUDE.md` 의 룰 (브랜치 최신화, README 갱신, merge commit, 모듈화) 도 그대로 적용.

## 패키지 매니저

npm 사용. pnpm/yarn 금지 (lockfile 충돌 방지).

## 정책 / 보안 — 필수 준수

이 프로젝트는 실존 인물의 사진을 다루므로 한국 개인정보보호법 + 명예훼손 리스크를 항상 우선 고려.

1. **업로드 이미지 원본은 절대 영구 저장 금지.** AI 생성 완료 직후 메모리/임시 파일에서 즉시 폐기.
2. **AI 생성 프롬프트는 항상 강한 캐릭터화 강제.** `3D claymation / caricature / exaggerated chibi style` 등 키워드 필수.
3. **API 키는 서버 전용.** `FAL_KEY`, `SUPABASE_SERVICE_ROLE_KEY` 는 절대 `NEXT_PUBLIC_*` 로 노출 금지. 클라이언트 번들 검사 필요.
4. **동의 다이얼로그 우회 금지.** `/generate` 진입 시 3개 체크박스 강제.
5. **Rate limit 우회 금지.** AI 생성은 반드시 서버 Route 에서 `ai_generations` 카운트 확인 후 진행.

## 코드 구조

- 게임 로직 (PixiJS) 은 `game/` 안에서 React 와 분리. React 컴포넌트에서 `useEffect` 로 마운트만.
- 한 파일 ~300-400 줄 부근에서 분리 (`Personal/CLAUDE.md` 룰).
- TypeScript strict. `any` 지양.
- 환경변수는 `lib/env.ts` (만들면) 에서 일괄 검증.

## 검증

- 로컬: `npm run dev` → `http://localhost:3000`
- Claude Preview MCP (`preview_start` → `preview_snapshot`/`preview_screenshot`) 로 화면 확인 필수.
- 타입체크: `npm run typecheck`
- 모바일 기준: Lighthouse PWA 90+ / Mobile Performance 80+ (M6 이후).

## 도구 사용 시 주의

- `app/api/fal/route.ts` 등 서버 Route 에서 `process.env.FAL_KEY` 접근. 클라이언트 컴포넌트에서 직접 fetch 금지.
- Supabase 클라이언트는 컨텍스트별로 분리 사용 — `lib/supabase/client.ts` (브라우저) vs `lib/supabase/server.ts` (Route/Server Component).
