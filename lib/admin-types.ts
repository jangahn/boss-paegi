// 관리자 대시보드 공용 타입 — server(admin-data)·client(components/admin) 공유.
// (server-only 가 아니어야 클라 컴포넌트가 타입 import 가능.)

export type AdminFunnel = {
  anon_users: number;
  players: number;
  members: number;
  first_gen: number;
  first_purchase: number;
};

export type OrderSummary = {
  revenue_today: number;
  revenue_7d: number;
  revenue_30d: number;
  orders_today: number;
  orders_7d: number;
  orders_30d: number;
  by_status: Record<string, number>;
};

export type AdminOrder = {
  order_uuid: string;
  status: string;
  amount: number;
  credits: number;
  product_id: string;
  mul_no: string | null;
  created_at: string;
  paid_at: string | null;
  user_id: string;
  display_name: string | null;
  // 머니 패스(0023)에서 환불 진행 상태. 목록(search_orders)만 채움 — 대시보드 조회는 생략(undefined).
  refund_state?: string | null;
};
