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
│   ├── api/                #   서버 Route (fal.ai 프록시, score, doll)
│   ├── generate/           #   인형 생성 플로우
│   ├── play/               #   게임 화면 (PixiJS 마운트)
│   ├── gallery/            #   내 인형 갤러리
│   ├── leaderboard/        #   랭킹
│   ├── layout.tsx
│   └── page.tsx            #   랜딩
├── game/                   # PixiJS 게임 로직 (React 와 분리)
│   ├── scenes/             #   PlayScene (입력 모드 전환 통합)
│   ├── entities/           #   Doll / Projectile / DrawingLayer
│   ├── effects/            #   HitEffect (파티클)
│   ├── physics/            #   matter.js wrapper (PhysicsWorld)
│   └── input/              #   ThrowInput, DrawInput
├── lib/
│   ├── supabase/           #   client.ts / server.ts
│   ├── fal.ts              #   fal.ai 호출 + 프롬프트 빌더
│   ├── policy.ts           #   동의 문구 / 면책 상수
│   ├── log.ts              #   구조화 JSON 로깅 (console + Sentry 브릿지 / 토큰 스크럽)
│   ├── sentry-bridge.ts    #   로그 이벤트 → Sentry (error/warn=issue, info=breadcrumb)
│   └── share.ts            #   Web Share / OG helper
├── components/             # React UI
├── store/                  # Zustand stores
├── supabase/migrations/    # SQL 마이그레이션
└── public/
    ├── manifest.webmanifest
    ├── icons/              # PWA 아이콘
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
| `FAL_KEY` | fal.ai API 키. **서버 전용** |
| `NEXT_PUBLIC_SITE_URL` | 공유 링크 / OG 이미지용 |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN. 미설정 시 Sentry 전부 no-op (앱 정상) |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | 빌드 시 소스맵 업로드용 (선택) |

## 모니터링 (Sentry)

에러/경고 알림 + **구조화 로그(Logs)** + **트레이싱(성능)** + **세션 리플레이** + **인앱 의견 위젯**. 초반 서비스 품질 향상 위해 유저 행동/피드백을 직접 관찰 — 게임 데이터(캐릭터/플레이/랭킹/닉네임/userKey)는 비민감 취급, **업로드 원본 얼굴만 마스킹**(정책 #1/PIPA).

- **로그 브릿지**(`lib/sentry-bridge.ts`, `emit()` 한 곳): `log.error/warn` → `captureMessage`(event 명 fingerprint 그룹핑 → 이벤트당 1 이슈) **+ `Sentry.logger`(Explore→Logs 검색)**, `log.info` → `Sentry.logger.info`+breadcrumb. 초고빈도 `gen.recover_list` 는 Logs 제외(볼륨). `enableLogs: true`.
- **게임 액션 로그**(`app/play/page.tsx`): `game.start`(dollId/weapon/bg)·`game.end`(score/maxCombo/hitCount/weaponCounts/mainWeapon/durationMs)·`game.weapon_switch`·`game.bg_switch`·`game.ultimate_fire` → Logs/Discover 에서 무기·점수대·플레이타임 분석. 고빈도 `hit` 은 per-hit 로그 안 함(`game.end` 요약으로 충분).
- **전역 신원/컨텍스트**(`lib/sentry-context.ts`): `setSentryIdentity(userKey, 닉네임)` → `Sentry.setUser`(모든 event/replay/log 에 자동 부착, `SessionBootstrap`); `setSentryGameContext({dollId,weapon,bg,gamePhase})` → `setTag`(weapon/bg/doll_type/game_phase)+`setContext("game_session")` → 태그로 끊어 보기. 55개 로그 site 안 건드리고 정보 극대화.
- **트레이싱**(production 한정 — dev/preview 는 0 으로 게이트해 대시보드 오염·span 한도 소모 방지): server `tracesSampler` 라우트별 차등(`/api/fal`·`/api/doll`=1.0, `/api/score`=0.5, **`/api/generations`=0.05**(폴링), 기본 0.1), client 0.1(Web Vitals 자동). 생성 파이프라인 커스텀 스팬(`gen.prepare_input`/`face_upload`/`detect_glasses`/`fal_submit`, `gen.fal_status`/`fal_result`/`copy_candidates`, `doll.bg_removal`/`normalize`) + 점수 제출 스팬(`score.submit`, score/maxCombo/weapon/durationMs/dollId attr). fal/Supabase 는 fetch 자동계측 `http.client` 스팬(`tracePropagationTargets` 는 자기 도메인만). release health(crash-free)는 release(SHA)+autoSessionTracking 자동.
- **세션 리플레이**(`instrumentation-client.ts`, **production 한정** — dev/preview 는 0 으로 게이트해 공용 50/월 한도 미소모): 에러 세션 100%(`replaysOnErrorSampleRate`) + 일반 20%(`replaysSessionSampleRate`). DOM-only(PixiJS 캔버스 녹화 미사용 = 모바일 perf). 게임 UI/텍스트는 비민감이라 언마스크, **`.sentry-block-face`(`/generate` 업로드 미리보기·`PhotoCropper` 크롭 컨테이너)만 `block`+`mask`** → 원본 얼굴 replay 미포함(크롭 컨테이너 차단이 내부 `<img>`까지 마스킹 — react-easy-crop 은 portal 미사용).
- **인앱 의견 위젯**(`feedbackAsyncIntegration`, `#sentry-feedback`): 버그·건의 자유 제보. **async = 모달/스크린샷 코드는 클릭 시 CDN 지연로드**(초기 번들 경량 — 모바일 PWA). 스크린샷 OFF(얼굴/캔버스 캡처 방지)·이름/이메일 입력 없음. `/play` 몰입화면(`.game-surface`)에선 무기바와 겹쳐 `globals.css` `:has()` 로 숨김, 그 외(홈/갤러리/랭킹) 노출.
- **자동 포착**: 서버/RSC/Route 미처리 에러(`instrumentation.ts` `onRequestError`), 클라 미처리 에러(`instrumentation-client.ts`), 루트 렌더 에러(`app/global-error.tsx`).
- **PII**: `sendDefaultPii: false`(IP·헤더·쿠키 미수집) + `beforeSend` 로 URL 쿼리스트링(서명 토큰) 제거. ctx 는 이미 `scrubSecrets`/`urlHost` 적용. 식별자는 익명 UUID(`userId`)+게임 닉네임(실명 아님)만 `setUser`. **업로드 원본 얼굴은 Replay 에서 마스킹**(`.sentry-block-face`) — AI 생성 후보·플레이 화면은 비민감이라 미마스킹.
- **설정**: Sentry 프로젝트 생성 → `NEXT_PUBLIC_SENTRY_DSN`(+선택 `SENTRY_*`)을 `.env.local`/Vercel 에 추가. DSN 없으면 init 안 함 → no-op. 광고차단 우회용 터널 `/monitoring`(proxy matcher 에서 제외).
- **권장 알림**(Sentry UI, production 한정): `falbal.hard_cap_hit`·`gen.submit_fail`·`auth.anon_sign_in_fail`·`gen.done_update_fail`·`score.out_of_range` 즉시, `gen.fal_timeout`·`gen.candidate_copy_giveup` 스파이크.

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
- **Rate limit**: AI 생성은 `ai_generations` 테이블로 일일 N회 / 사용자 강제 (서버 Route 검증).

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

**마이그레이션 적용**: 0006~0008 은 Supabase **management API query 엔드포인트**로 직접 적용 완료
(`POST /v1/projects/<ref>/database/query`, `SUPABASE_ACCESS_TOKEN`). 이후 마이그레이션도 동일 방식 — `.sql` 은 `supabase/migrations/` 에 보존(추적용).

**⚠️ Migration 0005 적용 필요** (`supabase/migrations/0005_generation_recovery.sql`):
ai_generations 에 candidate_urls/picked_doll_id 컬럼 + status 에 'picked' 추가. 적용 전엔 복구 기능 비활성(앱은 정상).

**⚠️ Migration 0004 적용 필요** (`supabase/migrations/0004_quota_balance_rank.sql`):
profiles public read (랭킹 닉네임) + daily_gen_limit + scores duration 1시간.
**⚠️ FAL_ADMIN_KEY 발급 필요**: fal dashboard → ADMIN scope 키 → `.env.local` 과 Vercel 환경변수에 추가 (없어도 동작하나 잔액 hard cap 비활성).

다음:
- **OAuth 로그인**: Supabase 내장 OAuth (Google/Kakao) + `linkIdentity()` 로 익명 계정 승격 (인형/점수/닉네임 유지). 키는 Google Cloud Console / Kakao Developers 에서 발급 → Supabase Dashboard 등록
- **결제 (생성권)**: AI 캐릭터 생성권 구매 모델. ai_generations 기반 쿼터 확장 + credits 테이블 추가 예정
- 도메인 연결 (bosspaegi.com 등)
- 서비스 워커 (오프라인 캐싱) — Lighthouse "installable" full pass
- 보고서 OG 이미지를 결재 보고서 디자인으로 (현재는 기존 포맷)

## 비용 (MVP 단계)

- Vercel Hobby / Supabase Free Tier 무료.
- fal.ai 생성당 ~$0.025-0.05. 무료 일일 1회 제한으로 통제.
