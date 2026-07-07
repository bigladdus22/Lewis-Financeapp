// SignalDesk — application logic (real Supabase backend)
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const PUBLIC_API = `${SUPABASE_URL}/functions/v1/public-api`;

const $ = (id) => document.getElementById(id);
const showErr = (id, msg) => { $(id).textContent = msg; $(id).hidden = false; };
const hideErr = (id) => { $(id).hidden = true; };

const state = {
  authMode: "signin",
  tab: "analyse",
  lang: "curl",
  newestKey: null, // full key, held in memory only, cleared on reload
  lastChart: null,
};

/* ---------------- routing ---------------- */
function show(screen) {
  ["auth", "pay", "app"].forEach((s) => ($("screen-" + s).hidden = s !== screen));
}

async function route() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return show("auth");
  const { data: profile } = await supabase.from("profiles").select("paid").eq("id", session.user.id).maybeSingle();
  if (profile?.paid) {
    $("whoami").textContent = session.user.email;
    show("app");
    setTab(state.tab);
  } else {
    $("paySub").textContent = `A one-time access fee activates your signals, ${session.user.email}.`;
    show("pay");
  }
}

/* ---------------- auth ---------------- */
function setAuthMode(m) {
  state.authMode = m;
  $("modeIn").setAttribute("aria-pressed", m === "signin");
  $("modeUp").setAttribute("aria-pressed", m === "signup");
  $("authTitle").textContent = m === "signin" ? "Sign in" : "Create your account";
  $("authGo").textContent = m === "signin" ? "Sign in" : "Continue — access fee applies";
  hideErr("authErr"); $("authInfo").hidden = true;
  $("credStep").hidden = false; $("otpStep").hidden = true;
}
$("modeIn").onclick = () => setAuthMode("signin");
$("modeUp").onclick = () => setAuthMode("signup");

function showOtpStep(email, message) {
  state.pendingEmail = email;
  $("credStep").hidden = true;
  $("otpStep").hidden = false;
  $("otpSub").textContent = message;
  $("otp").value = "";
  $("otp").focus();
  hideErr("authErr"); $("authInfo").hidden = true;
}

$("authGo").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("pw").value;
  hideErr("authErr"); $("authInfo").hidden = true;
  $("authGo").disabled = true;
  try {
    if (state.authMode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        if (error.message.toLowerCase().includes("not confirmed")) {
          await supabase.auth.resend({ type: "signup", email });
          showOtpStep(email, `Your email isn't confirmed yet. We've sent a fresh code to ${email}.`);
          return;
        }
        return showErr("authErr", error.message);
      }
      await route();
    } else {
      if (password.length < 8) return showErr("authErr", "Password needs at least 8 characters.");
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return showErr("authErr", error.message);
      if (!data.session) {
        showOtpStep(email, `We've emailed a 6-digit code to ${email}. Enter it below to confirm your account.`);
        return;
      }
      await route(); // email confirmation disabled → straight to paywall
    }
  } finally {
    $("authGo").disabled = false;
  }
};
$("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("authGo").click(); });

$("verifyGo").onclick = async () => {
  const token = $("otp").value.trim();
  hideErr("authErr");
  if (!/^\d{6}$/.test(token)) return showErr("authErr", "Enter the 6-digit code from the email.");
  $("verifyGo").disabled = true;
  const { error } = await supabase.auth.verifyOtp({ email: state.pendingEmail, token, type: "email" });
  $("verifyGo").disabled = false;
  if (error) return showErr("authErr", "That code didn't work — it may have expired. Try resending.");
  await route(); // confirmed and signed in → paywall or app
};
$("otp").addEventListener("keydown", (e) => { if (e.key === "Enter") $("verifyGo").click(); });

$("resendCode").onclick = async (e) => {
  e.preventDefault();
  hideErr("authErr");
  const { error } = await supabase.auth.resend({ type: "signup", email: state.pendingEmail });
  if (error) return showErr("authErr", "Couldn't resend just yet — wait a minute and try again.");
  $("authInfo").textContent = `New code sent to ${state.pendingEmail}.`;
  $("authInfo").hidden = false;
};
$("otpBack").onclick = (e) => { e.preventDefault(); setAuthMode(state.authMode); };

const signOut = async (e) => { e?.preventDefault(); await supabase.auth.signOut(); show("auth"); };
$("signout").onclick = signOut;
$("payOut").onclick = signOut;

/* ---------------- paywall ---------------- */
$("payGo").onclick = async () => {
  hideErr("payErr");
  $("payGo").disabled = true;
  $("payGo").textContent = "Processing…";
  const { error } = await supabase.rpc("activate_account");
  $("payGo").disabled = false;
  $("payGo").textContent = "Pay £0.01 and unlock";
  if (error) return showErr("payErr", "Activation failed: " + error.message);
  await route();
};

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
function setTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === name));
  ["analyse", "history", "api"].forEach((p) => ($("panel-" + p).hidden = p !== name));
  if (name === "history") renderHistory();
  if (name === "api") renderApi();
}

/* ---------------- analyse ---------------- */
const SUGGESTED = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "HSBA.L", "AZN.L", "BP.L", "SHEL.L"];
$("chips").innerHTML = SUGGESTED.map((s) => `<button data-t="${s}">${s}</button>`).join("");
document.querySelectorAll("#chips button").forEach((b) => (b.onclick = () => { $("ticker").value = b.dataset.t; runAnalysis(true); }));
$("ticker").addEventListener("keydown", (e) => { if (e.key === "Enter") runAnalysis(true); });
$("genBtn").onclick = () => runAnalysis(true);

state.range = "3M";
state.ccy = "";
state.lastTicker = null;

document.querySelectorAll("#rangeTabs button").forEach((b) => (b.onclick = () => {
  state.range = b.dataset.range;
  document.querySelectorAll("#rangeTabs button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  if (state.lastTicker) runAnalysis(false); // recompute view, no new history row
}));
$("ccySel").onchange = () => {
  state.ccy = $("ccySel").value;
  if (state.lastTicker) runAnalysis(false);
};

const CCY_SYMBOL = { GBP: "£", USD: "$", EUR: "€", JPY: "¥" };
const sym = (c) => CCY_SYMBOL[c] || (c ? c + " " : "");

function smaLocal(a, n) {
  return a.map((_, i) => (i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n));
}

function chartSVG(closes, currency, stamps) {
  const W = 760, H = 240, padL = 56, padR = 8, padT = 8, padB = 20;
  const min = Math.min(...closes), max = Math.max(...closes), span = max - min || 1;
  const x = (i) => padL + (i * (W - padL - padR)) / (closes.length - 1);
  const y = (v) => padT + (H - padT - padB) - ((v - min) * (H - padT - padB)) / span;
  const dp = max < 10 ? 3 : max < 100 ? 2 : max < 10000 ? 1 : 0;

  // horizontal price gridlines with labels
  const TICKS = 4;
  let grid = "";
  for (let t = 0; t <= TICKS; t++) {
    const v = min + (span * t) / TICKS;
    grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="#1B2032" stroke-width="1"/>
      <text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" fill="#5A6178" font-size="10" font-family="IBM Plex Mono">${sym(currency)}${v.toFixed(dp)}</text>`;
  }

  const linePath = (arr) => {
    let d = "", started = false;
    arr.forEach((v, i) => { if (v == null) return; d += (started ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1) + " "; started = true; });
    return d;
  };

  const pricePath = linePath(closes);
  const up = closes[closes.length - 1] >= closes[0];
  const col = up ? "#43C583" : "#F26D65";
  const s20 = smaLocal(closes, 20), s50 = smaLocal(closes, 50);
  const overlays =
    (closes.length >= 20 ? `<path d="${linePath(s20)}" fill="none" stroke="#8B8DFF" stroke-width="1.4" stroke-dasharray="5 4" opacity=".9"/>` : "") +
    (closes.length >= 50 ? `<path d="${linePath(s50)}" fill="none" stroke="#E5A83B" stroke-width="1.4" stroke-dasharray="2 4" opacity=".85"/>` : "");

  // x-axis date labels: start, middle, end
  const dateLbl = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const xTicks = [0, Math.floor(closes.length / 2), closes.length - 1]
    .map((i) => `<text x="${x(i)}" y="${H - 4}" text-anchor="${i === 0 ? "start" : i === closes.length - 1 ? "end" : "middle"}" fill="#5A6178" font-size="10" font-family="IBM Plex Mono">${stamps?.[i] ? dateLbl(stamps[i]) : ""}</text>`)
    .join("");

  return `<svg width="100%" height="240" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history chart with moving averages">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${col}" stop-opacity=".18"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${pricePath} L ${x(closes.length - 1)} ${H - padB} L ${x(0)} ${H - padB} Z" fill="url(#g)"/>
    <path d="${pricePath}" fill="none" stroke="${col}" stroke-width="2"/>
    ${overlays}
    ${xTicks}</svg>
    <div class="legend mono">
      <span><i style="background:${col};"></i>Price</span>
      ${closes.length >= 20 ? '<span><i style="background:#8B8DFF;"></i>SMA 20</span>' : ""}
      ${closes.length >= 50 ? '<span><i style="background:#E5A83B;"></i>SMA 50</span>' : ""}
    </div>`;
}

async function runAnalysis(store) {
  const ticker = store ? $("ticker").value.trim().toUpperCase() : state.lastTicker;
  hideErr("genErr");
  if (!ticker) return showErr("genErr", "Enter a ticker first — e.g. AAPL or BP.L.");
  const btn = $("genBtn");
  btn.disabled = true; btn.textContent = store ? "Analysing…" : "Updating…";
  if (store) $("sigOut").innerHTML = `<div class="empty thinking"><div class="mono empty-sub">Fetching price history · running indicator ensemble…</div></div>`;

  const { data, error } = await supabase.functions.invoke("generate-signal", {
    body: { ticker, range: state.range, currency: state.ccy, store },
  });
  btn.disabled = false; btn.textContent = "Generate signal";
  if (error || data?.error) {
    $("sigOut").innerHTML = `<div class="empty"><div class="empty-title">Couldn't generate a signal</div><div class="empty-sub">${data?.error || error.message}</div></div>`;
    return;
  }
  state.lastTicker = data.ticker;

  const conf = Math.round(data.confidence * 100);
  const fxNote = data.fx_rate !== 1 ? ` · FX ${data.fx_rate.toFixed(4)}` : "";
  const indHtml = (data.indicators || [])
    .map((i) => `<div class="ind"><div class="ind-name">${i.name}</div>
      <div class="ind-val mono">${i.value} <span class="ind-verdict ${i.verdict}">${i.verdict}</span></div></div>`)
    .join("");

  $("sigOut").innerHTML = `
    <div class="sigcard fade">
      <div class="row-between">
        <span class="pill ${data.signal}">${data.signal.toUpperCase()}</span>
        <span class="mono" style="font-size:11px; color:var(--faint);">
          ${new Date(data.generated_at).toLocaleTimeString("en-GB")} · ${data.ticker} · ${data.range}
          · last ${sym(data.currency)}${data.last_close.toFixed(2)}${fxNote}${data.source === "simulated" ? " · simulated data" : ""}${data.stored ? "" : " · view only, not stored"}</span>
      </div>
      <div style="display:flex; align-items:center; gap:12px; margin-top:14px;">
        <div class="confbar" style="flex:1;"><span style="width:${conf}%;"></span></div>
        <span class="mono" style="font-size:12px; color:var(--muted);">confidence ${conf}%</span>
      </div>
      <p style="font-size:13px; color:var(--muted); line-height:1.6; margin:12px 0 14px;">${data.rationale}</p>
      <div class="indgrid">${indHtml}</div>
      <div id="chartBox" style="margin-top:14px;">${data.closes?.length ? chartSVG(data.closes, data.currency, data.timestamps) : ""}</div>
    </div>`;
}

/* ---------------- history ---------------- */
$("histFilter").onchange = renderHistory;
async function renderHistory() {
  const filter = $("histFilter").value;
  let q = supabase.from("signals").select("ticker, signal, confidence, generated_at").order("generated_at", { ascending: false }).limit(100);
  if (filter !== "all") q = q.eq("signal", filter);
  const { data: rows, error } = await q;
  if (error) { $("histBody").innerHTML = `<div class="empty inset">${error.message}</div>`; return; }
  $("histBody").innerHTML = rows?.length
    ? `<table><thead><tr><th class="tag">Time</th><th class="tag">Ticker</th><th class="tag">Signal</th><th class="tag">Confidence</th></tr></thead>
       <tbody>${rows.map((s) => `
        <tr>
          <td class="mono" style="color:var(--muted); font-size:12px;">${new Date(s.generated_at).toLocaleString("en-GB")}</td>
          <td class="mono" style="font-weight:600;">${s.ticker}</td>
          <td><span class="pill mini ${s.signal}">${s.signal.toUpperCase()}</span></td>
          <td class="mono" style="color:var(--muted);">${Math.round(s.confidence * 100)}%</td>
        </tr>`).join("")}</tbody></table>`
    : `<div class="empty inset"><div class="empty-title">Nothing here yet</div><div class="empty-sub">Signals you generate on the Analyse tab appear here.</div></div>`;
}

/* ---------------- api access ---------------- */
const SNIPPETS = {
  curl: (k) => `curl ${PUBLIC_API} \\\n  -H "x-api-key: ${k}"`,
  JavaScript: (k) => `const res = await fetch(\n  "${PUBLIC_API}",\n  { headers: { "x-api-key": "${k}" } }\n);\nconst signals = await res.json();`,
  Python: (k) => `import requests\n\nres = requests.get(\n    "${PUBLIC_API}",\n    headers={"x-api-key": "${k}"},\n)\nsignals = res.json()`,
};

function copy(text, btn) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).catch(() => {})
    .finally(() => { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = o), 1500); });
}

$("createKey").onclick = async () => {
  const name = $("keyName").value.trim();
  hideErr("keyErr");
  if (!name) return showErr("keyErr", "Give the key a name so you can recognise it later — e.g. my-website.");
  $("createKey").disabled = true;
  const { data: fullKey, error } = await supabase.rpc("create_api_key", { key_name: name });
  $("createKey").disabled = false;
  if (error) {
    const msg = error.message.includes("duplicate") ? "You already have a key with that name." : error.message;
    return showErr("keyErr", msg);
  }
  state.newestKey = fullKey;
  $("keyName").value = "";
  $("revealTitle").textContent = `Key "${name}" created — copy it now`;
  $("revealKey").textContent = fullKey;
  $("reveal").hidden = false;
  renderApi();
};
$("keyName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("createKey").click(); });
$("keyName").addEventListener("input", () => hideErr("keyErr"));
$("revealCopy").onclick = (e) => copy($("revealKey").textContent, e.target);
$("revealDone").onclick = () => ($("reveal").hidden = true);
$("snipCopy").onclick = (e) => copy($("snippet").textContent, e.target);

$("testBtn").onclick = async () => {
  const btn = $("testBtn");
  btn.disabled = true; btn.textContent = "Sending…";
  const t0 = performance.now();
  try {
    const res = await fetch(PUBLIC_API, { headers: { "x-api-key": state.newestKey } });
    const body = await res.json();
    $("testStatus").textContent = `${res.status} ${res.ok ? "OK" : "ERROR"} · ${Math.round(performance.now() - t0)} ms`;
    $("testJson").textContent = JSON.stringify(body, null, 2);
  } catch (err) {
    $("testStatus").textContent = "network error";
    $("testJson").textContent = String(err);
  }
  $("testResult").hidden = false;
  btn.disabled = false; btn.textContent = "Send test request";
  renderApi();
};

async function renderApi() {
  const { data: keys, error } = await supabase
    .from("api_keys")
    .select("id, name, key_prefix, created_at, last_used_at, revoked")
    .eq("revoked", false)
    .order("created_at", { ascending: true });

  const list = $("keyList");
  if (error) { list.innerHTML = `<div class="empty">${error.message}</div>`; return; }

  list.innerHTML = keys?.length
    ? keys.map((k) => `
      <div class="keyrow fade" data-id="${k.id}" data-name="${k.name}">
        <div class="row-between">
          <div><span class="mono" style="font-size:13px; font-weight:600;">${k.name}</span>
            <span class="mono" style="font-size:12px; color:var(--muted); margin-left:10px;">${k.key_prefix}</span></div>
          <span class="revoke-zone"><button class="btn-quiet ask">Revoke</button></span>
        </div>
        <div class="keymeta mono">
          <span>created ${new Date(k.created_at).toLocaleDateString("en-GB")}</span>
          <span>last used ${k.last_used_at ? new Date(k.last_used_at).toLocaleString("en-GB") : "never"}</span>
        </div>
      </div>`).join("")
    : `<div class="empty"><div class="empty-title">No keys yet</div><div class="empty-sub">Name your first key above — it takes about two seconds.</div></div>`;

  list.querySelectorAll(".ask").forEach((btn) => (btn.onclick = (e) => {
    const row = e.target.closest(".keyrow");
    const zone = row.querySelector(".revoke-zone");
    zone.innerHTML = `<span style="font-size:12px; color:var(--sell);">Apps using this key stop working immediately.</span>
      <button class="btn-quiet btn-danger yes">Revoke</button> <button class="btn-quiet no">Keep</button>`;
    zone.querySelector(".yes").onclick = async () => {
      await supabase.from("api_keys").update({ revoked: true }).eq("id", row.dataset.id);
      if (state.newestKey) state.newestKey = null; // safest: force a fresh key for testing
      renderApi();
    };
    zone.querySelector(".no").onclick = renderApi;
  }));

  const display = state.newestKey || "fd_YOUR_KEY";
  $("snippet").textContent = SNIPPETS[state.lang](display);
  $("quickHint").textContent = state.newestKey
    ? "Snippets use the key you just created."
    : "Snippets show a placeholder — full keys are only visible right after creation.";
  $("testBtn").disabled = !state.newestKey;
  $("testHint").hidden = !!state.newestKey;

  $("langTabs").innerHTML = Object.keys(SNIPPETS)
    .map((l) => `<button data-lang="${l}" aria-pressed="${state.lang === l}">${l}</button>`).join("");
  $("langTabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { state.lang = b.dataset.lang; renderApi(); }));
}

/* ---------------- boot ---------------- */
supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") show("auth"); });
setAuthMode("signin");
route();
