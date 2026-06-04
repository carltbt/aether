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

  // PAPER vs LIVE — the host is the only determinant (not a secret).
  //   paper-api.alpaca.markets → PAPER (no real money)
  //   api.alpaca.markets       → LIVE  (real money) 🚨
  let host = "unparseable";
  let env: "PAPER" | "LIVE" | "UNKNOWN" = "UNKNOWN";
  try {
    host = new URL(base).host;
    if (host.startsWith("paper-api.")) env = "PAPER";
    else if (host === "api.alpaca.markets") env = "LIVE";
  } catch { /* keep defaults */ }

  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };

  try {
    const [clockR, acctR] = await Promise.all([
      fetch(`${base}/v2/clock`, { headers }),
      fetch(`${base}/v2/account`, { headers }),
    ]);
    if (!clockR.ok) {
      return { ok: false, host, env, status: clockR.status, body: (await clockR.text()).slice(0, 300) };
    }
    const clock = await clockR.json();
    // Account snapshot — account_number masked, no secrets.
    let account: Record<string, unknown> | undefined;
    if (acctR.ok) {
      const a = await acctR.json();
      const num = String(a.account_number ?? "");
      account = {
        account_number_masked: num ? `${num.slice(0, 3)}***${num.slice(-2)}` : null,
        status: a.status,
        cash: a.cash,
        portfolio_value: a.portfolio_value,
        buying_power: a.buying_power,
        pattern_day_trader: a.pattern_day_trader,
        // Alpaca paper accounts always return crypto_status etc; the env above is authoritative.
      };
    }
    return {
      ok: true,
      host,
      env,                       // 👈 PAPER / LIVE / UNKNOWN — the answer
      sample: { is_open: clock.is_open, timestamp: clock.timestamp, next_open: clock.next_open },
      account,
    };
  } catch (e) {
    return { ok: false, host, env, error: String((e as Error).message ?? e) };
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
