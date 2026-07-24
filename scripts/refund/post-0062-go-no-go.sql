-- post-0062-go-no-go.sql — 환불 saga 배포 단일 정본 go/no-go gate (§32). G-1 ~ G-48.
--
-- 실행: management API query 엔드포인트로 파일 전문 실행(읽기 전용 — 데이터 무변경).
--   POST https://api.supabase.com/v1/projects/<ref>/database/query  (Bearer SUPABASE_ACCESS_TOKEN)
--
-- 계약(§32·§33):
--   * 각 gate 는 정확히 한 행 `gate | violations | scope | detail` 을 반환한다. violations>0 = NO-GO.
--   * 모든 gate 는 **malformed JSON 에 abort 하지 않는다** — resolved_lot_mappings·metadata·projection 등은
--     safe-stage CTE(jsonb_typeof 선검증 후 cast)로 처리해 malformed 도 no-go count 에 포함한다(§26·§33·§40).
--   * scope 열: 'normal+cutover'=상시 성립해야 함 / 'cutover'=컷오버 시점에만 0(open 잔존 0 등) /
--                'live'=cron 실 가동 후에만 0(SLA) / 'structural'=스키마·데이터 구조 불변식.
--   * 존재하지 않는 객체 참조 금지 — 전부 0062/0063 실 컬럼·함수(§12·§29·§14 batch)만 참조.
--   * 명세 A/D 는 gate ID·설명만 참조하고 SQL 은 이 파일이 유일 정본(§32 — 복사 금지·Q12=G-29·Q17=G-13·G-34 합침).
--
-- 적용 범위 주석(정상운영 vs 컷오버/0063):
--   G-7·G-11(evidence)·G-16..G-29·G-31·G-32·G-34..G-46·G-48 = 스키마·불변식(상시).
--   G-1..G-6·G-9·G-10·G-13·G-30·G-33·G-38..G-42 = 금융 데이터 불변식(상시).
--   G-43 = ACL/권한(0063 적용 후 clean). G-47 = live cron SLA. cutover 전용(open 잔존 0)은 0062 postflight Q7/Q16 이 담당.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 그룹 1. 금융 봉투 불변식 (D-invariants — 상시 성립)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- G-1: 캐시 봉투 — member_accounts.gen_credits ≡ Σ live 로트 잔여(qty−consumed−refunded−refund_reserved).
select 'G-1' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'member cache <> sum(live lot remaining)' as detail
  from public.member_accounts ma
  left join (select user_id, sum(qty - consumed - refunded - refund_reserved) as remain
               from public.credit_lots where expired_at is null group by user_id) l
    on l.user_id = ma.user_id
 where ma.gen_credits <> coalesce(l.remain, 0);

-- G-2: 예약 봉투 — lot.refund_reserved ≡ Σ open attempts.qty (per lot).
select 'G-2' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'lot.refund_reserved <> sum(open attempts qty)' as detail
  from public.credit_lots l
 where l.refund_reserved <> coalesce((
         select sum(a.qty) from public.order_refund_attempts a
          where a.credit_lot_id = l.id
            and a.state in ('prepared','pg_requested','pg_pending','pg_succeeded','manual_pending','manual_review')), 0);

-- G-3: orders.refunded_credits 분해 = Σ committed attempt.qty + Σ resolved live event.resolved_economic_qty
--        + Σ policy_close.closure_qty + Σ legacy evidence.refunded_credits.
select 'G-3' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'orders.refunded_credits decomposition mismatch' as detail
  from public.orders o
 where o.paid_at is not null
   and o.refunded_credits <> (
       coalesce((select sum(a.qty) from public.order_refund_attempts a
                  where a.order_uuid = o.order_uuid and a.state = 'committed'), 0)
     + coalesce((select sum(ev.resolved_economic_qty) from public.payment_cancellation_events ev
                  where ev.order_uuid = o.order_uuid and ev.origin = 'live' and ev.resolution_state = 'resolved'), 0)
     + coalesce((select sum((cl.metadata->>'closure_qty')::int) from public.credit_ledger cl
                  join public.order_refund_attempts a2 on a2.id = cl.ref_attempt_id
                 where a2.order_uuid = o.order_uuid and cl.event_type = 'refund_policy_close'
                   and jsonb_typeof(cl.metadata) = 'object'
                   and jsonb_typeof(cl.metadata->'closure_qty') = 'number'), 0)
     + coalesce((select sum(e.refunded_credits) from public.legacy_refund_backfill_evidence e
                  where e.order_uuid = o.order_uuid), 0));

-- G-4: orders.refunded_amount 분해 = Σ committed attempt.amount + Σ resolved live SUCCEEDED event.amount
--        + Σ legacy evidence.refunded_amount.
select 'G-4' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'orders.refunded_amount decomposition mismatch' as detail
  from public.orders o
 where o.paid_at is not null
   and o.refunded_amount <> (
       coalesce((select sum(a.amount) from public.order_refund_attempts a
                  where a.order_uuid = o.order_uuid and a.state = 'committed'), 0)
     + coalesce((select sum(ev.amount) from public.payment_cancellation_events ev
                  where ev.order_uuid = o.order_uuid and ev.origin = 'live'
                    and ev.status = 'SUCCEEDED' and ev.resolution_state = 'resolved'), 0)
     + coalesce((select sum(e.refunded_amount) from public.legacy_refund_backfill_evidence e
                  where e.order_uuid = o.order_uuid), 0));

-- G-5: per-lot Σ remaining_shortfall_qty <= lot.consumed (미회수 소비분은 소비량을 못 넘음).
select 'G-5' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'per-lot sum(remaining_shortfall) > consumed' as detail
  from (select s.lot_id
          from public.credit_refund_shortfalls s
          join public.credit_lots l on l.id = s.lot_id
         group by s.lot_id, l.consumed
        having sum(s.remaining_shortfall_qty) > l.consumed) q;

-- G-6: canceled+paid 주문의 purchase 로트에 사용가능 잔여 0(취소 주문은 live 크레딧 미보유).
select 'G-6' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'canceled-paid order has live purchase credit' as detail
  from public.credit_lots l
  join public.orders o on o.order_uuid = l.order_uuid
 where l.source = 'purchase' and o.status = 'canceled' and o.paid_at is not null
   and l.expired_at is null and (l.qty - l.consumed - l.refunded - l.refund_reserved) > 0;

-- G-7: attempt 금액·수량 양수(구조).
select 'G-7' as gate, count(*)::int as violations, 'structural' as scope,
       'attempt amount<=0 or qty<=0' as detail
  from public.order_refund_attempts a
 where a.amount <= 0 or a.qty <= 0;

-- G-8: 로트 카운터 sanity — 음수 없음·합계<=qty(테이블 CHECK 이중 확인).
select 'G-8' as gate, count(*)::int as violations, 'structural' as scope,
       'lot counters negative or over qty' as detail
  from public.credit_lots l
 where l.consumed < 0 or l.refunded < 0 or l.refund_reserved < 0
    or l.consumed + l.refunded + l.refund_reserved > l.qty;

-- G-9: attempt↔lot / gen↔lot cross-user·cross-order 0(Q10 동치).
select 'G-9' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'attempt/gen references lot of other user or order' as detail
  from (
    select a.id from public.order_refund_attempts a join public.credit_lots l on l.id = a.credit_lot_id
     where l.user_id <> a.user_id or l.order_uuid is distinct from a.order_uuid
    union all
    select g.id from public.ai_generations g join public.credit_lots l on l.id = g.credit_lot_id
     where l.user_id <> g.owner_id) q;

-- G-10: 중복 원장 0 — attempt 계열(reserve/commit/release/policy_close 각 1) + gen v2 각 1.
select 'G-10' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'duplicate attempt-series / gen-v2 ledger rows' as detail
  from (
    select 1 from public.credit_ledger
     where ref_attempt_id is not null
       and event_type in ('refund_reserve','refund_commit','refund_release','refund_policy_close')
     group by ref_attempt_id, event_type having count(*) > 1
    union all
    select 1 from public.credit_ledger
     where ref_gen_id is not null and ref_attempt_id is null and schema_version = 2
     group by ref_gen_id, event_type having count(*) > 1) q;

-- G-11: legacy 백필 증빙 정합 — order 당 1행·manifest_hash 단일·legacy order 에 live event 0.
select 'G-11' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'legacy evidence dup / hash split / live event overlap' as detail
  from (
    select 1 from public.legacy_refund_backfill_evidence group by order_uuid having count(*) > 1
    union all
    select 1 from (select count(distinct manifest_hash) c from public.legacy_refund_backfill_evidence) h
      where h.c > 1
    union all
    select 1 from public.payment_cancellation_events ev
     where ev.origin = 'live'
       and exists (select 1 from public.legacy_refund_backfill_evidence e where e.order_uuid = ev.order_uuid)) q;

-- G-12: shortfall 분해 정합 — recovered+remaining=initial·initial<=mapped·state/resolved 커플링(구조).
select 'G-12' as gate, count(*)::int as violations, 'structural' as scope,
       'shortfall qty decomposition / state coupling mismatch' as detail
  from public.credit_refund_shortfalls s
 where s.recovered_qty + s.remaining_shortfall_qty <> s.initial_shortfall_qty
    or s.initial_shortfall_qty > s.mapped_qty
    or (s.state = 'resolved') <> (s.remaining_shortfall_qty = 0)
    or (s.state = 'resolved') <> (s.resolved_at is not null);

-- G-13: resolved 매핑 ↔ shortfall 장부 대사(§14·Q17 s7·s8 — malformed-safe).
--        resolved 이벤트 매핑의 lot 은 그 order 의 purchase 로트여야 하고, shortfall_qty>0 매핑엔 external_cancellation
--        shortfall 행 정확 1개, =0 매핑엔 0개. shortfall 행은 반드시 매핑(shortfall_qty>0)에 근거해야 함.
with ev as (
  select cancellation_id, order_uuid, resolved_lot_mappings
    from public.payment_cancellation_events
   where resolution_state = 'resolved' and jsonb_typeof(resolved_lot_mappings) = 'array'
),
raw_mp as (
  select ev.cancellation_id, ev.order_uuid, m.elem
    from ev cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) as m(elem)
),
mp_obj as (   -- 형식 검증(jsonb_typeof·regex 만 — cast 없음)만 통과한 원소
  select cancellation_id, order_uuid, elem
    from raw_mp
   where jsonb_typeof(elem) = 'object'
     and jsonb_typeof(elem->'lot_id') = 'string'
     and (elem->>'lot_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and jsonb_typeof(elem->'mapped_qty') = 'number'
     and jsonb_typeof(elem->'shortfall_qty') = 'number'
),
mp as (   -- 형식 검증 후에만 cast(§26 safe-stage) — numeric 은 overflow 없음
  select cancellation_id, order_uuid,
         (elem->>'lot_id') as lot_id,
         (elem->>'mapped_qty')::numeric as mq,
         (elem->>'shortfall_qty')::numeric as sq
    from mp_obj
),
viol as (
  -- s7: 매핑 lot 이 해당 order 의 purchase 로트가 아님
  select 1 from mp
   where not exists (select 1 from public.credit_lots l
                      where l.id = mp.lot_id::uuid and l.order_uuid = mp.order_uuid and l.source = 'purchase')
  union all
  -- s8a: shortfall_qty>0 매핑에 external_cancellation shortfall 행이 정확히 1 이 아님
  select 1 from mp
   where mp.sq > 0
     and (select count(*) from public.credit_refund_shortfalls s
           where s.source_cancellation_id = mp.cancellation_id and s.lot_id = mp.lot_id::uuid
             and s.source_type = 'external_cancellation'
             and s.mapped_qty = mp.mq and s.initial_shortfall_qty = mp.sq) <> 1
  union all
  -- s8b: shortfall_qty=0 매핑인데 shortfall 행이 존재
  select 1 from mp
   where mp.sq = 0
     and exists (select 1 from public.credit_refund_shortfalls s
                  where s.source_cancellation_id = mp.cancellation_id and s.lot_id = mp.lot_id::uuid)
  union all
  -- s8c(orphan): external_cancellation shortfall 행이 근거 매핑(shortfall_qty>0) 없이 존재
  select 1 from public.credit_refund_shortfalls s
   where s.source_type = 'external_cancellation'
     and not exists (select 1 from mp
                      where mp.cancellation_id = s.source_cancellation_id
                        and mp.lot_id::uuid = s.lot_id and mp.sq > 0)
)
select 'G-13' as gate, (select count(*) from viol)::int as violations, 'normal+cutover' as scope,
       'resolved mapping <-> shortfall ledger reconciliation mismatch' as detail;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 그룹 2. 상태·커플링 구조 불변식
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- G-14: refund_requests approved_* 커플링 — building⇔approved null / 그 외⇔approved not null.
select 'G-14' as gate, count(*)::int as violations, 'structural' as scope,
       'refund_requests approved coupling violated' as detail
  from public.refund_requests r
 where (r.state = 'building') <> (r.approved_plan_hash is null and r.approved_amount is null)
    or (r.approved_plan_hash is null) <> (r.approved_plan_hash_version is null);

-- G-15: attempt PG 단계 필드 존재 매트릭스(§7) — prepared=pg 필드 전부 null / pg_* 이후=필수 5+3 필드 non-null.
select 'G-15' as gate, count(*)::int as violations, 'structural' as scope,
       'attempt pg-phase field presence matrix violated' as detail
  from public.order_refund_attempts a
 where ( a.state = 'prepared'
         and (a.pg_requested_at is not null or a.pg_request_body is not null or a.pg_idempotency_key is not null
              or a.pg_total_before is not null or a.pg_preflight_at is not null) )
    or ( a.state in ('pg_requested','pg_pending','pg_succeeded')
         and (a.pg_requested_at is null or a.pg_request_body is null or a.pg_idempotency_key is null
              or a.pg_total_before is null or a.pg_cancelled_before is null or a.pg_cancellable_before is null
              or a.pg_cancellation_ids_before is null or a.pg_preflight_at is null) )
    or ( a.state = 'pg_succeeded'
         and (a.pg_cancel_id is null or a.pg_cancel_status is distinct from 'SUCCEEDED') );

-- G-16: cancellation event 커플링 매트릭스(§6) — matched/resolved/ignored/unmatched 필드 존재·actor·status.
select 'G-16' as gate, count(*)::int as violations, 'structural' as scope,
       'cancellation event coupling matrix violated' as detail
  from public.payment_cancellation_events ev
 where (ev.resolution_state = 'matched') <> (ev.matched_attempt_id is not null)
    or (ev.resolution_state in ('resolved','ignored')) <> (ev.resolved_at is not null and ev.resolution_source is not null)
    or (ev.resolution_state = 'resolved') <> (ev.resolved_economic_qty is not null)
    or (ev.resolution_state = 'resolved') <> (ev.resolved_lot_mappings is not null)
    or not ( (ev.resolution_source is null and ev.resolved_by is null)
             or (ev.resolution_source = 'admin' and ev.resolved_by is not null)
             or (ev.resolution_source = 'system' and ev.resolved_by is null) )
    or not ( ev.resolution_state = 'unmatched'
             or (ev.resolution_state in ('matched','resolved') and ev.status = 'SUCCEEDED')
             or (ev.resolution_state = 'ignored' and ev.status = 'FAILED') );

-- G-17: reconciliation_issues 커플링 — open⇔미해결 null / resolved·ignored⇔resolved_at+source·actor.
select 'G-17' as gate, count(*)::int as violations, 'structural' as scope,
       'reconciliation_issues state/actor coupling violated' as detail
  from public.reconciliation_issues i
 where not ( (i.state = 'open' and i.resolved_at is null and i.resolved_by is null and i.resolution_source is null)
          or (i.state in ('resolved','ignored') and i.resolved_at is not null and i.resolution_source is not null) )
    or not ( (i.resolution_source is null and i.resolved_by is null)
          or (i.resolution_source = 'admin' and i.resolved_by is not null)
          or (i.resolution_source = 'system' and i.resolved_by is null) );

-- G-18: ai_generations 크레딧 귀속 커플링(§19·§40) — lot⇔consumed·refund⇒consume·refund 시간순·refund⇒failed.
--   (credit_ledger v2 ref-shape 배타는 G-35 이 담당 — 여기선 생성 귀속 불변식만.)
select 'G-18' as gate, count(*)::int as violations, 'structural' as scope,
       'ai_generations credit attribution coupling violated' as detail
  from public.ai_generations g
 where (g.credit_lot_id is null) <> (g.consumed_at is null)
    or (g.refunded_at is not null and g.consumed_at is null)
    or (g.refunded_at is not null and g.refunded_at < g.consumed_at)
    or (g.refunded_at is not null and g.status <> 'failed');

-- G-19: credit_ledger delta 부호(§13) — event_type 별 부호 규약(v2 한정).
select 'G-19' as gate, count(*)::int as violations, 'structural' as scope,
       'credit_ledger delta sign violated' as detail
  from public.credit_ledger cl
 where cl.schema_version = 2
   and ( (cl.event_type = 'refund_reserve' and cl.delta > 0)
      or (cl.event_type = 'refund_release' and cl.delta < 0)
      or (cl.event_type = 'refund_commit' and cl.ref_attempt_id is not null and cl.delta <> 0)
      or (cl.event_type = 'refund_commit' and cl.ref_cancellation_id is not null and cl.delta > 0)
      or (cl.event_type = 'refund_policy_close' and cl.delta > 0)
      or (cl.event_type = 'expire' and cl.delta > 0)
      or (cl.event_type = 'purchase' and cl.delta < 0)
      or (cl.event_type = 'gen_consume' and cl.delta > 0)
      or (cl.event_type = 'gen_refund' and cl.delta < 0) );

-- G-20: hard-delete 차단 FK(§20) — profiles hard-delete 를 막는 앵커 FK 는 confdeltype='r'(RESTRICT).
--        orders.user_id(0030)·credit_lots.user_id(0062)는 금융 이력 보유 사용자의 hard-delete 를 직접 차단.
--        (member_accounts.user_id·ai_generations.owner_id 의 cascade→restrict 전환은 본 3파일 범위 밖.)
select 'G-20' as gate, 2 - count(*)::int as violations, 'structural' as scope,
       'financial anchor FK not ON DELETE RESTRICT (confdeltype<>r)' as detail
  from pg_constraint c
 where c.contype = 'f' and c.confdeltype = 'r'
   and ( (c.conrelid = 'public.orders'::regclass
          and c.confrelid = 'public.profiles'::regclass
          and c.conkey = (select array_agg(attnum order by attnum) from pg_attribute
                           where attrelid = 'public.orders'::regclass and attname = 'user_id'))
      or (c.conrelid = 'public.credit_lots'::regclass
          and c.confrelid = 'public.profiles'::regclass
          and c.conkey = (select array_agg(attnum order by attnum) from pg_attribute
                           where attrelid = 'public.credit_lots'::regclass and attname = 'user_id')) );

-- G-21: orders 금융 필드 범위·정합 — refunded 범위·receipt https·canceled-paid 전액종결.
select 'G-21' as gate, count(*)::int as violations, 'structural' as scope,
       'orders financial ranges / receipt / canceled-paid closure violated' as detail
  from public.orders o
 where o.refunded_credits < 0 or o.refunded_credits > o.credits
    or o.refunded_amount < 0 or o.refunded_amount > o.amount
    or (o.receipt_url is not null and (o.receipt_url !~ '^https://' or octet_length(o.receipt_url) > 2048))
    or (o.status = 'canceled' and o.paid_at is not null
        and (o.refunded_amount <> o.amount or o.refunded_credits <> o.credits));

-- G-22: attempt 무이동 확정 증빙 커플링(§7) — reconciliation 7필드 all-or-none.
select 'G-22' as gate, count(*)::int as violations, 'structural' as scope,
       'attempt reconciliation evidence coupling violated' as detail
  from public.order_refund_attempts a
 where not (
     (a.reconciliation_verified_at is null and a.reconciliation_result is null
      and a.observed_cancelled_amount is null and a.observed_cancellation_ids is null
      and a.verification_source is null and a.verified_by is null and a.evidence_hash is null)
  or (a.reconciliation_verified_at is not null and a.reconciliation_result is not null
      and a.observed_cancelled_amount is not null and a.observed_cancellation_ids is not null
      and a.verification_source is not null and a.evidence_hash is not null
      and (a.verified_by is not null or a.verification_source = 'pg_failed_response')) );

-- G-23: manual 확정 커플링(§7) — committed+manual_transfer ⇒ 5필드 존재·manual_commit_hash⇒manual rail.
select 'G-23' as gate, count(*)::int as violations, 'structural' as scope,
       'manual commit 5-field / rail coupling violated' as detail
  from public.order_refund_attempts a
 where (a.state = 'committed' and a.rail = 'manual_transfer'
        and (a.external_payout_ref is null or a.paid_out_at is null or a.payout_evidence is null
             or a.manual_commit_payload_hash is null or a.manual_commit_reason is null))
    or (a.manual_commit_payload_hash is not null and a.rail <> 'manual_transfer')
    or ((a.manual_commit_payload_hash is null) <> (a.manual_commit_reason is null));

-- G-24: external_payout_ref 형식·유일성(§2.1·§11).
select 'G-24' as gate, count(*)::int as violations, 'structural' as scope,
       'external_payout_ref bad format or duplicate' as detail
  from (
    select 1 from public.order_refund_attempts
     where external_payout_ref is not null and external_payout_ref !~ '^[A-Za-z0-9._:-]{1,128}$'
    union all
    select 1 from public.order_refund_attempts
     where external_payout_ref is not null
     group by external_payout_ref having count(*) > 1) q;

-- G-25: payout_evidence 정확 형태(§11) — {method:'bank_transfer', evidence_object_id:'<uuid>'} 만·PII 없음(malformed-safe).
select 'G-25' as gate, count(*)::int as violations, 'structural' as scope,
       'payout_evidence shape/PII violation' as detail
  from public.order_refund_attempts a
 where a.payout_evidence is not null
   and not ( jsonb_typeof(a.payout_evidence) = 'object'
             and a.payout_evidence ? 'method' and a.payout_evidence->>'method' = 'bank_transfer'
             and a.payout_evidence ? 'evidence_object_id'
             and jsonb_typeof(a.payout_evidence->'evidence_object_id') = 'string'
             and (a.payout_evidence->>'evidence_object_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             and (a.payout_evidence - array['method','evidence_object_id']) = '{}'::jsonb
             and not public.jsonb_has_sensitive_key(a.payout_evidence) );

-- G-26: PG preflight 5필드 all-or-none·범위·ids array(§7).
select 'G-26' as gate, count(*)::int as violations, 'structural' as scope,
       'attempt pg preflight coupling/range/type violated' as detail
  from public.order_refund_attempts a
 where not ( (a.pg_total_before is null and a.pg_cancelled_before is null and a.pg_cancellable_before is null
              and a.pg_cancellation_ids_before is null and a.pg_preflight_at is null)
          or (a.pg_total_before is not null and a.pg_cancelled_before is not null and a.pg_cancellable_before is not null
              and a.pg_cancellation_ids_before is not null and a.pg_preflight_at is not null) )
    or (a.pg_total_before is not null
        and (a.pg_total_before < 0 or a.pg_cancelled_before < 0 or a.pg_cancellable_before < 0
             or a.pg_cancelled_before + a.pg_cancellable_before > a.pg_total_before))
    or (a.pg_cancellation_ids_before is not null and jsonb_typeof(a.pg_cancellation_ids_before) <> 'array');

-- G-27: cancellation_resolution_batches 구조(§14) — projection array·크기·eligibility_hash 형식.
select 'G-27' as gate, count(*)::int as violations, 'structural' as scope,
       'resolution batch projection/eligibility structure violated' as detail
  from public.cancellation_resolution_batches b
 where jsonb_typeof(b.cancellation_projection) <> 'array'
    or octet_length(b.cancellation_projection::text) > 32768
    or b.eligibility_hash !~ '^[0-9a-f]{64}$'
    or b.eligibility_result not in ('eligible','ineligible');

-- G-28: 신규 ref 컬럼(ref_attempt_id/ref_cancellation_id/ref_lot_id)을 채운 원장은 schema_version=2(§13 — v1 미오염).
select 'G-28' as gate, count(*)::int as violations, 'structural' as scope,
       'v1 credit_ledger row references new refund refs' as detail
  from public.credit_ledger cl
 where cl.schema_version <> 2
   and (cl.ref_attempt_id is not null or cl.ref_cancellation_id is not null or cl.ref_lot_id is not null
        or cl.metadata is not null);

-- G-29 (=Q12): 금융 테이블 CHECK 에 now()/clock_timestamp/current_timestamp/localtimestamp 잔존 0(§28).
select 'G-29' as gate, count(*)::int as violations, 'structural' as scope,
       'time-based CHECK constraint present in financial table' as detail
  from pg_constraint c
 where c.contype = 'c'
   and c.conrelid in ('public.credit_lots'::regclass, 'public.refund_requests'::regclass,
                      'public.order_refund_attempts'::regclass, 'public.payment_cancellation_events'::regclass,
                      'public.reconciliation_issues'::regclass, 'public.credit_refund_shortfalls'::regclass,
                      'public.legacy_refund_backfill_evidence'::regclass,
                      'public.cancellation_resolution_batches'::regclass,
                      'public.credit_ledger'::regclass, 'public.admin_actions_ledger'::regclass,
                      'public.orders'::regclass, 'public.ai_generations'::regclass)
   and pg_get_constraintdef(c.oid) ~* '(now\(\)|clock_timestamp|current_timestamp|localtimestamp)';

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 그룹 3. G-30 ~ G-48 (rev16 §16.1 + directive §33)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- G-30: refund_requests.state = derive_refund_request_state(id) 완전 일치(§4.10).
select 'G-30' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'refund_requests.state <> derived state' as detail
  from public.refund_requests r
 where r.state <> public.derive_refund_request_state(r.id);

-- G-31: 함수 ACL/owner/definer/search_path manifest(§16·§33). VALUES manifest — to_regprocedure·prosecdef·
--        proconfig(search_path='')·proowner(=orders 소유자)·PUBLIC(grantee oid 0)/anon/auth/service_role EXECUTE.
--        external=definer+owner+search_path+service_role EXECUTE 有+PUBLIC/anon/auth 無 / internal=EXECUTE 全無 /
--        미예상 overload(관리 이름의 non-manifest 시그니처, legacy stub 제외) 0.
with manifest(sig, kind) as (values
  -- ── external RPC (service_role EXECUTE only · SECURITY DEFINER · search_path='' · owner=table owner) ──
  ('public.create_pending_order(uuid,uuid,text,int,int,text,text,text,boolean)','external'),
  ('public.mark_paid_and_grant(uuid,text,int,jsonb,timestamptz,text)','external'),
  ('public.create_generation_and_consume(uuid,text)','external'),
  ('public.mark_generation_failed_and_refund(uuid,text,int)','external'),
  ('public.admin_refund_begin(uuid,uuid,uuid,uuid,int,text,timestamptz,text)','external'),
  ('public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)','external'),
  ('public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)','external'),
  ('public.admin_refund_commit(uuid)','external'),
  ('public.admin_refund_switch_to_manual(uuid,uuid,text,bigint,jsonb,text)','external'),
  ('public.admin_refund_commit_manual(uuid,uuid,text,text,uuid)','external'),
  ('public.admin_refund_release(uuid,uuid,text)','external'),
  ('public.admin_refund_replan_pre_pg(uuid,uuid,text,boolean)','external'),
  ('public.admin_refund_replan_after_pg(uuid,uuid,text,bigint,jsonb)','external'),
  ('public.cancel_intent_begin(uuid,uuid,timestamptz,text)','external'),
  ('public.cancel_intent_resolve(uuid,uuid,int)','external'),
  ('public.resolve_external_cancellation(text,uuid,text,int)','external'),
  ('public.resolve_external_cancellation_auto_full(uuid)','external'),
  ('public.admin_resolve_reconciliation_issue(uuid,uuid,text,text)','external'),
  ('public.admin_adjust_credits(uuid,uuid,int,text)','external'),
  ('public.admin_cancel_order(uuid,uuid,boolean,text,boolean)','external'),
  ('public.admin_cancel_order(uuid,uuid,boolean,text)','external'),
  ('public.admin_soft_delete_account(uuid)','external'),
  ('public.sweep_expired(int)','external'),
  ('public.ops_cron_heartbeat(text,text,text)','external'),
  ('public.get_my_credits(uuid)','external'),
  ('public.get_admin_order_summary()','external'),
  ('public.admin_settle_stuck_order(uuid,uuid,text)','external'),
  ('public.create_or_update_member_consent(uuid,int,boolean,boolean,int,boolean,int)','external'),
  ('public.record_payment_cancellation_observation(uuid,text,text,bigint,timestamptz,timestamptz,jsonb)','external'),
  ('public.mark_order_failed(uuid,text,text,jsonb)','external'),
  ('public.mark_order_canceled_unpaid(uuid,text,text,jsonb)','external'),
  ('public.create_generation_row(uuid,text)','external'),
  -- ── internal core/helper/trigger (EXECUTE 全無) ──
  ('public.bp_sha256_hex(text)','internal'),
  ('public.bp_canonical_json(jsonb)','internal'),
  ('public.bp_versioned_hash(jsonb,int)','internal'),
  ('public.jsonb_has_sensitive_key(jsonb)','internal'),
  ('public.ledger_append_only_guard()','internal'),
  ('public.credit_lots_guard()','internal'),
  ('public.bp_forbid_delete()','internal'),
  ('public.refund_requests_guard()','internal'),
  ('public.derive_refund_request_state(uuid)','internal'),
  ('public.enforce_request_state_derive()','internal'),
  ('public.refund_attempts_lifecycle()','internal'),
  ('public.refund_attempts_transition()','internal'),
  ('public.crb_guard()','internal'),
  ('public.cancellation_events_guard()','internal'),
  ('public.recon_issues_guard()','internal'),
  ('public.shortfalls_guard()','internal'),
  ('public.legacy_evidence_freeze()','internal'),
  ('public.credit_ledger_insert_guard()','internal'),
  ('public.admin_ledger_insert_guard()','internal'),
  ('public.orders_insert_guard()','internal'),
  ('public.orders_financial_guard()','internal'),
  ('public.bp_refund_rate_bps(timestamptz,timestamptz)','internal'),
  ('public.bp_refund_amount(bigint,int,int,int,bigint)','internal'),
  ('public.bp_credit_ledger_write(uuid,int,text,uuid,text,uuid,uuid,uuid,jsonb,text)','internal'),
  ('public.consume_gen_credit_v2(uuid,uuid)','internal'),
  ('public.refund_gen_credit_v2(uuid,int)','internal'),
  ('public.bp_apply_attempt_commit(uuid,uuid,text,jsonb)','internal'),
  ('public.bp_apply_attempt_release(uuid,uuid,text,text,boolean)','internal'),
  ('public.bp_apply_external_resolution(text,uuid,int,uuid)','internal')
),
props as (
  select m.sig, m.kind, to_regprocedure(m.sig) as prooid,
         p.prosecdef, p.proconfig, p.proowner, p.proacl
    from manifest m
    left join pg_proc p on p.oid = to_regprocedure(m.sig)
),
owner_ref as (select relowner as own from pg_class where oid = 'public.orders'::regclass),
managed_oids as (select prooid::oid as oid from props where prooid is not null),
legacy_oids as (
  select o::oid as oid from (values
    (to_regprocedure('public.mark_paid_and_grant(uuid,text,int,jsonb)')),
    (to_regprocedure('public.consume_gen_credit(uuid)')),
    (to_regprocedure('public.refund_gen_credit(uuid)'))) v(o)
   where o is not null
),
viol as (
  -- (a) manifest 함수 부재
  select sig, 'missing' as why from props where prooid is null
  union all
  -- (b) external: not SECURITY DEFINER
  select sig, 'not_definer' from props where kind = 'external' and prooid is not null and prosecdef is not true
  union all
  -- (c) external: search_path='' 아님 (PG 저장 표기 2형 허용 — 'search_path=' / 'search_path=""')
  select sig, 'bad_search_path' from props
   where kind = 'external' and prooid is not null
     and not (coalesce(proconfig, array[]::text[]) && array['search_path=', 'search_path=""'])
  union all
  -- (d) external: owner <> orders 소유자
  select p.sig, 'owner_mismatch' from props p, owner_ref o
   where p.kind = 'external' and p.prooid is not null and p.proowner <> o.own
  union all
  -- (e) external: service_role EXECUTE 없음
  select sig, 'no_service_execute' from props
   where kind = 'external' and prooid is not null
     and not exists (select 1 from aclexplode(proacl) a join pg_roles rr on rr.oid = a.grantee
                     where rr.rolname = 'service_role' and a.privilege_type = 'EXECUTE')
  union all
  -- (f) external: PUBLIC(grantee 0)/anon/authenticated EXECUTE 누출(proacl null=PUBLIC 기본 실행 포함)
  select sig, 'external_execute_leak' from props
   where kind = 'external' and prooid is not null
     and ( proacl is null
        or exists (select 1 from aclexplode(proacl) a left join pg_roles rr on rr.oid = a.grantee
                   where a.privilege_type = 'EXECUTE'
                     and (a.grantee = 0 or rr.rolname in ('anon','authenticated'))) )
  union all
  -- (g) internal: EXECUTE grant 존재(service_role/anon/authenticated/PUBLIC). proacl null=PUBLIC 실행=누출.
  select sig, 'internal_execute_leak' from props
   where kind = 'internal' and prooid is not null
     and ( proacl is null
        or exists (select 1 from aclexplode(proacl) a left join pg_roles rr on rr.oid = a.grantee
                   where a.privilege_type = 'EXECUTE'
                     and (a.grantee = 0 or rr.rolname in ('service_role','anon','authenticated'))) )
  union all
  -- (h) 미예상 overload: 관리 이름의 pg_proc 중 manifest·legacy stub 이 아닌 시그니처
  select (p.oid::regprocedure)::text, 'unexpected_overload'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_pending_order','mark_paid_and_grant','create_generation_and_consume',
       'mark_generation_failed_and_refund','admin_refund_begin','admin_refund_mark_pg_requested',
       'admin_refund_record_pg_result','admin_refund_commit','admin_refund_switch_to_manual',
       'admin_refund_commit_manual','admin_refund_release','admin_refund_replan_pre_pg',
       'admin_refund_replan_after_pg','cancel_intent_begin','cancel_intent_resolve',
       'resolve_external_cancellation','resolve_external_cancellation_auto_full',
       'admin_resolve_reconciliation_issue','admin_adjust_credits','admin_cancel_order',
       'admin_soft_delete_account','sweep_expired','ops_cron_heartbeat','get_my_credits',
       'get_admin_order_summary','admin_settle_stuck_order','consume_gen_credit','refund_gen_credit',
       'consume_gen_credit_v2','refund_gen_credit_v2','bp_credit_ledger_write','bp_apply_attempt_commit',
       'bp_apply_attempt_release','bp_apply_external_resolution',
       'create_or_update_member_consent','record_payment_cancellation_observation',
       'mark_order_failed','mark_order_canceled_unpaid','create_generation_row')
     and p.oid not in (select oid from managed_oids)
     and p.oid not in (select oid from legacy_oids)
)
select 'G-31' as gate, (select count(*) from viol)::int as violations, 'cutover/normal' as scope,
       'function ACL/owner/definer/search_path manifest violation' as detail;

-- G-32: 금융 테이블 RLS enabled + policy 0(§33) — 정책 없이 default deny, service_role SELECT grant 로만 접근.
select 'G-32' as gate, count(*)::int as violations, 'structural' as scope,
       'financial table RLS disabled or has policy' as detail
  from (values ('credit_lots'),('refund_requests'),('order_refund_attempts'),
               ('payment_cancellation_events'),('reconciliation_issues'),('credit_refund_shortfalls'),
               ('legacy_refund_backfill_evidence'),('cancellation_resolution_batches'),
               ('ops_cron_heartbeats'),('schema_migration_journal'),
               ('credit_ledger'),('admin_actions_ledger')) t(tbl)
  join pg_class c on c.oid = ('public.' || t.tbl)::regclass
 where c.relrowsecurity = false
    or (select count(*) from pg_policy p where p.polrelid = c.oid) > 0;

-- G-33: 복합 소유권 정합(§33) — 신규 테이블 간 (user_id·order_uuid) 및 관리자·target 소유권 mismatch 0.
select 'G-33' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'composite ownership mismatch across refund tables' as detail
  from (
    -- attempt ↔ request
    select a.id from public.order_refund_attempts a join public.refund_requests r on r.id = a.request_id
     where r.user_id <> a.user_id or r.admin_user_id <> a.admin_user_id
    union all
    -- attempt ↔ order
    select a.id from public.order_refund_attempts a join public.orders o on o.order_uuid = a.order_uuid
     where o.user_id <> a.user_id
    union all
    -- shortfall ↔ lot(order 일치)
    select s.id from public.credit_refund_shortfalls s join public.credit_lots l on l.id = s.lot_id
     where l.order_uuid is distinct from s.order_uuid
    union all
    -- matched event ↔ attempt(order·amount·pg_cancel_id)
    select null::uuid from public.payment_cancellation_events ev
      join public.order_refund_attempts a on a.id = ev.matched_attempt_id
     where a.order_uuid <> ev.order_uuid or a.amount <> ev.amount
        or a.pg_cancel_id is distinct from ev.cancellation_id
    union all
    -- admin_actions_ledger ref_attempt ↔ order·target
    select null::uuid from public.admin_actions_ledger al join public.order_refund_attempts a on a.id = al.ref_attempt_id
     where a.order_uuid is distinct from al.order_uuid or a.user_id is distinct from al.target_user_id
    union all
    -- admin_actions_ledger ref_cancellation ↔ order
    select null::uuid from public.admin_actions_ledger al
      join public.payment_cancellation_events ev on ev.cancellation_id = al.ref_cancellation_id
     where ev.order_uuid is distinct from al.order_uuid) q;

-- G-34: resolved 매핑 자체 구조/합계(§33 — malformed-safe). array·object·5키+타입·uuid·int4 범위·값 불변식·lot 중복·qty 합.
with ev as (
  select cancellation_id, resolved_economic_qty, resolved_lot_mappings
    from public.payment_cancellation_events where resolution_state = 'resolved'
),
malformed as (
  -- resolved 인데 mappings 가 array 가 아님
  select cancellation_id from ev where jsonb_typeof(resolved_lot_mappings) <> 'array'
),
mp as (
  select ev.cancellation_id, ev.resolved_economic_qty, m.elem
    from ev cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) as m(elem)
   where jsonb_typeof(ev.resolved_lot_mappings) = 'array'
),
bad_elem as (
  select cancellation_id from mp
   where jsonb_typeof(elem) <> 'object'
      or (select count(*) from jsonb_object_keys(elem)) <> 5
      or not (elem ?& array['lot_id','mapped_qty','immediate_recovered_qty','shortfall_qty','lot_was_live'])
      or jsonb_typeof(elem->'lot_id') <> 'string'
      or jsonb_typeof(elem->'mapped_qty') <> 'number'
      or jsonb_typeof(elem->'immediate_recovered_qty') <> 'number'
      or jsonb_typeof(elem->'shortfall_qty') <> 'number'
      or jsonb_typeof(elem->'lot_was_live') <> 'boolean'
      or (elem->>'lot_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
typed as (   -- 숫자 형식이 검증된 원소만 값 불변식 평가(§26 safe-stage)
  select mp.cancellation_id,
         (elem->>'mapped_qty')::numeric mq, (elem->>'immediate_recovered_qty')::numeric irq,
         (elem->>'shortfall_qty')::numeric sq, elem->>'lot_id' lot_id
    from mp
   where jsonb_typeof(elem->'mapped_qty') = 'number' and jsonb_typeof(elem->'immediate_recovered_qty') = 'number'
     and jsonb_typeof(elem->'shortfall_qty') = 'number'
),
bad_value as (
  select cancellation_id from typed
   where mq <> trunc(mq) or mq < 1 or mq > 2147483647
      or irq <> trunc(irq) or irq < 0 or irq > 2147483647
      or sq <> trunc(sq) or sq < 0 or sq > 2147483647
      or mq <> irq + sq
),
dup_lot as (
  select cancellation_id from mp group by cancellation_id, elem->>'lot_id' having count(*) > 1
),
bad_sum as (   -- resolved_economic_qty = Σ mapped_qty (형식 정상 원소만 numeric 집계 비교 — cast overflow 없음)
  select e.cancellation_id
    from ev e
   where e.cancellation_id not in (select cancellation_id from malformed)
     and e.resolved_economic_qty <> coalesce((
           select sum(t.mq) from typed t where t.cancellation_id = e.cancellation_id), 0)
),
allv as (
  select cancellation_id from malformed union all select cancellation_id from bad_elem
  union all select cancellation_id from bad_value union all select cancellation_id from dup_lot
  union all select cancellation_id from bad_sum
)
select 'G-34' as gate, (select count(distinct cancellation_id) from allv)::int as violations, 'structural' as scope,
       'resolved lot mappings structure/sum invalid' as detail;

-- G-35: credit_ledger ref/delta/cache-effect metadata 등식(§33 — malformed-safe two-CTE).
--        refund_policy_close(closure=recovered+shortfall 상한·cache_effect·delta) + 외부취소형 refund_commit.
with pc as (   -- policy_close
  select id, delta, metadata from public.credit_ledger where event_type = 'refund_policy_close'
),
pc_typed as (   -- 키·타입 형식 검증만(cast 없음)
  select id, delta, metadata from pc
   where jsonb_typeof(metadata) = 'object'
     and (select count(*) from jsonb_object_keys(metadata)) = 7
     and metadata ?& array['closure_qty','recovered_qty','shortfall_qty','lot_was_live','cache_effect_qty','rate_bps','refunded_amount_total']
     and jsonb_typeof(metadata->'closure_qty') = 'number' and jsonb_typeof(metadata->'recovered_qty') = 'number'
     and jsonb_typeof(metadata->'shortfall_qty') = 'number' and jsonb_typeof(metadata->'cache_effect_qty') = 'number'
     and jsonb_typeof(metadata->'lot_was_live') = 'boolean'
),
pc_valid as (   -- 형식 확정 후에만 numeric 정수성·범위 cast(§26 safe-stage)
  select id, delta, metadata from pc_typed
   where (metadata->>'closure_qty')::numeric = trunc((metadata->>'closure_qty')::numeric)
     and (metadata->>'recovered_qty')::numeric = trunc((metadata->>'recovered_qty')::numeric)
     and (metadata->>'shortfall_qty')::numeric = trunc((metadata->>'shortfall_qty')::numeric)
     and (metadata->>'cache_effect_qty')::numeric = trunc((metadata->>'cache_effect_qty')::numeric)
     and (metadata->>'closure_qty')::numeric between 0 and 2147483647
     and (metadata->>'recovered_qty')::numeric between 0 and 2147483647
     and (metadata->>'shortfall_qty')::numeric between 0 and 2147483647
     and (metadata->>'cache_effect_qty')::numeric between 0 and 2147483647
),
cc as (   -- 외부취소형 refund_commit
  select id, delta, metadata from public.credit_ledger
   where event_type = 'refund_commit' and ref_cancellation_id is not null
),
cc_typed as (
  select id, delta, metadata from cc
   where jsonb_typeof(metadata) = 'object'
     and (select count(*) from jsonb_object_keys(metadata)) = 4
     and metadata ?& array['mapped_qty','immediate_recovered_qty','shortfall_qty','live_recovered_qty']
     and jsonb_typeof(metadata->'mapped_qty') = 'number' and jsonb_typeof(metadata->'immediate_recovered_qty') = 'number'
     and jsonb_typeof(metadata->'shortfall_qty') = 'number' and jsonb_typeof(metadata->'live_recovered_qty') = 'number'
),
cc_valid as (
  select id, delta, metadata from cc_typed
   where (metadata->>'mapped_qty')::numeric = trunc((metadata->>'mapped_qty')::numeric)
     and (metadata->>'immediate_recovered_qty')::numeric = trunc((metadata->>'immediate_recovered_qty')::numeric)
     and (metadata->>'shortfall_qty')::numeric = trunc((metadata->>'shortfall_qty')::numeric)
     and (metadata->>'live_recovered_qty')::numeric = trunc((metadata->>'live_recovered_qty')::numeric)
     and (metadata->>'mapped_qty')::numeric between 0 and 2147483647
     and (metadata->>'immediate_recovered_qty')::numeric between 0 and 2147483647
     and (metadata->>'shortfall_qty')::numeric between 0 and 2147483647
     and (metadata->>'live_recovered_qty')::numeric between 0 and 2147483647
),
ref_shape as (   -- §33: refund_commit=(attempt XOR cancellation)·나머지 ref null 정확(event_type 별 배타)
  select 1 from public.credit_ledger cl
   where cl.schema_version = 2
     and not (
       case cl.event_type
         when 'refund_reserve' then cl.ref_attempt_id is not null and cl.ref_cancellation_id is null
              and cl.ref_lot_id is null and cl.ref_gen_id is null and cl.ref_order_uuid is null
         when 'refund_release' then cl.ref_attempt_id is not null and cl.ref_cancellation_id is null
              and cl.ref_lot_id is null and cl.ref_gen_id is null and cl.ref_order_uuid is null
         when 'refund_policy_close' then cl.ref_attempt_id is not null and cl.ref_cancellation_id is null
              and cl.ref_lot_id is null and cl.ref_gen_id is null and cl.ref_order_uuid is null
         when 'refund_commit' then (cl.ref_attempt_id is not null) <> (cl.ref_cancellation_id is not null)
              and cl.ref_lot_id is null and cl.ref_gen_id is null and cl.ref_order_uuid is null
         when 'expire' then cl.ref_lot_id is not null and cl.ref_attempt_id is null and cl.ref_cancellation_id is null
              and cl.ref_gen_id is null and cl.ref_order_uuid is null
         when 'gen_consume' then cl.ref_gen_id is not null and cl.ref_attempt_id is null and cl.ref_cancellation_id is null
              and cl.ref_lot_id is null and cl.ref_order_uuid is null
         when 'gen_refund' then cl.ref_gen_id is not null and cl.ref_attempt_id is null and cl.ref_cancellation_id is null
              and cl.ref_lot_id is null and cl.ref_order_uuid is null
         when 'purchase' then cl.ref_order_uuid is not null and cl.ref_attempt_id is null and cl.ref_cancellation_id is null
              and cl.ref_lot_id is null and cl.ref_gen_id is null
         else true
       end)
)
select 'G-35' as gate,
       ( (select count(*) from ref_shape)
       + (select count(*) from pc) - (select count(*) from pc_valid)
       + (select count(*) from pc_valid
           where (metadata->>'recovered_qty')::int + (metadata->>'shortfall_qty')::int > (metadata->>'closure_qty')::int
              or (metadata->>'cache_effect_qty')::int
                   <> case when (metadata->>'lot_was_live')::boolean then (metadata->>'recovered_qty')::int else 0 end
              or delta <> -((metadata->>'cache_effect_qty')::int))
       + (select count(*) from cc) - (select count(*) from cc_valid)
       + (select count(*) from cc_valid
           where (metadata->>'mapped_qty')::int <> (metadata->>'immediate_recovered_qty')::int + (metadata->>'shortfall_qty')::int
              or (metadata->>'live_recovered_qty')::int > (metadata->>'immediate_recovered_qty')::int
              or delta <> -((metadata->>'live_recovered_qty')::int)) )::int as violations,
       'structural' as scope,
       'credit_ledger ref-shape(XOR/null) + policy_close/external-commit cache-effect metadata invalid' as detail;

-- G-36: admin_actions_ledger action/ref/actor/payload_hash/metadata 정합(§3·§33 — malformed-safe).
--        credit_delta=after−before·관리자 실재·action 별 필수 ref·payload_hash 형식·필수 metadata 키.
select 'G-36' as gate, count(*)::int as violations, 'structural' as scope,
       'admin ledger action/ref/actor/payload/metadata mismatch' as detail
  from public.admin_actions_ledger al
 where al.credit_delta <> al.after_credits - al.before_credits
    or not coalesce((select is_admin from public.member_accounts where user_id = al.admin_user_id), false)
    or (al.payload_hash is not null and al.payload_hash !~ '^[0-9a-f]{64}$')
    or (al.payload_hash is null) <> (al.payload_hash_version is null)
    or (al.action_type in ('partial_refund','refund_release','refund_switch_manual','refund_replan')
        and al.ref_attempt_id is null)
    or (al.action_type = 'resolve_external_cancellation' and al.ref_cancellation_id is null)
    or (al.action_type = 'cancel_intent'
        and (al.order_uuid is null or al.ref_attempt_id is not null or al.ref_cancellation_id is not null
             or jsonb_typeof(al.metadata) <> 'object'
             or al.metadata->>'customer_requested_at' is null
             or al.metadata->>'cancel_intent_created_at' is null))
    or (al.action_type = 'refund_replan'
        and (jsonb_typeof(al.metadata) <> 'object'
             or coalesce(al.metadata->>'phase','') not in ('pre_pg','post_pg')))
    or (al.action_type = 'partial_refund'
        and jsonb_typeof(al.metadata) = 'object' and al.metadata->>'rail' = 'manual_transfer'
        and coalesce(al.metadata->>'external_payout_ref','') !~ '^[A-Za-z0-9._:-]{1,128}$');

-- G-37: cancel intent 4필드 커플링(§3.2) — orders 취소의사 4필드 all-or-none + admin_ledger cancel_intent 유일성.
select 'G-37' as gate, count(*)::int as violations, 'structural' as scope,
       'cancel intent 4-field coupling violated' as detail
  from (
    select o.order_uuid from public.orders o
     where not ( (o.cancel_requested_at is null and o.cancel_requested_by is null
                  and o.cancel_intent_created_at is null and o.cancel_intent_reason is null)
              or (o.cancel_requested_at is not null and o.cancel_requested_by is not null
                  and o.cancel_intent_created_at is not null and o.cancel_intent_reason is not null) )
    union all
    select al.order_uuid from public.admin_actions_ledger al
     where al.action_type = 'cancel_intent'
     group by al.order_uuid having count(*) > 1) q;

-- G-38: v2 원장 중복 0(§33) — gen v2·purchase v2·lot expire v2·attempt reserve/settle/policy_close·cancellation.
select 'G-38' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'v2 ledger duplicate rows across unique dimensions' as detail
  from (
    select 1 from public.credit_ledger where schema_version = 2 and ref_gen_id is not null and ref_attempt_id is null
      group by ref_gen_id, event_type having count(*) > 1
    union all
    select 1 from public.credit_ledger where event_type = 'purchase' and schema_version = 2 and ref_order_uuid is not null
      group by ref_order_uuid having count(*) > 1
    union all
    select 1 from public.credit_ledger where event_type = 'expire' and schema_version = 2 and ref_lot_id is not null
      group by ref_lot_id having count(*) > 1
    union all
    select 1 from public.credit_ledger where event_type = 'refund_reserve' and ref_attempt_id is not null
      group by ref_attempt_id having count(*) > 1
    union all
    select 1 from public.credit_ledger where event_type in ('refund_commit','refund_release') and ref_attempt_id is not null
      group by ref_attempt_id having count(*) > 1
    union all
    select 1 from public.credit_ledger where event_type = 'refund_policy_close' and ref_attempt_id is not null
      group by ref_attempt_id having count(*) > 1
    union all
    select 1 from public.credit_ledger where ref_cancellation_id is not null
      group by ref_cancellation_id having count(*) > 1) q;

-- G-39: aggregate/event discrepancy 분리(§5·§33) — event 급 불일치는 실 event 참조, aggregate 급은 가짜 event 0.
--        cancellation_discrepancy 이슈에서 cancellation_id 있는 행은 실 event 참조 필수(가짜 참조 0).
select 'G-39' as gate, count(*)::int as violations, 'structural' as scope,
       'discrepancy issue references missing/fabricated cancellation event' as detail
  from public.reconciliation_issues i
 where i.type = 'cancellation_discrepancy'
   and i.cancellation_id is not null
   and not exists (select 1 from public.payment_cancellation_events ev
                    where ev.cancellation_id = i.cancellation_id and ev.order_uuid = i.order_uuid);

-- G-40: stale pre-PG attempt ↔ 외부 resolved 동시 예약 0(§33 — safe-stage). 같은 로트에 prepared(pg_requested_at null)
--        예약 attempt 가 살아있으면서, 그 로트가 resolved 외부취소 매핑(shortfall_qty 또는 immediate>0)에 걸린 상태.
with mp as (
  select ev.order_uuid, (m.elem->>'lot_id') as lot_id
    from public.payment_cancellation_events ev
   cross join lateral jsonb_array_elements(ev.resolved_lot_mappings) as m(elem)
   where ev.resolution_state = 'resolved' and ev.origin = 'live'
     and jsonb_typeof(ev.resolved_lot_mappings) = 'array'
     and jsonb_typeof(m.elem) = 'object' and jsonb_typeof(m.elem->'lot_id') = 'string'
     and (m.elem->>'lot_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
select 'G-40' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'stale pre-PG reserving attempt on externally-resolved lot' as detail
  from public.order_refund_attempts a
  join mp on mp.lot_id::uuid = a.credit_lot_id and mp.order_uuid = a.order_uuid
 where a.state = 'prepared' and a.pg_requested_at is null;

-- G-41: replan 증빙 없는 post-PG released 0 + pre-PG release 에 pg_requested 잔존 0(§8).
select 'G-41' as gate, count(*)::int as violations, 'normal+cutover' as scope,
       'released attempt with wrong/absent replan evidence' as detail
  from public.order_refund_attempts a
 where a.state = 'released'
   and ( (a.release_reason = 'replanned_after_pg_reconciliation'
          and (a.pg_requested_at is null or a.reconciliation_verified_at is null or a.evidence_hash is null))
      or (a.release_reason in ('admin_cancelled_before_pg','replanned_before_pg','replanned_before_pg_external')
          and a.pg_requested_at is not null) );

-- G-42: system auto-full batch pre-state eligibility(§14·§33). resolved batch 는 pre-refunded/committed/legacy 0·
--        전액 종결·eligible 이어야 하고, batch 부착 event 는 그 eligible batch 를 참조.
select 'G-42' as gate, count(*)::int as violations, 'structural' as scope,
       'auto-full batch pre-state ineligible / event-batch link invalid' as detail
  from (
    select b.id from public.cancellation_resolution_batches b
     where b.resolved_at is not null
       and ( b.eligibility_result <> 'eligible'
          or b.pre_refunded_amount <> 0 or b.pre_refunded_credits <> 0
          or b.pre_committed_count <> 0 or b.pre_legacy_contribution <> 0
          or b.total_succeeded_amount <> b.order_amount_snapshot )
    union all
    select ev.resolution_batch_id from public.payment_cancellation_events ev
      join public.cancellation_resolution_batches b on b.id = ev.resolution_batch_id
     where ev.resolution_batch_id is not null
       and (b.eligibility_result <> 'eligible' or ev.resolution_state <> 'resolved'
            or ev.origin <> 'live' or ev.resolution_source <> 'system')) q;

-- G-43: 금융 direct DML 권한 leak 0(§17·§33). 신규 12테이블 = service_role SELECT-only·anon/auth/PUBLIC 無;
--        orders/member/ai = 테이블 DML 無 + 컬럼 UPDATE 는 §13 operational exact set 만(0063 H2 와 동일 allowlist);
--        has_table_privilege/has_column_privilege 로 실 DML 가능성까지 검증(무기입).
select 'G-43' as gate, count(*)::int as violations, 'cutover/normal' as scope,
       'financial direct DML grant/privilege leak' as detail
  from (
    -- (a) 신규 금융 12테이블: anon/auth/PUBLIC 임의 권한 or service_role 비-SELECT
    select g.table_name from information_schema.role_table_grants g
     where g.table_schema = 'public'
       and g.table_name in ('credit_lots','refund_requests','order_refund_attempts','payment_cancellation_events',
             'reconciliation_issues','credit_refund_shortfalls','legacy_refund_backfill_evidence',
             'cancellation_resolution_batches','ops_cron_heartbeats','schema_migration_journal',
             'credit_ledger','admin_actions_ledger')
       and ( g.grantee in ('anon','authenticated','PUBLIC')
          or (g.grantee = 'service_role' and g.privilege_type <> 'SELECT') )
    union all
    -- (b) orders/member/ai: service_role 테이블 INSERT/UPDATE/DELETE
    select g.table_name from information_schema.role_table_grants g
     where g.table_schema = 'public' and g.table_name in ('orders','member_accounts','ai_generations')
       and g.grantee = 'service_role' and g.privilege_type in ('INSERT','UPDATE','DELETE')
    union all
    -- (c) orders/member/ai: service_role 컬럼 UPDATE 가 §13 operational allowlist 밖(금융/금융인접 leak)
    select g.table_name from information_schema.role_column_grants g
     where g.table_schema = 'public' and g.table_name in ('orders','member_accounts','ai_generations')
       and g.grantee = 'service_role' and g.privilege_type = 'UPDATE'
       and (g.table_name, g.column_name) not in (
             ('orders','pg_status'), ('orders','raw'), ('orders','error_message'),
             ('member_accounts','email'),
             ('ai_generations','status'), ('ai_generations','fail_reason'),
             ('ai_generations','candidate_urls'), ('ai_generations','fal_request_id'),
             ('ai_generations','fal_request_ids'), ('ai_generations','picked_doll_id'),
             ('ai_generations','picked_index'), ('ai_generations','cost_cents'),
             ('ai_generations','role'))
    union all
    -- (d) 실 권한 probe(무기입): 신규 12테이블은 INSERT/UPDATE/DELETE 전부, 기존 3테이블은 INSERT/DELETE
    --     (UPDATE 는 operational 컬럼 grant 로 table-level true 가 정상 — 컬럼 단위는 (e)가 검증)
    select t.tbl from (
        values ('credit_lots'),('refund_requests'),('order_refund_attempts'),('payment_cancellation_events'),
               ('reconciliation_issues'),('credit_refund_shortfalls'),('legacy_refund_backfill_evidence'),
               ('cancellation_resolution_batches'),('ops_cron_heartbeats'),('schema_migration_journal'),
               ('credit_ledger'),('admin_actions_ledger')) t(tbl)
     cross join (values ('INSERT'),('UPDATE'),('DELETE')) p(pv)
     where has_table_privilege('service_role', ('public.' || t.tbl)::regclass, p.pv)
    union all
    select t.tbl from (values ('orders'),('member_accounts'),('ai_generations')) t(tbl)
     cross join (values ('INSERT'),('DELETE')) p(pv)
     where has_table_privilege('service_role', ('public.' || t.tbl)::regclass, p.pv)
    union all
    -- (e) 금융/금융인접 컬럼 UPDATE 실권한 probe(has_column_privilege — 무기입)
    select c.tbl from (values
        ('orders','status'), ('orders','canceled_at'), ('orders','paid_at'), ('orders','payment_id'),
        ('orders','pg_tx_id'), ('orders','amount'), ('orders','credits'),
        ('orders','refunded_credits'), ('orders','refunded_amount'), ('orders','receipt_url'),
        ('orders','cancel_requested_at'), ('orders','cancel_requested_by'),
        ('orders','cancel_intent_created_at'), ('orders','cancel_intent_reason'),
        ('member_accounts','gen_credits'), ('member_accounts','is_admin'),
        ('ai_generations','credit_lot_id'), ('ai_generations','consumed_at'),
        ('ai_generations','refunded_at'), ('ai_generations','version')) c(tbl, col)
     where has_column_privilege('service_role', ('public.' || c.tbl)::regclass, c.col, 'UPDATE')) q;

-- G-44: hash golden 재계산 + version(§10·§33). scripts/refund/hash-goldens.json 의 8 vector(canonical→sha256)를
--        리터럴로 고정해 DB bp_sha256_hex(canonical) 과 대조 + 모든 canonical 이 hash_version:n1 로 시작하는지 검증.
--        (golden 은 사람이 레포에 고정한 값 — DB 계산치로 재생성 금지. 불일치 시 golden 또는 canonical 규약 drift.)
with golden(name, canonical, sha256) as (values
  ('base',
   'hash_version:n1|amount:n3000|attempt_id:u6f9619ff-8b86-d011-b42d-00c04fc964ff|order_uuid:u00000000-0000-4000-8000-000000000001|qty:n3|rail:sportone|reason:scustomer_request',
   '6d3618e5524ceaece50a606f4e5f510d369d5ac17eccb17d151612e71c1b986d'),
  ('key_order',
   'hash_version:n1|amount:n3000|attempt_id:u6f9619ff-8b86-d011-b42d-00c04fc964ff|order_uuid:u00000000-0000-4000-8000-000000000001|qty:n3|rail:sportone|reason:scustomer_request',
   '6d3618e5524ceaece50a606f4e5f510d369d5ac17eccb17d151612e71c1b986d'),
  ('whitespace',
   E'hash_version:n1|amount:n0|note:s  leading and  inner\ttabs and trailing  ',
   '7fbe5acd380faa0503196b65f733680842962a1c2695d85d56a51e92f8f2aea3'),
  ('unicode',
   'hash_version:n1|label:s생성권|reason:s테스트 환불 사유 — 오류 정정 🔁',
   'e4d18101cdc118c1ecc6aed0272e1b96482d2d3c1a228eb9bbff20af3012b84b'),
  ('timestamp',
   E'hash_version:n1|granted_at:t2026-07-24T09\\:30\\:45.123456Z|paid_at:t2026-07-24T09\\:30\\:45.123456Z',
   '41e520944edf5f0d3cdc199c62f8f9919533bea5d22a2f3c096a0b421dc15f33'),
  ('uuid',
   'hash_version:n1|cancellation_id:uaaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
   'da4cd38e6d7e4f070f014d88e7f2a7230a6d69f07b2849e93ff037322fd89cd3'),
  ('numeric_boundary',
   'hash_version:n1|krw:n1000000|max_safe:n9007199254740991|neg:n-3000|zero:n0',
   '065df8e22f69b0cf46d379173b4d2cc0f7295bcad62373fa5a560fe72a29a338'),
  ('delimiter',
   E'hash_version:n1|marker:sBP_REFUND\\:6f9619ff-8b86-d011-b42d-00c04fc964ff|mixed:sk\\:v\\|k2\\:v2|pipe:sa\\|b\\|c',
   '948b928fe8cf556606746e4df184ce6c31519329406f1062b31bbc63068a3782')
)
select 'G-44' as gate, count(*)::int as violations, 'structural' as scope,
       'golden hash recompute mismatch or version drift' as detail
  from golden g
 where public.bp_sha256_hex(g.canonical) <> g.sha256
    or g.canonical not like 'hash_version:n1%';

-- G-45: JSON size/PII 위반 0(§12·§33) — 실 JSON 컬럼 octet_length<=32768 & jsonb_has_sensitive_key=false.
select 'G-45' as gate, count(*)::int as violations, 'structural' as scope,
       'financial JSON column oversize or contains sensitive key' as detail
  from (
    select 1 from public.order_refund_attempts
     where (pg_request_body is not null and (octet_length(pg_request_body::text) > 32768 or public.jsonb_has_sensitive_key(pg_request_body)))
        or (pg_raw is not null and (octet_length(pg_raw::text) > 32768 or public.jsonb_has_sensitive_key(pg_raw)))
        or (pg_cancellation_ids_before is not null and (octet_length(pg_cancellation_ids_before::text) > 32768 or public.jsonb_has_sensitive_key(pg_cancellation_ids_before)))
        or (observed_cancellation_ids is not null and (octet_length(observed_cancellation_ids::text) > 32768 or public.jsonb_has_sensitive_key(observed_cancellation_ids)))
        or (payout_evidence is not null and (octet_length(payout_evidence::text) > 32768 or public.jsonb_has_sensitive_key(payout_evidence)))
    union all
    select 1 from public.payment_cancellation_events
     where (observed_raw is not null and (octet_length(observed_raw::text) > 32768 or public.jsonb_has_sensitive_key(observed_raw)))
        or (resolved_lot_mappings is not null and (octet_length(resolved_lot_mappings::text) > 32768 or public.jsonb_has_sensitive_key(resolved_lot_mappings)))
    union all
    select 1 from public.reconciliation_issues
     where detail is not null and (octet_length(detail::text) > 32768 or public.jsonb_has_sensitive_key(detail))
    union all
    select 1 from public.credit_ledger
     where metadata is not null and (octet_length(metadata::text) > 32768 or public.jsonb_has_sensitive_key(metadata))
    union all
    select 1 from public.admin_actions_ledger
     where metadata is not null and (octet_length(metadata::text) > 32768 or public.jsonb_has_sensitive_key(metadata))
    union all
    select 1 from public.cancellation_resolution_batches
     where octet_length(cancellation_projection::text) > 32768 or public.jsonb_has_sensitive_key(cancellation_projection)
    union all
    select 1 from public.legacy_refund_backfill_evidence
     where octet_length(cancellation_evidence::text) > 32768 or public.jsonb_has_sensitive_key(cancellation_evidence)
        or octet_length(ledger_evidence::text) > 32768 or public.jsonb_has_sensitive_key(ledger_evidence)) q;

-- G-46: legal 발행 전제(§31·§11.5). 필수 doc_type(privacy·terms)마다 현재 유효(effective_date<=오늘 KST) published 존재.
--        (source 파일 marker block 의 byte-for-byte golden hash 대조는 legal golden manifest[E-도메인]이 담당 — 본 파일 밖.)
select 'G-46' as gate, count(*)::int as violations, 'structural' as scope,
       'required legal doc_type has no current published version' as detail
  from (values ('privacy'),('terms')) req(doc_type)
 where not exists (
         select 1 from public.legal_documents d
          where d.doc_type = req.doc_type and d.status = 'published'
            and d.effective_date <= (now() at time zone 'Asia/Seoul')::date );

-- G-47: cron heartbeat SLA(§29·§33) — reconcile 성공 <=15분·credit-expire 성공 <=26h. row 부재/미성공/초과 = 위반.
select 'G-47' as gate, count(*)::int as violations, 'live' as scope,
       'cron heartbeat missing / stale beyond SLA' as detail
  from (values ('reconcile', interval '15 minutes'), ('credit-expire', interval '26 hours')) sla(job, max_age)
  left join public.ops_cron_heartbeats h on h.job_name = sla.job
 where h.job_name is null
    or h.last_succeeded_at is null
    or (now() - h.last_succeeded_at) > sla.max_age;

-- G-48: phase migration journal/hash(§22·§30). post-0062 gate 의 필수 phase = 0062 journal 행 존재.
--        (after-0063 = +0063_write_hardening, after-0064 = +0064_legacy_stub_removal — 적용 여부는 glob 아닌 journal 기준.)
select 'G-48' as gate, count(*)::int as violations, 'cutover' as scope,
       'required migration phase journal row missing' as detail
  from (values ('0062_credit_lots_refund_saga')) req(version)
 where not exists (select 1 from public.schema_migration_journal j where j.version = req.version);
