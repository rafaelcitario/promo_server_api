'use strict';
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { query, filterItems, sortItems, facets, toCSV } = require('./dataset');

const num = (v) => { if (v == null || v === '') return undefined; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : undefined; };
const flag = (v) => /^(1|true|sim|yes|on)$/i.test(v || '');

function parseParams(sp) {
  return {
    q: sp.get('q') || '', loja: sp.get('loja') || '', tipo: sp.get('tipo') || '', plataforma: sp.get('plataforma') || '',
    genero: sp.get('genero') || '', vale: sp.get('vale') || '',
    descontoMin: num(sp.get('desconto_min')), precoMin: num(sp.get('preco_min')), precoMax: num(sp.get('preco_max')),
    indisponiveis: flag(sp.get('indisponiveis')),
    ordenar: sp.get('ordenar') || 'desconto', ordem: /^(asc|desc)$/.test(sp.get('ordem') || '') ? sp.get('ordem') : undefined,
    pagina: Math.floor(num(sp.get('pagina')) || 1), limite: Math.floor(num(sp.get('limite')) || 50),
  };
}

function createServer(service, cfg) {
  const origins = cfg.corsOrigins === '*' ? null : cfg.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean);

  function cors(req, res) {
    const o = req.headers.origin;
    if (!origins) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (o && origins.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Cache-Updated-At');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  function send(req, res, status, body, { type = 'application/json; charset=utf-8', cache = 'no-store', headers = {} } = {}) {
    let buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', cache);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      buf = zlib.gzipSync(buf); res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
    }
    res.statusCode = status;
    res.setHeader('Content-Length', buf.length);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const json = (req, res, status, body, opts) => send(req, res, status, body, opts);

  function authorized(req) {
    if (!cfg.apiKey) return false;
    const h = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(String(h)), b = Buffer.from(cfg.apiKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Dispara a verificação de validade (30 min). Se vencido, raspa em segundo plano e responde já com o que existe.
  function touch() { return service.ensureFresh(); }

  // Quando ainda não há NENHUM dado (1ª chamada): 202 enquanto raspa, ou 503 se a raspagem falhou.
  function noDataResponse(req, res) {
    const st = service.status();
    if (st.atualizando) {
      return json(req, res, 202, {
        status: 'atualizando',
        mensagem: 'Primeira raspagem em andamento. Tente novamente em alguns instantes (consulte /api/status).',
        progresso: st.progresso, tente_novamente_em_segundos: 15,
      }, { headers: { 'Retry-After': '15' } });
    }
    const erros = Object.fromEntries(Object.entries(st.lojas).filter(([, l]) => l.ultimo_erro).map(([k, l]) => [k, l.ultimo_erro]));
    return json(req, res, 503, { status: 'sem_dados', mensagem: 'Ainda não há dados em cache e a última raspagem falhou.', erros }, { headers: { 'Retry-After': '300' } });
  }

  const routes = {
    'GET /': (req, res) => json(req, res, 200, {
      nome: 'promos-api', descricao: 'Promoções do Instant Gaming e da Nuuvem (R$), com cache de ' + Math.round(cfg.ttlMs / 60000) + ' min.',
      endpoints: {
        'GET /health': 'liveness (não dispara raspagem)',
        'GET /api/status': 'estado do cache e progresso da raspagem',
        'GET /api/promos': 'lista paginada com filtros: q, loja, tipo, plataforma, genero, vale, desconto_min, preco_min, preco_max, indisponiveis, ordenar (desconto|preco|titulo|vale|coletado), ordem (asc|desc), pagina, limite',
        'GET /api/promos/:id': 'uma oferta',
        'GET /api/promos.csv': 'mesmos filtros, em CSV',
        'GET /api/filtros': 'valores disponíveis para filtros',
        'POST /api/refresh': 'força nova raspagem (header X-API-Key); ?force=1 ignora a validade do cache',
      },
    }),

    'GET /health': (req, res) => json(req, res, 200, { ok: true, uptime_s: Math.round(process.uptime()) }),

    'GET /api/status': (req, res) => { touch(); json(req, res, 200, service.status()); },

    'GET /api/promos': (req, res, url) => {
      touch();
      if (!service.hasData()) return noDataResponse(req, res);
      const r = query(service.items, parseParams(url.searchParams));
      json(req, res, 200, {
        meta: { total: r.total, pagina: r.pagina, limite: r.limite, paginas: r.paginas, ...service.meta() },
        data: r.items,
      }, { cache: 'public, max-age=60' });
    },

    'GET /api/promos.csv': (req, res, url) => {
      touch();
      if (!service.hasData()) return noDataResponse(req, res);
      const p = parseParams(url.searchParams);
      const rows = sortItems(filterItems(service.items, p), p.ordenar, p.ordem).map((it) => it.out);
      send(req, res, 200, toCSV(rows), {
        type: 'text/csv; charset=utf-8', cache: 'public, max-age=60',
        headers: { 'Content-Disposition': `attachment; filename="promocoes_br_${new Date().toISOString().slice(0, 10)}.csv"` },
      });
    },

    'GET /api/filtros': (req, res) => {
      touch();
      if (!service.hasData()) return noDataResponse(req, res);
      json(req, res, 200, { meta: service.meta(), data: facets(service.items) }, { cache: 'public, max-age=300' });
    },

    'POST /api/refresh': (req, res, url) => {
      if (!cfg.apiKey) return json(req, res, 403, { erro: 'endpoint desativado: defina a variável de ambiente API_KEY' });
      if (!authorized(req)) return json(req, res, 401, { erro: 'API key ausente ou inválida (header X-API-Key)' });
      const r = service.ensureFresh({ force: flag(url.searchParams.get('force')) });
      const st = r.started ? 202 : 200;
      json(req, res, st, {
        status: r.started ? 'iniciada' : r.running ? 'ja_em_andamento' : 'cache_valido',
        lojas: r.stores || [],
        mensagem: r.fresh ? 'Cache ainda válido; use ?force=1 para raspar mesmo assim.' : undefined,
      });
    },
  };

  return http.createServer((req, res) => {
    try {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      const method = req.method === 'HEAD' ? 'GET' : req.method;

      const handler = routes[`${method} ${path}`];
      if (handler) return handler(req, res, url);

      const m = method === 'GET' && path.match(/^\/api\/promos\/([A-Za-z0-9_-]{1,64})$/);
      if (m) {
        touch();
        const item = service.byId.get(m[1]);
        if (item) return json(req, res, 200, { meta: service.meta(), data: item }, { cache: 'public, max-age=60' });
        if (!service.hasData()) return noDataResponse(req, res);
        return json(req, res, 404, { erro: 'oferta não encontrada (ela pode ter saído da promoção na última raspagem)' });
      }
      if (Object.keys(routes).some((k) => k.endsWith(' ' + path))) return json(req, res, 405, { erro: 'método não permitido' });
      json(req, res, 404, { erro: 'rota não encontrada', ajuda: 'GET / lista os endpoints' });
    } catch (e) {
      console.error('[http] erro:', e);
      if (!res.headersSent) json(req, res, 500, { erro: 'erro interno' });
      else res.end();
    }
  });
}

module.exports = { createServer, parseParams };
