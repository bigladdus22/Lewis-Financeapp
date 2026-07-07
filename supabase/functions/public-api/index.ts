// SignalDesk public-api: validates x-api-key, rate-limits 30/min, returns the key owner's signals
// Deployed with verify_jwt = false (custom API-key auth below).
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const RATE_LIMIT = 30;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "x-api-key, content-type",
    },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(null, 204);

  const apiKey = req.headers.get("x-api-key");
  if (!apiKey?.startsWith("fd_")) return json({ error: "Missing or malformed x-api-key header." }, 401);

  const keyHash = await sha256Hex(apiKey);
  const { data: key, error: keyErr } = await supabase
    .from("api_keys")
    .select("id, user_id, revoked")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (keyErr) return json({ error: "Key lookup failed." }, 500);
  if (!key || key.revoked) return json({ error: "Invalid or revoked API key." }, 401);

  const bucket = new Date();
  bucket.setSeconds(0, 0);
  const { data: count } = await supabase.rpc("increment_usage", {
    p_key_id: key.id,
    p_bucket: bucket.toISOString(),
  });
  if ((count ?? 0) > RATE_LIMIT) {
    return json({ error: `Rate limit exceeded (${RATE_LIMIT}/minute). Try again shortly.` }, 429);
  }

  supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id).then(() => {});

  const { data: signals, error: sigErr } = await supabase
    .from("signals")
    .select("ticker, signal, confidence, rationale, generated_at")
    .eq("user_id", key.user_id)
    .order("generated_at", { ascending: false })
    .limit(50);

  if (sigErr) return json({ error: "Could not load signals." }, 500);
  return json({ signals: signals ?? [], generated_at: new Date().toISOString() });
});
