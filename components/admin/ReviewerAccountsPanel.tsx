"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { fmtKst } from "@/lib/admin-format";

export type ReviewerRow = {
  user_id: string;
  email: string;
  active: boolean;
  note: string | null;
  created_at: string;
};

/**
 * 심사 계정 CUD 패널 — 생성(이메일 입력 → 서버가 비번 생성)·비번 재설정·활성 토글·삭제.
 * 비밀번호는 생성/재설정 응답에서 **1회만** 표시(서버 미저장) — PG 회신 메일에 붙여넣고 닫으면 끝.
 * 처리 후 router.refresh 로 서버 재조회(다른 admin 표들과 동일 패턴 — 로컬 상태 드리프트 없음).
 */
export function ReviewerAccountsPanel({ initialRows }: { initialRows: ReviewerRow[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "create" | userId
  const [error, setError] = useState<string | null>(null);
  // 마지막 발급 자격증명(1회 표시) — {email, password}
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  const call = async (
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
    busyKey: string
  ): Promise<{ ok: boolean; password?: string; error?: string }> => {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await fetch("/api/admin/reviewers", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        password?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error ?? "요청 실패" };
      }
      return { ok: true, password: data.password };
    } catch {
      return { ok: false, error: "네트워크 오류" };
    } finally {
      setBusy(null);
    }
  };

  const ERROR_LABEL: Record<string, string> = {
    invalid_email: "이메일 형식이 올바르지 않아요.",
    email_exists: "이미 존재하는 계정 이메일이에요.",
    create_failed: "계정 생성에 실패했어요.",
    update_failed: "변경에 실패했어요.",
    delete_failed: "삭제에 실패했어요.",
  };

  const onCreate = async () => {
    const r = await call("POST", { email, note }, "create");
    if (!r.ok) return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    if (r.password) setIssued({ email: email.trim().toLowerCase(), password: r.password });
    setEmail("");
    setNote("");
    router.refresh();
  };

  const onResetPw = async (row: ReviewerRow) => {
    const r = await call("PATCH", { userId: row.user_id, action: "reset_password" }, row.user_id);
    if (!r.ok) return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    if (r.password) setIssued({ email: row.email, password: r.password });
  };

  const onToggle = async (row: ReviewerRow) => {
    const r = await call(
      "PATCH",
      { userId: row.user_id, action: "set_active", active: !row.active },
      row.user_id
    );
    if (!r.ok) return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    router.refresh();
  };

  const onDelete = async (row: ReviewerRow) => {
    if (!window.confirm(`${row.email} 계정을 삭제할까요?\n(로그인 차단 + 목록 제거 — 주문 기록은 보존)`)) return;
    const r = await call("DELETE", { userId: row.user_id }, row.user_id);
    if (!r.ok) return setError(ERROR_LABEL[r.error ?? ""] ?? r.error ?? "실패");
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      {issued && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
          <p className="font-semibold text-emerald-500">발급된 로그인 정보 — 지금만 표시돼요(서버 미저장)</p>
          <p className="mt-2 font-mono text-[13px]">
            ID: {issued.email}
            <br />
            PW: {issued.password}
          </p>
          <p className="mt-2 text-xs text-zinc-500">
            진입 경로: <code>/login?reviewer=1</code> → 아이디/비밀번호 입력. 분실 시 비번 재설정으로 재발급.
          </p>
          <button
            type="button"
            onClick={() => setIssued(null)}
            className="mt-3 rounded-md border border-foreground/15 px-2 py-1 text-xs hover:bg-foreground/5"
          >
            닫기
          </button>
        </div>
      )}

      <div className="rounded-xl border border-foreground/10 ui-surface p-4">
        <p className="text-sm font-semibold">새 심사 계정</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="pg-review@boss-paegi.app"
            className="flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="메모(예: 카카오페이 심사용)"
            className="flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={!!busy || !email.trim()}
            onClick={() => void onCreate()}
            className="flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-paper-2 disabled:opacity-50"
          >
            {busy === "create" && <Spinner className="h-4 w-4" />}
            생성(비번 자동발급)
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}

      {initialRows.length === 0 ? (
        <p className="text-sm text-zinc-400">등록된 심사 계정이 없어요.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-foreground/10">
          <table className="w-full text-left text-xs">
            <thead className="ui-surface text-zinc-500">
              <tr>
                <th className="px-2 py-1.5">이메일</th>
                <th className="px-2 py-1.5">상태</th>
                <th className="px-2 py-1.5">메모</th>
                <th className="px-2 py-1.5">생성(KST)</th>
                <th className="px-2 py-1.5">액션</th>
              </tr>
            </thead>
            <tbody>
              {initialRows.map((r) => (
                <tr key={r.user_id} className="border-t border-foreground/5">
                  <td className="px-2 py-1.5 font-mono">
                    <Link
                      href={`/admin/users/${r.user_id}`}
                      className="text-sky-600 underline-offset-2 hover:underline"
                      title="회원 상세로 이동 (첫 로그인·동의 전 계정은 비회원으로 표시)"
                    >
                      {r.email}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5">
                    {r.active ? (
                      <span className="font-semibold text-emerald-500">활성</span>
                    ) : (
                      <span className="text-zinc-400">비활성(로그인 차단)</span>
                    )}
                  </td>
                  <td className="max-w-[10rem] truncate px-2 py-1.5">{r.note ?? "—"}</td>
                  <td className="px-2 py-1.5 tabular-nums">{fmtKst(r.created_at)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void onResetPw(r)}
                        className="rounded-md border border-foreground/15 px-2 py-1 text-[11px] hover:bg-foreground/5 disabled:opacity-50"
                      >
                        {busy === r.user_id ? <Spinner className="h-3 w-3" /> : "비번 재설정"}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void onToggle(r)}
                        className="rounded-md border border-foreground/15 px-2 py-1 text-[11px] hover:bg-foreground/5 disabled:opacity-50"
                      >
                        {r.active ? "비활성화" : "재활성화"}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void onDelete(r)}
                        className="rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
