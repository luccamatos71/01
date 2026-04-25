# Lumyn — Documento de fundação do produto

## Visão do produto

A Lumyn é uma plataforma de inteligência comercial com IA, construída para acelerar o ciclo completo de prospecção B2C/B2B local.

O foco atual é transformar dados brutos do Google Maps em oportunidades reais de contato — com análise de prioridade, geração de mensagem adaptada ao nicho e disparo rápido via WhatsApp.

A visão de longo prazo é evoluir para uma plataforma completa de acompanhamento comercial: do primeiro contato até o fechamento, com histórico de leads, follow-up automatizado, CRM simples e gestão de tráfego.

**Princípio central:** velocidade operacional. Cada fluxo deve ser projetado para reduzir o número de cliques e o tempo entre identificar um lead e iniciar o contato.

---

## Prioridades do produto

Em ordem de importância:

1. **Velocidade operacional** — o SDR precisa prospectar mais rápido com menos fricção
2. **Clareza visual** — a interface comunica hierarquia sem ruído
3. **Experiência premium** — aparência de produto pronto para vender, não de protótipo
4. **Modularidade** — cada módulo é independente e pode evoluir sem quebrar os outros
5. **Simplicidade antes de complexidade** — preferir a solução mais direta que resolve o problema

---

## Stack técnica atual

- **Backend:** Node.js nativo (`http` module) — sem Express
- **Frontend:** Vanilla JS + HTML + CSS (sem frameworks)
- **IA:** OpenAI SDK (`gpt-4o-mini`) via `openai.chat.completions.create`
- **Dados:** Google Places API v1 (`places:searchText`, `places/{id}`)
- **Variáveis de ambiente:** `dotenv`
- **Servidor:** `node server.js` na porta 3000

Manter essa stack. Não adicionar dependências sem necessidade clara.

---

## Módulos atuais

### SDR Manual
- Usuário descreve o cenário de um lead em linguagem natural
- O sistema analisa e decide: vale abordar? qual prioridade?
- Lógica de porta: exige problema explícito antes de classificar como oportunidade
- Estado de sessão server-side (`estadoManual`) para follow-up conversacional
- Routing `[NOVO]` / `[FOLLOW-UP]` para distinguir cenário novo de refinamento

### Análise Google
- Usuário busca por nome ou link do Google Maps
- Sistema busca via Places API, retorna dados reais
- Análise SDR com as mesmas regras de classificação
- Mensagem de abordagem gerada automaticamente

### Buscar Leads
- Modal de busca por categoria + cidade
- Retorna até 20 resultados do Google Maps
- Classifica cada lead: ALTA / MÉDIA / BAIXA / DESCARTE
- Leads ALTA têm análise gerada em paralelo (`Promise.all`)
- Ordenação: prioridade → leads com telefone primeiro
- Drawer lateral deslizante (direita) com análise completa

### Geração de Mensagem
- Gerada automaticamente junto com a análise
- Tom adaptado por nicho (informal / equilibrado / profissional)
- Estrutura: abertura leve · observação do negócio · convite para call de 15-20 min
- Nunca menciona avaliações, notas ou dados técnicos
- Extraída da análise pelo padrão `Mensagem pronta:`

### Drawer de Análise
- Painel fixo no lado direito (400px, 100vh)
- Desliza sem bloquear a lista de leads
- Atualiza conteúdo sem fechar ao trocar de lead
- Botão "WhatsApp": monta link `web.whatsapp.com/send` com número + mensagem
- Botão "Copiar mensagem": extrai só a mensagem pronta para clipboard
- ESC fecha o drawer

---

## Lógica de classificação de leads (Google)

```
classificarLead(nota, avaliacoes, temSite):
  - sem nota ou sem avaliações   → BAIXA
  - > 300 aval + nota > 4.3 + site → DESCARTE
  - > 300 aval                   → BAIXA
  - < 20 aval                    → ALTA
  - 20–150 aval + nota 3.0–4.3  → ALTA
  - resto                        → MÉDIA
```

**Nunca alterar esta lógica sem análise de impacto.** É a fundação da triagem.

---

## Lógica SDR Manual — portas de decisão

```
PASSO 0: só categoria + cidade sem contexto → pedir mais informação

PORTA 1: problema explícito mencionado?
  NÃO → Vale abordar: NÃO | Prioridade: BAIXA | encerrar

PORTA 2: há força + falha, ou só falha?
  Força + Falha → ALTA ou MÉDIA
  Só Falha      → ALTA

PROIBIDO:
- inventar problema não escrito
- deduzir falha de sinal positivo
- usar ausência de dado como problema
- "talvez", "pode indicar", "pode não estar"
```

---

## Módulos futuros (roadmap)

| Módulo | Descrição | Prioridade |
|---|---|---|
| Histórico de leads | Salvar leads analisados com status (contatado, respondeu, fechou) | Alta |
| CRM simples | Pipeline visual: novo → contatado → em negociação → fechado | Alta |
| Follow-up | Lembrete e geração de mensagem de acompanhamento | Média |
| Gestor de tráfego | Integração com Meta Ads para segmentação baseada nos nichos prospectados | Baixa |
| Landing / site Lumyn | Página de apresentação do produto para venda | Baixa |

---

## Regras de construção

### Antes de implementar qualquer coisa
1. Leia os arquivos afetados antes de editar
2. Entenda a arquitetura do módulo que será alterado
3. Confirme que a mudança não quebra módulos adjacentes
4. Prefira editar arquivos existentes a criar novos
5. Nunca adicionar dependências sem necessidade clara

### Sobre o backend (`server.js`)
- Toda lógica de negócio fica no servidor
- Prompts de IA ficam dentro das funções `gerarAnalise*` correspondentes
- Não expor chaves de API no frontend
- Manter o padrão de resposta `{ resposta, erro, modo, ... }`

### Sobre o frontend (`index.html`)
- Sem frameworks — Vanilla JS puro
- Estado local mínimo: só o necessário para o fluxo ativo
- CSS em design tokens (variáveis `--nome`) para consistência
- Não duplicar lógica que já existe no servidor

### Sobre IA e prompts
- Prompts são regras de negócio — tratar com o mesmo cuidado que código
- Toda mudança em prompt requer verificação de consistência com a classificação existente
- Nunca usar linguagem ambígua ("talvez", "pode") nas instruções ao modelo
- Exemplos de referência no prompt devem ter o comportamento esperado explícito

---

## Direção visual

**Referências:** Linear, Notion, Stripe Dashboard, AppMax, V4/G4

**Princípios:**
- Dark mode permanente — fundo `#07080f`, superfícies `#0c0e1a` / `#101226`
- Uma borda, uma opacidade: `rgba(255,255,255,0.07)` em todo lugar
- Espaçamento em grid de 8px: 8, 12, 16, 20, 24
- Border radius em escala: 6 / 8 / 12 / 16px
- Tipografia: Inter — 10 / 11 / 12 / 13 / 14 / 16 / 20px
- Sem sombras pesadas, sem gradientes chamativos, sem bordas duplas
- Hover sempre sutil — `rgba(255,255,255,0.02~0.04)` de diferença

**O que nunca fazer:**
- Bordas visíveis entre elementos irmãos (caixas dentro de caixas)
- Fundo branco ou cinza claro em qualquer área
- `font-size` abaixo de 10px ou acima de 20px na interface
- Animações longas (máximo 220ms)
- Elementos sem propósito funcional claro

---

## Direção comercial (mensagens SDR)

**Objetivo de cada mensagem:** abrir conversa, não fechar venda.

**Estrutura obrigatória:**
1. Abertura leve (1 linha)
2. Observação sobre o negócio adaptada ao nicho (1 linha)
3. Convite para conversa de 15-20 min (1 linha)

**Tom por nicho:**
- Informal (restaurante, barbearia, loja): direto, sem formalidade, "Fala,"
- Equilibrado (clínica, escola, coaching): acessível mas profissional, "Olá,"
- Profissional (advocacia, contabilidade): consultivo, sem gírias

**Sempre proibido:**
- Citar avaliações, notas ou dados técnicos da análise
- "Faço parte do time comercial"
- "Identificamos uma oportunidade"
- Linguagem de auditoria ou relatório
- Mensagem genérica copiável para qualquer negócio

---

## Arquitetura de arquivos

```
IA - APP - LUMYN/
├── server.js        # Backend completo — rotas, IA, Google Places
├── index.html       # Frontend completo — HTML + CSS + JS
├── .env             # OPENAI_API_KEY, GOOGLE_API_KEY (nunca commitar)
├── package.json     # Apenas: dotenv, openai
└── CLAUDE.md        # Este arquivo
```

---

## Variáveis de ambiente necessárias

```
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
```

---

## Como rodar

```bash
node server.js
# Abre em http://localhost:3000
```

Requer Node.js 18+ (usa `fetch` nativo).

## CLIENTES

### RIVANO

- segmento: óculos / eyewear
- posicionamento: premium acessível
- estilo: editorial, elegante, minimalista
- estética: limpa, sofisticada, magazine style
- cores: neutras, suaves, refinadas
- comunicação: sutil, não agressiva
- objetivo: gerar desejo e percepção de valor
- canal principal: Instagram + WhatsApp
- erro a evitar: visual poluído, promoção agressiva, estética popular

---

### COM TEMPERO

- segmento: alimentação / restaurante
- posicionamento: acessível, local, direto
- estilo: chamativo, apetitoso, direto
- estética: comida em destaque, cores quentes
- cores: vermelho, amarelo, contraste alto
- comunicação: clara, objetiva, voltada para conversão
- objetivo: gerar desejo imediato e pedido
- canal principal: WhatsApp / delivery
- erro a evitar: visual frio, sem apelo de comida, estética muito sofisticada
