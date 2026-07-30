/**
 * 표시 포맷.
 *
 * ❗ 시각은 전부 **Asia/Seoul** 로 그린다. 서버는 UTC 로 주고 운영 경계(일 상한·실행 날짜)도
 *    서울 날짜 기준이므로, 브라우저 로컬 시간으로 그리면 화면과 카운터가 어긋난다.
 * ❗ `null` 은 `—` 다. 0 이나 빈 문자열로 바꾸지 않는다 (설계서 A.6).
 */

const DASH = "—";

const timeFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `2026-07-30T07:39:59.369Z` → `16:39` (KST) */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : timeFmt.format(d);
}

const dateFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" });

/** `2026-07-30T00:00:00.000Z` → `2026-07-30` (KST) */
export function ymd(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : dateFmt.format(d);
}

export function krw(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `₩${Math.round(value).toLocaleString("ko-KR")}`
    : DASH;
}

export function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ko-KR") : DASH;
}

/** uuid 를 화면에 쓸 짧은 라벨로. 전체는 툴팁·복사로 남긴다. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8).toUpperCase() : DASH;
}

export { DASH };
