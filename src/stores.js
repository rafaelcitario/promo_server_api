'use strict';
const ig = require('./scrapers/instantgaming');
const nv = require('./scrapers/nuuvem');
const epic = require('./scrapers/epic');

// conc = conexões simultâneas, maxConc = teto, gap = intervalo mínimo (ms) entre o INÍCIO de dois pedidos.
// Lojas ativas: variável ENABLED_STORES (padrão: instantgaming,epic). A Nuuvem segue no código, mas desligada.
module.exports = (cfg) => {
  const all = {
    instantgaming: { id: 'instantgaming', nome: 'Instant Gaming', fetchPage: ig.fetchPage, conc: cfg.ig.conc, maxConc: 8, gap: cfg.ig.gap, cookie: cfg.ig.cookie, currency: cfg.ig.currency },
    epic: { id: 'epic', nome: 'Epic Games', fetchPage: epic.fetchPage, conc: cfg.epic.conc, maxConc: 4, gap: cfg.epic.gap, pageSize: cfg.epic.pageSize },
    nuuvem: { id: 'nuuvem', nome: 'Nuuvem', fetchPage: nv.fetchPage, conc: cfg.nv.conc, maxConc: 3, gap: cfg.nv.gap },
  };
  return Object.fromEntries(Object.entries(all).filter(([id]) => (cfg.enabledStores || Object.keys(all)).includes(id)));
};
