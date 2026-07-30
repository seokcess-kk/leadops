/**
 * CSV 직렬화.
 *
 * ❗ **수식 주입(CSV injection) 을 막는다.** 업체명은 공공 API 에서 온 외부 문자열이고,
 *    `=`·`+`·`-`·`@`·탭·캐리지리턴으로 시작하는 셀은 Excel·Sheets 가 **수식으로 실행**한다
 *    (`=HYPERLINK`·`=WEBSERVICE` 로 데이터가 외부로 나갈 수 있다). 앞에 `'` 를 붙여 무력화한다.
 *
 * ❗ BOM 을 붙인다. 없으면 Excel 이 UTF-8 한글을 깨뜨린다.
 */

const RISKY_PREFIX = /^[=+\-@\t\r]/;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  const guarded = RISKY_PREFIX.test(raw) ? `'${raw}` : raw;
  // 구분자·따옴표·줄바꿈이 있으면 감싸고, 안쪽 따옴표는 두 번 쓴다 (RFC 4180).
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: readonly T[], columns: ReadonlyArray<CsvColumn<T>>): string {
  const lines = [columns.map((c) => cell(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(","));
  // CRLF — RFC 4180 이고 Excel 이 가장 덜 틀린다.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** 브라우저에서 파일로 내려준다. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
