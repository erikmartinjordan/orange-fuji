import { json, normalizeDeviceId } from "../_shared/json.ts";
import { adminClient } from "../_shared/supabase.ts";

const PING_HASH_SALT = Deno.env.get("PING_HASH_SALT") || "orange-fuji-telemetry-v1";

async function hashDeviceId(deviceId: string) {
  const bytes = new TextEncoder().encode(`${PING_HASH_SALT}:${deviceId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sanitize(value: unknown, max = 60) {
  return String(value ?? "").trim().slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const payload = await req.json().catch(() => ({}));
  const deviceId = normalizeDeviceId(payload.deviceId);
  if (!deviceId) return json({ ok: false, error: "device_id_required" }, 400);

  const deviceHash = await hashDeviceId(deviceId);
  const appVersion = sanitize(payload.appVersion) || "unknown";
  const platform = sanitize(payload.platform) || "unknown";
  const osVersion = sanitize(payload.osVersion) || "unknown";
  const receivedAt = new Date().toISOString();

  const supabase = adminClient();
  const { error } = await supabase
    .from("app_pings")
    .upsert({
      device_hash: deviceHash,
      app_version: appVersion,
      platform,
      os_version: osVersion,
      day: receivedAt.slice(0, 10),
      last_seen_at: receivedAt,
    }, {
      onConflict: "device_hash,day",
    });

  if (error) {
    console.error("[usage-ping]", error);
    return json({ ok: false, error: "ping_store_failed" }, 500);
  }

  return json({ ok: true, receivedAt });
});
