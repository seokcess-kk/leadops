"use client";

import type { ReactNode } from "react";
import { ReviewProvider } from "@/lib/data/store";
import { Sidebar } from "./Sidebar";

/**
 * 앱 셸: 좌측 고정 사이드바 + 중앙 데이터 영역.
 * 우측 리드 상세 드로어는 화면(오늘의 검수)에서 셸 위로 띄운다.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ReviewProvider>
      <Sidebar />
      <div className="flex min-h-dvh flex-col pl-[232px]">{children}</div>
    </ReviewProvider>
  );
}
