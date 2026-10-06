'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PromoService } = require('../src/service');
const { createServer } = require('../src/server');
const ig = require('../src/scrapers/instantgaming');

const MIN = 60_000;
const silent = { log() {}, error() {} };

// Loja falsa: `pages` páginas de 3 ofertas cada; conta quantas páginas foram buscadas.
function fakeStore(id, nome, { pages = 4, failAt = null, price = 10 } = {}) {
  const s = {
    id, nome, conc: 2, maxConc: 3, gap: 0, calls: 0, failAll: false, failAt, price,
    async fetchPage(p, ctx) {
      s.calls++;
      if (s.failAll) { const e = new Error('HTTP 500'); e.status = 500; throw e; }
      if (s.failAt && p >= s.failAt) { const e = new Error('HTTP 403'); e.fatal = true; throw e; }
      const rows = [1, 2, 3].map((i) => ({
        titulo: `Jogo ${id} ${p}-${i}`, tipo: 'Jogo', genero: i === 1 ? 'Ação' : 'RPG', plataforma: 'PC', ativacao: 'Steam',
        preco_brl: s.price + i, preco_original_brl: 100, desconto_pct: 100 - p * 10 - i, indisponivel: false, preorder: false,
        loja: nome, coletado_em: ctx.nowIso, link: `https://x.test/${id}/${p}-${i}`, img: '',
      }));
      return { rows, totalPages: pages };
    },
  };
  return s;
}

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promos-'));
  const clock = { t: 1_700_000_000_000 };
  const stores = { a: fakeStore('a', 'Loja A', over.a), b: fakeStore('b', 'Loja B', over.b) };
  const config = {
    maxPages: 300, ttlMs: 30 * MIN, retryAfterFailMs: 5 * MIN, dataDir: dir, apiKey: 'segredo', corsOrigins: '*',
    userAgent: 'test', retryDelay: 1, aff: { igr: 'tag', nvId: 'id', nvMid: '1', nvU1: 'u' },
  };
  const mk = () => new PromoService({ config, stores, now: () => clock.t, log: silent });
  return { dir, clock, stores, config, mk, service: mk() };
}
const calls = (s) => s.stores.a.calls + s.stores.b.calls;

test('1ª chamada raspa; 2ª dentro de 30 min usa cache; depois de 30 min raspa de novo', async () => {
  const s = setup();
  assert.deepEqual(s.service.ensureFresh(), { started: true, stores: ['a', 'b'] });
  await s.service.jobPromise;
  assert.equal(calls(s), 8);                                    // 4 páginas x 2 lojas (limitado pelo total real, não 300)
  assert.equal(s.service.items.length, 24);

  s.clock.t += 10 * MIN;
  assert.deepEqual(s.service.ensureFresh(), { started: false, fresh: true });
  assert.equal(calls(s), 8);

  s.clock.t += 19 * MIN + 59_000;                               // 29 min 59 s no total
  assert.equal(s.service.ensureFresh().started, false);

  s.clock.t += 2_000;                                           // passou de 30 min
  assert.equal(s.service.ensureFresh().started, true);
  await s.service.jobPromise;
  assert.equal(calls(s), 16);
});

test('não roda duas raspagens ao mesmo tempo', async () => {
  const s = setup();
  assert.equal(s.service.ensureFresh().started, true);
  assert.deepEqual(s.service.ensureFresh(), { started: false, running: true });
  assert.deepEqual(s.service.ensureFresh({ force: true }), { started: false, running: true });
  await s.service.jobPromise;
});

test('cache é gravado em arquivo e reaproveitado após reiniciar', async () => {
  const s = setup();
  s.service.ensureFresh(); await s.service.jobPromise;
  assert.ok(fs.existsSync(path.join(s.dir, 'cache.json')));

  const novo = s.mk(); await novo.load();                       // "reinício" do servidor
  assert.equal(novo.items.length, 24);
  s.clock.t += 5 * MIN;
  assert.equal(novo.ensureFresh().started, false);              // ainda válido: não raspa
  s.clock.t += 30 * MIN;
  assert.equal(novo.ensureFresh().started, true);
  await novo.jobPromise;
});

test('falha mantém o cache anterior e só tenta de novo após o intervalo de espera', async () => {
  const s = setup();
  s.service.ensureFresh(); await s.service.jobPromise;
  s.stores.a.failAll = true;
  s.clock.t += 31 * MIN;
  s.service.ensureFresh(); await s.service.jobPromise;
  assert.equal(s.service.items.filter((i) => i.out.loja === 'Loja A').length, 12);   // cache antigo preservado
  assert.match(s.service.status().lojas.a.ultimo_erro.mensagem, /HTTP 500/);

  const before = s.stores.a.calls;
  s.clock.t += 2 * MIN;                                         // dentro do cooldown de 5 min
  assert.equal(s.service.isStale('a'), false);
  s.clock.t += 4 * MIN;                                         // cooldown acabou
  assert.equal(s.service.isStale('a'), true);
  assert.equal(s.stores.a.calls, before);
});

test('falha no meio salva o trecho contínuo já coletado e refaz cedo', async () => {
  const s = setup({ a: { pages: 6, failAt: 4 } });
  s.service.ensureFresh(); await s.service.jobPromise;
  const st = s.service.status().lojas.a;
  assert.equal(st.paginas_coletadas, 3);
  assert.equal(st.parcial, true);
  assert.equal(st.ofertas, 9);
  s.clock.t += 6 * MIN;                                         // parcial vence em 5 min, não em 30
  assert.equal(s.service.isStale('a'), true);
  assert.equal(s.service.isStale('b'), false);
});

test('consulta: filtros, ordenação, paginação, afiliado e "vale a pena"', async () => {
  const s = setup(); s.service.ensureFresh(); await s.service.jobPromise;
  const { query } = require('../src/dataset');
  const r = query(s.service.items, { loja: 'loja a', ordenar: 'desconto', limite: 5, pagina: 2 });
  assert.equal(r.total, 12); assert.equal(r.items.length, 5); assert.equal(r.paginas, 3);
  const all = query(s.service.items, { limite: 200 }).items;
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].desconto_pct >= all[i].desconto_pct);
  assert.equal(query(s.service.items, { genero: 'acao' }).total, 8);          // acento ignorado
  assert.equal(query(s.service.items, { q: 'jogo a 1-' }).total, 3);
  assert.equal(query(s.service.items, { precoMax: 11 }).total, 8);
  assert.ok(all[0].id && all[0].vale.motivo && all[0].link_afiliado);
});

test('servidor HTTP: 202 na 1ª chamada, depois 200 com meta; /refresh protegido', async () => {
  const s = setup();
  const server = createServer(s.service, s.config);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/health')).status, 200);

    const first = await fetch(base + '/api/promos');
    assert.equal(first.status, 202);
    assert.equal(first.headers.get('retry-after'), '15');
    assert.equal((await first.json()).status, 'atualizando');

    await s.service.jobPromise;
    const ok = await fetch(base + '/api/promos?limite=5&ordenar=preco');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), '*');
    const body = await ok.json();
    assert.equal(body.data.length, 5);
    assert.equal(body.meta.total, 24);
    assert.equal(body.meta.desatualizado, false);

    const one = await (await fetch(`${base}/api/promos/${body.data[0].id}`)).json();
    assert.equal(one.data.titulo, body.data[0].titulo);
    assert.equal((await fetch(base + '/api/promos/naoexiste')).status, 404);

    const csv = await fetch(base + '/api/promos.csv?loja=loja b');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.equal((await csv.text()).trim().split('\n').length, 13);   // cabeçalho + 12

    const f = await (await fetch(base + '/api/filtros')).json();
    assert.equal(f.data.lojas.length, 2);

    assert.equal((await fetch(base + '/api/refresh', { method: 'POST' })).status, 401);
    const before = calls(s);
    const rf = await fetch(base + '/api/refresh', { method: 'POST', headers: { 'X-API-Key': 'segredo' } });
    assert.equal(rf.status, 200); assert.equal((await rf.json()).status, 'cache_valido');
    assert.equal(calls(s), before);
    const forced = await fetch(base + '/api/refresh?force=1', { method: 'POST', headers: { 'X-API-Key': 'segredo' } });
    assert.equal(forced.status, 202);
    await s.service.jobPromise;
    assert.equal(calls(s), before + 8);

    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(st.total_ofertas, 24); assert.equal(st.atualizando, false);
    assert.equal((await fetch(base + '/api/refresh')).status, 405);
    assert.equal((await fetch(base + '/nada')).status, 404);
  } finally { server.close(); }
});

test('sem API_KEY o /refresh fica desativado', async () => {
  const s = setup(); s.config.apiKey = '';
  const server = createServer(s.service, s.config);
  await new Promise((r) => server.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/refresh`, { method: 'POST' });
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('Instant Gaming: extrai o JSON embutido e normaliza as linhas', () => {
  const hit = (o) => ({ prod_id: 7, seo_name: 'foo', fullname: 'Foo (PC)', name: 'Foo', price_converted: '12.5', retail: '50', retail_currency: 'BRL',
    discount: 75, platform_names: ['PC'], type: 'Steam', has_stock: 1, updated_at: 123, ...o });
  const json = JSON.stringify({ nbPages: 42, hits: [hit({}), hit({ prod_id: 8, is_dlc: true, retail_currency: 'EUR', price_converted: 'x' })] });
  const html = `<script>var a=1; window.searchResults = ${json}; var b=2;</script>`;
  const r = ig.parse(html, '2026-01-01T00:00:00.000Z');
  assert.equal(r.totalPages, 42);
  assert.equal(r.rows.length, 1);                                // preço inválido é descartado
  assert.equal(r.rows[0].preco_brl, 12.5);
  assert.equal(r.rows[0].preco_original_brl, 50);
  assert.equal(r.rows[0].link, 'https://www.instant-gaming.com/pt/7-comprar-foo/');
  assert.throws(() => ig.parse('<html></html>', 'x'), /layout mudou/);
});

test('Nuuvem: parser (precisa do cheerio instalado)', { skip: !(() => { try { require.resolve('cheerio'); return true; } catch { return false; } })() }, () => {
  const nv = require('../src/scrapers/nuuvem');
  const html = `<div class="pagination"><a class="pagination--item">1</a><a class="pagination--item">9</a></div>
  <a href="/item/bar" data-default-highlight-tracker-product-tracking-data-param='{"genre":"RPG"}'>
   <article data-component="product-card"><img class="game-cover__item" src="/img/bar.jpg">
    <div class="game-card__product-name"><span class="type-badge">DLC</span> Bar</div>
    <div class="mod-price" data-price='{"v":1990}' data-base-price='{"v":9990}'></div>
    <span class="product-price--discount">-80%</span>
    <div class="platform-tags__item"><span>PC</span></div><div class="drm-activation__item"><span>Steam</span></div>
   </article></a>`;
  const r = nv.parse(html, 'now');
  assert.equal(r.totalPages, 9);
  assert.equal(r.rows.length, 1);
  const x = r.rows[0];
  assert.deepEqual([x.titulo, x.tipo, x.genero, x.preco_brl, x.preco_original_brl, x.desconto_pct, x.link],
    ['Bar', 'DLC', 'RPG', 19.9, 99.9, 80, 'https://www.nuuvem.com/item/bar']);
});

test('Instant Gaming: pede BRL por parâmetro e cookie', () => {
  const r = ig.request(2, { headers: { 'User-Agent': 'x' }, cookie: 'a=b', currency: 'BRL' });
  assert.match(r.url, /currency=BRL/); assert.match(r.url, /page=2/);
  assert.equal(r.headers.Cookie, 'a=b; currency=BRL');
  assert.doesNotMatch(ig.request(1, { headers: {}, currency: '' }).url, /currency/);
});

const epic = require('../src/scrapers/epic');
const el = (o) => ({ title: 'Jogo', id: '1', isCodeRedemptionOnly: false, keyImages: [{ type: 'OfferImageTall', url: 'https://img/x.jpg' }],
  tags: [{ id: '1216' }, { id: '9547' }, { id: '10719' }], categories: [{ path: 'games/edition/base' }], offerMappings: [{ pageSlug: 'jogo-abc123', pageType: 'productHome' }],
  prePurchase: null, price: { totalPrice: { discountPrice: 1214, originalPrice: 1349, discount: 135, currencyCode: 'BRL', currencyInfo: { decimals: 2 } },
  lineOffers: [{ appliedRules: [{ endDate: '2026-10-12T16:00:00.000Z' }] }] }, ...o });
const wrap = (els, total = 7) => ({ data: { Catalog: { searchStore: { elements: els, paging: { count: els.length, total } } } } });

test('Epic: converte centavos, calcula desconto e monta link', () => {
  const { rows } = epic.parse(wrap([el({})]), 'now');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.preco_brl, r.preco_original_brl, r.desconto_pct, r.genero, r.plataforma, r.tipo, r.link, r.promo_termina_em],
    [12.14, 13.49, 10, 'Ação', 'PC / Mac', 'Jogo', 'https://store.epicgames.com/pt-BR/p/jogo-abc123', '2026-10-12T16:00:00.000Z']);
});

test('Epic: descarta sem desconto, outra moeda, só-código e sem slug; mantém 100% off e DLC', () => {
  const free = el({ categories: [{ path: 'addons' }], price: { totalPrice: { discountPrice: 0, originalPrice: 3999, currencyCode: 'BRL', currencyInfo: { decimals: 2 } }, lineOffers: [] } });
  const semDesc = el({ price: { totalPrice: { discountPrice: 2159, originalPrice: 2159, currencyCode: 'BRL', currencyInfo: { decimals: 2 } }, lineOffers: [] } });
  const usd = el({ price: { totalPrice: { discountPrice: 100, originalPrice: 500, currencyCode: 'USD', currencyInfo: { decimals: 2 } }, lineOffers: [] } });
  const code = el({ isCodeRedemptionOnly: true });
  const semSlug = el({ offerMappings: [], catalogNs: { mappings: [] }, productSlug: null, urlSlug: null });
  const { rows } = epic.parse(wrap([free, semDesc, usd, code, semSlug]), 'now');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desconto_pct, 100); assert.equal(rows[0].tipo, 'DLC');
});

test('Epic: paginação por offset e erros do GraphQL', () => {
  assert.equal(epic.body(1, { pageSize: 100 }).variables.start, 0);
  assert.equal(epic.body(3, { pageSize: 100 }).variables.start, 200);
  assert.equal(epic.body(1, {}).variables.country, 'BR');
  assert.throws(() => epic.parse({ errors: [{ message: 'boom' }] }, 'x'), /boom/);
  assert.throws(() => epic.parse({ data: {} }, 'x'), /searchStore/);
});

test('Epic: fetchPage calcula totalPages a partir de paging.total (fetch simulado)', async () => {
  const real = global.fetch;
  global.fetch = async (url, init) => { assert.match(url, /store\.epicgames\.com\/graphql/); assert.equal(JSON.parse(init.body).variables.onSale, true);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => wrap([el({})], 250) }; };
  try { const r = await epic.fetchPage(1, { pageSize: 100, nowIso: 'x', headers: {} }); assert.equal(r.totalPages, 3); assert.equal(r.rows.length, 1); }
  finally { global.fetch = real; }
});

test('stores: ENABLED_STORES liga/desliga lojas e link de afiliado da Epic', () => {
  const cfg = require('../src/config');
  const on = require('../src/stores')({ ...cfg, enabledStores: ['epic'] });
  assert.deepEqual(Object.keys(on), ['epic']);
  assert.deepEqual(Object.keys(require('../src/stores')(cfg)), ['instantgaming', 'epic']);
  const { affLink } = require('../src/dataset');
  assert.equal(affLink({ loja: 'Epic Games', link: 'https://store.epicgames.com/pt-BR/p/x' }, { epicCreator: 'abc' }), 'https://store.epicgames.com/pt-BR/p/x?epic_creator_id=abc');
  assert.equal(affLink({ loja: 'Epic Games', link: 'https://store.epicgames.com/pt-BR/p/x' }, {}), 'https://store.epicgames.com/pt-BR/p/x');
});
