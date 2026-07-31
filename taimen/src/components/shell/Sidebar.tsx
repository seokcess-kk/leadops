"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type ApiMe } from "@/lib/data/client";

interface NavItem {
  href: string;
  label: string;
  soon?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: "Discover",
    items: [
      { href: "/today", label: "Scout" },
      { href: "/leads", label: "Approved Leads" },
    ],
  },
  {
    label: "Engage",
    items: [
      { href: "/outreach", label: "Outreach", soon: true },
      { href: "/pipeline", label: "Pipeline", soon: true },
      { href: "/insights", label: "Insights", soon: true },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/industries", label: "Industries" },
      { href: "/runs", label: "Run History" },
      { href: "/privacy", label: "Privacy" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

/**
 * 좌측 고정 사이드바.
 * 활성 메뉴 = 민트 1px 좌측 라인 + 작은 민트 상태점 (요구 스펙 그대로).
 * 워드마크는 이 제품에서 디스플레이 폰트가 허용된 두 자리 중 하나.
 */
export function Sidebar() {
  const pathname = usePathname();

  // ❗ 하드코딩하지 않는다. 실패·로딩 중에는 가짜 이름 대신 `—` 를 보여 준다.
  const [me, setMe] = useState<ApiMe | null>(null);
  useEffect(() => {
    api.me().then((r) => setMe(r.data)).catch(() => setMe(null));
  }, []);
  const roleLabel = me === null ? "—" : me.role === "admin" ? "Admin" : me.role === "user" ? "Reviewer" : me.role;

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[232px] flex-col border-r border-line bg-canvas">
      {/* 워드마크 */}
      <Link href="/today" className="flex flex-col gap-1 px-6 pb-6 pt-7">
        <span className="flex items-end gap-1.5">
          <span className="display-num text-[28px] uppercase leading-none text-fg">
            Lead<span className="text-mint">Ops</span>
          </span>
          <span aria-hidden className="mb-[3px] block h-[5px] w-[5px] bg-mint" />
        </span>
        <span className="mono-label text-[9px]">Outbound Ops Console</span>
      </Link>

      {/* 내비게이션 */}
      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 pb-4">
        {NAV.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <span className="mono-label px-3 pb-1 text-[9px]">{group.label}</span>
            {group.items.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex h-9 items-center justify-between rounded-r-full px-3 text-sm transition-colors duration-150 ${
                    active
                      ? "border-l border-mint pl-[11px] font-medium text-fg"
                      : "text-fg-2 hover:text-hoverlink"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {item.label}
                    {active && <span aria-hidden className="block h-1 w-1 rounded-full bg-mint" />}
                  </span>
                  {item.soon && (
                    <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.2em] text-fg-2">
                      Soon
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* 사용자 — /api/me. fixture 모드·인증 실패 시 — 표시 */}
      <div className="flex items-center gap-3 border-t border-line px-5 py-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface text-xs font-semibold text-fg-3">
          {me?.email?.[0]?.toUpperCase() ?? "—"}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-fg-3">{me?.email ?? "—"}</span>
          <span className="mono-label text-[8px]">{roleLabel}</span>
        </div>
      </div>
    </aside>
  );
}
