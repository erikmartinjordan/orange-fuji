import { adminClient } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
};

function respond(body: unknown, status = 200, cache = "public, max-age=300") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cache,
      ...CORS,
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return respond({ ok: true });
  if (req.method !== "GET") return respond({ ok: false, error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const requested = Number(url.searchParams.get("days"));
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : 90, 7), 365);

  const supabase = adminClient();
  const { data, error } = await supabase.rpc("metrics_active_snapshot", { days });

  if (error) {
    console.error("[public-metrics]", error);
    return respond({ ok: false, error: "metrics_query_failed" }, 500, "no-store");
  }

  return respond({ ok: true, metrics: data, generatedAt: new Date().toISOString() });
});
