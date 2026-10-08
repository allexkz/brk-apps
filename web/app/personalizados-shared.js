// Constantes da dashboard de personalizados usadas no SERVIDOR e no CLIENTE
// (módulos `.server` não podem ser importados pelo componente).

export const TABS = ["todos", "pendentes", "enviados", "semAtributos", "presos"];
// Abas paginadas pelo banco da dashboard (D1): o filtro depende do estado do Sankhya, não
// da Shopify — nelas busca/período não se aplicam.
export const D1_TABS = ["presos", "semAtributos"];
export const PAGE_SIZES = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;
// Idade (min) a partir da qual um pendente do Sankhya é "preso" (~3 ciclos do dreno de 15 min).
export const STUCK_MIN = 45;
// Ações em lote (ClickUp / Sankhya / Concluir) vão ao servidor em fatias deste tamanho:
// cada request fica dentro do limite de subrequests do Worker, qualquer que seja a seleção.
export const BULK_CHUNK = 15;
