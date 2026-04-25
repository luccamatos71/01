---
description: Planeja ou implementa funcionalidades do CRM — histórico, pipeline e follow-up
---

Use the growth-ops agent.

Funcionalidade CRM solicitada: $ARGUMENTS

Siga este processo:

1. **Confirme escopo** — isso é histórico de leads, pipeline de status ou follow-up?
2. **Schema de dados** — o que precisa ser salvo, em qual formato (JSON/SQLite)?
3. **Rotas** — quais endpoints precisam existir em `server.js`?
4. **UI necessária** — quais componentes visuais precisam ser criados? (delegar ao ux-premium se complexo)
5. **Edge cases** — o que acontece se o arquivo não existir, se a API falhar, se o lead não tiver telefone?

Não toque em `gerarAnalise`, `gerarAnaliseManual` ou `classificarLead`.
Valide o plano com o usuário antes de implementar persistência de dados.
