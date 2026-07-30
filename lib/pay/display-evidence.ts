import type { CreditProduct } from "@/lib/credit-products";
import type {
  PayChannelMethod,
  PayMode,
} from "@/lib/pay-channels";

export const CREDITS_OFFER_COPY = Object.freeze({
  schemaVersion: 1,
  copyVersion: "credits-offer-2026-07-30-v1",
  summary:
    "캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.",
  supply: "생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.",
  validity: "구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.",
  refund:
    "미사용 생성권은 환불받을 수 있어요(무료로 지급받은 생성권은 제외). 일부만 사용했더라도 남은 수량만큼 환불돼요. 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한돼요.",
  refundReferencePrefix: "정확한 산정 기준·차감 순서·절차는",
  termsLinkLabel: "이용약관 제10조",
  refundReferenceSuffix: "를 확인해주세요.",
  price: "표시 가격은 부가세 포함 최종 결제 금액이에요.",
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function creditsOfferEvidenceSnapshot({
  products,
  payMode,
  channels,
}: {
  products: readonly CreditProduct[];
  payMode: PayMode;
  channels: readonly Readonly<{
    method: PayChannelMethod;
    label: string;
  }>[];
}) {
  if (
    products.length < 1 ||
    products.length > 8 ||
    channels.length < 1 ||
    channels.length > 10
  ) {
    throw new Error("credits_offer_snapshot_invalid");
  }
  const normalizedProducts = products.map((product) => {
    if (
      typeof product.productId !== "string" ||
      product.productId.length < 1 ||
      product.productId.length > 100 ||
      typeof product.goodname !== "string" ||
      product.goodname.length < 1 ||
      product.goodname.length > 200 ||
      !Number.isSafeInteger(product.price) ||
      product.price < 1 ||
      !Number.isSafeInteger(product.credits) ||
      product.credits < 1
    ) {
      throw new Error("credits_offer_snapshot_invalid");
    }
    return {
      productId: product.productId,
      goodname: product.goodname,
      priceKrwVatIncluded: product.price,
      credits: product.credits,
    };
  });
  if (
    channels.some(
      ({ method, label }) =>
        !["card", "tosspay", "kakaopay"].includes(method) ||
        typeof label !== "string" ||
        label.trim().length < 1 ||
        label.length > 100 ||
        label !== label.trim(),
    )
  ) {
    throw new Error("credits_offer_snapshot_invalid");
  }
  return {
    schemaVersion: CREDITS_OFFER_COPY.schemaVersion,
    copyVersion: CREDITS_OFFER_COPY.copyVersion,
    surface: "credits_offer",
    payMode,
    products: normalizedProducts,
    channels: channels.map(({ method, label }) => ({ method, label })),
    displayCopy: {
      summary: CREDITS_OFFER_COPY.summary,
      supply: CREDITS_OFFER_COPY.supply,
      validity: CREDITS_OFFER_COPY.validity,
      refund: CREDITS_OFFER_COPY.refund,
      refundReferencePrefix: CREDITS_OFFER_COPY.refundReferencePrefix,
      termsLinkLabel: CREDITS_OFFER_COPY.termsLinkLabel,
      refundReferenceSuffix: CREDITS_OFFER_COPY.refundReferenceSuffix,
      price: CREDITS_OFFER_COPY.price,
    },
  } as const;
}

type CommerceEvidenceRpcClient = {
  rpc(
    name: "record_commerce_display_evidence",
    args: { p_surface: "credits_offer"; p_snapshot: unknown },
  ): PromiseLike<{ data: unknown; error: unknown }>;
};

export async function recordCreditsOfferDisplayEvidence(
  client: CommerceEvidenceRpcClient,
  input: {
    products: readonly CreditProduct[];
    payMode: PayMode;
    channels: readonly Readonly<{
      method: PayChannelMethod;
      label: string;
    }>[];
  },
): Promise<Readonly<{ evidenceId: string; snapshotSha256: string }>> {
  const snapshot = creditsOfferEvidenceSnapshot(input);
  const { data, error } = await client.rpc(
    "record_commerce_display_evidence",
    {
      p_surface: "credits_offer",
      p_snapshot: snapshot,
    },
  );
  if (error) throw error;
  const row =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (
    !row ||
    row.ok !== true ||
    typeof row.evidence_id !== "string" ||
    !UUID_RE.test(row.evidence_id) ||
    typeof row.snapshot_sha256 !== "string" ||
    !SHA256_RE.test(row.snapshot_sha256) ||
    typeof row.first_displayed_at !== "string" ||
    !Number.isFinite(Date.parse(row.first_displayed_at)) ||
    typeof row.last_displayed_at !== "string" ||
    !Number.isFinite(Date.parse(row.last_displayed_at)) ||
    typeof row.retain_until_at_least !== "string" ||
    !Number.isFinite(Date.parse(row.retain_until_at_least))
  ) {
    throw new Error("commerce_display_evidence_response_invalid");
  }
  return {
    evidenceId: row.evidence_id,
    snapshotSha256: row.snapshot_sha256,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "__undefined__";
}

export function creditsOfferEvidenceRecordMatches(
  value: unknown,
  expected: Readonly<{
    evidenceId: string;
    snapshotSha256: string;
    snapshot: ReturnType<typeof creditsOfferEvidenceSnapshot>;
  }>,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") ===
      "id,snapshot,snapshot_sha256,surface" &&
    row.id === expected.evidenceId &&
    row.surface === "credits_offer" &&
    row.snapshot_sha256 === expected.snapshotSha256 &&
    canonicalJson(row.snapshot) === canonicalJson(expected.snapshot)
  );
}
