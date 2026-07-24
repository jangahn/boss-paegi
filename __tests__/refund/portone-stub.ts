// portone-stub.ts — PortOne V2 결제/취소 stub 서버 (§7·§27·§42).
//
// 상태: generated / statically-checked (tsc) — node:http 로 실제 기동되는 자기완결 stub.
//   라이브 PortOne 없이 환불 saga 의 PG 취소 경로(preflight GET → cancel POST)를 계약대로 구동한다.
//   설치 SDK @portone/server-sdk@0.19.0 의 **실 wire 타입**(`import type`)으로 응답을 타이핑하므로
//   SDK 를 이 stub 의 baseUrl 로 향하게 하면 그대로 소비된다(§27 "SDK vs raw fetch 를 하나의 adapter 로").
//
// 재현하는 wire 계약:
//   * GET  /payments/{id}            → Payment (status 주입 가능: PAID·PARTIAL_CANCELLED·CANCELLED·
//                                       FAILED·READY·PENDING·VIRTUAL_ACCOUNT_ISSUED·NOT_FOUND).
//                                       amount 는 PaymentAmount(total·cancelled·paid…), cancellations[] 포함.
//   * POST /payments/{id}/cancel     → CancelPaymentResponse { cancellation: SucceededPaymentCancellation }.
//       - 1차 부분취소 → PARTIAL_CANCELLED, 남은 cancellable 로 2차 취소 지원 → 전액 도달 시 CANCELLED.
//       - Idempotency-Key(RFC 8941 quoted-string): 동일 key+동일 body 재시도 → **동일 응답**(상태 무변경).
//         동일 key + 다른 body → 422 IDEMPOTENCY_KEY_CONFLICT.
//       - currentCancellableAmount CAS: 값 주입 시 현재 cancellable 과 불일치면 409 CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN.
//       - amount 미입력 → 전액(남은 cancellable) 취소. amount>cancellable → 400 CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT.
//       - 이미 CANCELLED → 400 PAYMENT_ALREADY_CANCELLED. 미결제 상태 → 400 PAYMENT_NOT_PAID.
//       - SUCCEEDED cancellation 객체 실 필드: id·pgCancellationId·totalAmount·reason·cancelledAt·requestedAt·receiptUrl.
//   * 모든 요청은 HTTP call log 에 기록(method·path·idempotency-key·body·status·response).
//   * fake clock(now)·결정적 cancellationId 시퀀스 주입 가능(§42 fake clock/주입 now).
//
// 비고(§27): "3h retry cutoff" 는 PortOne 보장이 아니라 boss-paegi 내부 보수적 재시도 상한이므로 stub 은
//   시간 경과로 상태를 바꾸지 않는다(순수 상태 기계). requester 는 공식 enum(Customer/Admin) 만 허용하되
//   correlation 은 reason 문자열(중립 marker)로 전달된다 — stub 은 reason 을 그대로 cancellation 에 반영.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type * as PortOne from "@portone/server-sdk";

type PaymentStatus = PortOne.Payment.PaymentStatus;
type PaymentAmount = PortOne.Payment.PaymentAmount;
type PaymentCancellation = PortOne.Payment.PaymentCancellation;
type SucceededPaymentCancellation = PortOne.Payment.SucceededPaymentCancellation;
type Payment = PortOne.Payment.Payment;
type CancelPaymentResponse = PortOne.Payment.CancelPaymentResponse;

/** 결제건 주입 초기값. */
export interface SeedPaymentInit {
  /** 주입 상태(미지정 시 PAID). */
  status?: PaymentStatus;
  /** 총 결제금액(int64, KRW). */
  totalAmount: number;
  /** 이미 취소된 누계 — 부분취소 상태를 미리 주입할 때 사용(기본 0). */
  cancelledAmount?: number;
  /** 결제 시각(RFC 3339). */
  paidAt?: string;
  /** 영수증 URL(HTTPS). */
  receiptUrl?: string;
  /** 이미 존재하는 취소 내역(주입). */
  cancellations?: PaymentCancellation[];
  /** GET 시 PAYMENT_NOT_FOUND(404) 로 응답. */
  notFound?: boolean;
}

/** HTTP 호출 로그 엔트리(§42 — call log). */
export interface CallLogEntry {
  at: string;
  method: string;
  path: string;
  idempotencyKey: string | null;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
}

interface PaymentRecord {
  paymentId: string;
  status: PaymentStatus;
  total: number;
  cancelled: number;
  paidAt?: string;
  receiptUrl?: string;
  cancellations: PaymentCancellation[];
  notFound: boolean;
}

interface IdempotencyEntry {
  bodyHash: string;
  status: number;
  response: unknown;
}

export interface PortOneStubOptions {
  /** 주입 시계(cancelledAt/requestedAt 에 사용). 기본 new Date(). */
  now?: () => Date;
  /** 결정적 cancellationId 시퀀스. 기본 randomUUID(). */
  nextCancellationId?: () => string;
  /** pgCancellationId 생성기(선택). 기본 `pg_${id}`. */
  nextPgCancellationId?: (cancellationId: string) => string;
}

/** PortOne 오류 wire body — SDK 는 `{ type, message }` 를 파싱해 오류 클래스로 던진다. */
interface PortOneErrorBody {
  type: string;
  message?: string;
}

const RFC8941_QUOTED = /^"([\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"$/; // sf-string quoted-string

const PAID_LIKE: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(["PAID", "PARTIAL_CANCELLED"]);

export class PortOneStub {
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly log: CallLogEntry[] = [];
  private server: Server | null = null;
  private readonly now: () => Date;
  private readonly nextCancellationId: () => string;
  private readonly nextPgCancellationId: (cancellationId: string) => string;

  constructor(opts: PortOneStubOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.nextCancellationId = opts.nextCancellationId ?? (() => randomUUID());
    this.nextPgCancellationId = opts.nextPgCancellationId ?? ((id) => `pg_${id}`);
  }

  // ── 주입 API ───────────────────────────────────────────────────────────────────────────────
  seedPayment(paymentId: string, init: SeedPaymentInit): this {
    this.payments.set(paymentId, {
      paymentId,
      status: init.status ?? "PAID",
      total: init.totalAmount,
      cancelled: init.cancelledAmount ?? 0,
      paidAt: init.paidAt,
      receiptUrl: init.receiptUrl,
      cancellations: init.cancellations ? [...init.cancellations] : [],
      notFound: init.notFound ?? false,
    });
    return this;
  }

  /** 임의 상태 강제 주입(예: PAID→FAILED 재관측). */
  setStatus(paymentId: string, status: PaymentStatus): this {
    const rec = this.payments.get(paymentId);
    if (!rec) throw new Error(`portone-stub: unknown payment ${paymentId}`);
    rec.status = status;
    return this;
  }

  getPaymentRecord(paymentId: string): Readonly<PaymentRecord> | undefined {
    return this.payments.get(paymentId);
  }

  get calls(): readonly CallLogEntry[] {
    return this.log;
  }

  clearCalls(): void {
    this.log.length = 0;
  }

  // ── 서버 수명 ──────────────────────────────────────────────────────────────────────────────
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as AddressInfo;
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  // ── 라우팅 ─────────────────────────────────────────────────────────────────────────────────
  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = decodeURIComponent(url.pathname);
      const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? null;

      // GET /payments/{id}
      const getMatch = /^\/payments\/([^/]+)$/.exec(path);
      const cancelMatch = /^\/payments\/([^/]+)\/cancel$/.exec(path);

      try {
        if (req.method === "GET" && getMatch) {
          return this.handleGet(res, decodeURIComponent(getMatch[1]), path, rawBody, idempotencyKey);
        }
        if (req.method === "POST" && cancelMatch) {
          return this.handleCancel(res, decodeURIComponent(cancelMatch[1]), path, rawBody, idempotencyKey);
        }
        return this.send(res, 404, { type: "NOT_FOUND", message: `no route ${req.method} ${path}` },
          req.method ?? "?", path, rawBody, idempotencyKey);
      } catch (e) {
        return this.send(res, 500, { type: "STUB_INTERNAL", message: (e as Error).message },
          req.method ?? "?", path, rawBody, idempotencyKey);
      }
    });
  }

  private handleGet(
    res: ServerResponse, paymentId: string, path: string, rawBody: string, key: string | null,
  ): void {
    const rec = this.payments.get(paymentId);
    if (!rec || rec.notFound) {
      return this.send(res, 404, this.err("PAYMENT_NOT_FOUND", `payment ${paymentId} not found`),
        "GET", path, rawBody, key);
    }
    return this.send(res, 200, this.toPayment(rec), "GET", path, rawBody, key);
  }

  private handleCancel(
    res: ServerResponse, paymentId: string, path: string, rawBody: string, key: string | null,
  ): void {
    // Idempotency-Key 형식 검증(RFC 8941 quoted-string).
    if (key !== null && !RFC8941_QUOTED.test(key)) {
      return this.send(res, 400, this.err("INVALID_REQUEST", "Idempotency-Key must be an RFC 8941 quoted string"),
        "POST", path, rawBody, key);
    }

    const rec = this.payments.get(paymentId);
    if (!rec || rec.notFound) {
      return this.send(res, 404, this.err("PAYMENT_NOT_FOUND", `payment ${paymentId} not found`),
        "POST", path, rawBody, key);
    }

    let body: Record<string, unknown> = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return this.send(res, 400, this.err("INVALID_REQUEST", "malformed JSON body"),
          "POST", path, rawBody, key);
      }
    }

    // 멱등 재시도: 동일 key + 동일 body → 저장 응답 그대로(상태 무변경). 다른 body → 충돌.
    if (key !== null) {
      const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
      const prior = this.idempotency.get(`${paymentId}:${key}`);
      if (prior) {
        if (prior.bodyHash === bodyHash) {
          return this.send(res, prior.status, prior.response, "POST", path, rawBody, key);
        }
        return this.send(res, 422,
          this.err("IDEMPOTENCY_KEY_CONFLICT", "same Idempotency-Key reused with a different body"),
          "POST", path, rawBody, key);
      }
    }

    // 상태 가드.
    if (rec.status === "CANCELLED") {
      return this.send(res, 400, this.err("PAYMENT_ALREADY_CANCELLED", "already fully cancelled"),
        "POST", path, rawBody, key);
    }
    if (!PAID_LIKE.has(rec.status)) {
      return this.send(res, 400, this.err("PAYMENT_NOT_PAID", `payment is ${rec.status}`),
        "POST", path, rawBody, key);
    }

    const cancellable = rec.total - rec.cancelled;

    // currentCancellableAmount CAS.
    const cca = body.currentCancellableAmount;
    if (cca != null) {
      if (typeof cca !== "number" || !Number.isSafeInteger(cca) || cca !== cancellable) {
        return this.send(res, 409,
          this.err("CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN",
            `expected currentCancellableAmount=${cancellable}, got ${String(cca)}`),
          "POST", path, rawBody, key);
      }
    }

    // 취소 금액 결정·검증.
    const amountRaw = body.amount;
    const amount = amountRaw == null ? cancellable : amountRaw;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return this.send(res, 400, this.err("INVALID_REQUEST", "amount must be a positive integer"),
        "POST", path, rawBody, key);
    }
    if (amount > cancellable) {
      return this.send(res, 400,
        this.err("CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT", `amount ${amount} > cancellable ${cancellable}`),
        "POST", path, rawBody, key);
    }
    const reason = body.reason;
    if (typeof reason !== "string" || reason.length === 0) {
      return this.send(res, 400, this.err("INVALID_REQUEST", "reason is required"),
        "POST", path, rawBody, key);
    }

    // 성공 — SUCCEEDED cancellation 생성·상태 전이.
    const nowIso = this.now().toISOString();
    const cancellationId = this.nextCancellationId();
    const cancellation: SucceededPaymentCancellation = {
      status: "SUCCEEDED",
      id: cancellationId,
      pgCancellationId: this.nextPgCancellationId(cancellationId),
      totalAmount: amount,
      taxFreeAmount: 0,
      vatAmount: 0,
      reason,
      cancelledAt: nowIso,
      requestedAt: nowIso,
      receiptUrl: rec.receiptUrl ?? `https://receipt.example/cancel/${cancellationId}`,
    };
    rec.cancellations.push(cancellation);
    rec.cancelled += amount;
    rec.status = rec.cancelled >= rec.total ? "CANCELLED" : "PARTIAL_CANCELLED";

    const response: CancelPaymentResponse = { cancellation };
    if (key !== null) {
      const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
      this.idempotency.set(`${paymentId}:${key}`, { bodyHash, status: 200, response });
    }
    return this.send(res, 200, response, "POST", path, rawBody, key);
  }

  // ── 직렬화 helper ──────────────────────────────────────────────────────────────────────────
  private toPayment(rec: PaymentRecord): Payment {
    const amount: PaymentAmount = {
      total: rec.total,
      taxFree: 0,
      vat: 0,
      supply: rec.total,
      discount: 0,
      paid: rec.total,
      cancelled: rec.cancelled,
      cancelledTaxFree: 0,
    };
    const nowIso = this.now().toISOString();
    // 공통 필드 + status 별 필드. 소비자는 status·amount.total·amount.cancelled·cancellations 를 읽는다.
    const base = {
      status: rec.status,
      id: rec.paymentId,
      amount,
      cancellations: rec.cancellations,
      statusChangedAt: nowIso,
      ...(rec.paidAt ? { paidAt: rec.paidAt } : {}),
      ...(rec.receiptUrl ? { receiptUrl: rec.receiptUrl } : {}),
      ...(rec.status === "CANCELLED" ? { cancelledAt: nowIso } : {}),
    };
    // stub 은 실 wire 필드의 부분집합을 반환한다(소비 경로가 읽는 필드 전부 포함). 타입은 SDK 유니온으로 단언.
    return base as unknown as Payment;
  }

  private err(type: string, message: string): PortOneErrorBody {
    return { type, message };
  }

  private send(
    res: ServerResponse, status: number, payload: unknown,
    method: string, path: string, rawBody: string, key: string | null,
  ): void {
    const text = JSON.stringify(payload);
    this.log.push({
      at: this.now().toISOString(),
      method,
      path,
      idempotencyKey: key,
      requestBody: rawBody.length ? safeJson(rawBody) : null,
      status,
      responseBody: payload,
    });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
