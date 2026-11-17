// Operator notification email via Resend. Never throws: a failed email must not fail a request.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const HUB = "https://wise-ai.au/os/";

export async function notify(db: SupabaseClient, subject: string, text: string, hash: string): Promise<boolean> {
  try {
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return false;
    const { data } = await db.from("settings").select("notify_email").eq("id", 1).single();
    const to = data?.notify_email?.trim();
    if (!to) return false;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Wise AI OS <dailybrief@wise-ai.au>",
        to: [to],
        subject: subject.slice(0, 150),
        text: `${text}\n\nOpen: ${HUB}#${hash.replace(/^#/, "")}\n`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error("notify failed", res.status);
    return res.ok;
  } catch (e) {
    console.error("notify error", (e as Error).message);
    return false;
  }
}
