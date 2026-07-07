// SignalDesk generate-signal v2: multi-indicator quantitative ensemble.
// Indicators: momentum, RSI(14), MACD(12/26/9), SMA20/50 trend, annualised volatility.
// Supports range (1M/3M/6M/1Y) and display-currency conversion via live FX.
// store=false recomputes without writing a new history row (used when switching range/currency).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });
const preflight = () => new Response(null, { status: 204, headers: cors });

const RANGES: Record<string, string> = { "1M": "1mo", "3M": "3mo", "6M": "6mo", "1Y": "1y" };
const CCYS = ["USD", "GBP", "EUR"];

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

function sma(a: number[], n: number): (number | null)[] {
  return a.map((_, i) => (i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n));
}
function emaSeries(a: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  a.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}
function rsi(a: number[], n = 14): number {
  if (a.length < n + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = a.length - n; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / n / (loss / n);
  return 100 - 100 / (1 + rs);
}

async function fetchCloses(symbol: string, range: string): Promise<{ closes: number[]; stamps: number[]; ccy: string }> {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
    { headers: { "user-agent": "Mozilla/5.0" } },
  );
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  const raw: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
  const ts: number[] = result?.timestamp ?? [];
  const closes: number[] = [], stamps: number[] = [];
  raw.forEach((c, i) => { if (c != null) { closes.push(c); stamps.push(ts[i] ?? 0); } });
  return { closes, stamps, ccy: result?.meta?.currency ?? "" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not authenticated." }, 401);

  let ticker = "", rangeKey = "3M", reqCcy = "", store = true;
  try {
    const body = await req.json();
    ticker = String(body.ticker ?? "").trim().toUpperCase();
    if (RANGES[String(body.range ?? "").toUpperCase()]) rangeKey = String(body.range).toUpperCase();
    if (CCYS.includes(String(body.currency ?? "").toUpperCase())) reqCcy = String(body.currency).toUpperCase();
    if (body.store === false) store = false;
  } catch (_) { /* fallthrough */ }
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) return json({ error: "Provide a valid ticker, e.g. AAPL or BP.L" }, 400);

  // ---- price history ----
  let closes: number[] = [], stamps: number[] = [], assetCcy = "", source = "yahoo";
  try {
    ({ closes, stamps, ccy: assetCcy } = await fetchCloses(ticker, RANGES[rangeKey]));
  } catch (_) { /* fall back below */ }

  if (closes.length < 15) {
    source = "simulated"; assetCcy = assetCcy || "USD";
    let p = 100; const now = Math.floor(Date.now() / 1000);
    const days = { "1M": 22, "3M": 63, "6M": 126, "1Y": 252 }[rangeKey]!;
    closes = []; stamps = [];
    for (let i = 0; i < days; i++) {
      p = p * (1 + Math.sin(i * 0.7 + ticker.length) * 0.012);
      closes.push(p); stamps.push(now - (days - i) * 86400);
    }
  }

  // LSE quotes arrive in pence (GBp) — normalise to pounds
  if (assetCcy === "GBp") { closes = closes.map((c) => c / 100); assetCcy = "GBP"; }

  // ---- currency conversion ----
  let fxRate = 1, displayCcy = assetCcy;
  if (reqCcy && reqCcy !== assetCcy) {
    try {
      const fx = await fetchCloses(`${assetCcy}${reqCcy}=X`, "5d");
      if (fx.closes.length) {
        fxRate = fx.closes[fx.closes.length - 1];
        closes = closes.map((c) => c * fxRate);
        displayCcy = reqCcy;
      }
    } catch (_) { /* keep native currency */ }
  }
  closes = closes.map((c) => +c.toFixed(4));

  // ---- indicator ensemble (currency-invariant: all ratios) ----
  const last = closes[closes.length - 1];
  const momentum = (last - closes[0]) / closes[0];
  const back10 = closes[Math.max(0, closes.length - 10)];
  const recent = (last - back10) / back10;
  const rsiVal = rsi(closes);
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const macdSig = emaSeries(macdLine, 9);
  const macdHist = macdLine[macdLine.length - 1] - macdSig[macdSig.length - 1];
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const s20v = s20[s20.length - 1], s50v = s50[s50.length - 1];
  const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) * Math.sqrt(252);

  const fMomentum = clamp(momentum * 8);
  const fRecent = clamp(recent * 12);
  const fMacd = clamp(macdHist / (last * 0.005));
  const fRsi = rsiVal > 70 ? -clamp((rsiVal - 70) / 20) : rsiVal < 30 ? clamp((30 - rsiVal) / 20) : clamp((rsiVal - 50) / 40);
  const fTrend = s20v != null && s50v != null ? clamp(((s20v - s50v) / s50v) * 25) : clamp(fMomentum * 0.5);

  const score = fMomentum * 0.30 + fRecent * 0.20 + fMacd * 0.20 + fRsi * 0.15 + fTrend * 0.15;
  const signal = score > 0.12 ? "buy" : score < -0.12 ? "sell" : "hold";
  const confidence = +Math.min(0.93, 0.5 + Math.abs(score) * 0.55).toFixed(3);

  const verdict = (f: number) => (f > 0.15 ? "bullish" : f < -0.15 ? "bearish" : "neutral");
  const indicators = [
    { name: `Momentum (${rangeKey})`, value: `${(momentum * 100).toFixed(1)}%`, verdict: verdict(fMomentum) },
    { name: "RSI (14)", value: rsiVal.toFixed(1), verdict: verdict(fRsi) },
    { name: "MACD histogram", value: macdHist.toFixed(3), verdict: verdict(fMacd) },
    { name: "SMA 20 vs 50", value: s20v != null && s50v != null ? `${(((s20v - s50v) / s50v) * 100).toFixed(2)}%` : "n/a", verdict: verdict(fTrend) },
    { name: "Volatility (ann.)", value: `${(vol * 100).toFixed(1)}%`, verdict: vol > 0.45 ? "bearish" : "neutral" },
  ];

  const drivers = indicators.filter((i) => i.verdict !== "neutral").map((i) => `${i.name} ${i.verdict}`);
  const rationale =
    `${ticker} scores ${score.toFixed(2)} on the 5-indicator ensemble over ${rangeKey}` +
    (drivers.length ? ` — driven by ${drivers.slice(0, 3).join(", ")}.` : " — indicators are broadly neutral.") +
    ` Verdict: ${signal.toUpperCase()}.`;

  let generated_at = new Date().toISOString();
  if (store) {
    const { data: row, error: insErr } = await supabase
      .from("signals")
      .insert({ user_id: userData.user.id, ticker, signal, confidence, rationale })
      .select("generated_at")
      .single();
    if (insErr) return json({ error: "Could not store signal: " + insErr.message }, 500);
    generated_at = row.generated_at;
  }

  return json({
    ticker, signal, confidence, rationale, indicators, score: +score.toFixed(3),
    closes, timestamps: stamps, currency: displayCcy, fx_rate: fxRate, source,
    range: rangeKey, last_close: last, generated_at, stored: store,
  });
});
