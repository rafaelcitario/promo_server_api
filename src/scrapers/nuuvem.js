'use strict';
const { getHTML } = require('../http');

const NV = 'https://www.nuuvem.com';
const NV_SORT_PATH = '/br-pt/catalog/sort/discount/sort-mode/desc';

// HTML renderizado no servidor: <a href="/item/..."><article data-component="product-card">…
// Usa cheerio no lugar do DOMParser da extensão (carregado sob demanda).
function parse(html, nowIso) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const txt = (e) => e.text().replace(/\s+/g, ' ').trim();
  const cents = (s) => { try { const v = JSON.parse(s).v; return typeof v === 'number' ? v / 100 : null; } catch { return null; } };
  const rows = [];

  $('article[data-component="product-card"]').each((_, node) => {
    const art = $(node);
    const priceEl = art.find('.mod-price').first();
    const preco = priceEl.length ? cents(priceEl.attr('data-price')) : null;
    if (preco == null) return;                          // sem preço (indisponível / em breve)
    const baseAttr = priceEl.attr('data-base-price');
    const orig = baseAttr ? cents(baseAttr) : null;
    const dm = txt(art.find('.product-price--discount').first()).match(/(\d{1,3})\s*%/);
    const a = art.closest('a[href]');
    const img = art.find('img.game-cover__item').first();

    // O selo "DLC"/"Pacote" fica dentro do título: lê e remove antes de pegar o nome.
    const nameEl = art.find('.game-card__product-name').first();
    const badge = nameEl.find('.type-badge').first();
    const badgeTxt = txt(badge); badge.remove();

    let genero = '';
    try { genero = JSON.parse(a.attr('data-default-highlight-tracker-product-tracking-data-param')).genre || ''; } catch { /* sem gênero */ }

    const list = (sel) => art.find(sel).map((__, e) => txt($(e))).get().filter(Boolean).join(' / ');
    const href = a.attr('href'), src = img.attr('src');
    rows.push({
      titulo: txt(nameEl),
      tipo: /dlc/i.test(badgeTxt) ? 'DLC' : /pacote/i.test(badgeTxt) ? 'Pacote' : 'Jogo',
      genero,
      plataforma: list('.platform-tags__item span') || 'PC',
      ativacao: list('.drm-activation__item span'),
      preco_brl: preco,
      preco_original_brl: orig,
      desconto_pct: dm ? +dm[1] : orig && orig > preco ? Math.round((1 - preco / orig) * 100) : 0,
      indisponivel: false,
      preorder: art.find('.game-card__pre-order').length > 0,
      loja: 'Nuuvem',
      coletado_em: nowIso,
      link: href ? new URL(href, NV).href : '',         // sem afiliado: aplicado pela API em link_afiliado
      img: src ? new URL(src, NV).href : '',
    });
  });

  const nums = $('.pagination a.pagination--item').map((_, e) => +txt($(e))).get().filter(Number.isFinite);
  return { rows, totalPages: nums.length ? Math.max(...nums) : null };
}

async function fetchPage(p, ctx) {
  const url = NV + NV_SORT_PATH + (p > 1 ? '/page/' + p : '');
  return parse(await getHTML(url, { headers: ctx.headers }), ctx.nowIso);
}

module.exports = { fetchPage, parse };
