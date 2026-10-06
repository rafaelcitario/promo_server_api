'use strict';
const { postJSON } = require('../http');

// Epic Games Store: a própria loja consome este GraphQL público (sem login). Os campos abaixo foram confirmados
// no HTML da página /browse (window.__REACT_QUERY_INITIAL_QUERIES__ → searchStoreQuery).
const EPIC = 'https://store.epicgames.com';
const ENDPOINT = EPIC + '/graphql';
const COUNTRY = 'BR', LOCALE = 'pt-BR';
// jogos, pacotes, edições e DLCs (sem demos, experiências e assinaturas)
const CATEGORY = 'games/edition/base|bundles/games|games/edition|addons';

const QUERY = `query searchStoreQuery($allowCountries: String, $category: String, $count: Int, $country: String!, $keywords: String, $locale: String, $sortBy: String, $sortDir: String, $start: Int, $tag: String, $withPrice: Boolean = false, $onSale: Boolean) {
  Catalog {
    searchStore(allowCountries: $allowCountries, category: $category, count: $count, country: $country, keywords: $keywords, locale: $locale, sortBy: $sortBy, sortDir: $sortDir, start: $start, tag: $tag, onSale: $onSale) {
      elements {
        title id namespace effectiveDate isCodeRedemptionOnly
        keyImages { type url }
        productSlug urlSlug
        tags { id }
        categories { path }
        catalogNs { mappings(pageType: "productHome") { pageSlug pageType } }
        offerMappings { pageSlug pageType }
        prePurchase
        price(country: $country) @include(if: $withPrice) {
          totalPrice { discountPrice originalPrice discount currencyCode currencyInfo { decimals } }
          lineOffers { appliedRules { endDate } }
        }
      }
      paging { count total }
    }
  }
}`;

// IDs de tags (pt-BR) copiados da própria página da loja.
const GENRES = { 1117: 'Aventura', 1216: 'Ação', 1336: 'Ação e Aventura', 1296: 'Casual', 1116: 'Comédia', 1146: 'Construção de Cidades',
  1212: 'Corrida', 1318: 'Curiosidades', 1170: 'Defesa de Torre', 1265: 'Dungeon Crawler', 1121: 'Espaço', 1283: 'Esportes', 1115: 'Estratégia',
  1088: 'Estratégia por Turnos', 1381: 'Exploração', 1287: 'Fantasia', 1084: 'Furtivos', 1263: 'Indie', 1181: 'Jogo de Cartas', 1110: 'Jogos de Festa',
  1386: 'Jogos de Turnos', 1344: 'Luta', 1275: 'MOBA', 1307: 'Mundo Aberto', 1129: 'Música', 1395: 'Narração', 1151: 'Plataforma',
  1294: 'Primeira Pessoa', 1298: 'Quebra-Cabeça', 1367: 'RPG', 1120: 'RTS', 1198: 'Retro', 1158: 'Ritmo', 1083: 'Roguelite', 1393: 'Simulação',
  1080: 'Sobrevivência', 1218: 'Terror', 1210: 'Tiro' };
const PLATFORMS = { 9547: 'PC', 10719: 'Mac' };

function slugOf(e) {
  const m = (e.offerMappings || [])[0] || (e.catalogNs && e.catalogNs.mappings || [])[0];
  return (m && m.pageSlug) || e.productSlug || e.urlSlug || null;
}

function parse(json, nowIso) {
  if (json.errors && json.errors.length) throw new Error('GraphQL: ' + (json.errors[0].message || 'erro'));
  const s = json.data && json.data.Catalog && json.data.Catalog.searchStore;
  if (!s || !Array.isArray(s.elements)) throw new Error('resposta sem searchStore (API mudou?)');
  const rows = [];
  for (const e of s.elements) {
    const t = e.price && e.price.totalPrice, slug = slugOf(e);
    if (!t || !slug || e.isCodeRedemptionOnly) continue;
    if (t.currencyCode !== 'BRL') continue;                        // nunca misturar moedas
    const div = 10 ** ((t.currencyInfo && t.currencyInfo.decimals) ?? 2);
    const orig = t.originalPrice / div, preco = t.discountPrice / div;
    if (!(orig > 0) || !(preco < orig)) continue;                   // só o que está de fato em promoção
    const ids = (e.tags || []).map((x) => +x.id);
    const cats = (e.categories || []).map((c) => c.path);
    const ends = ((e.price.lineOffers || []).flatMap((l) => l.appliedRules || []).map((r) => r.endDate).filter(Boolean)).sort();
    const img = (e.keyImages || []).find((k) => k.type === 'OfferImageTall') || (e.keyImages || []).find((k) => k.type === 'Thumbnail');
    rows.push({
      titulo: e.title,
      tipo: cats.some((c) => c.startsWith('addons')) ? 'DLC' : cats.some((c) => c.startsWith('bundles')) ? 'Pacote' : 'Jogo',
      genero: ids.map((i) => GENRES[i]).find(Boolean) || '',
      plataforma: [...new Set(ids.map((i) => PLATFORMS[i]).filter(Boolean))].join(' / ') || 'PC',
      ativacao: 'Epic Games',
      preco_brl: preco,
      preco_original_brl: orig,
      desconto_pct: Math.round(((orig - preco) / orig) * 100),
      indisponivel: false,
      preorder: !!e.prePurchase,
      loja: 'Epic Games',
      coletado_em: nowIso,
      promo_termina_em: ends[0] || null,
      link: `${EPIC}/${LOCALE}/p/${slug}`,
      img: img ? img.url : '',
    });
  }
  return { rows, totalPages: null, total: s.paging && s.paging.total };
}

function body(p, ctx) {
  const count = ctx.pageSize || 100;
  return {
    operationName: 'searchStoreQuery', query: QUERY,
    variables: { allowCountries: COUNTRY, country: COUNTRY, locale: LOCALE, category: CATEGORY, count, start: (p - 1) * count,
      keywords: '', tag: '', onSale: true, withPrice: true, sortBy: 'relevancy,viewableDate', sortDir: 'DESC,DESC' },
  };
}

async function fetchPage(p, ctx) {
  const json = await postJSON(ENDPOINT, body(p, ctx), {
    headers: { ...ctx.headers, Accept: 'application/json', Origin: EPIC, Referer: EPIC + '/pt-BR/browse?sortBy=relevancy&sortDir=DESC&count=40' },
  });
  const r = parse(json, ctx.nowIso);
  const count = (ctx.pageSize || 100);
  return { rows: r.rows, totalPages: r.total != null ? Math.max(1, Math.ceil(r.total / count)) : null };
}

module.exports = { fetchPage, parse, body, QUERY };
