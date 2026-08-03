import { supabaseServer } from "@/lib/server/supabase";

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function POST(): Promise<Response> {
  const supabase = await supabaseServer();
  // 미구성이어도 로그아웃은 성공으로 답한다 — 지울 세션 자체가 없다.
  if (supabase) await supabase.auth.signOut();
  return json(200, { data: { ok: true } });
}
