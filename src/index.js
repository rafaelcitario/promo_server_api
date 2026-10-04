'use strict';
const config = require('./config');
const makeStores = require('./stores');
const { PromoService } = require('./service');
const { createServer } = require('./server');

async function main() {
  const service = new PromoService({ config, stores: makeStores(config) });
  await service.load();
  const server = createServer(service, config);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[http] promos-api na porta ${config.port} | ${config.maxPages} páginas/loja | cache ${config.ttlMs / 60000} min | dados em ${config.dataDir}`);
    if (!config.apiKey) console.log('[http] API_KEY não definida: POST /api/refresh está desativado');
    if (config.warmOnStart) service.ensureFresh();
  });
  const stop = () => { console.log('[http] encerrando…'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
