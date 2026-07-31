# boss-paegi (부장님 패기)

라이브: https://boss-paegi.vercel.app

직장인 스트레스 해소용 캐주얼 웹 게임. 사진을 업로드하면 AI가 강하게 캐릭터화한 부장님 캐릭터를 만들어주고, 화면에서 마음껏 패고 점수·랭킹으로 풀어준다.

기획서 핵심: **이미지 업로드 기반 AI 캐릭터 커스터마이징**. 기존 Kick the Buddy / Beat the Boss 류와 차별화되는 진짜 "내 상황에 맞는" 감정 해소.

## 빠른 실행

```bash
npm install
cp .env.example .env.local   # 값 채우기
npm run dev                  # http://localhost:3000
```

로컬·CI·프로덕션 빌드의 Node.js major는 **22**로 고정한다. `.nvmrc`는 `22`,
`package.json`의 `engines.node`는 `22.x`이고, `prebuild`의
`scripts/qa/assert-node-major.mjs`가 `predev`·`prebuild`·`prestart`와
`build`·`start` 본문에서 다른 major를 즉시 거부한다. `dev` 본문도
`run-node22-command.mjs`를 반드시 거쳐 설치된 nvm v22만 exact 경로로 선택하므로
`npm --ignore-scripts`가 lifecycle guard를 생략해도 우회되지 않는다. v22가 없으면
현재 Node나 빈 PATH 항목으로 조용히 fallback하지 않고 중단한다. Vercel
프로젝트 설정만 믿지 않고 최종 production build log와 runtime에서도 실제 Node 22를
확인해야 배포가 완료된 것으로 판정한다.

## 검증

```bash
npm run audit
npm run lint
npm run typecheck
npm test
npm run build

# disposable local Supabase에서 실제 rollout 순서까지 검증
npm run qa:db:apply:expand
npm run qa:db:rollout-expand
npm run qa:db:checkout-convergence-race
npm run qa:db:apply:contract
npm run qa:db:rollout-contract
npm run qa:db:apply:oauth-expand
npm run qa:db:oauth-expand
npm run test:db:oauth-expand-compat
npm run qa:db:oauth-prune-lock-race
npm run qa:db:oauth-migration-member-race
npm run qa:db:apply:oauth-contract
npm run qa:db:oauth-contract
npm run qa:db:analytics-maintenance-raw-guard
npm run qa:db:apply:oauth-post-contract
npm run test:db:analytics-maintenance-bounds
npm run test:db:dead-service-rpc-acl-cleanup
npm run qa:db:analytics-maintenance-acl-upgrade
npm run qa:db:analytics-maintenance-lock-race
npm run test:db
```

CI의 DB job은 26개 파일인 `0072`~`008907` expand 호환성 검증 뒤에만 `0090`~`0092` contract를 적용한다. 이어 `0093` OAuth expand를 **단독 적용**하고 legacy score pgTAP으로 raw 익명이전의 구 앱 호환 실행권을 증명한 뒤에만 `0094` OAuth contract를 **단독 적용**한다. 원본 `0095`가 staged-runner guard에서 전부 rollback함을 증명한 후에만 `0095` analytics maintenance hardening을 **0094와 다른 transaction으로 단독 적용**하고, maintenance bounds/exact ACL 50개와 superseded service RPC owner-only 16개 focused pgTAP·실제 lock race·전체 pgTAP·GoTrue 계약 harness를 실행한다. `qa:db:apply`는 빈 로컬 DB에 최종 스키마를 구축하는 단축 명령일 뿐 staged rollout 증거가 아니다. 기존 결제/스토리지 운영 적용은 `qa:prod:rollout:*`, OAuth 운영 적용은 unchanged `origin/main` 위 clean exact HEAD에서 `qa:prod:oauth:expand[:apply]` → 같은 `HEAD:main` fast-forward와 exact Git↔Vercel production deployment 확인 → **1505초 drain 및 append-only DB qualification** → `qa:prod:oauth:app-postflight` → `qa:prod:oauth:contract[:apply]` → frozen 비용 surface를 유지한 `qa:prod:oauth:post-contract[:apply]` 순서다. ordinary merge/squash/rebase/cherry-pick으로 SHA를 바꾸거나 **0093+0094 동시 적용 또는 0094+0095 동일 transaction 적용은 금지**하며 상세는 [`docs/oauth-flow-rollout.md`](docs/oauth-flow-rollout.md)를 따른다. 로컬 `qa:db:*` 명령을 운영 DB에 사용하지 않는다. 과거의 비표준 suffix 파일 `0012a`/`0012b`는 Supabase CLI가 인식하는 고유 숫자 버전 `001200_score_highlights.sql`/`001201_drop_score_highlight_cols.sql`로 교체했으며, 둘은 의도한 대로 `0013`보다 먼저 적용한다. 실제 fal.ai 생성·과금과 실기기 동작은 자동 QA에서 실행하지 않고 검증 경계로 기록한다.

`supabase/config.toml`의 `[db.migrations].enabled=false`는 의도적이다. 전체
contract, 특히 OAuth `0093`+`0094`와 post-contract `0095`가 자동으로 연속 적용되는 것을 막고
expand/contract staged custom runner만 권위로 사용한다. 따라서 `supabase db reset`, `supabase db push`,
`supabase migration up`은 이 레포에서 migration QA·배포 명령이 아니며 project
migration을 건너뛰는 성공 응답을 합격으로 해석하면 안 된다. disposable DB는
`supabase start` 뒤 `npm run qa:db:apply:expand`부터 위 순서대로 구축한다.

검증 모델·기능별 범위·실행 증거·외부/실기기 경계는 [`docs/qa-validation-report.md`](docs/qa-validation-report.md)에 기록한다.

## 기술 스택

| 영역 | 선택 |
|---|---|
| Frontend | Next.js 16 (App Router) + TypeScript + Tailwind CSS v4 |
| 게임 렌더링 | PixiJS v8 (WebGL) |
| 물리엔진 | matter.js (던지기·복귀 spring) |
| 백엔드 / DB | Supabase (Postgres + Auth + Storage + RLS) |
| 인증 | Supabase Anonymous Auth → 랭킹 등록 시점에 카카오/구글 소셜 유도 |
| AI 이미지 생성 | fal.ai (서버사이드 프록시) |
| 호스팅 | Vercel |
| 상태 관리 | Zustand |
| 패키지 매니저 | npm |

## 디자인 시스템 — "인사기록부(도시에)"

OG 히어로의 톤앤매너를 사이트 전체로 확장. **크림 마닐라 종이 + 네이비 잉크 + 스탬프 레드 + 골드**의 풍자적 서류철 컨셉(단계별 PR 로 전환 중).

- **토큰은 `app/globals.css` `@theme` 단일 출처.** 시맨틱 토큰(`bg-paper`/`text-ink`/`bg-stamp`/`text-gold`/`border-line`/`bg-steel`)을 쓰고, 기존 유틸(`zinc`/`amber`/`red`/`emerald`/`sky`)은 도시에 팔레트로 **리맵**돼 자동 워밍됨. 새 하드코딩 hex 금지.
- **표면 역할 캐논(케이스별 불일치 종식).** 같은 시각 역할을 파일마다 다른 클래스로 쓰던 게 불일치 재발 원인 → `globals.css` 상단 주석 표를 **유일한 정답**으로 고정. 핵심 역할 클래스: **`ui-surface`**(`@utility`, =`var(--color-paper-2)`) = 떠 있는 오프화이트/다크 면(카드·패널·메뉴·모달·드롭다운·2차버튼·표 헤더), **`ui-field`**(=투명) = 입력 필드(input/textarea/select). 페이지=`bg-background`, 1차버튼=`bg-foreground text-paper-2`, 표 바디행=배경없음, 칩=`border`만, 차트/옅은노트=`bg-foreground/5`, 상태틴트=의미색. **새 표면은 raw `bg-*` 대신 역할 클래스 사용**(`bg-paper-2`는 opacity 필요 시 예외).
- **단일 라이트 테마(플레이 모드).** `@custom-variant dark` 로 `dark:` 유틸 무력화(OS 다크에서도 크림 고정). 카카오 옐로우 등 **브랜드 색은 리맵 예외**(그대로 유지).
- **어드민 = 다크 '운영 콘솔' 테마.** `/admin/*`(`app/admin/layout.tsx` 래퍼에 `.theme-admin`)만 **브랜드 네이비 다크**로 스위칭 — 플레이(크림)와 운영을 시각적으로 분리. 구현은 **CSS 변수 스코프 오버라이드**(`globals.css` `.theme-admin` 가 `--background`/`--foreground` + 모든 `--color-*` 램프를 다크값으로 재정의) → **같은 유틸 클래스가 컴포넌트 수정 0으로 다크 렌더**. 상단에 골드 "운영 모드" 스트립. 공개 영역은 무영향(스코프가 어드민 서브트리 한정).
- **디스플레이 폰트 = Gmarket Sans Bold**(타이틀·점수, `font-display` / `globals.css` `@font-face`, jsdelivr `fonts-archive`). 단일 face 로 전 weight 매핑. 본문은 Pretendard 스택. 한글 제목은 `word-break: keep-all`로 어절 단위 줄바꿈(소형폰 단어중간 깨짐 방지).
- 질감 강도 = **큐레이티드**: 히어로·빈 상태·핵심 CTA 엔 폴더탭·클립·고무도장·서류 No. 모티프, 데이터 밀집 페이지(랭킹·기록·어드민)는 장부형으로 절제.

## 디렉토리 구조

```
boss-paegi/
├── app/                    # Next.js App Router
│   ├── api/                #   서버 Route (fal.ai 프록시, score, doll, avatar, pay 결제)
│   ├── auth/callback/      #   OAuth 콜백 (세션 확립 + 동의여부 판정 → /consent 또는 목적지)
│   ├── login/              #   Kakao/Google 로그인 (가입 = 첫 로그인)
│   ├── generate/           #   캐릭터 생성 플로우 (회원 전용)
│   ├── play/               #   게임 화면 (PixiJS 마운트)
│   ├── gallery/            #   캐릭터 갤러리 (비회원 열람 가능 — 기본부장님 노출 + 가입 후킹 / 생성은 회원 전용)
│   ├── credits/            #   생성권 충전 (회원 전용, 포트원 결제) + done(결제 후 폴링)
│   ├── leaderboard/        #   랭킹 (프로필 아바타 표시 → 행 클릭 시 기록 페이지)
│   ├── history/[userId]/   #   지난 게임 기록 목록·상세 (본인/타인 공용, 공개)
│   ├── layout.tsx
│   └── page.tsx            #   랜딩
├── game/                   # PixiJS 게임 로직 (React 와 분리)
│   ├── scenes/             #   PlayScene (입력 모드 전환 통합)
│   ├── entities/           #   Doll / Projectile / DrawingLayer
│   ├── effects/            #   HitEffect (파티클)
│   ├── physics/            #   matter.js wrapper (PhysicsWorld)
│   └── input/              #   ThrowInput, DrawInput
├── lib/
│   ├── supabase/           #   client.ts / server.ts / admin.ts / middleware.ts
│   ├── auth-server.ts      #   requireMember (회원 전용 라우트 게이트)
│   ├── oauth-metadata.ts   #   OAuth 프로필 추출 + safeNext (open redirect 차단)
│   ├── auth-oauth.ts       #   startOAuth (linkIdentity/signInWithOAuth) / signOut
│   ├── avatar.ts           #   프로필 사진 업로드 (다운스케일 → 서명 URL)
│   ├── fal.ts              #   fal.ai 호출 + 프롬프트 빌더
│   ├── portone.ts          #   포트원(V2) 결제 연동 (server-only: 단건조회/취소/웹훅 서명검증)
│   ├── pay-channels.ts     #   결제수단↔채널키 매핑 (클라/서버 공용, NEXT_PUBLIC 만)
│   ├── credit-products.ts  #   충전 상품 allowlist (단일 소스, 클라/서버 공용)
│   ├── policy.ts           #   동의 문구 / 면책 상수
│   ├── log.ts              #   구조화 JSON 로깅 (console + Sentry 브릿지 / 토큰 스크럽)
│   ├── sentry-bridge.ts    #   로그 이벤트 → Sentry (error/warn=issue, info=breadcrumb)
│   ├── share.ts            #   Web Share / OG helper
│   ├── score-detail.ts     #   한 게임 상세 fetch (share·history 공용, server-only)
│   └── telemetry/          #   게임플레이 텔레메트리 (collector/transport/validate/budget — 5초 버킷 이벤트, 클라/서버 공용)
├── components/             # React UI
├── store/                  # Zustand stores
├── supabase/migrations/    # SQL 마이그레이션
└── public/
    ├── manifest.webmanifest
    ├── icons/              # PWA 아이콘
    ├── avatars/            # 기본 프로필 사진 (default.png — 교체 가능)
    ├── sprites/            # 기본 캐릭터 + 무기 sprite
    └── bg/                 # 배경
```

## 환경 변수

`.env.example` 참조. 로컬은 `.env.local`, Vercel 은 Dashboard 에서 설정.

| 키 | 용도 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (클라이언트 안전) |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용. 절대 클라이언트 노출 금지 |
| `OPS_USER_ID` | 운영 계정 user.id — 생성권 무제한 (선택) |
| `FAL_KEY` | fal.ai API 키. **서버 전용** |
| `NEXT_PUBLIC_SITE_URL` | 공유 링크 / OG 이미지 / **포트원·FAL 웹훅 및 리다이렉트 베이스**용. ⚠️ Vercel prod 에 실제 HTTPS 공개 도메인 필수. localhost·사설 IP는 FAL 제출 전에 거부한다 |
| `PORTONE_V2_API_SECRET` | 포트원 V2 API Secret — 단건 조회·취소. 콘솔 [식별코드·API Keys]>[V2 API]. 미설정 시 결제 비활성(503). **서버 전용** |
| `PORTONE_API_BASE_URL` | **운영에서는 설정 금지**. 운영은 exact `https://api.portone.io`로 고정되며 다른 값이면 시작을 거부한다. `test`/`development`에서도 `http://localhost`·`127.0.0.1`·`[::1]`의 path/query/credential 없는 stub만 허용 |
| `PORTONE_WEBHOOK_SECRET` / `PORTONE_WEBHOOK_SECRET_TEST` | 포트원 웹훅 서명 시크릿(Standard Webhooks, `whsec_~`) — 실연동/테스트 환경 각각 발급·**병존**(검증은 두 키 순차 시도). 둘 다 미설정 시 웹훅 비활성. **서버 전용** |
| `NEXT_PUBLIC_PORTONE_STORE_ID` / `NEXT_PUBLIC_PORTONE_CHANNEL_KEY_{CARD,TOSSPAY,KAKAOPAY}[_TEST]` | 클라 결제창 호출용 공개 식별자(승인·취소 권한 없음 — 서버 시크릿과 구분). 채널키=콘솔 채널관리 발급. 무접미사=**실연동 채널**(일반 유저) · `_TEST`=**테스트 채널**(심사·테스트 계정 전용) — 두 세트 동시 운영, 계정 기반 스위칭(`payModeFor`). 미설정 수단/모드는 UI 숨김·체크아웃 차단 |
| `CRON_SECRET` | ops cron(`/api/ops/reconcile`·`gen-recover`·`telemetry-maintain`·`content-maintain`·`analytics-maintain`·`integrity-scan`·`credit-expire`·`privacy-maintain`) 보호 시크릿. cron-job.org 가 `x-cron-secret` 헤더로 전달. 미설정 시 해당 cron 비활성(503). **서버 전용** |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN. 미설정 시 Sentry 전부 no-op (앱 정상) |
| `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` | Sentry Session Replay의 별도 공개 운영 opt-in. 기본값·미설정·`0` 및 `true` 등은 비활성이고, **production에서 exact literal `1`일 때만** Replay 통합과 sampling(오류 100%·일반 10%) 활성 |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | 빌드 시 소스맵 업로드용 (선택) |

현재 8개 ops route는 한 호출 전체에 공통 20초 monotonic deadline과 25초 platform
hard ceiling을 쓴다. queue/backoff/operator 후속이 남으면 `200`이 아니라
`429 + Retry-After: 60 + Cache-Control: no-store`, 권위 의존성 오류는 `503`이다.
cron-job.org가 `207`을 성공으로 취급하므로 ops route는 `207`을 사용하지 않는다.
외부 scheduler request timeout은 90초로 두고 non-2xx failure alert를 활성화한다.
회귀 테스트는 `app/api/ops/**/route.ts`를 파일시스템에서 동적으로 찾아 공통 인증,
deadline, `maxDuration=25`, 실패 응답 계약을 적용하므로 새 route도 자동 편입된다.
2026-07-30 운영 read-only inventory에서는 `privacy-maintain`을 제외한 기존 7개
잡의 등록·활성이 확인됐다. `telemetry-maintain`과 `analytics-maintain`은 각각
KST 09:00 일 1회, `gen-recover`는 5분 주기로 이미 가동 중이다.
`privacy-maintain`만 해당 migration·앱 배포 후 POST 방식으로 새로 등록하고 실행
이력의 drain 200을 확인해야 한다.

> Kakao/Google OAuth provider 키(client id/secret)는 앱 env 가 아니라 **Supabase Auth config**(Management API `PATCH /config/auth`)에 저장 — 아래 *회원 / 인증* 참조.

## 회원 / 인증 (OAuth)

익명 세션(`signInAnonymously`) + **Kakao/Google OAuth 회원**. 비회원도 플레이·랭킹·**갤러리 열람**은 자유, **캐릭터 생성·충전·관리자는 회원 전용**(`proxy.ts` 가 `/generate`·`/credits`·`/admin` 을 익명 시 `/login` 으로 리다이렉트). 갤러리는 비회원에게 **기본부장님**만 노출(맨 앞 '기본' 뱃지) — 공유/롤 변경/새 캐릭터 시도 시 후킹 토스트·배너로 가입(가입기념 생성권 1개) 유도. 가입(`/login?next=/generate`) 후 곧장 생성으로.

- **로그인은 자유, 동의는 글로벌 게이트(렌더 전)**: 별도 가입 페이지 없음 — `/login` 버튼뿐. OAuth 로그인하면 세션은 확립되지만, **로그인했는데 미동의면 `proxy.ts` 가 모든(비예외) 페이지 진입을 렌더 전에 `/consent` 로** 막는다(뒤로가기·직접URL·클라내비 우회 불가). 동의 화면 선택지는 **[동의] 또는 [로그아웃]뿐**. **회원 생성·OAuth 닉/프사/이메일 시드·가입보너스는 동의 시점의 단일 RPC**(`/api/account/consent` → `create_or_update_member_consent_with_profile`)에서 원자 처리하고, 익명이전은 그 RPC 전에 성공해야 한다. RPC는 사용자가 본 terms/privacy 버전을 같은 transaction의 legal advisory lock 아래 현재 시행본과 다시 비교해 publish/rollback TOCTOU를 차단하며, `growth_levers` 읽기 오류·손상은 기본 보너스로 강등하지 않고 member INSERT 전에 503으로 끝낸다. 콜백은 회원을 만들지 않고 동의여부만 판정해 미동의면 직접 `/consent`, 동의완료면 목적지로. `/consent` 의 약관/방침 "보기"는 인라인 모달(전문 로드 실패 시 동의 차단). 예외 경로 = `/consent`·`/auth/*`·`/api/*` + 정적/`_next`(`lib/routes.isConsentExempt`); **`/login` 은 anon 전용**(로그인 사용자가 가면 미동의→`/consent`·완료→`/`). `/signup`·`/reconsent` 는 `/consent` redirect stub. **회원탈퇴는 동의완료 회원만 도달**(`account/delete`=`requireAuthedNonDeleted`, 계정 종료 권리).
- **proxy 글로벌 게이트(`proxy.ts`)**: GET/HEAD 문서/RSC 내비에만(POST/Server Action 은 endpoint `requireMember` 백스톱 — 앱에 server action 없음). 로그인 사용자는 `profiles.deleted_at`+`member_accounts.{age,terms,privacy}` self-read(`maybeSingle`, no-row≠실패) + edge-safe 현재버전(`lib/legal/edge-versions`, isolate별 최대 60s 캐시) → `lib/consent.missingConsentItems` 단일 규칙으로 판정. 캐시 identity에 KST 날짜가 포함되어 예약 시행일 자정에는 전날 항목을 재사용하지 않고, 수동 발행 직후 proxy의 최대 60s 지연과 무관하게 최종 회원 API/RSC의 uncached `requireMember`가 즉시 차단한다. **실패 정책**: proxy의 member 조회 실패는 `/consent`로 fail-closed하고 edge 버전 조회 실패는 가용성 때문에 임시 fail-open하되, 최종 회원 API/RSC 경계 `requireMember`와 OAuth callback/consent API는 `profiles`·`member_accounts`·현재 legal version의 `{ error }`를 no-row/발행본 없음과 구분해 **503 또는 cookie 보존 재시도 경로로 fail-closed**한다. `/consent` 화면 자체도 auth/profile/member/legal version·표시 전문의 오류·no-row·버전 경합·손상을 동의완료/문서없음으로 강등하지 않고 명시적 **다시 시도** UI로 차단한다. `deleted_at` set=auth 쿠키 만료+`/login?error=account_deleted`(잔존 세션 루프 방지). redirect 는 세션 쿠키 보존+`no-store`. 결제 webhook(`/api/pay/webhook`)은 updateSession 전 즉시 pass-through. `missingConsentItems` 는 `<` 비교(동의 버전이 현재보다 높아도 OK — 두 버전 소스 publish 직후 divergence 루프 방지). 법무 v2 정본과 30일 사전고지·원자 발행 runbook은 `legal/v2-documents.mjs`·`docs/legal-v2-rollout.md`에 고정되어 있으며 실제 시행 전까지 v1이 권위다.
- **계정 상태(클라, `lib/profile`)**: `isLoggedIn`(비익명=로그인) + `genCredits` + `isAdmin` 만(동의 판정은 서버 proxy → 클라 계산 제거). 메뉴·갤러리는 `isLoggedIn` 기준(로그인=proxy 통과=동의완료). 서버 회원기능 API=`requireMember`(동의완료, 미동의→`consent_required`).
- **마이그레이션(익명→회원)**: 익명 상태 OAuth 로그인 시 **서명 쿠키(`MIGRATE_COOKIE`, `lib/cookies`)** 로 익명 데이터(scores·badges·telemetry)를 동의 시점의 **strict member no-row 신규 후보에서만** 이전한다. 이전은 member INSERT보다 먼저 수행하며 HMAC+TTL source 권한·source≠target·target Auth 비익명/identity·target member no-row를 runner 안에서 다시 검증하고, Auth source 조회·source member 조회·금지 데이터 3종 exact count·reassign RPC·즉시 Auth 삭제의 throw와 resolved `{ error }`, null/손상 count, reassign/delete 성공 증거 누락을 모두 `failed`로 판정한다. flow-scoped 재할당 transaction은 원본 Auth의 `created_at+instance_id` 세대에 결속한 durable cleanup job도 함께 arm하므로, 즉시 삭제 응답 유실이나 실패가 orphan Auth 사용자를 영구히 남기지 않는다. 0093 expand 중에는 **flow discovery가 exact absent일 때만** 구 앱이 발급한 유효한 3-part HMAC `signup_migrate`를 raw reassignment 호환 경로로 소비하며, flow 권한이 있으면 이 fallback을 절대 사용하지 않는다. 새 production alias 이후 구 invocation 최대 300초 + legacy TTL 900초 + 새 consent invocation 최대 300초 + clock margin 5초인 1505초를 drain한 뒤에만 0094가 raw 권한을 회수한다. `content-maintain`은 fresh Admin Auth read와 DB 세대 검증 뒤 삭제를 재시도하고, 삭제 호출 응답 자체는 성공 근거로 쓰지 않으며 fresh `user_not_found`와 잠금 아래 DB 부재가 함께 확인된 경우에만 완료한다. 모호한 결과는 backoff 재시도하고 pending/leased 동안 같은 UUID의 재생성·비익명 승격을 trigger로 차단하며, 세대가 이미 달라졌다면 새 사용자를 삭제하지 않고 `protected`로 종결한다. int4 최종 attempt/lease에서도 wrap하지 않고 `protected/cleanup_attempt_limit_exhausted`와 cron 실패로 노출한다. `reassign_anon_data`는 raw 익명 owner 대신 세션별 submitter binding으로 telemetry를 찾아 새 회원 binding으로 회전하며, source advisory lock+영구 winner receipt로 **동일 target 재시도는 멱등·다른 target 재사용은 충돌**한다. 점수의 현재 owner만 바꾸고 immutable submission-origin namespace는 유지해 cross-owner UUID 충돌을 보존하며, commit 뒤 응답유실된 익명 outbox는 영수증+현재 score owner+origin key+fingerprint가 모두 일치할 때만 새 회원 세션에서 복구한다. 실패면 503 + MIGRATE 유지 + row 미생성으로 끝나 다음 POST가 실제 이전을 재시도하고, 이전 성공/재시도 불필요(`skipped`) 후에만 동의 RPC가 INSERT해 성공 시 cookie를 clear한다. 이전 뒤 동의 INSERT만 실패했거나 Auth만 먼저 사라진 재시도에서 명시적 Auth `user_not_found`는 source no-row/삭제 완료로 정규화하되, 위 권한·target 검증 뒤 멱등 reassign을 다시 실행해 남은 orphan 데이터까지 복구한다. **URL/body에서 `migrationFlow`가 빠져도 target session discovery가 released+unconsumed flow를 복구한다. 기존 target member/target 선점은 exact no-transfer receipt 뒤 source profile·highlight·session을 즉시 quarantine하고 동일 target principal이 flow expiry+30일+5초까지 live session으로 복구할 수 있게 한다. source 비익명 승격·회원화, 금지 source 데이터, source Auth 세대 변경은 별도 principal을 보존하면서 `blocked/migration_blocked`로 남겨 privacy cron을 non-green으로 유지한다.** 원 target session 소실은 terminal 사유가 아니며 release 24시간 뒤 quarantine만 수행한다. exact deadline을 엄격히 지난 경우 또는 target profile 탈퇴·부재는 score/Auth/profile shell을 비식별 보존하고 badge·highlight·telemetry·source session을 scrub한다. 미증명 사유·모호한 discovery·손상 receipt는 member mutation 전에 fail-closed하고, 증명된 skip은 `migration_consumed_at`을 채워 35일 초과 미소비 backlog를 만들지 않는다. old JWT는 현재 Auth session의 exact 세대가 살아 있을 때만 read를 통과하고, 영구 session-ID tombstone이 같은 UUID 재사용을 막는다. 콜백의 profile/member/legal 판정 오류도 MIGRATE를 지우지 않고 `/consent` 재판정 경로에 머문다. 로그아웃(`/api/auth/signout`: server `auth.signOut`+sb-* 쿠키+MIGRATE 만료)·타계정 로그인 시 오이전 방지. `identity_already_exists`→`/login`.
- **OAuth durable flow ledger(0093/0094) + post-contract maintenance hardening(0095)**: callback code 교환 전 flow claim부터 target session 결속·동의 목적지·2단계 sign-out·브라우저 release·익명이전 소비와 익명 Auth cleanup까지 secret-free DB ledger와 exact receipt로 수렴한다. 완료됐어도 release 전 continue, 미소비 익명이전, pending/leased·quarantined·blocked cleanup은 retention 삭제하지 않고 `content-maintain`/`privacy-maintain` backlog로 공개한다. unbound claim은 signed lease 경계에서 expire하고 bound claim/sign-out은 5분 grace 뒤 exact target session revoke 또는 부재 증명으로 종결한다. DB rollout verifier는 flow·cleanup·winner receipt·quarantine marker·score/session tombstone·legacy receipt·deployment qualification의 여덟 critical private relation, 각 relation의 owner-only TRUNCATE guard, 전체 21개 trigger와 25개 core scoped RPC inventory, 별도 legacy bridge 단일 signature·ACL을 exact catalog로 검사한다. DB rollout은 `0093` expand → exact `gitRepo`/Git metadata와 GitHub `main` SHA가 일치하는 immutable production deployment 확인 → **1505초 drain**과 DB qualification receipt → `0094` raw reassignment·legacy bridge 권한 동시 회수 → 별도 transaction의 `0095` maintenance body/ACL fingerprint+receipt 순서만 허용한다. 0095 전후 OAuth contract catalog를 같은 transaction에서 재검증하며, raw 0095는 staged runner 없이 항상 rollback한다. 실행 명령·중단 조건·증거는 [`docs/oauth-flow-rollout.md`](docs/oauth-flow-rollout.md)가 정본이다.
- **계정 분리**: Supabase 자동 linking 수용 — 동일 **verified 이메일**의 Kakao/Google 은 같은 계정으로 연결될 수 있음. 다른 이메일이면 별개 계정. 멀티연동 UI 없음.
- **이메일 필수**: 이메일 없는/미검증 OAuth 는 멤버화 차단(`/login?error=email_required`). Kakao 는 Biz 인증 + `account_email` 필수 동의 필요.
- **테이블 분리**: 공개 프로필은 `profiles`(display_name/avatar_url, public read), 멤버십·생성권은 private `member_accounts`(self-read만, write 는 service-role/`SECURITY DEFINER` RPC). `profiles.avatar_url` 은 컬럼레벨 grant 로 클라 직접 변조 차단 → `/api/avatar`가 canonical owner path·실제 객체 size/mime·signed-token 수명을 확인한 뒤 upload intent와 함께 attach한다. 교체/삭제는 DB reference 변경+Storage cleanup outbox를 한 transaction에 남기고 즉시 처리 실패 시 cron이 재시도한다.
- **생성권(크레딧)**: 가입 시 1개 지급(발행된 `growth_levers.signupBonusCredits`가 권위, 코드 fallback도 1개), 생성마다 1개 차감(서버 원자 RPC·실패 시 환불). 소진 시 `/credits` 에서 **유료 충전**(포트원 결제, 아래 *결제* 참조)할 수 있다. `OPS_USER_ID` 는 무제한.
- **Provider 설정**(Management API `PATCH /config/auth`): Kakao/Google enabled+client_id+secret, `manual linking` 활성(linkIdentity 필수), `site_url`, `uri_allow_list`(prod+localhost `/auth/callback`). provider 측 redirect URI = `https://<ref>.supabase.co/auth/v1/callback`(앱의 `/auth/callback` 아님).

## 결제 (생성권 충전 — 포트원 V2)

**포트원(PortOne V2) 애그리게이터** 연동 — 채널 3종: 카드(KPN 신용카드 일반결제)·토스페이·카카오페이(간편결제 직연동). 페이앱은 '게임 캐릭터 생성권' PG 계약 거절로 제거(0058 — 실 paid 주문 0건 확인 후 컷오버, 레거시 주문 rows 는 `provider='payapp'` 으로 법정 보존). **KPN 이 V2 전용이라 연동 전체가 V2**(`@portone/browser-sdk/v2` + REST V2 + Standard Webhooks).

- **상품**: 발행 소스는 config `growth_levers`(fallback `lib/credit-products.ts` 4종). 클라는 `productId` 만 전송, price/credits/goodname 은 **서버 allowlist 로만 결정**(조작 차단). 모두 1,000원 이상(소액 카드결제 하한 가드).
- **흐름**: `/credits`(회원 전용, 수단 선택)→`POST /api/pay/checkout`(pending 주문 선삽입 + `payment_id` 채번 → 서버 결정값 반환)→클라 `PortOne.requestPayment()`(channelKey=수단별, `redirectUrl=/credits/done?order=`)→결제→**웹훅 `POST /api/pay/webhook`**(public)→`/credits/done` 폴링(`/api/pay/order-status`). 모바일은 리다이렉트 복귀(카카오페이 모바일=REDIRECTION 강제), PC 는 프로미스 반환 후 동일 경로.
- **paymentId**: 가맹점 채번 = `order_uuid` 하이픈 제거 hex(**KPN 이 영숫자만 허용**). 같은 paymentId는 포트원이 성공 1회만 허용한다. 앱은 시간 window가 아니라 사용자당 전역 미해결 PortOne intent 1개를 DB unique index로 강제하고, 같은 intent는 frozen receipt로 replay/reuse해 다른 paymentId의 중복 결제창을 막는다.
- **검증 3경로 수렴**: 웹훅·폴링(order-status)·대사(reconcile) 전부 **단건 조회 `GET /payments/{paymentId}` 재검증**만 신뢰한다. PAID·금액뿐 아니라 주문 생성 시 고정한 store/currency/channel key와 exact 일치해야 한다. 지급은 RPC `mark_paid_and_grant`(security definer, FOR UPDATE, pending/failed 허용)가 원자·멱등 처리하고 **credit_ledger 'purchase'를 원자 기록**한다. 외부 조회 뒤의 비종단 상태·evidence marker 기록도 최초 read의 `status`·`paid_at`·`error_message`를 CAS 조건으로 사용하고 즉시 durable postcondition을 재조회한다. 따라서 느린 READY/불일치 응답이 먼저 완료된 PAID 지급행의 `raw`나 `error_message`를 덮어써 `paid_review`로 후퇴시킬 수 없다. 주문의 `paid`는 PG 종결 사실이고 live 크레딧 지급 증거와는 분리된다. 탈퇴·취소의도·늦은 PAID처럼 `error_message`가 남는 무지급/quarantine 분기는 order-status가 `paid_review`로 반환해 완료 화면이 충전을 주장하지 않고 결제 내역의 운영 확인으로 안내하며, reconcile도 `granted`가 아닌 `manualReview`로 집계한다. 알 수 없는 향후 paid marker도 같은 방식으로 fail-closed한다. all-NULL 레거시 evidence는 `payment_evidence_incomplete`로 무지급이며 provider-backed backfill 전에는 어떤 지급 경로도 통과하지 못한다.
- **웹훅**: Standard Webhooks 서명 검증(`@portone/server-sdk`, **raw body**) → 단건 조회 재검증 → 상태 반영. 2xx=확인 / 5xx=포트원 최대 5회 재전송. 취소 웹훅은 `canceled_at` 채움(0057 폴백 정렬 갭 해소). 위조/우리 주문 아님(콘솔 수동 테스트 등)은 로그 후 확인 응답.
- **환불(수량 saga, v0.76)**: 크레딧은 **로트**(구매·가입보너스·CS지급·전환보전) 단위로 관리되고, 환불은 **주문 범위 수량 환불 saga**로 처리한다. 어드민이 회원 상세 또는 `/admin/refunds` 큐에서 수량·고객요청시각을 넣으면 `POST /api/admin/refund-credits` 가 `preview → begin(요청 채번·멱등키) → process(auto)` 로 진행 — process 는 fresh 단건조회 → **부분취소** `POST /payments/{id}/cancel`(body 정확히 `{amount, reason=marker BP_REFUND:<attempt>, currentCancellableAmount}` + `Idempotency-Key`) → `record_pg_result` → `commit`. **부분취소 1급 지원**(PARTIAL_CANCELLED 관측·경제 재대사), 환급률은 **약관 제10조 단일 소스**(7일내 전액·이후 90% — 코드에 수치 미기재). 회수 부족분은 `credit_refund_shortfalls`, 환불률 policy-cap 초과는 `invariant_violation`(Sentry 경보 — issue 큐 아님). 외부(콘솔) 취소는 이벤트 영속 + 대사 RPC(`resolve_external_cancellation`)로 화해, 미귀속은 `reconciliation_issues` 큐. 모든 금융 write 는 SECURITY DEFINER RPC 전용(§13 — 앱 직접 write 0, eslint `no-direct-financial-write` 가드). 구 `refund_state`·전액취소·`pg_done` 모델은 폐지.
- **테스트 채널 ↔ 실연동 채널(동시 운영)**: 콘솔 채널관리에서 테스트/실연동은 **독립 채널(각자 channelKey)** — env 두 세트(`…` / `…_TEST`)를 병존시키고 **계정 기반으로 서버가 스위칭**한다(`payModeFor`: reviewerEmails 계정=테스트 기본·`/credits?live=1` 시 실채널, 일반 유저=항상 실채널). checkout은 `growth_levers`를 uncached strict read하고, 화면이 표시한 TEST/LIVE mode와 상품 스냅샷(productId·가격·지급량·주문명)을 요청의 `expectedMode`/`expectedProduct` fence로 결속한다. reviewer/config가 render→click 사이에 바뀌어 서버 mode나 상품과 달라지면 409로 결제창을 열지 않으므로 TEST 표시가 LIVE 청구로, 표시 가격이 다른 청구액으로 조용히 전환되지 않는다. 주문에는 `is_test`·`pay_channel` 이 기록되고(0059), 지급 3경로(웹훅/폴링/reconcile)가 포트원 단건조회 `channel.type` 과 대사해 **테스트 채널 결제 → 실주문 지급을 차단**(`paymentModeMismatch` 백스톱). 테스트 채널은 계약 전에도 공용 테스트 MID(tosstest·TC0ONETIME·merchantest6)로 생성 가능. **KPN 카드 테스트 결제만** 매입 전 자동 void되어 사후 취소가 P568로 실패할 수 있으며, 토스페이·카카오페이까지 같은 동작으로 일반화하지 않는다. KB국민·NH농협·카카오뱅크 카드는 테스트 불가다.
- **PG 심사용 계정**: 심사·테스트 계정 판정은 `lib/reviewer.ts isReviewerUser` 단일 소스 — ① `growth_levers.reviewerEmails`(콘솔 성장 레버 "테스트 결제 계정 이메일", OAuth 심사관 allowlist) ② `reviewer_accounts`(0060, `/admin/reviewers` 에서 ID/PW 계정 CUD — 생성 시 auth email 유저+동의 스탬프+원장 insert, 비번은 응답 1회 표시). 사용분 청약철회 제한은 별도 체크박스로 적극 확인받고 사용자·주문·상품·금액·모드·채널·문구 버전·시각·request ID에 결속한 불변 증거를 주문과 원자 저장·재조회한다. 구현 fence는 완료됐지만 `PAYMENT_CHECKOUT_ENABLED=1`인 검증 완료 배포에서만 /credits와 checkout이 열리며 reviewer도 증거 경계를 우회하지 않는다. ID/PW 진입은 `/login?reviewer=1`(평상시 로그인 UI 불변). email 가입 계정은 가입보너스 0(공개 email 프로바이더 경유 보너스 파밍 차단). 심사 계정 주문은 테스트 채널 + `is_test`로 기록되어 어드민 매출·KPI 에서 제외(주문 목록·회원 상세·환불 경고에 TEST 뱃지 표시). **사업자정보 푸터**(`business_info.info` — 콘솔 '사업자 정보' 탭, v0.74 에 site_content 에서 분리)는 심사 요건(상호·사업자번호·대표자·주소·유선전화 상시 노출).
- **설정**(사용자 작업): 포트원 콘솔 — ①채널관리에서 테스트 채널 3개 추가(채널키 확보) ②[식별코드·API Keys]>[V2 API] Secret 발급 ③[결제알림(Webhook) 관리]에서 `{SITE_URL}/api/pay/webhook` 등록(V2·테스트/실연동 각각)+시크릿 확보 → env 6종(.env.local+Vercel). 계약·카드사 심사 완료 후 실연동 채널로 교체.

### 운영 한계·모니터링
- **웹훅 미도달**: 3중 자가치유 — ①`/credits/done` 폴링이 pending·failed 면 서버가 단건 조회→지급 ②대사 cron(`/api/ops/reconcile`)이 2h+ pending 을 단건 조회로 **실제 대사**(PAID→지급[웹훅 유실 경고]·FAILED/CANCELLED→종단·미결제 이탈→failed·READY 24h+ 좀비→failed 시효 종단[배치 기아 방지], 호출당 20건) ③잔여는 Sentry `pay.stale_payment_request` 경고. Sentry 경고 모니터: `pay.wh_grant_fail`·`pay.wh_amount_mismatch`·`pay.wh_paid_not_granted`·`pay.refund_invariant_violation`(fatal·임계 1·온콜 즉시)·`pay.refund_attempt_outstanding`·`pay.late_paid`(실결제라 임계 1 — **페이앱 시절 `payapp.*` 모니터는 `pay.*` 로 재설정 필요**, 환불 saga 상세 `docs/refund-runbook.md`).
- **환불 saga 미종결**: attempt 가 `manual_review`·또는 `pg_requested`(3h+) 로 남으면 `/admin/refunds` 큐 + 대시보드 경고. reconcile cron(5분)이 3h 내엔 동일 Idempotency-Key 재시도, 이후 GET 증빙 폴링으로 종단하고, 운영자 화해는 switch_to_manual/commit_manual/replan/release. 상세 대응은 `docs/refund-runbook.md`.
- **동시/다중 결제**: PortOne `pending`과 `failed` 중 `paid_at`/`canceled_at`이 없는 전체가 시간과 무관한 사용자 전역 미해결 intent다. 같은 상품·mode·channel은 기존 frozen receipt를 replay/reuse하고, 다른 조합은 기존 intent를 명시적으로 해결할 때까지 `checkout_prior_intent_unresolved`로 차단한다. 버튼 disable과 user rate-limit(10/분)은 보조 방어이며 DB unique index가 최종 방어선이다.
- **수동 지급(settle)**: 페이앱 시절 '콘솔 육안 확인' → **서버가 포트원 단건 조회로 PAID·금액 검증 후에만 지급**(휴먼에러 차단).
- **무지급 PAID 운영 결과**: reconcile에서 quarantine PAID를 발견하면 durable `reconciliation_issues` handoff가 생겨도 자동 대사가 완결된 것은 아니다. 매 실행이 open issue exact count를 권위 있게 읽으며 하나라도 남아 있으면 HTTP `429`/`ok:false`/`Retry-After: 60`과 failure heartbeat를 유지하고, count 오류·손상도 503이다. `late_paid` 이슈는 cancellation ID 유무와 관계없이 ignore할 수 없고, 주문의 전체 크레딧 수량과 전체 결제금액 이상이 실제 환불로 영속된 뒤에만 resolve할 수 있다. 구 acknowledgement-only 구현으로 잘못 닫힌 미환불 이슈는 rollout migration이 감사 detail을 보존한 채 open으로 복구한다. 관리자 stuck 정산 응답은 `requestedCredits`와 `quarantined`를 신규·exact replay·다른 request의 ledger no-op 모두에서 보존한다. `quarantined:false`는 요청량 전부 지급, `quarantined:true`는 잔액 변화 0만 허용하며 UI는 성공으로 닫지 않고 환불 큐 후속을 안내한다. 사용자 결제내역과 관리자 주문 목록/회원 주문 내역을 포함한 모든 order read가 non-null marker를 보존한다. 사용자 화면은 `지급검토`와 요청량을, 관리자 주문 행은 `paid_review`와 `지급 0 · 요청 N`을 표시해 주문 수량을 실제 지급량처럼 표현하지 않는다.
- **failed = 준종단**: 포트원 paymentId 는 성공 전까지 재시도 가능 → failed 마킹 후 같은 paymentId 로 결제가 성공할 수 있음. `mark_paid_and_grant`/`admin_settle_stuck_order` 가 failed 도 허용(PAID 재검증 선행) — 부활 지급으로 '수금됐는데 미지급' 고착 차단. paid/canceled 는 여전히 차단(canceled 는 환불 플로우 소유).
- **부분취소(PARTIAL_CANCELLED)**: 자체 코드는 전액 취소만 사용 — 콘솔 부분취소가 감지되면 자동 종단·화해 금지(전량 회수 위험), `pay.wh_partial_cancelled` 경고 후 운영 수동 판단.
- **레거시(페이앱) 주문**: canceled 20·failed 2건 — 조회·법정 보존만(자동취소 경로 없음, paid 환불 필요 시 '수동 처리' 안내).

## 관리자 / 운영 (admin)

관리자 전용 운영 대시보드 + 결제 대사. 권한은 `member_accounts.is_admin`(service_role 만 쓰기 → 자가부여 불가, 0020). `proxy.ts` 가 `/admin` 로그인 게이트를 제공하고, **모든 admin page는 첫 async 작업으로 `requireAdmin()`을 실행해 실패를 처리한 뒤에만 privileged read**를 시작한다. `/api/admin/*`도 같은 gate로 최종 판정한다. is_admin은 별도·관용 조회라 0020 미적용/비admin이면 안전 차단되고 기존 회원 흐름에는 영향이 없다.

- **멀티 라우트**(공통 `app/admin/layout.tsx` + 각 page의 독립 `requireAdmin` 경계 + `AppNav`+`AdminNav`): `/admin`(대시보드) · `/admin/orders`(전체 주문) · `/admin/refunds`(환불 운영 큐, v0.76) · `/admin/users`(회원) · `/admin/ledger`(처리내역) · `/admin/generations`(캐릭터 생성) · `/admin/moderation`(신고) · `/admin/integrity`(무결성 — 어뷰징 리뷰 큐) · `/admin/events`(이벤트/소식 — 공지·이벤트 작성/발행·홈 팝업·배너 운영, v0.50) · `/admin/reviewers`(PG 심사·테스트 계정, v0.73) · `/admin/content`(콘텐츠) · `/admin/analytics`(게임 분석) · `/admin/acquisition`(공유·유입 — 게임 분석과 격리). layout/page는 병렬 렌더돼도 React `cache`로 같은 render pass의 admin authority read를 공유하며, source inventory test가 모든 page의 gate-first 순서를 고정한다. **회원 표기 = 회원 상세 링크(v0.74)**: 어드민에서 회원(닉네임/이메일/id)을 표기하는 모든 표면은 `/admin/users/[id]` 로 링크한다(관리자 컬럼·집계 화면 제외) — 신규 표면 추가 시 이 규약 준수.
- **`/admin`**(대시보드, RSC `force-dynamic`): 매출·주문(오늘=KST 자정 / 7d·30d rolling, 상태별) · 가입·구매 퍼널(방문→플레이→가입→첫생성→첫구매) · **환불 운영 경고**(미종결 attempt·차단 요청·open 대사 이슈·레거시 미회수) · **오래된 결제요청(확인 필요)**. 환불 실행 큐는 **`/admin/refunds`**, CS 조정·수량환불 개시는 **회원 관리(유저 상세)**. 정확 수치는 DB(`lib/admin-data` + `get_admin_funnel`/`get_admin_order_summary` RPC), Sentry 아님.
- **`/admin/orders`**(전체 주문, RSC): 상태 필터 + 주문ID/거래번호/paymentId 부분검색 + 10건/page. `search_orders` RPC(`order_uuid::text`/`pg_tx_id`/`payment_id` prefix·window `total_count`, `lib/admin-orders.ts`).
- **`/admin/users`**(회원, RSC): 이메일·닉네임 부분검색(`search_members` RPC, ID exact) → 후보 → **유저 상세 `/admin/users/[id]`**: 결제·크레딧(주문 + 조정/환불 이력 + **크레딧 변동 내역(전체)** + **크레딧 로트 현황**·진행 중 환불 요청/이슈) · 콘텐츠(AI 생성내역[상태]·보유 캐릭터) · 회원정보 + 플레이내역 링크, 각 섹션 10/page. **CS 크레딧 조정**·**수량 환불 개시**(RefundButton, v0.76) 통합. `lib/admin-users.ts`.
- **운영 액션**(돈·감사): stuck **포트원 검증 후 지급**(서버가 단건 조회로 PAID·금액 확인 후에만 `admin_settle_stuck_order_verified`, 이어 `get_admin_settlement_receipt` exact postcondition 확인) · 정상결제 **환불**(paid 전용·포트원 자동취소+회수, 부족 시 차단) · **pending 취소**(`/api/admin/cancel` → 포트원 취소 연동, 미결제 pending 은 로컬 표시만; 회수 없음) · CS 크레딧 조정(회원만·−100~100·≠0·사유 5~500). current service_role RPC(`admin_settle_stuck_order_verified`/`admin_cancel_order`[5-arg + 4-arg wrapper, 무중단]/`admin_adjust_credits`)는 **불변 object advisory → `member:<uuid>` user advisory(다중 회원 UUID 정렬) → 기존 row lock → 변경·감사**의 단일 순서를 따른다. superseded `admin_settle_stuck_order_idempotent`는 0095부터 owner-only라 앱이 직접 호출할 수 없다. 수동 정산도 `mark_paid_and_grant`의 결제 종결 core를 재사용하므로 이미 탈퇴했거나 취소 의도가 있는 계정에는 live 크레딧을 되살리지 않고 paid 증빙+만료 quarantine 로트만 남긴다. CS 조정은 브라우저가 요청 UUID를 네트워크 호출 전에 보존하고 DB가 금융 변경과 같은 트랜잭션에 영구 영수증을 기록한다. 같은 대상의 제출·복구는 Web Locks의 non-queued exclusive lock으로 같은 렌더의 double-submit과 여러 탭의 동시 제출을 두 번째 네트워크 호출 전에 차단하며, lock 미지원 환경도 변경을 보내지 않고 fail-closed한다. 복구 요청도 DB의 같은 request advisory lock을 사용하고 관리자·대상 회원·요청 UUID를 모두 영수증과 대조한다. 복구가 POST보다 먼저 도착하면 대상이 결합된 aborted 표식을 남겨 늦은 POST를 거부하므로 응답 유실·재시도·역순 도착·다른 회원 컨텍스트 재생에서도 exactly-once다. 구 4-arg `admin_adjust_credits` 이름은 제거되어 owner 호출도 request receipt를 우회할 수 없다.
- **나머지 관리자 쓰기 exactly-once(0085)**: 설정, 이벤트 저장·상태변경, 신고 dismiss/takedown/restore/**permanent-delete begin**, 무결성 clear/void/ban/unban, 계정 재활성, stuck-order 정산은 exact JSON payload 영수증과 state/version CAS를 사용한다. 영구삭제는 모달 intent의 UUID·사유·hidden version을 최초 전송부터 고정하고 0078 purge job을 영수증에 결합해 응답 유실과 hidden→restore→hidden ABA를 차단한다. 응답 유실 복구가 POST보다 먼저면 late mutation을 tombstone으로 차단하고, event create는 request UUID가 달라도 동일 create intent+payload를 한 행으로 수렴한다. 재활성은 pending 영수증과 1:1 Auth-sync job을 원자 생성하며 route가 중단돼도 `content-maintain`이 exact request/admin/user + action/lease token/version/expiry로 이어받는다. 동일 timestamp 재사용은 단조 증가 탈퇴 세대로 분리하고, GoTrue marker→실 email은 Auth DB trigger가 exact lease와 metadata fence를 검증한 경우만 허용한다. 다른 실제 email은 덮어쓰지 않으며 fresh Auth read 뒤 fenced finish만 DB 계정을 활성화한다. 새로고침 뒤에도 active-admin 전용 pending-read RPC가 exact 취소 correlation을 복구하고, cancel은 기존 lease를 무효화해 exact real→marker 보상 후 `cancelled`로 종결한다. expand 구 route의 DB-first orphan은 permanent legacy repair outbox가 캡처하며 새 탈퇴와 전용 Auth-transition lock으로 직렬화하고, 제3 실제 email은 `0092` drain gate의 visible blocker로 남긴다. 정산은 PortOne 재호출 전에 non-tombstoning 영수증을 확인한다. 전체 계약과 장애 대응은 `docs/admin-mutation-idempotency.md`.
- **오래된 결제요청 대사**: `cron-job.org` → `POST /api/ops/reconcile`(`x-cron-secret`) → 결제 시도 pending 2h+ 를 포트원 단건 조회로 **자동 대사**(PAID→지급·종단 반영, 호출당 20건) → 잔여만 Sentry 경고.

### 콘텐츠 / 설정 콘솔 (`/admin/content` — 마케터 직접 편집)

구현(brian)과 마케팅(여친 어드민 `sayhe`) 역할 분리를 위해, 코드 하드코딩이던 **마케팅·게임 문구·OG·롤 대사·수치·뱃지·가격·세션한도**를 코드 변경 없이 어드민에서 편집한다. **substrate(0025)**: 도메인 key→jsonb `app_settings`(키: `marketing_copy`·`role_content`·`score_config`·`badge_catalog`·`session_limits`·`growth_levers`·`site_content`·`media_config`·`business_info` — 0025·0040·0045·0061) + 전용 감사 `app_settings_audit`(revert 소스).
- **server-only**: `app_settings`/`_audit` 는 anon/authenticated **전부 revoke**(정책 없음) → service_role 만. 주 방어선=`requireAdmin()`+server-only. 공개 런타임은 `GET /api/config/public?domain=gameplay|marketing`(운영필드·inactive·hidden 제거한 **최소 projection**)만.
- **읽기**(`lib/config`): async 서버 getter(value-only) + 진단용 `*WithMeta`(`source: db|default`). **검증 실패/DB불가 → 코드 기본값 폴백 + Sentry, 핫패스 throw 금지**. `unstable_cache`+`revalidateTag(tag,'max')`(SWR)+**1h(3600s) backstop**. 발행은 태그로 즉시 반영 — backstop 은 태그 실패 대비용. (루트 레이아웃이 이 캐시를 읽어 전 페이지 ISR revalidate 가 상속되므로, 60s 면 홈 등이 60초마다 재생성돼 무료 ISR write·Fluid CPU 를 소진 → 3600s. 2026-07-07 실측 근거.)
- **쓰기**: `POST /api/admin/config`(requireAdmin → 도메인 Zod 검증 → **`admin_update_app_setting_idempotent`** RPC: exact-payload 영수증 + key allowlist·version CAS·감사 insert 를 한 트랜잭션·security definer 하드닝). 낙관적 version 충돌=409. revert=같은 RPC 로 old_value 재발행.
- 도메인 에디터는 PR 별로 등록(레지스트리 `lib/config/registry`). 미등록 도메인은 `/admin/content` 에서 "준비 중".
- **`marketing_copy`(PR2)**: 홈·가입/갤러리 배너·캐릭터/점수 **공유 카드**·**공유 미리보기(OG)**(title/desc/웹공유)·게임오버 CTA 문구(`resolveCopy` 로 `{호칭}`+값 토큰 합성). 보고서 제목·인사기록 카드 제목은 **코드 고정(비제어)**. 콘솔 그룹/도식은 실제 화면 순서·용어(`{대상} 공유 카드`/`{대상} 공유 미리보기 (OG)`)와 일치. 클라 소비처가 많아 **루트 레이아웃(server)이 `getMarketingCopy()`로 읽어 `MarketingCopyProvider`(client 컨텍스트)로 1회 주입**(클라 fetch 없음·코드 기본값 폴백). 편집=`/admin/content/marketing_copy`. (정적/ISR 라우트 유지 — `unstable_cache` 1h backstop, 발행 시 태그 즉시 무효화.)
- **`role_content`(PR3)**: 5롤(부장/임원/팀장/거래처/동료) × 시비 멘트·피격 반응·인사기록(특이사항/직급/소속)·호칭. (점수 공유 OG 설명은 v0.31 부터 롤 무관 단일 `marketing_copy.scoreOgDesc` 로 이관.) **점수 10단계는 코드 고정**(`score_config`), 마케터는 칸 안 문구만(Zod `length(10)`·tier당 ≥1). `lib/config/domains/roles.ts`(순수, lib/roles 와 무순환) + `roleFrom(role, cfg?)`(미지정 시 코드 기본값 폴백). 서버 OG/doll=`getRoleConfig()`, 클라 시비멘트/반응=`RoleContentProvider`(라이브, 스냅샷 아님). 편집=`/admin/content/role_content`(5롤 탭). 공개 API 미노출(서버/프로바이더 전용). **호칭 라벨 단일 소스 = DB 발행 config(`roleFrom`), 정적 `ROLE_META` 는 fallback** — 갤러리 칩·역할선택·역할변경 토스트·히스토리·어드민 유저표(서버 cfg prop)까지 `roleFrom` 으로 일원화(마케터 호칭 변경이 전 화면 반영). **용어: 어드민='롤', 클라 노출='역할'**('대상' 폐기, 생성물='캐릭터').
- **`score_config`(PR4)**: 점수 10단계 등급 라벨/한 줄 평(=&apos;패기 유형&apos;). **tier 매핑·간격(step)은 코드 고정**, 라벨 텍스트만 라이브 편집(Zod `length(10)`). `gradeFor(score, grades?)` + `ScoreConfigProvider`(클라)/`getScoreConfig()`(서버 share·history). 편집=`/admin/content/score_config`. step 조절·과거결과 동결은 후속.
- **`session_limits`(PR5)**: 강제 종료 한도(최대 플레이 초·최대 점수). Zod 상한=제출 clamp 상수(`MAX_DURATION_MS`/`MAX_SCORE_HARD`), 기본값=hard cap(사실상 무제한 → 마케터가 낮춰야 동작). 게임 시작 시 `SessionLimitsProvider` 값을 ref 로 **동결**, 0.5s 폴링 → 한도 도달 시 배너→`FORCE_END_GRACE_MS`(4s, 궁극기 마무리)→**1회 종료**(one-shot guard·grace 타이머 정리). `scores.end_reason`(0026) 기록. 편집=`/admin/content/session_limits`.
- **`growth_levers`(PR6, 머니 패스)**: 가입 기념 생성권(0~50, 신규 가입 1회 멱등) + 충전 상품(productId 불변·price 1,000~100,000원·credits·`active`). **체크아웃은 서버에서 active 상품 재조회로 price/credits 결정**(클라 조작·비활성 차단), 기존 주문은 amount/credits 스냅샷이라 무관. `/credits` 표시는 `CreditProductsProvider`(active만). 가입 grant=`getGrowthLevers().signupBonusCredits`(callback `ignoreDuplicates` 멱등). 편집=`/admin/content/growth_levers`(발행 확인·productId 중복 거부). 공개 API 미노출. **결제 노출 on/off**(`creditsEnabled`, 기본 OFF·optional 이라 기존 발행값 무손상)+**준비중 안내**(`comingSoon{title,body}`): OFF 면 `/credits` 가 준비중 화면으로 바뀌고 체크아웃도 서버에서 `payment_unavailable` 차단(가입 보너스·기존 생성권 사용은 무관). `creditsConfig()`→`CreditProductsProvider`(=`useCreditsConfig`)로 클라 주입.
- **`badge_catalog`(PR7)**: 카테고리(7종 고정) 이름·이모지 + 뱃지 임계값·개수·라벨·`active`. **달성값 계산은 코드**(`FAMILY_VALUE` familyKey→fn), slug **불변 동결**(threshold 파싱 중단)→임계값 바꿔도 `user_badges` 고아 없음. 인증 grant(`/api/score`)=`getBadgeCatalog`→`evaluateBadges`(active만), 컬렉션/챌린지/strip=카탈로그 주입(`BadgeCatalogProvider`/prop). 삭제=`active=false`(획득 보존, 하드삭제 없음). `lib/badges.ts`→`lib/config/domains/badges.ts` 단일 소스. 편집=`/admin/content/badge_catalog`.
- **`media_config`(미디어 자산, v0.53)**: 기본 OG 공유 이미지·서비스 로고를 `/admin/content/media_config` 에서 업로드 관리. **저장은 path 만**(`{ogImagePath, logoPath}`, URL 금지) — 소비 URL 은 `lib/site-assets`(server-only)가 변환(render) 사양으로 파생(OG 1200×630 cover·로고 640² contain·미리보기 작은 transform). 업로드=`/api/admin/site-asset`(2-step signed, 슬롯 prefix `og/`·`logo/`, jpeg/png/webp·≤5MB·SVG/GIF 거부, confirm 응답은 **previewUrl 만**=raw object URL 미노출). 소비처는 항상 transform render URL(고용량 원본도 리사이즈만 로드). 발행 시 도메인 tag + `revalidatePath('/','layout')·'/'·'/login'`(layout metadata·로고 즉시 반영). 자산 버킷 `site-assets`(public)는 **배포 전 대시보드/Management API 로 수동 생성**(events 버킷과 동일, SQL 마이그 아님). 모든 업로드는 DB intent를 먼저 만들고 미attach 객체는 2시간5분 뒤 fenced cleanup이 회수한다. 현재 발행 config가 참조하는 자산은 롤백·감사를 위해 자동 detach하지 않는다.
  - **OG/미디어 통제 맵**: 기본 OG = `media_config`(미설정 시 정적 `public/og-default.png`) · 이벤트 상세 OG = 이벤트 커버(`/news/[id]`) · 캐릭터/공유 OG = 코드 생성(Satori, `/doll/[id]`·`/share/[scoreId]/opengraph-image`) · 로고 = `media_config`(미설정 시 `/logo.png`) · **파비콘 = 정적(어드민 미관리)**. OG 우선순위는 `resolveOgImages()` 단일 함수(이벤트 cover > media_config > default), openGraph·twitter 동일. **파일-기반 `app/opengraph-image` 제거**(`generateMetadata` images 와 충돌 방지) → metadata 에 명시.
- **`business_info`(사업자 정보, v0.74·0061)**: 전역 푸터(`SiteFooter`)에 상시 노출되는 사업자정보(PG 심사 요건)의 단일 소스 — `{info?: {상호·대표·사업자번호·통신판매업(빈값 허용)·주소·유선전화·이메일}}`, 미설정(`{}`)이면 푸터 비노출. site_content(소개·FAQ)에서 분리해 발행단위(CAS)·변경이력 독립(1도메인=1카드=1발행단위 관례). 발행 시 도메인 tag + `revalidatePath('/','layout')·'/'·'/login'`(media_config 와 동일 — layout 렌더에 박히는 값이라 tag 만으론 ISR 페이지 반영 지연). 편집=`/admin/content/business_info`.
- **법무 문서(이용약관·개인정보처리방침, v0.33)**: config 도메인이 **아닌 전용 테이블**(`legal_documents`, 0029) — 버전·시행일·예약 발행·과거본 공개가 필요해 분리. 섹션 배열(제목+본문) plain text. 편집=`/admin/content/legal`, 공개=`/terms`·`/privacy`(`lib/legal` 서버 getter가 service_role 로 발행본만 투영). 상세는 진행 상황 v0.33.

## 모니터링 (Sentry)

에러/경고 알림 + **구조화 로그(Logs)** + **트레이싱(성능)** + **인앱 의견 위젯**을 기본 제공하고, **세션 리플레이는 별도 운영 opt-in**으로만 켠다. 리플레이를 활성화하는 경우 게임 데이터(캐릭터/플레이/랭킹/닉네임/userKey)는 화면에 보일 수 있고, **업로드 원본 얼굴 영역은 마스킹**한다(정책 #1/PIPA).

- **로그 브릿지**(`lib/sentry-bridge.ts`, `emit()` 한 곳): `log.error/warn` → `captureMessage`(event 명 fingerprint 그룹핑 → 이벤트당 1 이슈) **+ `Sentry.logger`(Explore→Logs 검색)**, `log.info` → `Sentry.logger.info`+breadcrumb. 초고빈도 `gen.recover_list` 는 Logs 제외(볼륨). `enableLogs: true`.
- **게임 액션 로그**(`app/play/page.tsx`): `game.start`(dollId/weapon/bg)·`game.end`(score/maxCombo/hitCount/weaponCounts/mainWeapon/durationMs)·`game.weapon_switch`·`game.bg_switch`·`game.ultimate_fire` → Logs/Discover 에서 무기·점수대·플레이타임 분석. 고빈도 `hit` 은 per-hit 로그 안 함(`game.end` 요약으로 충분).
- **전역 신원/컨텍스트**(`lib/sentry-context.ts`): `setSentryIdentity(userKey, 닉네임, email?)` → `Sentry.setUser`(모든 event/replay/log·**의견 위젯**에 자동 부착, `SessionBootstrap`; email 은 멤버만 — `session.user.email`, 익명 제외, 로그아웃 시 `clearSentryIdentity`로 clear); `setSentryGameContext({dollId,weapon,bg,gamePhase})` → `setTag`(weapon/bg/doll_type/game_phase)+`setContext("game_session")` → 태그로 끊어 보기. 55개 로그 site 안 건드리고 정보 극대화.
- **트레이싱**(production 한정 — dev/preview 는 0 으로 게이트해 대시보드 오염·span 한도 소모 방지): server `tracesSampler` 라우트별 차등(`/api/fal`·`/api/doll`=1.0, `/api/score`=0.5, **`/api/generations`=0.05**(폴링), 기본 0.1), client 0.1(Web Vitals 자동). 생성 파이프라인 커스텀 스팬(`gen.prepare_input`/`face_upload`/`detect_glasses`/`fal_submit`, `gen.fal_status`/`fal_result`/`copy_candidates`, `doll.bg_removal`/`normalize`) + 점수 제출 스팬(`score.submit`, score/maxCombo/weapon/durationMs/dollId attr). fal/Supabase 는 fetch 자동계측 `http.client` 스팬(`tracePropagationTargets` 는 자기 도메인만). release health(crash-free)는 release(SHA)+autoSessionTracking 자동.
- **세션 리플레이**(`instrumentation-client.ts`, **기본 비활성·exact opt-in**): `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=1`과 `production`이 동시에 성립할 때만 Replay 통합 자체를 설치한다. 미설정·`0`·`true`·공백 포함 값과 dev/preview는 sampling 0이며 통합도 생략한다. 활성화 시 에러 세션 100%(`replaysOnErrorSampleRate`) + 일반 10%(`replaysSessionSampleRate`). DOM-only(PixiJS 캔버스 녹화 미사용 = 모바일 perf). 일반 화면 텍스트·미디어·입력은 기본 언마스크이고, **`.sentry-block-face`(`/generate` 업로드 미리보기·`PhotoCropper` 크롭 컨테이너)만 `block`+`mask`** → 원본 얼굴 replay 미포함(크롭 컨테이너 차단이 내부 `<img>`까지 마스킹 — react-easy-crop 은 portal 미사용).
- **인앱 의견 위젯**(`feedbackAsyncIntegration`, `#sentry-feedback`): 버그·건의 자유 제보. **async = 모달/스크린샷 코드는 클릭 시 CDN 지연로드**(초기 번들 경량 — 모바일 PWA). 스크린샷 OFF(얼굴/캔버스 캡처 방지). 이름/이메일 입력칸은 숨기되(`showName/showEmail:false`) **로그인 유저의 닉네임·이메일을 `useSentryUser` 로 숨김 컨텍스트 첨부** → 누가 보낸 피드백인지 식별(익명은 닉네임만, email 없음). 폼에 개인정보 안내 문구 고지. `/play` 몰입화면(`.game-surface`)에선 무기바와 겹쳐 `globals.css` `:has()` 로 숨김, 그 외(홈/갤러리/랭킹) 노출.
- **자동 포착**: 서버/RSC/Route 미처리 에러(`instrumentation.ts` `onRequestError`), 클라 미처리 에러(`instrumentation-client.ts`), 루트 렌더 에러(`app/global-error.tsx`).
- **PII**: `sendDefaultPii: false`(IP·헤더·쿠키 미수집) + `beforeSend` 로 URL 쿼리스트링(서명 토큰) 제거. ctx 는 이미 `scrubSecrets`/`urlHost` 적용. 식별자는 익명 UUID(`userId`)+게임 닉네임(실명 아님), **멤버는 피드백 식별·연락용 email 추가**(`setUser`; 로그아웃 시 `setUser(null)` clear, 클라 프로필/캐시엔 미노출). **업로드 원본 얼굴은 Replay 에서 마스킹**(`.sentry-block-face`) — AI 생성 후보·플레이 화면은 비민감이라 미마스킹.
- **설정**: Sentry 프로젝트 생성 → `NEXT_PUBLIC_SENTRY_DSN`(+선택 `SENTRY_*`)을 `.env.local`/Vercel 에 추가. DSN 없으면 init 안 함 → no-op. Replay는 정책·고지 정합을 확인한 뒤에만 `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=1`로 별도 활성화한다. 광고차단 우회용 터널 `/monitoring`(proxy matcher 에서 제외).
- **구성된 모니터링**(Sentry org `ja-inc`, production 한정 — API 로 설정, UI 에서 조정 가능):
  - 이슈 알림: `새 에러/경고 발생·재발`, `에러 급증 1h 20+`, **`생성 실패 급증`**(`event:gen.submit_fail`/`gen.fal_timeout` 1h 5+).
  - 메트릭 알림(span dataset `events_analytics_platform`, Sentry 가 transaction→span 마이그레이션 중): **`생성 제출 지연 p95`**(`/api/fal` warn 8s·crit 12s), **`점수 제출 실패율`**(`/api/score` crit 20%).
  - **Uptime**: `boss-paegi.vercel.app` 5분 간격(무료 1개 한도) → 다운 시 이메일.
  - **Dashboard `boss-paegi 운영 개요`**: 에러 추이·event 태그별 Top·생성 p95·Web Vitals(p75)·점수 제출·무기 분포.
  - 추가 권장(미설정): `falbal.hard_cap_hit`·`auth.anon_sign_in_fail`·`gen.done_update_fail` 즉시 알림은 필요 시 UI 에서.

## 게임플레이 텔레메트리 (수집)

무기/맵/콤보·궁극/입력·이탈 등 게임플레이 패턴을 **세션당 1행 jsonb**로 수집 — Sentry breadcrumb(쿼리 불가)와 별개의 **조회 가능한** 분석 데이터. 무료플랜 안전(행 폭발 없음). 신뢰=분석 등급(점수 보상 권위 아님).

- **캡처**(`lib/telemetry/`, `app/play/useTelemetry.ts`): 핵심 이벤트(무기/맵 `select_attempt`·`switch`·궁극·종료) 즉시 + 타격은 5초 버킷 집계(render loop 밖, 60fps 보호 — 부하 시 드롭). 10초 flush(`fetch keepalive`) + 이탈 시 `navigator.sendBeacon`. delta-only(미전송분만).
- **수신**(`app/api/telemetry`): **공개 라우트**(익명 포착 — `requireMember` 안 씀). `Content-Length` 선검사 + 실제 UTF-8 64KB stream cap → parse → deep validation(PostgreSQL int `seq`·ISO 시간/서버 시간창·순서·key allowlist·clamp·이벤트 cap) → member 판별(`member_accounts` 기준, 서버 결정) → DB-authoritative `ingest_telemetry_delta` RPC(원자: global/opaque actor/new-session quota+budget+row lock·seq 멱등·clamp). 회원=풀 timeline, **비회원/익명=요약만(timeline null)**. Auth/profile/member 조회의 throw와 resolved `{ error }`, profile no-row는 503 fail-closed이며 탈퇴 계정은 403으로 ingest 전에 거부한다. 장애를 익명으로 강등해 owner-less session을 만드는 `owner_mismatch` 고착을 방지한다. 권위 DB가 확정한 hard quota/budget/ownership drop만 terminal `200` ACK다. RPC throw/resolved error·손상 응답·secret 부재·`quota_busy`는 `503 + Retry-After: 1`로 sequence를 ACK하지 않으며 클라이언트가 delta를 보존해 bounded retry한다. 입력 상세는 [`docs/telemetry-input-validation.md`](docs/telemetry-input-validation.md), quota·동시성·보존 계약은 [`docs/public-write-quotas.md`](docs/public-write-quotas.md).
- **저장**(`supabase/migrations/0027_play_telemetry.sql`): `telemetry_sessions`(세션 1행) · `telemetry_rollups`(대시보드 사전집계) · `telemetry_budget`(운영 degrade 상태). `scores.telemetry_session_id`(점수↔세션 링크, 부분 unique·additive — `/api/score` 가 UUID 검증 후 저장, 중복 제출은 본인 score면 graceful 반환·타인이면 409). 전부 **server-only**(anon/authenticated revoke + service_role grant), 쓰기는 ingest RPC(security definer)로만.
- **용량 가드**: 30MB 운영 target budget(Supabase 500MB 한계 아님). **env kill-switch·자동 샘플링 없음** → budget DB row 기준 자동 degrade(full/summary/off).
- **유지보수**(`app/api/ops/telemetry-maintain`, `x-cron-secret`=`CRON_SECRET`, cron-job.org **KST 09:00 일 1회 등록·활성 확인**): 독립 privacy 단계 `prune_public_write_quota_buckets(80000)`을 필수 1회, backlog가 있으면 최대 2회 실행한다(10초 부분예산, quota bucket 72,505 + score/report attempt 5,500 = 하루 exact 최악 78,005행보다 큰 필수 80,000행, 호출당 최대 160,000행 capacity). 이후 quota 실패/잔여와 무관하게 `telemetry_rollup_days(3)` → 성공 시 `telemetry_prune()` → `telemetry_budget_refresh()`를 실행한다. 롤업 RPC의 수동 복구 범위는 **1..31 KST 날짜**(오늘+raw 30일)이며 NULL·0·음수·32 이상은 advisory lock/date 연산/DML 전에 SQLSTATE `22023`으로 fail-closed한다. 전체 route는 공통 20초 monotonic deadline, 25초 platform ceiling, 외부 scheduler 90초 timeout을 쓴다. quota error=500, quota backlog=503, budget이 `summary/off`로 남음=429이며 모두 non-green/재시도 가능하다. (공유·유입 analytics 롤업은 **별도 cron** `/api/ops/analytics-maintain` — 도메인 격리.)
- **대시보드**(`/admin/analytics`, AdminNav '게임 분석' 탭): **무기 편중·다양성**(단일무기율·메인무기분포·tap카테고리·세션평균집중도) · **무기 효율·파워**(메인무기 점수/초 중앙값, 단일무기 세션 우선) · **맵 고착·전환**(단일맵율·시작맵분포·전환율) — 이 셋은 `telemetry_sessions` 윈도우 직접 집계(세션 단위 facts). + 무기·맵 밸런스(타격·점수 비중·갭 — 빈도 교란되는 "점/타" 폐기) · 펀널·이탈 · 회원 활동(코호트·재방문 — 익명 ephemeral) · 세션 인스펙터(`/admin/analytics/sessions/[id]` 타임라인 재생). 밸런스/펀널은 `telemetry_rollups` 윈도우 합산(7/30일), 세션단위 지표는 sessions 직접(limit 5,000·표본 메타 동봉). 차트 라이브러리 없이 CSS 바. `lib/admin-analytics.ts`.
  - **지표 정의**: `동시터치`=세션 중 관측된 최대 active pointer 수(터치/마우스/펜 공통). `단일무기율`/`단일맵율`=한 세션에서 무기/맵 1개만 쓴 비율. `메인무기`=세션 내 hits 최다(동률 시 score→고정순서). `메인무기 점수/초`=세션 score/sec를 메인무기로 그룹핑한 중앙값(근사 — 콤보·맵·숙련도 혼재, 정확한 무기 DPS 아님; 완료·유효 duration 세션). `세션 평균 집중도`=세션별 무기 hit-share Herfindahl(Σshare²) 평균. 밸런스 `gap`=점수비중−타격비중(빈도 대비 점수 기여 불균형 신호, 확정 아님). `dpr`/`refresh_hz`/`avg_frame_ms`/`p95_frame_ms`=렉 진단(게임 ticker 프레임타임 표본·종료 시 저장, SQL 쿼리 가능). 렌더 최적화로 `BossPaegiGame` `app.init` **DPR 캡(≤2, 고DPI fill-rate 완화)**.
- **프라이버시**: 익명 id = 세션 한정 ephemeral(`crypto.randomUUID`, 쿠키 지속·재방문 추적 없음), telemetry payload는 PII 미수집, coarse `device_class`만(핑거프린팅 아님). 공개 쓰기 abuse-control은 DB에서 durable 회원임을 확인한 telemetry/conversion만 Auth UUID를 쓰고, 익명 Auth·동의 전·`/api/track`·score·report·signed URL은 Vercel edge IP 기반 network actor를 쓴다. 원본은 저장/로그하지 않고 service secret HMAC으로 바꿔 quota table에 current+직전 2개 KST 날짜를 보존한다. 이 HMAC은 `analytics_events`의 무식별 불변식과 분리된 pseudonymous security identifier다. 이 항목과 자체 유입 분석 고지는 법무 v2 정본(`legal/v2-documents.mjs`)에 반영됐지만, v2의 30일 사전고지·발행 전에는 `NEXT_PUBLIC_ANALYTICS_ENABLED`를 비워 실제 수집을 계속 비활성화한다. Vercel이 forwarded IP를 overwrite하는 근거는 [공식 request-header 문서](https://vercel.com/docs/headers/request-headers)에 고정한다.

## 공유·유입 분석 (격리 도메인)

공유(누가·어디서·얼마나)와 유입 경로(referrer/UTM/바이럴)를 **무식별 집계**로 어드민에 노출. 텔레메트리·계정·결제 도메인과 **완전 격리** — 신규 `analytics_*` 테이블만, 기존 테이블 무변경. 전환은 컬럼 스탬프가 아니라 conversion 이벤트로 적재.

- **저장**(`supabase/migrations/0049_analytics.sql`): `analytics_events`(raw·append-only·service_role only·RLS) + `analytics_rollups`(일별 사전집계·metric allowlist CHECK·dim NOT NULL `''`). **식별자/원본 URL/query/IP/UA/props 무저장** — 도메인·UTM·차원만. `day_kst`=BEFORE INSERT 트리거(KST; generated column 은 `at time zone` STABLE 이라 immutable 위반). kind별·source_kind 정합성 CHECK 가 API 외 DB 마지막 방어선.
- **수집**(`app/api/track`, **공개**·anon 허용·requireAdmin/Member 아님): 성공/드롭 모두 **204 + `Cache-Control: no-store`**, zod allowlist + 정규화(UTM/referrer lowercase·trim·≤64·`@`/`%40`/query-like → null → fallthrough). **member_state = Supabase auth session 기준**(member_accounts 조회 안 함 — 도메인 격리·법적 회원/동의완료와 동일하지 않을 수 있음). raw event insert는 HMAC actor별 200/일·global 2,000/일 quota 승인과 한 DB transaction이며 quota actor는 event row에 저장하지 않는다. 클라 `lib/acquisition.ts`(순수 로직 `lib/analytics/core.ts` 공유, 서버 적재 `lib/analytics/server.ts` best-effort). 상세는 [`docs/public-write-quotas.md`](docs/public-write-quotas.md).
- **source 분리**: `current`(현재 진입·매 탭세션 1회) vs `first_touch`(획득·localStorage 90일 TTL·sticky). 우선순위 `utm_source` → `/share/*` viral(score) → `/doll/*` viral(doll) → 외부 referrer 도메인 → direct. **viral 판정은 referrer 아닌 현재 landing pathname**(공유 수신자 referrer 는 카카오/인스타/빈값이라 부정확). 무효/PII source 는 direct fallback(이벤트 drop 안 함).
- **공유**(`runShare` 진입 4곳): `share_attempt`(클릭 의도) — GameOverModal(game_over·**결과화면당 1회**)·ShareReportButton(history)·HighlightPlayer(highlight_viewer)·DollCard(gallery). 비-게임오버 3초 디바운스. success/cancel 미집계(MVP — "공유 시도").
- **전환**(conversion 이벤트, 항상 source_scope=`first_touch`): `/api/score` 첫 점수 성공 시 `conversion:play`(클라 `playConversionSent` 1회 게이트) · consent 신규회원(`isNew`) 시 `conversion:signup`. 둘 다 **best-effort**(insert 실패가 점수저장/회원가입 무영향). 클라가 source 동봉할 때만 적재(분석 off 면 미적재).
- **유지보수**: **별도 cron `/api/ops/analytics-maintain`**(`x-cron-secret`=`CRON_SECRET`, cron-job.org **KST 09:00 일 1회 등록·활성 확인** — 텔레메트리와 별도 잡) — `maintain_analytics_rollups(7)`(idempotent: 대상일 delete-재계산 + `pg_advisory_xact_lock`; `score_submit`/`play_session` 은 `scores` 읽기집계) → 성공 시 `prune_analytics_events(90)`(당일 제외). 수동 롤업은 **1..91 날짜**(오늘+raw 90일), raw 보존 인자는 개인정보 정책 안의 **1..90일**만 허용하며 NULL·0·음수·상한 초과는 lock/date 연산/DML 전에 SQLSTATE `22023`으로 거부한다.
- **대시보드**(**별도 탭 `/admin/acquisition` "공유·유입"** — 게임 분석과 성격이 달라 분리, `lib/admin-acquisition.ts`·`analytics_rollups` 윈도우 합산 7/30일): **공유** = 게임오버 전환 퍼널(점수제출→공유 시도·무식별 근사) + 표면/대상/점수대/회원여부 분포. **유입** = 방문 현황(current) + source별 방문→플레이→가입 전환(first-touch) + 바이럴 루프(공유 N → viral 유입 M, 윈도우 근사·causal 아님). source top-N+기타, score_tier→`score_config` 라벨 매핑. metric별 dim 의미는 0049 마이그 주석·getter 와 일치.
- **프라이버시**: `analytics_events`는 무식별·집계·무PII·persistent visitor id 없음. 별도 abuse-control quota의 3일 목표 HMAC actor는 analytics row·rollup에 결합하지 않는다. 봇은 클라 JS 캡처라 자연 필터. 집계형 유입/이용 분석(referrer 도메인·UTM)과 단기 abuse-control identifier는 법무 v2 정본에 조건부 수집·보존으로 명시되어 있다. v2가 원자 발행되고 운영 opt-in을 별도 검증하기 전까지 자체 분석은 비활성이다.

## 점수 어뷰징 방지 (Anti-Abuse)

오토클리커/직접 API 제출로 만든 조작 점수가 공개면(리더보드·백분위·공유·OG·히스토리)에 노출되는 것을 차단. 설계 전체: `docs/anti-abuse-design.md`. (다단계 롤아웃 — 이 항목은 **PR1: 가시성 토대**.)

- **가시성 SoT**(`supabase/migrations/0050_anti_abuse.sql`): `scores.review_status`(`registered`|`pending`|`cleared`|`voided`) 가 공개 노출의 단일 기준. 공개면은 `registered`·`cleared` 만 노출(`lib/score-visibility.ts` `isVisibleReviewStatus`/`SCORE_VISIBLE_STATUSES`). `get_leaderboard`·`get_score_percentile` RPC 에 `review_status in ('registered','cleared')` 필터, `lib/score-detail.ts`(공유/OG/history 상세, 기본 hidden 차단·`includeHidden` 옵트인)·공개 히스토리 목록에도 적용.
- **리뷰/감사 테이블**(server-only, anon/auth revoke): `score_flags`(score_id PK·signals·evidence·abuse_score·rules_version·status, `set_updated_at_and_version` 트리거) + 전용 `integrity_actions_ledger`(score/member 조치 감사, meta 는 allowlist·PII 금지). `member_accounts.abuse_status`(`clean`|`flagged`|`banned`). `telemetry_sessions.interval_cv`(타격간격 CV, PR6).
- **서버 판정·fail-closed 제출**(`lib/anti-abuse-rules.ts`, `supabase/migrations/0051`·`0074`): `/api/score` 가 protocol 검증 → 신호 판정 → **원자 RPC `submit_score_with_review`**(scores+score_flags 한 트랜잭션, service-role only, integrity 실패 시 롤백=조작 점수가 registered 로 안 샘) → visible 점수만 `commit_score_report`로 stats+뱃지를 한 트랜잭션에 확정한다. 제출 신호(버전 `2026-07-anti-abuse-v6`, 임계는 튜닝 상수 파생): **S1** 지속 타격속도(>18/s@60s+·>25/s), **S2** 모든 1타 이상 무기에 fresh(300) 차감 avg/hit>실효 이론상한×1.05(실효 max base 는 swipe ×2.0·throw ×2.2·grab fling strength+30, 고정무기는 strength), **S3** score/초>1400, **S4** stats 누락/엄격 산술검증 실패, **S5** 등간격 CV, **S6** notable(≥30만) 무텔레메트리, **S7** duration>15분 AND score>126만, **S8** 연결 텔레 `suspicious`, **S10** 실제 게이지식으로 가능한 궁극 횟수·점수 상한 위반. 하나라도 발화→`pending`, banned 유저→`voided`.
- **정확 멱등·권한 경계**(`supabase/migrations/0074_score_submission_integrity.sql`, `008900_public_write_quotas.sql`, `docs/score-submission-integrity.md`): 판마다 RFC 4122 `submissionId` 하나를 만들고 모든 HTTP 재시도에서 재사용한다. immutable origin-owner namespace의 DB unique key와 canonical score/gameplay SHA-256 fingerprint가 텔레메트리 유무와 무관하게 같은 판을 1행으로 수렴시키며, 같은 key로 stats/core를 바꾸면 충돌한다. 익명→회원 이전 직전 응답유실도 durable 이전 영수증과 이미 이동된 score가 일치할 때만 target 세션에서 복구한다. 새 intent는 별도 reservation RPC에서 DB global 5,000/network 300/owner 100 KST 일일 quota와 opaque operation row를 먼저 커밋한다. core가 protocol·소유권·lifecycle 검증에서 거절한 결과도 terminal failure로 캐시되어 정확한 재시도는 quota/core를 다시 소비하지 않으며, exact 성공 receipt replay도 cap 이후 quota-free다. 일시적 lock busy는 reservation을 유지해 복구 가능하다. `commit_score_report`와 telemetry core는 canonical user lifecycle lock을 profile 조회보다 먼저 잡고, `score_stats`·`user_badges`·회원 telemetry trigger가 탈퇴 후 child write를 최종 차단한다. `scores`·report 테이블의 Data API 직접 쓰기는 제거하고 전용 SECURITY DEFINER RPC만 쓴다. 텔레메트리는 raw 익명 Auth ID 대신 session-local binding으로 exact owner를 검증한다.
- **제출 UX**(`components/ScoreReport`·`GameOverModal`·`useScoreSubmission`·`marketing_copy`): 일시 실패는 같은 `submissionId`로 1·2·4초 bounded retry하고, 소진 뒤 “다시 시도”로 수동 재개한다. flagged(pending/voided) 점수는 종료화면에 "⏳ 랭킹 검토 중" 안내 + 정지 경고를 표시하고 공유 버튼·뱃지·페르소나는 숨긴다.
- **어드민 무결성 탭**(`/admin/integrity`, `lib/admin-integrity.ts`, `supabase/migrations/0052`): 리뷰 큐(최신 제출순 — 표시 날짜와 동일 키·`id` tiebreaker, 위험도는 칩 표시·상태필터) + 상세(점수/텔레 종합지표·발화신호·evidence·**버킷 apm 스파크라인**[봇=천장 직선/인간=들쭉날쭉, 인간 상한 참조선]·유저 다른 점수). 조치 RPC(security definer·is_admin 재검·advisory lock·`integrity_actions_ledger` 감사): `admin_clear_score`(→cleared)·`admin_void_score`(→voided+뱃지회수)·`admin_ban_member`(banned+전점수 voided+뱃지회수)·`admin_unban_member`(status만, 점수 자동복구 안 함). UI 는 어드민 공통 관습 준수(카드리스트·`ui-surface`·테마토큰, 신고 탭 미러): 조치는 `ModalShell`+사유+**패널티 설명**, `?ownerId=` 유저 필터, 상세→회원 상세(`/admin/users/[id]`) 링크, 회원 상세·무결성 상세 양쪽에 정지(`abuse_status=banned`) 배지. AdminNav 는 가로 드래그 스크롤(스크롤바 숨김).
- **cron 백스톱**(`/api/ops/integrity-scan`, `supabase/migrations/0053`·`0054`·`0055`): 텔레메트리는 delta 스트리밍이라 제출시점 미확정 가능 → 최근(6h) `registered` 점수를 **확정 텔레메트리**와 대조해 사후 flag. 신호 **C1**(score, one-sided — 제출>텔레 20%+)·**C1B**(duration 20%+ 불일치, 대칭)·**C2**(세션 apm>1200 & ≥60s)·**C8**(연결 텔레 `suspicious`). **C1/C1B 정합 검사는 `tscore>0` 그리고 완주 텔레(`end_reason ∈ normal/time_limit/score_limit`)일 때만**(0054): 빈/abandoned/**hidden_timeout 절단** 텔레는 duration·score가 부분값이라 정상 점수를 오탐. C1은 추가로 **one-sided**(0055): 제출 점수는 클램프(min(raw,초×2000))·텔레는 raw라 완주 텔레에선 tscore≥제출이 항상 성립 → "제출>텔레"(위조) 방향만 flag(예 `5c5e6435` raw 171K→ceiling 130K 32% 오탐 제거). `registered→pending` 만, idempotent(score_flags PK). `x-cron-secret`. 2026-07-30 운영 inventory에서 cron-job.org 등록·활성이 확인됐다.
- **타격 간격 jitter(S5)**(`store/gameStore` `selectIntervalCV`·`lib/anti-abuse-rules`): 봇/매크로는 거의 등간격(CV≈0)이라, charge 타격 간격의 변동계수(CV=σ/μ)를 gameStore 러닝통계로 산출→`gameplayStats.intervalCV`→제출 시 S5(hitCount≥100 & CV<`INTERVAL_CV_MIN`) flag. `interval_cv` 는 어드민 지표용으로 텔레메트리에 persist. **⚠ 클라 CV 계측 실플레이 미보정 → 임계 보수적 0.08(확실한 봇)로 시작, 어드민 분포 확인 후 상향 검토**(C3 cron 은 S5 와 동일소스라 생략).
- 기존 오토클리커 조작 3건은 `voided`(전수조사 2026-07-02).
- **S2 임계 교정 v2**(2026-07-03, `ANTI_ABUSE_RULES_VERSION=2026-07-anti-abuse-v2`): v1 산식(strength×8×1.15, fresh 미차감)이 속도 배율 경로를 미반영해 정상 손 플레이 오탐 2건(grab 247.8·214.9/타 > 184) → **실효 max base 유도**(속도 배율 상한 상수를 `lib/weapons.ts` 로 이관, PlayScene 이 import → 튜닝-임계 자동 동기) + **fresh 300 정확 차감** + margin 1.05. 검증: 클린 v2 535튜플 전수 FP 0(구 산식은 19건 충돌), 임계>per-hit 정수 하드 상한이라 구조적 오탐 불가, 위조 봉투는 S3 바인딩이라 불변(고정무기 4종은 임계 8.7% 강화). 분포 모니터링 쿼리·S2b 백로그는 `docs/anti-abuse-design.md` §12.
- **cron C1/C1B 교정 v3**(2026-07-08, `ANTI_ABUSE_RULES_VERSION=2026-07-anti-abuse-v3`, `supabase/migrations/0054`): cron 정합 검사가 절단 텔레(`hidden_timeout` 등)의 부분 duration/score를 완주값처럼 비교해 정상 유저 오탐(사례 score `c80b30b6`: 게임 벽시계 257s vs 텔레 절단 129s → C1B 99% 불일치, 점수는 10%만 차이=같은 게임). → C1/C1B에 **완주 게이트**(`end_reason ∈ normal/time_limit/score_limit`) 추가. 전수조사: 완주 텔레 184건 C1B 발화 0·hidden_timeout 발화 100%가 절단 아티팩트(진짜 의심방향 0건)라 회귀 0. 함께 `anti-abuse-rules.ts` CRITICAL set의 dead entry(`S7_DURATION_MISMATCH` — 발화 id는 `S7_DURATION_LONG`) 제거(S7은 magnitude-only weight 1, mismatch-critical은 C1B가 ×3로 담당).
- **cron C1 one-sided + 봉투 계층 명문화 v4**(2026-07-08, `ANTI_ABUSE_RULES_VERSION=2026-07-anti-abuse-v4`, `supabase/migrations/0055`): C1(점수 정합)이 대칭 `|score−tscore|`이라 **클램프 아티팩트를 오탐**(제출 점수는 min(raw,초×2000)로 클램프되고 텔레는 raw 저장 → 완주 텔레에선 tscore≥제출이 항상 성립. 예 `5c5e6435`: 65s raw 171,354→ceiling 130,132, 32% 불일치인데 admin cleared=정상) → **one-sided**(제출>텔레 방향만, 원점수 초과=위조). 34배 위조(제출≫텔레)는 계속 포착. C1B(duration)는 클램프가 없어 대칭 유지. 함께 봉투 계층 **불변식 명문화**(교차참조 주석): `MAX_AVG_SCORE_PER_SEC`(2000, 저장 하드상한) ≥ `SCORE_PER_SEC_MAX`(1400, S3 의심 플래그) ≥ 인간 max(1267) — 의도된 계층이라 같게 맞추지 말 것(상한↓=정상 거부, S3↑=봇 누락).
- **S7 점수 하한 결합 v5**(2026-07-13, `ANTI_ABUSE_RULES_VERSION=2026-07-anti-abuse-v5`, 마이그레이션 없음): S7 이 duration 단독(>15분)이라 **세션 캡(30분) 도달 정상 제출을 100% 오탐** — 캡 도달 시 `clampForSubmit` 이 durationMs 를 정확히 `MAX_DURATION_MS`(1,800,000ms)로 안착시키고 route 400 은 strict `>` 라 경계값이 통과. 캡 완주(`3e2f930e`)와 탭 방치(게임 벽시계는 hidden 중에도 진행 — 사례 `0528dbad`: 46초 플레이 후 방치, 1,194점, admin cleared) 모두 해당. → **S7 = duration>15분 AND score>`S7_LONG_SESSION_SCORE_FLOOR`(1,400/s×900s=126만, S3 의 15분 봉투 상수)**. S3 는 비율이라 15분 초과 구간에선 봉투가 duration 에 비례해 늘어나는데 S7 이 같은 상수를 하한으로 이어받아 **무플래그 위조 상한 126만이 duration 전 구간 불변**(공격자 이득 0). ≤15분 & >126만은 산술상 반드시 S3 발화(126만/900s=1,400/s)라 두 신호 상보적. 실측 어뷰저 패턴(`4be023f8` 2.19M/29.6분 — score/초 1,231이라 S3 침묵)은 계속 포착. 검증: 역대 duration>15분 4건 중 새 조건 발화=voided 어뷰저 2건뿐(정상 2건 미발화), 새 조건은 구 조건의 부분집합(AND 추가)이라 신규 오탐 구조적 불가.
- **제출 봉투 완결 v6**(2026-07-29): exact integer gameplay stats에서 S2의 20타 표본 게이트는 통계적 의미 없이 1~19타 분산 우회만 만들므로 **모든 1타 이상 무기에 이론 상한을 적용**한다. S10 궁극 횟수도 첫 타 +0.01, 이후 매 타 최대 +0.11인 실제 게이지식의 수학 상한으로 교체했다. 9개 무기×1..19타, hitCount 0..1000, 9^1..9^4 무기 순열과 combo 0..100,000 경계를 독립 모델로 전수 검증한다.

## npm scripts

```bash
npm run dev         # 개발 서버 (Turbopack)
npm run build       # 프로덕션 빌드
npm run start       # 프로덕션 서버
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # 전체 Node 계약/회귀 테스트
npm run test:db     # 로컬 Supabase pgTAP 통합 테스트
npm run qa:db:race  # 로컬 PostgreSQL 2세션 checkout↔탈퇴 lock 경합 테스트
npm run qa:db:anon-reassign-race # 익명 source→서로 다른 target 동시 이전 경합
npm run qa:db:anon-reassign-write-race # 익명이전↔source 점수·텔레메트리 late-write 경합
npm run qa:db:score-ban-race # 점수 제출↔ban 두 commit 순서의 void/badge 수렴 경합
npm run qa:db:moderation-purge-race # 복구↔영구삭제·반복 begin↔finish 경합
npm run qa:db:consent-delete-race # 동의/OAuth profile seed↔계정탈퇴 경합
npm run qa:db:admin-adjust-race # CS 크레딧 조정 POST↔재시도/복구 도착순서 경합
npm run qa:db:admin-mutation-race # 설정·이벤트·신고·무결성·재활성·정산 12개 경합
npm run qa:db:reactivation-auth-api # 로컬 GoTrue Admin API의 activate/cancel/rollback 계약
```

`test:db`·`qa:db:race`는 disposable 로컬 Supabase에 전체 migration을 적용한 뒤 실행한다
(`supabase start` → `npm run qa:db:apply`). CI의 database job도 같은 순서로 pgTAP 다음 실제
2세션 경합을 강제하며, 위 추가 race harness도 같은 로컬 DB만 사용하고 운영 DB나 외부 PG는 호출하지 않는다. `test:db`는
`supabase/tests/*.pgtap.sql`을 파일별로 실제 실행하고 0개 파일·0개 assertion·`NOTESTS`·plan
불일치를 모두 실패로 처리한다.

## 정책 / 보안 (반드시 준수)

- **업로드 이미지**: 정상 흐름은 입력 검증 반려 또는 세 후보의 provider terminal 웹훅 직후 원본을 삭제한다. 요청 프로세스가 강제 종료되면 10분 signed URL 만료 뒤 2분 경계 여유를 둔 `tmp/face` sweep 대상이 되며, scheduler backlog는 비정상 응답으로 노출한다. 결과물(캐릭터화된 이미지)만 장기 저장한다.
- **동의 다이얼로그**: 생성 직전 3개 체크박스 강제 (본인 또는 사용권 있는 이미지 / 타인 비방 목적 아님 / 캐릭터화 변형 동의).
- **AI 프롬프트·수치**: `generation_config`(어드민 콘텐츠 콘솔) 소유 — 기본 시드 = 캐릭터화 템플릿(chibi super-deformed·plush felt·흰 배경·identity 보존), 어드민 편집·버전 이력·롤백. 강제 키워드는 코드로 강제하지 않고 이력·롤백·검토로 관리. 조립 단일 소스 `assembleGenerationPrompts`(`lib/config/domains/generation.ts`).
- **API 키**: `FAL_KEY`, `SUPABASE_SERVICE_ROLE_KEY` 는 **서버 전용**. 클라이언트 번들 절대 포함 금지.
- **HTTP 보안 경계**: 모든 응답에 정적/ISR·PortOne/OAuth와 양립하는 CSP(`base-uri`·`frame-ancestors`·`object-src`), HSTS, `nosniff`, `DENY`, referrer/permissions 정책을 적용하고 `X-Powered-By`를 끈다. `/api/**`의 브라우저 캐시는 기본 `private, no-store`이며 공개 read의 짧은 edge 캐시는 별도 `Vercel-CDN-Cache-Control`로만 명시한다. cookie-auth API mutation은 session/DB 조회 전에 exact `Origin`과 Fetch Metadata로 cross-site·sibling-subdomain 요청을 막고, 서명 검증이 권위인 provider webhook만 이 경계를 우회한다. Supabase auth cookie는 production/preview에서 `Secure`, 전 환경 `SameSite=Lax`·`Path=/`이다(`HttpOnly`는 browser SDK가 token cookie를 직접 읽는 현재 구조상 적용 불가).
- **생성권(크레딧)**: AI 생성은 **회원 전용** — 가입 시 생성권 1개(발행 `growth_levers.signupBonusCredits`), 생성마다 1개 차감(서버 `consume_gen_credit` 원자적, 실패 시 환불). 소진 시 **충전**(`/credits`, 포트원). 전역 fal 잔액 캡($2) 미만이면 service_paused. `OPS_USER_ID` 무제한.

전체 정책 결정은 [CLAUDE.md](./CLAUDE.md) 참조.

## 진행 상황

- [x] M1 셋업
- [x] M2 코어 게임 (PixiJS 탭 메커니즘, 점수+콤보, 결과 모달)
- [x] M3 AI 캐릭터 생성 플로우 (업로드 → 동의 → fal.ai → 저장)
- [x] M4 인증 / 갤러리 (Supabase Anonymous + /gallery)
- [x] M5 공유 / 랭킹 (점수 등록 API + 일·주·월간 랭킹 + Web Share + 동적 OG 이미지)
- [x] M6 PWA + 마무리 (manifest + dynamic icon/apple-icon)

v0.3 (2026-06-05 라이브, 실기기 1차 QA 반영):
- 무기 4종 + 효과음 (주먹/싸대기/키보드/종이, Web Audio 합성)
- 배경 4종 (사무실/탕비실/회의실/회식자리)
- 부장님 시비 멘트 (5.5s 간격 랜덤)
- AI 캐릭터: strength 0.65 + birefnet 누끼 + 사이즈 200
- 점수 0 종료 시 홈으로 (모달 X)

v0.4 (2026-06-09, 물리엔진 도입):
- matter.js 물리: 캐릭터는 spring constraint 로 anchor 에 묶여 밀려났다 자동 복귀, 화면 4벽 (두께 400px, 관통 방지) 튕김
- **캐릭터 자체 드래그 던지기**: tap/throw 모드에서 캐릭터 잡고 끌면 (≥14px) fling → 놓는 속도대로 발사 (cap 28px/step) → 0.9초 자유 비행 후 anchor 복귀. drag 중 벽 박기 +15점 (4벽 margin 60px edge-trigger)
- 효과음: punch/thud/slap/clack/rustle/whoosh/scribble — Web Audio 합성, 타격 속도 비례 볼륨

v0.5 (2026-06-10, 무기 메커니즘 개편):
- 무기 9종 6그룹 — 탭(👊🔨) · 문지르기(✋) · 던지기(📚⌨️📄) · 사격(🔫) · 잡아던지기(🤏) · 낙서(🖊️)
- **뿅망치(🔨)**: 탭 타격 + 휘두르는 스윙 이펙트 + 만화 스프링 "뿅" 사운드
- **비비탄총(🔫)**: 빈 곳을 꾹 누르면 🔫이 캐릭터를 자동 조준, 0.18s 간격 연사. pellet 이 날아가 명중 시 pop + 파티클
- 탭 무기는 타격 지점에 무기 이모지가 뿅 나타나는 emojiPop 이펙트 (주먹 = 펀치, 뿅망치 = 스윙)
- 모든 무기에 조작 hint (weapons.ts 의 `hint` 필드로 일원화) — 주먹/잡아던지기 포함
- **잡아던지기(🤏)**: 캐릭터 fling 은 이 무기 선택 시에만. 주먹/던지기 모드에선 캐릭터를 끌 수 없음 (오발사 방지)
- **주먹**: 둔탁한 한 방 — sine drop + 저역 노이즈 + 어택 클릭 합성 "퍽퍽" 사운드 (타마다 ±8% 디튠)
- **싸대기**: 드래그하면 손바닥(✋)이 손가락을 따라다니고, 캐릭터 위를 빠르게 (≥500px/s) 왔다갔다 문지르면 속도 비례 데미지 (0.6~2×) + 찰싹. 쿨다운 150ms — 1왕복당 1대
- **던지기 (책/키보드/종이)**: 무기를 잡고 캐릭터 쪽으로 휘둘러 놓으면 드래그 방향·속도 그대로 발사 (flick, 슬링샷 폐기). 입력 속도는 finite 값만 허용하고 1600px/s에서 hard cap하며, 충돌 속도 비례 데미지를 준다. 책/키보드 = 둔탁 (thud + momentum 넉백), 종이 = 흩뿌려짐 (paperScatter 팔랑팔랑)
- **펜**: PNG 알파맵 기반 캐릭터 실루엣 판정 — 실루엣 밖 낙서 불가 (보간 dot 까지 재검증). 한 입력 샘플의 보간점은 하나의 `Graphics`로 batch하고 segment당 128점·FIFO 256 segment로 장기 세션의 GPU 객체/메모리를 제한한다. 낙서는 doll.bodyWrap 의 child — 캐릭터가 흔들리거나 던져지면 낙서도 같은 레이어로 함께 이동
- **배경 전환 시 게임 상태 유지**: BgSwitcher 가 navigation 대신 텍스처 핫스왑 (`setBackground`) — 점수/콤보/무기/낙서 전부 유지, URL 은 replaceState 동기화
- 안정성: PIXI v8 globalpointermove 로 fling 추적 (캐릭터 밖 드래그 추적 유지), touch-action none 유지 (모바일 제스처 하이재킹 방지), DOM pointercancel 안전망, 물리 body 반경 표시 scale 동기화, collisionStart 넉백 setVelocity 임펄스화, fling 중 중력 누적 방지, 게임 생성 중 무기/배경 변경 유실 방지. 종료·blur·hidden은 held gesture와 궁극기/투사체를 취소하고 producer(PlayScene)·receiver(store) 양쪽 점수 gate를 같은 turn에 닫으며, 종료 뒤 충돌/타격은 0점이다. 명시적 restart만 gate를 다시 열고, 0×0 resize는 무시해 양수 크기 복귀 때 Matter 좌표/질량이 유한하게 유지된다.
- 모바일 fling: drag 중 doll↔벽 충돌 off + 벽 overhang (body 반경 70%) — 좁은 화면에서 캐릭터 body 가 좌우 벽에 끼어 상하로만 움직이던 버그 수정
- 연타: tap 무기 (주먹/뿅망치) 는 pointerdown 즉시 타격 + 포인터 잠금 없음 — 두 손가락 파바박 연타 전부 접수 (기존엔 단일 포인터 lock + up 판정으로 절반 씹힘)
- 네이티브 제스처 차단 (`.game-surface`): 게임 화면에서 텍스트 선택 / iOS 길게누름 돋보기 / 콜아웃 시트 / 이미지 드래그 / 컨텍스트 메뉴 차단
- 로딩 UI: /play 진입 시 "부장님 불러오는 중..." 오버레이, 갤러리 카드 이미지 페이드인 + 삭제 중 카드 dim + 스피너
- 낙서 지우개: 캐릭터에 낙서가 있으면 picker 의 펜 슬롯이 🧽 로 변함 — 터치하면 낙서 전체 삭제 (점수 무관, 무기 모드 유지), 지워지면 🖊️ 복귀
- placeholder 캐릭터 크기 0.8× 보정 — 머리 지름이 곧 전체 폭이라 AI 캐릭터 (프레임 내 ~60-80%) 보다 커 보이던 것 균형
- 게임 생성 race 수정: StrictMode 더블 마운트에서 취소된 생성 호출이 살아있는 게임의 canvas 를 DOM 에서 제거해 입력 전체가 죽던 버그 — createGame 에 isCancelled 체크 추가 (DOM 건드리기 전 자가 정리). renderer 크기도 ResizeObserver 에서 직접 동기화 (resizeTo 는 window resize 만 반응해 모바일 주소창 수축/회전 시 입력 좌표계가 어긋남)
- 점수 한도 ([lib/score-limits.ts](lib/score-limits.ts), 서버/클라 공유): 콤보 배율 cap 4×, 평균 2000점/sec, 제출 전 클라이언트 클램프 — 정상 플레이에서 score_out_of_range 저장 실패 안 남 (서버 검증은 변조 방어용 유지)

v0.6 (2026-06-12, 네비게이션·닉네임·보고서):
- **전역 네비게이션** (`AppNav`): 홈/갤러리/랭킹 탭 + 닉네임 표시·수정 버튼. 홈/갤러리/랭킹/생성 페이지 장착 (/play 는 몰입 화면 — 종료 보고서에서 이동 제공)
- **닉네임**: 기본값 직장인 컨셉 랜덤 ("분노한 사원 3847" 등, migration 0003) + 어디서든 수정 (profiles self-update RLS) → 랭킹/공유 즉시 반영
- **게임 결과 = 결재 보고서 패러디**: 문서번호·작성자·"해소완료" 도장·항목별 정산 (점수/최대콤보/총타격/주력무기/소요시간/판정등급) + 부장님 피드백 멘트. 등급은 점수 구간별 직급 패러디 (무급 인턴 ~ 전설의 퇴사자)
- **공유 랜딩 리뉴얼** (/share/[scoreId]): 동일 보고서 포맷 + 커스텀 캐릭터 사진 + "당신의 부장님은 무사하십니까?" 후킹 + CTA 3종. OG 제목도 "[결재완료] 닉네임 — N점 (등급)"
- scores.max_combo 컬럼 (migration 0003) — 미적용 환경에서도 동작하는 fallback 포함
- 연타 씹힘 근본 수정: 타격 이펙트 (이모지/점수팝/파티클) 와 hint 텍스트가 PIXI hit-test 를 가로채 같은 자리 빠른 연타가 캐릭터에 닿지 못하던 것 — 이펙트/오버레이 레이어 전부 `eventMode: "none"` (검증: 같은 좌표 40ms 간격 10연타 전부 등록)

**⚠️ Migration 0003 적용 필요** (`supabase/migrations/0003_nickname_and_combo.sql` → Dashboard SQL Editor):
직장인 닉네임 생성기 + 기존 "익명*" 일괄 변환 + scores.max_combo. 적용 전에도 앱은 동작 (fallback).

v0.7 (2026-06-12, 운영 안전장치·바이럴):
- **플레이타임 10분 → 1시간** (클라 클램프 + 서버 검증 + DB check, migration 0004). 점수 상한 (시간×2000/sec) 방어선은 유지
- **AI 생성 1일 2회** (KST 자정 리셋, 실패한 생성은 차감 안 함). `profiles.daily_gen_limit` 로 계정별 관리 — null 로 두면 무제한 (운영 계정용)
- **fal 잔액 hard cap(현재 계약)**: 새로 claim한 생성 후보마다 fal billing API (`/v1/account/billing?expand=credits`)를 fresh 조회한다. 정상 잔액은 캐시하지 않고 $2 미만 denial만 60초 캐시한다. 키 누락·timeout·HTTP/본문/JSON/잔액 손상도 권위 부재이므로 생성 제출을 fail-closed한다. `FAL_ADMIN_KEY`(ADMIN scope) 필요.
- **OG 이미지를 결재 보고서 디자인으로**: 문서번호·작성자·점수·판정 등급·부장님 멘트·해소완료 도장·캐릭터 사진 — 카톡/트위터 공유 시 보고서가 그대로 보임
- **랭킹 익명 버그 수정**: get_leaderboard 가 security invoker 라 RLS 로 타인 닉네임이 null → profiles public read 정책 추가 (migration 0004)
- 무기 조작 안내를 캐릭터 발치 (PIXI) → **무기 picker 바로 위 (DOM)** 로 이동, PIXI hint 코드 5곳 제거
- **꼬질꼬질 데미지 데칼** (`DamageLayer`): **2,000점마다** 약한 꼬질 (때 + 작은 멍/스크래치) — 상한 없이 누적 (성능 안전망: 데칼 400개 초과 시 오래된 것부터 정리). 궁극기로 점수가 빠르게 쌓이는 점 반영해 천천히 더러워지게(만점 단위 큰 멍 로직 제거). 위치는 랜덤이 아니라 **피격 부위 기준** — 모든 타격의 좌표를 기록해 최근 맞은 곳 부근에 쌓임 (실루엣 밖이면 재시도 → 랜덤 fallback). 낙서처럼 캐릭터와 함께 움직이고 라운드 리셋 시 초기화. zustand subscribe 로 리렌더 없이 점수 전달. 자연스러움: 멍 = 불규칙 폴리곤 + radial gradient, 때 = 가우시안 스프레이, 스크래치 = 휜 곡선. **실루엣 클리핑**: 데칼+낙서 레이어를 캐릭터 텍스처 자체의 Sprite alpha mask (placeholder 는 도형 mask) 로 감싸 — 면적 있는 데칼도 캐릭터 픽셀 밖으로 한 픽셀도 안 나감
- **OG 캐릭터 이미지 수정**: Satori 가 외부 URL `<img>` 를 자체 fetch 하다 조용히 실패 + attribute width 만으론 크기 미인식 — data URI embed + style 명시로 해결. 커스텀 없으면 기본 부장님 (OG/공유 페이지/결과 보고서 모달 공통)
- **기본 부장님 교체**: 3D 클레이 스타일 이미지 (`public/sprites/boss-default.png`, 768×1024 누끼 PNG 130KB). 기본 플레이만 이 정적 자산을 사용하며, 기본/커스텀 텍스처·DB 조회·서명·배경 초기화 실패는 다른 캐릭터나 Graphics placeholder로 위장하지 않고 플레이 화면의 명시적 재시도 상태로 전환한다. 전처리 스크립트 `scripts/prepare-default-boss.mjs` (fal storage 업로드 → birefnet 누끼 → trim → AI 캐릭터 규격 정규화). 코드베이스 정적 자산으로 둔 이유: 전 유저 공통·불변 자산은 Vercel CDN 캐시가 최적, Supabase 대역폭/장애 의존 0

- **갤러리 캐릭터 공유** (바이럴): 카드 우상단 ⋯ 옵션 메뉴 → 공유 / 삭제. 공유 = 워터마크 이미지(우하단 작게) + `/doll/[id]` 링크를 Web Share 로 (fallback: url share → 링크 복사). Web Share 공유 시트에 "이미지 저장" 이 이미 포함돼 별도 저장 옵션은 제거
- **`/doll/[id]` 공개 랜딩 — 인사기록카드 패러디**: 증명사진란 + 성명/직급/소속/제작자/특이사항 + "관리대상" 도장 + "나도 우리 부장님 만들기" CTA. 전용 OG 카드 동일 컨셉 (admin client 조회 — RLS 무관, UUID 라 추측 불가)

v0.8 (2026-06-13, 궁극기·베리에이션·UX):
- **궁극기** (`UltimateButton`/`DamageLayer` 연계): 명중 100회 누적 시 게이지(`ScoreBoard` 상단 바) 풀 충전 → "궁극기 발동" 버튼 등장 → 탭 시 3.9초 **난사타** (랜덤 무기 타격 다발 + **캐릭터 마구 던져짐** (0.4s마다 랜덤 임펄스, 스프링 약화로 화면 휘젓다 종료 시 anchor 복귀) + 화면 흔들림 + 점수 폭등 + 마무리 화면 플래시). 난타 타격은 게이지 재충전 안 함, 발동 중 입력 차단·재발동 가드, 종료/그만패기 시 `stopUltimate` 로 정리. `gameStore` 의 `ultProgress/ultReady/consumeUlt`
- **점수 구간 단일 10단계 통일** (`lib/report.ts` `scoreTier()` 한 곳에서 결정, 갭 10000 / 0~90000): 판정 등급·부장님 피드백·OG 설명·play 시비 멘트(`lib/taunts.ts`)가 전부 동일 10단계 공유 (이전엔 등급10/OG5/시비3 으로 제각각이던 것 통일)
  - **판정 등급 = 패는 사람(직장인)의 경지** (이전 부장님 직급 → 변경): 무급 인턴 → 패기의 신입 → 열혈 사원 → 독기의 대리 → 분노의 과장 → 폭주 차장 → 광기의 부장 → 해탈한 임원 → 사이다 마스터 → **전설의 퇴사자**
  - 부장님 피드백·시비 멘트는 단계마다 무시→짜증→당황→회유→굴복 톤, OG 설명은 후킹 강도 상승
  - 인사카드 직급/소속/특이사항(맞는 부장님 정보)은 별개 seed 해시 베리에이션 유지
- **무기 hint 가독성**: 반투명 캡슐(pill) 배경 — 배경 무관 또렷
- 갤러리 "이미지 저장" 옵션 제거 (공유에 포함되어 중복)
- 리뷰 수정 2건: 난타 중 비행 투척물 명중이 게이지 재충전하던 버그(ultActive 중 charge 강제 false), "그만 패기" 시 난타가 모달 뒤에서 잔류하던 버그(`stopUltimate`)
- 꼬질꼬질 누적 속도 절반(2000점마다) + 만점 단위 큰 멍 로직 제거, 궁극기 한 타격 점수 절반

v0.9 (2026-06-13, 생성 파이프라인 복구):
- **캐릭터 생성 중단 복구**: 3장 생성 후 고르기 전 이탈/새로고침/실패/생성중 끊김에서 갤러리로 이어서 진행
  - fal 결과 3장을 Supabase(dolls 버킷 `candidates/{genId}/` prefix)에 복사 보관 (fal URL 은 만료되므로). `ai_generations.candidate_urls` (migration 0005)
  - 갤러리 "진행 중인 생성" 영역: 생성 중(스피너) / 3장 완성→썸네일+"이어서 고르기"(`/generate?resume=genId`) / 중단됨→"다시 만들기"
  - `/api/generations` GET: 미완결 목록 + lazy 복구/정리 (queued 는 fal request_id 로 결과 폴링, 일반 요청은 30분 초과+복구 실패 시 중단하며 **submit 수락 여부가 불확실한 요청은 start 10분+기본 처리 1시간+signed webhook 재전송 2시간+여유 10분인 200분까지 보류**, done 미선택 24h 초과는 row lock 아래 명시적 `expired` 전이·환불 없음). 만료 후보는 삭제하고 실패 경로만 정리 재시도 manifest 로 남기며, 어드민 목록/필터/상세도 `미선택 만료`를 별도 표시하되 후보 signed URL은 만들지 않는다. 생성 중이면 갤러리가 4초 폴링
  - pick 시 `/api/doll` 가 generationId 로 `done→picked` 조건부 전이 + 안 고른 후보 storage 정리. 전이 DB 오류·동시성 패자는 방금 만든 doll row→storage 순서로 보상삭제하며, SDK가 resolve한 삭제 오류도 500+로그로 드러내 성공으로 오인하지 않는다
  - migration 0005 미적용 환경에서도 안전 (생성 done fallback, 복구 기능만 비활성)

v0.10 (2026-06-15, 생성 품질·데이터 감사·랭킹):
- **생성 비동기 전환** (제출-후-폴링): `/api/fal` 가 fal 에 3건 제출만 하고 즉시 반환(~6s) → 클라가 `/api/generations` 폴링으로 완성분 수집. 생성이 60~120s+ 걸려도 maxDuration/abort 에 안 걸림(기존 동기 대기 → 후보 누락/실패 사고의 구조적 해결). 임시 얼굴은 genId 결정적 경로(`{owner}/tmp/{genId}.jpg`)로 두고 복구가 done 마킹 시 폐기(정책 #1). `/api/generations` 행별 복구 병렬화 + OG 라우트 ISR 캐시(`revalidate=3600`)
- **비용 경로 재개방 식별자**: 결제 checkout과 생성 `/api/fal`·`/api/doll`의 frozen 응답은 검증된 Supabase project ref와 40자리 배포 commit 헤더를 함께 노출한다. 운영 migration runner는 세 표면의 식별자가 모두 일치하는 배포에서만 expand·drain을 수행하고, DB/app/drain 검증이 끝난 뒤에만 `GENERATION_COST_PATH_ENABLED=1`로 생성 비용 경로를 연다.
- **입력 얼굴 화질 게이트** (crop 시 해상도≥300px·Laplacian 선명도 검사 → 미달 차단), **안경 조건부 반영** (Moondream VQA 로 입력 안경 검출 → 있을 때만 프롬프트 주입), 의류 색 베리에이션(팔레트), 닮음도 파라미터(true_cfg 2/guidance 4), 후보 복사 재시도+폴백, 느린 생성 자가복구(request_id 기반 reclaim)
- **감사 컬럼** (migration 0007): 모든 테이블(profiles/dolls/scores/ai_generations)에 `updated_at`·`version` + UPDATE 트리거(`set_updated_at_and_version`)로 자동 갱신 — 데이터 확인/트러블슈팅용
- **랭킹 KST 자정 초기화** (migration 0008): `get_leaderboard` 윈도우를 롤링(now()−1d/7d)에서 **KST 자정 고정 경계**로 — 일간=매일 0시, 주간=월요일 0시 (Asia/Seoul). 일간/주간 모두 **최대 10명**
- 갤러리 "이어서/중단됨" 텍스트 라이트모드 대비 수정 (`dark:` variant)
- **배경(맵) 재구성**: 사무실/탕비실/회식자리 새 이미지로 교체 + **복사실·엘리베이터 맵 추가** → 총 **6종**(회의실 유지). BgSwitcher 좁은 폭 가로 스크롤

v0.11 (2026-06-20, 하이라이트 클립 공유 — 바이럴):
- **점수 급상승 하이라이트** (영상 되는 곳은 영상, 아니면 카드 + **항상 링크 공유**): 플레이 중 점수 timeline(100ms ring buffer, `store/gameStore` `scoreSamples`)을 기록하고, velocity/궁극기/콤보 spike 에서 **최대 3회·각 ~4초** 캔버스를 MediaRecorder 로 녹화해 Δscore 최대 **best clip 1개**만 메모리 보관(`app/play/useHighlightRecorder.ts`). `lib/highlight.ts`(순수: `pickHighlightWindow`/velocity/서버 메타 클램프).
  - **크로스플랫폼 현실**: 클라 녹화+`navigator.share(file)` 는 iOS Safari 불안정·인앱 webview(카톡) 미지원·데스크톱 일부 미지원 → **공유는 항상 `/share/[scoreId]` 링크**(URL primary `navigator.share({url})` → 실패/webview 면 clipboard, **gesture 안에서**), **업로드는 백그라운드**(fire-and-forget). 녹화 미지원/실패/빈 blob → 카드만으로 끊김 없이 공유(fallback 원칙).
  - **검은 프레임 방지**(Whale/Mac·iOS): PixiJS `app.init` `preserveDrawingBuffer:true`(WebGL 합성 후 버퍼 보존 — captureStream 검은 프레임 차단) + 녹화 직후 1프레임 휘도/분산으로 **confident-black 만 reject→카드 폴백**(디코드 실패는 fail-open). `HighlightPlayer` 재생 onError 도 카드 배지로 강등.
  - **업로드** (`app/api/highlight`): 클립 바이트는 **Vercel 안 거침**(4.5MB 한도 회피) — POST 가 owner 검증 후 DB upload intent를 먼저 발급하고 `createSignedUploadUrl(highlights/{scoreId}/{uploadId}.{ext})`를 반환 → 클라가 Supabase 직접 업로드 → PATCH 가 intent의 owner/path/token freshness와 **`storage.info()` size/mime을 서버에서 재검증**한 뒤 원자 attach(score당 1회) + `revalidatePath`. attach 전 이탈·실패 객체는 2시간5분 후 fenced cleanup lease가 회수하며, 만료 클립도 DB reference를 먼저 끊고 outbox로 물리삭제를 재시도한다. **공유 클릭 시점만 업로드**(매 게임 X).
  - **`/share`**: 클립 있으면 `<video>`(src=Supabase CDN 직접, Vercel egress 0) + 🔥급상승 stat, 없으면 보고서 카드. OG 카드에도 `+N점` stat. migration 0009(`scores` highlight_* 컬럼 + public `highlights` 버킷, `highlight_expires_at`/`deleted_at` TTL·신고 설계 반영). **(v0.41: `highlights` private 전환 — 재생은 CDN 직접 → signed URL[`clipSignedUrl`].)**
  - 관측: `highlight.record_supported/started/success`·`empty_blob`·`upload_success/rejected_size` (Sentry/Logs).

v0.12 (2026-06-20, OAuth 회원 + 생성권 크레딧):
- **Kakao/Google 로그인 회원제**: 익명 전용 → OAuth 회원 도입. 비회원도 플레이·랭킹 유지, **생성·갤러리는 회원 전용**(`proxy.ts` 게이팅 → `/login`). 별도 가입 페이지 없이 로그인 버튼이 곧 가입.
- **linkIdentity 마이그레이션**: 익명 상태 첫 OAuth 로그인 시 같은 `user.id` 로 멤버 승격 → 익명 때 만든 dolls/scores 보존. 로그아웃=새 익명 분리. 이미 가입된 OAuth 재로그인은 `identity_already_exists`→`/login?relogin=1`→`signInWithOAuth`(현재 익명 데이터 자동 병합 안 함).
- **공개/멤버십 분리** (migration 0010): 공개 프로필 `profiles`(+`avatar_url`, public read; 컬럼레벨 grant 로 클라는 `display_name` 만 수정) / private `member_accounts`(`gen_credits`·`member_since`·`email`, self-read만, write 는 service-role/`SECURITY DEFINER` RPC) — 익명 변조·노출 차단. `email`(0014)은 이벤트/연락용 — `auth.users.email` 복제본(콜백서 변경 시 최신화), **public 노출 금지라 여기 비공개 저장**, 추출은 admin/대시보드 전용(클라 프로필·캐시 미반영).
- **생성권 크레딧**(일일 한도 대체): 가입 시 1개(이후 `growth_levers` 발행값이 권위), 생성마다 1개 차감(`consume_gen_credit`, fal 제출 직전 원자적·실패 시 `refund_gen_credit`). `OPS_USER_ID` 무제한.
- **콜백/게이트**: `/auth/callback`(code 교환 + **이메일 필수 게이트**(verified-email linking 안전성) + 멤버 1회성 초기화 — `member_accounts` 신규 insert 시만 OAuth 닉/프사 반영, 재로그인 보존), `lib/auth-server.ts` `requireMember`(401/member_only/member_setup_required), `safeNext`(open redirect 차단).
- **계정 UI**: `AppNav`/`AccountMenu` 익명(닉네임+로그인) vs 멤버(아바타+드롭다운: 닉네임/프사 변경·로그아웃). `/api/avatar`(서명 업로드 → admin 검증 → `profiles.avatar_url`), 랭킹에 프로필 아바타(없으면 `/avatars/default.png`).
- 계정 정책: Supabase 자동 linking 수용(동일 verified 이메일 Kakao/Google = 같은 계정), 멀티연동 UI 없음. Provider 키는 앱 env 가 아니라 Supabase Auth config. 이 버전에서 적었던 익명 dolls 후속 정리는 현재 blanket 계정삭제로 구현하지 않는다. 신규 회원의 서명된 익명이전만 exact receipt로 수행하고, 미승격 익명 점수·원본 소유 namespace는 무결성 증거로 보존하며 telemetry와 미attach Storage 객체만 각 보존기한·fenced cleanup 정책으로 정리한다.

v0.13 (2026-06-20, OAuth 후속 폴리시):
- **매끄러운 재로그인**: 이미 가입된 계정으로 로그인 시 거부 바운스 제거. `startOAuth` 가 `redirectTo` 에 `p=provider` 를 실어보내고, 콜백이 `identity_already_exists` 면 `/login?auto=<provider>` 로 → `LoginForm` 이 스피너 보이며 `signInWithOAuth` 자동 재개(allowlist + `useRef` 1회 guard, 루프 없음). 신규 가입(linkIdentity)은 그대로.
- **생성권 노출/가드**: `getMyProfile` 가 멤버면 `member_accounts.gen_credits` 도 반환(`formatCredits`: ≥9999 "무제한"). 계정 메뉴·갤러리에 "생성권 N개", `/generate` 는 `checking`→`no_credits` stage 로 0 이면 진입 차단(우측하단 의견 위젯 안내). 클라는 UX 가드일 뿐 — 최종 차단은 `/api/fal`(조회 실패 시 consent 로 진행).
- **프로필 사진 삭제**: `/api/avatar` DELETE가 `request_avatar_clear`로 DB reference 제거와 Storage cleanup outbox 생성을 한 트랜잭션에 고정한다. 즉시 물리삭제가 실패하면 202를 반환하고 `content-maintain`이 fenced lease로 재시도한다(외부 URL은 Storage 삭제 대상에서 제외). `AvatarEditor` "기본 사진으로 되돌리기".
- 익명 dolls→운영계정(f81c8a92) **이관 실행**(0011 전, `doll_owner_migration_log` 백업). `member_accounts` 에 감사 컬럼(updated_at/version), `daily_gen_limit` 컬럼 제거(0011).

v0.14 (2026-06-21, 플레이 해석 리포트 — 페르소나, PR1/4):
- **"부장님 패기 인사평가 리포트"**: 종료화면에 score/combo 를 넘어 **플레이 스타일 페르소나** 즉시 리빌 → 이탈 방지·공유 유도. 룰베이스 결정적(LLM 없음, 대기 0) — 같은 플레이=같은 페르소나.
- **엔진 계측**(`store/gameStore.ts`): `weaponScores`(무기별 **final gain**=콤보배율 적용 점수기여), `ultimateCount`, `firstHitMs` 추가. `bgVisits` 는 store 밖이라 `app/play/page.tsx` ref 로 수집.
- **해석 엔진**(순수 모듈, SSR/CSR 공용): `lib/stats.ts`(`GameplayStats`/파생/서버검증), `lib/persona.ts`(~10종 결정적 우선순위 + **트리거 stat evidence** 동봉 — "이 분석은 이 데이터에서"). `lib/report.ts` 카피 자산 재사용.
- **저장**(migration 0015 `score_stats` — 1:1, public read, service-role write; highlight attach-once 불변식 보호 위해 별도 테이블): 이 버전은 `/api/score` 점수 저장 뒤 stats를 best-effort로 썼다. 현재는 `commit_score_report`가 canonical payload·stats·badge·receipt를 한 DB mutation으로 커밋하며, 부분 성공을 허용하지 않는다. `sum(weaponScores)≈score`·`sum(weaponCounts)≈hitCount` 검증도 같은 권위 경계에서 실패 폐쇄한다.
- 종료화면(`GameOverModal`/`ScoreReport`)이 페르소나를 **클라 즉시 계산**(서버 대기 없음). 익명도 동일 적용(승격 시 보존).
- **공유/OG 반영**(PR2/4): `/share/[scoreId]`·OG 가 `score_stats` 조인해 페르소나 카드 렌더(`components/PersonaCard` — 종료화면과 공용 DRY), CTA 를 "당신의 패기 유형은?"·"나도 패기 유형 받아보기"로 → 받는 사람 호기심→플레이 전환. OG 는 satori 제약상 페르소나/백분위 텍스트만(차트 없음).
- **뱃지 + 백분위**(PR3/4): migration 0016 — `user_badges`(owner_id별 누적 수집, 승격 시 보존) + `get_score_percentile` RPC(**전체 플레이 기준** `상위 ceil%`, ≤100 cap; 랭킹과 별개 지표). `lib/badges.ts`(11종 단일게임 업적). 당시 `/api/score`의 badge/percentile 후처리는 best-effort였고, 현재는 `commit_score_report`의 원자 receipt 경계에 포함된다. 종료화면=이번 판 뱃지(클라 즉시)+NEW 표시+수집 N/M+백분위(서버 스켈레톤→채움), 공유/OG=스냅샷 렌더(`components/BadgeStrip` 공용).
- **인게임 동기부여**(PR4): `components/play/MissionHud`(소프트목표 무기3종/콤보30/궁극기1회 — 세션 연장·무기 다양성 유도, "● 분석 기록 중" 으로 데이터 수집 암시) + `app/play/useGameMilestones`(store.subscribe 기반 토스트 — 콤보 10단위·새 무기·궁극기 발동마다 "📊 보고서에 기록 중" 암시; recorder 와 신호원만 공유, **별도 interval 없음**). 페르소나→공유→뱃지/백분위→인게임 **4개 PR 완료**.

v0.15 (2026-06-21, 뱃지 통합 후속 — 4 PR; 마이그레이션 없음):
- **궁극기 제외**(PR1): 궁극기 난타(`charge===false`)는 **점수만**(`gameStore.hit()` early return — score+`ultScore` 누적·콤보 유지, combo/maxCombo/hitCount/weaponCounts/weaponScores/firstHitMs 미반영). 랜덤 무기·자동 콤보가 뱃지/페르소나/미션을 부풀리던 문제 해결 — 콤보·무기 통계가 **순수 수동 플레이** 기준이 됨. `GameplayStats` **v:2**(`ultScore` 추가) + 검증 `sum(weaponScores)≈score−ultScore`(v:1 tolerant). 궁극기 발동 자체(ultimateCount)·점수 뱃지엔 ult 포함(정당 득점).
- **카탈로그 패밀리화**(PR2): `lib/badges.ts` 를 **패밀리×티어 생성(50개)** 단일 소스로 재작성 — 점수/콤보/총타격 각 10단계(100~100만 / 100~1만 / 100~1만), 무기/궁극기/플레이타임/맵 5단계. 상위는 사실상 불가(전설). **`badgeValue(def,stats,score)`** 진행도 API(인게임 체크리스트·수집페이지 공용), `summarizeBadges`(패밀리별 최고 티어 압축 — 종료/공유 strip ≤7칩), **`KNOWN_BADGE_IDS`**(구 badge_id 고아를 모든 카운트에서 제외 — `collectedCount`·N/M). `components/BadgeStrip` 압축 적용.
- **수집 페이지**(PR3): `app/badges/page.tsx`(클라 self-RLS) — 프로필 메뉴 **"🏅 내 뱃지"** 진입(`AccountMenu`, 익명/회원 공통). 패밀리별 섹션(획득=이모지+임계라벨, **미획득=🔒/"?"** 조건 숨김), 상단 "N/50 수집"·섹션 k/n. 카운트는 known id 만(고아 제외). `proxy.ts` MEMBER_ONLY 미포함=공개.
- **인게임 뱃지 통합**(PR4): MissionHud/useGameMilestones 폐기 → **`components/play/BadgeChallenge`**(🏅 도전 과제 — 패밀리별 1개씩 획득 임박 3슬롯·진행바) + **`app/play/useBadgeChallenge`**(`lib/badges` 단일 소스 구동: store.subscribe 로 라이브 진행도, **뱃지 실제 획득 순간 "「○○」 획득!" 토스트 + ✅ 핀 1.2s → 다음 임박 리필**). 성능: setState 는 슬롯·진행률(floor%)·✅ 변동 시에만, 별도 interval 없음. **"분석/기록" 표현 → "도전 과제/획득"** 리네임. HUD 를 SpeechBubble 아래(top-28%)로 — **iPhone SE 말풍선 비가림**. 뱃지 4 PR 완료(궁극기제외→카탈로그50→수집페이지→인게임).
- **뱃지 튜닝**(후속): 캡 **30분/500만점**(`score-limits` MAX_DURATION_MS/MAX_SCORE_HARD — DB check 1h/10M 보다 타이트, 마이그레이션 불요). 카탈로그 **60개**로 — 점수 1,000~1,000,000(10), 궁극기 1~50회(10), 플레이타임 1~20분(10), **타격 150~30,000(10 — 콤보값과 비겹침·콤보보다 큼)**; 콤보(100~10,000)/무기(2~9)/맵(2~6) 현행. 종료화면 CTA 에 "🏅 내 뱃지"(/badges) 랜딩. BadgeChallenge HUD **컴팩트**(폭 88px·숫자 제거 progress bar 만 → 원래 면적 ~30%, 소형 폰서 캐릭터 비가림).

v0.16 (2026-06-22, 게임 기록 보기 — 본인/타인 회고):
- **지난 게임 기록** (`/history/[userId]` 목록 + `/history/[userId]/[scoreId]` 상세): 우상단 프로필 메뉴 "내 기록" / 랭킹 행 클릭으로 진입. 본인·타인 **같은 컴포넌트**(경로 키=userId, self/other 분기 없음, 헤더는 항상 "{닉}님의 기록"). scores/score_stats/profiles public-read 기반 공개 — 신규 PII·DB 변경 없음(목록 인덱스 `scores(owner_id, created_at desc)` 는 0001 기존).
- **목록**: 10개씩 페이징(server component, `?page=` SSR · `.range()`+`count:'exact'`). 행 = 등급·주력무기·콤보·소요시간·상대시간 + 점수. 빈 상태/페이지 경계 처리.
- **상세**: "기록 회고" 역할 — 종료화면(즉시 축하)·`/share`(바이럴 자랑)와 분리. 보고서 카드 **축약판**(문서번호·캐릭터·점수·상위%·콤보·총타격·주력무기·소요시간·등급·페르소나·획득뱃지). **부장님 멘트·OG·하이라이트 임베드는 제외**(역할 분리). `score.owner_id !== userId` 면 404(URL 변조 방지).
- **공용 추출**: `/share` 의 fetch/flatten/highlight 헬퍼를 **`lib/score-detail.ts`**(server-only, owner_id 포함, nested select 객체/배열 방어)로 추출해 상세와 공용. `timeAgo` 를 `lib/report` 공용화(leaderboard 중복 제거).
- **보고서 공유 통합** (`components/ShareReportButton`): 게임 직후·이전 기록 상세 **둘 다** Web Share API(`lib/share` `shareGameResult`, URL primary→clipboard 폴백)로 `/share/[scoreId]` 링크 공유 → 수신자는 `/share` 랜딩. 상세의 하이라이트-전용 "보기" 링크를 **항상 노출되는 공유 버튼**으로 대체(라벨만 하이라이트 유무로 "🔥 하이라이트 공유"/"결과 보고서 공유"). 모든 게임이 공유 가능.
- **메뉴 위계 평탄화 + 순서**: "내 뱃지"·"내 기록" 이모지(🏅)·볼드 제거(다른 메뉴와 동일 위계), 게임종료화면 하단 "내 뱃지" 링크도 평탄화. **비로그인 시 "로그인 / 회원가입"을 메뉴 최상단**으로. 인게임 뱃지 HUD/토스트·결과 뱃지칩은 유지.
- **dev/preview 영구 설정**: `npm run dev`의 본문 launcher가 현재 Node 또는 nvm 설치 목록에서 exact v22 실행파일을 선택·재검증한 뒤 `--hostname 0.0.0.0` 로 바인딩한다. lifecycle을 생략해도 guard는 남고, v22 미설치·다른 system Node·빈 PATH는 조용히 사용하지 않는다. **같은 WiFi 폰에서 `http://<맥 LAN IP>:3000` 접속** 가능(next.config `allowedDevOrigins` 192.168.* 등 허용).

v0.17 (2026-06-22, 캐릭터 롤 확장 — 부장 → 5종):
- **롤 5종**: 부장(기본)·임원·팀장·거래처·짜증나는 직장동료. 캐릭터별 **피격자 의견·시비 멘트·인사기록(직급/소속/특이사항)·호칭·무기힌트·OG**가 롤별 고유(점수 10단계 풀뎁스). 판정등급·페르소나는 플레이어 것이라 롤 중립.
- **레지스트리** `lib/roles/`(RoleId·ROLE_META·getRoleContent, `TieredLines` 10단계 컴파일 강제 + dev assert). 셀렉터(report/taunts/weapons)에 `role` 파라미터(기본 boss). boss 출력은 리팩터 전과 동일(회귀 0).
- **데이터**: `dolls.role`(migration 0017, default 'boss', CHECK 5롤, 기존 doll 자동 boss 백필). 롤 변경 = `PATCH /api/doll`(owner 검증, unknown role 400). 갤러리 카드 좌상단 롤 칩 + 점세개 "롤 변경". 생성 기본 boss, **이미지/프롬프트 불변(롤=메타데이터)**.
- **배선**: play(시비멘트/게임오버 의견)·`/share`·`/doll` 인사기록·`/history`·OG 가 doll.role 로 분기(공유/기록은 라이브 doll join + 삭제 시 boss 폴백). 한국어 조사는 명사형(`noun`)+완성형(`targetObj`/`ctaSafe`/`ogLines`)으로 정확.
- **브랜드 유지**: 앱명("부장님 패기")·홈·메타·login 은 부장 그대로. 갤러리 집합 카피만 "캐릭터"로 중립화.

v0.18 (2026-06-22, 롤 후속 — 생성 시 롤 선택 + 감정선/포맷/조사):
- **생성 시 롤 선택**: 사진 crop 후 `role-select` 단계(`components/generate/RoleSelectStage`, 5칩·boss 기본) → 고른 롤이 **fal 프롬프트(복장·표정·분위기)** 와 `dolls.role` 에 반영. 프롬프트는 **`generation_config.prompt.roles[role]`(subject/attire/expression) + 공용 템플릿**(chibi·plush·identity 시드)로 조립(`assembleGenerationPrompts`), **복장/표정만 롤 차등**(임원=고급정장+포켓스퀘어, 팀장=노타이·소매 걷음, 거래처=정장+방문증, 동료=니트 가디건). 이미지=생성 시 롤 반영, 이후 갤러리 롤 변경=텍스트만(재생성 없음).
- **데이터/배선**: `ai_generations.role`(migration 0018, default 'boss', CHECK 5롤). `/api/fal` role 추출·검증(미지 400)·저장·프롬프트 전달. `/api/doll` POST 는 `ai_generations.role` 을 **권위 소스**로 읽어 doll.role 저장(클라 신뢰 X). resume/"이어서" 복귀 시 `/api/generations` 가 role 반환 → `useGenerationPolling` 이 복구.
- **감정선 전면 재정렬**: 4롤 `taunts`+`reactions` 를 boss 아크(0~4 고압 → 5 전환 → 6~9 점진 비굴)로 재작성 — tier5 이전엔 굴복 금지(기존엔 너무 빨리 비굴). 4롤 파일을 boss.ts 포맷(tier 1줄)으로 통일.
- **조사/UX**: `josaEuro(word)`(받침 따라 으로/로) → "동료로 변경"(기존 "동료 으로" 오류 수정). 갤러리 롤 변경 중 **"변경 중…" 오버레이**(삭제 패턴 복제) — 탭/대기 구분.

v0.19 (2026-06-23, 생성권 유료 충전 — 페이앱 무사업자 결제):
- **결제 경로**: 사업자등록 없이 본인 비사업자(개인판매자)로 페이앱 연동(카드·네이버페이, 카카오 불가). `/credits`(상품 4종 1,000~7,000원·개당 단가, 회원 전용)→`POST /api/payapp/checkout`(price/credits 는 서버 allowlist `lib/credit-products` 로만 결정, 클라는 productId 만)→payurl 같은 탭 이동→결제→**웹훅 `POST /api/payapp/feedback`**(public).
- **데이터**(migration 0019 `payapp_orders`, service-role 전용): `order_uuid`(PK=var2)·`mul_no`(nullable unique)·status(pending/paid/canceled/failed)·amount/credits snapshot. checkout 이 pending 선삽입(웹훅 선도착 대비)→payrequest→mul_no/payurl update. 같은 user+product 최근 10분 pending 재사용으로 중복 주문 방지.
- **멱등·검증**: 웹훅은 `linkval`·price·`var1==order.user_id`·mul_no 정합 검증(외부 입력 불신, DB=source of truth). 지급은 RPC `mark_paid_and_grant`(security definer, FOR UPDATE)로 **원자·멱등**(첫 통보만 paid+`gen_credits += credits`, 대상=order.user_id). 검증된 이벤트는 모두 텍스트 `"SUCCESS"`(JSON 금지) — 실패 시 페이앱 최대 10회 재시도.
- **복귀/UX**: `skip_cstpage=y`라 페이앱이 returnurl 로 POST → `/api/payapp/return`(303)→`/credits/done?order=` → `/api/payapp/order-status` 폴링(본인 주문만)으로 paid 확인. recvphone 더미+`smsuse=n`. `/generate` no_credits·AccountMenu 가 `/credits` 로 안내, `proxy.ts` 가 `/credits` 회원 게이트.
- **환불(v1 수동)**: 페이앱 관리자 취소→웹훅 `status='canceled'`(paid_at 유지, **크레딧 자동 회수 없음**, 운영자 수동). 테스트는 prod 실결제→환불(샌드박스 없음·웹훅 공개 HTTPS 필요). 규모 확대 시 여친 명의 간이사업자+토스 전환 경로(별도).

v0.20 (2026-06-23, 관리자 대시보드 + 모니터링 고도화):
- **권한** `member_accounts.is_admin`(0020, emfoa23 seed). `requireAdmin()` = requireMember + is_admin **별도·관용 조회** → 0020 미적용이어도 기존 회원/결제 흐름 무영향, `/admin` 만 비활성.
- **/admin**(RSC `force-dynamic`): 매출·주문(KST today/7d/30d·상태별)·가입구매 퍼널·최근주문·오래된 결제요청. 정확 수치는 DB.
- **운영 액션+감사**(0020 RPC, row lock·멱등·`admin_actions_ledger`): stuck 지급(결제완료 확인 후)·환불표시(회수 clamp-0)·CS 조정(회원만·−100~100·≠0·사유).
- **대사 알림**: `/api/ops/reconcile`(`x-cron-secret`) — mul_no 있는 pending 2h+ "확인 필요"(자동지급 X). cron-job.org 직접 호출.
- **Sentry**: payapp 스팬(`/api/payapp/*` 전수)·저카디널리티 태그(payapp.status/product·gen_stage·last_action)·`CAPTURE_SKIP`(고볼륨 warn logs-only, 에러쿼터 보호)·결제 critical 즉시/프로브 rate-based(룰=로컬 토큰, **앱 런타임 env 금지**). 알림 dev.jangahn+emfoa23.

v0.21 (2026-06-24, 어드민 전면 개편 + 페이앱 자동환불):
- **멀티 라우트 어드민**(`app/admin/layout.tsx`+`AdminNav`): `/admin`(대시보드+환불 경고) · `/admin/orders`(전체 주문·상태/검색·10p) · `/admin/users`(부분검색→유저 상세[결제·콘텐츠·회원정보·CS조정], 각 10p) · `/admin/ledger`(처리내역·필터·10p). 공용 `Pagination`(맨앞/맨뒤) + `/history`도 적용. 가입 무료 크레딧 5→2.
- **페이앱 자동환불(0023)**: 어드민 환불 → `paycancel` 자동취소 + 크레딧 회수. **회수 부족 시 차단**(선검사), 정산마감(D+5)은 "수동 필요", 경쟁상황은 clamp+shortfall. `refund_state`(CAS 단일플라이트·고착·복구). 커밋실패=`payapp.refund_commit_fail`(money-critical)→대시보드 경고+'환불 재시도'(멱등). `admin_cancel_order` 5-arg + 4-arg wrapper(무중단).
- 읽기 RPC(`search_orders`/`search_members`/`get_user_generations`) + `admin_cancel_order` 모두 `service_role` 전용(revoke/grant). 적대적 리뷰(PR별 워크플로우)로 검증.

v0.22 (2026-06-24, 갤러리 비회원 개방 + 기본부장님 후킹 — 가입 전환; 마이그레이션 없음):
- **갤러리 비회원 개방**(`proxy.ts` 에서 `/gallery` 게이트 제거 — 생성/충전/관리자는 회원 전용 유지): 비회원도 갤러리 진입 가능. 3-state 뷰어(`getMyProfile().isMember`+`dolls.length`) — 비회원 / 회원·0캐릭터 / 회원·有캐릭터.
- **기본부장님 카드 상시 노출**(맨 앞 '기본' 뱃지, `components/gallery/DefaultBossCard.tsx`): 이미지 클릭=기본부장님 플레이(`/play`). 비회원·0캐릭터에겐 ⋯ 메뉴([공유, 롤 변경], 삭제 없음)가 후킹 토스트+CTA(`HookToast`)로 가입/생성 유도. 캐릭터 보유 회원에겐 play 전용(메뉴 없음). DB row 가 아니라 실 공유/PATCH/DELETE 는 호출 안 함.
- **상태별 가입 후킹**: 비회원=배너 "가입하면 생성권 1개"(→`/login?next=/generate`), 회원·0캐릭터="첫 캐릭터 만들기"(→`/generate`). 토스트·배너·헤더버튼 공용 헬퍼(`lib/gallery-cta.ts`).
- 비회원은 생성권·진행중 생성(`/api/generations`) 모두 미요청. 갤러리 472줄 → `components/gallery/` 모듈 분리(DollCard/PendingGrid 동작 보존 이동).

v0.23 (2026-06-24, 마케터 콘텐츠/설정 콘솔 — substrate; 6-PR 초기 PR1):
- **설정 substrate(0025)**: `app_settings`(도메인 key→jsonb)+`app_settings_audit`+`admin_update_app_setting`(CAS+감사 원자 RPC). **server-only**(anon/auth revoke, 주방어=requireAdmin+service_role). `lib/config`(async getter 2종·코드 기본값 폴백·`unstable_cache`+태그). `/api/config/public`(최소 projection)·`/api/admin/config`(Zod+RPC). `/admin/content` 셸 + `AdminNav` 콘텐츠 탭. **소비자 무변경**(config 미시드 시 코드 기본값). 도메인 에디터·소비자 전환은 후속 PR.

v0.24 (2026-06-24, 마케터 콘솔 PR2 — 마케팅 카피 도메인; 마이그레이션 없음):
- **`marketing_copy` 도메인**: 홈 화면(태그라인·CTA·고지)·가입 배너 문구를 `/admin/content/marketing_copy` 에서 편집. `lib/config/domains/marketing.ts`(schema+코드 기본값) + `getMarketingCopy()` getter + 레지스트리 등록. **루트 레이아웃 async 주입 → `MarketingCopyProvider`(client 컨텍스트)** → 홈(`app/page.tsx`)·`SignupBanner` 가 read-or-default. 정적/ISR 라우트 유지(빌드 확인). 적대적 리뷰 실 결함 0(카피 12개 verbatim·하이드레이션 정합·async 레이아웃 무영향).

v0.25 (2026-06-24, 마케터 콘솔 PR3 — 롤 tiered 콘텐츠; 마이그레이션 없음):
- **`role_content` 도메인**: 5롤 × 시비멘트/반응/OG/인사기록/호칭/ctaSafe 를 `/admin/content/role_content` 에서 편집(5롤 탭, 점수 10단계 칸). `lib/config/domains/roles.ts`(schema `length(10)`·tier당 ≥1·5롤 + 코드 기본값=현 콘텐츠 byte-identical) + `roleFrom(role, cfg?)` 폴백. 소비자=선택적 cfg 주입(`report`/`taunts`/`weapons`/`doll-share`): 서버 OG·doll=`getRoleConfig()`, 클라 시비멘트·반응·라벨=`RoleContentProvider`(라이브). 적대적 리뷰 실 결함 0(카피 byte-identical·10-tier 가드+폴백·무순환·하이드레이션). gallery 칩·역할선택·토스트·히스토리·어드민 유저표 호칭도 `roleFrom`(DB 발행) 일원화 완료(ROLE_META=fallback).

v0.26 (2026-06-24, 마케터 콘솔 PR4 — 점수 등급; 마이그레이션 없음):
- **`score_config` 도메인(등급만)**: 점수 10단계 등급 라벨/한 줄 평('패기 유형')을 `/admin/content/score_config` 에서 라이브 편집. `gradeFor(score, grades?)`(코드 기본값 폴백) + `ScoreConfigProvider`(클라)/`getScoreConfig()`(서버 share·history). tier 간격(step)·매핑은 코드 고정(step 조절+과거결과 동결은 PR5 play_sessions 와 함께). 적대적 리뷰 실 결함 0(등급 byte-identical·OOB 안전·무순환).

v0.27 (2026-06-24, 마케터 콘솔 PR5 — 세션 한도 + 강제 종료):
- **`session_limits` 도메인 + 강제종료 신규 게임플레이**: 최대 플레이 시간/점수 도달 시 자동 종료→결과. 한도는 게임 시작 시 ref 동결, 0.5s 폴링→배너→4s grace(궁극기 마무리)→one-shot 종료(grace 타이머 정리로 재시작 race 차단). 기본값=hard cap(무변경). `scores.end_reason`(0026) 기록, 제출은 기존 clamp 가 커버(거부 0). 편집=`/admin/content/session_limits`. 적대적 리뷰 1 MED(orphan grace timeout) 반영.

v0.28 (2026-06-24, 마케터 콘솔 PR6 — 성장 레버(가입 생성권·가격); 마이그레이션 없음):
- **`growth_levers` 도메인(머니 패스)**: 가입 기념 생성권 개수 + 충전 상품(개수·가격)을 `/admin/content/growth_levers` 에서 편집(발행 확인 단계). 체크아웃(`/api/payapp/checkout`)이 **서버 config 의 active 상품 재조회로 price/credits 결정**(클라 조작·비활성 구매 차단), 기존 주문 스냅샷 무관. 가입 grant=config 값(callback `ignoreDuplicates` 멱등). price 1,000(페이앱 floor)~100,000원·productId 불변/중복거부. `/credits`=`CreditProductsProvider`(active만). 적대적 리뷰 실 결함 0(머니 불변 전부 hold).

v0.29 (2026-06-24, 마케터 콘솔 PR7 — 뱃지 카탈로그; 마이그레이션 없음):
- **`badge_catalog` 도메인**: 카테고리(7종)·뱃지 임계값/개수/라벨/활성을 `/admin/content/badge_catalog` 에서 편집. 달성값 계산은 코드(`FAMILY_VALUE`), slug 불변 동결→임계값 변경해도 `user_badges` 고아 없음. 인증 grant(`/api/score`)·컬렉션·챌린지·strip 전부 카탈로그 구동(서버 getBadgeCatalog / 클라 `BadgeCatalogProvider`/prop). active=false 만(하드삭제 없음·획득 보존). `lib/badges.ts` 삭제→`lib/config/domains/badges.ts` 단일 소스. 적대적 리뷰: grant **byte-identical**(무회귀)·소비자 완비·trust-boundary 하드닝(families 유니크·int).

v0.30 (2026-06-24, 콘텐츠 콘솔 개편 — 가시화·CTA 흡수·롤 호칭 단일화·뱃지/성장레버 편집; 마이그레이션 없음):
- **롤 호칭 단일화**: 롤당 `label`(호칭) 1개만 입력 — `noun/targetObj/ctaSafe/chip` 제거. 을/를·은/는·으로/로·갤러리 칩을 `josaEul/josaEun/josaEuro`(lib/roles)로 파생. boss 출력 **바이트 동일(회귀0)**, coworker `직장동료→동료`·teamlead 목적격 `팀장을→팀장님을`은 의도된 통일.
- **마케팅 CTA 흡수**: `resolveCopy`(`lib/config/template`, 클라/서버 공용 순수) — `{호칭}`(조사 자동) + 값 토큰(`{제작자}/{점수}/{등급}/{특이사항}` 코드 합성). marketing 도메인에 **`share` 그룹 신규**(인사기록·점수공유·게임오버 CTA·웹공유·OG title/desc). 홈 태그라인/고지는 단일 멀티라인(개행 인식), 갤러리/랭킹 링크는 코드 리터럴(콘솔 제어 제거). 저장 시 미지 `{...}` 토큰 거부.
- **콘텐츠 탭 가시화**: 도식형 주석 레이아웃(`SurfaceDiagram`, 5표면) + 필드 포커스 시 영역 하이라이트 + `{호칭}` 필드 **5롤 치환 라이브 미리보기** + OG 캐시(발행 후 이미지·제목 최대 1h 지연) 안내.
- **뱃지 자유 편집**: slug 편집 잠금 해제 + **하드삭제**(획득 영향도 `user_badges`/`score_stats` 카운트 경고 모달) + family 내 **▲▼ 순서변경**. **성장레버**: 상품 **개당 단가** 표시 + **▲▼ 순서변경**. (표시=배열 순서 → 재정렬만으로 반영.)
- 검증: boss 골든 바이트 동일 · typecheck/lint/build 0 · `app_settings` 0행 전제(스키마 변경 SQL 무필요).

v0.31 (2026-06-25, 마케팅 카피 페이지 정밀 다듬기 + 롤 OG desc 정리; 마이그레이션 없음):
- **마케팅 콘솔 IA 일치**: 그룹/도식을 실제 UI 순서·용어로 통일 — `{대상} 공유 카드`/`{대상} 공유 미리보기 (OG)` 일괄 패턴(캐릭터·점수). 웹 공유 텍스트는 공유 후 노출이라 **OG 그룹**으로 이동, OG 영역 순서=이미지(+푸터 후킹)→제목→설명→웹공유. 갤러리 헤더 버튼 라벨 "모든 방문자"(전 상태 노출 반영).
- **보고서 제목 코드 고정**: `reportTitle` config 제거 → "스트레스 해소 결과 보고서" 코드 고정(캐릭터 카드 "인사기록카드"와 결 맞춤). "공통" 그룹 삭제.
- **롤 ogLines 제거 → 마케팅 단일 `scoreOgDesc`**: 점수 공유 OG 설명을 롤별 10단계(`ogLines`)에서 **롤 무관 단일 값**(토큰 지원 `{호칭}`+`{점수}`/`{상위}`/`{등급}`)으로. share og:description=`resolveCopy(scoreOgDesc, …)`. 롤 에디터에서 OG 후킹 칸 제거.
- **무중단**: 발행된 `marketing_copy`(reportTitle)·`role_content`(ogLines) 잔여 키는 Zod `z.object` strip → 신 스키마로 valid(추가 마이그레이션 불필요). `scoreOgDesc` 는 `.default()` 로 발행행 자동 충전.
- 검증: golden(scoreOgDesc 토큰 치환·발행행 strip·boss 기본값 회귀) · typecheck/build 0 · 점수 og:desc 는 롤 ogLines→단일값으로 **의도된 변경**.

v0.32 (2026-06-25, 롤 대사 에디터 본문 중심 미리보기; 마이그레이션 없음):
- **롤 에디터를 마케팅 에디터와 같은 인터랙션으로**: 상단 sticky 도식 밴드 + 필드 포커스 시 해당 화면 영역 하이라이트. 단 마케팅은 CTA가 주역이지만 롤은 **본문(직급/소속/특이사항/피격 반응)이 주역** → 본문을 edit-tone, 후킹/CTA는 "마케팅 카피에서 관리" 축약 ctx 로 무게중심 반전.
- **섹션 순서 = 실제 카드 위→아래**: 호칭(상단 별도, 파생 조사형 한 줄 미리보기) → 직급 → 소속 → 특이사항 → 피격 반응 → 시비 멘트(플레이 말풍선이라 맨 밑). 무의미해진 `defaultSafeHook` "공유후킹" 미리보기 줄 제거.
- **미리보기 4면**(캐릭터 공유 카드·점수 공유 카드·게임 종료 화면·플레이 화면, `RoleSurfaceDiagram`/`ROLE_FIELD_SURFACE`) — 피격 반응은 점수 공유+게임 종료 2면 동시 하이라이트. 용어는 마케팅 페이지와 일치.
- `role_content` 스키마·저장 경로 불변(순수 에디터 UI). 마케팅 `SurfaceDiagram`/`FIELD_SURFACE` 불변(저수준 렌더만 공유 추출). typecheck/build 0.

v0.33 (2026-06-25, 어드민 법무 문서(이용약관·개인정보처리방침) 관리 + 공개 페이지; Migration 0029):
- **전용 메커니즘**(config 콘솔과 분리): `legal_documents`(버전 행·시행일·draft/published) + `legal_documents_audit`. 2종 고정(privacy·terms), 섹션 배열(제목+본문) **plain text** 렌더(markdown/HTML 파서·`dangerouslySetInnerHTML` 금지 — 주입 차단).
- **예약 발행**: 미래 시행일 가능, 공개 페이지는 **KST 기준 `effective_date<=오늘` 최신본**을 자동 노출(cron 불필요, `force-dynamic`). 예정본은 "○일 시행 예정 — 미리보기" 사전 고지, 시행일별 개정 이력 공개(`?v=` **published 만**).
- **발행본 + 편집 초안 분리**: 문서당 초안 1개(부분 유니크), 발행=append-only 새 버전. RPC 하드닝(advisory lock·KST·미래 예약본 1개·무변경 차단·내부 admin 재검증·security definer). 전수조사 초안(방침 15섹션·약관 16조, 확정 정책[14세+·수동탈퇴·마케팅X·법정환불·탈퇴까지보유] 반영)을 draft로 시드(운영자 정보·시행일 placeholder → 운영자가 채워 발행).
- 어드민 `/admin/content/legal`(섹션 ▲▼·공개 개정사유/내부 메모 분리·미리보기·발행 무변경 비활성). 공개 `/terms`·`/privacy`(홈 푸터 링크). 신규 전용 → 기존 기능 영향 0.
- 검증: 시드 2건·발행 RPC 6분기(즉시/무변경/예약/예약중복/과거/비admin) 롤백 테스트·RLS anon 차단·typecheck/build 0.

v0.34 (2026-06-25, 법무 이행 공백 핵심 3 — 계정 탈퇴·결제기록 보존·만14세 게이트; Migration 0030):
- **원칙: 법정 필수 최소만 구현, 구현 안 한 건 약관/방침에서도 약속 안 함.**
- **계정 탈퇴(soft-delete)**: 셀프 즉시(`profiles.deleted_at`), **`auth.users` 삭제 안 함**(삭제 시 결제기록 CASCADE 파괴). 캐릭터 이미지·하이라이트·본인 업로드 avatar는 DB 탈퇴 트랜잭션에서 cleanup manifest/outbox로 먼저 고정하고, `display_name`="탈퇴한 사용자"·`avatar_url`/`member_accounts.email`·동의시각/버전=null·`gen_credits`=0·`reconsent_required=true`, `scores`는 비식별 보존한다. Auth/Storage 정리가 실패하거나 요청이 중단돼도 `content-maintain`이 final sweep까지 fenced lease로 재시도한다. 재로그인·늦은 child write는 profile lock과 DB trigger로 차단한다. UI=AccountMenu "계정 삭제" 2-step 모달. `/api/account/delete`(same-origin·pending 결제 409·DB 먼저).
- **결제기록 법정 보존**: soft-delete로 profile 잔존 → 자동 보존 + **`payapp_orders.user_id` FK CASCADE→RESTRICT**(2중 방어). `mark_paid_and_grant` 가드(탈퇴자=paid 기록·크레딧 미지급·`error_message='account_deleted_no_grant'`·webhook 경고). `raw` 방어적 PII redaction(linkval/linkkey + 구매자 연락처류).
- **만14세 게이트**: 이 버전은 DOB·보호자 동의 없이 `member_accounts.age_confirmed_at`을 `/api/account/confirm-age`에서 따로 받았다. 현재 해당 route는 제거됐고 `/consent` + `POST /api/account/consent`가 만14세 이상 확인·약관·방침의 정확한 발행 버전을 한 번에 기록한다. DOB는 수집하지 않고 만14세 미만 가입은 지원하지 않는다. fal.ai 전송은 이와 별도로 만19세 이상·ToS·AUP의 불변 acceptance receipt를 요구한다.
- 문서: 이 시점의 감사·자동환불·모더레이션 후속 목록은 현재 계약이 아니다. 생성 실패 환급은 원자 generation lifecycle과 cron으로 구현됐고, 신고·가역 숨김·복구·fenced 영구삭제 및 signed-upload orphan 정리는 각각 후속 migration에서 구현됐다. 만14세 미만은 서비스 대상이 아니므로 법정대리인 가입 동의 플로우를 제공하지 않으며, 법정대리인의 권리행사 창구는 법무 v2 정본에 명시한다.
- 검증: 마이그 롤백 테스트(soft-delete·FK RESTRICT·pending 차단·탈퇴자 무지급·멱등)·typecheck/build 0.

v0.35 (2026-06-25, 로그인/회원가입 분리 + OAuth 단일 프롬프트 + 마이페이지·회원탈퇴 재배치; Migration 0031):
- **로그인/회원가입 분리**: 로그인은 14세 안 묻고 바로. OAuth 콜백이 신규 계정 판별 → `/signup` 동의(만14세+이용약관+개인정보처리방침 체크) → `/api/account/onboard` 가 member 생성(동의 `terms/privacy_agreed_at`·version 기록). 로그인 age 체크·생성 ConsentDialog age-14 제거(레거시 회원은 생성/결제 `age_required` backstop만).
- **OAuth 단일 프롬프트**: `linkIdentity` 제거 → 항상 `signInWithOAuth`(계정 선택 1회, 익명+기록일 때 이미 가입계정이면 2회 선택되던 문제 해결). 익명 데이터 보존은 **신규 가입 시에만 명시적 마이그**(`reassign_anon_data`: scores·user_badges·telemetry owner_id). 익명 id는 `prepare-signup`의 **HMAC 서명 쿠키**(위조 차단)로 추적, **모든 종료 경로에서 clear**(/signup 정상 경로만 유지). onboard 멱등(중복 크레딧 0)·이상 데이터 시 스킵·익명 정리 best-effort·new==세션 검증.
- **마이페이지 `/account`**(member-only): 닉네임·프사·**회원탈퇴**("계정 삭제"→"회원탈퇴", 하단 작게·2단계[고지 체크 + "회원탈퇴" 직접 입력]). 드롭다운은 충전·대시보드·뱃지·기록 유지 + "마이페이지" 링크.
- `safeNext` 강화(`/auth/*`·`/api/*`·`/signup` 제외 — open-redirect/loop 차단). 당시 적은 “미사용 익명 계정 일괄 정리 cron”은 현재 약속된 기능이 아니다. 익명 원본 owner/점수는 중복제출·이전 무결성 증거로 보존하고 telemetry·임시 업로드만 명시된 보존기한과 cleanup job으로 정리한다.
- 검증: `reassign` 롤백 테스트(scores·badges·telemetry 이전·멱등)·typecheck/lint/build 0.

v0.38 (2026-06-25, 콘텐츠 모더레이션 — 비동의 제3자 얼굴 신고/takedown 능력 Phase 1; Migration 0034):
- **단일 존재위협 해소**: 동의 없이 올린 제3자 얼굴이 `/doll`·`/share`·OG 로 공개 바이럴되는데 내릴 능력이 구조적으로 없던 결함(적대적 감사 지적).
- **신고 창구**: 공개 `POST /api/report`(**인증 불요** — 피해자는 보통 비가입 제3자), `/doll`·`/share`·`/history` 🚩버튼(doll 있을 때만 노출). 사유 allowlist·network actor 인메모리 보조제한 + 별도 DB reservation의 global 500/network 20 KST 일일 quota·stable receipt dedup을 함께 쓴다. 존재하지 않는 target 등 terminal core 거절도 opaque failed attempt로 캐시되어 같은 ID가 quota와 core를 반복 소비하지 않는다. 정확한 성공/실패 replay는 cap이 가득 차도 quota-free이며 payload가 달라지면 충돌한다. 신고 1건당 **Sentry 알림**(`report.new` — 자동숨김 없으므로 알림이 SLA, 어드민 deep link 동봉, 인증 없는 one-click 토큰 없음). 오프플랫폼 접수=공개 보호책임자 이메일(인프라 0).
- **takedown(어드민 수동·복구 불가)**: `/admin/moderation` 큐 + `/api/admin/moderation/{takedown,dismiss}`. `admin_takedown_doll` RPC(**멱등**·cascade로 그 doll 하이라이트 `highlight_deleted_at`·신고 actioned·`{bucket,path}` 반환) → 라우트가 storage 객체 **물리삭제**(public 버킷 origin 직링크 사망). 전부 성공만 `dolls.artifacts_purged_at`, **실패는 조용히 삼키지 않음**(Sentry+ledger metadata+어드민 "파일 삭제 확인 필요"+cron 재시도). **(→ v0.41: public 물리삭제 → private 가역 takedown 전환. 복구/영구삭제 분리, cron 자동 purge·"파일 삭제 확인 필요" 배너 제거.)**
- **공개 읽기 게이트 + invisible takedown**: `dolls.deleted_at` → 얼굴 자리를 **기본 부장님으로 대체**(`/doll` 페이지·OG·`/share`·`/history` — doll-less 점수와 구분 불가, **공유 화면에서 '신고/내려감' 여부 확인 불가**). `/doll`은 404 안 함(기본 부장님 카드). 갤러리(소유자)만 숨김. **점수/닉네임/랭킹은 유지**(cascade=얼굴 아티팩트만). 하이라이트는 기존 `highlightLive`(`highlight_deleted_at`) writer 연결로 자동 차단.
- **인접 cron**(`app/api/ops/content-maintain`, `x-cron-secret`=`CRON_SECRET`, cron-job.org 등록): 만료 하이라이트 purge 뒤 재활성 Auth-sync를 unbounded Storage/reviewer 작업보다 먼저 10초 단조시계 budget으로 drain하고, 이어 signed URL이 확실히 만료된 고아 `tmp/face` sweep(12분+)·계정탈퇴/모더레이션/Storage/reviewer durable job을 처리한다. 재활성은 due claim 결과뿐 아니라 RPC queue-health의 전체 pending/leased backlog와 sanitized failure correlation을 응답에 보존해 backoff·timeout job도 200 false-green으로 숨기지 않는다. OAuth prune은 exact 11-key(`expiredPending`, `boundRecoveryConverged`, `prunedTerminal`, `targetAuthorityLossConverged`, `targetAuthorityLossBacklog`, `pendingExpiryBacklog`, `terminalRetentionBacklog`, `unconsumedMigrationBacklog`, `unreleasedContinueBacklog`, `unboundClaimBacklog`, `boundRecoveryBacklog`)만 허용하며 일곱 backlog 필드 중 하나라도 양수면 429 non-green이다. lock skip은 batch limit을 소비하지 않고, terminal retention row가 이번 batch에서 지워지지 않은 경우도 실제 backlog로 남겨 200으로 숨기지 않는다. 미release continue와 미소비 익명이전은 자동 삭제로 숨기지 않으며 unbound claim은 signed lease 경계, bound claim/sign-out은 5분 recovery grace 뒤 자동 수렴한다. cleanup int4 최종 attempt/lease 실패는 `oauthAnonAuthCleanupFailed`와 privacy status `failures`로 503/non-green이다.
- **탈퇴 정책 보강(0034 §6, admin_soft_delete_account 재정의)**: 크레딧 0(전면 스크럽)과 일관되게 **탈퇴 시 하이라이트(얼굴 영상)도 삭제**(highlight_deleted_at render-block + account/delete 가 clip 객체 물리삭제) + 탈퇴로 hard-delete 되는 dolls 의 **미처리 신고 자동 종결**(고아 방지). **점수(숫자)는 익명 보존**(랭킹 무결성). takedown 은 doll 단위 cascade.
- **한계·Phase 2**: public 버킷이라 origin 삭제는 즉시지만 **CDN/브라우저 캐시 잔존 가능** → "완전 즉시 직링크 사망"은 Phase 2(`dolls`·`highlights` private+signed URL 전환) 후속. **→ v0.41 에서 구현 완료(private+signed, raw 직링크 400).**
- 검증: typecheck/build 0. **E2E·storage 직링크 사망 확인은 Migration 0034 적용 후**(읽기 게이트가 `deleted_at` 조회).

v0.39 (2026-06-25, 공유 페이로드 통일 — Web Share url-in-text·미디어 모바일한정; 마이그레이션 없음):
- **단일 공유 규약(`lib/share.runShare`)**: 점수·캐릭터 공유가 함수마다 다르던 url 배치·도메인·폴백·취소처리를 통일. **url 을 text 마지막 줄에 1개만 합성(분리 `url` 필드 폐기)** → macOS 네이티브 공유시트 Copy 가 `{url,text}` 를 구분자 없이 직렬화하던 결함(점수공유 복사 시 URL+문구 붙음) 근본 해소. OG 카드는 페이지 메타가 보장.
- **미디어 첨부는 모바일 OS 한정**(`lib/device.isMobileOS` — UA 기반, coarse pointer 아님): iOS/iPadOS/Android 만 이미지/영상 첨부, 데스크톱은 `canShare(files)` 무관하게 문구+링크(macOS pasteboard 다중표현 → 붙여넣기 이미지 중복 회피). **파일 공유 실패는 텍스트→클립보드로 자동 강등**(첨부 실패가 전체 실패로 안 이어짐), `AbortError`(취소)만 즉시 중단.
- **도메인 통일**: 캐릭터 공유 링크·워터마크 호스트를 `location.origin`→`PUBLIC_ENV.SITE_URL`(점수와 일치, 프리뷰/커스텀 도메인 누출 방지). 캐릭터 클립보드 폴백도 문구+링크(이전 url-only 문구 유실 수정).
- 검증: typecheck/lint(신규 파일 클린)/build 0. **카톡 OG 카드(url-in-text)·플랫폼별 직렬화는 실기기 매트릭스(M1~M4)로 사용자 확인.** 참고: 카카오는 OG 를 캐싱 → 발행 후 `https://developers.kakao.com/tool/clear/og` 로 해당 `/share` URL 초기화.

v0.40 (2026-06-25, 하이라이트 영상 공유 + 공유문구 어드민화 + 콘솔 재구성; 마이그레이션 없음):
- **하이라이트 영상 공유(모바일)**: 게임 종료 화면(로컬 blob)·이전 플레이 기록(업로드 clip lazy fetch)에서 하이라이트가 있으면 **영상+문구+링크**를 함께 공유. `runShare` 게이트로 모바일만 첨부, PC 는 문구+링크. 이전기록은 버튼 탭 시 영상 fetch → user activation 끊겨 share 막히면 문구+링크로 자동 강등. `/share` 의 HighlightPlayer(영상 공유·저장)는 현행 유지.
- **공유 문구 어드민화**: `marketing_copy.share` 에 게임종료/이전기록 각각 {하이라이트 없을 때 버튼·있을 때 버튼·웹 공유 텍스트} 추가(`gameoverShareBtnHighlight`·`historyShareBtn`·`historyShareBtnHighlight`·`historyShareText`, additive `.default` → 발행행 무중단). 기존 하드코딩 라벨/문구 제거(게임종료 하이라이트 버튼·history 버튼/문구). `scoreShareText` 키는 **유지**(게임종료 웹텍스트로 재배치만, 발행값 보존). 웹공유텍스트 3종은 **raw URL 저장 차단**(`tplNoUrl` — helper 가 url 1줄 자동 부착).
- **마케팅 콘솔 재구성**: 섹션 순서 = 게임종료 → 이전 플레이 기록(신설) → 점수 공유 카드 → 점수 공유 미리보기(OG). `SurfaceDiagram` 에 게임종료/이전기록을 **하이라이트 유/무 별도 표면**(갤러리 배너 패턴)으로 분리, OG 제목 "(메타)" 표기 제거.
- **OG desc 는 코드 정상**(라이브 `og:description` = 발행 `scoreOgDesc` 치환 확인) — 어드민 변경이 "안 들어가는 것 같음"은 **카카오 OG 캐시**(발행 후 위 clear/og 툴로 초기화). OG 이미지엔 desc 가 아니라 `scoreHook` 이 렌더됨.
- 검증: typecheck/lint(신규 클린)/build 0. dev 에서 history 공유버튼 라벨이 발행 config(하이라이트 유/무: "🔥 하이라이트 공유"/"결과 보고서 공유") 정상 반영 확인. 영상 첨부·플랫폼 직렬화는 실기기(M1~M4).

v0.41 (2026-06-25, Phase 2 — `dolls`·`highlights` private 버킷 + 가역 takedown + 복구/영구삭제; Migration 0035·0036):
- **private 전환으로 takedown 가역화**: `dolls`·`highlights` 버킷을 `public=false` 로 플립. takedown = `deleted_at`(신규 signed URL 발급 중단)만 — storage 객체 보존 → **오삭제 복구 가능**. raw 공개 직링크 사망(`/object/public/...` 400). avatars 는 public 유지. **⚠️ 이미 발급된 signed URL 은 TTL(doll 10분/clip 15분) 동안 생존** — deleted_at/플립은 "신규 발급 중단"만(즉시 일괄무효화 아님). 외부(카카오 등) OG 캐시도 우리 권한 밖(필요 시 OG 캐시 초기화 툴로 해당 share/doll URL purge).
- **읽기 전 표면 signed URL**: 헬퍼 `lib/storage-path.ts`(순수 `dollPath`·client 안전)는 확정 `{owner UUID}/{doll UUID}.png`와 후보 `{owner UUID}/candidates/{generation UUID}/{0..2}.jpg`, 그리고 그 경로를 담은 레거시 Supabase HTTPS URL만 받아 임의 URL·dot traversal·인코딩 separator·비정규 key를 거부한다. `lib/storage.ts`는 server-only `signedDollUrl`/`signedHighlightUrl`과 ttl을 담당한다. 서버: doll page/OG·share page/OG·history 상세·score-detail(clip)·admin(모더레이션/회원). 클라: **`POST /api/doll/signed-urls`**(id 로 DB 조회한 canonical path만 서명·UUID·ids≤50·deleted 제외·no-store·IP rate-limit·`createSignedUrls` 배치) → useGameInit(ttl 3600)·gallery(50청크·실패 시 기본 보스 강등)·`/api/generations`(후보 우리버킷/fal 분기 서명·ttl 6h). write(`api/doll`·`generation-recovery`)는 경로 저장, 삭제 핸들러(doll DELETE·account/delete)는 `dollPath`.
- **복구·영구삭제 어드민**: `/api/admin/moderation/{restore,permanent-delete}`. restore=이 takedown 이 숨긴 하이라이트만 되살림(`highlight_deleted_by_doll` 태깅·만료 등 다른 숨김 불간섭). permanent-delete=artifact purge(storage 객체 제거·dolls row 보존), `hidden`+`moderationVersion` CAS와 stable request UUID 영수증 뒤 0078 fenced job을 시작한다. **전부 성공만 purged**·실패 path 추적·동일 모달 재시도는 같은 job으로 수렴한다. 모더레이션 큐에 [복구][영구삭제] 버튼(purged 면 "복구 불가"). takedown 라우트는 물리삭제 제거(가역) + `revalidateDollSurfaces`(doll/share/history+OG 무효화). cron 자동 purge 백스톱 제거.
- **캐시(현재 하드닝 반영)**: private Storage signed URL이 HTML에 박히는 `/doll`·`/share`·history 상세는 `force-dynamic`으로 요청마다 새 URL을 발급한다. `revalidate` 주기를 TTL보다 짧게 잡아도 장기간 무방문 뒤 첫 요청에는 stale HTML이 먼저 나갈 수 있기 때문이다. doll/share OG와 공개 leaderboard도 제작자 탈퇴·source quarantine/scrub 직후 이전 identity/highlight를 다시 노출하지 않도록 `force-dynamic`·`revalidate=0`·`private, no-store`와 CDN별 `no-store`를 사용한다. takedown/restore/permanent-delete는 관련 동적 경로도 명시 무효화하고 HighlightPlayer/공유 버튼은 만료 시 카드/문구+링크 fallback한다. 외부 플랫폼의 OG 캐시는 우리 무효화 권한 밖이므로 플랫폼별 cache purge가 별도 운영 경계다.
- **검증**: 사전검증 G1(public 버킷 createSignedUrl 200)·G2(signed URL `ACAO=*` → WebGL/녹화 무taint) 통과. 적대 검증(8 확정·전부 medium/low) 반영(갤러리 fallback·관측성·만료가드·에러코드). 무중단 롤아웃(코드 배포→flip前 검증→flip→flip後 검증), flip後 전 표면 200·raw public 400 확인.

v0.42 (2026-06-25, 회원 재활성 — 본인 요청 시 운영자 계정 복구(데이터 미복구); Migration 0037):
- **탈퇴 복구 능력**: 탈퇴(0034 §6)는 `profiles.deleted_at`·익명화·`gen_credits=0`·이메일 스크럽 + dolls/하이라이트/Storage 물리삭제이나 **auth.users 는 보존**(결제 FK) → 같은 OAuth 재로그인이 `deleted_at` 게이트(`requireMember` 등)에 막혀 재가입 불가였음. **재활성 = `deleted_at` 해제**(`admin_reactivate_account` RPC) — `auth.identities` 의 원본 닉/프사/이메일 즉시 복원, `gen_credits=0`·`age_confirmed_at` 유지. **캐릭터·하이라이트·생성권은 이미 영구삭제 → 복구 안 됨**(계정만 부활).
- **본인요청·운영자·사유 필수**: 어드민 회원 상세에 탈퇴 배지 + `ReactivateAccountForm`(신원확인·데이터미복구 2-체크 + 사유 + 과거점수 실명 재노출 경고). `/api/admin/reactivate`(requireAdmin). 탈퇴자는 스크럽돼 search_members 로 못 찾으므로 **원본 이메일 검색**(`admin_find_withdrawn_by_email`, auth.identities). 이메일 복원 전 **타 활성계정 email_conflict 검사**. identities 이메일 없으면 어드민 입력 override 또는 `identity_email_missing` 중단.
- **재로그인 시 재동의(연령 제외)**: 재활성이 `member_accounts.reconsent_required=true` + 동의 클리어 → `requireMember` 가 모든 member 경로 차단(reconsent 경로만 예외), 콜백/페이지가 `/reconsent` 로 유도 → `{terms, privacy}` 재동의(`age_confirmed_at` 유지). **"동의 stamp null" 이 아닌 명시 플래그**로 게이트 — 동의흐름 이전 생성 레거시 회원(현재 전원 stamp null) 락아웃 방지.
- **법무 정합**: 약관 제5조(재이용 제한 + 본인요청 운영자 복구·데이터 미복구)·방침 제13조(CASCADE 오기→실제 soft-delete/익명보존) 개정(예약본 v1·초안 v0·`_local` md). 탈퇴 UI 문구도 "데이터는 되돌릴 수 없음·재이용은 고객센터 문의"로 정합.
- **검증**: typecheck/lint/build 0. RPC 복원/가드는 트랜잭션 rollback e2e(prod 무변경)로 확인(닉/프사/이메일 복원·credit 0·age 유지·reconsent 플래그·not_withdrawn). 어드민 세션(michael) UI e2e(탈퇴자 이메일 검색·상세 배지·재활성 폼 렌더). 안전: 활성 9명 전원 reconsent_required=false(락아웃 0).

v0.43 (2026-06-26, 로그인 bfcache 로딩 멈춤 수정; 마이그레이션 없음):
- **OAuth 뒤로가기 시 스피너 방치 수정**: 로그인 버튼 클릭→OAuth 페이지→**뒤로가기** 시 페이지가 bfcache(특히 모바일)로 복원되며 React `busy` 로딩 상태가 살아나 버튼이 스피너+disabled 로 멈춰있던 문제. `LoginForm` 에 `pageshow`(`event.persisted`=bfcache 복원) 리스너 추가 → `busy` 해제(버튼 재활성), 자동 재로그인(`?auto=`) 변형도 스피너 화면 풀어 버튼 노출. 클라 1파일·DB 무관. 검증: 클릭으로 stuck(disabled) 재현→pageshow persisted 디스패치로 재활성 확인.

v0.44 (2026-06-26, 프로필 사진 압축 수정 — 로딩 속도; 마이그레이션 없음):
- **아바타 webp→png 폴백으로 5~10배 비대 수정**: `lib/avatar.ts` `normalizeSquare` 가 `toBlob("image/webp")` 인데, webp 미지원 브라우저(일부 Safari/iOS)에서 **PNG 로 silently 폴백**(canvas 스펙 기본값) → 버킷 아바타 5개 전부 PNG 114~590KB(평균 ~400KB). 차원 캡(≤512px 정사각)은 동작했으나 포맷 폴백이 압축을 무력화 → raw `<img>`(24~44px 표시)에 400KB 전송으로 프사 로딩 느림.
- **JPEG 고정**: `toBlob("image/jpeg", 0.85)` + 흰 배경 flatten(알파 없음 대비). 512px 사진 ~40~80KB. 서버 `MAX_BYTES` 3MB→512KB(bloat 가드). 업로드 `cacheControl: 31536000`(콘텐츠-주소 URL 이라 immutable 안전; Supabase public 엔드포인트는 no-cache 서빙이나 작은 파일 재검증=304 저렴).
- **기존 백필(완료)**: 버킷 아바타 4개(michael 포함) PNG→JPEG 재인코딩 — 493→50·590→70·114→18·430→38 KB(**평균 ~88%↓**), 고아 PNG 1개(373KB) 정리. 버킷 5객체 ~2MB → 4객체 176KB. 원본은 `_local` 백업.
- 검증: typecheck/lint/build 0. 백필 dry-run→적용→HEAD(200·image/jpeg·18.5KB) 확인. 대부분(434명) 기본/OAuth 핫링크라 영향=커스텀 업로더만.

v0.45 (2026-06-26, 이미지 pop-in 페이드인 — `FadeImg`; 마이그레이션 없음):
- **이미지 늦게 채워지며 튀던 pop-in 완화**: 페이지(텍스트·고정 레이아웃)는 즉시 뜨는데 `<img>` 만 늦게 fetch 되어 갑자기 채워지던 문제. 공용 `components/FadeImg.tsx` 신설(placeholder[정적 회색/펄스] + 페이드인). 갤러리 `DollCard` 의 기존 패턴을 전 아바타·리포트 캐릭터 이미지로 일반화. 적용: 아바타(나브/랭킹/계정/히스토리, cover·gray)·캐릭터(doll·리포트, contain·pulse). 갤러리는 미변경(이미 처리).
- **페이드는 CSS 애니메이션**(`fade-in-img`): JS 로드감지(onLoad/decode/complete)는 SSR 하이드레이션·캐시 hit·cross-origin no-cache revalidate 레이스에서 미스되어 이미지가 opacity-0 로 **투명하게 멈출 수 있다**(특히 서버 컴포넌트가 렌더한 클라 아일랜드 미하이드레이션 — 디버깅으로 실측). CSS 는 하이드레이션과 무관하게 실행되고 `fill-mode` 없이 base opacity 1 로 두어 **애니메이션 미실행(reduced-motion·미지원)에도 항상 보임**(fail-safe). placeholder 제거만 onLoad best-effort(cover 는 img 가 덮어 무관).
- 차원 일관(고정 크기 wrapper)이라 CLS 없음. fallbackSrc 로 깨진 이미지는 기본 아바타/보스로.
- 검증: typecheck/lint/build 0. fail-safe(애니메이션 off→opacity 1) preview 실측. 페이드 자체는 헤드리스가 CSS 애니메이션을 frame0 에 멈춰 시각검증 불가(실 브라우저 정상) — 배포 후 실기기 확인.

v0.46 (2026-06-27, 로그인·가입·재가입·동의 흐름 전면 개편 — 통합 `/consent`; Migration 0041):
- **"동의까지 끝나야 로그인"**: OAuth 직후 동의 미충족이면 **로그인의 마지막·필수 단계** `/consent` 로만. 14세+약관+방침을 마쳐야 `member`. 중간 이탈은 비로그인(`ConsentGuard` 가 내비 시 `/consent` 로 수렴) — non-anon인데 미동의를 "반쪽 로그인"(닉/프사는 비회원인데 로그아웃 버튼)으로 노출하던 문제(클라 `isMember=is_anonymous` vs 서버 게이트 불일치) 제거. [로그아웃하고 다시 로그인]=쿠키 clear+signOut→계정 재선택(google `prompt=select_account`).
- **신규=재가입=레거시=구버전 통일**: `/signup`·`/reconsent`·`onboard`·`reconsent`·`confirm-age`를 단일 `/consent` + `POST /api/account/consent`로 통합(row 유무로 insert/update, 보너스·익명이전은 **신규 insert 1회** — `create_or_update_member_consent` RPC 트랜잭션). redirect stub과 410 shim은 rollout 당시 호환용이었고, 현재 deployable API surface에는 legacy `confirm-age` route가 없다.
- **버전 기반 재동의**: `member.terms_version`/`privacy_version` vs 현재 발행본(`getCurrentLegalVersions` `unstable_cache` + publish/unpublish 시 `revalidateTag('legal-versions','max')`). 14세도 로그인 직후 통합 → 생성/결제 `age_required` backstop 제거. 판정은 `lib/consent.missingConsentItems` **단일 소스**(서버 게이트·콜백·클라·`/consent` 공용). 발행본 미존재·조회 실패는 fail-open(단, 신규/미완료 계정 승격은 막음 — age·row 검사 항상 유효).
- **부수**: `ensureAuth` 동시성 안전(in-flight 합류 — 첫 진입 익명 세션 race 방지), 클라 `accountState`(anonymous/consent_incomplete/member) + 프로필 캐시 TTL 120s(개정 전파).
- **익명 Auth 런타임 계약**: 무료·무로그인 플레이의 점수/텔레메트리 저장은 `ensureAuth()`의 `signInAnonymously()`를 사용하므로 로컬과 hosted Supabase 모두 anonymous sign-in을 켜야 한다. 정본 `supabase/config.toml`은 이를 활성화하고 양수 rate limit을 유지하며, 단위 테스트가 설정과 클라이언트 호출의 동시 존재를 고정한다.
- 검증: typecheck/lint(신규 에러 0)/build 0. RPC e2e(트랜잭션 rollback) + dev/prod 스모크 green. 0041 prod 적용 완료.

v0.47 (2026-06-27, 동의 화면 약관 "보기" 수정 + 가드 공개페이지 허용; 마이그레이션 없음):
- **약관/방침 "보기"가 막히던 문제**: ConsentGuard 가 consent_incomplete 를 `/terms`·`/privacy` 에서도 `/consent` 로 되돌려 전문을 못 읽던 버그. **인라인 모달**로 전환(`/consent` 서버가 `getCurrentLegal` sections 를 ConsentForm 에 props 로 → `ModalShell`+`LegalDocView`, 네비게이션 0·체크 상태 보존·모바일 인앱브라우저 `_blank` 불안정 회피).
- **ConsentGuard 를 회원전용 페이지에만 작동**: `lib/routes.ts`(신규) `MEMBER_ONLY_PAGES` 단일 소스를 proxy·ConsentGuard 공유. consent_incomplete 도 **공개 페이지(비로그인 열람 가능: 홈·랭킹·플레이·갤러리·공유·약관·방침 등)는 전체 허용** — member 자원은 서버 `requireMember` 가 별도 차단하므로 enforcement 무약화.
- 검증: typecheck/build 0. dev 스모크(proxy 게이트 유지·공개 200·/terms LegalDocView 렌더=모달 데이터경로). 모달 시각은 consent_incomplete OAuth 세션 필요 → 실기기 확인.

v0.48 (2026-06-27, 동의 모델 전환 — lazy 게이트(로그인 자유, 회원기능 진입 시 동의); 마이그레이션 없음):
- **"동의 완료돼야 로그인" → "로그인 자유 + 회원기능 진입 시 lazy 동의 게이트"**: 콜백 `/consent` 강제·`ConsentGuard` 제거. OAuth 로그인하면 콜백이 **로그인 시 회원 생성**(보너스·OAuth 시드·익명이전, 동의 stamp 없음) → 바로 온전한 로그인(메뉴 닉/프사/크레딧/로그아웃). 동의는 회원 기능(생성·결제·마이페이지·어드민) 진입 시 검사 → 미동의면 `/consent`, **[돌아가기]→홈**(로그인 유지). v0.46/0.47의 consent_incomplete 비로그인 취급·ConsentGuard 폐기. (배경: Supabase PKCE 상 "동의 전 미인증" 불가 — 교환=인증. 세션 커밋 지연은 결을 거스름 → lazy 게이트 채택.)
- **클라 상태 분리(I1)**: `isMember` 폐기 → `isLoggedIn`(메뉴) + `consentPending` + `canUseMemberFeatures`. 서버 `requireMember`=동의완료 회원 게이트 유지(미동의→`consent_required`).
- **게이트 누락 audit(I5)**: 회원 자산 API 전수 requireMember — `doll`(전 메서드)·`generations` 승격. **`account/delete`는 `requireAuthedNonDeleted`**(탈퇴=권리, 미동의 허용; `/account` 미동의 시 최소 폴백). `payapp/feedback`은 public webhook(requireMember 금지). 아래 gate list.
- **익명이전 보수화(I4)**: is_new(신규 생성) 1회만, 기존 회원 병합 안 함. MIGRATE_COOKIE 콜백 성공/로그아웃 clear + 생성 실패 시 유지(consent API INSERT 복구). 신규 `POST /api/auth/signout`(쿠키 clear).
- ⚠️ **법적**: 동의를 기능 진입으로 미뤄 privacy 동의 전 OAuth PII 저장(인지·감수). 로그인 화면 최소 고지 추가, **약관/방침 문서에 lazy consent 반영은 별도 과제**.
- 검증: typecheck/lint(신규 0)/build 0. RPC e2e(rollback: 로그인 all-false→INSERT 보너스·stamp null / 동의→UPDATE stamp). dev 스모크(anon→member_only·proxy·signout·공개 200). consent-pending 게이트 실동작은 실기기/어드민 세션.

**member feature gate list (lazy 동의 모델)**:
- `requireMember`(동의완료): fal · doll(POST/GET/DELETE/PATCH) · generations · avatar · payapp/checkout · payapp/order-status · admin/*(requireAdmin)
- `requireAuthedNonDeleted`(로그인만·동의 불요): account/delete(탈퇴) · /api/account/consent · /consent
- public webhook(인증 금지·linkval/order 검증): payapp/feedback · payapp/return
- 공개(게이트 없음·조회/공유): leaderboard · score · doll/signed-urls · highlight · report · gallery 열람 · config/public · auth/prepare-signup · /api/legal/versions
- 클라 진입 가드(consentPending→/consent): /generate · /credits · /admin(RSC) · /account(최소 폴백)

v0.49 (2026-06-28, 동의 모델 재전환 — 글로벌 게이트(렌더 전)·회원생성 동의 시점; 마이그레이션 없음):
- **"lazy 게이트(회원기능별 제각각)" → "글로벌 게이트(proxy, 모든 페이지 렌더 전)"**: lazy 의 페이지별 클라 가드(깜빡임·갤러리→/login·마이페이지 폴백 등 불일치)를 폐기. **로그인+미동의면 `proxy.ts` 가 모든(비예외) 페이지 진입을 렌더 전 `/consent` 로**(뒤로가기·직접URL·클라내비 우회 불가, [동의]/[로그아웃]만). 단일 규칙(`lib/consent.missingConsentItems`)을 게이트·`requireMember`·`/consent` 공유.
- **회원 생성·보너스·OAuth 시드·익명이전 = 동의 시점**(로그인 시 아님): 콜백은 회원 안 만들고 동의여부만 판정해 미동의→직접 `/consent`, 동의완료→목적지. → 서비스 사용(생성·결제) 전 동의 강제 → 법적 우려 대부분 해소(로그인 고지 문구 제거; OAuth 이메일 저장만 잔존). `/account`·`/admin` 도 글로벌 게이트(lazy 의 동의-무관 예외 폐기).
- **클라 단순화**: `lib/profile` 에서 `consentPending`·`canUseMemberFeatures` 제거(서버가 게이트) → `isLoggedIn`+`genCredits`+`isAdmin` 만. generate/credits 마운트 동의 가드 제거(action `consent_required` 핸들러만 유지), account 폴백 제거, gallery `isLoggedIn` 기준, `/consent` [돌아가기]→**[로그아웃]**.
- **적대 리뷰 반영(운영 안전)**: matcher 정적/`_next` 제외(GET/HEAD만 게이트) · `/login` anon 전용 · callback 직접 `/consent` · POST/Action 은 endpoint `requireMember` · member 실패=fail-closed/버전=fail-open · **deleted 세션=auth 쿠키 만료+`/login`**(루프 방지) · webhook pass-through · redirect 쿠키보존+no-store · signout server `auth.signOut`+쿠키 만료 · edge-safe 버전리더(`lib/legal/edge-versions`, isolate 60s) · `missingConsentItems` `<` 비교(버전 divergence 루프 방지) · `lib/cookies`(MIGRATE 이름 edge 공용).
- 검증: typecheck/lint(신규 0)/build 0(edge proxy 번들 OK). anon 스모크(공개 200·회원전용→/login·정적 미redirect·webhook 200). edge-versions ≡ `/api/legal/versions`(`{terms:1,privacy:1}`). `missingConsentItems` 단위 케이스. 로그인 미동의 게이트 실동작은 preview 실로그인.

**member feature gate (v0.49 글로벌 게이트)**:
- proxy 글로벌 동의: 로그인+미동의 → 모든 비예외 페이지 `/consent`. 예외=`/consent`·`/auth/*`·`/api/*`+정적/`_next`(`/login`=anon 전용).
- `requireMember`(동의완료, endpoint 백스톱): fal · doll(전 메서드) · generations · avatar · payapp/checkout · payapp/order-status · admin/*(requireAdmin)
- `requireAuthedNonDeleted`(로그인만): account/delete(탈퇴) · /api/account/consent
- public webhook: payapp/feedback · payapp/return · 공개 조회: leaderboard·score·signed-urls·highlight·report·gallery·config/public·/api/legal/versions

v0.50 (2026-06-28, 이벤트/공지 운영 — 소식 게시판·홈 팝업·배너 구좌; Migration 0043):
- **신규 기능**: 어드민이 공지·이벤트를 작성·발행하고 3지면을 운영. (a)**홈 진입 팝업**("○일 안보기" 이벤트별 localStorage dismiss·기본 7일) · (b)**소식 게시판 `/news`**(홈/갤러리/랭킹과 동급 탭, 타입[공지/이벤트] 배지·필터·페이징·상세) · (c)**배너 구좌**(홈·랭킹·갤러리 공통 1건, 기존 가입배너와 별개). a·c 는 events 행의 `popup_active`/`banner_active` 플래그로 b 의 특정 글을 가리켜 랜딩(단일 소스).
- **데이터(전용 테이블 — config 부적합)**: `events`(0043) status(draft/published)+노출 윈도우(starts_at/ends_at)+priority·pinned·noindex·popup_dismiss_days. **버전 이력 없음**(과거본 공개 의무 없음). 노출=발행+윈도우+미삭제. 팝업/배너는 priority deterministic 1건. legal_documents(0029) 하드닝(security definer·search_path·revoke·내부 admin 재검증·advisory lock) 복제 + 전용 `events_audit`(details jsonb). RPC: `admin_save/publish/unpublish/delete_event`.
- **이미지**: 신규 **public `events` 버킷**(서명 불요·CDN/OG). DB 는 `cover_image_path`(상대경로) 저장→서버 getter 가 `getPublicUrl` 파생. 업로드(`/api/admin/event-image`, avatar 패턴)+저장 API(zod)+RPC **3중** events 버킷·SVG 금지·5MB 검증. 본문 마크다운 인라인 이미지도 events 버킷 URL 만 렌더.
- **본문**: 마크다운(`react-markdown`+`remark-gfm`, **rehype-raw 미사용**=XSS 안전, 링크 http/https/mailto·외부 target/rel, img events 버킷만).
- **어드민**: `/admin/events`(목록·status/type 필터·페이징) + `/admin/events/[id]`(에디터: 폼·커버/본문 이미지 업로드·마크다운 미리보기·발행/예약/삭제·다중활성 경고). AdminNav 탭 추가.
- **공개·예약 경계(현재 계약)**: 초기 60초 now-bucket/ISR/SWR 설계는 제거됐다. `/news` 목록·상세·sitemap은 `force-dynamic` + 요청별 정확한 서버 시각으로 `starts_at <= now`·`ends_at > now`를 평가한다. 팝업·배너 3지면은 service-role 전용 `get_active_event_surfaces` SQL RPC 한 statement의 단일 MVCC snapshot에서 deterministic pick하며, 같은 `serverNow`에 가장 가까운 future start/end를 `nextTransitionAt`으로 결속한다. 따라서 발행·삭제·플래그·우선순위가 조회 도중 바뀌어도 서로 다른 DB 상태의 지면을 섞지 않는다. `/api/events/active`는 브라우저·Vercel CDN 모두 `no-store`; 탭 내 공유 요청은 최대 30초만 합류하되 다음 전환이 먼저면 응답 수신 시 고정한 monotonic 절대 만료시각에 기존 snapshot을 먼저 폐기하고 재조회한다. 서버/클라이언트 왕복 중 경계가 이미 지났으면 각각 최대 3회 재조회한 뒤 fail-closed하며, 외부 Promise 정산 때문에 1ms 만료를 연장하지 않는다. 시작은 inclusive, 종료는 exclusive다.
- **SEO**: `/news` + 발행·윈도우 active·noindex=false 상세를 `sitemap.ts` 동적 등재, 상세 `generateMetadata` OG(cover)·행별 robots noindex. **`/news` 는 public 이나 로그인 미동의자는 v0.49 글로벌 게이트(`proxy.ts`)로 `/consent`**(anon·동의완료는 정상). 만료/삭제/예약 상세는 `notFound`(404) — **만료 안 시킬 공지는 `ends_at=null`**(보드 영속). ⚠️ 만료 이벤트의 공유·북마크 링크는 404.
- 검증: typecheck 0·신규 파일 lint 0. 당시의 미저장 이미지 orphan 허용은 0079의 DB upload intent + 2시간5분 fenced cleanup으로 폐지됐고, 지면별 배너는 v0.51에서 완료됐다. 예약 노출은 읽기 시각으로 판정하므로 별도 만료 purge cron이 필요 없다. 공개 URL은 의도적으로 불변 UUID(`/news/[id]`)를 쓰고 popup dismissal도 이벤트 ID별 만료값으로 격리하므로 slug/reset을 미구현 결함으로 추적하지 않는다.

v0.51 (2026-06-28, 배너 지면별 분리 + 소식 상세 정리; Migration 0044):
- **배너 구좌 지면별 독립화**: 단일 `banner_active`(3지면 일괄) → **`banner_home_active`/`banner_gallery_active`/`banner_leaderboard_active`** 3 독립 플래그. 에디터 체크박스 홈/갤러리/랭킹 각각, 한 이벤트가 임의 조합으로 지면 선택. **문구(summary)·우선순위(priority)는 공용**. `getActiveBanner(surface)` + `/api/events/active` 가 `banners.{home,gallery,leaderboard}` 반환 + `EventBanner surface` prop(홈/랭킹/갤러리 각 주입).
- **소식 상세(`/news/[id]`) 정리**: 본문에서 **커버 이미지·요약 제거**(커버·요약은 목록 썸네일·팝업·배너·OG 메타 전용으로만 유지) + 약관/방침처럼 **오프화이트(`ui-surface`) 카드** + header border-b.
- 검증: typecheck 0·신규 변경 파일 lint 0. 라이브(어드민 세션 주입 로컬) — 에디터 3체크박스·**per-surface 독립**(갤러리=테스트 배너, 홈/랭킹=기존 배너 동시 확인)·상세 오프화이트·커버 미노출 확인.

v0.52 (2026-06-29, 소식 썸네일 og 비율 정합 + 커버 transform 경량화):
- **썸네일·OG 비율 통일·경량화**: 소식 목록 썸네일이 1.25:1(`h-16 w-20`, 풀 원본 png ~2.27MB)이라 og(1200×630=1.91:1)와 비율 어긋나고 느리던 문제. 커버 원본 1장에서 **표시 시점 Supabase transform**(갤러리 `DOLL_THUMB` 패턴)으로 `coverThumbUrl`(600×315)·`coverOgUrl`(1200×630) 파생 — 둘 다 **40:21·resize:cover** 로 목록·og 프레이밍 통일. 목록=`<FadeImg aspect-[40/21] shimmer>`(webp ~44KB, ~98%↓), `/news/[id]` `generateMetadata` OG=`coverOgUrl`+width/height 1200×630. **재크롭/마이그레이션 0**(public 버킷 render URL·기존 원본 그대로). OG는 콘텐츠 협상(브라우저=webp·SNS 스크래퍼=png)이라 미리보기 호환.
- 검증: typecheck 0·build 0. prod `events` 버킷 실측(원본 2.27MB png → 썸네일 44KB webp, og 1200×630 webp/png 협상). 배너(`EventBanner`)도 동일 경량화는 후속 후보(표시 비율 달라 별도 PR).

v0.53 (2026-06-29, 미디어 자산 어드민화 — 기본 OG·서비스 로고 + 어드민 이벤트 썸네일; Migration 0045):
- **Part A — 어드민 이벤트 이미지 정합**: 어드민 이벤트 목록·수정 미리보기가 raw `<img>` 풀커버를 1.25~1.5:1 로 로드하던 것을 `FadeImg`+`coverThumbUrl`(서버 리사이즈)+`aspect-[40/21]`(=1200/630)+"권장 1200×630" 안내로(공개 소식목록 v0.52·어드민 캐릭터목록 thumb 와 결 통일). 캐릭터목록(`getUserDolls` thumb)은 기 적용.
- **`media_config` 도메인 — 기본 OG·로고 어드민화**: 정적이던 루트 OG·서비스 로고를 `/admin/content/media_config` 업로드로 제어. **path-only 저장**(URL 금지) + 소비/미리보기는 늘 변환(render) URL(고용량 원본도 리사이즈만). 업로드 `/api/admin/site-asset`(2-step·슬롯 prefix `og/`·`logo/`·jpeg/png/webp·≤5MB·SVG/GIF 거부·previewUrl 만 반환). `lib/site-assets`(변환 사양+URL 파생+`resolveOgImages`), `MediaAssetsProvider`(로고 클라 주입). config 쓰기 API 제네릭이 media_config 자동 처리(0045 allowlist).
- **OG/twitter file-based 컨벤션 제거**: `app/opengraph-image.png`(+alt)를 `public/og-default.png` 로 이동 → `generateMetadata` 가 openGraph·twitter `images` 를 **명시**(파일-기반과 충돌 방지). 우선순위 `resolveOgImages()` 단일화 — 이벤트 cover > media_config > 정적 default(일반 페이지·`/news/[id]` 공통, openGraph deep-merge 안 됨 대응). 로고=`media.logoUrl ?? /logo.png`(home·login, `object-contain`). **파비콘은 정적 유지**.
- **하드닝**: next/image 원격 optimizer allowlist를 닫아(`remotePatterns=[]`) 제3자 Supabase/fal URL을 우리 비용으로 변환하지 못하게 한다. 동적 로고는 이미 Supabase 640px transform 결과이므로 `<Image unoptimized>`로 직접 전달하고, `/_next/image`는 query 없는 로컬 `/logo.png`·quality 75만 허용하며 redirect 추적은 0회다. media_config 발행 시 `revalidatePath('/','layout')·'/'·'/login'`(og:image·로고 즉시 반영). 이 버전의 orphan 미삭제 메모는 0079에서 대체됐다. 미attach 객체는 fenced cleanup이 회수하고, 현재 발행 설정이 참조하는 site/event 자산만 롤백·감사를 위해 자동 detach하지 않는다.
- 검증: typecheck 0·build 0(정확한 exit 캡처). **배포 전: Migration 0045 적용 + `site-assets` public 버킷 수동 생성**.

v0.54 (2026-06-29, 이미지 fade-in 모바일 깜빡임 수정 — `FadeImg`; 마이그레이션 없음):
- **모바일에서 fade-in 이 '번쩍/깜빡'이던 문제 수정**(아바타·프로필·캐릭터·이벤트 썸네일 등 `FadeImg` 전체). 두 원인: ① `.fade-in-img` 에 `animation-fill-mode` 가 없어 onLoad 후 클래스 부착 직전 한 프레임 img base opacity 1 가 노출됐다 `from{opacity:0}` 로 뚝 떨어지던 번쩍 → **`fill-mode: both` 추가**(v0.45 의 'fill-mode 없음' 결정 갱신). ② `onLoad`(바이트 완료)가 디코드(래스터)보다 빨라 모바일서 미디코드 빈 프레임 노출 → **`img.decode()` 완료 후 표시**(catch→reveal graceful, lazy 는 onLoad 이후 호출이라 reject 안전) + 캐시 fast-path ↔ onLoad 경쟁 `settledRef` 가드.
- **fail-safe 보존**: fade 클래스는 여전히 JS reveal 시에만 부착 → JS 미실행이면 클래스 없음=base opacity 1(투명 정지 없음). reduced-motion `animation:none` 그대로(fill-mode 무관). 이 시점의 cache fast-path·AppNav 승격·갤러리 서명URL 캐싱 후속은 바로 다음 v0.55~v0.56에서 완료됐고, fade 자체는 v0.57에서 제거됐다.
- 검증: typecheck 0·build 0. 로컬 dev(`--hostname 0.0.0.0`) 실기기 모바일 육안 확인.

v0.55 (2026-06-29, AppNav 전역 영속화 + FadeImg P1 — 내비 remount/캐시 깜빡 잔여 제거; 마이그레이션 없음):
- **AppNav 를 root layout 으로 승격**(v0.54 ③ 근본). 페이지마다 `<AppNav/>` 를 직접 렌더하던 것(내비 이동마다 AppNav·AccountMenu remount → 프로필 재조회·아바타 재페이드·스피너 깜빡)을 `app/layout.tsx` **1회 렌더**로. 라우트별 노출은 AppNav 내부 self-hide(`NAV_HIDDEN_PREFIXES` = play·login·signup·consent·reconsent·share·doll·admin). **/admin 은 root 에선 hide + admin layout 이 theme-admin(다크) 안에서 `<AppNav forceShow/>` 로 직접 렌더**(라이트색 누수·double-nav 방지). 19파일에서 페이지 `<AppNav/>` 제거(`LegalPublicPage` 포함 — terms/privacy 도 root 경유로 정상).
- **FadeImg P1**(#129): 캐시 fast-path(`img.complete`) mount effect 를 isomorphic `useLayoutEffect` 로 → 캐시/정적 이미지 1프레임 placeholder 깜빡 제거.
- 검증: typecheck 0·build 0. `<AppNav` 렌더 grep=root+admin 2곳뿐(라우트 상호배타 → double-nav 0). SSR fetch 로 라우트별 노출 일치(홈·faq·랭킹·약관 노출 / play·login·signup·consent·reconsent 미노출) + 홈 단일 nav preview 확인. 당시 남은 갤러리 서명URL 캐싱은 v0.56에서 완료됐다.

v0.56 (2026-06-29, 갤러리 서명URL 클라 캐싱 — 재진입 재페이드 제거, ④ 마무리; 마이그레이션 없음):
- **갤러리 이탈→재진입 시 전 캐릭터가 재페이드되던 문제 제거**. `fetchDollPage` 가 매 mount 마다 `/api/doll/signed-urls` 로 **모든 id 서명 재발급**(새 URL → FadeImg 재로드)하던 것을, 모듈 레벨 `signedUrlCache`(id→{url,만료}, 8분 < 서버 ttl 600s)로 **캐시 미스/만료 id 만 재요청** → 재진입 시 같은 URL 재사용(브라우저 캐시 히트)으로 재페이드 없음. 캐시 만료는 재서명하고, 조회·서명 장애나 손상/부분 응답은 기본 부장님으로 위장하지 않고 오류·재시도로 노출한다. 이미지 경로 불변이라 정상 캐시의 staleness 없음.
- 검증: typecheck 0·build 0. (갤러리는 인증·본인 doll RLS 라 실데이터 확인은 실기기.) v0.54~0.56 으로 fade 깜빡임 ①②③④ 마무리.

v0.57 (2026-06-29, 이미지 fade 제거 + 정적 캐싱 — 깜빡임 우회 대신 빠른 로딩; 마이그레이션 없음):
- **방향 전환**: fade-in 효과를 걷어내고 *캐싱*으로 빠른 표시. fade 는 느린 첫 로드 pop-in 을 가리려던 우회책이라 모바일 깜빡임을 못 떨쳐냈음 → 제대로 캐싱되면 재방문 즉시 표시라 fade 불요.
- **`FadeImg` fade 제거**: `fade` state·`fade-in-img` 클래스·`img.decode()` 게이팅·`settledRef` 삭제(+ globals.css `.fade-in-img`/keyframes 제거). **placeholder(회색/펄스/shimmer) + 캐시 fast-path(`useLayoutEffect` — complete 면 paint 전 즉시) + onError 폴백 유지** → 캐시 이미지 즉시, cold 로드만 placeholder→이미지(페이드 없음). base opacity 1 fail-safe.
- **P0 정적 캐싱(`next.config` `headers()`)**: Next 가 `public/` 에 주던 `max-age=0, must-revalidate`(재방문마다 304 round-trip)가 진짜 원인(`_next/static` 은 immutable 인 게 증거). **sprites·bg·avatars=immutable 1년**(⚠ 교체 시 파일명 변경), **logo·og·icons=1일**(immutable 풋건 회피). `images.minimumCacheTTL`=31일(/_next/image). dev curl 로 적용 실측.
- **캐시 전수 감사**: render/transform(이벤트썸네일·OG·doll썸네일)=`max-age=3600`+CDN 양호 · avatars 버킷=1년(기존) · event커버 원본=`no-cache`이나 화면은 transform 소비라 무영향 · **doll 서명URL=no-store 응답**이라 객체 cacheControl 무효(원천적으로 remount 시 재로드, placeholder 가 완화). **P1(업로드 cacheControl)은 실효 낮아 보류**(소비가 transform/서명). next/image 전면 전환 비권장(비용↑·P0 로 동일 이득).
- 검증: typecheck 0·build 0(Sentry 래핑 headers 보존). dev 헤더 실측(sprites/avatars/bg=immutable, logo/icon/og=1일). fade 제거·캐싱 체감은 실기기.

v0.58 (2026-06-29, 신규 회원 member_accounts.email 누락 수정 + 기존 백필; 마이그레이션 없음):
- **신규 가입자 `member_accounts.email` 이 null 로 들어가던 버그**. 회원 생성 RPC(`create_or_update_member_consent`, 0041)는 email 을 안 채우고, 콜백의 이메일 동기화는 member row 가 *이미 있을 때만* 동작 → 갓 동의한 신규는 재로그인 전까지 email null. **수정**: `seedOAuthProfile`(consent API 의 신규 생성 경로, 이미 `getUserById`+`extractOAuthProfile` 보유)에서 `profiles` 시드에 더해 `member_accounts.email` 도 시드(콜백과 동일 추출·Kakao identity_data 대응). reconsent=멤버 미생성·onboard=deprecated(410)라 무관.
- **기존 백필**: null email 회원을 auth 의 이메일로 채움(service_role + Auth Admin API). 이전 세션 2건 → 이번 전체 재백필.

v0.59 (2026-06-29, 캐릭터 생성 결과 회수 실패 수정 #1 — 즉시 실패+환불; 마이그레이션 없음):
- **배경(실측)**: 생성 완료율 60%(40% 결과 미회수)·좀비 13행. 근본원인 = fal flux-pulid 가 큐 `COMPLETED` 후 result 400(`facexlib align face fail`, no-face)을 내는데 우리 회수가 ① 30분간 "생성중"으로 위장 ② 환불 안 함 ③ 좀비 박제.
- **① 결정적 실패 즉시 처리**: `RecoverResult.definitive` 추가 — fal 전부 멈춤인데 결과 0(no-face/만료)이면 결정적. 호출부(`/api/generations`)가 30분 대기 없이 *즉시* `interrupted`(reason:`photo`) 반환(transient copy 실패만 마감까지 대기 유지).
- **③ 실패 시 환불(멱등)**: `failGeneration` 헬퍼 — `status` 전이 가드(`neq('status','failed')`)로 폴링 3.5s 재실행·동시요청에 1회만 마킹+환불(ops 제외). 모든 실패 사이트(결정적·30분 끊김·만료) 일원화. `QUEUED_STALE_MS==INCOMPLETE_RECLAIM_MS` 라 fail→refund→reclaim 무료생성 엣지 없음(마이그레이션 불요).
- 검증: typecheck 0·build 0. 당시 후속은 모두 후속 버전에서 닫혔다. 제출 전 얼굴 검증은 현재 모호·부분 장애까지 fail-closed하고, ED25519 signed FAL webhook + cron이 응답유실/탭 이탈 회수를 담당하며, 생성·저장 진행률과 사진 오류 안내도 실제 UI에서 사용한다.

v0.60 (2026-06-29, 제출 전 얼굴 게이트 #1-b — no-face 즉시 반려; 마이그레이션 없음):
- **`lib/fal.ts`**: `detectGlasses` → `analyzeInputFace`(VLM **1회** 호출로 얼굴 존재+안경 동시 판별, 추가 비용 0). 당시에는 `'face=no'` 명시 시에만 반려하고 모호·파싱실패·예외를 통과시켰다. 이 과거 fail-open 정책은 아래 2026-07-29 QA 하드닝에서 폐기됐다.
- **`app/api/fal/route.ts`**: 차감·제출 *전* 얼굴 게이트 — 확실한 no-face 면 row failed + 임시얼굴 정리 후 `400 no_face`(**차감 없음**) → 30~60초 대기 제거.
- **`app/generate/page.tsx`**: `no_face` → "얼굴이 정면으로 또렷한 사진으로 다시" 안내 + 업로드 단계 복귀.
- 검증: typecheck 0·build 0.

v0.61 (2026-06-29, 생성 서버측 회수 cron #1-c — 폴링 이탈/만료 손실 제거; 마이그레이션 없음):
- **클라 폴링 의존 제거**: 탭 닫힘·앱 백그라운드로 폴링이 멈추면 fal 완료돼도 결과를 못 채워 좀비가 되던 것(+result 만료 시 영구 손실)을, 클라와 무관한 **cron 스윕**으로 해소. 당시에는 webhook 대신 cron만 사용했으나, 아래 v0.78 QA 하드닝(0086)에서 ED25519 signed webhook을 로컬 생성키로 결정론 검증해 응답 유실 request ID 복구 경로를 추가했다.
- **`app/api/ops/gen-recover`**(신규): `x-cron-secret`(telemetry-maintain 패턴) → 최근 2h 의 미완(candidate < fal 요청수) `queued/done` 행을 `recoverQueuedGeneration`(force=age>30분)으로 회수: ready=candidate 복사+done / 결정적 실패=`failGeneration`(환불). 한 실행 ≤20행. 멱등(폴링과 동일 로직).
- **`failGeneration` 을 `lib/generation-recovery` 로 추출**(폴링 라우트 + cron 공용).
- 검증: typecheck 0·build 0. **당시 배포 체크리스트**는 cron-job.org에
  `POST https://boss-paegi.vercel.app/api/ops/gen-recover`
  (`x-cron-secret` 헤더 = CRON_SECRET)을 5분 주기로 등록하라는 내용이었다. 현재
  2026-07-30 운영 inventory에서는 해당 5분 잡의 등록·활성이 확인됐으므로 미등록
  경고는 역사로만 보존한다.

v0.62 (2026-06-29, 생성 진행률 UX #4 — 시간기반 바+단계 텍스트; 마이그레이션 없음):
- **정적 스피너 → 진행 표시**(체감 완화, 이탈 방지). `components/generate/GeneratingProgress`(신규): 경과시간 점근 진행바(asymptote 95%·완료 전 100% 안 됨) + 단계 텍스트(사진 분석→캐릭터 그리기→디테일→거의 다). fal 실제 진행 신호가 없어 시간 휴리스틱(A+B), 숫자 카운트다운 없이 범위("보통 1~2분")만(p90 4분이라 카운트다운 부정확).
- **`reason:photo` 소비**: 생성 중 no-face 결정적 실패(PR-1)가 `interrupted`로 오면 폴링이 "얼굴이 안 보여요, 정면 사진으로" 안내(일반 중단 메시지와 분기). `PendingGeneration.reason`→`useGenerationPolling` 전파.
- **카피 소유권**: LoadingStage/no-face/진행 카피는 현재도 코드 고정이다. 런타임 안전·정합에 필요한 설정 기능으로 약속하지 않으며, 마케팅 config에 편입하려면 별도 제품 범위와 migration이 필요하다.
- 검증: typecheck 0·build 0.

v0.63 (2026-06-29, 어드민 회원탭 전체 목록 — 검색 없이 전체 노출; 마이그레이션 없음):
- 지금까진 **검색해야만 목록이 떠서** 전체 회원 보기가 불편 → **기본=전체 활성 회원 페이징(10/page 최신 가입순)** + 검색은 필터 + **"전체" 초기화 버튼**.
- `lib/admin-users.ts` `listMembers(page)` 신규(`member_accounts` + `profiles!inner` `deleted_at is null` 활성만·count:exact·range). `app/admin/users/page.tsx` q 유무로 전체목록/검색 분기(행 렌더 공유, `Pagination` 재사용). `MemberSearch` 에 전체 초기화.
- 검증: typecheck 0·build 0 + service_role 실측(활성 18명·10/page·임베드 필터 동작).

v0.64 (2026-06-29, 생성 메타 기록 — fail_reason + picked_index; **Migration 0046**):
- 생성 현황 어드민 탭(예정) 전제. 지금은 no-face·타임아웃·fal오류·차감/제출 실패가 전부 `status='failed'` 한 덩어리라 "거부"를 구분 못 함 → **`fail_reason`** 기록. 고른 후보 인덱스 **`picked_index`** 기록(픽 선호 분석).
- `lib/generation-recovery.ts`: `RecoverResult.reason`(no_face/fal_error/no_requests) + `failGeneration(..., reason)`(+0046 미적용 fallback). `fal/route.ts` 3지점(no_face/no_credits/submit_error). `generations`/`gen-recover` 호출부에 사유(timeout/expired/rec.reason). `doll/route.ts` 픽 시 후보 경로에서 index 파싱(+fallback).
- 검증: typecheck 0·build 0. **⚠ Migration 0046 (`0046_generation_meta.sql`)**: `ai_generations` 에 `fail_reason text`·`picked_index int` 추가(둘 다 nullable·additive·CHECK 없음). 대시보드 SQL 에디터로 적용. 코드는 fallback/self-heal 로 미적용 lag 도 견딤(적용 전 no-face 거부는 사유 미기록·30분 후 마킹).

v0.65 (2026-06-29, 어드민 캐릭터 생성 현황 탭 — 신고탭 컨벤션; 마이그레이션 없음):
- **신규 `/admin/generations`**(AdminNav "캐릭터 생성"). 생성 라이프사이클을 상태/회원/캐릭터로 조회 — **목록 + 행 인라인 펼침**(신고탭 모델), 페이징 10.
- 상태(파생): 생성요청(queued)·선택 전(done)·선택완료(picked)·**거부(failed+no_face)**·기타 실패(failed 그 외). 상태칩 필터 + 회원/캐릭터 id 클릭→필터(+회원 상세 이동). 펼침에 후보 썸네일(선택 전 3장·선택완료 1장+픽 인덱스, 나머지 후보는 pick 시 삭제됨), 실패 사유, 메타.
- `lib/admin-generations.ts`(`listGenerations` — 상태/owner/doll 필터·count·signed 썸네일·owner명/doll이미지 배치, **0046 미적용 fallback**: full 쿼리 에러에 fail_reason 포함→폴백). `GenStatusFilter`·`GenerationsTable` 컴포넌트.
- **크레딧 표기는 status 기반 추정**(consumed/refunded/none) — 정확 변동은 PR-D(credit_ledger)에서.
- 검증: typecheck 0·build 0 + service_role 실측(prod 116건·fallback 트리거 확인=`column fail_reason does not exist`·candidate_urls 배열).

v0.66 (2026-06-29, 크레딧 변동 원장 — 생성 차감/환불 기록; **Migration 0047**):
- **갭**: 운영자 조정(admin_actions_ledger)·충전(payapp_orders)은 기록되나 **생성 차감(−1)·생성 환불(+1)은 어디에도 기록 안 됨**(member_accounts.gen_credits 만 +/-). → `credit_ledger`(gen_consume/gen_refund) + 회원상세 "크레딧 사용 내역 · 생성 차감/환불" 섹션(10/page).
- **앱 레벨 로깅**(money/hot-path RPC 무수정·리스크 최소화): `lib/credit-ledger.ts` `logCreditEvent`(best-effort, 0047 미적용이면 무음 skip). 호출부 — `fal/route.ts`(consume `-1`·submit실패 refund `+1`, balance_after=RPC 반환), `generation-recovery.ts` `failGeneration`(폴링/cron 실패 refund `+1`). 모두 `ref_gen_id` 연결.
- **충전(purchase)은 기록 안 함** — 이미 결제 내역(orders)에 보여 payment 라우트 무수정. credit_ledger/EVENT_META 는 purchase 지원(향후 통합 대비).
- 검증: typecheck 0·build 0 + 실측(credit_ledger 부재 PGRST205 확인 → 로깅/조회 graceful skip). **⚠ Migration 0047 (`0047_credit_ledger.sql`)**: `credit_ledger` 신규(server-only RLS·additive). 대시보드 적용 후 신규 발생분부터 누적.

v0.67 (2026-06-30, 무료 플랜 사용량 절감 — Vercel ISR write + Sentry replay; 마이그레이션 없음):
- **배경(실측)**: Vercel 무료 ISR Writes 200k 중 ~75% 도달(100%=프로젝트 자동정지). 원인 = per-id ISR 페이지(`/share`·`/history`·`/doll` + OG ≈ **1,178개**, `revalidate=60`)를 **robots 가 크롤 허용**(noindex·follow) → GSC·네이버 등록 후 크롤러가 반복 fetch → 60초마다 재생성. (Supabase DB 17MB/500MB·스토리지 106MB/1GB, Sentry error 182·span 93k 는 전부 여유.)
- **`app/robots.ts`**: `/share`·`/doll`·`/history` **크롤 차단**(noindex·sitemap 미등재라 색인 손실 0 — 크롤러발 ISR write 제거가 핵심).
- **`revalidate` 60→480s**(share/doll/history): 서명 URL TTL 600 안쪽(120s 마진). 남는 실유저/소셜 트래픽분 ~8배 감소. takedown 등 변경은 기존 명시 `revalidatePath` 유지.
- **Sentry `replaysSessionSampleRate` 0.2→0.1**(`instrumentation-client.ts`): 세션 리플레이가 월 147건으로 무료 ~50 초과 → 절반으로(에러 리플레이는 100% 유지). 이후 privacy hardening에서 Replay는 production + exact 운영 opt-in일 때만 통합을 설치하도록 기본 비활성화했다.
- 검증: typecheck 0·build 0.

v0.68 (2026-06-30, 탈퇴→재활성→재가입 이메일 정상화 — marker 영구 오염 수정; **Migration 0048**):
- **버그**: 탈퇴 후 어드민 재활성·재로그인하면 `auth.users.email` 과 `member_accounts.email` 이 실 이메일 대신 탈퇴 스크럽 marker(`deleted+<uid>@deleted.invalid`)로 영구 잔존. (어드민 회원검색·표시·Sentry 식별 오염; end-user 직접 노출은 없음.)
- **근본 원인**: 탈퇴가 `updateUserById(email=marker)` 로 `auth.users.email` 스크럽 → GoTrue 가 marker 를 소유하는 confirmed `email` provider identity 생성(primary email 슬롯 잠금). 재활성 RPC(0037)는 `member_accounts.email` 만 복원하고 `auth.users.email` 미복원 → 재로그인 시 `extractOAuthProfile` 의 `firstString(user.email, m.email)` 이 marker 를 우선 → 콜백 이메일 동기화가 매 로그인마다 복원된 실 이메일을 marker 로 되덮음.
- **수정**: (1) `lib/oauth-metadata.ts` — 공유 헬퍼 `deletedEmailMarker()`/`isDeletedMarker()` + `extractOAuthProfile` 가 marker 를 이메일에서 제외(OAuth identity 실 이메일 우선) → 콜백 재오염·`email_required` 게이트 오판 차단. (2) `app/api/admin/reactivate/route.ts` — RPC 후 `updateUserById` 로 `auth.users.email` 도 실 이메일 복원(F1, GoTrue API 는 SQL RPC 밖). (3) 재활성 RPC(0048) — identity 선택 정렬에 non-marker·OAuth-provider 우선 추가 + 최종값 marker 면 override 폴백(스크럽이 만든 email-identity 회피). (4) 기존 오염 **활성** 계정 보정 스크립트 `scripts/backfill-email-unscrub.mjs`(탈퇴 상태는 marker 유지 — PIPA 익명화 보존).
- **PIPA**: marker 는 탈퇴 계정에선 정당 → 복원은 **재활성(=`deleted_at` 해제, 서비스 복귀)된 계정에 한해**서만(F1·백필 모두 활성만). 탈퇴 상태 익명화 불변.
- 검증: typecheck/lint/build 0. 가드 유닛테스트 8/8(실제 소스 — marker user→실 이메일·정상 user 불변·all-marker→null). **라이브 E2E 14/14**(테스트 계정 brian: email-scoped 탈퇴→0048 RPC marker-회피 real 복원→F1 auth 복원→A/B/E 전부 real 확인→consent 원복, prod 원상태 복귀). 백필 prod 적용(오염 활성 1건 복원). **⚠ Migration 0048 적용 완료**(`0048_reactivate_email_marker_guard.sql`, `admin_reactivate_account` create-or-replace·additive·컬럼 무변경, Management API). 0045~0047 과 번호 겹치지 않게 0048.

v0.69 (2026-06-30, 캐릭터 저장 단계 진행률 UI + 정리 오프패스 — 체감 개선; 마이그레이션 없음):
- **배경(Sentry 실측, prod 30일)**: 후보 선택 후 "저장 중…"(`POST /api/doll`) 이 **p50 ~8s·p95 ~12s·최대 ~20s**. 내역 = birefnet 누끼(`doll.bg_removal`) **p50 ~4.4s(최대 10.4s, 최대 병목)** + fal.media fetch ~1.8s + Supabase 업로드 ~1.9s + normalize ~0.4s. 생성 단계는 `GeneratingProgress` 진행바가 있는데 **저장 단계는 맨 스피너뿐**이라 더 짧은데도 더 답답하게 체감됐음.
- **진행률 UI**: `GeneratingProgress` 를 공유 `TimedProgress`(stages·tau·footer 파라미터)로 일반화 + **`SavingProgress`** 추가(단계 "배경 정리→캐릭터 저장→게임 준비", tau=7). `app/generate` saving 스테이지의 `LoadingStage "저장 중…"` → `SavingProgress` 로 교체. 생성 동작은 불변(동일 stages·tau=60).
- **정리 오프패스(당시 구현, 현재 대체됨)**: 이 버전의 `after()` 정리는 이후 durable Storage cleanup job과 provider terminal raw-face cleanup으로 대체됐다. 현재 `POST /api/doll`은 cleanup job을 즉시 시도하되 실패/시간 초과를 durable pending으로 남기고 cron이 재시도하므로 프로세스 종료에도 정리가 유실되지 않는다.
- birefnet 누끼(4.4s) 자체는 fal 모델 지연이라 미변경(필요 시 생성 단계 사전계산은 fal 비용 ~3× 트레이드오프로 후속). fal 비용 변화 없음.
- 검증: typecheck/lint/build 0. 프리뷰 임시 라우트로 `SavingProgress` 렌더 확인(단계 텍스트·진행바·푸터·콘솔 0) 후 라우트 삭제. `after()` 는 Next 16.2.7 `next/server` stable export 확인.

v0.70 (2026-06-30, 무기 다양성 게임성 — 저글링 보상; 마이그레이션 없음):
- **배경(telemetry/scores 실측)**: fist 타격 49%·`distinct_weapons=1` 비-빈판 66%·무전환 60%. 단 코드/데이터로 사용자 전제 2개 반박 — ① 전환은 콤보 안 끊음(콤보 시간기반 `gameStore.ts:109` `<1500ms`) ② 단일화는 점수 **불리**(`distinct_weapons` 1→p50 8,286 / 9→60,762, 콤보 corr +0.82). 즉 발견·동기 실패라 채찍 아닌 **당근**으로 "fist 연타"→"무기 저글링" 재설계.
- **`lib/game-tuning.ts`**(신규): 상수 6종 + `JUGGLE_INITIAL_STATE`(start·reset 공유 spread, 드리프트 방지). **`store/gameStore.ts`** `hit()` charge 분기에 — **A** 다양성 콤보배율(최근 5타 distinct → `(1+varietyMult)`, 5종 ×2.00, 동일무기 반복 시 점진 감쇠) · **B** 새 무기 첫타 +300 플랫(배율 미적용·무기당 1회) · **C** 전환 시 궁극 게이지 +0.03(300ms 쿨다운, 2무기 왕복 차단) · **D** 전환 타격 콤보창 1500→1800ms(느린 무기 마찰 완화). 전부 *이전 상태* 기준 판정 + 불변 업데이트. 궁극 게이지는 기존 증가분에 switch bonus 합산·ready 1회 판정.
- **`components/ScoreBoard.tsx`**: 콤보 옆 `저글링 ×1.25`(최종배율) + `새 무기 +300` 토스트(useEffect 타이머 1.5s 자동 숨김).
- **점수천장 무변경**: ×2 max라 750/sec×2=1,500 < `MAX_AVG_SCORE_PER_SEC=2000` → 서버 cap·리더보드 무영향. telemetry/서버/마이그 변경 0. 맵은 효과 0이라 제외.
- 검증: typecheck/build 0 + **로직 실측 16/16**(시간 제어로 store 직접 구동 — 배율 1→5종 ×2.00·감쇠·쿨다운·grace·fresh 1회·reset). **배포 후**: `/admin/analytics` 무기탭 before/after(`distinct_weapons=1`·`first_switch_ms` null·fist share·HHI·max_combo p50).

v0.71 (2026-06-30, 저글링 튜닝 — 보너스 지속↑·전환 궁극↑·표현 친화화; 마이그레이션 없음):
- **보너스 지속 윈도우 5→100타**: 윈도우(`VARIETY_WINDOW_SIZE`)와 최대도달 무기수(`VARIETY_FULL_AT=5`)를 분리. 5종 쓰면 ×2.00 도달은 동일하되 이후 **~100타 동안 유지**(자주 안 바꿔도 됨), 윈도우 밖이면 점진 감쇠. 공식 `min(CAP, (distinct-1)/(FULL_AT-1)*CAP)`(6종+도 ×2 clamp). 배율 범위 2종 ×1.25 ~ 5종 ×2.00 불변 → 점수천장 무영향.
- **전환 궁극 가속 +3%→+10%**(`SWITCH_ULT_BONUS_RATIO` 0.1, 300ms 쿨다운 유지).
- **HUD "저글링"→"무기변경"**(`ScoreBoard`) — 플레이어 친화 표현.
- 검증: typecheck/build 0 + 로직 실측(5종 후 동일무기 10연타 ×2.00 유지·9종 clamp·전환 궁극 +0.10·쿨다운).

v0.72 (2026-06-30, 데미지 팝업에 콤보·무기변경 배율 반영; 마이그레이션 없음):
- **문제**: 화면 데미지 팝업(`fx.scorePop`)이 콤보·무기변경 배율 적용 *전* 값(예: 주먹 항상 +12)만 보여줌 — 실제 점수 증가(콤보×무기변경 적용)와 따로 놀았음. 배율은 `gameStore.hit()` 안에서만 계산돼서.
- **수정**: `hit()`가 **팝업값(baseGain=strength×콤보배율×(1+varietyMult), fresh +300 제외=별도 토스트)을 반환** → `PlayScene.reportHit()`이 그 값을 반환 → 6개 입력(tap/swipe/throw/shoot/grab/난타) 각 사이트가 `scorePop`을 **reportHit 결과로** 찍게 재배치(펜=무팝·사이트별 위치/색 보존). `onHit` 타입 `=> number | void`.
- 검증: typecheck/build 0 + 로직 실측(주먹 5연타 12→18·5종 저글링 keyboard +60·난타 콤보 반영·fresh +300 팝 제외).

v0.73 (2026-07-21, 결제 프로바이더 페이앱 → 포트원(PortOne V2) 컷오버; **Migration 0058**):
- **배경**: 페이앱이 '게임 캐릭터 생성권' PG 계약 거절 → 포트원 애그리게이터로 전환(계약 진행: 카드=KPN·토스페이·카카오페이, NHN KCP 반려). 실 paid 주문 0건 실측(canceled 20·failed 2 = dev 테스트 이력) → 병행 없이 컷오버, 페이앱 코드(`lib/payapp.ts`·`/api/payapp/*`) 전체 제거. **KPN 이 V2 전용이라 연동 전체 V2 확정.**
- **Migration 0058**: `payapp_orders`→`orders` 리네임(+제약/인덱스/트리거 접두사 정리), `mul_no`→`pg_tx_id`·`pay_state`→`pg_status`(text)·`payurl` 제거·`provider`('payapp'|'portone')·`payment_id`(포트원 paymentId=order_uuid 하이픈 제거 — KPN 영숫자 제약) 추가, `refund_state` 'payapp_done'→'pg_done', canceled_at 백필, RPC 재정의(`mark_paid_and_grant`[+credit_ledger purchase 원자 기록 — 0047 갭 해소]·`admin_settle_stuck_order`·`admin_cancel_order`[p_pg_done]·funnel/summary/search/unreconciled).
- **신규 결제 흐름**: `/api/pay/checkout`(pending 선삽입→서버 결정값 반환) → 클라 `@portone/browser-sdk/v2` `requestPayment`(수단 선택 UI: 카드/토스페이/카카오페이, channelKey env 매핑, redirectUrl=/credits/done) → `/api/pay/webhook`(Standard Webhooks 서명·raw body) → 전 경로(웹훅/폴링/대사) **단건 조회 재검증** 수렴. order-status 폴링이 pending 이면 서버가 직접 조회→지급(웹훅 유실 자가치유). reconcile 은 '경고만'→**실제 자동 대사** 승격. settle 은 포트원 PAID·금액 검증 후에만 지급. 환불은 `POST /payments/{id}/cancel` + 구조화 에러(`PAYMENT_ALREADY_CANCELLED`=멱등 ok — 한국어 문구 allowlist 파싱 제거). checkout rate-limit(user 10/분) 추가.
- **PG 심사 대응**: `growth_levers.reviewerEmails`(콘솔)은 심사 계정을 분류하지만 checkout의 분리 확인·불변 증거 경계를 우회하지 않는다. 구현 fence는 완료됐고 실제 노출은 exact runtime rollout gate를 따르며, 심사 계정은 TEST 표시·테스트 채널, 일반 계정은 live 판정을 서버와 화면이 함께 검증한다. `site_content.businessInfo`(콘솔) + 전역 `SiteFooter`(사업자정보 상시 노출 — 심사 요건, /play 등 게임 표면 제외).
- **env**: `PAYAPP_*` 3종 제거 → `PORTONE_V2_API_SECRET`·`PORTONE_WEBHOOK_SECRET`(서버) + `NEXT_PUBLIC_PORTONE_STORE_ID`·`NEXT_PUBLIC_PORTONE_CHANNEL_KEY_{CARD,TOSSPAY,KAKAOPAY}`(공개 안전 식별자 — 이 프로젝트 최초의 클라 결제 env, 시크릿 아님). Sentry 트레이싱 `/api/payapp`→`/api/pay/`, 이벤트명 `payapp.*`→`pay.*`(**알림 모니터 재설정 필요**). proxy WEBHOOK_PATHS=`/api/pay/webhook`.

v0.74 (2026-07-23, 어드민 정합 — 회원 상세 링크 전면화·결제 표시 패리티·사업자정보 도메인 분리·심사계정 카피 정정; **Migration 0061**):
- **회원 상세 링크 전면화**: 어드민에서 회원을 표기하는 모든 표면에 `/admin/users/[id]` 링크 — 주문 목록/회원 상세(OrdersTable 유저 컬럼), 처리 내역(LedgerTable 대상 유저), 대시보드 오래된 결제요청(StalePendingTable)·**환불 경고(DashboardWarnings — 회원 표기 자체 신설**, RPC 경로라 profiles 임베드 대신 `fillDisplayNames` 배치 조회), 무결성 큐 '이 유저만' 필터 칩 옆 '회원 →', 게임분석 세션 인스펙터 목록·상세(**'회원 (닉네임)' 표기+링크** — `profiles(display_name)` 임베드, owner_id null[프로필 하드삭제 잔존, on delete set null]이면 링크 없는 '회원' 텍스트), PG 심사 계정 탭 이메일. 회원 상세 안 임베드 테이블의 셀프 링크는 허용(컴포넌트 시그니처 불변). **관리자 표기(처리 내역 '관리자'·콘텐츠 변경내역 수정자)는 링크 제외**(운영자 결정). 무결성 큐 owner_id null(하드삭제 잔존 점수) 행은 moderation 관용구로 '(탈퇴/삭제)' 텍스트만 — 종전 빈 href(`/admin/users/`) 링크 버그 수정.
- **결제 표시 패리티**: 회원 상세 결제 내역에 결제경로(카드/토스페이/카카오페이)+TEST 뱃지가 주문 어드민과 동일 표시 — 원인은 `getUserOrders` select 의 `is_test, pay_channel` 누락(렌더는 OrdersTable 공유; `as Omit<AdminOrder,…>` 단언이 누락을 은폐). 대시보드 환불 경고에도 TEST 뱃지(0059 주석대로 테스트 주문도 경고에 포함 — 실환불/테스트 구분). **채널 라벨 단일 출처화**: `CHANNEL_LABELS`(lib/pay-channels, CHANNEL_DEFS 파생) ← `payRouteLabel`(lib/admin-format 이관) + `TestBadge` 공용 컴포넌트 — OrdersTable 인라인 중복 제거(결제수단 선택 UI 와 어드민 표기 자동 동기화).
- **사업자정보 도메인 분리(0061)**: `site_content.businessInfo` → 독립 **`business_info` 도메인**(`{info?}` — 미설정 인코딩) + 콘솔 '사업자 정보' 탭/이력. 1도메인=1카드=1발행단위(CAS)=1감사이력 관례 유지, 마케터의 SEO/FAQ 발행과 심사 필수 데이터(사업자등록증 일치)의 발행단위·이력 분리. 발행 시 `revalidatePath('/','layout')` 추가(media_config 와 동일 — layout 렌더 값이라 tag 만으론 ISR 반영 지연, businessInfo 시절 수동 재배포[dcfcf62]하던 갭 해소). SiteFooter/layout 소비 = `getBusinessInfo().info`. site_content 발행값의 잔존 businessInfo 키는 zod 가 무시(다음 발행 때 자연 소거).
- **심사계정 카피 정정**: 성장 레버 "PG 심사용 계정 이메일" → **"테스트 결제 계정 이메일"** — 향후 checkout 법무 fence가 해제된 뒤 등록 계정 결제는 테스트 채널 기본이고 `?live=1`에서만 실채널을 선택한다. 현재는 reviewer 포함 전체 checkout이 compile-time fence로 닫혀 있다. ID/PW 계정은 `/admin/reviewers`에서 별도 관리하며 OAuth allowlist와 OR로 분류하지만 fence를 우회하지 않는다. '심사 종료 후 비우세요' → 유지 운영(런북 §7 정책)으로 정정. reviewers 페이지·런북의 구 명칭 참조 동시 갱신.

v0.75 (2026-07-23, 환불 정책 정비 — 토스페이 가맹 반려 대응; **DB 약관·config 직접 갱신, 마이그 없음**):
- **반려 사유**: 충전형 생성권의 ①일부 사용 시 잔여 유료분 환불 가능 여부 ②환불 산정 방식 ③무상분 환불 제외 기준 미비.
- **약관 제10조 전문 재작성**(published v1 **in-place UPDATE** — 운영자 결정으로 신규 발행 없이 직접 갱신[소비자 유리 방향 개정이라 리스크 낮음, '시행본 불변' 원칙의 의도적 예외], 사전 백업 `_local/legal-drafts/backup-terms-published-2026-07-23.json`): 유효기간 1년(토스페이 요건 '1년 이내') · **미사용 유료분 상시 환불** — 7일 내=청약철회 전액(가분적 디지털콘텐츠 잔여분 포함, 전상법 §17②5호 단서), 7일 후=90%(10% 환불 수수료 — 콘텐츠이용자보호지침 §19 상한 준수) · 단가=해당 주문 결제금액÷지급 수량(**주문 스냅샷 기준이라 이후 상품 구성·가격 변경과 무관**) · **차감 순서 명문화**(무상 우선→유료 FIFO, 환불은 최신 결제 역순) · 무상분(가입 보너스·CS 지급) 환불 제외 · 유효기간 경과 시 5년까지 90% 환급(유지) · **남용 제한 조항 신설**(반복 구매-환불). 볼륨 할인 방어 검증: 어떤 부분환불 전략도 실효 개당가가 최대 티어가(375원) 미만이 될 수 없음(10% 공제 ≈ 티어 할인 기울기, 잔존 누수 건당 ~1천 원대는 남용 조항+수동 절차 마찰로 커버).
- **단일 소스 원칙 확립**: 환불 수치·산정식의 정본 = **약관 제10조 하나**. /credits 고지(`CreditsClient`)·FAQ(`site_content` v10 발행)·탈퇴 화면(`app/account`)은 요지+약관 참조형으로 전환(7일·90% 등 수치 중복 제거 — 이후 정책 변경 시 약관만 수정). 단 /credits 의 '사용분 청약철회 제한' 표시는 법정 필수(전상법 §17⑥·콘진법 §27)라 유지. FAQ 발행 시 잔존 businessInfo 키 자연 소거 완료(0061 이관 종결).
- **당시 시스템 공백(현재 해소)**: 이 v0.75 시점에는 로트·부분취소·부분회수·만료가 없었으나 바로 다음 v0.76의 Migration 0062~0068이 크레딧 로트, 만료 임박 FIFO, PortOne 부분취소, 수량 환불 saga, shortfall·대사·만료 cron을 구현했다. 현재 계약은 아래 v0.76과 `docs/refund-runbook.md`이며 수동 콘솔+CS 조정을 정상 경로로 사용하지 않는다.

v0.76 (2026-07-24, 크레딧 로트·환불 saga 시스템 — v0.75 약관이 유예한 "시스템 반영" 구현; **Migration 0062~0068**):
- **크레딧 로트 모델**: 단일 `gen_credits` 풀 → **로트**(구매·가입보너스·CS지급·전환보전) 분리. 소비는 **만료 임박 로트 우선 FIFO**(`consume_gen_credit_v2` = `expires_at asc, granted_at asc, id asc` — 무상/유료 source 구분 없음), `member_accounts.gen_credits` = Σ live 로트 잔여(캐시 봉투 불변식 G-1). 약관 제10조 3항은 코드(만료 우선)에 맞춰 정정 완료(2026-07-25 in-place — '무상 우선 차감'→'만료 임박 우선', QA 발견·운영자 결정, 백업 `_local/legal-drafts/`). 유료 잔액 보유자 0명이라 신뢰이익 침해 없음(소비자-불리 개정이나 무영향).
- **수량 환불 saga**: `refund_requests`→`order_refund_attempts`(상태기계 8종·전이 화이트리스트)→PortOne 부분취소→`record`→`commit`. 부분취소 1급 지원·policy-cap(약관 제10조 산식·초과 시 `invariant_violation` Sentry 경보)·회수 부족분(`credit_refund_shortfalls`)·외부취소 대사(`payment_cancellation_events`)·미귀속 이슈 큐(`reconciliation_issues`). 채번·상태전이·불변식은 전부 SECURITY DEFINER RPC(§13 — 앱 직접 금융 write 0, eslint `no-direct-financial-write` 가드로 CI 강제).
- **앱 표면**: 어드민 `/admin/refunds`(운영 큐)·회원 상세 로트/환불 개시(RefundButton)·대시보드 4범주 경고 / 사용자 마이페이지 3탭(`/account` 회원정보 · `/account/payments` 결제내역 — 결제완료 주문만·최신순·결제수단/테스트/잔여크레딧·영수증·KST 시분 · `/account/credits` 생성권 내역 — 모든 크레딧 증감 타임라인, 유저 라벨). 크레딧 개수는 헤더 드롭다운(AccountMenu — 생성 제출·충전 확정 시 `credits-changed` 이벤트로 새로고침 없이 즉시 갱신). 탈퇴용 `GET /api/account/refundable-credits`. 생성 lifecycle 원자화(`create_generation_and_consume`·`create_generation_row`·`mark_generation_failed_and_refund`).
- **컷오버(2026-07-24 적용 완료)**: Phase-A 유지보수 게이트(`CREDITS_MAINTENANCE_MODE`)로 write 차단 → 0062 additive(pgcrypto 선행) → v2 앱 → 0063 write-hardening(금융 테이블 UPDATE/INSERT revoke·operational 컬럼만 column-grant) → 0064 legacy stub 제거 → **과도기 게이트 철거**(canary 생략·즉시 open, 게이트 코드/env 제거 = commit `8c8f1c2`·PR #181). cron 2종(credit-expire 일1회·reconcile 5분+refund sweep). 검증: pgTAP 146/146(로컬 클린체인) + **프로덕션 go/no-go G-1~48 위반 0 재실행** + 독립 ACL 사후 probe(금융테이블 직접 DML 0·service_role 는 operational 컬럼만 재부여). 실결제 0건·유료 잔액 보유자 0명 상태에서 컷오버. 배포 절차 이력 = `docs/refund-saga/runbook.md`(당시 21스텝, 게이트는 완료 후 제거), 운영 대응 = `docs/refund-runbook.md`.
- **결제 정상화 핫픽스(2026-07-25, Migration 0065)**: 오픈 직후 리뷰어 결제가 전량 실패(`pay.order_insert_fail` ×6). 원인 = `create_pending_order` 의 **가격 allowlist 하드코딩이 어드민 config(`growth_levers`)와 드리프트** — config(`credits_10`=4500·`credits_20`=8500… + 신규 `event_credits_10`) vs RPC 옛 하드코딩(3000·5500…). 결제 비활성(`creditsEnabled=false`) 기간이라 잠복하다 오픈 후 리뷰어 결제로 표면화. **수정**: RPC 가 가격/개수를 **config(`app_settings.growth_levers` active 상품)에서 직접 조회** — 앱 checkout 의 `activeCreditProducts` 와 동일 소스라 구조적 재드리프트 불가(가격 정본 단일화). config price 는 zod 1,000~100,000원 바운드라 서버 권위·클라 위조 차단(§18) 유지. 프로덕션 적용·검증(config 가 통과·위조가/미존재 상품 거절) 완료.
- **부분 환불 실패 핫픽스(2026-07-25, Migration 0066)**: 어드민 수량 환불 확정 시 `불변식 위반으로 전체 롤백`(Sentry `pay.refund_invariant_violation` fatal) — 실제 원인은 `permission denied for function derive_refund_request_state`. 환불상태 파생 constraint 트리거 `enforce_request_state_derive` 가 **DEFERRED**(커밋 시점 발화)인데 secdef 가 아니라 **outer 트랜잭션 롤(service_role)로 실행**되어, service_role EXECUTE 가 회수된 private helper `derive_refund_request_state` 호출에서 거부. secdef RPC 내부 인라인 호출(postgres)은 통과하지만 커밋 시점 deferred 트리거만 실패 → 로컬/pgTAP(postgres 실행)에선 미검출. **수정**: 트리거 함수를 SECURITY DEFINER 로 → 발화 롤 무관 postgres 컨텍스트 실행(helper 직접호출 차단은 유지). 프로덕션 적용·검증(service_role 컨텍스트 롤백 재현 통과) 완료.
- **환불 saga 상태정합 + 어드민 원장 표시(2026-07-25, Migration 0067·0068 — 로컬 service_role QA 매트릭스 발견)**: (0067) `admin_refund_switch_to_manual` 이 request state 재유도를 누락해 prepared/pg_requested/pg_pending 출처에서 커밋 시 deferred 트리거 abort → 다른 종단 RPC 와 동일하게 재유도 추가; 도달불가였던 `mark_pg_requested` 의 manual_review 재시도(set-once 충돌)를 가드에서 제거해 `invalid_state` 로 명확 거부(복구는 replan_after_pg 일원화). (0068) 어드민 '크레딧 조정/환불 이력'의 **부분환불 증감 0·잔액 X→X** 문제 — 크레딧 −N 회수가 begin(예약) 시점 발생(commit delta=v_after−v_before=0)이라, begin 이 캐시 예약분(`order_refund_attempts.cache_reserved_qty`)을 기록하고 commit 원장이 `before=v_before+cache_reserved_qty`·`delta=v_after−before` 로 실제 −N·잔액 감소를 표기(실 gen_credits·G-1·orders 불변, 감사 표시값만 정합). 검증: 0067(수동체인 무회귀)·**0068 전 케이스 44/44**(라이브/만료/saga중만료/policy-close/shortfall/다건/동시성, credit_ledger 교차검증) 통과. 프로덕션 적용 완료. ※ 0068 이전 커밋된 이력행(append-only)은 0 유지 — 신규 환불부터 정합.
- **마이페이지·결제내역 UX 개편(2026-07-25)**: `/account` 2탭(회원정보|결제내역, 탈퇴 유지 — `app/account/layout.tsx`+`AccountTabs`). 결제내역 '내 생성권' 요약카드 제거(크레딧 수는 헤더 AccountMenu 드롭다운)·`CreditsSummaryCard`·`GET /api/account/credits` 삭제(탈퇴용 refundable-credits 유지). 테이블: **결제완료(paid_at) 주문만·최신순(paid_at desc)**·결제수단(카드/토스페이/카카오페이)·테스트 배지·잔여크레딧(credits−refunded)·**KST 연월일시분**. (카카오페이 테스트 영수증은 목업 URL 정상.) KST 시분 전수검증 — 운영 타임스탬프는 전부 이미 KST·시:분(`fmtKst`), 그림자 복제 2건 dedup + `doll` 등록일 KST 교정. 어드민 KST 는 `fmtKst` 에 **연도 추가**(로트 만료연도 식별) — 어드민 전 표면 공용.
v0.77 (2026-07-26, 생성 프롬프트·수치 어드민 제어 + 캐릭터 provenance; **Migration 0069·0070**):
- **generation_config 도메인(Deploy A, 0069)**: 캐릭터 생성(flux-pulid) 프롬프트·수치를 코드 하드코딩 → 콘텐츠 콘솔 `generation_config`(`lib/config/domains/generation.ts`)로 이관. 프롬프트 **100% config 소유**(코드 영어 리터럴 0) — `assembleGenerationPrompts`(positiveTemplate `{head}{attire}{glasses}{expression}{tail}{identity}{idGlasses}` 치환, provider·에디터·golden 공용 단일소스). zod 계약(placeholder 규칙·수치 서브레인지 steps20–40/guidance3–6/trueCfg1–4/imageSize enum·suitColors≥3). `GENERATION_CONFIG_DEFAULT`=현행 **byte-identical**(golden 테스트가 조립 positive/negative·수치 동치 강제 — negative 이중콤마 quirk 보존). **uncached 강한읽기**(getGenerationConfig — 발행 즉시 첫 생성 반영, SWR 우회). 어드민 `/admin/content/generation_config`(수치 입력 + 프롬프트 편집 + 실시간 최종 프롬프트 미리보기). 강제 키워드 없음(사용자 결정) — 안전은 이력·롤백·검토. `CLAUDE.md §2`·`README` 정책 갱신, 데드코드 `generateBossDoll` 제거.
- **공용 롤백(Deploy A)**: `/api/admin/config` publish/restore union — 서버가 `app_settings_audit`(auditId+key) 조회→safeParse→재발행(CAS·cross-key 404·검증 400). history 페이지 `RestoreButton`("이 버전으로 되돌리기"). 전 config 도메인 공용.
- **생성 provenance(Deploy B, 0070)**: `ai_generations.gen_params` jsonb(어드민 전용) — 생성 당시 config/analyze(moondream)/generation(수치·프롬프트 스냅샷·후보 3)/postprocess(birefnet)/picked 스냅샷(`lib/character-gen/provenance.ts` v1 계약, 비밀·URL 미포함). 제출 **전** 선저장→`allSettled` 부분성공 제출→requestId 반영(실패 시 원자 환불). recovery는 **원 candidate index 보존**(`.flat()` 재번호화 제거, `{owner}/candidates/{genId}/{index}.jpg`)+seed 방어파싱. **pick 서버권위**(`/api/doll` = `{generationId, candidateIndex}`, 소유·done·candidate_urls 멤버십 검증→내부 서명→birefnet, 멱등·동시성 done→picked·보상삭제, `style_meta`=비민감 포인터). 어드민 **`/admin/generations/[id]` 상세**(단계별 프롬프트·수치·seed·후보, 원가·fal링크 없음) + 창구(생성 현황·회원 생성내역 링크). 0070은 gen_params grant + **ai_generations anon/auth SELECT revoke·owner-read 정책 drop**(어드민 전용화, 앱 15경로 전부 service_role 확인) + postflight. exact-set 6접점(eslint allowlist·selftest·G-43c·final·runbook) 동기화. 원가/fal 요청별 링크는 실비·딥링크 회수 불가라 미표기(실측 확정).
- **생성 품질 튜닝(2026-07-26)**: (비율) DEFAULT 프롬프트에 비율 앵커 강화(~2.5등신 수렴·정수리~발끝 온전·양손 내림) + negative 에 현실적비율/큰키/긴다리·손얼굴근처/브이/잘린머리 배제 + guidance 4→5(등신 편차 축소). 전부 generation_config 라 콘솔에서 미세조정·롤백 가능. 품질 개선은 실제 생성 테스트로 확인·반복(콘솔 롤백 안전). ⚠️ **프롬프트·수치의 라이브 정본은 `app_settings.generation_config` 발행행**(있으면 codeDefault 를 덮음) — 코드 DEFAULT 만 바꾸면 반영 안 됨(콘솔 발행 또는 `admin_update_app_setting` 필요). 프로덕션 v6 발행 완료(2026-07-27, steps25·trueCfg3 은 콘솔 튜닝 보존).
- **입력 검증 재작성(2026-07-27, QA 하드닝 2026-07-29~30)**: ⚠️ 기존 "5판정 1콜 compound 프롬프트"는 **무력**이었음 — moondream3/query 가 복수질문을 **첫 질문만 답하고 무시**(`face:yes` 만 반환) → 나머지 parse 전부 fail-open → 모든 사진 통과(브이·여러명 뚫림). fal 실측 후 **체크별 단일질문 병렬 호출**로 재작성(`lib/character-gen/face-analysis.ts` 순수 판정 + signed one-attempt face-check saga): 얼굴 유무 · **인원 수(여러 명)** · **가림(손/물건)** · 안경. 실회원은 DB가 생성 row와 크레딧 소비 영수증을 먼저 원자 확정한 뒤에만 유료 얼굴 검사를 시작하며, 확인된 위반(`no_face`/`multiple_people`/`face_obstructed`)이나 검사 실패는 같은 terminal 전이에서 원자 환급한다. 필수 호출 하나의 실패, null/빈값/모호한 yes·no, 복수 숫자·비정수·unsafe integer, 얼굴 유무↔인원수 상충은 정상 입력으로 추정하지 않고 외부 이미지 생성 제출 전에 fail-closed한다. **정수리 잘림은 입력 반려에서 제외** — moondream 이 이상적 증명사진까지 오반려해 신뢰성 미달(실측), 완결성은 생성 프롬프트(headTemplate·negative)가 담당(사용자 결정). provenance `analyze` 에 faceVisible/singlePerson/peopleCount/faceClear/wearsGlasses + 체크별 프롬프트·raw 기록(구 `fail_open` 레코드는 파싱 호환만 유지), 어드민 상세에 인원수·가림·검증 원문 표시. 판정 동치류 회귀는 `__tests__/generation/face-analysis.test.ts`.
- **입력 거부 어드민 가시화 + 거부 분류 확장(2026-07-27, 영수증 교정 2026-07-30)**: 입력 거부 row는 `status=failed`+`fail_reason`+`gen_params(analyze+rejected)`로 남아 어드민 "거부" 카테고리에 표시된다. 현재 실회원 경로는 `credit_lot_id` 소비 영수증을 먼저 만들고 반려 시 `refunded_at`을 원자 기록하며, 운영 계정만 lot 없이 미차감이다. 어드민 크레딧 표시는 fail reason 추정이 아니라 이 두 DB 영수증을 사용한다. 거부 분류는 `INPUT_REJECT_REASONS`(no_face/multiple_people/face_obstructed, `face-analysis.ts` 단일정본)이고 provenance `config`/`generation`은 거부 row에서 optional이다. 테스트 `__tests__/generation/provenance.test.ts`, `admin-generation-state.test.ts`.
- **⚠️ Migration 0069·0070 적용 필요** — 0069(app_settings key·RPC allowlist에 generation_config, seed 없음)·0070(gen_params 컬럼+CHECK+grant, SELECT revoke+policy drop, postflight). 배포순서 A(0069→코드)·B(0070→코드). 프로덕션 적용 완료(2026-07-26).
- **크레딧 변동 내역 통합 + 헤더 즉시 반영(2026-07-25)**: 회원 상세 '크레딧 사용 내역'을 **'크레딧 변동 내역(전체)'** 로 개편 — `getCreditHistory`(읽기전용 3소스 병합: `credit_ledger` + `admin_actions_ledger.cs_adjust` + `signup_bonus` 로트, `lib/admin-users.ts`)로 **가입 보너스·구매·생성 차감/환불·운영자 조정·환불·만료**를 한 타임라인에(기존엔 운영자 조정·가입 보너스 누락). 환불 표기는 예약(`refund_reserve`/`release`)은 내부 잠금이라 숨기고 **확정(`refund_commit`)만 −N**(내부=같은 attempt 예약 delta, 외부취소=행 delta)로 정합 — '예정 때 차감·확정 때 무증감' 혼란 해소. 각 행은 델타 칩(±N)에 더해 **`before개 → after개`(출발→도착)** 를 표기(`balanceBefore = balanceAfter − delta`, 봉투 원장 정의상 per-event 정확 — 프로덕션 13유저 실측: 최근 데이터 완전 연속, break 는 레거시/컷오버 경계 원장 gap뿐; refund_commit 표시 before 12건 mismatch 0). '도착값만' 보여 출발값을 역산해야 했던 문제 해소. 동일 소스를 **마이페이지 3번째 탭 `/account/credits`(생성권 내역, 유저 라벨·ref/사유 비노출, `force-dynamic`)** 재사용. 헤더 생성권(AccountMenu)은 `credits-changed` 이벤트(생성 제출·충전 확정 dispatch) + 탭 복귀(visibilitychange) 시 재조회로 **새로고침 없이 즉시 반영**. **스키마·트리거·RPC·마이그레이션 무변경**(순수 표시단 병합 — append-only 원장 가드·G-1 불변). ※ 참고: 너굴맨(운영 계정, `OPS_USER_ID`)의 생성은 설계상 크레딧 미차감(`create_generation_row` 바이패스) — 실유저 소비경로(`create_generation_and_consume`)는 프로덕션 실측으로 lot 귀속·`gen_consume` 원장·G-1 정합 확인(버그 아님).

v0.78 (2026-07-29, 긴급 Storage·공급망 보안 하드닝; **Migration 0071**):
- **private Storage RLS 폐쇄(0071)**: Dashboard 에 남아 있던 `storage.objects`의 public-role SELECT/INSERT 정책을 제거했다. `dolls`·`highlights`는 client policy 0개를 불변식으로 두고, 서버 발급 signed URL·signed upload token 및 service-role 경로만 사용한다. 프로덕션에는 선적용했고 anon list=빈 배열, cache-busting object GET=차단, synthetic signed upload=성공·정리까지 확인했다. 기존 공개 캐시 응답은 당시 `max-age=3600`이어서 최장 1시간 잔존 가능했으며 만료 후 재검증 대상으로 기록했다.
- **권위 조회 false-empty/false-default 제거**: 어드민·법무·이벤트·설정감사·결제/환불·캐릭터/생성 상태의 서버 조회는 resolved `{error}`, `data:null`, 손상된 행·count·timestamp·부분 enrichment를 빈 배열·0·기본 이미지로 축소하지 않는다. 목록은 안정 정렬 전페이지 조회 또는 exact count를 쓰고, window-count의 범위 밖 빈 페이지는 offset 0 probe로 실제 total을 복원한다. 갤러리는 `(created_at,id)` keyset+중복 제거, 플레이는 캐릭터 조회/서명/텍스처 실패와 배경 hot-swap 실패를 재시도/롤백으로 노출한다. 탈퇴는 환불가능 수량 권위 조회가 성공하기 전에는 확정할 수 없고, 진행 중 생성 조회 실패도 갤러리에서 별도 재시도한다. 공통 runtime 계약과 fault-injection/source inventory 테스트가 이 경계를 강제한다.
- **의존성 취약점 0건 + CI gate**: Next.js `16.2.12`(Proxy 우회 패치), Sharp `0.35.3`, PostCSS `8.5.24`, brace-expansion `5.0.8`, minimatch `10.2.6`으로 고정/override했다. `.github/workflows/quality.yml`이 PR/main마다 `npm ci`→audit→ESLint→TypeScript→단위/계약·golden·규칙 self-test→Sentry 업로드를 끈 production build를 강제한다.
- **탈퇴 외부정리 durable saga(0072)**: `admin_soft_delete_account`가 dolls·highlight·본인 업로드 avatar의 정규화 경로 manifest와 cleanup outbox를 **금융 quarantine·profile/member scrub·0034 highlight render-block/미처리 신고 종결·doll 삭제와 같은 트랜잭션**에 먼저 고정한다. `/api/account/delete`는 반환 manifest로 Storage(candidate/tmp-face 포함)·Auth 정리를 즉시 시도하고, resolved `{ error }`·throw·요청 중단은 pending/backoff로 남겨 `content-maintain`이 `FOR UPDATE SKIP LOCKED` lease로 재시도한다. Storage list는 전 페이지, remove는 bounded batch라 객체 100개 제한에 잘리지 않는다. 삭제 전에 발급된 2시간 signed-upload token과 탈퇴 중이던 doll pick의 늦은 객체까지 회수하려고 모든 소유 score의 `highlights/{scoreId}/`, `avatars/{userId}/`, canonical `dolls/{userId}/{uuid}.png`를 매번 다시 훑고, 빠른 1차 성공도 `final_sweep_after=삭제+2시간5분`까지 `pending_final_sweep`으로 유지한 뒤 마지막 전수 sweep에서만 completed+manifest `{}`로 scrub한다. 그 전 재활성은 `account_cleanup_pending`으로 막아 ABA 재삭제를 차단한다. 탈퇴 commit 뒤 stale 요청의 dolls/scores/ai_generations INSERT·생성 RPC뿐 아니라 기존 score를 향한 `score_highlights` INSERT도 profile/score lock+DB trigger가 `account_deleted`로 막고, route의 signed-upload confirm은 active profile·owner path·UUID·token age를 재검증하며 attach 실패 객체를 보상삭제한다. 실제 PostgreSQL 2세션 harness가 child-first/delete-first lock 순서와 direct INSERT backstop을 CI에서 강제한다. outbox는 완료 즉시 개인정보 manifest를 지우고 profile FK를 의도적으로 두지 않아 향후 합법적 profile purge가 cleanup 재시도/감사 이력을 막지 않는다.
- **생성 terminal·artifact 직렬화(0073)**: queued/done/picked/expired/failed 전이를 expected-version CAS와 원자 환급 RPC로 고정하고, `mark_generation_failed_and_refund`는 호출자가 본 version을 쓰기 전에 검증한 뒤 실제 전이 version으로만 환급해 stale 호출의 이중/오환급을 막는다. recovery의 candidate Storage copy는 별도 fenced write lease를 잡으며 terminal cleanup은 active lease가 끝날 때까지 물리삭제를 시작하지 않는다. CAS 패배 뒤 보상삭제가 실패하면 cleanup marker를 재개방하고, failed까지 terminal cleanup 대상에 포함해 다음 cron이 재시도한다. 탈퇴 소유자의 inflight generation은 전체 profiles를 앞에서 1000개씩 자르는 대신 실제 작업 row를 공정한 순서로 scan하며, provider 호출·새 Storage/DB write 없이 먼저 terminal 전이한 뒤 artifact를 정리한다. doll pick은 candidate와 tmp face가 모두 삭제된 뒤에만 cleanup marker를 완료하고, doll/하이라이트/avatar/어드민 업로드·영구삭제와 doll signed URL batch는 SDK가 resolve한 `{ error }`나 부분 응답도 성공으로 삼지 않는다.
- **인증·동의 판정 fail-closed + 익명이전 재시도**: `requireMember`/`requireAuthedNonDeleted`·OAuth callback·consent API가 profile/member/legal read의 resolved `{ error }`를 no-row/발행본 없음과 명시 구분한다. 보안경계 API는 503, callback은 세션·MIGRATE를 보존한 `/consent` 재판정으로 막고, `/consent` 표시 읽기는 전문 no-row·손상·버전 경합까지 명시적 재시도 UI로 차단한다. 신규 익명이전은 member INSERT 전에 수행하며 signed source 권한과 target Auth/member를 runner 내부에서 재검증하고 Auth/member/count 3종/reassign/delete 각각의 throw·resolved-error와 손상 count를 전부 retryable 실패로 처리해 cookie 유지+row 미생성으로 다음 POST에서 재시도한다. 이미 이전·Auth 삭제 뒤 동의 INSERT만 실패했거나 Auth만 먼저 사라진 경우의 명시적 `user_not_found`는 위 권한·target 검증 뒤 no-row/삭제 완료로 정규화하고 멱등 reassign으로 남은 orphan 데이터를 복구하며, 기존회원 재로그인 병합 금지는 유지한다. 순수 read/migration 정책 helper에 전 연산 resolved-error·throw fault-injection 테스트를 추가했다.
- **브라우저 Auth singleton·로그인 경합 폐쇄(2026-07-31)**: 브라우저는 같은 auth cookie에 GoTrueClient를 하나만 두어 refresh single-flight·BroadcastChannel·visibility/auto-refresh owner를 중복 생성하지 않는다. 익명 로그인과 reviewer password login은 FIFO로 직렬화하고, 현재 SDK가 첫 async 경계 전에 시작하는 fetch에 operation signal을 결합해 header 이후 response body가 끝날 때까지 취소를 전달한다. 대기 중 취소된 mutation은 네트워크를 시작하지 않는다. fresh reviewer/OAuth 시작은 SessionBootstrap의 익명 session single-flight에 먼저 합류해 늦은 anonymous 응답의 member session 덮어쓰기와 이른 OAuth missing-session 실패를 막는다. auth read/local signout은 shared lifecycle이라 결과 publication만 bounded fence하고, profile/gallery/badge/play PostgREST는 query별 `.abortSignal`을 유지한다. Fast Refresh도 전역 symbol scope를 재사용해 retained singleton fetch와 새 caller가 갈라지지 않는다. 설치된 Supabase SDK runtime 회귀가 7회 client 생성 identity=1·중복 경고=0, lifecycle owner 불변, signal/FIFO/body-abort/final-member 불변을 고정한다.
- **SSR-preserving SessionBootstrap(2026-07-31)**: root layout은 홈·FAQ·이용약관·개인정보처리방침을 포함한 ordinary subtree를 서버 HTML에는 즉시 렌더하고, 브라우저 hydration만 OAuth null-flow discovery와 안정 Auth baseline 뒤로 미룬다. 따라서 Auth API/Web Locks 장애가 지속돼도 공개·법무 본문이 전면 spinner로 대체되지 않으며, 그동안 descendant client effect·Supabase writer는 실행되지 않는다. 초기 bootstrap 실패는 document identity invalidation과 분리해 reconciliation owner를 clean release하고 5초 local retry만 수행한다(`reload=0`, `body.inert=false`).
- **Path/Domain-scoped Auth cookie 복구(2026-07-31)**: proxy가 `/auth/reconcile`로 넘기는 HttpOnly capability는 nonce뿐 아니라 reason·exact user/session CAS·원래 request pathname·값을 제외한 Supabase auth-token **및 code-verifier** cookie exact-name set 전체의 SHA-256에 결속된다. 이름 목록은 4KiB로 제한해 비정상 Cookie header가 거대한 `Location`으로 반사되지 않으며, 비-GET/HEAD 요청은 303으로 바꿔 원 mutation method/body를 복구 페이지에 재전송하지 않는다. 브라우저는 origin-wide H→SDK S lock 안에서 `.64`·`.foo` 같은 임의의 안전 suffix까지 원 pathname의 exact names와 복구 페이지에서 보이는 auth/verifier names를 양쪽 non-root RFC path-match 경계에서 먼저 tombstone하고, OAuth barrier가 없음을 확인한 뒤 verifier의 root/current 변형까지 제거한 다음에만 root auth를 판정한다. valid root는 보존하고 corrupt/absent root만 제거한다. 구조상 유효하지만 서버에서 폐기된 세션은 실제 storage와 분리된 non-persisting Auth probe가 판정하며, 명시적 invalid/missing rejection에서만 raw-cookie fingerprint·access/refresh token·user/session ID의 exact CAS를 SDK S lock 안에서 다시 통과한 뒤 로컬 세션을 지운다. network·429·5xx·모호 오류는 기존 세션을 보존한다. lock 해제 전 원 pathname과 `/auth/reconcile` 양쪽 `HEAD` probe가 auth+verifier **name/value multiset fingerprint**의 root-only 또는 empty post-state를 확인하므로 `/account` stale cookie와 `/auth` scoped cookie의 역방향 조합, Domain/Path 삭제 실패, 동일-name duplicate, JS에 안 보이는 HttpOnly verifier가 무한 redirect나 정상 root 로그아웃으로 숨지 않고 명시적 재시도 UI로 fail-closed한다. 동시 reconcile의 단일 capability cookie overwrite도 다른 query에 권한을 주지 않으며 losing tab은 mutation 없이 오류 UI에 머문다.
- **원자 checkout·설정·탈퇴 직렬화 + 결제·청약철회 증거 fail-closed(0075/0087~0092)**: 008899의 12-arg 주문 core는 candidate order object → `growth_levers` config → member user 순서의 advisory boundary 안에서 요청을 검증하고, 008905의 영구 19-arg wrapper가 분리된 적극 확인의 request ID·사용자·주문·상품명/금액/수량·TEST/LIVE·채널·표시 snapshot hash·문구/버전·DB 시각을 같은 트랜잭션에 불변 저장한다. route는 표시 증거와 주문·확인 증거를 모두 재조회하기 전에는 PortOne 파라미터를 반환하지 않는다. auth·64KiB body·config·reviewer·DB 호출은 같은 20초 route deadline(`maxDuration=25`)을 공유하고, 브라우저의 단일 PortOne SDK 호출은 10분 hard cap 뒤 재호출 없이 `/credits/done`의 64KiB strict 응답 폴링으로 수렴한다. expand의 evidence-free 12-arg wrapper는 frozen 구 앱 호환용이고 0092가 제거하며 private core 직접 실행권도 없다. 시간·상품별 재사용 창은 없다. PortOne의 `pending` 또는 `failed`이면서 `paid_at`/`canceled_at`이 없는 주문은 모두 나중에 과금될 수 있는 **사용자 전역 미해결 intent**이며, DB partial unique index가 사용자당 최대 1개만 허용한다. 같은 payment ID는 exact replay, 새 payment ID의 같은 상품·test-mode·채널은 기존 주문의 금액·수량·store/currency/channel key를 담은 **불변 영수증을 그대로 reuse**한다. 다른 상품·mode·채널은 `checkout_prior_intent_unresolved`, 둘 이상이면 `checkout_reuse_ambiguous`로 중단한다. expand 동안 구 9-arg `create_pending_order`는 미해결 intent가 없으면 `checkout_upgrade_required`, 같은 payment ID의 exact pending replay만 성공, 다른 ID는 `checkout_reuse_required`이며 신규 all-NULL 증거 주문을 만들 수 없다. 모든 PortOne 주문은 생성 시 `expected_store_id`/`expected_currency`/`expected_channel_key`를 고정한다. 레거시 all-NULL 증거 행은 어떤 webhook·poll·reconcile·settle에서도 지급하지 않고 `payment_evidence_incomplete`로 실패하며, fresh PortOne 조회가 exact 주문 ID·payment ID·금액·test-mode·로컬 채널과 provider의 store/currency/channel key를 모두 입증한 경우에만 expand-only backfill할 수 있다. `profiles FOR KEY SHARE`와 0072 탈퇴의 `profiles FOR UPDATE` 충돌은 **checkout-first → `payment_pending`**, **delete-first → `account_deleted`**로 끝나며, 주문 trigger와 unique index가 RPC 우회도 막는다. 환불 saga 권위 read와 테스트채널 mismatch 감사 write도 resolved `{error}`·throw를 성공/빈값으로 축소하지 않는다.
- **환불 PG 증거 무결성(0077)**: PG 요청 전 원주문 total·취소누계·취소가능액 등식과 정확한 `{amount, reason, currentCancellableAmount}` body를 attempt row lock 아래 검증하고, preflight 멱등도 5개 snapshot 필드 전체가 같을 때만 허용한다. `SUCCEEDED` 취소 결과는 실제 `cancelled_amount`가 양수이면서 계획된 `attempt.amount`와 정확히 같아야 event→`pg_succeeded`→commit으로 전진한다. NULL·부분·초과·충돌 증거는 event/attempt/order/ledger를 하나도 바꾸지 않고 안전 오류로 중단한다. 외부 취소 관측 RPC의 resolved `{error}`·throw·손상 결과도 더는 skip하지 않아 웹훅 5xx 재전송, 폴링 503, reconcile 미해결 신호로 전파한다.
- **모더레이션 영구삭제 fenced saga(0078)**: 영구삭제 요청을 `moderation_purge_jobs`에 먼저 기록하고 `doll → job` 순서의 row lock, lease token/version, 만료 검증으로 worker 중복·stale finish·복구 경쟁을 직렬화한다. 복구가 먼저면 purge는 `not_taken_down`, purge가 먼저면 복구는 `purge_pending`으로 결정되며 Storage 삭제가 실패해도 202+outbox로 남아 `content-maintain`이 재시도한다.
- **모든 signed-upload intent + DB-first 객체 정리(0079)**: site asset·event image·avatar·highlight·doll의 signed upload를 모두 DB intent 선발급→owner/canonical path/token freshness·실객체 size 및 **path 확장자와 정확히 일치하는 안전 Content-Type** 검증→원자 attach로 통일했다. 미attach 객체는 2시간5분 뒤 fenced orphan cleanup이 회수하고 avatar 교체/초기화·만료 highlight·doll 삭제는 DB reference 변경과 cleanup outbox를 같은 트랜잭션에 남긴다. 운영자가 발행한 site/event asset은 롤백·감사를 위해 자동 detach cleanup하지 않는다. 구 서버에서 token 발급 후 새 서버에서 finalize되는 배포 경계는 위 검증을 먼저 통과하고 exact missing-intent일 때만 context-bound intent를 채택하며, 응답 유실·동시 채택·재시도는 2차 exact confirmation으로 수렴한다. 채택 시점 DB 장애로 intent insert 자체가 남지 않은 극단 경계는 0079 expand 시각부터 `0092` contract+기존 token horizon까지만 열린 **유한 inventory window**가 보완한다. `content-maintain` scanner가 canonical·15분 초과 grace·미참조·무intent 객체만 기존 fenced receipt로 승격하며, reference와 scanner는 동일 storage-path advisory lock을 사용한다(reference 선착→보호 ledger, cleanup 선착→후속 attach 거부). window 밖 과거 객체와 contract 당시 참조 자산은 후보가 될 수 없다.
- **금융·크레딧·계정 lifecycle 전역 잠금 순서(0084)**: 결제/주문·환불 attempt/request/event·크레딧 lot/cache·생성 소비/환급·탈퇴/재활성/동의/OAuth/avatar/익명이전/심사계정 finalize의 외부 mutation 42개를 owner-only 구현으로 격리하고, 외부 wrapper만 공통 `object(s) → member user(s) → row` 순서로 진입한다. 기존 score/report/ban과 정확히 같은 `member:<uuid>` advisory key를 재사용하고 request/legal/anonymous의 기존 advisory도 wrapper에서 먼저 선취해 nested wrapper의 late-object 역전을 없앴다. `sweep_expired`는 `(expires_at,id)` exact ID batch와 UUID 정렬 user set을 먼저 고정한 뒤 재검증한다. 마이그레이션 postflight가 signature/default/return/ACL/search_path, 내부 실행권, wrapper call graph, trigger OID 우회를 원자적으로 거부하며, pgTAP 34계약과 실제 2세션 P↔O·M↔L·O↔A·O↔E·다중-row barrier/deadlock 모니터를 CI에서 실행한다.
- **관리자 mutation 영수증·상태 CAS(0085)**: 설정·이벤트·가역 신고조치·영구삭제 begin·무결성조치·재활성·stuck 정산을 `admin_mutation_requests`의 exact-payload 영수증으로 통일하고 contract(`0092`)에서 legacy service-role 우회 RPC를 닫는다. 영구삭제는 receipt replay를 현재 상태 확인보다 먼저 수행한 뒤 `hidden`+정확한 doll version을 잠가 0078 fenced saga를 시작하므로 응답 유실과 hidden→restore→hidden ABA를 함께 차단한다. 완료된 job의 재시도는 claim `idle` 뒤 job+doll 결합 status RPC의 terminal 증거로 200을 복구하고, pending/leased·malformed status는 완료로 오인하지 않는다. 일반 복구-before-POST는 aborted tombstone, event create intent는 delivery UUID가 달라도 1행이며 같은 탭의 응답 유실 뒤 폼 변경도 기존 create를 먼저 복구한 후 update로 수렴한다. 이벤트/score/member/doll version은 JS exact integer 상한을 갖고 ABA를 차단한다. 재활성은 최초 resolved email과 삭제 timestamp+단조 증가 탈퇴 세대를 pending 영수증+RPC-only durable job에 고정하고 route/cron이 같은 worker를 사용한다. worker는 activate marker→동일 email, cancel 동일 email→marker만 허용하고 Auth trigger/app_metadata의 exact admin/target/request/action/token/version/expiry/generation fence와 fresh read를 모두 통과한 finish에서만 DB를 활성화하거나 취소한다. 관리자 상세 새로고침은 job+receipt 단일 snapshot의 최소 pending correlation을 복구하며 pending 중 중복 activate 입력을 막고, durable cancel intent는 최초 actor/reason을 바꾸지 않은 채 어느 active admin도 보상을 재개할 수 있다. expand 구 route의 active-profile/Auth 불일치는 permanent legacy outbox가 캡처하고, marker→real과 새 탈퇴를 별도 transition lock으로 직렬화하며 제3 실제 email은 자동 overwrite하지 않고 `0092` gate를 막는다. semantic poison과 int4 counter exhaustion은 뒤 job을 굶기지 않도록 finite backoff/quarantine되고, pending/leased 동안 profile lifecycle trigger와 generation이 새 탈퇴주기 ABA를 막으며 queue-health가 backlog를 `429 + Retry-After: 60`으로 보존한다. 정산은 read-only receipt→PortOne→DB 순서다. pgTAP 146계약, 실제 2세션 12개 결정론 interleaving, 로컬 GoTrue Admin API의 2-provider identity 보존·activate 최종 commit·cancel·stale/third-real 전체 rollback을 CI에서 검증한다.
- **동의·프로필·탈퇴 TOCTOU 폐쇄 + strict config**: 신규 동의와 profile/member/email/가입보너스 반영을 단일 RPC로 묶고, terms→privacy advisory lock 아래 화면에 표시된 정확한 발행 버전을 재검증한다. 탈퇴는 같은 profile/member 잠금과 동의 scrub으로 늦은 consent/OAuth writer를 차단한다. 가입·생성 경로의 설정 read가 실패하거나 저장된 설정이 손상되면 code default로 축소하지 않고 외부 호출·크레딧/회원 변이 전에 503으로 중단한다.
- **얼굴 분석 승인 fail-closed**: Moondream 필수 체크(얼굴·인원수·가림·안경)의 일부 장애나 모호/상충 응답을 더는 정상 사진으로 추정하지 않는다. 분석 불확실성은 임시 얼굴 정리를 시도한 뒤 503으로 끝나며, generation row·크레딧 소비·유료 FAL 생성 제출은 발생하지 않는다. 확인된 입력 위반만 기존 400 재촬영 경로로 분리한다.
- **FAL 단일 제출·응답유실 복구 saga(0086)**: SDK의 queue POST 자동 재시도를 사용하지 않고, 후보별 payload hash·callback token hash intent를 DB에 먼저 기록한 뒤 정확히 한 번 claim된 후보만 raw POST 1회를 보낸다. transport 오류·408/409/429/5xx·손상 2xx는 수락 여부가 불확실하므로 즉시 재제출/환불하지 않고, 공개 HTTPS callback의 raw body를 fal JWKS ED25519·±5분 timestamp·request ID로 검증해 request ID를 복구한다. queue start는 `X-Fal-Request-Timeout: 600`으로 제한하고, JWKS는 23시간 캐시하되 키 교체 서명 실패 시 분당 1회 이하로 강제 갱신하며 64KiB를 초과하는 키 응답은 거부한다. 동일/상충/terminal 이후 callback은 각각 멱등·conflict·late evidence로 영속한다. 응답불명 제출은 fal 문서의 기본 처리 1시간과 webhook 2시간 재전송을 합산한 200분 뒤에만 timeout 후보가 되며, 환불은 조회한 generation version을 RPC에 전달해 callback과 CAS한다. 실제 PostgreSQL 두 세션에서 claim/동일 ack/ack↔환불 양방향과 deadlock 불변식을 CI로 검증한다. **QA에서는 실제 fal.ai 생성·과금 호출을 하지 않고** raw HTTP fault injection, 로컬 ED25519, pgTAP 및 DB race만 사용한다. 단, fal이 공개하지 않은 endpoint별 처리 상한·submit idempotency가 바뀌는 경우는 외부 경계라 운영 모니터/문서 재검토가 필요하다.
- **운영 cron false-green 제거**: `gen-recover`·`content-maintain`·`reconcile`·`credit-expire`·`privacy-maintain`을 포함한 현재 8개 ops route는 공통 20초 monotonic soft deadline과 25초 platform ceiling 안에서 끝나며 외부 scheduler timeout은 90초다. route inventory는 `app/api/ops/**/route.ts`에서 동적으로 생성되어 새 route도 공통 gate에 자동 편입된다. 권위 쿼리/RPC 오류·손상 응답은 503, 재시도 대기 또는 bounded batch/시간 예산 한도 도달은 `429 + Retry-After: 60`, queue가 비었다고 증명된 경우만 200/`ok:true`와 success heartbeat다. cron-job.org가 성공으로 오인하는 207은 사용하지 않는다. 결제 대사는 미해결 주문, refund `pending`/`blocked`/`outstanding`, 항목 예외, 정확한 배치 경계를 각각 집계하고 취소 관측에서 생성된 reconciliation issue 수도 응답에 보존한다. 크레딧 만료가 20초 soft deadline에 닿으면 `done:false`·failure heartbeat로 다음 drain 필요를 드러낸다. 생성 회수 대상은 filter-before-limit 기아를 막기 위해 signed-submit 창을 포함한 4시간 권위 window를 `(created_at,id)` keyset으로 읽어, 앞 페이지 행이 동시에 terminal 상태로 빠져도 뒤 행을 건너뛰지 않은 뒤 provider 작업만 제한한다. 0078/0079/동의 lifecycle은 pgTAP 122개 계약과 실제 PostgreSQL 2세션 7개 lock-order 시나리오를 CI에서 검증한다.
- **HTTP·외부 응답 자원 경계**: deployable 페이지 56개와 API route 58개를 exact manifest로 고정하고, 모든 API가 명시적 HTTP method를 export하며 임시 local-QA route/payload가 없음을 inventory 테스트로 검증한다. 모든 API route에 `request.json/text/arrayBuffer/blob/formData` 직접 호출이 남지 않도록 별도 inventory 테스트로도 고정했다. 공개·회원 JSON은 strict UTF-8 object와 64KiB, 관리자 JSON은 기본 64KiB(설정·이벤트·법무 문서는 1MiB), 신고 32KiB, 분석 track 4KiB, PortOne webhook 64KiB, FAL webhook 512KiB로 `Content-Length`와 실제 stream 양쪽을 제한한다. 생성 multipart는 이미지 10MiB+64KiB overhead를 먼저 제한한 뒤 파싱한다. PortOne 응답은 256KiB, FAL queue ACK 16KiB, billing/JWKS는 64KiB로 제한하고 인증 헤더를 가진 PortOne/FAL fetch와 OG media fetch는 redirect를 거부한다. 현재 8개 cron route는 4KiB 상한과 SHA-256 고정길이 digest의 constant-time 비교를 공유하며 동적 inventory가 누락을 막는다.

**Migration 0072~0092 무중단 롤아웃**: expand는 26개 파일인 `0072`~`008907`의 additive 묶음, contract는 `0090`~`0092`의 3개 파일이다. 전체 신 앱은 expand DB surface를 요구하므로 현재 운영 코드에 outer checkout gate만 넣은 bootstrap 배포를 먼저 올리고, anonymous checkout의 exact 503 body와 `X-Boss-Paegi-Payment-Rollout: frozen` header로 동결을 증명한다. 최종 release branch는 unchanged `origin/main` 위로 rebase하고 PR CI가 green인 clean HEAD의 exact commit/tree를 고정한다. 직전 fetch에서도 `origin/main`이 변하지 않았을 때만 그 exact source에서 운영 expand를 **DB 먼저** 적용해 journal receipt를 같은 commit/tree에 결속하고, 이어 같은 HEAD를 `main`으로 fast-forward push해 Vercel 자동 배포를 시작한다. expand 뒤 `main`이 움직였다면 force-push하거나 다른 commit을 배포하지 않고 additive DB 상태를 유지한 채 재평가한다. 운영의 populated `orders`에는 `qa:payments:ensure-intent-index`가 duplicate 0을 증명하고 사용자당 미해결 intent partial unique index를 독립 `CREATE UNIQUE INDEX CONCURRENTLY` 요청으로 선빌드한다. active concurrent build는 건드리지 않으며, 응답 중단이 남긴 exact-definition invalid index만 progress 부재를 확인한 뒤 독립 concurrent drop→duplicate 재검증→rebuild로 복구한다. `0087`은 이 exact valid/ready index가 없으면 실패하며, regular index fallback은 row가 0개인 fresh local reset에만 허용한다. 운영 runner는 `0087_payment_evidence_expand_ddl.sql`→`008800_payment_evidence_expand_validate.sql`→`008899_server_read_surface_rollout_gate.sql`→`008900_public_write_quotas.sql`→`008901_generation_storage_cost_controls.sql`→`008902_financial_projection_bounds.sql`→`008903_bounded_asset_cleanup_sagas.sql`→`008904_privacy_retention_controls.sql`→`008905_legal_commerce_generation_compliance.sql`→`008906_admin_search_helper_acl.sql`→`008907_atomic_active_event_snapshot.sql`까지 파일당 한 요청과 atomic journal receipt로 적용한다. `008905`는 분리된 청약철회 확인 증거와 생성 공급자 만 19세·Terms/AUP flow-down 증거를 구현한다. expand pending=0 뒤에는 evidence-free 12-arg 구 앱 호환 wrapper와 evidence-required **영구 19-arg** 신 앱 caller를 **계속 runtime frozen 상태로** 배포하고, canonical bundle의 구성된 live/test channel subset과 로컬 runtime secret을 교차검증해 기존 PortOne all-NULL 증거 행을 fresh provider 조회 기반 dry-run→backfill한다. production wrapper는 clean exact release commit/tree를 권위로 삼아 bundle 추출 전·후와 backfill 종료 뒤 checkout·FAL·doll의 동일 project/commit frozen identity를 재검증한다. old server invocation·background worker·legacy repair/Auth mismatch를 drain하되 장기 생존 구 브라우저는 전수 열거하지 않고 새 route와 contract surface로 fail-closed한다. 모든 PortOne row의 완전한 증거와 drain을 입증한 뒤에만 `0090_payment_evidence_contract_constraint.sql`→`0091_payment_evidence_contract_validate.sql`→`0092_rollout_contract_cleanup.sql`을 적용해 required CHECK, 임시 backfill/DML, 구 9-arg RPC, expand-only 12-arg checkout wrapper, 브라우저 DELETE, rollout flag를 닫고 영구 19-arg surface만 남긴 뒤 `qa:db:rollout-contract`를 실행한다. contract apply runner는 적용 직후 blocker inventory를 다시 읽어 초기 gate 뒤 생긴 변경도 성공으로 축소하지 않는다. 청약철회 제한 분리 확인·불변 증거의 compile-time 구현 fence는 완료됐지만, contract pending=0과 probe·앱 smoke를 모두 통과한 뒤에만 `PAYMENT_CHECKOUT_ENABLED=1`로 실제 경로를 연다. fal 생성 공급자 acceptance evidence도 구현됐지만 external compliance fence는 별개이며, fal의 서면/DPA/private ACL·국가·보존기간 조건이 충족될 때까지 생성은 compile-time frozen이다. checkout convergence harness는 expand-only 9-arg/12-arg 호환과 19-arg 증거 수렴 경계를 함께 확인하고, 단계가 다르면 아무 데이터도 만들지 않은 채 종료한다. 전체 절차와 실행 증거는 `docs/qa-validation-report.md`, 점수 표면의 상세 호환성은 `docs/score-submission-integrity.md`, 운영 결제 절차는 `docs/portone-cutover-runbook.md`가 정본이다.

**⚠️ Migration 0066 적용 필요** (`supabase/migrations/0066_refund_state_trigger_secdef.sql`): 환불상태 파생 DEFERRED constraint 트리거 함수 `enforce_request_state_derive` 를 SECURITY DEFINER 로(부분 환불이 커밋 시점 service_role 컨텍스트에서 private helper 호출 거부로 전량 실패한 핫픽스). 데이터 무변경(함수 속성만), 앱 코드 변경 없음. 프로덕션 적용 완료(2026-07-25).

**⚠️ Migration 0065 적용 필요** (`supabase/migrations/0065_create_pending_order_config_source.sql`): `create_pending_order` 가격 allowlist 를 하드코딩 → `growth_levers` config 단일정본으로 전환(가격 드리프트로 결제 전량 실패한 핫픽스). 데이터 무변경(create or replace + EXECUTE 재확정), **앱 코드 변경 없음**(checkout 이 이미 config 가격 전달). 프로덕션 적용 완료(2026-07-25).

**⚠️ Migration 0061 적용 필요** (`supabase/migrations/0061_business_info_domain.sql`): business_info 도메인 — `app_settings` key CHECK + `admin_update_app_setting` RPC allowlist 확장(0045 패턴) + **기존 site_content 발행값의 businessInfo 를 새 key 로 seed**(`{"info": …}` 형태, `on conflict do nothing`). ⚠️ **코드 배포와 동시 적용 필수**(0058 선례): seed 없이 새 코드가 배포되면 푸터가 코드기본값(미설정=비노출)으로 떨어져 PG 심사 요건 노출이 끊긴다. 적용 후 확인: 콘솔 '사업자 정보' 탭에 기존 값 표시 + 푸터 정상 노출.

**⚠️ Migration 0058 적용 필요** (`supabase/migrations/0058_portone_orders.sql`): 페이앱→포트원 전환 — `payapp_orders`→`orders` 리네임 + 컬럼 일반화(pg_tx_id/pg_status/provider/payment_id, payurl 제거) + refund_state 'pg_done' + RPC 전면 재정의. **단일 트랜잭션(begin/commit)·기존 22 rows 보존(provider='payapp')**. ⚠️ 리네임이라 **코드 배포와 동시 적용 필수**(구 코드는 payapp_orders 참조 — 순서: 마이그 적용 직후 배포, 결제는 어차피 creditsEnabled OFF+env 미설정으로 비활성 상태라 무風險). + env 6종(PORTONE_*) 설정, cron-job.org reconcile 잡은 그대로(경로 불변), Sentry `payapp.*` 모니터→`pay.*` 재설정.

**⚠️ Migration 0045 (미디어 자산)** (`supabase/migrations/0045_media_config_domain.sql`): `app_settings` key CHECK + `admin_update_app_setting` RPC allowlist 에 `media_config` 추가(0040 패턴, CAS·감사 동일). **신규 public `site-assets` 스토리지 버킷**은 별도 생성(대시보드/Management API, 마이그 밖 — events 버킷과 동일). additive·무중단. **코드 배포 전 적용**.

**⚠️ Migration 0044 (배너 지면별)** (`supabase/migrations/0044_events_banner_surfaces.sql`): `events`에 `banner_home/gallery/leaderboard_active` 3컬럼 + backfill(기존 `banner_active=true`→3지면 true) + 부분 인덱스 3 + `admin_save_event` **17-arg 오버로드**(3 배너 파라미터). **구 15-arg RPC·`banner_active` 컬럼은 보존**(롤아웃 윈도우 중 구코드 read/call 호환 — 페이지 read 무영향; 후속 정리 마이그에서 제거). additive·무중단. **코드 배포 전 적용**.

**⚠️ Migration 0043 (이벤트/공지)** (`supabase/migrations/0043_events.sql`): `events`(공지/이벤트 게시판·팝업·배너 단일 소스, status+노출윈도우+플래그) + `events_audit`(details jsonb) + `admin_save/publish/unpublish/delete_event` RPC(하드닝·advisory lock·이미지 출처 검증·끝에 `notify pgrst`). **신규 public `events` 스토리지 버킷**은 별도 생성(Management API, 마이그 밖). additive·무중단(신규 테이블, 기존 무영향). **코드 배포 전 적용**(배포된 코드가 events 테이블 조회).

**⚠️ Migration 0041 (프로덕션 적용 완료 2026-06-27)** (`supabase/migrations/0041_consent_unify.sql`): `create_or_update_member_consent` RPC — 통합 동의(insert[보너스·stamp]/update[필요 항목만] 원자 처리·`on conflict (user_id) do nothing`·`is_new` 반환, `security definer set search_path`·service_role only). **컬럼 변경 없음**(기존 0030/0031/0037 컬럼 사용) — 함수 추가만, 롤백=`drop function`. 코드 배포와 함께 적용.

**⚠️ Migration 0037 (프로덕션 적용 완료 2026-06-25)** (`supabase/migrations/0037_account_reactivate.sql`): `account_admin_actions_ledger`(계정 액션 전용 감사) + `member_accounts.reconsent_required` 컬럼 + `admin_reactivate_account`/`admin_find_withdrawn_by_email` RPC. **additive·기존 데이터 무영향**(reconsent_required default false).

**⚠️ Migration 0035·0036 (Phase 2, 프로덕션 적용 완료 2026-06-25)**: 0035(`score_highlights.highlight_deleted_by_doll` + `admin_takedown_doll` 재정의[만료 가드·by_doll 태깅] + `admin_restore_doll` + ledger CHECK 확장) — 코드 배포와 함께. 0036(`dolls`·`highlights` `public=false` + `image_url`/`candidate_urls` 경로 backfill[idempotent·dry-run 후]) — **코드 배포 + flip前 검증 후** 적용. 플립은 `public=true` 로 롤백 가능.

**⚠️ Migration 0034 적용 필요** (`supabase/migrations/0034_content_moderation.sql`): `dolls`에 `deleted_at`/`deleted_by`/`deletion_reason`/`artifacts_purged_at` + `content_reports`·`moderation_actions_ledger` 테이블 + 당시 `admin_takedown_doll`/`admin_dismiss_report` RPC. 현재 dismiss/takedown/restore/permanent-delete runtime은 receipt·state/version CAS가 결합된 `admin_moderation_action_idempotent`를 사용하고, superseded `admin_dismiss_report`는 0095부터 owner-only다. **additive·기존 데이터 무영향**. **배포 순서: 0034 먼저 적용 → 코드 배포**(읽기 게이트가 `deleted_at` 컬럼 조회). content-maintain cron-job.org 등록(`CRON_SECRET` 재사용). Sentry `report.new` 알림룰(occurrence당 통지) 설정. ※ 0032/0033 은 README changelog 미기재(병렬 작업) — v0.36/0.37 비어있음, 필요 시 번호 조정.

**⚠️ Migration 0030 적용 필요** (`supabase/migrations/0030_withdrawal_age.sql`): `profiles.deleted_at`·`member_accounts.age_confirmed_at` 컬럼 + `payapp_orders.user_id` FK CASCADE→RESTRICT(동적 제약명) + `admin_soft_delete_account` RPC + `mark_paid_and_grant` 탈퇴자 가드(재정의). additive·결제 정상경로 불변.

**⚠️ Migration 0031 적용 필요** (`supabase/migrations/0031_signup_migrate.sql`): `member_accounts` 동의 컬럼(`terms_agreed_at`·`privacy_agreed_at`·`terms_version`·`privacy_version`) + `reassign_anon_data` RPC(scores·user_badges·telemetry owner_id 재-own, conflict-safe). server-only. Management API 적용 완료. additive.

**마이그레이션 적용**: 0006~0011 은 Supabase **management API query 엔드포인트**로 직접 적용 완료
(`POST /v1/projects/<ref>/database/query`, `SUPABASE_ACCESS_TOKEN`). 이후 마이그레이션도 동일 방식 — `.sql` 은 `supabase/migrations/` 에 보존(추적용).

**⚠️ Migration 0019 적용 필요** (`supabase/migrations/0019_payapp_orders.sql`): `payapp_orders` 테이블 + `mark_paid_and_grant` RPC. 적용 + `PAYAPP_*`/`NEXT_PUBLIC_SITE_URL`(prod) env 설정 전엔 결제 비활성(503).

**⚠️ Migration 0020 적용 필요** (`supabase/migrations/0020_admin_monitoring.sql`): `is_admin`+seed(emfoa23)·`payapp_orders.canceled_at/clawback_credits`·인덱스·`admin_actions_ledger`·`get_admin_funnel`/`get_admin_order_summary`/`admin_settle_stuck_order`/`admin_cancel_order`/`admin_adjust_credits` RPC. **additive(구 코드 무영향)** — 적용 전엔 `/admin` 비활성(requireAdmin 관용 차단). + env `CRON_SECRET`(.env.local+Vercel), cron-job.org 설정, Sentry emfoa23 초대.

**⚠️ Migration 0022 적용 필요** (`supabase/migrations/0022_admin_read_side.sql`): 어드민 read-side — 인덱스 + `payapp_orders.refund_state`(읽기) + `search_members`/`search_orders`/`get_user_generations` RPC(`security invoker` + service_role grant). additive.

**⚠️ Migration 0023 적용 필요** (`supabase/migrations/0023_refund_block.sql`): 머니 패스 — `admin_cancel_order` 5-arg(`p_payapp_done`, 회수부족 조건부 block/clamp+shortfall·화해) + 4-arg wrapper(무중단). + `PAYAPP_LINKKEY` env(자동환불). additive(drop 없음).

**⚠️ Migration 0024 적용 필요** (`supabase/migrations/0024_cancel_payapp_done_clawback.sql`): `admin_cancel_order` 회수 조건 `(p_clawback OR p_payapp_done)` — pending 취소가 TOCTOU 로 paid 가 된 순간에도 페이앱 환불(payapp_done) 시 크레딧 무조건 회수(머니 손실 차단). additive(create or replace).

**⚠️ Migration 0025 적용 필요** (`supabase/migrations/0025_app_settings.sql`): 마케터 설정 substrate — `app_settings`(도메인 key→jsonb)+`app_settings_audit`(전용 감사)+`admin_update_app_setting`(key allowlist·version CAS·감사 한 txn·security definer). **server-only**(anon/auth revoke). additive·무중단(소비자는 코드 기본값과 공존).

**⚠️ Migration 0026 적용 필요** (`supabase/migrations/0026_scores_end_reason.sql`): `scores.end_reason`(강제종료 사유 분석용). additive·무중단(컬럼 없으면 /api/score fallback insert).

**⚠️ Migration 0029 적용 완료** (`supabase/migrations/0029_legal_documents.sql`): 법무 문서 — `legal_documents`+`legal_documents_audit`+당시 `legal_sections_valid`/`admin_save_legal_draft`/`admin_publish_legal` RPC(security definer·내부 admin 검증·advisory lock). 현재 route는 Zod 검증 뒤 save/publish/unpublish write RPC만 호출하며, superseded `legal_sections_valid`는 0095부터 owner-only다. 외부 역할은 테이블에 직접 접근하지 않고 current write RPC만 service_role 경계로 사용한다. Management API 적용 완료. additive(신규, 기존 무영향).

**⚠️ Migration 0005 적용 필요** (`supabase/migrations/0005_generation_recovery.sql`):
ai_generations 에 candidate_urls/picked_doll_id 컬럼 + status 에 'picked' 추가. 적용 전엔 복구 기능 비활성(앱은 정상).

**⚠️ Migration 0004 적용 필요** (`supabase/migrations/0004_quota_balance_rank.sql`):
profiles public read (랭킹 닉네임) + daily_gen_limit + scores duration 1시간.
**⚠️ FAL_ADMIN_KEY 발급 필요**: fal dashboard → ADMIN scope 키 → `.env.local` 과 Vercel 환경변수에 추가 (없어도 동작하나 잔액 hard cap 비활성).

다음:
- **OAuth 로그인**: Supabase 내장 OAuth (Google/Kakao) + `linkIdentity()` 로 익명 계정 승격 (캐릭터/점수/닉네임 유지). 키는 Google Cloud Console / Kakao Developers 에서 발급 → Supabase Dashboard 등록
- ~~결제 (생성권)~~ ✅ v0.19 페이앱 → **v0.73 포트원 V2 전환**(카드=KPN·토스페이·카카오페이). ~~유저 구매내역/영수증 UI~~ ✅ **v0.76**(`/account/payments` + 크레딧 로트·수량 환불 saga). 향후: PG 계약·카드사 심사 완료 후 실연동 전환
- 도메인 연결 (bosspaegi.com 등)
- 서비스 워커 (오프라인 캐싱) — Lighthouse "installable" full pass
- 보고서 OG 이미지를 결재 보고서 디자인으로 (현재는 기존 포맷)

## 비용 (MVP 단계)

- Vercel Hobby / Supabase Free Tier 무료.
- fal.ai 생성당 비용은 생성권 크레딧(현재 가입 1개 + 포트원 유료 충전)으로 통제하고, fal 잔액이 $2 미만이면 생성 일시중지를 시도한다.
- **하이라이트 클립 스토리지/egress** (Supabase Free 1GB/5GB egress): **공유 시점만 업로드**(매 게임 X) + 클립 크기 캡(~4s·≤~2MB) + 재생은 Supabase CDN 직접(Vercel egress 0)으로 통제. 바이럴 급증 시 TTL cron(컬럼 설계 완료)·Cloudflare R2(egress 무료) 오프로드·Supabase Pro 가 스케일 경로.
