'use strict';
const { getHTML } = require('../http');

const IG = 'https://www.instant-gaming.com';
const IG_SORT = 'sort_by=discount_desc';

// A página de busca embute o resultado como JSON em `window.searchResults = {...};` (60 itens/página).
function extractJSON(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const s = text.indexOf('{', i);
  let depth = 0, inStr = false, esc = false;
  for (let j = s; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(s, j + 1));
  }
  return null;
}

function parse(html, nowIso) {
  const data = extractJSON(html, 'window.searchResults = ');
  if (!data || !Array.isArray(data.hits)) throw new Error('não encontrei os resultados no HTML (layout mudou?)');
  const rows = data.hits.map((h) => {
    const preco = parseFloat(h.price_converted);
    if (!isFinite(preco)) return null;
    const orig = h.retail_currency === 'BRL' ? parseFloat(h.retail) : NaN;
    return {
      titulo: h.fullname || h.name,
      tipo: h.is_dlc ? 'DLC' : h.is_prepaid ? 'Gift card' : h.is_subscription ? 'Assinatura' : 'Jogo',
      genero: '',
      plataforma: (h.platform_names || []).join(' / ') || 'PC',
      ativacao: h.type || '',
      preco_brl: preco,
      preco_original_brl: isFinite(orig) ? orig : null,
      desconto_pct: +h.discount || 0,
      indisponivel: h.has_stock === 0,
      preorder: !!h.preorder,
      loja: 'Instant Gaming',
      coletado_em: nowIso,
      link: `${IG}/pt/${h.prod_id}-comprar-${h.seo_name}/`,   // sem afiliado: aplicado pela API em link_afiliado
      img: `https://gaming-cdn.com/images/products/${h.prod_id}/380x218/${h.seo_name}.jpg?v=${h.updated_at}`,
    };
  }).filter(Boolean);
  return { rows, totalPages: data.nbPages || null };
}

// O IG escolhe a moeda pelo IP do visitante; a partir de um datacenter fora do Brasil ele devolve USD/EUR.
// Por isso pedimos BRL explicitamente (parâmetro + cookie). Desative com IG_CURRENCY= (vazio).
function request(p, ctx) {
  const qs = [IG_SORT, ctx.currency ? 'currency=' + encodeURIComponent(ctx.currency) : '', p > 1 ? 'page=' + p : ''].filter(Boolean).join('&');
  const headers = { ...ctx.headers };
  const cookies = [ctx.cookie, ctx.currency ? 'currency=' + ctx.currency : ''].filter(Boolean).join('; ');
  if (cookies) headers.Cookie = cookies;
  return { url: `${IG}/pt/pesquisar/?${qs}`, headers };
}

async function fetchPage(p, ctx) {
  const { url, headers } = request(p, ctx);
  return parse(await getHTML(url, { headers }), ctx.nowIso);
}

// Diagnóstico: devolve os itens crus da 1ª página, para conferir moeda/preço contra o site.
async function sample(ctx, n = 3) {
  const { url, headers } = request(1, ctx);
  const data = extractJSON(await getHTML(url, { headers }), 'window.searchResults = ');
  if (!data || !Array.isArray(data.hits)) throw new Error('não encontrei os resultados no HTML (layout mudou?)');
  return { url, cookie_enviado: headers.Cookie || null, campos_do_resultado: Object.keys(data).filter((k) => k !== 'hits'),
    campos_do_item: data.hits[0] ? Object.keys(data.hits[0]) : [], itens: data.hits.slice(0, n) };
}

module.exports = { fetchPage, parse, extractJSON, request, sample };
