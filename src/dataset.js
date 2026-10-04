'use strict';
const crypto = require('crypto');

const nk = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const brl = (n) => (n == null ? '' : 'R$ ' + n.toFixed(2).replace('.', ','));
const idOf = (link) => crypto.createHash('sha1').update(link).digest('hex').slice(0, 12);

// ===== LINKS DE AFILIADO =====
function affLink(r, aff) {
  if (!r.link) return '';
  if (r.loja === 'Instant Gaming') {
    if (!aff.igr) return r.link;
    try { const u = new URL(r.link); u.searchParams.set('igr', aff.igr); return u.href; } catch { return r.link; }
  }
  if (r.loja === 'Nuuvem') {
    if (!aff.nvId) return r.link;
    return `https://click.linksynergy.com/deeplink?id=${encodeURIComponent(aff.nvId)}&mid=${aff.nvMid}` +
      `&murl=${encodeURIComponent(r.link)}&u1=${encodeURIComponent(aff.nvU1)}`;
  }
  return r.link;
}

// ===== HISTÓRICO DE PREÇOS =====
function updateHistory(hist, rows) {
  for (const r of rows) {
    const h = hist[r.link];
    if (!h) hist[r.link] = { min: r.preco_brl, max: r.preco_brl, n: 1 };
    else { h.min = Math.min(h.min, r.preco_brl); h.max = Math.max(h.max, r.preco_brl); h.n++; }
  }
}

// ===== "VALE A PENA?" (estimativa; portado da extensão) =====
const normTitle = (s) => nk(s)
  .replace(/\([^)]*\)/g, ' ')
  .replace(/\s[-–]\s*(pc|mac|xbox|playstation|ps4|ps5|switch|nintendo|windows|steam|epic|gog)\b.*$/i, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const famOf = (p) => {
  const s = new Set();
  if (/xbox/i.test(p)) s.add('x');
  if (/playstation|ps\d/i.test(p)) s.add('p');
  if (/switch|nintendo/i.test(p)) s.add('n');
  if (!s.size || /pc|windows|mac|linux/i.test(p)) s.add('w');
  return s;
};
const keyCache = new WeakMap();
function xKey(r) {
  let k = keyCache.get(r);
  if (!k) keyCache.set(r, (k = { key: r.tipo + '|' + normTitle(r.titulo), fam: famOf(r.plataforma) }));
  return k;
}
function buildXMap(rows) {
  const m = new Map();
  for (const r of rows) { const { key } = xKey(r); (m.get(key) || m.set(key, []).get(key)).push(r); }
  return m;
}
function verdict(r, xmap, hist) {
  if (r.indisponivel) return { texto: null, score: -99, motivo: 'Indisponível no momento.' };
  if (r.preorder) return { texto: 'Pré-venda', score: -50, motivo: 'Pré-venda: ainda não há histórico de preço para comparar.' };
  const why = []; let s = 0; const d = r.desconto_pct;
  if (d >= 60) { s += 2; why.push(`desconto alto (${d}%)`); }
  else if (d >= 40) { s += 1; why.push(`bom desconto (${d}%)`); }
  else if (d >= 20) why.push(`desconto moderado (${d}%)`);
  else { s -= 1; why.push(d ? `desconto baixo (${d}%)` : 'sem desconto'); }
  const h = hist[r.link];
  if (h && h.n >= 2 && h.max > h.min + 0.005) {
    if (r.preco_brl <= h.min + 0.005) { s += 2; why.push(`menor preço que já registramos (variou de ${brl(h.min)} a ${brl(h.max)})`); }
    else if (r.preco_brl >= h.min * 1.2) { s -= 1; why.push(`já esteve a ${brl(h.min)}`); }
  }
  const { key, fam } = xKey(r);
  const others = (xmap.get(key) || []).filter((o) => o.loja !== r.loja && [...xKey(o).fam].some((f) => fam.has(f)));
  if (others.length) {
    const o = others.reduce((a, b) => (b.preco_brl < a.preco_brl ? b : a));
    if (o.preco_brl < r.preco_brl * 0.95) { s -= 1; why.push(`mais barato na ${o.loja} (${brl(o.preco_brl)})`); }
    else if (r.preco_brl < o.preco_brl * 0.95) { s += 1; why.push(`mais barato que na ${o.loja} (${brl(o.preco_brl)})`); }
  }
  return { texto: s >= 2 ? 'Sim' : s >= 0 ? 'Talvez' : 'Não', score: s, motivo: 'Estimativa: ' + why.join('; ') + '.' };
}

// ===== DATASET (linhas de todas as lojas, já enriquecidas) =====
// Cada item guarda o objeto público (`out`) e campos normalizados só para busca.
function buildDataset(stores, hist, aff) {
  const rows = [];
  for (const c of Object.values(stores)) if (c && c.rows) for (const r of c.rows) rows.push(r);
  const xmap = buildXMap(rows);
  return rows.map((r) => ({
    out: { id: idOf(r.link), ...r, link_afiliado: affLink(r, aff), vale: verdict(r, xmap, hist) },
    t: nk(r.titulo), g: nk(r.genero), p: nk(r.plataforma), l: nk(r.loja).replace(/\s+/g, ''), tipo: nk(r.tipo),
  }));
}

const SORTS = {
  desconto: (r) => r.desconto_pct,
  preco: (r) => r.preco_brl,
  titulo: (r) => r.titulo,
  vale: (r) => r.vale.score,
  coletado: (r) => r.coletado_em,
};

function filterItems(items, p = {}) {
  const q = p.q ? nk(p.q) : '', loja = p.loja ? nk(p.loja).replace(/\s+/g, '') : '';
  const plat = p.plataforma ? nk(p.plataforma) : '', tipo = p.tipo ? nk(p.tipo) : '', gen = p.genero ? nk(p.genero) : '';
  const vale = p.vale ? nk(p.vale) : '';
  return items.filter((it) => {
    const r = it.out;
    if (!p.indisponiveis && r.indisponivel) return false;
    if (r.desconto_pct < (p.descontoMin || 0)) return false;
    if (p.precoMax != null && r.preco_brl > p.precoMax) return false;
    if (p.precoMin != null && r.preco_brl < p.precoMin) return false;
    if (loja && it.l !== loja) return false;
    if (plat && !it.p.includes(plat)) return false;
    if (tipo && it.tipo !== tipo) return false;
    if (gen && !it.g.includes(gen)) return false;
    if (vale && nk(r.vale.texto) !== vale) return false;
    if (q && !it.t.includes(q) && !it.g.includes(q)) return false;
    return true;
  });
}

function sortItems(list, ordenar = 'desconto', ordem) {
  const key = SORTS[ordenar] || SORTS.desconto;
  const dir = (ordem || (ordenar === 'preco' || ordenar === 'titulo' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    const x = key(a.out), y = key(b.out);
    const c = typeof x === 'string' ? x.localeCompare(y, 'pt-BR') : (x > y) - (x < y);
    return c * dir || a.out.preco_brl - b.out.preco_brl;
  });
}

function query(items, p = {}) {
  const sorted = sortItems(filterItems(items, p), p.ordenar, p.ordem);
  const limite = Math.min(200, Math.max(1, p.limite || 50)), pagina = Math.max(1, p.pagina || 1);
  return {
    total: sorted.length, pagina, limite, paginas: Math.max(1, Math.ceil(sorted.length / limite)),
    items: sorted.slice((pagina - 1) * limite, pagina * limite).map((it) => it.out),
  };
}

function facets(items) {
  const count = (get) => {
    const m = new Map();
    for (const it of items) { const v = get(it.out); if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([valor, qtd]) => ({ valor, qtd }));
  };
  return { lojas: count((r) => r.loja), tipos: count((r) => r.tipo), plataformas: count((r) => r.plataforma), generos: count((r) => r.genero) };
}

const CSV_COLS = ['titulo', 'tipo', 'genero', 'preco_brl', 'preco_original_brl', 'vale_a_pena', 'motivo', 'desconto_pct', 'loja',
  'ativacao', 'plataforma', 'coletado_em', 'preorder', 'indisponivel', 'link_afiliado'];
function toCSV(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const val = (r, c) => (c === 'vale_a_pena' ? r.vale.texto : c === 'motivo' ? r.vale.motivo : r[c]);
  return '\ufeff' + [CSV_COLS.join(',')].concat(rows.map((r) => CSV_COLS.map((c) => esc(val(r, c))).join(','))).join('\n');
}

module.exports = { buildDataset, updateHistory, query, filterItems, sortItems, facets, toCSV, affLink, verdict, idOf, nk };
