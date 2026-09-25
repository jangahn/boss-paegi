# iPhone SE(375×667) 무깨짐 전수 검사 하네스

모든 페이지(사용자향·어드민)와 버튼/모달 상태를 375px 로 크롤하며 레이아웃 위반을 측정한다(v1.27, 사용자 상시 규칙: "모든 페이지는 iPhone SE 에서도 깨지면 안 된다").

## 측정 항목
| type | sev | 의미 |
|---|---|---|
| `doc-overflow` | error | 문서 가로 스크롤(scrollWidth > 375) |
| `child-overflow` | error | 자식 박스가 부모 박스를 벗어남(부모가 스크롤 컨테이너·hidden 이 아닐 때) |
| `content-overflow` | error | 요소 내용이 자기 박스를 넘침(overflow visible) |
| `out-of-viewport` | error | fixed/absolute 요소가 뷰포트 밖 |
| `clipped` | warn | overflow hidden 에 잘림(ellipsis 없음) |
| `label-wrapped` | warn | 짧은 라벨(≤8자·공백 없음)이 2줄 이상으로 꺾임(알약·탭·버튼 찌그러짐) |
| `short-wrapped` | warn | 짧은 글(공백 빼고 12자 이하 — 닉네임·값·표 칸)이 2줄 이상으로 꺾임(v1.57) |
| `orphan-wrap` | warn | 60자 이하 글의 마지막 줄이 한두 글자뿐인 꼬리 줄바꿈(「…시작됐습 / 니다」, v1.57) |

두 꺾임 검사는 더 쪼개지지 않는 블록(자식이 전부 인라인)마다 잰다 — 문단 속 굵은 글씨처럼 흐르다 줄이 바뀌는 인라인 요소는 그 문단으로 보고, 절대·고정 위치 자식(숫자 배지)은 빼고, 같은 줄은 세로 겹침으로 묶는다(글자 크기가 섞인 줄, v1.58).
| `truncated` / `scroll-container` | info | 의도된 ellipsis·가로 스크롤 컨테이너(검토용) |

제외: 변형 요소(transform/rotate/scale/translate — 회전 스탬프), 의도된 블리드(`-mx-*`), sr-only(1×1), 폼 컨트롤 내부 텍스트 스크롤(input/textarea/select).

## 안전장치
쓰기 요청(POST/PUT/PATCH/DELETE)은 네트워크 계층에서 전부 차단(토큰 갱신만 허용) → **프로덕션을 대상으로 버튼을 눌러도 데이터가 바뀌지 않는다.** 로그아웃·소셜 로그인·계정 삭제 버튼은 클릭 대상에서 제외. 서버 액션·Supabase 직접 쓰기도 POST 라 함께 차단된다.

## 실행
```bash
# 1회: 하네스 전용 디렉토리에 playwright 설치(레포 의존성 아님)
mkdir -p /tmp/se-audit && cd /tmp/se-audit && npm init -y >/dev/null && npm i playwright@1.58 && npx playwright install chromium webkit
cp <repo>/scripts/qa/se-audit/*.mjs <repo>/scripts/qa/se-audit/seeds.example.json .
# 2) 관리자 세션 쿠키(sb-<ref>-auth-token.0/.1) → cookies.json [{name, value}] · seeds.json 은 example 의 <id> 를 실제 id 로
# 3) 전수 (엔진별 ~50분)
BASE=https://boss-paegi.vercel.app ENGINE=chromium node audit.mjs   # → out-chromium/report.md, shots/
BASE=https://boss-paegi.vercel.app ENGINE=webkit   node audit.mjs   # iOS 계열 quirk(폼 컨트롤 고유폭 등)는 webkit 에서만 드러난다
# 4) 단일 페이지/상태 즉시 측정
ENGINE=webkit node one.mjs /admin/content/legal/terms "새 버전으로 개정"
```
seeds 는 링크 필터(`SKIP_HREF`: /api·/auth·/login·로그아웃 등)를 **우회**한다 — `/login`·`/auth/*` 화면도 seeds 에 적으면 측정된다(소셜 로그인·로그아웃 버튼 클릭은 `SKIP_CLICK` 이 막는다). 비회원 상태 화면(`/login`, `/consent` 는 비회원이면 `/login` 으로 리다이렉트)은 `cookies.json` 이 없는 디렉토리에서 `one.mjs` 로 따로 측정한다.

환경변수: `MAX_PAGES`(기본 400) · `MAX_CLICKS`(페이지당 30) · `PER_PATTERN`(같은 라우트 패턴당 2) · `CLICK=0`(버튼 탐색 끄기) · `ONLY=<regex>`.

## 화면 밀림 측정 (`shift.mjs`, v1.60)
자산(로고 · 사진 · 캐릭터 이미지)이나 데이터가 늦게 와서 **이미 그려진 요소가 자리를 옮기는지**를 라우트마다 잰다. 느린 4G(왕복 150ms, 1.6Mbps) · CPU 4배 감속 · 라우트마다 새 컨텍스트(첫 방문)로 열고 Chromium layout-shift 기록에서 CLS(창 방식)와 움직인 요소 · 전후 좌표를 뽑는다. 판정은 CLS 0.1 이상 error, 0.01 이상 warn.
```bash
BASE=https://boss-paegi.vercel.app COOKIES=./cookies.json SEEDS=./seeds.json node shift.mjs   # → out-shift/shift-report.md
ONLY='^/(news|leaderboard)' FILM='^/news/' node shift.mjs                                      # 일부 라우트 + 화면 프레임(out-shift/film/)
```
- 쓰기 차단 · Sentry 차단은 `audit.mjs` 와 같다. Chromium 전용이고, 3px 미만 이동은 Chromium 이 세지 않는다.
- Playwright 가 route 를 가로채면 HTTP 캐시가 꺼진다 — 재방문(캐시 있음)은 잴 수 없고, 캐시 동작은 응답 헤더로 판단한다.
- 쿠키 없이(비회원) 재면 익명 로그인(POST)이 막혀 하이드레이션 게이트가 안 풀린다 — 서버 HTML 단계(로고 · 본문 이미지 자리)만 유효하다. 브라우저에서 채우는 영역은 회원 세션으로 잰다.
- 밀림을 막는 규약(v1.60): 이미지는 도착 전에 완성 크기의 자리(고정 크기 · aspect · 실제 비율의 width/height), 서버 HTML fallback 은 실제 첫 화면과 같은 스켈레톤, 로딩 상태에는 `PAGE_LOADING_PROPS`(`lib/page-loading.ts` — 그동안 사업자 정보 푸터를 뺀다). `__tests__/qa/layout-shift-contract.test.ts` 가 소스에서 고정한다.

## 한계
- Playwright WebKit 은 데스크톱 WebKit — iOS Safari 고유 quirk 일부(`datetime-local` 고유 최소폭 등)는 재현되지 않는다. 그런 항목은 코드 규약(`block w-full min-w-0 appearance-none`)으로 막고 실기기로 확인한다.
- `/play` 는 캔버스라 DOM 측정만 하고 버튼 탐색은 건너뛴다. 게임 종료 모달은 `/share/[scoreId]`·`/history/…/[scoreId]` 카드로 대신 본다.
