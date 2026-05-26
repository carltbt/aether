// ============================================================================
// Aether — smoke-test Edge Function
// ============================================================================
// But : valider en un seul appel que (1) les secrets sont posés ET (2) les 3
// APIs externes répondent réellement avec les clés actuelles.
//
// Sécurité : ne retourne JAMAIS les valeurs des secrets. Pour les réponses
// API, on ne renvoie qu'un échantillon minimal (statut marché, prix AAPL,
// echo "PONG" de Claude) — rien de sensible.
//
// Conçu comme diagnostic permanent — peut rester en place pour le run de la
// vie du projet. Coût d'invocation : ~$0.001 (Anthropic mini-complétion).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const REQUIRED_SECRETS = [
  "ALPACA_API_KEY_ID",
  "ALPACA_API_SECRET_KEY",
  "ALPACA_API_BASE_URL",
  "ANTHROPIC_API_KEY",
  "FMP_API_KEY",
] as const;

function checkSecrets() {
  const secrets: Record<string, { present: boolean; length: number }> = {};
  let all_present = true;
  for (const name of REQUIRED_SECRETS) {
    const v = Deno.env.get(name);
    const present = v !== undefined && v.length > 0;
    if (!present) all_present = false;
    secrets[name] = { present, length: v?.length ?? 0 };
  }
  return { all_present, secrets };
}

async function checkAlpaca() {
  const base = Deno.env.get("ALPACA_API_BASE_URL");
  const keyId = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!base || !keyId || !secret) return { ok: false, error: "missing_env_vars" };

  try {
    const r = await fetch(`${base}/v2/clock`, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
      },
    });
    if (!r.ok) {
      return { ok: false, status: r.status, body: (await r.text()).slice(0, 300) };
    }
    const data = await r.json();
    return {
      ok: true,
      sample: {
        is_open: data.is_open,
        timestamp: data.timestamp,
        next_open: data.next_open,
      },
    };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function checkFmp() {
  const key = Deno.env.get("FMP_API_KEY");
  if (!key) return { ok: false, error: "missing_env_vars" };

  try {
    const r = await fetch(
      `https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=${key}`,
    );
    if (!r.ok) {
      return { ok: false, status: r.status, body: (await r.text()).slice(0, 300) };
    }
    const data = await r.json();
    const first = Array.isArray(data) ? data[0] : data;
    return {
      ok: !!first?.symbol,
      sample: {
        symbol: first?.symbol,
        price: first?.price,
        change_pct: first?.changesPercentage ?? first?.changePercentage,
      },
    };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function checkAnthropic() {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, error: "missing_env_vars" };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 20,
        messages: [
          {
            role: "user",
            content: "Reply with exactly the word PONG and nothing else.",
          },
        ],
      }),
    });
    if (!r.ok) {
      return { ok: false, status: r.status, body: (await r.text()).slice(0, 500) };
    }
    const data = await r.json();
    const text = data.content?.[0]?.text?.trim();
    return {
      ok: true,
      sample: {
        model: data.model,
        text,
        usage: data.usage,
      },
    };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

Deno.serve(async () => {
  // Stage 1 : presence
  const secretCheck = checkSecrets();
  if (!secretCheck.all_present) {
    return new Response(
      JSON.stringify(
        {
          all_ok: false,
          stage: "secrets_presence",
          secrets: secretCheck.secrets,
        },
        null,
        2,
      ),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    );
  }

  // Stage 2 : real API pings en parallèle
  const [alpaca, fmp, anthropic] = await Promise.all([
    checkAlpaca(),
    checkFmp(),
    checkAnthropic(),
  ]);

  const all_ok = alpaca.ok && fmp.ok && anthropic.ok;

  return new Response(
    JSON.stringify(
      {
        all_ok,
        stage: "api_pings",
        secrets: secretCheck.secrets,
        apis: { alpaca, fmp, anthropic },
      },
      null,
      2,
    ),
    {
      headers: { "Content-Type": "application/json" },
      status: all_ok ? 200 : 500,
    },
  );
});
