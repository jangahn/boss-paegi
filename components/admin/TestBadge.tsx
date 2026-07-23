/** 테스트 채널 주문(orders.is_test, 0059) 표시 뱃지 — 실환불/테스트 구분용. server/client 양쪽 사용. */
export function TestBadge() {
  return (
    <span className="ml-1 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[10px] font-semibold text-amber-500">
      TEST
    </span>
  );
}
