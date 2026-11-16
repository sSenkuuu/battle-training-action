// upload.mjs — upload a controller as a new version of a battle.training bot.
//
//   POST {apiBase}/api/bots/<bot>/versions {"label": "v1", "source": "<js>"}
//   Authorization: Bearer <key>
//
// The upload runs the arena's 400-tick smoke test; if it fails the version
// is not activated. The API key is passed in by the caller and never logged.

export async function uploadVersion({ apiBase, apiKey, bot, label, source }) {
  const url = `${apiBase.replace(/\/$/, "")}/api/bots/${encodeURIComponent(bot)}/versions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "battle-training-action/1.0",
    },
    body: JSON.stringify({ label, source }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`upload returned HTTP ${res.status} (non-JSON): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`upload returned HTTP ${res.status}: ${data.error ?? data.message ?? text.slice(0, 200)}`);
  }
  // The API reports the smoke test in the version object; surface it plainly.
  const version = data.version ?? data;
  return {
    ok: true,
    versionId: version.id ?? version.versionId ?? null,
    label: version.label ?? label,
    active: version.active ?? null,
    smoke: version.smokeTest ?? version.smoke ?? "passed",
    raw: data,
  };
}
