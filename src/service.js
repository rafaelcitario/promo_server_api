'use strict';
const fs = require('fs/promises');
const path = require('path');
const { scanStore } = require('./scanner');
const { buildDataset, updateHistory } = require('./dataset');

// Cache simples em arquivo (data/cache.json) + cópia em memória.
//
// Regra: a raspagem só roda se (a) não existe cache da loja, ou (b) já passaram CACHE_TTL_MINUTES desde a última.
// Enquanto raspa, as chamadas continuam sendo respondidas com o cache anterior (stale-while-revalidate): uma raspagem
// de 300 páginas leva minutos, então nenhuma requisição HTTP fica pendurada esperando por ela.
class PromoService {
  constructor({ config, stores, now = Date.now, log = console }) {
    this.cfg = config; this.defs = stores; this.now = now; this.log = log;
    this.state = {};        // { [loja]: { fetchedAt, requestedPages, pagesOk, totalPages, partial, error, rows } }
    this.hist = {};         // { [link]: { min, max, n } }
    this.failures = {};     // { [loja]: { at, message } }
    this.items = [];        // dataset derivado (linhas enriquecidas)
    this.byId = new Map();
    this.job = null;        // { startedAt, stores: { [loja]: { done, total, rows, note } } }
    this.jobPromise = null;
    this.cacheFile = path.join(config.dataDir, 'cache.json');
    this.histFile = path.join(config.dataDir, 'history.json');
  }

  // ---------- persistência ----------
  async load() {
    const read = async (f) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return null; } };
    const c = await read(this.cacheFile), h = await read(this.histFile);
    if (c && c.stores) this.state = c.stores;
    if (h) this.hist = h;
    this._rebuild();
    const n = Object.keys(this.state).length;
    if (n) this.log.log(`[cache] carregado: ${this.items.length} ofertas de ${n} loja(s)`);
  }

  async _writeAtomic(file, data) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  }

  async _persist() {
    try {
      await fs.mkdir(this.cfg.dataDir, { recursive: true });
      await this._writeAtomic(this.cacheFile, { version: 1, savedAt: this.now(), stores: this.state });
      await this._writeAtomic(this.histFile, this.hist);
    } catch (e) {
      this.log.error('[cache] não consegui gravar em disco (segue só em memória):', e.message);
    }
  }

  _rebuild() {
    this.items = buildDataset(this.state, this.hist, this.cfg.aff);
    this.byId = new Map(this.items.map((it) => [it.out.id, it.out]));
  }

  // ---------- regra de validade ----------
  isStale(id, force = false) {
    if (force) return true;
    const c = this.state[id], t = this.now(), f = this.failures[id];
    if (f && t - f.at < this.cfg.retryAfterFailMs) return false;       // falhou há pouco: não insiste
    if (!c) return true;
    if ((c.requestedPages || 0) < this.cfg.maxPages) return true;      // MAX_PAGES aumentou desde a última raspagem
    const ttl = c.partial ? this.cfg.retryAfterFailMs : this.cfg.ttlMs; // cache parcial é refeito mais cedo
    return t - c.fetchedAt >= ttl;
  }

  // Dispara (sem esperar) a raspagem das lojas vencidas. Nunca roda duas raspagens ao mesmo tempo.
  ensureFresh({ force = false } = {}) {
    if (this.job) return { started: false, running: true };
    const ids = Object.keys(this.defs).filter((id) => this.isStale(id, force));
    if (!ids.length) return { started: false, fresh: true };
    this.job = { startedAt: this.now(), stores: {} };
    this.jobPromise = this._run(ids).catch((e) => this.log.error('[scrape] erro inesperado:', e))
      .finally(() => { this.job = null; });
    return { started: true, stores: ids };
  }

  async _run(ids) {
    const nowIso = new Date(this.now()).toISOString();
    const headers = { 'User-Agent': this.cfg.userAgent, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5', Accept: 'text/html,application/xhtml+xml' };
    this.log.log(`[scrape] iniciando: ${ids.join(', ')} (até ${this.cfg.maxPages} páginas cada)`);
    await Promise.all(ids.map(async (id) => {
      const def = this.defs[id], t0 = Date.now();
      this.job.stores[id] = { nome: def.nome, done: 0, total: this.cfg.maxPages, rows: 0, note: '' };
      try {
        const r = await scanStore(def, {
          maxPages: this.cfg.maxPages, nowIso, headers, retryDelay: this.cfg.retryDelay,
          onProgress: (p) => Object.assign(this.job.stores[id], p),
        });
        if (!r.rows.length) throw r.error || new Error('nenhuma oferta encontrada');
        updateHistory(this.hist, r.rows);
        this.state[id] = {
          fetchedAt: this.now(), requestedPages: this.cfg.maxPages, pagesOk: r.pagesOk, totalPages: r.totalPages,
          partial: !!r.error, error: r.error ? r.error.message : null, rows: r.rows,
        };
        if (r.error) this.failures[id] = { at: this.now(), message: r.error.message }; else delete this.failures[id];
        this.log.log(`[scrape] ${def.nome}: ${r.rows.length} ofertas, ${r.pagesOk}/${r.totalPages} páginas em ${Math.round((Date.now() - t0) / 1000)} s` +
          (r.error ? ` (parcial: ${r.error.message})` : ''));
      } catch (e) {
        this.failures[id] = { at: this.now(), message: e.message };     // o cache anterior (se houver) é mantido
        this.log.error(`[scrape] ${def.nome}: falhou: ${e.message}${this.state[id] ? ' (mantendo cache anterior)' : ''}`);
      }
    }));
    this._rebuild();
    await this._persist();
  }

  // Diagnóstico do Instant Gaming (usado por GET /api/debug/instantgaming).
  async debugInstantGaming() {
    const def = this.defs.instantgaming;
    const ig = require('./scrapers/instantgaming');
    return ig.sample({ cookie: def.cookie, currency: def.currency, headers: {
      'User-Agent': this.cfg.userAgent, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5', Accept: 'text/html,application/xhtml+xml' } });
  }

  // ---------- consulta ----------
  hasData() { return this.items.length > 0; }

  status() {
    const t = this.now();
    const lojas = {};
    for (const [id, def] of Object.entries(this.defs)) {
      const c = this.state[id], f = this.failures[id];
      const ttl = c && c.partial ? this.cfg.retryAfterFailMs : this.cfg.ttlMs;
      lojas[id] = {
        nome: def.nome,
        ofertas: c ? c.rows.length : 0,
        atualizado_em: c ? new Date(c.fetchedAt).toISOString() : null,
        idade_segundos: c ? Math.round((t - c.fetchedAt) / 1000) : null,
        valido_ate: c ? new Date(c.fetchedAt + ttl).toISOString() : null,
        desatualizado: !c || t - c.fetchedAt >= ttl,
        paginas_coletadas: c ? c.pagesOk : 0,
        paginas_disponiveis: c ? c.totalPages : null,
        parcial: c ? c.partial : false,
        ultimo_erro: f ? { mensagem: f.message, em: new Date(f.at).toISOString() } : null,
      };
    }
    return {
      atualizando: !!this.job,
      iniciado_em: this.job ? new Date(this.job.startedAt).toISOString() : null,
      progresso: this.job ? this.job.stores : null,
      ttl_minutos: Math.round(this.cfg.ttlMs / 60000),
      paginas_por_loja: this.cfg.maxPages,
      total_ofertas: this.items.length,
      lojas,
    };
  }

  // Resumo de datas para o campo `meta` das respostas.
  meta() {
    const atualizado_em = {};
    for (const id of Object.keys(this.defs)) atualizado_em[id] = this.state[id] ? new Date(this.state[id].fetchedAt).toISOString() : null;
    const t = this.now();
    const desatualizado = Object.keys(this.defs).some((id) => {
      const c = this.state[id]; return !c || t - c.fetchedAt >= this.cfg.ttlMs;
    });
    return { atualizado_em, desatualizado, atualizando: !!this.job };
  }
}

module.exports = { PromoService };
