import { readAuthConfiguration } from "@/server/config";
import { SignIn } from "./sign-in";

export const dynamic = "force-dynamic";
export default function Home() {
  let authReady = false;
  try { readAuthConfiguration(process.env, process.env.NODE_ENV === "production"); authReady = true; } catch { /* Setup has not completed. */ }
  return (
    <>
      <a className="skip-link" href="#main">본문으로 건너뛰기</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Web Planner 홈">
          <span className="brand-mark" aria-hidden="true">w.</span>
          <span>Web Planner</span>
        </a>
        <span className="header-note">나의 시간, 나의 방향</span>
      </header>
      <main id="main" className="landing">
        <section className="introduction" aria-labelledby="page-title">
          <p className="eyebrow">A LITTLE SPACE FOR WHAT MATTERS</p>
          <h1 id="page-title">나의 하루를,<br /><span>중요한 일부터.</span></h1>
          <p className="lead">해야 할 일 사이에서, 하고 싶은 삶을 잊지 않도록.<br className="desktop-break" /> 계획과 기록, 돌아보는 시간을 한곳에 담으세요.</p>
          <SignIn enabled={authReady} />
        </section>
        <section className="principles" aria-label="플래너가 지향하는 세 가지 습관">
          <div className="paper-heading"><span>나를 위한 작은 습관</span><span aria-hidden="true">↗</span></div>
          <article><span className="step-number">01</span><div><h2>중요한 것을 고르기</h2><p>많은 할 일보다, 나에게 의미 있는 한 가지.</p></div></article>
          <article><span className="step-number">02</span><div><h2>생각을 가볍게 남기기</h2><p>해야 할 일도, 문득 떠오른 생각도 잊기 전에.</p></div></article>
          <article><span className="step-number">03</span><div><h2>나의 방향 돌아보기</h2><p>지나간 하루에서 다음 주의 힌트를 찾으세요.</p></div></article>
          <p className="paper-footer">조금 덜 바쁘게, 조금 더 나답게.</p>
        </section>
      </main>
      <footer className="site-footer"><span>계획하고, 기록하고, 돌아보는 나의 공간.</span><span>Web Planner</span></footer>
    </>
  );
}
