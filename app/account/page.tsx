"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import { AvatarEditor } from "@/components/AvatarEditor";
import { FadeImg } from "@/components/FadeImg";
import { signOut } from "@/lib/auth-oauth";
import {
  getMyProfile,
  updateNickname,
  writeCachedProfile,
  NICKNAME_MAX,
  type MyProfile,
} from "@/lib/profile";
import { parseRefundableCreditsResponse } from "@/lib/refundable-credits-response";
import { parseAccountDeletionHttpAck } from "@/lib/account-http-contract";
import {
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runBoundedClientJsonFetch,
  runClientMutation,
  type ClientMutationEvidence,
} from "@/lib/client-mutation";

const DEFAULT_AVATAR = "/avatars/default.png";

/**
 * 마이페이지(회원정보) — 회원 전용(proxy 게이트). 닉네임·프로필 사진·회원탈퇴.
 * (충전·뱃지·기록·대시보드는 접근 뎁스 유지를 위해 드롭다운 메뉴에 그대로 둠.)
 */
export default function AccountPage() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoadError, setProfileLoadError] = useState(false);
  const [nick, setNick] = useState("");
  const [savingNick, setSavingNick] = useState(false);
  const [nickMsg, setNickMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const mountedRef = useRef(false);
  const profileRequestEpochRef = useRef(0);
  const savingNickRef = useRef(false);
  const nicknameRequestEpochRef = useRef(0);
  const nicknameEditEpochRef = useRef(0);
  const nicknameLifecycleRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const nicknameLifecycle = new AbortController();
    nicknameLifecycleRef.current = nicknameLifecycle;
    const requestEpoch = profileRequestEpochRef.current + 1;
    profileRequestEpochRef.current = requestEpoch;
    getMyProfile()
      .then((p) => {
        if (
          !mountedRef.current ||
          profileRequestEpochRef.current !== requestEpoch
        ) {
          return;
        }
        if (!p) {
          setProfileLoadError(true);
          return;
        }
        setProfile(p);
        setProfileLoadError(false);
        setNick(p.display_name);
      })
      .catch(() => {
        if (
          mountedRef.current &&
          profileRequestEpochRef.current === requestEpoch
        ) {
          setProfileLoadError(true);
        }
      });
    return () => {
      mountedRef.current = false;
      if (profileRequestEpochRef.current === requestEpoch) {
        profileRequestEpochRef.current += 1;
      }
      nicknameRequestEpochRef.current += 1;
      nicknameLifecycle.abort(new Error("account_page_unmounted"));
      if (nicknameLifecycleRef.current === nicknameLifecycle) {
        nicknameLifecycleRef.current = null;
      }
    };
  }, []);

  if (!profile) {
    if (profileLoadError) {
      return (
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="sr-only">회원정보</h1>
          <p role="alert" className="text-sm text-red-500">
            회원정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full border border-foreground/15 px-5 py-2.5 text-sm font-semibold"
          >
            다시 불러오기
          </button>
        </main>
      );
    }
    return (
      <main
        aria-busy="true"
        className="flex flex-1 items-center justify-center"
      >
        <h1 className="sr-only">회원정보</h1>
        <Spinner className="h-6 w-6" />
      </main>
    );
  }

  // 법적 동의는 서버 proxy 가 /account 진입 전 게이트 → 여기 도달 = 동의완료. 별도 폴백 불필요.
  const avatar = profile.avatar_url ?? DEFAULT_AVATAR;

  const saveNick = async () => {
    if (savingNickRef.current || nick.trim().length < 2) return;
    savingNickRef.current = true;
    const requestEpoch = nicknameRequestEpochRef.current + 1;
    nicknameRequestEpochRef.current = requestEpoch;
    const editEpoch = nicknameEditEpochRef.current;
    setSavingNick(true);
    setNickMsg(null);
    try {
      const saved = await updateNickname(
        nick,
        nicknameLifecycleRef.current?.signal,
      );
      if (
        !mountedRef.current ||
        nicknameRequestEpochRef.current !== requestEpoch
      ) {
        return;
      }
      setProfile((p) => {
        if (!p) return p;
        const next = { ...p, display_name: saved };
        writeCachedProfile(p.id, next);
        return next;
      });
      if (nicknameEditEpochRef.current === editEpoch) {
        setNick(saved);
      }
      setNickMsg({ ok: true, text: "저장됐어요." });
    } catch (e) {
      if (
        mountedRef.current &&
        nicknameRequestEpochRef.current === requestEpoch
      ) {
        setNickMsg({
          ok: false,
          text: e instanceof Error ? e.message : "저장 실패",
        });
      }
    } finally {
      savingNickRef.current = false;
      if (
        mountedRef.current &&
        nicknameRequestEpochRef.current === requestEpoch
      ) {
        setSavingNick(false);
      }
    }
  };

  return (
    <>
      <main className="flex flex-1 flex-col px-5 py-8">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6">
          <h1 className="text-2xl font-bold text-foreground">회원정보</h1>

          {/* 프로필 카드 — 사진 + 닉네임 */}
          <section className="rounded-2xl border border-foreground/10 ui-surface p-6">
            {/* 프로필 사진 (중앙) */}
            <div className="flex flex-col items-center gap-3">
              <FadeImg
                src={avatar}
                alt="내 프로필 사진"
                className="h-24 w-24 shrink-0 rounded-full border border-foreground/10 object-cover"
                loading="eager"
                fallbackSrc={DEFAULT_AVATAR}
              />
              <button
                type="button"
                onClick={() => setEditingAvatar(true)}
                className="rounded-full border border-foreground/15 ui-surface px-4 py-1.5 text-sm font-medium transition hover:bg-foreground/5"
              >
                프로필 사진 변경
              </button>
            </div>

            <hr className="my-5 border-t border-foreground/10" />

            {/* 닉네임 */}
            <div className="flex flex-col gap-2">
              <label
                htmlFor="account-nickname"
                className="text-sm font-semibold text-zinc-500"
              >
                닉네임 <span className="font-normal text-zinc-400">({NICKNAME_MAX}자 이내)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="account-nickname"
                  value={nick}
                  maxLength={NICKNAME_MAX}
                  onChange={(e) => {
                    nicknameEditEpochRef.current += 1;
                    setNick(e.target.value);
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-foreground/15 ui-field px-3 py-2.5 text-sm outline-none focus:border-foreground/40"
                />
                <button
                  type="button"
                  onClick={() => void saveNick()}
                  disabled={savingNick || nick.trim().length < 2 || nick === profile.display_name}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40"
                >
                  {savingNick && <Spinner className="h-4 w-4" />}
                  저장
                </button>
              </div>
              {nickMsg && (
                <p
                  role={nickMsg.ok ? "status" : "alert"}
                  className={`text-xs ${nickMsg.ok ? "text-emerald-600" : "text-red-400"}`}
                >
                  {nickMsg.text}
                </p>
              )}
            </div>
          </section>

          <WithdrawSection />
        </div>
      </main>

      {editingAvatar && (
        <AvatarEditor
          current={avatar}
          hasCustomAvatar={profile.avatar_url !== null}
          onClose={() => setEditingAvatar(false)}
          onSaved={(url) => {
            setProfile((p) => {
              if (!p) return p;
              const next = { ...p, avatar_url: url };
              writeCachedProfile(p.id, next);
              return next;
            });
            setEditingAvatar(false);
          }}
        />
      )}
    </>
  );
}

// 회원탈퇴 — 눈에 안 띄는 하단, 2단계(고지 체크 + "회원탈퇴" 직접 입력)로 오조작 방지.
function WithdrawSection() {
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 실측 환불가능 수량(§11.6 /api/account/refundable-credits — 표시 전용, null=미조회/실패).
  const [refundable, setRefundable] = useState<number | null>(null);
  const [refundableStatus, setRefundableStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [refundableRetry, setRefundableRetry] = useState(0);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const mutationLifecycleRef = useRef<AbortController | null>(null);
  const ready =
    ack &&
    confirm.trim() === "회원탈퇴" &&
    refundableStatus === "ready";

  // 탈퇴 결정 전에 환불 가능 수량을 반드시 권위 조회한다. 실패를 0/미표시로
  // 축소한 채 탈퇴를 허용하면 사용자가 환불 기회를 모른 채 파괴 작업을 확정할 수 있다.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    void runBoundedClientJsonFetch({
      input: "/api/account/refundable-credits",
      signal: controller.signal,
      deadlineMs: 12_000,
      attemptMs: 8_000,
    })
      .then((delivery) => {
        if (delivery.kind !== "confirmed") {
          throw new Error("refundable_response_unconfirmed");
        }
        const { response: res, body } = delivery.value;
        if (!res.ok) throw new Error(`refundable_http_${res.status}`);
        return parseRefundableCreditsResponse(body);
      })
      .then((result) => {
        if (!cancelled) {
          setRefundable(result.refundable);
          setRefundableStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRefundable(null);
          setRefundableStatus("error");
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, refundableRetry]);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    mutationLifecycleRef.current = controller;
    return () => {
      mountedRef.current = false;
      controller.abort(new Error("withdraw_section_unmounted"));
      if (mutationLifecycleRef.current === controller) {
        mutationLifecycleRef.current = null;
      }
    };
  }, []);

  const submit = async () => {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    const lifecycleSignal = mutationLifecycleRef.current?.signal;
    try {
      const requestBody = "{}";
      const deliver = async (
        signal: AbortSignal,
      ): Promise<ClientMutationEvidence<true>> => {
        const res = await fetch("/api/account/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal,
        });
        const responseBody =
          await readBoundedClientJsonResponse(res, signal);
        const out: unknown = responseBody.ok
          ? responseBody.value
          : null;
        if (res.ok && parseAccountDeletionHttpAck(out)) {
          return { kind: "confirmed", value: true };
        }
        const error =
          out &&
          typeof out === "object" &&
          !Array.isArray(out) &&
          typeof (out as Record<string, unknown>).error === "string"
            ? (out as Record<string, unknown>).error
            : null;
        // A replay after response loss is rejected by the non-deleted gate
        // only after the authoritative profile deletion is visible.
        if (res.status === 403 && error === "account_deleted") {
          return { kind: "confirmed", value: true };
        }
        if (
          clientMutationResponseNeedsReconciliation(res.status, res.ok)
        ) {
          return {
            kind: "unconfirmed",
            reason: "account_delete_response_unconfirmed",
            error,
          };
        }
        return {
          kind: "rejected",
          error: error ?? `account_delete_http_${res.status}`,
        };
      };
      const outcome = await runClientMutation({
        attempt: deliver,
        // admin_soft_delete_account is idempotent per withdrawal lifecycle;
        // the exact replay also turns account_deleted into deletion evidence.
        reconcile: deliver,
        signal: lifecycleSignal,
      });
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "confirmed") {
        try {
          await signOut(lifecycleSignal);
        } catch {
          if (mountedRef.current && !lifecycleSignal?.aborted) {
            setErr(
              "탈퇴 처리는 완료됐지만 로그아웃 확인에 실패했어요. 상단 계정 메뉴에서 로그아웃을 다시 시도해주세요.",
            );
          }
        }
        return;
      }
      if (mountedRef.current && !lifecycleSignal?.aborted) {
        const error =
          outcome.kind === "rejected" && typeof outcome.error === "string"
            ? outcome.error
            : null;
        setErr(
          error === "payment_pending"
            ? "진행 중인 결제가 있어요. 잠시 후 다시 시도해주세요."
            : error === "financial_cleanup_pending"
              ? "미해결 결제·환불 처리가 있어요. 먼저 처리를 완료해 주세요."
              : outcome.kind === "unconfirmed"
                ? "탈퇴 요청 결과를 확인하지 못했어요. 성공으로 간주하지 않았습니다. 페이지를 새로고침해 계정 상태를 확인해 주세요."
                : "탈퇴 처리에 실패했어요. 잠시 후 다시 시도해주세요."
        );
      }
    } catch {
      if (mountedRef.current && !lifecycleSignal?.aborted) {
        setErr("탈퇴 요청 결과를 확인하지 못했어요. 페이지를 새로고침해 계정 상태를 확인해 주세요.");
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current && !lifecycleSignal?.aborted) setBusy(false);
    }
  };

  return (
    <div className="border-t border-foreground/10 pt-6">
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setRefundableStatus("loading");
            setOpen(true);
          }}
          className="text-xs text-zinc-400 underline-offset-4 hover:text-red-500 hover:underline"
        >
          회원탈퇴
        </button>
      ) : (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <h3 className="text-sm font-bold text-red-500">회원탈퇴</h3>
          <div className="mt-2 space-y-1 text-xs text-zinc-500">
            <p>
              탈퇴하면 프로필 정보와 생성한 캐릭터 이미지·하이라이트는 삭제 또는 익명화되며,{" "}
              <b className="text-foreground">삭제된 데이터(캐릭터·하이라이트·생성권)는 되돌릴 수 없습니다.</b>{" "}
              (업로드한 원본 사진은 생성 직후 이미 폐기되어 보관하지 않습니다.)
            </p>
            <p>· 남은 생성권은 사용할 수 없으며 복구되지 않습니다.</p>
            <p>· 유료로 구매한 미사용 생성권은 탈퇴 전에 환불을 요청할 수 있습니다(이용약관 참조).</p>
            <p>· 점수·랭킹 등 개인을 식별할 수 없는 기록은 운영을 위해 익명 형태로 남을 수 있습니다.</p>
            <p>· (결제 이용 시) 결제 기록은 관련 법령에 따라 일정 기간 보존될 수 있습니다.</p>
            <p>· 탈퇴 후 재이용은 제한되며, 재이용을 원하면 고객센터로 문의해 주세요(계정만 복구되고 위 데이터는 복구되지 않습니다).</p>
          </div>
          {/* 동적 환불 안내 — 위 법률 고지 블록(byte-for-byte 보존, §11.5)과 분리된 별도 노드. */}
          {refundableStatus === "loading" && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-foreground/10 p-3 text-xs text-zinc-500">
              <Spinner className="h-3.5 w-3.5" />
              환불 가능한 생성권을 확인하고 있어요.
            </div>
          )}
          {refundableStatus === "error" && (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-500"
            >
              <p>환불 가능 수량을 확인하지 못했어요. 확인 후 탈퇴할 수 있습니다.</p>
              <button
                type="button"
                onClick={() => {
                  setRefundableStatus("loading");
                  setRefundableRetry((value) => value + 1);
                }}
                className="mt-2 font-semibold underline underline-offset-2"
              >
                다시 확인
              </button>
            </div>
          )}
          {refundableStatus === "ready" && refundable !== null && refundable > 0 && (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-zinc-500">
              <p>
                지금 환불 가능한 유료 생성권: <b className="text-foreground">{refundable}개</b>
              </p>
              <p className="mt-1">
                  탈퇴 전에 환불을 요청할 수 있어요(이용약관 참조). 주문·환불 상태는{" "}
                  <Link href="/account/payments" className="underline underline-offset-2">
                    결제내역
                  </Link>
                  에서 확인해주세요.
              </p>
            </div>
          )}
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            <span>위 내용을 이해했으며 삭제된 데이터는 되돌릴 수 없음에 동의합니다.</span>
          </label>
          <label
            id="withdraw-confirm-help"
            htmlFor="withdraw-confirm"
            className="mt-3 block text-xs text-zinc-500"
          >
            확인을 위해 <b className="text-foreground">회원탈퇴</b>를 입력하세요.
          </label>
          <input
            id="withdraw-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="회원탈퇴"
            aria-describedby="withdraw-confirm-help"
            disabled={busy}
            className="mt-1 w-full rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-red-500/40"
          />
          {err && (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {err}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setAck(false);
                setConfirm("");
                setErr(null);
              }}
              className="flex-1 rounded-full border border-foreground/15 ui-surface py-2 text-xs font-medium"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!ready || busy}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-red-500 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              탈퇴하기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
