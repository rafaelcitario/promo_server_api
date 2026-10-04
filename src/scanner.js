'use strict';
const { makeLimiter, withRetry } = require('./http');

// Varre uma loja: a 1ª página revela o total; as demais entram num pool de N conexões. O resultado é montado na ordem
// das páginas. Se uma página falhar depois de todas as tentativas, mantém o trecho contínuo já coletado (as páginas
// iniciais são as de maior desconto) em vez de perder tudo.
async function scanStore(store, { maxPages, nowIso, headers, onProgress = () => {}, retryDelay }) {
  const ctx = { nowIso, headers, cookie: store.cookie, currency: store.currency };
  const conc = Math.min(store.maxConc, Math.max(1, store.conc || 1));
  const lim = makeLimiter(conc, store.gap);
  const pages = [];
  let failure = null, done = 0, total = maxPages, rowCount = 0;
  const retryOpts = retryDelay != null ? { baseDelay: retryDelay } : {};
  const tick = (idx, rows) => {
    pages[idx] = rows; done++; rowCount += rows.length;
    onProgress({ done, total, rows: rowCount, note: lim.note });
  };

  const first = await withRetry(() => store.fetchPage(1, ctx), lim, retryOpts);
  total = Math.max(1, Math.min(maxPages, first.totalPages || maxPages));
  tick(0, first.rows);

  let next = 2;
  const worker = async (i) => {
    while (!failure) {
      if (i >= lim.conc) return;                       // o limitador reduziu as conexões: este worker se aposenta
      const p = next++; if (p > total) return;
      try { tick(p - 1, (await withRetry(() => store.fetchPage(p, ctx), lim, retryOpts)).rows); }
      catch (e) { failure = failure || e; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lim.conc, Math.max(0, total - 1)) }, (_, i) => worker(i)));

  let k = 0; while (k < total && pages[k]) k++;        // trecho contínuo de páginas
  const seen = new Set();
  const rows = pages.slice(0, k).flat().filter((x) => !seen.has(x.link) && seen.add(x.link));
  return { rows, pagesOk: k, totalPages: total, error: failure };
}

module.exports = { scanStore };
