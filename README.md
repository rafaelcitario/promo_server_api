# promos-api

API que raspa **Instant Gaming** e **Nuuvem** (preços em R$) e serve as promoções por HTTP, com cache em arquivo.
É a mesma lógica da extensão (limitador de velocidade com recuo em 429, histórico de preços, "vale a pena", links de afiliado),
agora rodando no servidor para qualquer cliente consumir: extensão, web, mobile ou desktop.

## Como o cache funciona

- Cada loja tem sua própria data de raspagem, guardada em `data/cache.json` (histórico de preços em `data/history.json`).
- **Qualquer chamada** a `/api/promos`, `/api/status`, etc. verifica há quanto tempo foi a última raspagem:
  - menos de **30 min** → responde direto do cache, sem tocar nas lojas;
  - 30 min ou mais (ou sem cache) → dispara a raspagem de até **300 páginas por loja** *em segundo plano*.
- Raspar 300 páginas leva alguns minutos, então a API **não deixa a requisição esperando**:
  - **já existe cache (mesmo vencido)** → responde na hora com ele (`meta.atualizando: true` indica que há raspagem rodando);
  - **primeira vez, sem nenhum dado** → `202 Accepted` + `Retry-After: 15`. Consulte `/api/status` ou repita a chamada.
- Nunca roda duas raspagens ao mesmo tempo. Se uma loja falhar, o cache anterior dela é mantido e a API só tenta de novo depois de 5 min.
- Se uma página falhar no meio, guarda o trecho já coletado (as primeiras páginas são as de maior desconto) e tenta completar após 5 min.

## Endpoints

| Método e rota | Descrição |
|---|---|
| `GET /health` | Liveness (não dispara raspagem). |
| `GET /api/status` | Estado do cache por loja, progresso da raspagem, erros. |
| `GET /api/promos` | Lista paginada (`{ meta, data }`). |
| `GET /api/promos/:id` | Uma oferta. |
| `GET /api/promos.csv` | Mesmos filtros, em CSV (sem paginação). |
| `GET /api/filtros` | Lojas, tipos, plataformas e gêneros disponíveis (com contagem). |
| `POST /api/refresh` | Força raspagem. Header `X-API-Key`. `?force=1` ignora a validade. |

**Filtros de `/api/promos`:** `q` (título ou gênero), `loja` (`instantgaming` \| `nuuvem`), `tipo` (Jogo, DLC, Pacote…),
`plataforma`, `genero`, `vale` (`Sim`/`Talvez`/`Não`), `desconto_min`, `preco_min`, `preco_max`, `indisponiveis=1`,
`ordenar` (`desconto` \| `preco` \| `titulo` \| `vale` \| `coletado`), `ordem` (`asc` \| `desc`), `pagina`, `limite` (padrão 50, máx. 200).

```bash
curl "https://SEU-APP.onrender.com/api/promos?loja=nuuvem&desconto_min=70&preco_max=30&ordenar=preco&limite=20"
curl -X POST "https://SEU-APP.onrender.com/api/refresh?force=1" -H "X-API-Key: SEU_SEGREDO"
```

Cada oferta:

```json
{
  "id": "a1b2c3d4e5f6",
  "titulo": "…", "tipo": "Jogo", "genero": "RPG", "plataforma": "PC", "ativacao": "Steam",
  "preco_brl": 19.9, "preco_original_brl": 99.9, "desconto_pct": 80,
  "indisponivel": false, "preorder": false, "loja": "Nuuvem",
  "coletado_em": "2026-10-04T03:00:00.000Z",
  "link": "https://…", "link_afiliado": "https://…", "img": "https://…",
  "vale": { "texto": "Sim", "score": 3, "motivo": "Estimativa: desconto alto (80%); …" }
}
```

Use `link_afiliado` para abrir a oferta (o `link` é o original, sem afiliado).

## Rodar localmente

```bash
npm install
cp .env.example .env     # opcional; as variáveis também podem ser exportadas no shell
npm start                # http://localhost:3000
npm test
```

## Deploy na Render

1. Crie um repositório no GitHub/GitLab com esta pasta e dê push.
2. Render → **New +** → **Blueprint** → escolha o repositório (usa o `render.yaml`).
   *(Alternativa manual: New + → Web Service; Build `npm install`; Start `npm start`; Health check `/health`.)*
3. Em **Environment**, copie o valor gerado de `API_KEY` (necessário para `POST /api/refresh`).
4. Chame `https://SEU-APP.onrender.com/api/promos`. A primeira resposta é `202`; repita após alguns minutos.

### Variáveis de ambiente

`MAX_PAGES` (300), `CACHE_TTL_MINUTES` (30), `RETRY_AFTER_FAIL_MINUTES` (5), `DATA_DIR`, `API_KEY`, `CORS_ORIGINS` (`*`),
`WARM_ON_START`, `IG_COOKIE`, `IG_CONCURRENCY`/`IG_GAP_MS`, `NV_CONCURRENCY`/`NV_GAP_MS`, `AFF_*`. Veja `.env.example`.

## Pontos de atenção

- **Bloqueio por IP.** Na extensão as requisições saíam do *seu* navegador/IP residencial. No servidor saem de um IP de datacenter,
  e Cloudflare costuma barrar esse tipo de tráfego (HTTP 403 / "Just a moment"). Se acontecer, `/api/status` mostra o erro em
  `lojas.*.ultimo_erro`. Nesse caso teste outra região da Render ou um proxy residencial; não há como contornar só no código.
- **Moeda do Instant Gaming.** O IG escolhe a moeda pelo IP; de um servidor nos EUA ele devolve USD. A API pede BRL por parâmetro e cookie
  (`IG_CURRENCY=BRL`), mas isso **precisa ser conferido**: chame `GET /api/debug/instantgaming` (header `X-API-Key`) e compare
  `price_converted`/`retail`/`discount` dos itens crus com o site. Depois de corrigir, force `POST /api/refresh?force=1`.
- **Nuuvem 403.** Cloudflare barra IPs de datacenter. Alternativas: proxy residencial (`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=...`, Node 22.21+),
  o feed de produtos do programa de afiliados (Rakuten), ou a extensão enviar os dados raspados do navegador do usuário para a API.
- **Plano free da Render.** O serviço hiberna após ~15 min sem tráfego e o disco é efêmero: ao acordar, o cache de arquivo some e a
  primeira chamada raspa de novo. Para cache persistente e serviço sempre ativo, use plano pago com disco (`render.yaml`, bloco `disk`).
- **Histórico de preços e "vale a pena".** O histórico cresce a cada raspagem. Sem disco persistente ele recomeça a cada reinício.
- **Tags do Instant Gaming** (fase 2 da extensão, 1 requisição por jogo) não foram portadas; a Nuuvem traz `genero` direto na listagem.
- Os dados vêm de scraping dos sites das lojas: respeite os termos de uso e mantenha o intervalo de 30 min.
