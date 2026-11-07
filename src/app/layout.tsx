import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Web Planner — 중요한 일부터",
  description: "중요한 일을 선택하고, 하루를 기록하고, 다음 주의 방향을 정하는 개인 플래너입니다."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
