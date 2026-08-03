"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ReviewProvider } from "@/lib/data/store";
import { Sidebar } from "./Sidebar";

/**
 * 앱 셸: 좌측 고정 사이드바 + 중앙 데이터 영역.
 * 우측 리드 상세 드로어는 화면(오늘의 검수)에서 셸 위로 띄운다.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // 로그인 화면은 콘솔 셸 밖이다 — 비로그인 방문자에게 사이드바·데이터 fetch 를 노출하지 않는다.
  if (pathname === "/login") return <>{children}</>;
  return (
    <ReviewProvider>
      <Sidebar />
      <div className="flex min-h-dvh flex-col pl-[232px]">{children}</div>
    </ReviewProvider>
  );
}
