'use strict';
// Rede + limitador de velocidade (portado da extensão).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(message, status, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

async function getHTML(url, { headers = {}, timeoutMs = 30_000 } = {}) {
  let r;
  try {
    r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = new Error(`falha de rede: ${(e.cause && e.cause.code) || e.name || e.message}`);
    err.network = true; throw err;
  }
  if (!r.ok) {
    const ra = parseFloat(r.headers.get('retry-after'));
    const e = new HttpError('HTTP ' + r.status, r.status, ra > 0 ? ra : undefined);
    if (r.status === 403) { e.fatal = true; e.message = 'HTTP 403 (a loja bloqueou o IP do servidor ou pediu verificação anti-bot)'; }
    throw e;
  }
  const html = await r.text();
  if (/Just a moment|cf-challenge/i.test(html.slice(0, 3000))) {
    const e = new Error('a loja respondeu com verificação anti-bot (Cloudflare)');
    e.fatal = true; throw e;
  }
  return html;
}

// Teto de conexões simultâneas + intervalo mínimo entre pedidos + recuo automático em 429 (respeita Retry-After).
function makeLimiter(conc, gap) {
  const L = { conc, gap, pauseUntil: 0, nextStart: 0, hits: 0, note: '' };
  L.gate = async () => {
    for (;;) {
      const now = Date.now(), wait = Math.max(L.pauseUntil - now, L.nextStart - now);
      if (wait <= 0) { L.nextStart = now + L.gap * (0.8 + Math.random() * 0.5); return; }
      await sleep(Math.min(wait, 400));
    }
  };
  L.on429 = (retryAfter) => {
    const fresh = Date.now() >= L.pauseUntil;          // só o 1º 429 de cada pausa reduz a velocidade
    if (fresh) { L.hits++; if (L.conc > 1) L.conc--; L.gap = Math.min(3000, Math.max(L.gap, 50) * 1.5); }
    const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 4000 * 2 ** (L.hits - 1));
    L.pauseUntil = Math.max(L.pauseUntil, Date.now() + wait);
    L.note = `429: ${L.conc} conexão(ões), pausa de ${Math.round(wait / 1000)} s`;
  };
  return L;
}

async function withRetry(fn, lim, { baseDelay = 1500 } = {}) {
  for (let t = 0; ; t++) {
    await lim.gate();
    try { return await fn(); }
    catch (e) {
      if (e.fatal) throw e;
      const is429 = e.status === 429;
      const retriable = is429 || e.status >= 500 || e.network;
      if (!retriable || t >= (is429 ? 5 : 2)) throw e;
      if (is429) lim.on429(e.retryAfter);
      else await sleep(baseDelay * 2 ** t + Math.random() * 500);
    }
  }
}

module.exports = { getHTML, makeLimiter, withRetry, HttpError, sleep };
