# 점수 어뷰징 방지 설계 (Anti-Abuse Design)

> 상태: **구현 완료**(PR1~6, 2026-07-02) + **S2 임계 교정 v2**(2026-07-03) · 작성: 2026-07-02 · 근거: 프로덕션 전수조사
> 구현은 하단 "구현 계획"의 PR 단위로 진행했다. 신호별 최신 임계의 SoT 는 `lib/anti-abuse-rules.ts`.

## 1. 배경 — 무엇이 일어났나

프로덕션 리더보드 1·2위가 단일 유저(`ljd_@naver.com`, 카카오, 비관리자)의 조작 점수다.

| | 레코드1 (1위) | 레코드2 (2위) |
|---|---|---|
| score | 3,600,000 | 2,186,835 |
| duration | 30분(정확히 캡) | 29.6분 |
| 정체 | 오토클리커 apm 3,431(57타/초), 원점수 4.96M을 클라가 상한 3.6M로 클램프 | 직접 제출형: 연결 텔레메트리는 63K/3.5분(apm 197)인데 점수는 2.19M/29.6분 (34배 불일치) |
| 현재 탐지 | telemetry.suspicious=true (but 무효) | suspicious=false (완전 우회) |

근본 원인 3가지:
1. **서버가 점수를 재계산하지 않음** — `body.score`를 그대로 신뢰, 유일 방어는 `scoreCeiling(durationMs)` 상한 하나. (`app/api/score/route.ts:61-75`)
2. **상한이 관대** — `MAX_AVG_SCORE_PER_SEC=2000`은 검증된 인간 최고(1,267/초)의 1.6배, 정상 최고점(406K)의 ~9배 위조를 통과시킴.
3. **안티치트가 무력** — `validateGameplayStats`는 자기신고 숫자의 산술정합만 검사(→ ultScore에 몰아넣으면 통과), best-effort라 실패해도 점수는 저장. `telemetry.suspicious`는 점수·리더보드에 전혀 연결 안 됨(죽은 신호).

## 2. 목표 / 비목표

**목표**
- 오토클리커·매크로·직접 API 제출로 만든 점수가 리더보드/백분위/뱃지에 노출되지 않게 한다.
- 판정을 **서버 권위**로 이전한다(클라 판정 신뢰 제거).
- 어뷰징 의심 점수를 운영자가 종합 지표로 확인·대응할 수 있는 어드민 탭을 제공한다.
- 오탐은 **가역적**으로 처리한다(숨김→복원 가능, 하드 삭제/차단 지양).

**비목표**
- 100% 완벽 차단(불가능). 목표는 "현재 관측된 4~6배 격차 벡터를 오탐 없이 막고, 회색지대는 사람이 판단"이다.
- 게임 플레이 자체 제한(입력 속도 캡 등) — 정상 고속 플레이어 UX를 해치므로 하지 않는다.

## 3. 위협 모델 — 두 벡터

- **A. 엔진 경유 봇** (레코드1): 오토클리커가 실제 게임을 구동 → 텔레메트리에 초인적 apm 기록. rate 신호로 탐지 가능.
- **B. 직접 제출형** (레코드2): 게임 엔진을 (충분히) 거치지 않고 `POST /api/score`에 위조 payload 제출. rate 신호가 **텔레메트리에 없음**. 제출된 payload 자체의 내부 물리 타당성 + 텔레메트리 정합으로만 탐지 가능.

> 핵심 교훈: **rate 기반 탐지(apm 등)만으론 B를 절대 못 잡는다.** 반드시 제출 payload 검증 + 텔레메트리↔점수 정합을 함께 둔다.

## 4. 실측 기준선 (프로덕션 텔레메트리, 치터·suspicious 제외)

APM은 세션이 길수록 상한이 급락한다(짧은 세션은 버스트로 뻥튀기).

| 세션 길이 하한 | 표본 | p95 | p99 | 관측 최대 apm | ≈ 타/초 |
|---|---|---|---|---|---|
| 전체 | 155 | 861 | 1,104 | 1,147 | 19.1 (5초 버스트) |
| ≥60초 | 28 | 810 | 869 | **879** | 14.6 |
| ≥120초 | 12 | 531 | 565 | **574** | 9.6 |
| ≥300초 | 5 | 476 | 491 | **495** | 8.3 |

- 인간 **순간 버스트 상한 ≈ 19타/초 (apm ~1,150)**, **지속(1분+) ≈ 15타/초 (apm ~880)**, **2분+ ≈ 10타/초**.
- **인간 최대 1,147 ~ 봇 3,298 사이에 세션이 하나도 없음(깨끗한 공백)** → 임계를 이 사이 어디에 둬도 현재 데이터상 오탐 0.
- 버킷(5초) 단위: 봇은 318버킷 내내 median apm **3,610**(천장 고정), 인간 최고는 median **570**·순간 최고 1,128 한 번.

## 5. 탐지 신호 & 임계값

> **max_combo는 신호에서 제외.** 콤보는 1500ms 무입력에만 끊기므로, 연속 탭하는 인간은 수천 콤보를 쉽게 유지한다(실측: 인간이 combo_ratio 1.0로 2,646 콤보). 봇/인간을 가르지 못한다.

### 5.1 제출 시점 신호 (서버, `body`={score, durationMs, gameplayStats}만으로 판정 — 텔레메트리 불요)

| ID | 신호 | 플래그 조건 | 근거 |
|---|---|---|---|
| S1 | **지속 타격속도** `hitCount/durationSec` | ≥60초에서 > 18/s, 또는 임의 길이에서 > 25/s | 인간 지속 최대 ~15/s. REC2=23/s → 잡힘. REC1=57/s → 잡힘. |
| S2 | **무기별 점수 타당성** | 어떤 무기 w(≥20타)에서 `(weaponScores[w]−300)/weaponCounts[w] > 실효maxBase(w)×8×1.05` | 타당 상한 = **실효 max base**(속도 배율 상한 반영: swipe ×2.0·throw ×2.2·grab fling strength+30, 고정무기는 strength) × 콤보캡4 × 다양성캡2. fresh 300 은 무기당 1회 weaponScores 귀속이라 정확 차감. "적은 타격·거대 점수" 위조 차단. ⚠ v1 산식(strength×8×1.15, fresh 미차감)은 정상 플레이와 충돌(실측 grab 271.8/타 > 184 — 오탐 2건) → 2026-07-03 교정, 클린 v2 535튜플 전수 FP 0 검증. |
| S3 | **평균 점수/초** `score/durationSec` | > 1,400 | 인간 검증 최대 1,267. |
| S4 | **stats 누락/검증실패** | gameplayStats 없음 또는 `validateGameplayStats` 실패 | REC1의 "stats 없이 조용히 저장" 구멍을 닫음 → pending 처리. |

S1·S2가 **직접 제출형(B)** 을 payload만으로 잡는 열쇠다. 위조자가 hitCount를 낮추면 avg-per-hit이 올라 S2에 걸리고, 높이면 S1에 걸린다(닫힌 박스). 봉투의 실질 바인딩은 **S3**(S2×S1 최대 ≈ 420×18 ≈ 7,560/s ≫ S3 1,400/s) — S2 교정으로 무기별 임계가 올라도 무플래그 위조 상한(1,400/s × 900s ≈ 126만점)은 불변이다. S2 의 역할은 총량이 아니라 "특정 무기에 점수를 몰아넣은 비정합 payload" 탐지.

### 5.2 cron 백스톱 신호 (텔레메트리 확정 후 — `/api/ops/integrity-scan`)

텔레메트리는 delta 스트리밍이라 점수 제출 직후엔 미확정일 수 있음 → 정합 검사는 사후로.

**완주 게이트(C1·C1B 공통, v3/0054):** 정합 검사는 텔레가 **게임 끝까지 기록한 경우만** 수행한다 — `tscore>0` **그리고** `telemetry.end_reason ∈ {normal, time_limit, score_limit}`. `endSession(reason)`이 게임오버 사유로 텔레를 종료하므로 이 값이면 완주. `abandon/reload/hidden_timeout/null`은 조기 절단이라 duration·score가 부분값 → 정합 비교가 무의미(오탐). 근거: 텔레 duration은 collector `end()`에서 동결되는데 탭 30초+ 숨김 시 `hidden_timeout`으로 절단되는 반면, `scores.duration_ms`는 게임 벽시계(백그라운드 포함)라 정상 유저도 큰 "불일치"가 난다(전수조사 2026-07-08: 완주 텔레 184건 C1B 발화 0 / hidden_timeout 발화는 100%가 절단 아티팩트, 진짜 의심방향 0건). ⚠ 트레이드오프: 절단 텔레는 C1/C1B가 건너뛰므로 "탭 백그라운드로 텔레 절단 후 위조" 경로는 cron이 못 잡는다 — 단 위조 봉투는 제출시 **S3(1,400/s)**로 여전히 바인딩되고, 실제 절단-텔레 어뷰징은 관리자/오토클리커 판정이 담당(실측 REC2는 C1이 아니라 관리자 CONFIRMED_AUTOCLICKER로 차단).

| ID | 신호 | 플래그 조건 | 근거 |
|---|---|---|---|
| C1 | **텔레메트리↔점수 정합** | 완주 텔레에서 `|scores.score − telemetry.score|/score > 0.2` | REC2의 34배 불일치 차단. |
| C1B | **텔레메트리↔duration 정합** | 완주 텔레에서 `|scores.duration_ms − telemetry.duration_ms|/telemetry.duration_ms > 0.2` | 제출 duration 위조 차단. 절단 텔레는 완주 게이트로 제외(오탐 방지). |
| C2 | **지속 apm (버킷)** | 세션 ≥60초에서 버킷 median apm > 1,200 | 봇 median 3,610 vs 인간 570. |
| C8 | **연결 텔레 suspicious** | 제출 후 텔레가 단조(monotonic)로 suspicious=true 확정 | 제출 시점엔 미확정이던 오토클리커를 사후 확정. |
| C3 | (후속) **타격 간격 규칙성 (jitter/CV)** | CV < 0.1 (거의 등간격) | 가장 우회 불가 신호. **현재 미수집** — 클라 텔레메트리 summary에 CV 추가 필요(별도 과제). |

### 5.3 판정
- 제출 신호(S1–S10) 또는 cron 신호(C1·C1B·C2·C8) 중 **하나라도** 발화 → `review_status='pending'` + `leaderboard_hidden=true`.
- `abuse_score` = 발화 신호의 가중합(리뷰 큐 정렬·우선순위용, 판정 자체는 boolean OR).
- 임계는 인간 최대의 1.5~3배 위에 있어 현재 데이터상 오탐 0이지만, 고주사율+터보마우스 등 회색지대 가능성 때문에 **하드 리젝이 아니라 flag→운영자 리뷰(가역)** 로 둔다.

## 6. 제출 흐름 & UX (서버 권위)

```
게임종료 → "랭킹 등록 중…" (클라)
   → POST /api/score
        서버: 점수 저장 + 5.1 신호 판정
        ├ clean   → { status: "registered" }  → "랭킹에 등록되었습니다!" → 리더보드 노출
        └ flagged → { status: "pending" }     → 아래 안내 + leaderboard_hidden=true
```

- **하드 유저-리젝은 두지 않는다**(어뷰저에게 임계값을 노출하지 않기 위해, 그리고 포렌식 보존). 모든 점수는 저장하되 flagged면 숨김.
- `registered`/`pending`은 **서버가 결정**해 반환, 클라는 표시만. (현재 root cause인 "클라가 판정"을 뒤집는 핵심)

**flagged 종료화면 문구 (초안):**
> 랭킹 등록이 접수되었습니다.
> 비정상 플레이 패턴이 감지되어 **운영자 확인 후 랭킹에 반영**됩니다.
> ⚠ 매크로 등 부정한 방법으로 점수를 조작할 경우 **계정이 정지될 수 있습니다.**

**clean 문구:** "랭킹에 등록되었습니다!"

- 유저 본인 기록(마이페이지/공유)에는 pending 점수가 "확인 중" 상태로 보이되 리더보드 순위엔 미반영.

## 7. 데이터 모델 (additive 마이그레이션)

```sql
-- scores 확장
alter table scores add column review_status text not null default 'registered'
  check (review_status in ('registered','pending','cleared','voided'));
alter table scores add column leaderboard_hidden boolean not null default false;
-- (leaderboard_hidden = pending/voided/banned-user 일 때 true. review_status와 중복 같지만
--  리더보드/백분위 쿼리의 빠른 단일 컬럼 필터용. 트리거 또는 앱에서 동기 유지.)

-- 리뷰 큐 + 감사 (side 테이블, server-only)
create table score_flags (
  score_id uuid primary key references scores(id) on delete cascade,
  signals jsonb not null default '[]',      -- ["S1","C1",...] + 각 신호 관측값
  abuse_score int not null default 0,
  status text not null default 'pending'    -- pending|cleared|voided
    check (status in ('pending','cleared','voided')),
  action text,                              -- hide|void|clear|ban 등 마지막 조치
  reviewed_by uuid, reviewed_at timestamptz, reason text,
  created_at timestamptz not null default now()
);

-- 유저 단위 상태
alter table member_accounts add column abuse_status text not null default 'clean'
  check (abuse_status in ('clean','flagged','banned'));
```

## 8. 리더보드 / 백분위 / 뱃지 통합 (오염 실제 제거)

- `get_leaderboard`, `get_score_percentile` RPC에 `where review_status = 'registered'`(또는 `not leaderboard_hidden`) 추가.
- **뱃지 동반 숨김**: `user_badges.first_score_id`가 hidden 점수를 가리키면 그 뱃지는 프로필·수집카운트·종료화면에서 **제외**. 단 같은 임계를 만족하는 **clean 점수가 따로 있으면 유지**(재평가). `cleared` 되면 복원. (치터의 47종은 전부 hidden 점수 기반이라 전량 사라짐.)
- 백분위 모수에서 hidden 점수 제외 → 정상 유저 백분위 정상화.

## 9. 어드민 탭 `/admin/integrity` (무결성)

기존 `/admin/moderation`(신고/takedown, 가역 restore/permanent-delete) 패턴 미러링.

**9.1 리뷰 큐** — flagged 점수 목록, `abuse_score` 내림차순. 행: 유저(이메일 마스킹)·점수·시간·지속타격속도·score/초·발화 신호칩·현재 상태·리더보드 노출여부.

**9.2 상세 (종합 판단 지표)** — 한 점수당:
- **버킷별 apm 스파크라인** (봇=천장 고정 직선 / 인간=들쭉날쭉 → 육안 판별 1순위)
- 지속 타격속도(타/초) · score/초(제출 vs 텔레메트리) · hit_count · duration
- tap_share · max_touch · distinct_weapons · device_class · refresh_hz · dpr
- **텔레메트리↔점수 정합 배지** (일치 / N배 불일치 / 세션없음)
- 무기별 점수 타당성 (fresh 차감 avg/hit vs 실효 이론상한)
- **이 유저의 다른 세션·점수 이력** (첫 정상판 대비 이상치 — 치터도 초기엔 정상 75K였음)
- 발화 신호 목록 + abuse_score + 정상분포 대비 위치(percentile)

**9.3 액션 (전부 감사 로그, 가역 우선)**
- **Clear** — 오탐 해제: `review_status='cleared'`, `leaderboard_hidden=false`, 뱃지 복원.
- **Hide 유지** — pending 확정 유지(점수 보존, 숨김).
- **Void** — 점수 무효화: `review_status='voided'`, 뱃지 회수. (DB엔 보존)
- **Ban 유저** — `abuse_status='banned'`: **① 향후 점수 제출 차단(POST /api/score 거부)  ② 기존 전 점수 `leaderboard_hidden=true`**. 로그인·게임플레이·캐릭터 생성은 **막지 않음**.

**9.4 발견성** — analytics 세션 목록/대시보드에 flagged 카운트 배지 노출(현재는 세션 상세 1곳에만 있어 발견 불가).

## 10. 기존 데이터 처리 (결정됨)

- 레코드1·2(넓게는 봇 3건: +130,132) → **숨김 보존**(`review_status='pending'`+hidden), DB 보존해 포렌식·재검토 가능. **삭제 안 함.**
- 치터 계정(`ljd_@naver.com`) → **현재 조치 안 함**(정지 가능 안내 UX는 제공하되 이 유저는 미조치). 향후 재발 시 어드민에서 Ban.
- 뱃지 47종은 hidden 점수 기반이라 8번 규칙으로 자동 제외됨.

## 11. 구현 계획 (PR 분할)

| PR | 범위 | 산출 |
|---|---|---|
| PR1 | 마이그(7번) + 리더보드/백분위/뱃지 필터(8번) + **기존 봇 3건 숨김**(10번) | 오염 즉시 제거 |
| PR2 | 서버 제출 판정(5.1) + 제출 UX/문구(6번) | 신규 어뷰징 차단(A·B 둘 다) |
| PR3 | 어드민 탭 `/admin/integrity`(9번) | 운영자 확인·대응 |
| PR4 | cron 백스톱 `/api/ops/integrity-scan`(5.2 C1·C2) + cron-job.org 등록 | 사후 정합 검사 |
| (후속) | 클라 텔레메트리에 jitter/CV(C3) 추가 | 가장 우회 불가 신호 |

각 PR은 상위 `Personal/CLAUDE.md` 룰 준수: 브랜치 최신화 → 구현 → README/docs 갱신 → merge commit(squash 금지) → ~300-400줄 모듈 분리.

## 12. 미해결 / 후속 논의

- **jitter/CV 신호(C3)**: 가장 강력하나 클라 계측 추가 필요. PR4 이후 별도.
- **회색지대 정책**: 고주사율+터보마우스 정상 유저가 임계 근접 시 오탐 가능성 → flag→리뷰(가역)로 흡수. 데이터 쌓이면 임계 재조정.
- **레코드2 텔레메트리 오링크 원인**: 제출 시 세션ID 오첨부인지 백그라운드 누적인지 미확정(자동화 결론엔 무영향). C1이 어차피 잡음.
- **임계값 튜닝**: 5번 값은 현재 표본(비치터 155세션) 기반. 트래픽 증가 시 p99 재측정 권장.
- **S2 임계 교정 이력(2026-07-03)**: v1 산식(strength×8×1.15)이 속도 배율 경로·fresh 300 을 미반영해 오탐 2건(grab 247.8·214.9/타, 손 플레이) 발생 → 실효 max base 유도 + fresh 정확 차감 + margin 1.05 로 교정(`ANTI_ABUSE_RULES_VERSION=2026-07-anti-abuse-v2`). 검증: 클린 v2 251게임 535튜플 전수 FP 0(구 산식은 동일 데이터에서 19건 충돌), 실측 극값이 캡에 정확 안착(fist 96.0/gun 32.0/pen 24.0 = 캡). 임계가 캡×1.05 > 캡(per-hit gain 의 정수 하드 상한)이라 **모델이 유효한 한 오탐 불가**. ⚠ v1 stats(6/21 이전 5게임)는 ultScore 가 weaponScores 혼입이라 실측 기준선에서 제외해야 함.
- **S2 분포 모니터링 쿼리**(재보정·튜닝 변경 시 실행 — 무기별 fresh 차감 avg 분포):
  ```sql
  select k.key as weapon, count(*) as n,
         round(max(((st.gameplay_stats->'weaponScores'->>k.key)::numeric - 300) / w.cnt), 1) as adj_max,
         round((percentile_cont(0.99) within group (
           order by ((st.gameplay_stats->'weaponScores'->>k.key)::numeric - 300) / w.cnt))::numeric, 1) as adj_p99
  from public.scores s
  join public.score_stats st on st.score_id = s.id,
  lateral jsonb_object_keys(st.gameplay_stats->'weaponCounts') k(key),
  lateral (select (st.gameplay_stats->'weaponCounts'->>k.key)::numeric as cnt) w
  where s.review_status in ('registered','cleared')
    and st.gameplay_stats->>'v' = '2' and w.cnt >= 10
  group by k.key order by k.key;
  ```
- **S2b(후속 검토)**: 무기당 19타 이하로 분산하면 S2 가 전면 침묵(S2_MIN_HITS 게이트) — S3 가 총량을 막지만, 게임 전체 보정 avg `(score−ultScore−Σfresh)/hitCount` 를 보는 게이트 무관 전역 신호를 백로그로.
