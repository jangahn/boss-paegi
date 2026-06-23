# boss-paegi (부장님 패기)

라이브: https://boss-paegi.vercel.app

직장인 스트레스 해소용 캐주얼 웹 게임. 사진을 업로드하면 AI가 강하게 캐릭터화한 부장님 인형을 만들어주고, 화면에서 마음껏 패고 점수·랭킹으로 풀어준다.

기획서 핵심: **이미지 업로드 기반 AI 인형 커스터마이징**. 기존 Kick the Buddy / Beat the Boss 류와 차별화되는 진짜 "내 상황에 맞는" 감정 해소.

## 빠른 실행

```bash
npm install
cp .env.example .env.local   # 값 채우기
npm run dev                  # http://localhost:3000
```

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

## 디렉토리 구조

```
boss-paegi/
├── app/                    # Next.js App Router
│   ├── api/                #   서버 Route (fal.ai 프록시, score, doll, avatar, payapp 결제)
│   ├── auth/callback/      #   OAuth 콜백 (linkIdentity/로그인 → 세션 + 멤버 초기화)
│   ├── login/              #   Kakao/Google 로그인 (가입 = 첫 로그인)
│   ├── generate/           #   인형 생성 플로우 (회원 전용)
│   ├── play/               #   게임 화면 (PixiJS 마운트)
│   ├── gallery/            #   내 인형 갤러리 (회원 전용)
│   ├── credits/            #   생성권 충전 (회원 전용, 페이앱 결제) + done(결제 후 폴링)
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
│   ├── payapp.ts           #   페이앱 결제 연동 (server-only: payrequest/feedback 검증)
│   ├── credit-products.ts  #   충전 상품 allowlist (단일 소스, 클라/서버 공용)
│   ├── policy.ts           #   동의 문구 / 면책 상수
│   ├── log.ts              #   구조화 JSON 로깅 (console + Sentry 브릿지 / 토큰 스크럽)
│   ├── sentry-bridge.ts    #   로그 이벤트 → Sentry (error/warn=issue, info=breadcrumb)
│   ├── share.ts            #   Web Share / OG helper
│   └── score-detail.ts     #   한 게임 상세 fetch (share·history 공용, server-only)
├── components/             # React UI
├── store/                  # Zustand stores
├── supabase/migrations/    # SQL 마이그레이션
└── public/
    ├── manifest.webmanifest
    ├── icons/              # PWA 아이콘
    ├── avatars/            # 기본 프로필 사진 (default.png — 교체 가능)
    ├── sprites/            # 기본 인형 + 무기 sprite
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
| `NEXT_PUBLIC_SITE_URL` | 공유 링크 / OG 이미지 / **페이앱 결제 콜백(feedback·return)**용. ⚠️ Vercel prod 에 실제 도메인 필수 (미설정 시 콜백이 localhost → 결제 깨짐) |
| `PAYAPP_USERID` / `PAYAPP_LINKVAL` | 페이앱(무사업자) 결제 — 판매자 아이디 / 연동VALUE(웹훅 위변조 차단). 미설정 시 결제 비활성(503). **서버 전용** |
| `PAYAPP_LINKKEY` | 페이앱 연동KEY (취소 API용, 선택). **서버 전용** |
| `CRON_SECRET` | 대사 cron(`/api/ops/reconcile`) 보호 시크릿. cron-job.org 가 `x-cron-secret` 헤더로 전달. 미설정 시 reconcile 비활성(503). **서버 전용** |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN. 미설정 시 Sentry 전부 no-op (앱 정상) |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | 빌드 시 소스맵 업로드용 (선택) |

> Kakao/Google OAuth provider 키(client id/secret)는 앱 env 가 아니라 **Supabase Auth config**(Management API `PATCH /config/auth`)에 저장 — 아래 *회원 / 인증* 참조.

## 회원 / 인증 (OAuth)

익명 세션(`signInAnonymously`) + **Kakao/Google OAuth 회원**. 비회원도 플레이·랭킹은 자유, **생성·갤러리는 회원 전용**(`proxy.ts` 가 `/generate`·`/gallery` 를 익명 시 `/login` 으로 리다이렉트).

- **로그인 = 가입**: 별도 가입 페이지 없음 — `/login` 버튼뿐. DB 에 계정 없으면 그 로그인이 곧 가입.
- **마이그레이션(linkIdentity)**: 익명 상태에서 첫 OAuth 로그인 시 같은 `user.id` 로 멤버 승격 → 익명 때 만든 dolls/scores 보존. 로그아웃하면 새 익명 세션으로 분리. 이미 가입된 OAuth 로 재로그인(`identity_already_exists`)은 `/login?relogin=1` → `signInWithOAuth`(현재 익명 데이터는 자동 병합 안 함).
- **계정 분리**: Supabase 자동 linking 수용 — 동일 **verified 이메일**의 Kakao/Google 은 같은 계정으로 연결될 수 있음. 다른 이메일이면 별개 계정. 멀티연동 UI 없음.
- **이메일 필수**: 이메일 없는/미검증 OAuth 는 멤버화 차단(`/login?error=email_required`). Kakao 는 Biz 인증 + `account_email` 필수 동의 필요.
- **테이블 분리**: 공개 프로필은 `profiles`(display_name/avatar_url, public read), 멤버십·생성권은 private `member_accounts`(self-read만, write 는 service-role/`SECURITY DEFINER` RPC). `profiles.avatar_url` 은 컬럼레벨 grant 로 클라 직접 변조 차단 → 변경은 검증된 `/api/avatar`(admin) 경유.
- **생성권(크레딧)**: 가입 시 5개 지급(`member_accounts.gen_credits`), 생성마다 1개 차감(서버 `consume_gen_credit`, fal 제출 직전 원자적·실패 시 `refund_gen_credit`). 소진 시 `/credits` 에서 **유료 충전**(페이앱 결제, 아래 *결제* 참조) 또는 의견 위젯 요청. `OPS_USER_ID` 는 무제한.
- **Provider 설정**(Management API `PATCH /config/auth`): Kakao/Google enabled+client_id+secret, `manual linking` 활성(linkIdentity 필수), `site_url`, `uri_allow_list`(prod+localhost `/auth/callback`). provider 측 redirect URI = `https://<ref>.supabase.co/auth/v1/callback`(앱의 `/auth/callback` 아님).

## 결제 (생성권 충전 — 페이앱)

사업자등록 없이 **본인 비사업자(개인판매자)로 페이앱** 연동(카드·네이버페이, 카카오페이 불가). 정식 PG·토스는 사업자등록 필요라 무사업자 단계는 페이앱으로 시작, 규모 확대 시 전환.

- **상품**: `lib/credit-products.ts` allowlist 4종(생성권 5/10/20/50 = 1,000/1,800/3,200/7,000원, 개당 200→140원). 클라는 `productId` 만 전송, price/credits/goodname 은 **서버 allowlist 로만 결정**(조작 차단). 모두 1,000원 이상(페이앱 최소금액).
- **흐름**: `/credits`(회원 전용)→`POST /api/payapp/checkout`(pending 주문 선삽입→payrequest→mul_no/payurl)→`payurl` 같은 탭 이동→결제→**웹훅 `POST /api/payapp/feedback`**(public)→`/api/payapp/return`(303)→`/credits/done?order=` 폴링(`/api/payapp/order-status`).
- **데이터**(migration 0019 `payapp_orders`, service-role 전용): `order_uuid`(PK=var2)·`mul_no`(nullable unique)·status(pending/paid/canceled/failed)·amount/credits snapshot. 같은 user+product 최근 10분 pending 재사용으로 중복 주문 방지.
- **멱등·보안**: 웹훅은 `linkval`(연동VALUE 비밀)·price·`var1==order.user_id`·mul_no 정합 검증(외부 입력 불신, DB=source of truth). 지급은 RPC `mark_paid_and_grant`(security definer, FOR UPDATE)로 원자·멱등 — 첫 통보만 paid + `gen_credits += credits`(대상=order.user_id). 검증된 이벤트는 모두 텍스트 `"SUCCESS"`(JSON 금지), 실패 시 페이앱 최대 10회 재시도. recvphone 더미+`smsuse=n`(카드/네이버페이라 수신폰 불요).
- **환불(v1 수동)**: 페이앱 관리자 취소→웹훅 `status='canceled'`(paid_at 유지, **크레딧 자동 회수 없음** — 운영자 수동). `failed` 주문은 운영자가 필요 시 정리, paid/canceled 보존.
- **설정**(사용자 작업): 페이앱 판매자관리 > 설정 > 연동정보에서 `PAYAPP_USERID`·`PAYAPP_LINKVAL`(+선택 `PAYAPP_LINKKEY`) 확보 → `.env.local`+Vercel, 결제수단 카드·네이버페이 ON, `NEXT_PUBLIC_SITE_URL` prod 도메인 설정. **테스트는 prod 실결제→환불**(샌드박스 없음, 웹훅 공개 HTTPS 필요).

### 운영 한계·모니터링 (v1 — 전수 엣지케이스 감사 반영)
실결제 안전을 위해 106개 엣지케이스 감사 → 코드로 막은 것(위변조·IDOR·이중지급·비밀값 저장·SITE_URL 오설정 fail-fast·멱등 지급) 외에 **운영으로 관리하는 한계**:
- **웹훅 영구 미도달**(페이앱 10회 재시도 소진/서버 장애): 결제됐는데 order 가 `pending` 잔존 가능 → **stale pending 대사 필요**. Sentry 경고 모니터: `payapp.fb_grant_fail`·`payapp.fb_order_not_found`·`payapp.fb_paid_not_granted`(실결제라 임계 1). 주기 점검 쿼리 `status='pending' AND created_at < now()-interval '4h'` → 페이앱 결제내역과 대사 후 수동 `mark_paid_and_grant`.
- **환불**: 수동(페이앱 관리자→웹훅이 `status='canceled'` 기록). **크레딧 자동 회수 없음** — `gen_credits>=0` 가드상 음수 불가, 운영자가 잔액 확인 후 조정. 정산마감(D+5) 후 취소는 정산금 반환 필요.
- **동시/다중 결제**: 같은 상품 동시 checkout 은 10분 내 pending 재사용 + 버튼 disable 로 우발 중복 방지. 사용자가 여러 결제창을 모두 결제하면 각각 별도 수금·지급(손실 아님). 미완료 pending 은 누적 가능(대사로 정리).
- **계정 삭제**: `payapp_orders`·`member_accounts` 가 `profiles` `ON DELETE CASCADE` — 결제 이력 보존이 필요하면 soft-delete/RESTRICT 전환(현재 계정삭제 기능 없음).
- **확장 시(v2)**: 자동 환불 회수 RPC, stale-pending 대사 cron, preview 환경 DB 격리, bigint 전환, 사업자 전환+토스(수수료/세금계산서).

## 관리자 / 운영 (admin)

관리자 전용 운영 대시보드 + 결제 대사. 권한은 `member_accounts.is_admin`(service_role 만 쓰기 → 자가부여 불가, 0020). `proxy.ts` 가 `/admin` 로그인 게이트, 페이지·`/api/admin/*` 는 **`requireAdmin()`** 으로 최종 판정 — is_admin 을 **별도·관용 조회**(0020 미적용/비admin 이면 안전 차단, 기존 회원 흐름 무영향).

- **`/admin`**(RSC, `force-dynamic`): 매출·주문(오늘=KST 자정 / 7d·30d rolling, 상태별) · 가입·구매 퍼널(방문→플레이→가입→첫생성→첫구매) · 최근 주문 · **오래된 결제요청(확인 필요)**. 정확 수치는 DB(`lib/admin-data` + `get_admin_funnel`/`get_admin_order_summary` RPC), Sentry 아님.
- **운영 액션**(돈·감사): stuck 주문 **결제완료 확인 후 지급** · 환불/취소 표시(회수 0까지만) · CS 크레딧 조정(기존 회원만·−100~100·≠0·사유 5~500). 모두 service_role RPC(`admin_settle_stuck_order`/`admin_cancel_order`/`admin_adjust_credits`)가 **row lock→변경→`admin_actions_ledger` 기록**을 한 트랜잭션(멱등·취소 1회·clamp-0).
- **오래된 결제요청 대사**: `cron-job.org` → `POST /api/ops/reconcile`(`x-cron-secret`) → mul_no 있는 pending 2h+ 탐지 → Sentry 경고(**"확인 필요"** — 미지급 단정 아님, dedup 6~24h). **자동 지급 없음**(수동).

## 모니터링 (Sentry)

에러/경고 알림 + **구조화 로그(Logs)** + **트레이싱(성능)** + **세션 리플레이** + **인앱 의견 위젯**. 초반 서비스 품질 향상 위해 유저 행동/피드백을 직접 관찰 — 게임 데이터(캐릭터/플레이/랭킹/닉네임/userKey)는 비민감 취급, **업로드 원본 얼굴만 마스킹**(정책 #1/PIPA).

- **로그 브릿지**(`lib/sentry-bridge.ts`, `emit()` 한 곳): `log.error/warn` → `captureMessage`(event 명 fingerprint 그룹핑 → 이벤트당 1 이슈) **+ `Sentry.logger`(Explore→Logs 검색)**, `log.info` → `Sentry.logger.info`+breadcrumb. 초고빈도 `gen.recover_list` 는 Logs 제외(볼륨). `enableLogs: true`.
- **게임 액션 로그**(`app/play/page.tsx`): `game.start`(dollId/weapon/bg)·`game.end`(score/maxCombo/hitCount/weaponCounts/mainWeapon/durationMs)·`game.weapon_switch`·`game.bg_switch`·`game.ultimate_fire` → Logs/Discover 에서 무기·점수대·플레이타임 분석. 고빈도 `hit` 은 per-hit 로그 안 함(`game.end` 요약으로 충분).
- **전역 신원/컨텍스트**(`lib/sentry-context.ts`): `setSentryIdentity(userKey, 닉네임, email?)` → `Sentry.setUser`(모든 event/replay/log·**의견 위젯**에 자동 부착, `SessionBootstrap`; email 은 멤버만 — `session.user.email`, 익명 제외, 로그아웃 시 `clearSentryIdentity`로 clear); `setSentryGameContext({dollId,weapon,bg,gamePhase})` → `setTag`(weapon/bg/doll_type/game_phase)+`setContext("game_session")` → 태그로 끊어 보기. 55개 로그 site 안 건드리고 정보 극대화.
- **트레이싱**(production 한정 — dev/preview 는 0 으로 게이트해 대시보드 오염·span 한도 소모 방지): server `tracesSampler` 라우트별 차등(`/api/fal`·`/api/doll`=1.0, `/api/score`=0.5, **`/api/generations`=0.05**(폴링), 기본 0.1), client 0.1(Web Vitals 자동). 생성 파이프라인 커스텀 스팬(`gen.prepare_input`/`face_upload`/`detect_glasses`/`fal_submit`, `gen.fal_status`/`fal_result`/`copy_candidates`, `doll.bg_removal`/`normalize`) + 점수 제출 스팬(`score.submit`, score/maxCombo/weapon/durationMs/dollId attr). fal/Supabase 는 fetch 자동계측 `http.client` 스팬(`tracePropagationTargets` 는 자기 도메인만). release health(crash-free)는 release(SHA)+autoSessionTracking 자동.
- **세션 리플레이**(`instrumentation-client.ts`, **production 한정** — dev/preview 는 0 으로 게이트해 공용 50/월 한도 미소모): 에러 세션 100%(`replaysOnErrorSampleRate`) + 일반 20%(`replaysSessionSampleRate`). DOM-only(PixiJS 캔버스 녹화 미사용 = 모바일 perf). 게임 UI/텍스트는 비민감이라 언마스크, **`.sentry-block-face`(`/generate` 업로드 미리보기·`PhotoCropper` 크롭 컨테이너)만 `block`+`mask`** → 원본 얼굴 replay 미포함(크롭 컨테이너 차단이 내부 `<img>`까지 마스킹 — react-easy-crop 은 portal 미사용).
- **인앱 의견 위젯**(`feedbackAsyncIntegration`, `#sentry-feedback`): 버그·건의 자유 제보. **async = 모달/스크린샷 코드는 클릭 시 CDN 지연로드**(초기 번들 경량 — 모바일 PWA). 스크린샷 OFF(얼굴/캔버스 캡처 방지). 이름/이메일 입력칸은 숨기되(`showName/showEmail:false`) **로그인 유저의 닉네임·이메일을 `useSentryUser` 로 숨김 컨텍스트 첨부** → 누가 보낸 피드백인지 식별(익명은 닉네임만, email 없음). 폼에 개인정보 안내 문구 고지. `/play` 몰입화면(`.game-surface`)에선 무기바와 겹쳐 `globals.css` `:has()` 로 숨김, 그 외(홈/갤러리/랭킹) 노출.
- **자동 포착**: 서버/RSC/Route 미처리 에러(`instrumentation.ts` `onRequestError`), 클라 미처리 에러(`instrumentation-client.ts`), 루트 렌더 에러(`app/global-error.tsx`).
- **PII**: `sendDefaultPii: false`(IP·헤더·쿠키 미수집) + `beforeSend` 로 URL 쿼리스트링(서명 토큰) 제거. ctx 는 이미 `scrubSecrets`/`urlHost` 적용. 식별자는 익명 UUID(`userId`)+게임 닉네임(실명 아님), **멤버는 피드백 식별·연락용 email 추가**(`setUser`; 로그아웃 시 `setUser(null)` clear, 클라 프로필/캐시엔 미노출). **업로드 원본 얼굴은 Replay 에서 마스킹**(`.sentry-block-face`) — AI 생성 후보·플레이 화면은 비민감이라 미마스킹.
- **설정**: Sentry 프로젝트 생성 → `NEXT_PUBLIC_SENTRY_DSN`(+선택 `SENTRY_*`)을 `.env.local`/Vercel 에 추가. DSN 없으면 init 안 함 → no-op. 광고차단 우회용 터널 `/monitoring`(proxy matcher 에서 제외).
- **구성된 모니터링**(Sentry org `ja-inc`, production 한정 — API 로 설정, UI 에서 조정 가능):
  - 이슈 알림: `새 에러/경고 발생·재발`, `에러 급증 1h 20+`, **`생성 실패 급증`**(`event:gen.submit_fail`/`gen.fal_timeout` 1h 5+).
  - 메트릭 알림(span dataset `events_analytics_platform`, Sentry 가 transaction→span 마이그레이션 중): **`생성 제출 지연 p95`**(`/api/fal` warn 8s·crit 12s), **`점수 제출 실패율`**(`/api/score` crit 20%).
  - **Uptime**: `boss-paegi.vercel.app` 5분 간격(무료 1개 한도) → 다운 시 이메일.
  - **Dashboard `boss-paegi 운영 개요`**: 에러 추이·event 태그별 Top·생성 p95·Web Vitals(p75)·점수 제출·무기 분포.
  - 추가 권장(미설정): `falbal.hard_cap_hit`·`auth.anon_sign_in_fail`·`gen.done_update_fail` 즉시 알림은 필요 시 UI 에서.

## npm scripts

```bash
npm run dev         # 개발 서버 (Turbopack)
npm run build       # 프로덕션 빌드
npm run start       # 프로덕션 서버
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
```

## 정책 / 보안 (반드시 준수)

- **업로드 이미지**: 생성 직후 원본 즉시 폐기. 결과물(캐릭터화된 이미지)만 Supabase Storage 저장.
- **동의 다이얼로그**: 생성 직전 3개 체크박스 강제 (본인 또는 사용권 있는 이미지 / 타인 비방 목적 아님 / 캐릭터화 변형 동의).
- **AI 프롬프트**: 강한 캐릭터화 (3D claymation, caricature, exaggerated chibi) — 실제 얼굴과 닮음 최소화.
- **API 키**: `FAL_KEY`, `SUPABASE_SERVICE_ROLE_KEY` 는 **서버 전용**. 클라이언트 번들 절대 포함 금지.
- **생성권(크레딧)**: AI 생성은 **회원 전용** — 가입 시 생성권 5개, 생성마다 1개 차감(서버 `consume_gen_credit` 원자적, 실패 시 환불). 소진 시 의견 위젯으로 추가 요청. `OPS_USER_ID` 무제한.

전체 정책 결정은 [CLAUDE.md](./CLAUDE.md) 참조.

## 진행 상황

- [x] M1 셋업
- [x] M2 코어 게임 (PixiJS 탭 메커니즘, 점수+콤보, 결과 모달)
- [x] M3 AI 인형 생성 플로우 (업로드 → 동의 → fal.ai → 저장)
- [x] M4 인증 / 갤러리 (Supabase Anonymous + /gallery)
- [x] M5 공유 / 랭킹 (점수 등록 API + 일·주간 랭킹 + Web Share + 동적 OG 이미지)
- [x] M6 PWA + 마무리 (manifest + dynamic icon/apple-icon)

v0.3 (2026-06-05 라이브, 실기기 1차 QA 반영):
- 무기 4종 + 효과음 (주먹/싸대기/키보드/종이, Web Audio 합성)
- 배경 4종 (사무실/탕비실/회의실/회식자리)
- 부장님 시비 멘트 (5.5s 간격 랜덤)
- AI 인형: strength 0.65 + birefnet 누끼 + 사이즈 200
- 점수 0 종료 시 홈으로 (모달 X)

v0.4 (2026-06-09, 물리엔진 도입):
- matter.js 물리: 인형은 spring constraint 로 anchor 에 묶여 밀려났다 자동 복귀, 화면 4벽 (두께 400px, 관통 방지) 튕김
- **인형 자체 드래그 던지기**: tap/throw 모드에서 인형 잡고 끌면 (≥14px) fling → 놓는 속도대로 발사 (cap 28px/step) → 0.9초 자유 비행 후 anchor 복귀. drag 중 벽 박기 +15점 (4벽 margin 60px edge-trigger)
- 효과음: punch/thud/slap/clack/rustle/whoosh/scribble — Web Audio 합성, 타격 속도 비례 볼륨

v0.5 (2026-06-10, 무기 메커니즘 개편):
- 무기 9종 6그룹 — 탭(👊🔨) · 문지르기(✋) · 던지기(📚⌨️📄) · 사격(🔫) · 잡아던지기(🤏) · 낙서(🖊️)
- **뿅망치(🔨)**: 탭 타격 + 휘두르는 스윙 이펙트 + 만화 스프링 "뿅" 사운드
- **비비탄총(🔫)**: 빈 곳을 꾹 누르면 🔫이 인형을 자동 조준, 0.18s 간격 연사. pellet 이 날아가 명중 시 pop + 파티클
- 탭 무기는 타격 지점에 무기 이모지가 뿅 나타나는 emojiPop 이펙트 (주먹 = 펀치, 뿅망치 = 스윙)
- 모든 무기에 조작 hint (weapons.ts 의 `hint` 필드로 일원화) — 주먹/잡아던지기 포함
- **잡아던지기(🤏)**: 인형 fling 은 이 무기 선택 시에만. 주먹/던지기 모드에선 인형을 끌 수 없음 (오발사 방지)
- **주먹**: 둔탁한 한 방 — sine drop + 저역 노이즈 + 어택 클릭 합성 "퍽퍽" 사운드 (타마다 ±8% 디튠)
- **싸대기**: 드래그하면 손바닥(✋)이 손가락을 따라다니고, 인형 위를 빠르게 (≥500px/s) 왔다갔다 문지르면 속도 비례 데미지 (0.6~2×) + 찰싹. 쿨다운 150ms — 1왕복당 1대
- **던지기 (책/키보드/종이)**: 무기를 잡고 캐릭터 쪽으로 휘둘러 놓으면 드래그 방향·속도 그대로 발사 (flick, 슬링샷 폐기). 충돌 속도 비례 데미지. 책/키보드 = 둔탁 (thud + momentum 넉백), 종이 = 흩뿌려짐 (paperScatter 팔랑팔랑)
- **펜**: PNG 알파맵 기반 캐릭터 실루엣 판정 — 실루엣 밖 낙서 불가 (보간 dot 까지 재검증). 낙서는 doll.bodyWrap 의 child — 인형이 흔들리거나 던져지면 낙서도 같은 레이어로 함께 이동
- **배경 전환 시 게임 상태 유지**: BgSwitcher 가 navigation 대신 텍스처 핫스왑 (`setBackground`) — 점수/콤보/무기/낙서 전부 유지, URL 은 replaceState 동기화
- 안정성: PIXI v8 globalpointermove 로 fling 추적 (인형 밖 드래그 추적 유지), touch-action none 유지 (모바일 제스처 하이재킹 방지), DOM pointercancel 안전망, 물리 body 반경 표시 scale 동기화, collisionStart 넉백 setVelocity 임펄스화, fling 중 중력 누적 방지, 게임 생성 중 무기/배경 변경 유실 방지
- 모바일 fling: drag 중 doll↔벽 충돌 off + 벽 overhang (body 반경 70%) — 좁은 화면에서 인형 body 가 좌우 벽에 끼어 상하로만 움직이던 버그 수정
- 연타: tap 무기 (주먹/뿅망치) 는 pointerdown 즉시 타격 + 포인터 잠금 없음 — 두 손가락 파바박 연타 전부 접수 (기존엔 단일 포인터 lock + up 판정으로 절반 씹힘)
- 네이티브 제스처 차단 (`.game-surface`): 게임 화면에서 텍스트 선택 / iOS 길게누름 돋보기 / 콜아웃 시트 / 이미지 드래그 / 컨텍스트 메뉴 차단
- 로딩 UI: /play 진입 시 "부장님 불러오는 중..." 오버레이, 갤러리 카드 이미지 페이드인 + 삭제 중 카드 dim + 스피너
- 낙서 지우개: 인형에 낙서가 있으면 picker 의 펜 슬롯이 🧽 로 변함 — 터치하면 낙서 전체 삭제 (점수 무관, 무기 모드 유지), 지워지면 🖊️ 복귀
- placeholder 인형 크기 0.8× 보정 — 머리 지름이 곧 전체 폭이라 AI 인형 (프레임 내 ~60-80%) 보다 커 보이던 것 균형
- 게임 생성 race 수정: StrictMode 더블 마운트에서 취소된 생성 호출이 살아있는 게임의 canvas 를 DOM 에서 제거해 입력 전체가 죽던 버그 — createGame 에 isCancelled 체크 추가 (DOM 건드리기 전 자가 정리). renderer 크기도 ResizeObserver 에서 직접 동기화 (resizeTo 는 window resize 만 반응해 모바일 주소창 수축/회전 시 입력 좌표계가 어긋남)
- 점수 한도 ([lib/score-limits.ts](lib/score-limits.ts), 서버/클라 공유): 콤보 배율 cap 4×, 평균 2000점/sec, 제출 전 클라이언트 클램프 — 정상 플레이에서 score_out_of_range 저장 실패 안 남 (서버 검증은 변조 방어용 유지)

v0.6 (2026-06-12, 네비게이션·닉네임·보고서):
- **전역 네비게이션** (`AppNav`): 홈/갤러리/랭킹 탭 + 닉네임 표시·수정 버튼. 홈/갤러리/랭킹/생성 페이지 장착 (/play 는 몰입 화면 — 종료 보고서에서 이동 제공)
- **닉네임**: 기본값 직장인 컨셉 랜덤 ("분노한 사원 3847" 등, migration 0003) + 어디서든 수정 (profiles self-update RLS) → 랭킹/공유 즉시 반영
- **게임 결과 = 결재 보고서 패러디**: 문서번호·작성자·"해소완료" 도장·항목별 정산 (점수/최대콤보/총타격/주력무기/소요시간/판정등급) + 부장님 피드백 멘트. 등급은 점수 구간별 직급 패러디 (무급 인턴 ~ 전설의 퇴사자)
- **공유 랜딩 리뉴얼** (/share/[scoreId]): 동일 보고서 포맷 + 커스텀 인형 사진 + "당신의 부장님은 무사하십니까?" 후킹 + CTA 3종. OG 제목도 "[결재완료] 닉네임 — N점 (등급)"
- scores.max_combo 컬럼 (migration 0003) — 미적용 환경에서도 동작하는 fallback 포함
- 연타 씹힘 근본 수정: 타격 이펙트 (이모지/점수팝/파티클) 와 hint 텍스트가 PIXI hit-test 를 가로채 같은 자리 빠른 연타가 인형에 닿지 못하던 것 — 이펙트/오버레이 레이어 전부 `eventMode: "none"` (검증: 같은 좌표 40ms 간격 10연타 전부 등록)

**⚠️ Migration 0003 적용 필요** (`supabase/migrations/0003_nickname_and_combo.sql` → Dashboard SQL Editor):
직장인 닉네임 생성기 + 기존 "익명*" 일괄 변환 + scores.max_combo. 적용 전에도 앱은 동작 (fallback).

v0.7 (2026-06-12, 운영 안전장치·바이럴):
- **플레이타임 10분 → 1시간** (클라 클램프 + 서버 검증 + DB check, migration 0004). 점수 상한 (시간×2000/sec) 방어선은 유지
- **AI 생성 1일 2회** (KST 자정 리셋, 실패한 생성은 차감 안 함). `profiles.daily_gen_limit` 로 계정별 관리 — null 로 두면 무제한 (운영 계정용)
- **fal 잔액 hard cap**: 생성 요청마다 fal billing API (`/v1/account/billing?expand=credits`) 로 잔액 조회 (60초 캐시) — $2 미만이면 전 계정 생성 중단 + "요청이 많아 일시 중단" UI 안내. `FAL_ADMIN_KEY` (ADMIN scope) 필요, 미설정 시 체크 skip
- **OG 이미지를 결재 보고서 디자인으로**: 문서번호·작성자·점수·판정 등급·부장님 멘트·해소완료 도장·인형 사진 — 카톡/트위터 공유 시 보고서가 그대로 보임
- **랭킹 익명 버그 수정**: get_leaderboard 가 security invoker 라 RLS 로 타인 닉네임이 null → profiles public read 정책 추가 (migration 0004)
- 무기 조작 안내를 인형 발치 (PIXI) → **무기 picker 바로 위 (DOM)** 로 이동, PIXI hint 코드 5곳 제거
- **꼬질꼬질 데미지 데칼** (`DamageLayer`): **2,000점마다** 약한 꼬질 (때 + 작은 멍/스크래치) — 상한 없이 누적 (성능 안전망: 데칼 400개 초과 시 오래된 것부터 정리). 궁극기로 점수가 빠르게 쌓이는 점 반영해 천천히 더러워지게(만점 단위 큰 멍 로직 제거). 위치는 랜덤이 아니라 **피격 부위 기준** — 모든 타격의 좌표를 기록해 최근 맞은 곳 부근에 쌓임 (실루엣 밖이면 재시도 → 랜덤 fallback). 낙서처럼 인형과 함께 움직이고 라운드 리셋 시 초기화. zustand subscribe 로 리렌더 없이 점수 전달. 자연스러움: 멍 = 불규칙 폴리곤 + radial gradient, 때 = 가우시안 스프레이, 스크래치 = 휜 곡선. **실루엣 클리핑**: 데칼+낙서 레이어를 인형 텍스처 자체의 Sprite alpha mask (placeholder 는 도형 mask) 로 감싸 — 면적 있는 데칼도 캐릭터 픽셀 밖으로 한 픽셀도 안 나감
- **OG 인형 이미지 수정**: Satori 가 외부 URL `<img>` 를 자체 fetch 하다 조용히 실패 + attribute width 만으론 크기 미인식 — data URI embed + style 명시로 해결. 커스텀 없으면 기본 부장님 (OG/공유 페이지/결과 보고서 모달 공통)
- **기본 부장님 교체**: 3D 클레이 스타일 이미지 (`public/sprites/boss-default.png`, 768×1024 누끼 PNG 130KB) — Graphics placeholder 는 텍스처 로드 실패 시 fallback 으로만. 전처리 스크립트 `scripts/prepare-default-boss.mjs` (fal storage 업로드 → birefnet 누끼 → trim → AI 캐릭터 규격 정규화). 코드베이스 정적 자산으로 둔 이유: 전 유저 공통·불변 자산은 Vercel CDN 캐시가 최적, Supabase 대역폭/장애 의존 0

- **갤러리 인형 공유** (바이럴): 카드 우상단 ⋯ 옵션 메뉴 → 공유 / 삭제. 공유 = 워터마크 이미지(우하단 작게) + `/doll/[id]` 링크를 Web Share 로 (fallback: url share → 링크 복사). Web Share 공유 시트에 "이미지 저장" 이 이미 포함돼 별도 저장 옵션은 제거
- **`/doll/[id]` 공개 랜딩 — 인사기록카드 패러디**: 증명사진란 + 성명/직급/소속/제작자/특이사항 + "관리대상" 도장 + "나도 우리 부장님 만들기" CTA. 전용 OG 카드 동일 컨셉 (admin client 조회 — RLS 무관, UUID 라 추측 불가)

v0.8 (2026-06-13, 궁극기·베리에이션·UX):
- **궁극기** (`UltimateButton`/`DamageLayer` 연계): 명중 100회 누적 시 게이지(`ScoreBoard` 상단 바) 풀 충전 → "궁극기 발동" 버튼 등장 → 탭 시 3.9초 **난사타** (랜덤 무기 타격 다발 + **인형 마구 던져짐** (0.4s마다 랜덤 임펄스, 스프링 약화로 화면 휘젓다 종료 시 anchor 복귀) + 화면 흔들림 + 점수 폭등 + 마무리 화면 플래시). 난타 타격은 게이지 재충전 안 함, 발동 중 입력 차단·재발동 가드, 종료/그만패기 시 `stopUltimate` 로 정리. `gameStore` 의 `ultProgress/ultReady/consumeUlt`
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
  - `/api/generations` GET: 미완결 목록 + lazy 복구/정리 (queued 는 fal request_id 로 결과 폴링, 30분 초과+복구 실패=중단, done 미선택 24h 초과=후보 삭제). 생성 중이면 갤러리가 4초 폴링
  - pick 시 `/api/doll` 가 generationId 로 picked 마킹 + 안 고른 후보 storage 정리
  - migration 0005 미적용 환경에서도 안전 (생성 done fallback, 복구 기능만 비활성)

v0.10 (2026-06-15, 생성 품질·데이터 감사·랭킹):
- **생성 비동기 전환** (제출-후-폴링): `/api/fal` 가 fal 에 3건 제출만 하고 즉시 반환(~6s) → 클라가 `/api/generations` 폴링으로 완성분 수집. 생성이 60~120s+ 걸려도 maxDuration/abort 에 안 걸림(기존 동기 대기 → 후보 누락/실패 사고의 구조적 해결). 임시 얼굴은 genId 결정적 경로(`{owner}/tmp/{genId}.jpg`)로 두고 복구가 done 마킹 시 폐기(정책 #1). `/api/generations` 행별 복구 병렬화 + OG 라우트 ISR 캐시(`revalidate=3600`)
- **입력 얼굴 화질 게이트** (crop 시 해상도≥300px·Laplacian 선명도 검사 → 미달 차단), **안경 조건부 반영** (Moondream VQA 로 입력 안경 검출 → 있을 때만 프롬프트 주입), 의류 색 베리에이션(팔레트), 닮음도 파라미터(true_cfg 2/guidance 4), 후보 복사 재시도+폴백, 느린 생성 자가복구(request_id 기반 reclaim)
- **감사 컬럼** (migration 0007): 모든 테이블(profiles/dolls/scores/ai_generations)에 `updated_at`·`version` + UPDATE 트리거(`set_updated_at_and_version`)로 자동 갱신 — 데이터 확인/트러블슈팅용
- **랭킹 KST 자정 초기화** (migration 0008): `get_leaderboard` 윈도우를 롤링(now()−1d/7d)에서 **KST 자정 고정 경계**로 — 일간=매일 0시, 주간=월요일 0시 (Asia/Seoul). 일간/주간 모두 **최대 10명**
- 갤러리 "이어서/중단됨" 텍스트 라이트모드 대비 수정 (`dark:` variant)
- **배경(맵) 재구성**: 사무실/탕비실/회식자리 새 이미지로 교체 + **복사실·엘리베이터 맵 추가** → 총 **6종**(회의실 유지). BgSwitcher 좁은 폭 가로 스크롤

v0.11 (2026-06-20, 하이라이트 클립 공유 — 바이럴):
- **점수 급상승 하이라이트** (영상 되는 곳은 영상, 아니면 카드 + **항상 링크 공유**): 플레이 중 점수 timeline(100ms ring buffer, `store/gameStore` `scoreSamples`)을 기록하고, velocity/궁극기/콤보 spike 에서 **최대 3회·각 ~4초** 캔버스를 MediaRecorder 로 녹화해 Δscore 최대 **best clip 1개**만 메모리 보관(`app/play/useHighlightRecorder.ts`). `lib/highlight.ts`(순수: `pickHighlightWindow`/velocity/서버 메타 클램프).
  - **크로스플랫폼 현실**: 클라 녹화+`navigator.share(file)` 는 iOS Safari 불안정·인앱 webview(카톡) 미지원·데스크톱 일부 미지원 → **공유는 항상 `/share/[scoreId]` 링크**(URL primary `navigator.share({url})` → 실패/webview 면 clipboard, **gesture 안에서**), **업로드는 백그라운드**(fire-and-forget). 녹화 미지원/실패/빈 blob → 카드만으로 끊김 없이 공유(fallback 원칙).
  - **업로드** (`app/api/highlight`): 클립 바이트는 **Vercel 안 거침**(4.5MB 한도 회피) — POST 가 owner 검증 후 `createSignedUploadUrl(highlights/{scoreId}/{uploadId}.{ext})` 발급 → 클라가 Supabase 직접 업로드 → PATCH 가 **`storage.info()` 로 size/mime 서버 검증**(클라값 불신, 초과/불일치 시 object 삭제) + DB attach(score당 1회) + `revalidatePath`. **공유 클릭 시점만 업로드**(매 게임 X).
  - **`/share`**: 클립 있으면 `<video>`(src=Supabase CDN 직접, Vercel egress 0) + 🔥급상승 stat, 없으면 보고서 카드. OG 카드에도 `+N점` stat. migration 0009(`scores` highlight_* 컬럼 + public `highlights` 버킷, `highlight_expires_at`/`deleted_at` TTL·신고 설계 반영).
  - 관측: `highlight.record_supported/started/success`·`empty_blob`·`upload_success/rejected_size` (Sentry/Logs).

v0.12 (2026-06-20, OAuth 회원 + 생성권 크레딧):
- **Kakao/Google 로그인 회원제**: 익명 전용 → OAuth 회원 도입. 비회원도 플레이·랭킹 유지, **생성·갤러리는 회원 전용**(`proxy.ts` 게이팅 → `/login`). 별도 가입 페이지 없이 로그인 버튼이 곧 가입.
- **linkIdentity 마이그레이션**: 익명 상태 첫 OAuth 로그인 시 같은 `user.id` 로 멤버 승격 → 익명 때 만든 dolls/scores 보존. 로그아웃=새 익명 분리. 이미 가입된 OAuth 재로그인은 `identity_already_exists`→`/login?relogin=1`→`signInWithOAuth`(현재 익명 데이터 자동 병합 안 함).
- **공개/멤버십 분리** (migration 0010): 공개 프로필 `profiles`(+`avatar_url`, public read; 컬럼레벨 grant 로 클라는 `display_name` 만 수정) / private `member_accounts`(`gen_credits`·`member_since`·`email`, self-read만, write 는 service-role/`SECURITY DEFINER` RPC) — 익명 변조·노출 차단. `email`(0014)은 이벤트/연락용 — `auth.users.email` 복제본(콜백서 변경 시 최신화), **public 노출 금지라 여기 비공개 저장**, 추출은 admin/대시보드 전용(클라 프로필·캐시 미반영).
- **생성권 크레딧**(일일 한도 대체): 가입 시 5개, 생성마다 1개 차감(`consume_gen_credit`, fal 제출 직전 원자적·실패 시 `refund_gen_credit`). 소진 시 우측하단 의견 위젯으로 추가 요청 안내. `OPS_USER_ID` 무제한.
- **콜백/게이트**: `/auth/callback`(code 교환 + **이메일 필수 게이트**(verified-email linking 안전성) + 멤버 1회성 초기화 — `member_accounts` 신규 insert 시만 OAuth 닉/프사 반영, 재로그인 보존), `lib/auth-server.ts` `requireMember`(401/member_only/member_setup_required), `safeNext`(open redirect 차단).
- **계정 UI**: `AppNav`/`AccountMenu` 익명(닉네임+로그인) vs 멤버(아바타+드롭다운: 닉네임/프사 변경·로그아웃). `/api/avatar`(서명 업로드 → admin 검증 → `profiles.avatar_url`), 랭킹에 프로필 아바타(없으면 `/avatars/default.png`).
- 계정 정책: Supabase 자동 linking 수용(동일 verified 이메일 Kakao/Google = 같은 계정), 멀티연동 UI 없음. Provider 키는 앱 env 가 아니라 Supabase Auth config. 익명 dolls→운영계정 이관은 즉시 X — grace period 후 후속 정리(미승격 익명 보호).

v0.13 (2026-06-20, OAuth 후속 폴리시):
- **매끄러운 재로그인**: 이미 가입된 계정으로 로그인 시 거부 바운스 제거. `startOAuth` 가 `redirectTo` 에 `p=provider` 를 실어보내고, 콜백이 `identity_already_exists` 면 `/login?auto=<provider>` 로 → `LoginForm` 이 스피너 보이며 `signInWithOAuth` 자동 재개(allowlist + `useRef` 1회 guard, 루프 없음). 신규 가입(linkIdentity)은 그대로.
- **생성권 노출/가드**: `getMyProfile` 가 멤버면 `member_accounts.gen_credits` 도 반환(`formatCredits`: ≥9999 "무제한"). 계정 메뉴·갤러리에 "생성권 N개", `/generate` 는 `checking`→`no_credits` stage 로 0 이면 진입 차단(우측하단 의견 위젯 안내). 클라는 UX 가드일 뿐 — 최종 차단은 `/api/fal`(조회 실패 시 consent 로 진행).
- **프로필 사진 삭제**: `/api/avatar` DELETE(avatar_url=null + 버킷 본인객체만 best-effort 삭제, 외부 핫링크 스킵), `AvatarEditor` "기본 사진으로 되돌리기".
- 익명 dolls→운영계정(f81c8a92) **이관 실행**(0011 전, `doll_owner_migration_log` 백업). `member_accounts` 에 감사 컬럼(updated_at/version), `daily_gen_limit` 컬럼 제거(0011).

v0.14 (2026-06-21, 플레이 해석 리포트 — 페르소나, PR1/4):
- **"부장님 패기 인사평가 리포트"**: 종료화면에 score/combo 를 넘어 **플레이 스타일 페르소나** 즉시 리빌 → 이탈 방지·공유 유도. 룰베이스 결정적(LLM 없음, 대기 0) — 같은 플레이=같은 페르소나.
- **엔진 계측**(`store/gameStore.ts`): `weaponScores`(무기별 **final gain**=콤보배율 적용 점수기여), `ultimateCount`, `firstHitMs` 추가. `bgVisits` 는 store 밖이라 `app/play/page.tsx` ref 로 수집.
- **해석 엔진**(순수 모듈, SSR/CSR 공용): `lib/stats.ts`(`GameplayStats`/파생/서버검증), `lib/persona.ts`(~10종 결정적 우선순위 + **트리거 stat evidence** 동봉 — "이 분석은 이 데이터에서"). `lib/report.ts` 카피 자산 재사용.
- **저장**(migration 0015 `score_stats` — 1:1, public read, service-role write; highlight attach-once 불변식 보호 위해 별도 테이블): `/api/score` 가 점수 저장 **후 best-effort** 로 stats 검증·페르소나 계산·저장(`badge_ids`/`percentile` 은 후속 PR). 검증 = `sum(weaponScores)≈score`·`sum(weaponCounts)≈hitCount`(조작방지) → 실패 시 stats 폐기·점수는 항상 저장.
- 종료화면(`GameOverModal`/`ScoreReport`)이 페르소나를 **클라 즉시 계산**(서버 대기 없음). 익명도 동일 적용(승격 시 보존).
- **공유/OG 반영**(PR2/4): `/share/[scoreId]`·OG 가 `score_stats` 조인해 페르소나 카드 렌더(`components/PersonaCard` — 종료화면과 공용 DRY), CTA 를 "당신의 패기 유형은?"·"나도 패기 유형 받아보기"로 → 받는 사람 호기심→플레이 전환. OG 는 satori 제약상 페르소나/백분위 텍스트만(차트 없음).
- **뱃지 + 백분위**(PR3/4): migration 0016 — `user_badges`(owner_id별 누적 수집, 승격 시 보존) + `get_score_percentile` RPC(**전체 플레이 기준** `상위 ceil%`, ≤100 cap; 랭킹과 별개 지표). `lib/badges.ts`(11종 단일게임 업적). `/api/score` 가 best-effort 로 뱃지 부여·백분위 산정 후 `score_stats`(badge_ids/percentile 스냅샷)+`user_badges` 저장. 종료화면=이번 판 뱃지(클라 즉시)+NEW 표시+수집 N/M+백분위(서버 스켈레톤→채움), 공유/OG=스냅샷 렌더(`components/BadgeStrip` 공용).
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
- **상세**: "기록 회고" 역할 — 종료화면(즉시 축하)·`/share`(바이럴 자랑)와 분리. 보고서 카드 **축약판**(문서번호·인형·점수·상위%·콤보·총타격·주력무기·소요시간·등급·페르소나·획득뱃지). **부장님 멘트·OG·하이라이트 임베드는 제외**(역할 분리). `score.owner_id !== userId` 면 404(URL 변조 방지).
- **공용 추출**: `/share` 의 fetch/flatten/highlight 헬퍼를 **`lib/score-detail.ts`**(server-only, owner_id 포함, nested select 객체/배열 방어)로 추출해 상세와 공용. `timeAgo` 를 `lib/report` 공용화(leaderboard 중복 제거).
- **보고서 공유 통합** (`components/ShareReportButton`): 게임 직후·이전 기록 상세 **둘 다** Web Share API(`lib/share` `shareGameResult`, URL primary→clipboard 폴백)로 `/share/[scoreId]` 링크 공유 → 수신자는 `/share` 랜딩. 상세의 하이라이트-전용 "보기" 링크를 **항상 노출되는 공유 버튼**으로 대체(라벨만 하이라이트 유무로 "🔥 하이라이트 공유"/"결과 보고서 공유"). 모든 게임이 공유 가능.
- **메뉴 위계 평탄화 + 순서**: "내 뱃지"·"내 기록" 이모지(🏅)·볼드 제거(다른 메뉴와 동일 위계), 게임종료화면 하단 "내 뱃지" 링크도 평탄화. **비로그인 시 "로그인 / 회원가입"을 메뉴 최상단**으로. 인게임 뱃지 HUD/토스트·결과 뱃지칩은 유지.
- **dev/preview 영구 설정**: `npm run dev` 가 nvm v22 를 자동 선택(`PATH` prepend)하고 `--hostname 0.0.0.0` 로 바인딩 → 시스템 기본 node 와 무관하게 항상 기동 + **같은 WiFi 폰에서 `http://<맥 LAN IP>:3000` 접속**(next.config `allowedDevOrigins` 192.168.* 등 허용).

v0.17 (2026-06-22, 캐릭터 롤 확장 — 부장 → 5종):
- **롤 5종**: 부장(기본)·임원·팀장·거래처·짜증나는 직장동료. 캐릭터별 **피격자 의견·시비 멘트·인사기록(직급/소속/특이사항)·호칭·무기힌트·OG**가 롤별 고유(점수 10단계 풀뎁스). 판정등급·페르소나는 플레이어 것이라 롤 중립.
- **레지스트리** `lib/roles/`(RoleId·ROLE_META·getRoleContent, `TieredLines` 10단계 컴파일 강제 + dev assert). 셀렉터(report/taunts/weapons)에 `role` 파라미터(기본 boss). boss 출력은 리팩터 전과 동일(회귀 0).
- **데이터**: `dolls.role`(migration 0017, default 'boss', CHECK 5롤, 기존 doll 자동 boss 백필). 롤 변경 = `PATCH /api/doll`(owner 검증, unknown role 400). 갤러리 카드 좌상단 롤 칩 + 점세개 "롤 변경". 생성 기본 boss, **이미지/프롬프트 불변(롤=메타데이터)**.
- **배선**: play(시비멘트/게임오버 의견)·`/share`·`/doll` 인사기록·`/history`·OG 가 doll.role 로 분기(공유/기록은 라이브 doll join + 삭제 시 boss 폴백). 한국어 조사는 명사형(`noun`)+완성형(`targetObj`/`ctaSafe`/`ogLines`)으로 정확.
- **브랜드 유지**: 앱명("부장님 패기")·홈·메타·login 은 부장 그대로. 갤러리 집합 카피만 "캐릭터"로 중립화.

v0.18 (2026-06-22, 롤 후속 — 생성 시 롤 선택 + 감정선/포맷/조사):
- **생성 시 롤 선택**: 사진 crop 후 `role-select` 단계(`components/generate/RoleSelectStage`, 5칩·boss 기본) → 고른 롤이 **fal 프롬프트(복장·표정·분위기, `flux-pulid` `ROLE_VISUALS`)** 와 `dolls.role` 에 반영. 강한 캐릭터화(chibi·plush·identity) 정책은 공통 고정, **복장/표정만 롤 차등**(임원=고급정장+포켓스퀘어, 팀장=노타이·소매 걷음, 거래처=정장+방문증, 동료=니트 가디건). 이미지=생성 시 롤 반영, 이후 갤러리 롤 변경=텍스트만(재생성 없음).
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

**마이그레이션 적용**: 0006~0011 은 Supabase **management API query 엔드포인트**로 직접 적용 완료
(`POST /v1/projects/<ref>/database/query`, `SUPABASE_ACCESS_TOKEN`). 이후 마이그레이션도 동일 방식 — `.sql` 은 `supabase/migrations/` 에 보존(추적용).

**⚠️ Migration 0019 적용 필요** (`supabase/migrations/0019_payapp_orders.sql`): `payapp_orders` 테이블 + `mark_paid_and_grant` RPC. 적용 + `PAYAPP_*`/`NEXT_PUBLIC_SITE_URL`(prod) env 설정 전엔 결제 비활성(503).

**⚠️ Migration 0020 적용 필요** (`supabase/migrations/0020_admin_monitoring.sql`): `is_admin`+seed(emfoa23)·`payapp_orders.canceled_at/clawback_credits`·인덱스·`admin_actions_ledger`·`get_admin_funnel`/`get_admin_order_summary`/`admin_settle_stuck_order`/`admin_cancel_order`/`admin_adjust_credits` RPC. **additive(구 코드 무영향)** — 적용 전엔 `/admin` 비활성(requireAdmin 관용 차단). + env `CRON_SECRET`(.env.local+Vercel), cron-job.org 설정, Sentry emfoa23 초대.

**⚠️ Migration 0005 적용 필요** (`supabase/migrations/0005_generation_recovery.sql`):
ai_generations 에 candidate_urls/picked_doll_id 컬럼 + status 에 'picked' 추가. 적용 전엔 복구 기능 비활성(앱은 정상).

**⚠️ Migration 0004 적용 필요** (`supabase/migrations/0004_quota_balance_rank.sql`):
profiles public read (랭킹 닉네임) + daily_gen_limit + scores duration 1시간.
**⚠️ FAL_ADMIN_KEY 발급 필요**: fal dashboard → ADMIN scope 키 → `.env.local` 과 Vercel 환경변수에 추가 (없어도 동작하나 잔액 hard cap 비활성).

다음:
- **OAuth 로그인**: Supabase 내장 OAuth (Google/Kakao) + `linkIdentity()` 로 익명 계정 승격 (인형/점수/닉네임 유지). 키는 Google Cloud Console / Kakao Developers 에서 발급 → Supabase Dashboard 등록
- ~~결제 (생성권)~~ ✅ v0.19 페이앱(무사업자) 충전 구현. 향후: 규모 확대 시 사업자등록+토스페이먼츠 전환, 현금영수증/구매내역 UI/자동 환불
- 도메인 연결 (bosspaegi.com 등)
- 서비스 워커 (오프라인 캐싱) — Lighthouse "installable" full pass
- 보고서 OG 이미지를 결재 보고서 디자인으로 (현재는 기존 포맷)

## 비용 (MVP 단계)

- Vercel Hobby / Supabase Free Tier 무료.
- fal.ai 생성당 ~$0.025-0.05. 생성권 크레딧(가입 5개 + 페이앱 유료 충전)으로 통제. + fal 잔액 hard cap($2).
- **하이라이트 클립 스토리지/egress** (Supabase Free 1GB/5GB egress): **공유 시점만 업로드**(매 게임 X) + 클립 크기 캡(~4s·≤~2MB) + 재생은 Supabase CDN 직접(Vercel egress 0)으로 통제. 바이럴 급증 시 TTL cron(컬럼 설계 완료)·Cloudflare R2(egress 무료) 오프로드·Supabase Pro 가 스케일 경로.
