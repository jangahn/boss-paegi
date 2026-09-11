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

## 한계
- Playwright WebKit 은 데스크톱 WebKit — iOS Safari 고유 quirk 일부(`datetime-local` 고유 최소폭 등)는 재현되지 않는다. 그런 항목은 코드 규약(`block w-full min-w-0 appearance-none`)으로 막고 실기기로 확인한다.
- `/play` 는 캔버스라 DOM 측정만 하고 버튼 탐색은 건너뛴다. 게임 종료 모달은 `/share/[scoreId]`·`/history/…/[scoreId]` 카드로 대신 본다.
