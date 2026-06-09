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
- 무기 6종, 3그룹 — 탭(주먹/싸대기/책) · 던지기(키보드/종이) · 낙서(펜)
- matter.js 물리: 인형은 spring constraint 로 anchor 에 묶여 밀려났다 자동 복귀, 화면 4벽 튕김
- **인형 자체 드래그 던지기**: tap/throw 모드에서 인형 잡고 끌면 (≥14px) fling 시작 → 놓는 속도대로 발사 → 0.9초 자유 비행 후 anchor 복귀. 짧은 탭은 기존 mode 액션 유지 (tap=hit)
- **drag 중 벽 박기 점수**: fling 중 인형이 화면 4벽 margin(60px) 안으로 진입할 때마다 thud + 15점 + shockwave
- 던지기 무기 (키보드/종이): 화면 드래그→놓기 슬링샷 (당긴 반대 방향 발사, 화살표 미리보기 + power 0~1)
- 펜 낙서: stage 좌표계 dot row 누적 (graphic + fill, PIXI v8 호환). DrawInput 이 인형 face 화면 반경 안 좌표만 허용. doll body radius 0.55 × naturalSize (충돌 영역 확장)
- 타격감: projectile↔doll 충돌 시 punch ×1.4, burst ×3, 큰 shockwave + scorePop + 인형에 momentum force 적용. projectile 0.2초 fade 잔존
- 무기 picker 가로 6개 한 줄, 카테고리 구분선
- 효과음 2종 추가: whoosh (던지기·인형) · scribble (펜)

다음:
- 도메인 연결 (bosspaegi.com 등)
- 소셜 가입 (카카오/구글) 으로 anonymous → permanent 업그레이드
- 서비스 워커 (오프라인 캐싱) — Lighthouse "installable" full pass

## 비용 (MVP 단계)

- Vercel Hobby / Supabase Free Tier 무료.
- fal.ai 생성당 ~$0.025-0.05. 무료 일일 1회 제한으로 통제.
