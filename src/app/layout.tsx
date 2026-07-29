import type { Metadata } from "next";
import "pretendard/dist/web/variable/pretendardvariable.css";
import "@fontsource/anton";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";

export const metadata: Metadata = {
  title: "LeadOps — Outbound Ops Console",
  description: "검색 점유 공백 업체를 발굴·검수해 영업 리드로 승인하는 사내 콘솔",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
