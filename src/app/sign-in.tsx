"use client";

import { useEffect, useState } from "react";

export function SignIn({ enabled, paused = false }: { enabled: boolean; paused?: boolean }) {
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(enabled ? "Google 계정으로 안전하게 시작하세요." : "로그인은 준비 중입니다.");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    if (new URLSearchParams(window.location.search).has("auth")) setMessage("로그인을 완료하지 못했습니다. 다시 시도해주세요.");
    fetch("/api/session", { cache: "no-store" }).then(async result => {
      if (result.ok && active) { setSignedIn(true); setMessage("로그인되었습니다. 플래너 기능을 준비 중입니다."); }
    }).catch(() => { if (active) setMessage("연결을 확인하고 다시 시도해주세요."); });
    return () => { active = false; };
  }, [enabled]);

  async function signIn() {
    setBusy(true); setMessage("Google 로그인으로 이동합니다.");
    try {
      const response = await fetch("/api/auth/sign-in/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "google", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      if (!response.ok) throw new Error("Sign-in unavailable");
      const url = new URL((await response.json()).url);
      if (url.origin !== "https://accounts.google.com") throw new Error("Invalid login destination");
      window.location.assign(url.href);
    } catch { setMessage("로그인을 시작하지 못했습니다. 잠시 후 다시 시도해주세요."); setBusy(false); }
  }
  async function signOut() {
    setBusy(true);
    try {
      const current = await fetch("/api/session", { cache: "no-store" });
      const token = current.ok ? (await current.json()).csrfToken : undefined;
      const result = await fetch("/api/logout", { method: "POST", headers: token ? { "X-CSRF-Token": token } : {} });
      if (!result.ok) throw new Error("Logout unavailable");
      window.location.replace("/");
    } catch { setMessage("로그아웃을 완료하지 못했습니다. 다시 시도해주세요."); setBusy(false); }
  }
  return <div className="sign-in">
    <button type="button" className="google-button" disabled={!enabled || busy} aria-describedby="sign-in-status" onClick={signedIn ? signOut : signIn}>
      <span className="google-letter" aria-hidden="true">G</span>
      {signedIn ? "로그아웃 / 계정 바꾸기" : "Google로 시작하기"}
    </button>
    <p id="sign-in-status" role="status">{paused ? "로그인이 일시 중지되었습니다." : message}</p>
  </div>;
}
