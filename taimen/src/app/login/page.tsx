"use client";

import { useState } from "react";

/**
 * 로그인 — 내부 검수 콘솔이라 가입 링크가 없다 (계정은 관리자가 만든다).
 * 오류는 코드와 함께 그대로 보여 준다 — 가짜 성공 없음.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await res.json()) as { error?: { code: string; message: string } };
      if (!res.ok || payload.error) {
        setError(`${payload.error?.message ?? "로그인에 실패했습니다."} (${payload.error?.code ?? res.status})`);
        return;
      }
      window.location.href = "/today";
    } catch {
      setError("서버에 연결할 수 없습니다. (network_error)");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas">
      <form
        onSubmit={submit}
        className="flex w-[360px] flex-col gap-5 rounded-card border border-line bg-canvas p-8"
      >
        <div className="flex flex-col gap-1">
          <span className="flex items-end gap-1.5">
            <span className="display-num text-[28px] uppercase leading-none text-fg">
              Lead<span className="text-mint">Ops</span>
            </span>
            <span aria-hidden className="mb-[3px] block h-[5px] w-[5px] bg-mint" />
          </span>
          <span className="mono-label text-[9px]">Outbound Ops Console</span>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="mono-label text-[9px]">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 rounded-block border border-line bg-subtle px-3 text-sm text-fg outline-none focus:border-mint"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="mono-label text-[9px]">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 rounded-block border border-line bg-subtle px-3 text-sm text-fg outline-none focus:border-mint"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-block border border-violet-rule px-3 py-2 text-[12px] text-violet-bright">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="h-10 rounded-full bg-mint text-sm font-semibold text-ink transition-opacity disabled:opacity-50"
        >
          {busy ? "확인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}
