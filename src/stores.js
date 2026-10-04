'use strict';
const ig = require('./scrapers/instantgaming');
const nv = require('./scrapers/nuuvem');

// conc = conexões simultâneas, maxConc = teto, gap = intervalo mínimo (ms) entre o INÍCIO de dois pedidos.
// A Nuuvem aplica 429 com facilidade, por isso começa mais devagar.
module.exports = (cfg) => ({
  instantgaming: { id: 'instantgaming', nome: 'Instant Gaming', fetchPage: ig.fetchPage, conc: cfg.ig.conc, maxConc: 8, gap: cfg.ig.gap, cookie: cfg.ig.cookie, currency: cfg.ig.currency },
  nuuvem: { id: 'nuuvem', nome: 'Nuuvem', fetchPage: nv.fetchPage, conc: cfg.nv.conc, maxConc: 3, gap: cfg.nv.gap },
});
