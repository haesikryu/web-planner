import { notFound } from "next/navigation";
import { isLocalDemoEnabled } from "@/server/demo";
import { DemoPlanner } from "./demo-planner";

export const dynamic = "force-dynamic";

export default function DemoPage() {
  if (!isLocalDemoEnabled(process.env)) notFound();
  return <>
    <a className="skip-link" href="#main">본문으로 건너뛰기</a>
    <header className="site-header"><a className="wordmark" href="/" aria-label="w. Web Planner 홈"><span className="brand-mark" aria-hidden="true">w.</span><span>Web Planner</span></a><span className="header-note">나의 시간, 나의 방향</span></header>
    <DemoPlanner />
  </>;
}
