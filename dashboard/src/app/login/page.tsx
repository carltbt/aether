"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "signing_in" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("signing_in");
    setErrorMsg("");

    const resp = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!resp.ok) {
      setStatus("error");
      const data = await resp.json().catch(() => ({}));
      setErrorMsg(data.error === "invalid_code" ? "Wrong code" : "Authentication failed");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-12 text-center">
          <div className="inline-block bg-brand-gradient text-white font-mono font-bold text-2xl px-4 py-2 rounded-lg tracking-tight">
            AETHER
          </div>
          <p className="mt-3 text-sm text-slate-500">AI trading system — mid-cap US</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-8 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="code" className="block text-xs font-medium text-slate-700 mb-1.5">
                Access code
              </label>
              <input
                id="code"
                type="password"
                required
                autoFocus
                autoComplete="off"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                disabled={status === "signing_in"}
                placeholder="••••••"
                className="w-full px-3 py-3 text-center text-lg border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent disabled:bg-slate-50 disabled:cursor-not-allowed font-mono tracking-[0.5em]"
              />
            </div>

            <button
              type="submit"
              disabled={status === "signing_in" || code.length !== 6}
              className="w-full bg-brand-gradient text-white text-sm font-medium py-2.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === "signing_in" ? "Signing in..." : "Sign in"}
            </button>

            {status === "error" && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-center">
                {errorMsg}
              </p>
            )}
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Private system. Unauthorized access prohibited.
        </p>
      </div>
    </main>
  );
}
