"use client";

import { useEffect, useState } from "react";
import { Planner } from "../planner";
import { createDemoTransport } from "./transport";

export function DemoPlanner() {
  const [transport, setTransport] = useState<ReturnType<typeof createDemoTransport> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    try { setTransport(createDemoTransport(window.sessionStorage)); }
    catch { setError(true); }
  }, []);
  if (!transport) return <main id="main" className="planner"><p role={error ? "alert" : "status"}>{error ? "이 탭의 테스트 저장소를 열 수 없습니다. 브라우저 저장 허용 설정을 확인하거나 새 탭에서 다시 열어주세요." : "테스트 플래너를 준비하고 있습니다."}</p><a href="/">홈으로 돌아가기</a></main>;
  return <Planner initialSession={transport.initialSession} request={transport.request} demo />;
}
