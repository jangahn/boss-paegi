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
│   ├── scenes/
│   ├── entities/
│   ├── effects/
│   └── input/
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

다음 (post v0.3):
- 도메인 연결 (bosspaegi.com 등)
- 던지기 / 펜 낙서 무기 (Physics 기반)
- 소셜 가입 (카카오/구글) 으로 anonymous → permanent 업그레이드
- 서비스 워커 (오프라인 캐싱) — Lighthouse "installable" full pass

## 비용 (MVP 단계)

- Vercel Hobby / Supabase Free Tier 무료.
- fal.ai 생성당 ~$0.025-0.05. 무료 일일 1회 제한으로 통제.
