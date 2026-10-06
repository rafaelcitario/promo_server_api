'use strict';
const path = require('path');
const env = process.env;
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|sim|yes)$/i.test(v));

module.exports = {
  port: int(env.PORT, 3000),
  enabledStores: (env.ENABLED_STORES || 'instantgaming,epic').split(',').map((s) => s.trim()).filter(Boolean),
  maxPages: Math.max(1, int(env.MAX_PAGES, 300)),
  ttlMs: int(env.CACHE_TTL_MINUTES, 30) * 60_000,
  retryAfterFailMs: int(env.RETRY_AFTER_FAIL_MINUTES, 5) * 60_000,
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
  apiKey: env.API_KEY || '',
  corsOrigins: env.CORS_ORIGINS || '*',
  warmOnStart: bool(env.WARM_ON_START, false),
  userAgent: env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ig: { cookie: env.IG_COOKIE || '', currency: env.IG_CURRENCY ?? 'BRL', conc: int(env.IG_CONCURRENCY, 5), gap: int(env.IG_GAP_MS, 120) },
  epic: { conc: int(env.EPIC_CONCURRENCY, 2), gap: int(env.EPIC_GAP_MS, 400), pageSize: Math.max(1, int(env.EPIC_PAGE_SIZE, 100)) },
  nv: { conc: int(env.NV_CONCURRENCY, 2), gap: int(env.NV_GAP_MS, 700) },
  aff: {
    igr: env.AFF_IG ?? 'citario',
    nvId: env.AFF_NV_ID ?? 'c/wenaA4Ols',
    nvMid: env.AFF_NV_MID ?? '46796',
    nvU1: env.AFF_NV_U1 ?? 'citario',
    epicCreator: env.AFF_EPIC_CREATOR ?? '',   // código Support-A-Creator (opcional)
  },
};
