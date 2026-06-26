"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { ModalShell } from "@/components/ModalShell";
import { moveItem } from "@/lib/reorder";
import type { GrowthLevers, GrowthProduct } from "@/lib/config/domains/growth";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed:
    "형식 오류 — 가격 1,000~100,000원·생성권 1개 이상·상품ID/이름 필수. 빨간 안내를 확인하세요.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

type Draft = {
  productId: string;
  goodname: string;
  price: string;
  credits: string;
  active: boolean;
};

function toDraft(p: GrowthProduct): Draft {
  return {
    productId: p.productId,
    goodname: p.goodname,
    price: String(p.price),
    credits: String(p.credits),
    active: p.active,
  };
}

export function GrowthLeversEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: GrowthLevers;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [signup, setSignup] = useState(String(initial.signupBonusCredits));
  const [products, setProducts] = useState<Draft[]>(initial.products.map(toDraft));
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setP = (i: number, key: keyof Draft, v: string | boolean) =>
    setProducts((ps) => ps.map((p, pi) => (pi === i ? { ...p, [key]: v } : p)));
  const addP = () =>
    setProducts((ps) => [
      ...ps,
      { productId: "", goodname: "", price: "1000", credits: "1", active: true },
    ]);
  const removeP = (i: number) => setProducts((ps) => ps.filter((_, pi) => pi !== i));
  const moveP = (i: number, dir: -1 | 1) => setProducts((ps) => moveItem(ps, i, dir));

  const publish = async () => {
    if (busy) return;
    setBusy(true);
    setConfirm(false);
    setMsg(null);
    try {
      const value: GrowthLevers = {
        signupBonusCredits: Number(signup),
        products: products.map((p) => ({
          productId: p.productId.trim(),
          goodname: p.goodname.trim(),
          price: Number(p.price),
          credits: Number(p.credits),
          active: p.active,
        })),
      };
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "growth_levers", value, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        error?: string;
      };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 표시·신규 결제부터 반영됩니다." });
        router.refresh();
      } else {
        setMsg({ ok: false, text: ERR_KO[out.error ?? ""] ?? out.error ?? "저장 실패" });
      }
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-5">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다."}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-zinc-500">
          가입 기념 생성권 <span className="text-zinc-400">· 0 ~ 50 (신규 가입자에게만 1회)</span>
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={50}
          value={signup}
          onChange={(e) => setSignup(e.target.value)}
          className="w-40 rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40"
        />
      </label>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-semibold text-zinc-500">충전 상품</span>
        {products.map((p, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-foreground/10 ui-surface p-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={(e) => setP(i, "active", e.target.checked)}
                />
                판매 활성
              </label>
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[11px] text-zinc-400">
                  개당 ₩
                  {Number(p.credits) > 0
                    ? Math.round(Number(p.price) / Number(p.credits)).toLocaleString()
                    : "—"}
                </span>
                <button
                  type="button"
                  onClick={() => moveP(i, -1)}
                  disabled={i === 0}
                  aria-label="위로"
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => moveP(i, 1)}
                  disabled={i === products.length - 1}
                  aria-label="아래로"
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-foreground/10 disabled:opacity-30"
                >
                  ▼
                </button>
                <button
                  type="button"
                  onClick={() => removeP(i)}
                  className="text-xs text-red-400 hover:underline"
                >
                  삭제
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={p.productId}
                onChange={(e) => setP(i, "productId", e.target.value)}
                placeholder="상품 ID (예: credits_3, 영문/숫자)"
                className="rounded-lg border border-foreground/15 ui-field p-2 text-xs outline-none focus:border-foreground/40"
              />
              <input
                value={p.goodname}
                onChange={(e) => setP(i, "goodname", e.target.value)}
                placeholder="상품명 (영수증 표기)"
                className="rounded-lg border border-foreground/15 ui-field p-2 text-xs outline-none focus:border-foreground/40"
              />
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-400">가격(원) 1,000~100,000</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1000}
                  max={100000}
                  value={p.price}
                  onChange={(e) => setP(i, "price", e.target.value)}
                  className="rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-400">생성권 개수</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1000}
                  value={p.credits}
                  onChange={(e) => setP(i, "credits", e.target.value)}
                  className="rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40"
                />
              </label>
            </div>
          </div>
        ))}
        {products.length < 8 && (
          <button
            type="button"
            onClick={addP}
            className="rounded-xl border border-dashed border-foreground/20 py-2 text-sm text-zinc-500 hover:bg-foreground/5"
          >
            + 상품 추가
          </button>
        )}
      </div>

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => setConfirm(true)}
        disabled={busy}
        className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행 (실결제 반영)
      </button>

      {confirm && (
        <ModalShell onClose={() => setConfirm(false)}>
          <h2 className="text-lg font-bold">가격·생성권을 발행할까요?</h2>
          <p className="mt-2 text-sm text-zinc-500">
            이 설정은 <b>신규 결제와 가입 생성권에 즉시 적용</b>됩니다. 가격·개수를 다시 확인하세요.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className="flex-1 rounded-full border border-foreground/15 ui-surface py-2.5 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void publish()}
              className="flex-1 rounded-full bg-foreground py-2.5 text-sm font-semibold text-paper-2"
            >
              발행
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
