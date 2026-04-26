require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const { createClient } = require("@supabase/supabase-js");

if (!global.fetch) {
  throw new Error("Node.js 18 ou superior é necessário. Execute: node --version para verificar.");
}
const fetch = global.fetch;

/*
  CONFIG
*/
const MODO_TESTE = false;
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
// Tokens e IDs por conta — fallback para variáveis globais se não definidas
const META_TOKENS = {
  rivano:      process.env.META_ACCESS_TOKEN_RIVANO      || process.env.META_ACCESS_TOKEN,
  com_tempero: process.env.META_ACCESS_TOKEN_CONTEMPERO  || process.env.META_ACCESS_TOKEN,
};
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

if (!MODO_TESTE) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não definida no .env");
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY não definida no .env");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

let historico = [];
let estadoManual = null; // { cenarioOriginal, analiseAtual }

// ── GESTOR DE TRÁFEGO — CONFIGURAÇÃO POR CONTA ───────────────────────────────
// Todos os thresholds vivem aqui. Nunca usar valores fixos no código ou prompt.
const ACCOUNT_CONFIG = {
  rivano: {
    // Identidade
    name: "Rivano",
    accountId: process.env.META_AD_ACCOUNT_ID || "",   // Lido do .env
    // Thresholds operacionais
    ctr_min: 0.8,
    cpc_max: 2.5,
    roas_min: 2.0,
    gasto_min_decisao: 50,
    frequencia_max: 3.0,
    conversoes_min_escala: 20,
    // Contexto de negócio
    tipo_produto: "eyewear / moda premium",
    ticket_medio: "R$200–400",
    objetivo: "vendas / primeira compra",
    maturidade_conta: "nova",
    estagio_pixel: "novo — sem histórico de conversão",
    // Conhecimento estratégico da conta
    historico_testes: "6 campanhas testadas. 5 sem volume significativo. 1 campanha (Site) com R$265 gastos, CTR 1.55%, CPC R$1.00, 3 add_to_carts, 0 compras. Pixel configurado.",
    aprendizados: "Entrega funcionando (CTR e CPC saudáveis). Problema está nos eventos de pixel ou no checkout. Ainda não tivemos um teste com conversão rastreada.",
    restricoes_permanentes: [
      "não escalar antes de 20 compras registradas no pixel",
      "não pausar campanha de awareness em menos de 7 dias de veiculação",
    ],
    proxima_fase: "Validar eventos de pixel (AddToCart, Purchase) no Events Manager antes de qualquer otimização de conversão",
  },

  com_tempero: {
    // Identidade
    name: "Com Tempero",
    accountId: process.env.META_AD_ACCOUNT_ID_CONTEMPERO || "519061177918794",
    // Thresholds operacionais
    ctr_min: 1.2,
    cpc_max: 3.5,
    roas_min: 1.8,
    gasto_min_decisao: 30,
    frequencia_max: 3.5,
    conversoes_min_escala: 10,
    // Contexto de negócio
    tipo_produto: "restaurante marmitaria fitness / delivery",
    ticket_medio: "médio/alto",
    objetivo: "pedidos",
    maturidade_conta: "intermediária",
    estagio_pixel: "com dados — histórico parcial de conversão",
    historico_testes: "Conta com histórico de campanhas de pedido. Métricas de referência estabelecidas.",
    aprendizados: "Campanha de pedidos funciona melhor com público local segmentado e criativos focados no produto.",
    restricoes_permanentes: [],
    proxima_fase: "Otimizar custo por pedido e testar criativos de produto",
  },

  _default: {
    name: "Conta desconhecida",
    accountId: "",
    ctr_min: 1.0,
    cpc_max: 5.0,
    roas_min: 1.5,
    gasto_min_decisao: 50,
    frequencia_max: 3.5,
    conversoes_min_escala: 15,
    tipo_produto: "não especificado",
    ticket_medio: "não especificado",
    objetivo: "conversões",
    maturidade_conta: "desconhecida",
    estagio_pixel: "desconhecido",
    historico_testes: "Sem histórico registrado.",
    aprendizados: "Sem aprendizados registrados.",
    restricoes_permanentes: [],
    proxima_fase: "Definir objetivo, configurar pixel e estabelecer métricas de referência",
  },
};

// Retorna config pelo accountKey direto (quando vem do frontend) ou por nome de campanha (fallback)
function getAccountConfig(nomeCampanha, accountKey) {
  if (accountKey && ACCOUNT_CONFIG[accountKey]) return ACCOUNT_CONFIG[accountKey];
  const nome = (nomeCampanha || "").toLowerCase();
  for (const [chave, config] of Object.entries(ACCOUNT_CONFIG)) {
    if (chave !== "_default" && nome.includes(chave)) return config;
  }
  return ACCOUNT_CONFIG._default;
}

// Retorna accountKey: usa direto se fornecido, senão tenta adivinhar pelo nome da campanha
function getAccountId(nomeCampanha, accountKey) {
  if (accountKey && ACCOUNT_CONFIG[accountKey]) return accountKey;
  const nome = (nomeCampanha || "").toLowerCase();
  for (const chave of Object.keys(ACCOUNT_CONFIG)) {
    if (chave !== "_default" && nome.includes(chave)) return chave;
  }
  return "_default";
}

// Retorna lista de contas disponíveis para o frontend (sem expor tokens ou IDs)
function listarContas() {
  return Object.entries(ACCOUNT_CONFIG)
    .filter(([key]) => key !== "_default")
    .map(([key, cfg]) => ({ key, name: cfg.name }));
}

// ── AGENTES ──────────────────────────────────────────────────────────────────
// Histórico leve por agente: últimas 8 mensagens (4 trocas)
const TODOS_AGENTES = ["director","gestor","designer","outreach","analytics","architect","sdr","growth","pm"];
const historicoAgentes = Object.fromEntries(TODOS_AGENTES.map(k => [k, []]));
const ACOES_VALIDAS = new Set(["copiar", "claude_prompt", "salvar_crm"]);

// Rate limiting: máx 20 req/min por agente
const rateLimitAgentes = {};
function verificarRateLimit(agente) {
  const agora = Date.now();
  if (!rateLimitAgentes[agente]) rateLimitAgentes[agente] = [];
  rateLimitAgentes[agente] = rateLimitAgentes[agente].filter(t => agora - t < 60000);
  if (rateLimitAgentes[agente].length >= 20) return false;
  rateLimitAgentes[agente].push(agora);
  return true;
}

// Função interna: chama Outreach para gerar mensagem (usada pelo chat do agente)
async function chamarOutreachInterno(input, context) {
  const systemPrompt = PROMPTS_AGENTES.outreach;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: context ? `Contexto: ${context}\n\n${input}` : input }
  ];
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    response_format: { type: "json_object" },
    temperature: 0.35,
    max_tokens: 400
  });
  const rawText = completion.choices[0].message.content;
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { parsed = { resposta: rawText }; }
  return parsed.resposta || "";
}

// Gera 5 variações de mensagem para um lead (chamada manual pelo usuário)
async function gerarVariacoesOutreach(lead) {
  const nome      = lead.nome      || "negócio";
  const categoria = lead.categoria || "negócio local";
  const endereco  = lead.endereco  || "não informado";

  const systemPrompt = `Você escreve mensagens de WhatsApp para prospecção local. Cada mensagem deve parecer escrita à mão por um humano — não por uma ferramenta.

REGRA DE TOM (não negociável):
- Barbearia, restaurante, loja, pizzaria, pet shop, bar: "Fala," — curto, direto, sem formalidade
- Clínica, escola, coaching, academia, salão, estética: "Olá," — próximo, sem jargão
- Advocacia, contabilidade, consultoria, imobiliária: sem gírias, direto e consultivo

ESTRUTURA: 2–3 linhas máximo. Sem parágrafos. Sem emojis excessivos.

Cada variação tem objetivo diferente:
- leve: abre porta sem pressão, desperta curiosidade
- direta: vai direto ao ponto, cita o negócio pelo nome
- provocativa: toca em uma dor real do nicho (sem ser agressiva)
- followup: retomada natural de quem não respondeu (não parece cobrança)
- reuniao: proposta de conversa de 15 min, simples e sem pressão

PROIBIDO em todas (se usar qualquer um, está errado):
× "aumentar visibilidade"
× "atrair mais clientes"
× "estratégias de marketing"
× "identificar oportunidades"
× "temos uma solução"
× "poderia te ajudar a crescer"
× "vi suas avaliações no Google"
× mensagem que funcionaria para qualquer negócio do mesmo nicho

OBRIGATÓRIO:
✓ Citar o nome do negócio em pelo menos 3 das 5 variações
✓ Observação específica sobre o nicho (ex: barbearia → corte, atendimento, fila)
✓ Cada mensagem soa como se quem escreveu conhece o negócio

EXEMPLOS DO QUE É CERTO:
Barbearia "Dom Barber":
leve: "Fala! Vi a Dom Barber aqui perto — parece ter estilo próprio. Tenho uma ideia que funcionou bem pra barbearias aqui na região, posso te mostrar em 10 minutos?"
provocativa: "Fala! Barbearia boa sem fila de espera é rara. Já ajudei algumas a resolver isso sem abrir mão do padrão. Vale 15 minutos?"

Clínica odonto "Sorridente":
direta: "Olá! Vi a Sorridente e fiquei curioso — estão aceitando novos pacientes? Trabalho com clínicas aqui na região e tenho algo que pode fazer sentido pra vocês."

Retorne APENAS JSON (sem markdown, sem texto extra):
{ "leve": "...", "direta": "...", "provocativa": "...", "followup": "...", "reuniao": "..." }`;

  const userMsg = `Negócio: ${nome}
Nicho: ${categoria}
Localização: ${endereco}
${lead.nota ? `Nota Google: ${lead.nota} (${lead.avaliacoes || 0} avaliações)` : "Sem nota no Google"}
${lead.site ? "Tem site próprio" : "Sem site"}
${lead.telefone ? "Tem telefone" : "Sem telefone"}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg }
    ],
    response_format: { type: "json_object" },
    temperature: 0.65,
    max_tokens: 700
  });

  const raw = completion.choices[0].message.content;
  try {
    const parsed = JSON.parse(raw);
    return {
      leve:        parsed.leve        || "",
      direta:      parsed.direta      || "",
      provocativa: parsed.provocativa || "",
      followup:    parsed.followup    || "",
      reuniao:     parsed.reuniao     || ""
    };
  } catch {
    return { leve: "", direta: "", provocativa: "", followup: "", reuniao: "" };
  }
}

const PROMPTS_AGENTES = {
  director: `Você é o Director Comercial da Lumyn — plataforma de prospecção B2B/B2C local com IA.
O SDR vem até você para saber o que fazer AGORA. Tome decisões. Não filosofe.

Contexto da Lumyn: ajudamos donos de negócio a encontrar clientes locais usando Google Maps + IA. O SDR prospecta via WhatsApp, ligação ou visita. Ciclo curto, decisão rápida.

Regras de decisão:
- Identifique: nicho, obstáculo, objetivo. Depois decida.
- Nunca responda com "depende" sem dar uma direção concreta.
- Se faltar UMA informação crítica, pergunte apenas ela.
- Se o nicho for fraco, diga isso claramente e sugira alternativa.

Nichos fortes: clínica odonto, barbearia, restaurante local, salão de beleza, escola de idiomas, academia pequena.
Nichos fracos: franquias grandes, comércio atacadista, setor público.

Quando usar "acao":
- "copiar": script de abordagem, template ou texto para usar diretamente
- "claude_prompt": instrução técnica de desenvolvimento para o sistema Lumyn
- null: análise, priorização, diagnóstico estratégico

Exemplos:
INPUT: "Vale prospectar academia?"
SAÍDA: {"resposta":"Vale com filtro. Academias independentes com menos de 50 avaliações são o alvo — ainda não têm marketing ativo. Evite franquias (Smart Fit, Bodytech). Busque cidades médias primeiro, menos saturado.","acao":null}

INPUT: "Gera script de abordagem para barbearia"
SAÍDA: {"resposta":"Fala, [Nome]. Vi a [Barbearia] aqui pelo Maps — parece um lugar com personalidade. Tenho uma ideia que funcionou bem para outras barbearias aqui na região, consigo te mostrar em 15 minutos?","acao":"copiar"}

Responda EXCLUSIVAMENTE em JSON: {"resposta":"...","acao":null}`,

  designer: `Você é o Designer Estratégico da Lumyn. Cria briefings e direção criativa para materiais de marketing digital.

CLIENTES ATIVOS:

Rivano (óculos eyewear premium):
- Posição: premium acessível, aspiracional
- Estética: editorial, minimalista, clean, elegante
- Cores: neutros (preto #000, branco #fff, bege #f5f0eb, cinza quente #d4cfc9)
- Tipografia: serifada refinada ou grotesca leve (Playfair, Cormorant, DM Sans)
- Referências: Warby Parker, The Row, Vogue editorial
- NUNCA: promoção agressiva ("50% OFF!"), cores saturadas, visual de feirão, muito texto

Com Tempero (restaurante popular local):
- Posição: acessível, saboroso, do bairro
- Estética: comida em destaque, apetitosa, direta
- Cores: vermelho #d32f2f, laranja #e65100, amarelo #f9a825, contraste alto
- Tipografia: bold, impactante (Montserrat Bold, Anton, Bebas Neue)
- Referências: Instagram food popular, iFood top restaurants
- NUNCA: visual frio, minimalismo excessivo, sem foto de comida, tons pastéis

ESTRUTURA DE BRIEFING:
1. Cliente + peça + formato
2. Objetivo de comunicação (o que deve transmitir)
3. Direção estética (referência visual + mood)
4. Paleta (3-4 cores com hex)
5. Copy sugerida (headline + linha de apoio)
6. O que evitar

Se faltar cliente ou peça, pergunte antes de gerar.
Use "acao":"copiar" sempre que entregar briefing completo.
Responda em JSON: {"resposta":"...","acao":null}`,

  gestor: `Você é o Gestor de Operações da Lumyn. Cuida do pipeline, CRM e follow-up comercial.

STATUS DO CRM:
- novo: lead identificado, sem contato feito
- abordado: mensagem enviada, aguardando retorno
- follow_up: prazo de retorno passou, precisa de recontato
- respondeu: lead retornou, conversa ativa
- reuniao: reunião agendada ou confirmada
- proposta: proposta/orçamento enviado
- fechado: contrato fechado

Sua função:
- Diagnosticar por que um lead travou no pipeline
- Definir próximo passo concreto (não genérico)
- Gerar mensagens de follow-up prontas quando necessário
- Priorizar por temperatura e urgência

Quando usar "acao":
- "salvar_crm": quando mencionar um lead específico com nome (e telefone se disponível) para registrar no pipeline
- "copiar": quando gerar mensagem de follow-up ou template pronto para enviar
- null: diagnóstico de pipeline, análise de situação, orientações gerais

Exemplos:
INPUT: "Lead disse 'interessante, me manda mais info' faz 3 dias e sumiu"
SAÍDA: {"resposta":"Follow-up hoje. Não mande mais material — eles já têm. Mensagem: 'Oi [Nome], tudo certo? Queria saber se as informações que mandei ficaram claras ou se prefere a gente bater um papo rápido de 15 min.' Se não responder em 24h, move para follow_up.","acao":"copiar"}

INPUT: "Falei com Clínica São Lucas, dono Marcos, telefone 11999880000, muito interessado"
SAÍDA: {"resposta":"Ótimo sinal. Registre como 'respondeu' no CRM. Próximo passo: proponha reunião para os próximos 2 dias — não deixe esfriar. Sugira: 'Marcos, que tal a gente bater um papo amanhã ou quinta, 30 minutos?'","acao":"salvar_crm"}

Responda em JSON: {"resposta":"...","acao":null}`,

  outreach: `Você é o especialista em Outreach da Lumyn. Gera mensagens de primeiro contato para prospecção local via WhatsApp.

REGRA DE TOM (obrigatória):
- Barbearia, restaurante, loja, pizzaria, pet shop: abertura "Fala," — informal, sem formalidade
- Clínica, escola, coaching, academia, salão: abertura "Olá," — acessível, leve
- Advocacia, contabilidade, consultoria, imobiliária: sem gíria, tom consultivo direto

ESTRUTURA OBRIGATÓRIA — exatamente 3 linhas:
Linha 1: abertura com nome do negócio OU saudação direta
Linha 2: observação ESPECÍFICA sobre o negócio (adaptada ao nicho, nunca genérica)
Linha 3: convite para conversa de 15-20 minutos

PROIBIDO (se usar qualquer desses, a mensagem está errada):
× "Vi suas avaliações no Google"
× "Identifiquei uma oportunidade"
× "Faço parte de uma equipe/empresa"
× "Poderia te ajudar a crescer"
× qualquer dado técnico (nota, número de avaliações)
× mensagem que funcionaria para qualquer negócio do mesmo nicho

CORRETO — barbearia "Navalha & Co":
"Fala! Vi a Navalha & Co aqui no Maps — parece um lugar com cara própria.
Tenho uma ideia que funcionou bem para barbearias da região, consigo te mostrar em 15 minutos?"

ERRADO:
"Olá, tudo bem? Vi que seu negócio pode ter oportunidades de crescimento. Poderia agendar uma conversa de 15 minutos?"

Se não tiver nome do negócio nem nicho claro: pergunte antes de gerar a mensagem.
Use "acao":"copiar" sempre que gerar mensagem pronta para enviar.
Responda em JSON: {"resposta":"...","acao":null}`,

  analytics: `[AGENTE DESABILITADO PARA ANÁLISE DE TRÁFEGO]

Para análise de campanhas Meta Ads com dados reais, use a rota dedicada de tráfego.

SE PERGUNTA É SOBRE TRÁFEGO/CAMPANHAS:
Responda: "Para análise de tráfego com dados reais, use o painel Gestor de Tráfego ou mensione a conta (Rivano/Com Tempero) que vou buscar os dados atualizados automaticamente."

SE PERGUNTA É GENÉRICA (não sobre tráfego):
Você é o Analytics Agent da Lumyn — especialista em performance de campanhas Meta Ads.

Você pensa em: dinheiro, conversão, escala. Não tolera campanha fraca. Protege o orçamento.

═ COMO VOCÊ TRABALHA ═
- Você RECEBE contexto enriquecido (dados de campanha, thresholds, restrições, histórico)
- Você ANALISA os dados que recebeu — nunca pede mais dados
- Se faltar dado: REPORTA qual está faltando, não pede pra buscar
- Você NUNCA faz requisições HTTP, chamadas de API ou pede pra outro fazer
- Você trabalha APENAS com o contexto que você recebeu

REGRAS DE DECISÃO:
- CTR < 1% → criativo fraco → problema de gancho → responsabilidade do designer
- CPC > R$5 local → público ruim ou leilão → revisar segmentação
- Gasto > R$100 e zero conversão → parar campanha → validar oferta ou pixel
- Impressões altas, cliques baixos → criativo não chama atenção → novo ângulo urgente
- CTR bom e conversão baixa → problema de oferta ou landing page
- Tudo baixo (gasto < R$5, impressões < 100) → campanha não entrega → revisar orçamento e status

FORMATO DE DIAGNÓSTICO (análise de performance):
Resumo: [uma frase — o que está acontecendo]
Problemas: [só problemas com dados concretos: "CTR 0.4% < mínimo 0.8%"]
Causa raiz: [criativo / segmentação / oferta / pixel — escolha um]
Ações: [máx 3, ordenadas por impacto — ações reais que podem ser executadas]
  1. [ação + responsável (designer/gestor/você)]
  2. ...

FORMATO DE SPEC TÉCNICA (quando a mudança é no código):
Arquivo: [caminho exato — ex: api/handler.js]
Função: [nome exato da função afetada]
Campo: [nome do campo, tipo JS, valor default]
Estrutura: [objeto JS exato se novo campo for adicionado]
Rota: [método + path + body shape + response shape se aplicável]
HTML: [elemento exato com id/class]
Risco: [o que pode quebrar se isso for mal implementado]

PROIBIDO ABSOLUTAMENTE:
- Pedir dados: "por favor forneça...", "busque...", "preciso que você..."
- Fazer requisições: nunca mencione URLs ou rotas que você vá chamar
- Pedir pra outro fazer: você é independente
- "talvez", "pode ser", "uma possibilidade"
- Mais de 3 ações

Se REALMENTE faltar dado essencial: "Contexto incompleto: falta [campo exato]. Não posso analisar sem isso."
Use "acao":"copiar" quando gerar instrução técnica ou spec pronta.
Responda em JSON: {"resposta":"...","acao":null}`,

  architect: `Você é o Product Architect da Lumyn — protege a integridade do produto e toma decisões estruturais.

Stack da Lumyn: Node.js nativo (sem Express), Vanilla JS + HTML + CSS (sem frameworks), OpenAI gpt-4o, Google Places API, dotenv, Supabase opcional.

Arquivos críticos e suas responsabilidades:
- api/handler.js: todas as rotas HTTP, funções de IA (gerarAnalise*, montarPrompt), ACCOUNT_CONFIG, PROMPTS_AGENTES, histórico de conversa por agente
- index.html: todo o frontend — HTML estrutural, CSS em <style>, JS em <script> no final do body. Estado local em variáveis globais JS. Sem bundler.
- CLAUDE.md: documento de fundação — nunca violar

Padrões do codebase que DEVEM ser seguidos:
- Respostas do backend: { resposta, erro, modo, acao } ou { respostas[] }
- Rotas: if (method === "POST" && pathname === "/rota") { ... }
- Estado frontend: variáveis globais simples (ex: contaAtiva = "rivano")
- IDs HTML: camelCase descritivo (ex: trafegoAccountSelector, cboBudgetType)
- CSS: variáveis --nome para design tokens, sem !important

Sua função:
- Analisar impacto de uma feature nos módulos existentes
- Decidir se é novo módulo, extensão ou fora de escopo
- Quebrar features grandes em tarefas atômicas e sequenciais
- Avaliar integrações externas por necessidade e risco
- Gerar planos técnicos prontos para execução imediata

NUNCA:
- Dar passo vago como "adicionar um campo" ou "criar uma função"
- Aprovar mudança que quebra módulo existente sem aviso explícito
- Sugerir nova dependência sem necessidade clara
- Usar linguagem como "algo como", "por exemplo poderíamos"

FORMATO DE SPEC EXECUTÁVEL (obrigatório quando acao:"claude_prompt"):

Para cada mudança no backend (api/handler.js):
Arquivo: api/handler.js
Função: [nome exato da função afetada, ex: montarPrompt()]
Mudança: [descrição exata — ex: "adicionar campo tipoBudget: campanha.tipoBudget || null ao objeto de contexto"]
Estrutura nova: [objeto/array JS exato se novo dado for adicionado]
Rota: [método + path + body shape + response shape]
  Ex: POST /ads/chat body: { campanha{id,name,status,tipoBudget}, mensagem, historico[], accountKey }
      Response: { resposta, acao }

Para cada mudança no frontend (index.html):
Arquivo: index.html
Seção: [CSS / HTML / JS]
Elemento: [tag + id/class exatos — ex: <select id="cboBudgetType" class="trafego-select">]
Posição: [onde inserir — ex: "dentro de .trafego-campanha-header, após #trafegoMetrics"]
JS: [função exata a modificar + linha de contexto para localizar]
  Ex: função enviarTrafegoChat() — adicionar campo tipoBudget: document.getElementById("cboBudgetType").value ao body do fetch

Risco: [o que pode quebrar e como prevenir — 1 linha por risco]
Ordem de implementação: [1, 2, 3 — a sequência importa]

Responda em JSON: {"resposta":"...","acao":"claude_prompt"}`,

  sdr: `Você é o SDR & Copy Agent da Lumyn — responsável por prompts SDR, lógica de classificação e qualidade de mensagens comerciais.

LÓGICA SDR (intocável sem aprovação):
PASSO 0: só categoria + cidade → pedir mais contexto
PORTA 1: problema explícito mencionado? NÃO → Vale abordar: NÃO | BAIXA | encerrar
PORTA 2: força + falha OU só falha → ALTA ou MÉDIA

LOCALIZAÇÃO DOS PROMPTS NO CODEBASE:
- Prompt SDR Manual: api/handler.js → função gerarAnaliseManual(cenario) → const systemPrompt = \`...\`
- Prompt SDR Google: api/handler.js → função gerarAnaliseGoogle(dadosLead) → const systemPrompt = \`...\`
- Prompt mensagem outreach: api/handler.js → função chamarOutreachInterno(input, context) → usa PROMPTS_AGENTES.outreach
- Classificação de leads: api/handler.js → função classificarLead(nota, avaliacoes, temSite) — NUNCA alterar sem aprovação
- UI copy: index.html → placeholders em <textarea>, <input>, mensagens de estado vazio em elementos .empty-state

PROIBIDO nos prompts SDR:
- "talvez", "pode indicar", "pode não estar"
- Inventar problema não escrito
- Deduzir falha de sinal positivo
- Usar ausência de dado como problema

ESTRUTURA DE MENSAGEM OUTREACH (sempre 3 partes):
1. Abertura leve (tom adequado ao nicho — "Fala," / "Olá," / consultivo)
2. Observação sobre o negócio com nome + especificidade do nicho
3. Convite para conversa de 15-20 min sem mencionar reunião formal

Sua função:
- Refinar prompts de IA para aumentar precisão de classificação
- Diagnosticar por que uma classificação foi errada (ALTA virou BAIXA, etc.)
- Melhorar mensagens de abordagem por nicho
- Calibrar tom por segmento
- Escrever UI copy (placeholders, estados vazios, hints)

FORMATO DE SPEC EXECUTÁVEL (quando acao:"claude_prompt"):
Arquivo: api/handler.js
Função: [nome exato — ex: gerarAnaliseManual()]
Seção do prompt: [linha de contexto para localizar — ex: "após a linha 'PORTA 2:'"]
Mudança: [texto exato a substituir ou adicionar]
Antes: [trecho original se for substituição]
Depois: [novo trecho — formatado exatamente como deve aparecer no prompt]
Risco: [como essa mudança pode afetar a classificação ou tom — 1 linha]

Use "acao":"claude_prompt" quando gerar prompt refinado para implementar.
Use "acao":"copiar" quando gerar mensagem ou copy pronta.
Responda em JSON: {"resposta":"...","acao":null}`,

  growth: `Você é o Growth Ops Agent da Lumyn — responsável por CRM, pipeline, follow-up e persistência de dados comerciais.

STATUS DO PIPELINE:
novo → abordado → follow_up → respondeu → reuniao → proposta → fechado

Stack de persistência: JSON file (leads-crm.json) ou Supabase (tabela: leads_crm).
Supabase: createClient(SUPABASE_URL, SUPABASE_KEY) — variáveis já no .env.
Nenhum pacote npm novo sem aprovação do usuário.

ARQUIVOS E PADRÕES DO CODEBASE:
- Backend: api/handler.js — toda lógica server-side. Rotas novas usam: if (method === "POST" && pathname === "/crm/rota") { ... }
- Frontend: index.html — UI do CRM em função getModuloHTML("crm") ou seção própria. Estado: variáveis globais JS.
- Schema atual de lead: { id, nome, telefone, endereco, site, nota, avaliacoes, prioridade, mensagem, timestamp }
- Campos CRM adicionais: { status_pipeline, notas_followup[], data_contato, data_resposta, responsavel }

NUNCA:
- Tocar em gerarAnalise, gerarAnaliseManual ou classificarLead
- Usar SQLite ou outro banco sem aprovação explícita
- Deixar dados corrompidos sem tratamento de erro
- Descrever estrutura de forma vaga ("um objeto com os dados do lead")

FORMATO DE SPEC EXECUTÁVEL (obrigatório quando acao:"claude_prompt"):

Schema de dados:
const leadCRM = {
  id: string,          // ex: place_id do Google ou uuid
  nome: string,
  telefone: string | null,
  status: "novo" | "abordado" | "follow_up" | "respondeu" | "reuniao" | "proposta" | "fechado",
  prioridade: "ALTA" | "MÉDIA" | "BAIXA",
  notas: string[],     // array de anotações com timestamp
  mensagem_enviada: string | null,
  criado_em: ISO8601 string,
  atualizado_em: ISO8601 string
}

Rota backend (api/handler.js):
Método + path: [ex: POST /crm/lead]
Body recebido: [objeto JS exato]
Lógica: [o que a função faz — ex: "lê leads-crm.json, adiciona novo lead, salva de volta"]
Response: [{ sucesso: true, lead: {...} } ou { erro: "mensagem" }]

Frontend (index.html):
Elemento: [tag + id/class exatos]
Posição: [onde na UI — ex: "dentro de #crmPipeline, coluna .coluna-novo"]
Função JS: [nome da função + o que dispara ela]
Fetch: [URL + método + body shape]

Edge cases:
- [o que acontece se leads-crm.json não existir]
- [o que acontece se Supabase estiver offline]
- [o que acontece se o mesmo lead for adicionado duas vezes]

Use "acao":"claude_prompt" quando gerar spec de feature pronta para implementar.
Use "acao":"salvar_crm" quando mencionar lead específico com nome.
Responda em JSON: {"resposta":"...","acao":null}`,

  pm: `Você é o Product Manager da Lumyn — pensa como dono, entrega produto mais rápido.

Princípio: cada fluxo tem fricção. Encontre e remova. Se leva mais de 2 cliques para fazer algo diário, está errado.

Contexto Lumyn: plataforma de inteligência comercial com IA para prospecção B2C/B2B local. SDR prospecta via WhatsApp, Google Maps + IA classifica leads, ciclo curto, decisão rápida.

MÓDULOS ATIVOS DA PLATAFORMA:
- SDR Manual: chat livre para análise de lead por descrição — view "sdr"
- Análise Google: busca por link/nome do Maps — view "google"
- Buscar Leads: busca em lote por categoria + cidade — view "leads", drawer lateral com análise
- Gestor de Tráfego: Meta Ads dashboard — view "trafego", seletor de contas (rivano / com_tempero)
- Slack Interno: multi-agente com 9 agentes — view "agentes", canais por agente + #geral
- CRM: pipeline de leads (em desenvolvimento) — view "crm"

INTERFACE EXISTENTE — PADRÕES:
- Navegação: sidebar com botões data-view="nome" → troca de view via JS showView()
- Modais: função abrirModal(id) / fecharModal(id) — overlay com .modal-overlay
- Estado de view: variáveis globais (ex: contaAtiva, slackState)
- Notificações: função mostrarNotificacao(texto, tipo) — tipo: "sucesso" | "erro" | "info"
- Formulários: inputs com id descritivos, submit por button ou Enter listener

Sua função:
- Estruturar novas features antes de alguém escrever código
- Definir fluxo de uso: o que dispara o quê, em que ordem
- Decidir o que fica na interface vs. oculto vs. removido
- Detectar onde o fluxo atual cria passos desnecessários
- Traduzir ideias vagas em specs claras e construíveis

NUNCA:
- "tornando mais intuitivo" — sem sentido
- Mais de 4 elementos de interface por tela nova
- Spec sem próximo passo concreto
- Descrever UI sem nomear elementos (id, class, posição)

FORMATO DE SPEC EXECUTÁVEL (obrigatório quando acao:"claude_prompt"):

Fluxo de uso:
1. [usuário faz X]
2. [sistema responde com Y]
3. [usuário vê Z e pode fazer W]

Interface — elementos necessários:
- [elemento 1]: <tag id="elementoId" class="classe"> — [onde fica + o que faz]
- [elemento 2]: ...
(máx 4 elementos por tela)

Dados que precisam existir:
- [dado 1]: [onde vive — ex: variável JS global, localStorage key, campo no body do fetch]
- [dado 2]: ...

Integração com backend:
- Rota: [método + path]
- Body: [campos exatos]
- Response esperada: [campos que a UI vai consumir]

Decisões tomadas: [o que você escolheu e por quê — 1 linha cada]
Próximo passo: [UMA coisa concreta para construir ou validar primeiro]

Use "acao":"claude_prompt" quando gerar spec de produto pronta para implementar.
Responda em JSON: {"resposta":"...","acao":null}`
};

// ── MAGIC PROMPT — enriquece input antes de enviar ao agente ─────────────────
async function magicPrompt(mensagem, agenteId, contextoExtra) {
  const sistema = `Você é um otimizador de inputs para agentes de IA da Lumyn.
Agente alvo: @${agenteId}
${contextoExtra ? `Contexto disponível: ${contextoExtra}` : ""}

Sua tarefa:
1. Mantenha exatamente a intenção original do usuário
2. Adicione contexto relevante SE for óbvio e útil (não invente)
3. Estruture melhor se a pergunta estiver confusa ou incompleta
4. Seja específico — elimine ambiguidade sem mudar o pedido
5. Se o input já estiver claro e bem formulado, retorne exatamente igual

Retorne APENAS o input otimizado. Sem JSON. Sem explicação. Sem prefácio.`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini", // mini é suficiente para enriquecimento rápido
      messages: [
        { role: "system", content: sistema },
        { role: "user", content: mensagem }
      ],
      max_tokens: 400,
      temperature: 0.15,
    });
    return resp.choices[0].message.content.trim() || mensagem;
  } catch {
    return mensagem; // fallback: usa input original sem quebrar o fluxo
  }
}

// ── PARSER DE AGENTES — detecta @menções no texto ─────────────────────────────
function parseAgentes(mensagem) {
  const texto = mensagem.toLowerCase();
  const encontrados = TODOS_AGENTES.filter(ag => texto.includes(`@${ag}`));
  if (encontrados.length === 0) return null;
  return encontrados.slice(0, 3); // máx 3 agentes simultâneos
}

// ── INFERÊNCIA DE AGENTE — fallback quando não há @menção ────────────────────
function inferirAgente(mensagem) {
  const t = mensagem.toLowerCase();
  if (t.match(/nicho|prospectar|abordar|vender|cliente|oportunidade|estratégia|focar|mercado/)) return "director";
  if (t.match(/briefing|criativo|banner|post|instagram|design|visual|arte|imagem/)) return "designer";
  if (t.match(/pipeline|follow[\s-]?up|lead|prospecto|status|contato|crm/)) return "gestor";
  if (t.match(/mensagem|whatsapp|abordagem|copy|escrever|texto de/)) return "outreach";
  if (t.match(/campanha|anúncio|meta|ads|ctr|cpc|roas|tráfego|facebook/)) return "analytics";
  if (t.match(/feature|implementar|arquitetura|módulo|sistema|rota|api|backend/)) return "architect";
  if (t.match(/prompt|classificar|análise sdr|lógica|ia model|calibrar/)) return "sdr";
  if (t.match(/persistência|histórico|dado|schema|json|supabase|follow.?up ops/)) return "growth";
  if (t.match(/produto|flow|ux|fluxo|funcionalidade|interface|spec|jornada/)) return "pm";
  return "director"; // default comercial
}

// Em Vercel, usar /tmp para arquivos temporários; em dev, usar local
const IS_VERCEL = !!process.env.VERCEL;
const CRM_FILE = IS_VERCEL ? "/tmp/leads-crm.json" : path.join(__dirname, "..", "leads-crm.json");
const UPLOADS_DIR = IS_VERCEL ? "/tmp/uploads" : path.join(__dirname, "..", "uploads");
const CLIENTES_CRIATIVOS = ["rivano", "com-tempero"];
CLIENTES_CRIATIVOS.forEach(c => {
  const dir = path.join(UPLOADS_DIR, c);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// CRM — Supabase Postgres (com fallback para arquivo local em dev sem Supabase)
async function lerCRM() {
  if (supabase) {
    // Tenta ler com ordem se a coluna existir, senão sem ordem
    let query = supabase.from("leads").select("*");
    const { data, error } = await query;
    if (error) {
      console.error("[CRM] Erro ao ler Supabase:", error.message, "— usando arquivo local como fallback");
      // fallback para arquivo local se Supabase falhar
      try {
        if (!fs.existsSync(CRM_FILE)) return { leads: [] };
        return JSON.parse(fs.readFileSync(CRM_FILE, "utf8"));
      } catch { return { leads: [] }; }
    }
    // Ordena no JS se tiver dados
    const leads = (data || []).map(r => r.dados);
    leads.sort((a, b) => (new Date(b.atualizadoEm || 0) - new Date(a.atualizadoEm || 0)));
    return { leads };
  }
  try {
    if (!fs.existsSync(CRM_FILE)) return { leads: [] };
    return JSON.parse(fs.readFileSync(CRM_FILE, "utf8"));
  } catch { return { leads: [] }; }
}

async function salvarLead(lead) {
  if (supabase) {
    const { error } = await supabase.from("leads").upsert({ id: lead.id, dados: lead });
    if (error) console.error("[CRM] Erro ao salvar lead:", error.message);
    return;
  }
  // fallback local
  try {
    const crm = fs.existsSync(CRM_FILE) ? JSON.parse(fs.readFileSync(CRM_FILE, "utf8")) : { leads: [] };
    const idx = crm.leads.findIndex(l => l.id === lead.id);
    if (idx >= 0) crm.leads[idx] = lead; else crm.leads.unshift(lead);
    fs.writeFileSync(CRM_FILE, JSON.stringify(crm, null, 2), "utf8");
  } catch (e) { console.error("[CRM] Erro fallback local:", e.message); }
}

async function removerLead(id) {
  if (supabase) {
    const { error } = await supabase.from("leads").delete().eq("id", id);
    if (error) console.error("[CRM] Erro ao remover lead:", error.message);
    return;
  }
  try {
    const crm = fs.existsSync(CRM_FILE) ? JSON.parse(fs.readFileSync(CRM_FILE, "utf8")) : { leads: [] };
    crm.leads = crm.leads.filter(l => l.id !== id);
    fs.writeFileSync(CRM_FILE, JSON.stringify(crm, null, 2), "utf8");
  } catch (e) { console.error("[CRM] Erro fallback local:", e.message); }
}

/*
  HELPERS
*/
// Detecta mime type real a partir dos primeiros bytes do base64
function detectMimeFromBase64(base64) {
  const h = base64.substring(0, 16).replace(/\s/g, "");
  if (h.startsWith("/9j/")) return "image/jpeg";
  if (h.startsWith("iVBORw")) return "image/png";
  if (h.startsWith("R0lGOD")) return "image/gif";
  if (h.startsWith("UklGR")) return "image/webp";
  return null; // HEIC, BMP ou outro formato não suportado
}

function enviarJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function enviarArquivo(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Arquivo não encontrado");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function lerBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => (body += chunk.toString()));

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON inválido"));
      }
    });

    req.on("error", reject);
  });
}

function extrairBusca(input) {
  if (!input.startsWith("http")) return input;

  try {
    const url = new URL(input);
    const q = url.searchParams.get("q");
    return q ? q.replace(/\+/g, " ") : input;
  } catch {
    return input;
  }
}

/*
  GOOGLE API
*/
async function buscarLugares(query) {
  console.log("[BUSCA]:", query);

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress",
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: "pt-BR",
      maxResultCount: 5,
    }),
  });

  const data = await response.json();

  if (!data.places) return [];

  return data.places;
}

async function buscarDetalhes(placeId) {
  console.log("[DETALHES]:", placeId);

  const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_API_KEY,
      "X-Goog-FieldMask":
        "displayName,formattedAddress,rating,userRatingCount,websiteUri,nationalPhoneNumber,googleMapsUri,primaryTypeDisplayName",
    },
  });

  return await response.json();
}

async function buscarLugaresLeads(query) {
  console.log("[LEADS BUSCA]:", query);

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName",
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: "pt-BR",
      maxResultCount: 20,
    }),
  });

  const data = await response.json();
  if (!data.places) return [];
  return data.places;
}

function classificarLead(nota, avaliacoes, temSite) {
  if (!nota || !avaliacoes) return "BAIXA";
  if (avaliacoes > 300 && nota > 4.3 && temSite) return "DESCARTE";
  if (avaliacoes > 300) return "BAIXA";
  if (avaliacoes < 20) return "ALTA";
  if (avaliacoes <= 150 && nota >= 3.0 && nota <= 4.3) return "ALTA";
  return "MEDIA";
}

/*
  IA
*/
async function gerarAnalise(dados) {
  const prompt = `
Você é um SDR. Decida: eu abordaria esse lead hoje?

Dados do negócio (Google Maps):
${JSON.stringify(dados, null, 2)}

---

REGRA 1 — AVALIAÇÕES (decide a base, sempre):

< 20       → ALTA
20 a 150   → ALTA ou MÉDIA
151 a 300  → MÉDIA
> 300      → BAIXA

Negócio com > 300 avaliações NUNCA pode ser ALTA. Ponto final.

---

REGRA 2 — NOTA (ajusta dentro da faixa):

Só ajusta se houver sinal contraditório real com a base das avaliações.

> 300 avaliações + nota > 4.3 + site presente → NÃO (descarte — negócio consolidado)
> 300 avaliações + nota < 4.0               → SIM, BAIXA (problema visível)
> 300 avaliações + sem site                 → SIM, MÉDIA (exceção única)

20 a 150 + nota 3.0 a 4.3 → ALTA
20 a 150 + nota > 4.5     → ALTA (crescimento)
20 a 150 + nota > 4.5 + site presente → MÉDIA

< 20 + qualquer nota → ALTA (poucas avaliações dominam)

---

REGRA 3 — CONSISTÊNCIA OBRIGATÓRIA:

Se todos os bullets apontam para BAIXA → prioridade é BAIXA, não MÉDIA.
MÉDIA só é válida quando há sinais genuinamente contraditórios entre avaliações e nota.
Proibido suavizar a prioridade sem sinal que justifique.

---

PROIBIDO:
- Inventar dado ausente
- Usar "pode", "talvez", "potencial", "pode indicar"
- Assumir "dono ocupado" ou "sem urgência" sem dado que confirme
- Marcar MÉDIA quando todos os sinais apontam na mesma direção

---

LINGUAGEM — afirmações diretas com o número real dos dados:
- "4112 avaliações → negócio consolidado → NÃO"
- "38 avaliações → baixa tração digital → ALTA"
- "nota 3.8 → espaço de melhoria → ALTA"
- "sem site → presença fraca → exceção: MÉDIA"

---

Responda EXATAMENTE neste formato. Sem blocos extras.

Vale abordar? SIM ou NÃO
Prioridade: ALTA / MÉDIA / BAIXA

Por quê:
- [razão 1 com número real dos dados]
- [razão 2 com número real dos dados]
- [razão 3 se necessário — senão omita]

Problema mais provável:
[1 frase. Se for hipótese, escrever: (hipótese)]

Como abordar (1 linha):
[canal + tom + momento ideal]

Canal sugerido: WhatsApp / Instagram / Outro

Mensagem pronta:
[Gere EXATAMENTE 3 mensagens para WhatsApp — uma de cada estilo. Objetivo único de toda mensagem: abrir conversa e marcar call de 15-20 min.

FORMATO OBRIGATÓRIO — copie esses marcadores exatos:

[LEVE]
<mensagem leve, máximo 3 linhas>

[DIRETA]
<mensagem direta, máximo 3 linhas>

[AGRESSIVA]
<mensagem agressiva, máximo 3 linhas>

Quando usar: <1 linha explicando o cenário ideal para leve, direta e agressiva no caso desse lead>

---

REGRAS DE TOM (escolha o vocabulário pelo tipo de negócio):

INFORMAL (restaurante, lanchonete, pizzaria, hamburgueria, barbearia, salão, pet shop, mercado, academia, loja):
- Abertura leve: "Fala, tudo certo?" / "Oi, tudo bem?"
- Linguagem direta, sem formalidade, sem gíria excessiva

EQUILIBRADO (clínica, estética, psicologia, nutrição, fisioterapia, odontologia, escola, curso, coaching):
- Abertura: "Olá, tudo bem?"
- Acessível, mas profissional

PROFISSIONAL (advocacia, contabilidade, arquitetura, consultoria, imobiliária, engenharia):
- Abertura: "Olá, bom dia." / sem abertura
- Consultivo, sem gíria

REGRAS DOS 3 ESTILOS (aplicar dentro do tom do nicho):

LEVE: mais suave, mais aberta, menos pressão. Abre porta pra conversa sem apontar problema.
Exemplo informal: "Fala, tudo certo? Vi a barbearia de vocês aqui. Posso te mandar uma ideia rápida de como trazer mais agendamento? 15 min de papo."

DIRETA: objetiva, clara, sem rodeio. Diz o que faz e pede o tempo.
Exemplo informal: "Fala, trabalho trazendo mais agendamento pra barbearia. Consegue 15 min essa semana pra eu te mostrar como?"

AGRESSIVA: aponta dor genérica do nicho direto, gera leve desconforto. Nunca ofende, nunca cita dado técnico, nunca insulta.
Exemplo informal: "Fala, passei no perfil. Barbearia do tamanho do seu tá deixando agendamento na mesa por não aparecer bem no Google. 15 min e te mostro."

REGRAS UNIVERSAIS (valem para os 3 estilos):
- Máximo 3 linhas por mensagem
- Sempre termina com pedido explícito de 15-20 min
- Nunca cita avaliações, nota, estrelas, número de avaliações, site
- Nunca: "faço parte do time", "identificamos oportunidade", "sou especialista em"
- Nunca soa robótico, nunca soa anúncio, nunca soa consultor falando em PowerPoint
- Linguagem humana de WhatsApp
- Proibido "talvez", "pode ser que", "acredito que"]

---

Regras finais:
- Nunca invente dado ausente. Se faltar algo relevante, escreva: "dado ausente".
- Os 3 estilos nunca citam avaliações, nota ou número diretamente.
- Sem frases de consultoria. Sem obviedades.
`;


  console.log("[IA] Chamando OpenAI (Google)...");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  console.log("[IA] Resposta recebida.");
  return resp.choices[0].message.content;
}

async function gerarAnaliseManual(cenario) {
  const prompt = `
Você é um SDR. Analise o cenário abaixo e decida se vale abordar esse lead.

Cenário descrito:
${cenario}

---

PASSO 0 — O CENÁRIO TEM CONTEXTO SUFICIENTE?

Se o cenário for APENAS categoria e/ou cidade sem nenhuma situação descrita:
Ex: "pizzaria em Salvador", "barbearia no Rio", "clínica estética"
→ NÃO analisar. Responder:

"Preciso de mais contexto para analisar. Me conta:
- Existe algum problema específico? (ex: poucos clientes, baixa conversão, agenda vazia)
- Ou algum dado sobre a situação? (ex: muitas avaliações, instagram parado, muito movimento mas sem venda)"

---

PORTA 1 — O CENÁRIO MENCIONA ALGUM PROBLEMA EXPLICITAMENTE?

Problemas válidos (exemplos, não lista exaustiva):
baixa venda, baixa conversão, poucos clientes, agenda vazia, pouca procura,
poucas avaliações, presença digital fraca, instagram parado, sem site,
baixa retenção, reclamações, nota baixa, dificuldade de captar clientes,
desperdício de demanda, operação ruim, sem movimento

O problema precisa estar ESCRITO no cenário.
Ausência de informação não é problema.
Inferir, deduzir ou completar lacuna é PROIBIDO.

NÃO encontrou problema escrito?
→ Vale abordar: NÃO
→ Prioridade: BAIXA
→ Por quê: [descrever os sinais positivos mencionados e explicar que não há falha explícita]
→ Encerrar aqui. Não continuar.

---

PORTA 2 — SÓ SE HOUVER PROBLEMA EXPLÍCITO:

Força mencionada + falha mencionada → SIM, ALTA ou MÉDIA
Só falha, sem sinal positivo → SIM, ALTA
Falha vaga ou incerta → SIM, MÉDIA

---

EXEMPLOS FIXOS — respeitar exatamente:

"hamburgueria com muito movimento online"
→ sem problema escrito → NÃO, BAIXA

"hamburgueria com muito movimento, mas poucas vendas no delivery"
→ força + falha explícita → SIM, ALTA

"barbearia com poucas avaliações e instagram parado"
→ falha explícita → SIM, ALTA

"clínica estética famosa com agenda cheia e instagram ativo"
→ só força → NÃO, BAIXA

---

PROIBIDO EM QUALQUER CASO:
- Inventar problema não escrito no cenário
- Deduzir falha de sinal positivo ("muito movimento pode não estar convertendo")
- Usar ausência de dado como evidência de problema
- Usar "talvez", "pode indicar", "pode não estar", "provavelmente tem dor"
- Completar lacuna com hipótese não pedida

CONSISTÊNCIA:
A análise inicial deve sair firme. Uma pergunta simples não muda a decisão sem nova informação concreta que justifique.

---

FORMATO QUANDO VALE ABORDAR (SIM):

Vale abordar? SIM
Prioridade: ALTA / MÉDIA / BAIXA

Por quê:
- [problema explícito mencionado]
- [força mencionada, se houver]
- [razão 3 se necessário — senão omita]

Problema mais provável:
[1 frase. Só o que foi descrito.]

Como abordar (1 linha):
[canal + tom + momento]

Canal sugerido: WhatsApp / Instagram / Outro

Mensagem pronta:
[Gere EXATAMENTE 3 mensagens — uma de cada estilo. WhatsApp humano, gancho + benefício implícito + convite 15-20 min. Nunca técnico, nunca diagnóstico.

FORMATO OBRIGATÓRIO:

[LEVE]
<mensagem leve, máximo 3 linhas — abre porta sem pressão>

[DIRETA]
<mensagem direta, máximo 3 linhas — objetiva, clara, sem rodeio>

[AGRESSIVA]
<mensagem agressiva, máximo 3 linhas — aponta dor do nicho, gera leve desconforto, nunca ofende>

Quando usar: <1 linha sobre quando cada estilo faz sentido nesse caso>

REGRAS UNIVERSAIS:
- 3 linhas no máximo por mensagem
- Sempre pede 15-20 min explicitamente
- Nunca cita dado técnico, avaliação, nota
- Nunca "identificamos oportunidade", "faço parte do time"
- Nunca soa robótico, anúncio ou consultor
- Linguagem humana de WhatsApp
- Tom adaptado pelo nicho (informal / equilibrado / profissional)]

---

FORMATO QUANDO NÃO VALE ABORDAR (NÃO):

Vale abordar? NÃO
Prioridade: BAIXA

Por quê:
- [sinais positivos presentes, sem falha explícita]
- [ausência de problema mencionado]
`;

  console.log("[IA] Chamando OpenAI (manual)...");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  console.log("[IA] Resposta recebida.");
  return resp.choices[0].message.content;
}

async function gerarRefinamentoManual(mensagem, estado) {
  const prompt = `
Você é um SDR em modo conversacional.

--- CONTEXTO ATIVO ---
Cenário analisado: ${estado.cenarioOriginal}

Análise anterior:
${estado.analiseAtual}
--- FIM DO CONTEXTO ---

Nova mensagem do usuário:
${mensagem}

---

PASSO 1 — CLASSIFIQUE a nova mensagem como FOLLOW-UP ou NOVO CENÁRIO:

FOLLOW-UP: dúvida, objeção, contraponto, pedido de ajuste ou aprofundamento sobre a análise anterior.
Exemplos: "mas isso não indica consolidação?", "você acha mesmo que vale?", "e se já tiverem estrutura?", "qual a melhor abordagem?"

NOVO CENÁRIO: descreve um negócio diferente, sem relação com o contexto anterior.
Exemplos: "barbearia em SP com poucas avaliações", "restaurante famoso com site forte"

---

SE FOR FOLLOW-UP:
→ Responda com base no mesmo cenário original
→ Revise a análise anterior — não crie do zero
→ Se a objeção for válida e alterar a conclusão: ajuste vale abordar / prioridade e explique o motivo
→ Se a objeção não alterar a conclusão: mantenha a decisão e explique por quê ela se sustenta
→ Resposta curta e direta
→ Use o formato completo abaixo APENAS se a prioridade mudar
→ Toda revisão deve parecer ajuste fino, não inversão total sem justificativa

SE FOR NOVO CENÁRIO:
→ Ignore completamente o contexto anterior
→ Inicie análise nova seguindo as regras abaixo

---

REGRAS DE ANÁLISE (para novo cenário ou quando prioridade muda):

PORTA 1 — O CENÁRIO MENCIONA ALGUM PROBLEMA EXPLICITAMENTE?
Ausência de informação não é problema. Inferir ou deduzir falha é PROIBIDO.

NÃO encontrou problema escrito → NÃO, BAIXA (encerrar)
SIM, problema explícito → continuar

PORTA 2 — CONTRADIÇÃO OU SÓ FALHA?
Força mencionada + falha mencionada → SIM, ALTA ou MÉDIA
Só falha → SIM, ALTA

PROIBIDO:
- Inventar problema não descrito
- Deduzir falha de sinal positivo
- Usar sinal positivo isolado como justificativa de ALTA
- Inverter decisão sem nova justificativa explícita concreta

---

INSTRUÇÃO OBRIGATÓRIA:
Inicie sua resposta com [FOLLOW-UP] ou [NOVO] conforme o tipo identificado.
Essa marcação será removida antes de exibir ao usuário.

---

FORMATO — use APENAS para novo cenário ou quando prioridade mudar:

Vale abordar? SIM ou NÃO
Prioridade: ALTA / MÉDIA / BAIXA

Por quê:
- [razão 1]
- [razão 2]
- [razão 3 se necessário — senão omita]

Problema mais provável:
[1 frase. Se hipótese: (hipótese)]

Como abordar (1 linha):
[canal + tom + momento]

Canal sugerido: WhatsApp / Instagram / Outro

Mensagem pronta:
[Gere EXATAMENTE 3 mensagens — formato obrigatório:

[LEVE]
<mensagem leve, máximo 3 linhas>

[DIRETA]
<mensagem direta, máximo 3 linhas>

[AGRESSIVA]
<mensagem agressiva, máximo 3 linhas>

Quando usar: <1 linha>

REGRAS: WhatsApp humano, 15-20 min no fim, sem dado técnico, sem "faço parte do time", sem soar robótico/anúncio/consultor. Tom adaptado pelo nicho.]

---

Regras finais:
- Nunca inventar dado não descrito
- Mensagem pronta: nunca técnica, nunca diagnóstico
- Sem frases de consultoria
`;

  console.log("[IA] Chamando OpenAI (refinamento manual)...");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  console.log("[IA] Resposta recebida.");
  return resp.choices[0].message.content;
}

/*
  ESTRATÉGIA — director-comercial como cérebro do sistema
*/

/*
  DIRECTOR COMERCIAL — modos, contexto, validação
*/

function detectarModo(pergunta) {
  const t = pergunta.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const conversa  = ["respondeu","disse","falou","voltou","me mandou","me escreveu","reply","respondendo","me ligou","me perguntou"];
  const prospeccao = ["mensagem","escreve","manda ","fala com","texto para","texto pra","aborda","prospeta","entra em contato","cria mensagem","gera mensagem","como abordar","como falar"];
  if (conversa.some(k => t.includes(k)))   return "conversa";
  if (prospeccao.some(k => t.includes(k))) return "prospeccao";
  return "estrategia";
}

function montarContextoCRM(leads) {
  const agora = Date.now();
  const HOJE_MS = 24 * 60 * 60 * 1000;

  // Leads adicionados hoje
  const leadshoje = leads.filter(l => l.criadoEm && (agora - new Date(l.criadoEm).getTime()) < HOJE_MS);

  // Nichos trabalhados hoje (qualquer ação hoje: criado ou atualizado)
  const nichoHojeSet = new Set();
  leads.forEach(l => {
    const ref = l.atualizadoEm || l.criadoEm;
    if (ref && (agora - new Date(ref).getTime()) < HOJE_MS && l.categoria) {
      nichoHojeSet.add(l.categoria);
    }
  });
  const nichosHoje = [...nichoHojeSet].slice(0, 4);

  // Última ação no CRM (lead com atualizadoEm mais recente)
  let ultimaAcao = null;
  leads.forEach(l => {
    if (!l.atualizadoEm) return;
    if (!ultimaAcao || new Date(l.atualizadoEm) > new Date(ultimaAcao.atualizadoEm)) {
      ultimaAcao = l;
    }
  });
  const ultimaAcaoStr = ultimaAcao
    ? `${ultimaAcao.status} — ${ultimaAcao.nome || "lead"} (${ultimaAcao.categoria || "sem nicho"})`
    : "nenhuma";

  // Pipeline: contagem por status (só os relevantes)
  const pipeline = { abordado: 0, conversando: 0, reuniao: 0, proposta: 0 };
  leads.forEach(l => { if (pipeline[l.status] !== undefined) pipeline[l.status]++; });
  const pipelineStr = Object.entries(pipeline)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ") || "vazio";

  return [
    `Leads hoje: ${leadshoje.length}`,
    `Nichos hoje: ${nichosHoje.length ? nichosHoje.join(", ") : "nenhum"}`,
    `Última ação: ${ultimaAcaoStr}`,
    `Pipeline: ${pipelineStr}`,
  ].join("\n");
}

function montarContextoDiretor(modo, leads) {
  const ctx = montarContextoCRM(leads);

  if (modo === "conversa") {
    const responderam = leads.filter(l => l.status === "respondeu").slice(0, 3);
    const extra = responderam.length
      ? `\nResponderam: ${responderam.map(l => `${l.nome || "lead"} (${l.categoria || "?"})`).join(", ")}`
      : "";
    return ctx + extra;
  }

  if (modo === "prospeccao") {
    const alta = leads.filter(l => l.prioridade === "ALTA" && l.status === "novo").length;
    return ctx + `\nLeads ALTA sem contato: ${alta}`;
  }

  // estrategia — adiciona nicho prioritário
  const nichos = {};
  leads.filter(l => l.prioridade === "ALTA" && l.status === "novo").forEach(l => {
    const n = l.categoria || "sem categoria";
    nichos[n] = (nichos[n] || 0) + 1;
  });
  const nichoPrincipal = Object.entries(nichos).sort((a, b) => b[1] - a[1])[0];
  const extra = nichoPrincipal ? `\nNicho ALTA sem contato: ${nichoPrincipal[0]} (${nichoPrincipal[1]})` : "";

  const TRAVADO_MS = 3 * 24 * 60 * 60 * 1000;
  const travados = leads
    .filter(l => ["abordado","reuniao","proposta"].includes(l.status) && l.atualizadoEm
      && (Date.now() - new Date(l.atualizadoEm).getTime()) > TRAVADO_MS)
    .map(l => l.nome || "Lead").slice(0, 3);
  const travadosStr = travados.length ? `\nTravados +3 dias: ${travados.join(", ")}` : "";

  return ctx + extra + travadosStr;
}

function promptSistemaDiretor(modo, contexto) {
  const core = `Você é o director-comercial da Lumyn. Você existe para gerar clientes rápido.

Nunca explique raciocínio. Nunca ensine. Nunca descreva o que está fazendo.
Nunca peça mais informação se puder assumir. Nunca dê múltiplas opções. Nunca responda genérico.
Sempre entregue algo copiável e executável agora. Responda como humano no WhatsApp.

CONTEXTO (use para decidir — não mencione):
${contexto}`;

  if (modo === "conversa") return `${core}

MODO: CONVERSA
Entregue APENAS a mensagem para enviar ao lead. Até 2 linhas. Sem apresentação, sem aspas, sem explicação.
A mensagem começa na primeira palavra. Sempre avança a conversa — puxa para call ou próximo passo.
Nunca deixe a conversa aberta ou passiva.`;

  if (modo === "prospeccao") return `${core}

MODO: PROSPECÇÃO
Entregue APENAS a mensagem de primeiro contato. Até 3 linhas. Tom adaptado ao nicho (informal para barbearia/restaurante, equilibrado para clínica/coaching).
Nunca cite avaliações, notas ou dados técnicos. Nunca use "identifiquei uma oportunidade".
A mensagem começa na primeira palavra.`;

  return `${core}

MODO: ESTRATÉGIA
Entregue exatamente isto — sem mais:
linha 1: nicho ou foco decidido
linha 2: motivo curto (até 10 palavras)
linha 3: ação concreta para fazer hoje

Sem subtítulos. Sem listas. Sem parágrafos extras.`;
}

function validarOutputDiretor(resposta, modo) {
  const r = resposta.trim();
  if (r.length < 10) return false;
  const palavrasBloqueadas = ["análise", "intenção", "estratégia do", "identificamos", "com base em", "claro,", "com prazer"];
  if (palavrasBloqueadas.some(p => r.toLowerCase().includes(p))) return false;
  if (modo === "conversa"   && r.length > 300) return false;
  if (modo === "prospeccao" && r.length > 400) return false;
  if (modo === "prospeccao") {
    const bloqueadas = ["oportunidade", "avaliações", "nota ", "dados técnicos"];
    if (bloqueadas.some(p => r.toLowerCase().includes(p))) return false;
  }
  if (modo === "estrategia") {
    const temVerboAcao = /\b(prospecte|busque|liste|mande|aborde|entre|ligue|foque|feche|envie|teste|corte|pare|comece|priorize|ataque|vá|contate)\b/i.test(r);
    if (!temVerboAcao) return false;
  }
  return true;
}

async function chamarDirectorIA(modo, systemPrompt, historico, pergunta, temperature = 0.35) {
  const maxTokens = modo === "estrategia" ? 180 : 120;
  const messages = [
    { role: "system", content: systemPrompt },
    ...historico.map(h => ({ role: h.tipo === "user" ? "user" : "assistant", content: h.texto })),
    { role: "user", content: pergunta },
  ];
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: maxTokens,
    temperature,
  });
  return resp.choices[0].message.content.trim();
}

async function montarSnapshotEstrategia() {
  const crm = await lerCRM();
  const leads = crm.leads || [];
  const contagem = { novo: 0, abordado: 0, respondeu: 0, reuniao: 0, proposta: 0, fechado: 0, perdido: 0 };
  let travados = 0;
  const TRAVADO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
  const agora = Date.now();

  leads.forEach((l) => {
    const s = l.status || "novo";
    if (contagem[s] !== undefined) contagem[s]++;
    if ((s === "reuniao" || s === "proposta") && l.atualizadoEm) {
      if (agora - new Date(l.atualizadoEm).getTime() > TRAVADO_MS) travados++;
    }
  });

  const partesCrm = [
    `CRM: ${contagem.novo} novo${contagem.novo !== 1 ? "s" : ""}`,
    `${contagem.abordado} abordado${contagem.abordado !== 1 ? "s" : ""}`,
    `${contagem.respondeu} respondeu`,
    `${contagem.reuniao} em reunião`,
    `${contagem.proposta} proposta`,
    `${contagem.fechado} fechado${contagem.fechado !== 1 ? "s" : ""}`,
    `${contagem.perdido} perdido${contagem.perdido !== 1 ? "s" : ""}`,
  ];
  let linhas = [partesCrm.join(" | ")];
  if (travados > 0) linhas.push(`⚠ ${travados} lead(s) em reunião/proposta sem movimento há mais de 7 dias`);
  if (leads.length === 0) linhas = ["CRM: sem leads cadastrados ainda."];

  return linhas.join("\n");
}

async function gerarRespostaEstrategia(pergunta, snapshot) {
  const instrucoes = `Você é o diretor comercial da Lumyn — plataforma de inteligência comercial para prospecção B2B/B2C local.

Princípio central: velocidade operacional. O operador precisa prospectar mais e travar menos.

Contexto do produto:
- Leads classificados: ALTA / MÉDIA / BAIXA / DESCARTE via dados do Google Maps
- Mensagens geradas por nicho com tom adaptado: informal / equilibrado / profissional
- CRM com etapas: novo → abordado → respondeu → reunião → proposta → fechado
- O usuário opera a Lumyn como serviço — você fala com quem executa, não com o lead

Nunca diga:
- "Pode ser interessante explorar..." ou qualquer variação
- Números que não vieram do snapshot
- Recomendações sem ação concreta
- Mais de 4 itens em qualquer resposta

Formato: prosa direta ou lista de até 4 itens. Sem saudação, sem introdução. Primeira palavra já é ação ou diagnóstico. Resposta lida em menos de 20 segundos.

Se os dados do snapshot forem insuficientes para recomendar algo, diga exatamente o que falta — nunca opere no vazio fingindo ter contexto.`;

  const contextoSistema = snapshot
    ? `Estado atual do sistema:\n${snapshot}`
    : `Estado atual do sistema: sem dados disponíveis.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: instrucoes },
      { role: "user", content: `${contextoSistema}\n\nPergunta: ${pergunta}` },
    ],
    max_tokens: 400,
    temperature: 0.35,
  });

  return resp.choices[0].message.content.trim();
}

/*
  META MARKETING API
*/
// ============================================================
//  CRIATIVOS — analytics-agent + designer-agent
// ============================================================

async function analisarCriativoAnalytics(cliente, dadosCampanha) {
  const contexto = dadosCampanha
    ? `Dados de campanha (Meta Ads):\n${JSON.stringify(dadosCampanha, null, 2)}`
    : `Sem dados de campanha disponíveis. Use o contexto do cliente para diagnosticar.`;

  const prompt = `Você é o analytics-agent. Analise o contexto abaixo e identifique se o problema é de criativo.
Se for criativo, gere um briefing curto e direto para o designer.

Cliente: ${cliente}
${contexto}

Regras:
- CTR < 1% → criativo fraco → problema de gancho
- Impressões altas, cliques baixos → criativo não prende atenção
- Se não houver dados suficientes, diga exatamente o que está faltando

Responda EXATAMENTE neste formato:

resumo:
[1 frase — o que está acontecendo]

problema_criativo: SIM ou NÃO

briefing:
[se SIM: instrução direta para o designer — o que mudar e por quê. Máximo 3 linhas.]

acao_imediata:
[1 ação concreta para hoje]`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 250,
    temperature: 0.2,
  });
  return resp.choices[0].message.content.trim();
}

// Extrai o campo edit_prompt do bloco — captura tudo entre edit_prompt: e reason:
function extrairEditPromptDoBloco(bloco) {
  // Tenta capturar entre edit_prompt: e reason: (formato de 6 passos)
  const matchCompleto = bloco.match(/edit_prompt:\s*\n([\s\S]*?)(?=\nreason:)/i);
  if (matchCompleto) return matchCompleto[1].trim();
  // Fallback: captura até próxima chave de seção
  const matchSimples = bloco.match(/edit_prompt:\s*\n([\s\S]*?)(?=\n[a-z_]+:|$)/i);
  return matchSimples ? matchSimples[1].trim() : bloco.trim();
}

// Regras visuais por cliente — instruções de agência para o Gemini
const DESIGN_RULES = {
  rivano: {
    tratamentoCor: `Color grading editorial premium (estilo Vogue/Zara):
  - Reduza temperatura de cor em -20: azuis e neutros ganham protagonismo, alaranjados e vermelhos recuam
  - Contraste: +25 nas sombras médias, preservando detalhes nas luzes (não queimar)
  - Saturação geral: -15, depois +10 seletivo em azuis e cinzas
  - Split toning: sombras com toque azul-ardósia (#1a2030), luzes com dourado suave (#fff8e8)
  - Skin tone: preserve a naturalidade da pele — não deixe alaranjado nem cinza`,
    vignette: `Vignette editorial sutil:
  - Escurecimento 25% nas bordas, raio de difusão que cobre 35% da imagem a partir de cada borda
  - Cantos inferiores mais intensos (30%) para ancorar o peso visual no texto
  - Deve ser imperceptível em primeiro olhar — só sentido, não visto`,
    overlay: `Gradiente de leitura sofisticado:
  - Gradiente do rodapé para cima, ocupando 30% da altura
  - Opacidade: 0% na borda superior do gradiente → 60% na base absoluta
  - Curva de transição suave (ease-in): a foto deve "afundar" no gradiente organicamente
  - Proibido linha de corte visível. Proibido bloco sólido`,
    tipografia: `Tipografia editorial de moda:
  - Tagline: fonte serif light ou thin (Didot, Cormorant, Playfair Light), peso 200–300
    Tamanho: 9–11% da altura da imagem. Cor: #FFFFFF. Caixa mista natural (não all caps)
  - Separador: linha horizontal de 1px, cor #FFFFFF opacidade 50%, largura 160px
    Margem de 8px acima e abaixo
  - CTA: sans-serif light (Helvetica Neue Light, Futura Light), peso 300
    Tamanho: 3–4% da altura. Cor: #FFFFFF opacidade 80%. Letter-spacing: 0.18em. Caixa baixa`,
    grade: `Zonas de texto (coordenadas relativas):
  - Zona segura do texto: x entre 7% e 50% da largura, y entre 65% e 92% da altura
  - Tagline: y=70%, x=7%
  - Separador: y=79%, x=7%
  - CTA: y=84%, x=7%
  - Fora dessas coordenadas: proibido qualquer elemento tipográfico`,
    validacao: `Auto-validação antes de renderizar:
  (1) Rosto e óculos estão íntegros e nítidos? Se não → refaça sem tocar nessa área
  (2) O gradiente inferior tem linha de corte visível? Se sim → suavize até desaparecer
  (3) A fonte da tagline é serif ou thin sans — nunca bold? Se não → troque
  (4) O CTA está escrito exatamente como passado, sem alterar letras? Se não → corrija
  (5) O resultado parece campanha de revista de moda ou parece feito por IA? Se IA → refine`,
  },
  "com-tempero": {
    tratamentoCor: `Color grading apetitoso de alta conversão:
  - Temperatura: +25, ambiente quente e acolhedor
  - Saturação vermelhos e amarelos: +35. Laranjas: +20
  - Contraste: +30, sombras marcadas, tridimensionalidade
  - Luzes nos alimentos: boost de +20 para efeito "saiu do forno agora"
  - Resultado: foto que faz salivar na primeira fração de segundo`,
    vignette: `Vignette de enquadramento:
  - Bordas laterais: 25% de escurecimento
  - Topo: 15%. Base: sem vignette (a faixa de texto cobre)
  - Direciona o olhar para o alimento`,
    overlay: `Faixa de texto de alta conversão:
  - Faixa sólida na base da imagem, cor #0d0000 (preto-vinho), opacidade 80%
  - Altura: 24% da imagem. Bordas: retas, sem arredondamento
  - A faixa começa exatamente em y=76% e vai até y=100%`,
    tipografia: `Tipografia de conversão imediata:
  - Título: sans-serif black ou heavy (Impact, Bebas Neue, Futura Heavy), peso 800–900
    Tamanho: 12–14% da altura. Cor: #FFFFFF. Caixa alta obrigatória
  - CTA: mesma família, peso 700
    Tamanho: 5% da altura. Cor: #FFE600 (amarelo vivo). Letter-spacing: 0.06em
  - Sem linha separadora — espaçamento de 8px entre título e CTA`,
    grade: `Zonas de texto:
  - Título: centralizado, y=80%
  - CTA: centralizado, y=88%
  - Margem lateral: 5% de cada lado`,
    validacao: `Auto-validação:
  (1) O alimento é o elemento mais brilhante e saturado da imagem? Se não → aumente
  (2) A faixa inferior está em y=76% com bordas retas? Se não → reposicione
  (3) O título está em caixa alta, peso black? Se não → corrija
  (4) O CTA está em amarelo #FFE600 e legível? Se não → ajuste
  (5) O resultado converte num scroll de 1 segundo? Se não → torne mais impactante`,
  },
};

async function gerarPromptDesigner({ cliente, cta, legenda, objetivo, formato, contexto, imagemBase64, mimeType }) {
  const rules = DESIGN_RULES[cliente] || DESIGN_RULES["rivano"];

  const mensagens = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Você é o designer-agent. Analise a imagem e produza uma instrução de edição para criativo de anúncio de nível agência.

REGRAS:
- EDITOR, não gerador. Preserve: pessoa, rosto, postura, fundo, composição, ângulo.
- Proibido recriar cena, substituir pessoa, inventar objetos.
- Os textos abaixo devem ser copiados literalmente, sem alterar uma letra.

Formato: ${formato || "feed"} | Objetivo: ${objetivo || "conversão"}
${contexto ? `Notas do gestor: ${contexto}` : ""}

TEXTOS DEFINIDOS PELO GESTOR:
${legenda ? `- Tagline: "${legenda}"` : "- Tagline: não definida"}
${cta ? `- CTA: "${cta}"` : "- CTA: não definido"}

Responda APENAS neste formato:

image_analysis:
[1 linha: o que tem na imagem e como serve para o criativo]

edit_prompt:
Edite esta imagem preservando integralmente: pessoa, rosto, fundo, composição e ângulo. Execute na ordem:

PASSO 1 — COLOR GRADING:
${rules.tratamentoCor}

PASSO 2 — VIGNETTE:
${rules.vignette}

PASSO 3 — OVERLAY:
${rules.overlay}

PASSO 4 — TIPOGRAFIA:
${rules.tipografia}

PASSO 5 — POSICIONAMENTO:
${rules.grade}
${legenda ? `Tagline (copie exatamente): "${legenda}"` : ""}
${cta ? `CTA (copie exatamente): "${cta}"` : ""}

PASSO 6 — VALIDAÇÃO FINAL:
${rules.validacao}

reason:
[1 linha: impacto esperado na performance]`,
        },
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${imagemBase64}` },
        },
      ],
    },
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: mensagens,
    max_tokens: 900,
    temperature: 0.2,
  });

  const bloco = resp.choices[0].message.content.trim();
  const editPrompt = extrairEditPromptDoBloco(bloco);
  return { prompt: bloco, edit_prompt: editPrompt };
}

// Sanitiza prompt que contenha linguagem de geração, forçando modo edição
function sanitizarPromptEdicao(prompt) {
  const termosCriacao = /\b(crie|cria|cria uma|generate|scene|new scene|nova cena|cena nova)\b/gi;
  if (termosCriacao.test(prompt)) {
    console.warn("[Gemini] Prompt com linguagem de geração detectada — aplicando correção automática.");
    return prompt.replace(termosCriacao, "");
  }
  return prompt;
}

// Gemini image editing — uma chamada, retorna { base64, mimeType }
async function chamarGeminiEdicao(base64Input, mimeType, promptEdicao) {
  if (!GOOGLE_GEMINI_API_KEY) throw new Error("GOOGLE_GEMINI_API_KEY não definida no .env");

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";

  // Envelope de preservação — âncora imutável antes de qualquer instrução
  const promptFinal = `Tarefa: edição de fotografia para criativo de anúncio pago. NÃO é geração de imagem nova.

══ O QUE NUNCA TOCAR (preservação absoluta) ══
Pessoa · rosto · expressão · corpo · postura · roupa · fundo · composição · ângulo de câmera · objetos existentes.
Nenhum desses elementos pode ser alterado, movido, substituído ou removido.

══ O QUE ADICIONAR (novos elementos sobre a foto) ══
Color grading · vignette · overlay de gradiente · tipografia e texto.
Esses são elementos novos que serão sobrepostos à foto original — não fazem parte dela.

══ PADRÃO DE QUALIDADE OBRIGATÓRIO ══
· Textos: copiados literalmente da instrução, sem alterar uma letra, sem erros ortográficos
· Gradiente/overlay: integrado à foto sem linha de corte visível
· Tipografia: hierarquia clara, legível, fonte refinada
· Acabamento: pronto para veicular em Meta Ads — sem artefatos, sem bordas estranhas

══ INSTRUÇÃO DO DESIGNER ══
${sanitizarPromptEdicao(promptEdicao)}`;

  const body = {
    contents: [{
      parts: [
        { text: promptFinal },
        { inline_data: { mime_type: mimeType, data: base64Input } },
      ],
    }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GOOGLE_GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error?.message || `Gemini HTTP ${resp.status}`);

  const parts = json.candidates?.[0]?.content?.parts || [];
  // API retorna inlineData (camelCase) no REST
  const imgPart = parts.find(p => p.inlineData || p.inline_data);
  if (!imgPart) throw new Error("Gemini não retornou imagem. Verifique o prompt ou o modelo.");

  const img = imgPart.inlineData || imgPart.inline_data;
  return { base64: img.data, mimeType: img.mime_type || img.mimeType || "image/png" };
}

// Gera 3 variações em paralelo
async function editarImagemGemini(base64Input, mimeType, promptEdicao) {
  const variacoes = await Promise.allSettled([
    chamarGeminiEdicao(base64Input, mimeType, promptEdicao),
    chamarGeminiEdicao(base64Input, mimeType, promptEdicao),
    chamarGeminiEdicao(base64Input, mimeType, promptEdicao),
  ]);

  return variacoes.map((r, i) => {
    if (r.status === "fulfilled") return { ok: true, base64: r.value.base64, mimeType: r.value.mimeType };
    console.error(`[Gemini] Variação ${i + 1} falhou:`, r.reason?.message);
    return { ok: false, erro: r.reason?.message || "Falha desconhecida" };
  });
}

async function buscarInsightsMeta(accountKey) {
  // Resolve token e accountId para a conta selecionada
  const cfg = (accountKey && ACCOUNT_CONFIG[accountKey]) ? ACCOUNT_CONFIG[accountKey] : null;
  const token     = (accountKey && META_TOKENS[accountKey]) ? META_TOKENS[accountKey] : META_ACCESS_TOKEN;
  const accountId = cfg?.accountId || META_AD_ACCOUNT_ID;

  if (!token || !accountId) {
    const err = new Error(
      accountKey
        ? `Conta "${accountKey}" não configurada. Verifique META_ACCESS_TOKEN e META_AD_ACCOUNT_ID no .env.`
        : "API Meta não configurada. Adicione META_ACCESS_TOKEN e META_AD_ACCOUNT_ID nas variáveis de ambiente."
    );
    err.tipo = "config";
    throw err;
  }

  let resp;
  try {
    // Buscar lista de campanhas com objective para distinguir tráfego vs conversão
    const urlCampanhas = `https://graph.facebook.com/v19.0/act_${accountId}/campaigns?fields=id,name,status,objective&access_token=${token}`;
    resp = await fetch(urlCampanhas);
  } catch (e) {
    const err = new Error("Sem conexão com a API do Meta. Verifique sua internet.");
    err.tipo = "rede";
    throw err;
  }

  const jsonCampanhas = await resp.json();

  if (jsonCampanhas.error) {
    const codigo = jsonCampanhas.error.code;
    let msg = jsonCampanhas.error.message;
    if (codigo === 190) msg = "Token Meta expirado ou inválido. Gere um novo em developers.facebook.com.";
    else if (codigo === 100) msg = "ID da conta de anúncios inválido. Verifique META_AD_ACCOUNT_ID.";
    else if (codigo === 10 || codigo === 200) msg = "Permissões insuficientes. O token precisa de ads_read.";
    const err = new Error(msg);
    err.tipo = "api";
    err.codigo = codigo;
    throw err;
  }

  const campanhas = jsonCampanhas.data || [];
  if (campanhas.length === 0) return [];

  // Extrai valor de action por tipo — retorna null se não existir, nunca inventa
  function extrairAction(arr, tipos) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const found = arr.find(a => tipos.includes(a.action_type));
    if (!found || found.value == null) return null;
    const val = parseFloat(found.value);
    return isNaN(val) ? null : val;
  }

  // Para cada campanha, buscar insights
  const campanhasComInsights = await Promise.all(
    campanhas.map(async (camp) => {
      try {
        const urlInsights = `https://graph.facebook.com/v19.0/${camp.id}/insights?fields=spend,impressions,clicks,cpc,ctr,cpm,frequency,actions,action_values&date_preset=last_30d&access_token=${token}`;
        const respInsights = await fetch(urlInsights);
        const jsonInsights = await respInsights.json();

        if (jsonInsights.error) {
          console.warn(`[Meta] Erro ao buscar insights de ${camp.name}:`, jsonInsights.error.message);
          // Retorna campanha com flag de erro — não silencia, não inventa dados
          return {
            campanha: camp.name || "Sem nome",
            status:   camp.status || null,
            erro:     jsonInsights.error.message,
          };
        }

        const insight = (jsonInsights.data && jsonInsights.data[0]) || {};

        // Métricas de entrega — null se o campo não vier da API, nunca default inventado
        const gasto      = insight.spend       != null ? parseFloat(insight.spend)       : null;
        const impressoes = insight.impressions  != null ? parseInt(insight.impressions)   : null;
        const cliques    = insight.clicks       != null ? parseInt(insight.clicks)        : null;
        const ctr        = insight.ctr          != null ? parseFloat(insight.ctr)         : null;
        const cpc        = insight.cpc          != null ? parseFloat(insight.cpc)         : null;
        const cpm        = insight.cpm          != null ? parseFloat(insight.cpm)         : null;
        const frequencia = insight.frequency    != null ? parseFloat(insight.frequency)   : null;

        // Arrays brutos de conversões
        const rawActions      = Array.isArray(insight.actions)       ? insight.actions       : [];
        const rawActionValues = Array.isArray(insight.action_values)  ? insight.action_values : [];

        // Conversões — extraídas dos arrays da API; null = sem pixel/evento, não zero
        const conversoes        = extrairAction(rawActions,      ["purchase",          "offsite_conversion.fb_pixel_purchase"]);
        const purchase_value    = extrairAction(rawActionValues, ["purchase",          "offsite_conversion.fb_pixel_purchase"]);
        const add_to_cart       = extrairAction(rawActions,      ["add_to_cart",       "offsite_conversion.fb_pixel_add_to_cart"]);
        const initiate_checkout = extrairAction(rawActions,      ["initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"]);
        const leads             = extrairAction(rawActions,      ["lead",              "offsite_conversion.fb_pixel_lead"]);

        // ROAS = receita / gasto — só calcula se ambos existirem e gasto > 0
        const roas = (gasto != null && gasto > 0 && purchase_value != null && purchase_value > 0)
          ? parseFloat((purchase_value / gasto).toFixed(2))
          : null;

        // Custo por conversão — só calcula se conversoes > 0 e gasto conhecido
        const custoPorConversao = (conversoes != null && conversoes > 0 && gasto != null && gasto > 0)
          ? parseFloat((gasto / conversoes).toFixed(2))
          : null;

        return {
          // ── EXIBIDO NA UI ──────────────────────────────────────────
          campanha:          camp.name || "Sem nome",
          gasto,
          ctr,
          cpc,
          roas,
          conversoes,
          add_to_cart,
          initiate_checkout,
          // ── CONTEXTO DO GESTOR (não exibido na tabela) ─────────────
          status:            camp.status    || null,
          objective:         camp.objective || null,  // tipo de campanha da Meta (CONVERSIONS, TRAFFIC, etc.)
          impressoes,
          cliques,
          cpm,
          frequencia,
          purchase_value,
          leads,
          custoPorConversao,
          _actions:          rawActions,
          _action_values:    rawActionValues,
        };
      } catch (e) {
        console.warn(`[Meta] Erro ao processar campanha ${camp.name}:`, e.message);
        return {
          campanha: camp.name || "Sem nome",
          status:   camp.status || null,
          erro:     e.message,
        };
      }
    })
  );

  return campanhasComInsights.filter(c => c !== null);
}

// ── GESTOR: PERSISTÊNCIA DE RESTRIÇÕES (memória server-side por conta) ────────
const _restricoesPorConta = new Map(); // accountId → [{tipo, regra}]

function carregarRestricoesConta(accountId) {
  return _restricoesPorConta.get(accountId) || [];
}
function salvarRestricoesConta(accountId, restricoes) {
  _restricoesPorConta.set(accountId, restricoes);
}
function mesclarRestricoes(existentes, novas) {
  const tipos = new Set(existentes.map(r => r.tipo));
  return [...existentes, ...novas.filter(r => !tipos.has(r.tipo))];
}

// ── GESTOR: AUDIT TRAIL ────────────────────────────────────────────────────────
const _auditTrail = [];

async function registrarLog(entrada) {
  const log = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entrada,
  };
  _auditTrail.push(log);
  if (_auditTrail.length > 500) _auditTrail.shift();
  console.log(`[AUDIT] ${log.timestamp} | conta:${log.accountId} | acao:${log.acao_recomendada} | confianca:${log.confianca ?? "—"} | fallback:${log.usou_fallback}`);
  if (supabase) {
    try {
      await supabase.from("gestor_audit").insert([{ id: log.id, dados: log, criado_em: log.timestamp }]);
    } catch { /* tabela opcional — falha silenciosa */ }
  }
}

// ── GESTOR: CONSTANTES ────────────────────────────────────────────────────────
const ACOES_GESTOR_VALIDAS = [
  "manter", "subir criativo", "criar novo conjunto", "duplicar campanha",
  "pausar", "revisar criativo", "revisar público", "aguardar dados",
];

const LINGUAGEM_GENERICA = [
  "você pode", "considere", "talvez", "pode ser", "uma opção",
  "outra alternativa", "seria interessante", "recomendo que você",
];

// ── GESTOR: ANÁLISE LOCAL (sem IA) ────────────────────────────────────────────

// Fase do pixel — considera restrições declaradas e thresholds da conta
function calcularFasePixel(campanha, restricoes, accountConfig) {
  const { conversoes, leads, gasto, ctr, add_to_cart } = campanha;
  const gastoNum     = gasto || 0;
  const totalEventos = (conversoes || 0) + (leads || 0) + (add_to_cart || 0);
  const pixelDeclaradoInstalado = restricoes.some(r => r.tipo === "pixel_instalado");

  if (conversoes == null && leads == null) {
    // Entrega ok + gasto relevante + zero conversões → problema de rastreamento/checkout
    if (gastoNum > accountConfig.gasto_min_decisao && ctr != null && ctr > 0.5) {
      if (pixelDeclaradoInstalado) {
        return `Pixel instalado mas sem eventos de conversão registrados. Gasto R$${gastoNum.toFixed(2)}, CTR ${ctr.toFixed(2)}% — entrega saudável. Verificar eventos (AddToCart, Purchase) no Events Manager.`;
      }
      return `R$${gastoNum.toFixed(2)} gastos com CTR ${ctr.toFixed(2)}% — entrega funcionando. Ausência de conversões: verificar se pixel rastreia AddToCart e Purchase.`;
    }
    return "Pixel sem eventos de conversão registrados.";
  }

  if (totalEventos < 10 || gastoNum < accountConfig.gasto_min_decisao) {
    return `Fase de aprendizado — ${totalEventos} evento(s), R$${gastoNum.toFixed(2)} gastos. Mínimo: 10 eventos e R$${accountConfig.gasto_min_decisao} para decisão confiável.`;
  }
  return `Pixel ativo — ${totalEventos} evento(s). Dados suficientes para decisão.`;
}

// Funil — detecta abandono precoce e abandono no checkout
function analisarFunil(campanha) {
  const { add_to_cart, initiate_checkout, conversoes } = campanha;
  if (add_to_cart == null && initiate_checkout == null && conversoes == null) return null;
  if (add_to_cart != null && add_to_cart > 5 &&
      (initiate_checkout == null || initiate_checkout < 2) &&
      (conversoes == null || conversoes < 1)) {
    return `ABANDONO PRECOCE: ${add_to_cart} add_to_carts, ~${initiate_checkout ?? 0} checkouts → problema no carrinho/oferta, não na campanha`;
  }
  if (initiate_checkout != null && initiate_checkout > 3 && (conversoes == null || conversoes < 1)) {
    return `ABANDONO NO CHECKOUT: ${initiate_checkout} chegaram ao checkout, 0 compraram → revisar página de pagamento/frete`;
  }
  if (add_to_cart != null && add_to_cart > 0 && conversoes != null && conversoes > 0) {
    return `Funil funcional: ${((conversoes / add_to_cart) * 100).toFixed(1)}% de add_to_cart convertem`;
  }
  return null;
}

// Restrições — padrões semânticos amplos, acumulativo por histórico
function extrairRestricoes(historico) {
  const regras = {
    sem_verba: {
      padroes: [
        "sem grana", "sem verba", "sem budget", "não tenho verba", "tô sem grana",
        "não dá pra aumentar", "orçamento apertado", "não posso gastar mais",
        "não tem budget", "budget limitado", "não consigo porque não tenho verba",
        "verba pequena", "investimento baixo", "não quero aumentar",
      ],
      regra: "não sugerir aumentar orçamento, duplicar campanha ou criar novo conjunto",
    },
    sem_acesso: {
      padroes: [
        "sem acesso", "não consigo acessar", "não posso mexer", "sem permissão",
        "não tenho acesso", "não posso mexer agora", "acesso bloqueado",
      ],
      regra: "não sugerir ação que exija acesso ao gerenciador",
    },
    pixel_instalado: {
      padroes: [
        "pixel instalado", "pixel está instalado", "pixel já está instalado",
        "já instalei o pixel", "pixel tá lá", "pixel configurado",
        "o pixel tá instalado", "pixel funcionando",
      ],
      regra: "pixel declarado como instalado — focar em validação de eventos, não em instalação",
    },
    pixel_novo: {
      padroes: [
        "pixel novo", "pixel recém instalado", "acabei de instalar o pixel",
        "pixel não tem dados", "pixel sem histórico",
      ],
      regra: "não sugerir escala — pixel em fase de coleta inicial",
    },
    sem_criativo: {
      padroes: [
        "sem criativo", "não tenho criativo", "não tem arte", "cliente não aprovou",
        "aguardando aprovação", "sem imagem nova", "sem material novo",
        "criativo em aprovação", "sem peça nova",
      ],
      regra: "não sugerir subir ou revisar criativo com novos materiais",
    },
    sem_tempo: {
      padroes: [
        "sem tempo", "não consigo agora", "não posso mexer agora",
        "ocupado", "não tenho disponibilidade", "depois vejo isso",
      ],
      regra: "priorizar ações simples — não sugerir reestruturação complexa",
    },
    foco_roi: {
      padroes: [
        "foco em roi", "preciso de retorno", "tem que dar resultado",
        "não posso desperdiçar", "cada real conta", "orçamento enxuto",
      ],
      regra: "priorizar decisões conservadoras que protejam o orçamento",
    },
    evitar_testes: {
      padroes: [
        "sem mais testes", "não quero testar", "chega de teste",
        "quero resultado direto", "sem experimento agora",
      ],
      regra: "não sugerir novos testes — focar em otimizar o que existe",
    },
  };

  const texto = historico
    .filter(h => h.tipo === "user")
    .map(h => (h.texto || "").toLowerCase())
    .join(" ");

  const encontradas = [];
  for (const [tipo, config] of Object.entries(regras)) {
    if (config.padroes.some(p => texto.includes(p))) {
      encontradas.push({ tipo, regra: config.regra });
    }
  }
  return encontradas;
}

// Legacy functions removed after unification with @analytics
// (processarMagicPrompt, montarPrompt, validarRespostaGestor, corrigirResposta)

// Fallback determinístico — rule-based, zero IA, sempre conservador
function fallbackDeterministico(restricoes, campanha, accountConfig) {
  const n  = (v, pre = "", suf = "", d = 2) => v != null ? `${pre}${parseFloat(v).toFixed(d)}${suf}` : "sem dado";
  const ni = (v) => v != null ? parseInt(v).toLocaleString("pt-BR") : "sem dado";

  const blocoMetricas = [
    `Nome: ${campanha.campanha}`,
    `Status: ${campanha.status || "desconhecido"}`,
    campanha.tipoBudget ? `Otimização de orçamento: ${campanha.tipoBudget === "CBO" ? "CBO — nível de campanha" : "ABO — nível de conjunto"}` : "",
    campanha.objective ? `Objetivo da campanha: ${campanha.objective}` : "",
    `Gasto 30d: ${n(campanha.gasto, "R$ ")}`,
    `Impressões: ${ni(campanha.impressoes)} | Cliques: ${ni(campanha.cliques)}`,
    `CTR: ${n(campanha.ctr, "", "%")} | CPC: ${n(campanha.cpc, "R$ ")} | CPM: ${n(campanha.cpm, "R$ ")}`,
    `Frequência: ${n(campanha.frequencia, "", "x", 1)}`,
    `Compras: ${ni(campanha.conversoes)} | Receita: ${n(campanha.purchase_value, "R$ ")} | ROAS: ${n(campanha.roas, "", "x")}`,
    `Custo/compra: ${n(campanha.custoPorConversao, "R$ ")}`,
    `Add to Cart: ${ni(campanha.add_to_cart)} | Checkout: ${ni(campanha.initiate_checkout)} | Leads: ${ni(campanha.leads)}`,
    campanha.erro ? `⚠ ERRO: ${campanha.erro}` : "",
  ].filter(Boolean).join("\n");

  const blocoNegocio = [
    `Tipo: ${accountConfig.tipo_produto}`,
    `Ticket médio: ${accountConfig.ticket_medio}`,
    `Objetivo: ${accountConfig.objetivo}`,
    `Maturidade: ${accountConfig.maturidade_conta}`,
    `Pixel: ${accountConfig.estagio_pixel}`,
    `Histórico: ${accountConfig.historico_testes}`,
    accountConfig.aprendizados !== "Sem aprendizados registrados." ? `Aprendizados: ${accountConfig.aprendizados}` : "",
    accountConfig.restricoes_permanentes.length > 0 ? `Restrições permanentes: ${accountConfig.restricoes_permanentes.join("; ")}` : "",
    `Próxima fase: ${accountConfig.proxima_fase}`,
  ].filter(Boolean).join("\n");

  const blocoRestricoes = ctx.restricoes.length > 0
    ? `RESTRIÇÕES ATIVAS — PRIORIDADE MÁXIMA. Nunca viole:\n${ctx.restricoes.map(r => `- [${r.tipo}] ${r.regra}`).join("\n")}`
    : "Sem restrições operacionais ativas.";

  const blocoAusentes = ctx.dadosAusentes.length > 0
    ? `Ausentes (não invente): ${ctx.dadosAusentes.join(", ")}`
    : "Todos os dados principais presentes.";

  return `Você é gestor de tráfego pago operacional. Analisa dados, toma UMA decisão, orienta execução.
Nunca use linguagem condicional. Nunca dê múltiplas opções. Retorne sempre JSON válido.

═══════════════════════════════════
DADOS DA CAMPANHA (últimos 30 dias)
═══════════════════════════════════
${blocoMetricas}

═══════════════════════════════════
FASE DO PIXEL
═══════════════════════════════════
${ctx.fasePixel}

═══════════════════════════════════
ANÁLISE DO FUNIL
═══════════════════════════════════
${ctx.analiseFunil || "Sem anomalia de funil detectada."}

═══════════════════════════════════
DADOS AUSENTES
═══════════════════════════════════
${blocoAusentes}

═══════════════════════════════════
CONTEXTO DO NEGÓCIO
═══════════════════════════════════
${blocoNegocio}

═══════════════════════════════════
RESTRIÇÕES DO USUÁRIO
═══════════════════════════════════
${blocoRestricoes}

═══════════════════════════════════
INTENÇÃO: ${ctx.intencao}
═══════════════════════════════════

LÓGICA DE DECISÃO — avalie nessa ordem, pare na primeira que se aplicar:
1. Sem entrega (gasto = sem dado OU impressões < 10) → aguardar dados
2. Gasto < R$${accountConfig.gasto_min_decisao} e eventos de conversão < 10 → aguardar dados (aprendizado)
3. Entrega ok (CTR > 0) + gasto > R$${accountConfig.gasto_min_decisao} + zero conversões → manter (problema de rastreamento/checkout, não de campanha)
4. Gasto > R$80 + impressões < 100 → pausar (problema de entrega)
5. Frequência > ${accountConfig.frequencia_max}x → revisar público (público esgotado)
6. CTR < ${accountConfig.ctr_min}% + impressões > 800 → revisar criativo
7. CPC > R$${accountConfig.cpc_max} + CTR ok → revisar público
8. add_to_cart alto + checkout baixo + conversões = 0 → manter (problema no site/carrinho)
9. initiate_checkout alto + conversões = 0 → manter (problema no checkout final)
10. ROAS < 1 + conversões > 5 → pausar (prejuízo confirmado)
11. ROAS entre 1 e ${accountConfig.roas_min}x + conversões > 3 → subir criativo
12. ROAS > ${accountConfig.roas_min}x + CTR ok + conversões > ${accountConfig.conversoes_min_escala} → duplicar campanha
13. Nenhum problema identificado → manter

AÇÕES VÁLIDAS — escolha exatamente uma:
manter | subir criativo | criar novo conjunto | duplicar campanha | pausar | revisar criativo | revisar público | aguardar dados

PROIBIÇÕES ABSOLUTAS:
- "talvez", "pode ser", "considere", "você pode", "uma opção", "seria interessante"
- Mais de uma ação
- Violar restrições ativas
- Inventar dados ausentes
- Decidir com base em dado não presente

RETORNE APENAS ESTE JSON — sem texto adicional:
{
  "acao": "uma da lista acima",
  "justificativa": "razão direta em 1-2 frases com números reais",
  "base_dados": "dados específicos que embasam esta decisão",
  "confianca": 0-100
}`;
}

// Valida resposta estruturada JSON do modelo
function validarRespostaGestor(parsed, restricoes) {
  if (!parsed || typeof parsed !== "object") {
    return { valido: false, motivo: "resposta não é JSON válido" };
  }
  if (!ACOES_GESTOR_VALIDAS.includes(parsed.acao)) {
    return { valido: false, motivo: `ação inválida: "${parsed.acao}"` };
  }
  const texto = `${parsed.justificativa || ""} ${parsed.base_dados || ""}`.toLowerCase();
  const generica = LINGUAGEM_GENERICA.find(p => texto.includes(p));
  if (generica) return { valido: false, motivo: `linguagem ambígua: "${generica}"` };
  if (!parsed.justificativa || parsed.justificativa.length < 10) {
    return { valido: false, motivo: "justificativa ausente ou muito curta" };
  }
  if (!parsed.base_dados || parsed.base_dados.length < 5) {
    return { valido: false, motivo: "base_dados ausente" };
  }
  for (const r of restricoes) {
    if (r.tipo === "sem_verba" && ["duplicar campanha", "criar novo conjunto"].includes(parsed.acao)) {
      return { valido: false, motivo: `viola sem_verba: ação "${parsed.acao}"` };
    }
    if (r.tipo === "sem_criativo" && ["subir criativo", "revisar criativo"].includes(parsed.acao)) {
      return { valido: false, motivo: `viola sem_criativo: ação "${parsed.acao}"` };
    }
    if (r.tipo === "sem_acesso" && ["pausar", "duplicar campanha", "criar novo conjunto", "subir criativo"].includes(parsed.acao)) {
      return { valido: false, motivo: `viola sem_acesso: ação "${parsed.acao}"` };
    }
  }
  return { valido: true };
}

// Prompt de correção — enviado ao modelo após resposta inválida
async function corrigirResposta(msgs, respostaAnterior, motivo) {
  const retryMsgs = [
    ...msgs,
    { role: "assistant", content: typeof respostaAnterior === "string" ? respostaAnterior : JSON.stringify(respostaAnterior) },
    {
      role: "user",
      content: `Resposta inválida: ${motivo}. Corrija retornando JSON: { "acao": uma da lista válida, "justificativa": 1-2 frases diretas com números reais, "base_dados": dados específicos, "confianca": 0-100 }. Sem linguagem ambígua. Sem violar restrições.`,
    },
  ];
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: retryMsgs,
      response_format: { type: "json_object" },
      max_tokens: 400,
      temperature: 0,
    });
    return JSON.parse(resp.choices[0].message.content);
  } catch { return null; }
}

// Fallback determinístico — rule-based, zero IA, sempre conservador
function fallbackDeterministico(restricoes, campanha, accountConfig) {
  let acao = "manter", justificativa = "", base_dados = "";

  if (restricoes.some(r => r.tipo === "sem_verba")) {
    acao = "manter";
    justificativa = "Restrição de orçamento ativa — ações com custo adicional bloqueadas.";
    base_dados = "Restrição sem_verba detectada no histórico.";
  } else if (restricoes.some(r => r.tipo === "sem_acesso")) {
    acao = "aguardar dados";
    justificativa = "Sem acesso ao gerenciador — nenhuma ação executável agora.";
    base_dados = "Restrição sem_acesso detectada.";
  } else if (campanha.gasto == null || campanha.ctr == null) {
    acao = "aguardar dados";
    justificativa = "Dados insuficientes — campanha sem métricas de entrega.";
    base_dados = `Gasto: ${campanha.gasto ?? "sem dado"} | CTR: ${campanha.ctr ?? "sem dado"}`;
  } else if (campanha.gasto > accountConfig.gasto_min_decisao && campanha.ctr != null && campanha.conversoes == null) {
    acao = "manter";
    justificativa = "Entrega funcionando mas sem eventos de conversão — problema de rastreamento, não de campanha.";
    base_dados = `Gasto: R$${campanha.gasto.toFixed(2)} | CTR: ${campanha.ctr.toFixed(2)}%`;
  } else {
    acao = "manter";
    justificativa = "Sinais inconclusivos — decisão conservadora por segurança.";
    base_dados = "Fallback determinístico ativado após falha na análise de IA.";
  }

  return { acao, justificativa, base_dados, confianca: 0, fallback: true };
}

// ── PROCESSADOR UNIFICADO DE AGENTES ─────────────────────────────────────────
// Função interna reutilizável: processa input através de qualquer agente
async function processarAgente(nomeAgente, input, context = "", historico = []) {
  if (!TODOS_AGENTES.includes(nomeAgente)) {
    throw new Error(`Agente "${nomeAgente}" não existe.`);
  }

  const systemPrompt = PROMPTS_AGENTES[nomeAgente];
  const hist = historicoAgentes[nomeAgente];

  // Auto-contexto do CRM se relevante
  let autoContext = context;
  if ((nomeAgente === "director" || nomeAgente === "gestor") && !context) {
    const palavrasChave = ["prospectei", "leads", "hoje", "pipeline", "quantos", "performance", "contatos", "responderam", "fechei"];
    const temPalavra = palavrasChave.some(p => input.toLowerCase().includes(p));
    if (temPalavra) {
      try {
        const crm = await lerCRM();
        const leads = crm.leads || [];
        const agora = new Date();
        const hoje = agora.toISOString().split("T")[0];
        const prospectadosHoje = leads.filter(l => l.atualizadoEm && l.atualizadoEm.startsWith(hoje)).length;
        const statusCount = {};
        leads.forEach(l => { statusCount[l.status] = (statusCount[l.status] || 0) + 1; });
        const crmSummary = `[CRM] Total de leads: ${leads.length} | Prospectados hoje: ${prospectadosHoje} | Novos: ${statusCount.novo || 0} | Abordados: ${statusCount.abordado || 0} | Responderam: ${statusCount.respondeu || 0} | Reunião agendada: ${statusCount.reuniao || 0} | Fechados: ${statusCount.fechado || 0}`;
        autoContext = crmSummary;
      } catch (e) { /* fail silently */ }
    }
  }

  // Auto-busca de dados de tráfego se @analytics menciona campanha
  if (nomeAgente === "analytics" && !context) {
    const msgLower = input.toLowerCase();
    const temPalavrasTrafe = ["campanha", "tráfego", "ad", "ads", "roas", "ctr", "cpc", "criativo", "anúncio"];
    const temPalavra = temPalavrasTrafe.some(p => msgLower.includes(p));

    if (temPalavra) {
      try {
        // Detecta qual conta (rivano ou com_tempero)
        let accountKey = "rivano"; // default
        if (msgLower.includes("tempero") || msgLower.includes("com tempero")) {
          accountKey = "com_tempero";
        }

        // Busca dados de campanhas dessa conta
        const token = META_TOKENS[accountKey];
        if (token) {
          const url = `https://graph.instagram.com/v21.0/${ACCOUNT_CONFIG[accountKey].accountId}/campaigns?access_token=${token}&fields=id,name,status,objective,daily_budget,budget_remaining,start_date,stop_date`;
          const resp = await fetch(url);
          const data = await resp.json();

          if (data.data && data.data.length > 0) {
            // Busca insights das campanhas
            const campanhasInfo = await Promise.all(
              data.data.slice(0, 5).map(async (camp) => {
                try {
                  const insightsUrl = `https://graph.instagram.com/v21.0/${camp.id}/insights?metric=spend,impressions,clicks,actions,action_values&access_token=${token}`;
                  const insightsResp = await fetch(insightsUrl);
                  const insightsData = await insightsResp.json();
                  return { name: camp.name, status: camp.status, ...insightsData.data?.[0] };
                } catch { return { name: camp.name, status: camp.status }; }
              })
            );

            const trafegoSummary = `[TRÁFEGO ${ACCOUNT_CONFIG[accountKey].name.toUpperCase()}]\n${campanhasInfo
              .map(c => `- ${c.name} (${c.status}): Gasto R$${parseFloat(c.spend || 0).toFixed(2)} | ${c.impressions || 0} imp | ${c.clicks || 0} cliques | ${c.actions || 0} conversões`)
              .join("\n")}`;
            autoContext = autoContext ? `${trafegoSummary}\n\n${autoContext}` : trafegoSummary;
          }
        }
      } catch (e) {
        console.warn(`[Analytics auto-fetch] Erro ao buscar dados de tráfego: ${e.message}`);
        /* fail silently, continue com contexto original */
      }
    }
  }

  // Magic Prompt
  const inputEnriquecido = await magicPrompt(input, nomeAgente, autoContext && autoContext.trim() ? autoContext : null);
  const userContent = (autoContext && autoContext.trim())
    ? `Contexto: ${autoContext.trim()}\n\n${inputEnriquecido}`
    : inputEnriquecido;

  const messages = [
    { role: "system", content: systemPrompt },
    ...historico,
    { role: "user", content: userContent }
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    response_format: { type: "json_object" },
    temperature: 0.35,
    max_tokens: 1200,
  });

  const rawText = completion.choices[0].message.content;
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { parsed = { resposta: rawText, acao: null }; }

  // Valida acao
  if (!ACOES_VALIDAS.has(parsed.acao)) parsed.acao = null;

  // Atualiza histórico global
  historicoAgentes[nomeAgente].push({ role: "user", content: userContent });
  historicoAgentes[nomeAgente].push({ role: "assistant", content: rawText });
  if (historicoAgentes[nomeAgente].length > 8) {
    historicoAgentes[nomeAgente] = historicoAgentes[nomeAgente].slice(-8);
  }

  return {
    agente: nomeAgente,
    resposta: parsed.resposta || "",
    acao: parsed.acao || null,
    trocas: historicoAgentes[nomeAgente].length / 2,
  };
}

// Orquestrador: Gestor de Tráfego usa @analytics para análise
async function analisarCampanha(campanha, mensagem, historico, accountKey) {
  const accountConfig = getAccountConfig(campanha.campanha, accountKey);
  const accountId     = getAccountId(campanha.campanha, accountKey);

  // Carregar e mesclar restrições persistentes da conta
  const restricoesSalvas = carregarRestricoesConta(accountId);
  const restricoes = mesclarRestricoes(restricoesSalvas, []);
  salvarRestricoesConta(accountId, restricoes);

  // Montar contexto enriquecido de tráfego para o @analytics
  const n  = (v, pre = "", suf = "", d = 2) => v != null ? `${pre}${parseFloat(v).toFixed(d)}${suf}` : "sem dado";
  const ni = (v) => v != null ? parseInt(v).toLocaleString("pt-BR") : "sem dado";

  const contextoTrafego = [
    `═ DADOS DA CAMPANHA (últimos 30 dias) ═`,
    `Nome: ${campanha.campanha}`,
    `Status: ${campanha.status || "desconhecido"}`,
    campanha.tipoBudget ? `Otimização: ${campanha.tipoBudget === "CBO" ? "CBO (nível campanha)" : "ABO (nível conjunto)"}` : "",
    campanha.objective ? `Objetivo: ${campanha.objective}` : "",
    `Gasto: ${n(campanha.gasto, "R$ ")} | Impressões: ${ni(campanha.impressoes)} | Cliques: ${ni(campanha.cliques)}`,
    `CTR: ${n(campanha.ctr, "", "%")} | CPC: ${n(campanha.cpc, "R$ ")} | CPM: ${n(campanha.cpm, "R$ ")}`,
    `Frequência: ${n(campanha.frequencia, "", "x", 1)} | Compras: ${ni(campanha.conversoes)} | ROAS: ${n(campanha.roas, "", "x")}`,
    `Add to Cart: ${ni(campanha.add_to_cart)} | Checkout: ${ni(campanha.initiate_checkout)} | Leads: ${ni(campanha.leads)}`,
    ``,
    `═ CONTEXTO DO NEGÓCIO ═`,
    `Tipo: ${accountConfig.tipo_produto}`,
    `Ticket médio: ${accountConfig.ticket_medio} | Maturidade: ${accountConfig.maturidade_conta}`,
    `Pixel: ${accountConfig.estagio_pixel}`,
    ``,
    `═ THRESHOLDS DESTA CONTA ═`,
    `CTR mínimo: ${accountConfig.ctr_min}% | CPC máximo: R$${accountConfig.cpc_max} | ROAS mínimo: ${accountConfig.roas_min}x`,
    `Gasto mínimo para decisão: R$${accountConfig.gasto_min_decisao} | Frequência máxima: ${accountConfig.frequencia_max}x`,
    `Conversões mínimas para escalar: ${accountConfig.conversoes_min_escala}`,
    ``,
    restricoes.length > 0 ? `═ RESTRIÇÕES ATIVAS ═\n${restricoes.map(r => `[${r.tipo}] ${r.regra}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  // Chamar @analytics para análise
  let resultado;
  try {
    resultado = await processarAgente("analytics", mensagem, contextoTrafego, historico);
  } catch (e) {
    console.error(`[Gestor] Erro ao chamar @analytics:`, e.message);
    const fallback = fallbackDeterministico(restricoes, campanha, accountConfig);
    resultado = {
      agente: "analytics",
      resposta: `Análise automática: ${fallback.acao}. ${fallback.justificativa}`,
      acao: fallback.acao,
      trocas: 0,
    };
  }

  // Validar resposta e aplicar restrições
  let parsed = null;
  try {
    // Tenta extrair JSON da resposta
    const jsonMatch = resultado.resposta.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      parsed = { acao: resultado.acao, justificativa: resultado.resposta, base_dados: "análise em texto livre" };
    }
  } catch {
    parsed = { acao: resultado.acao, justificativa: resultado.resposta, base_dados: "erro ao parsear" };
  }

  // Validar contra restrições
  for (const r of restricoes) {
    if (r.tipo === "sem_verba" && ["duplicar campanha", "criar novo conjunto"].includes(parsed.acao)) {
      console.warn(`[Gestor] Ação "${parsed.acao}" viola restrição sem_verba`);
      parsed.acao = "manter";
      parsed.justificativa = "Restrição ativa: sem orçamento disponível para escalar.";
    }
  }

  // Audit trail
  await registrarLog({
    accountId,
    campanha: campanha.campanha,
    dados_utilizados: {
      gasto: campanha.gasto, ctr: campanha.ctr, cpc: campanha.cpc,
      roas: campanha.roas, conversoes: campanha.conversoes,
    },
    contexto_negocio: accountConfig.objetivo,
    restricoes: restricoes.map(r => r.tipo),
    acao_recomendada: parsed?.acao,
    confianca: parsed?.confianca ?? null,
    validacao_status: "ok",
    usou_fallback: false,
    mensagem_usuario: mensagem,
  });

  return { parsed, restricoes, accountConfig, accountId };
}

// Formata resultado para o frontend — mantém compatibilidade com UI atual
async function chatGestorTrafego(campanha, mensagem, historico, accountKey) {
  const resultado = await analisarCampanha(campanha, mensagem, historico, accountKey);
  const { parsed } = resultado;

  const linhas = [
    `Decisão: ${parsed.acao}`,
    `Justificativa: ${parsed.justificativa || "análise realizada"}`,
  ];
  if (parsed.base_dados) {
    linhas.unshift(`Diagnóstico: ${parsed.base_dados}`);
  }
  if (parsed.confianca != null && parsed.confianca < 50) {
    linhas.push(`⚠ Confiança baixa (${parsed.confianca}%) — valide antes de executar.`);
  }

  return {
    resposta: linhas.join("\n"),
    analise: {
      acao: parsed.acao,
      justificativa: parsed.justificativa || "",
      base_dados: parsed.base_dados || "",
      confianca: parsed.confianca ?? null,
      fallback: false,
    },
  };
}

async function analisarCampanhas(campanhas) {
  const nd = (v, pre = "", suf = "", d = 2) => v != null ? `${pre}${parseFloat(v).toFixed(d)}${suf}` : "sem dado";
  const ni = (v) => v != null ? parseInt(v).toLocaleString("pt-BR") : "sem dado";

  // Formatar resumo completo para o modelo — inclui todos os campos, nunca inventa
  const resumoCampanhas = campanhas.map(c => {
    if (c.erro) return `Campanha: ${c.campanha}\nSTATUS: ${c.status || "desconhecido"}\nERRO AO CARREGAR: ${c.erro}`;
    const linhas = [
      `Campanha: ${c.campanha} | Status: ${c.status || "desconhecido"}`,
      `Gasto: ${nd(c.gasto, "R$")} | Impressões: ${ni(c.impressoes)} | Cliques: ${ni(c.cliques)}`,
      `CTR: ${nd(c.ctr, "", "%")} | CPC: ${nd(c.cpc, "R$")} | CPM: ${nd(c.cpm, "R$")}`,
      `Frequência: ${nd(c.frequencia, "", "x", 1)}`,
      `Compras: ${ni(c.conversoes)} | Receita: ${nd(c.purchase_value, "R$")} | ROAS: ${nd(c.roas, "", "x")}`,
      `Custo/compra: ${nd(c.custoPorConversao, "R$")}`,
      `Add to Cart: ${ni(c.add_to_cart)} | Checkout iniciado: ${ni(c.initiate_checkout)} | Leads: ${ni(c.leads)}`,
    ];
    return linhas.join("\n");
  }).join("\n\n");

  const prompt = `Você é especialista em tráfego pago. Analise as campanhas e retorne diagnóstico direto.

${resumoCampanhas}

Critérios:
- CTR < 1% + impressões > 500 → criativo fraco
- CPC > R$5 para negócio local → público ruim
- gasto > R$100 e cliques = 0 → problema de entrega
- frequência > 3 → público esgotado
- ROAS > 3 → campanha saudável
- ROAS < 1 → prejuízo nas conversões
- tudo baixo (gasto < R$5, impressões < 100) → campanha não entregando

Retorne JSON válido:
{
  "resumo": "1 frase sobre estado geral",
  "problemas": ["problema específico por campanha"],
  "acoes": ["ação 1", "ação 2", "ação 3"]
}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  return JSON.parse(resp.choices[0].message.content);
}

/*
  ROTAS
*/
async function handler(req, res) {
  try {
    const host = req.headers.host || "localhost:3000";
    const urlObj = new URL(req.url, `http://${host}`);
    const pathname = urlObj.pathname;

  if (req.method === "GET" && pathname === "/") {
    return enviarArquivo(res, path.join(__dirname, "..", "index.html"), "text/html");
  }

  // ================================
  // ROTA GOOGLE
  // ================================
  if (req.method === "POST" && pathname === "/api/analisar") {
    try {
      const body = await lerBody(req);

      const modo = body.modo || "buscar";
      const input = body.input || "";
      const placeId = body.placeId;

      console.log(`[REQUEST] modo=${modo} | input="${input.slice(0, 60)}" | placeId=${placeId || "—"}`);

      // LIMPAR
      if (modo === "limpar") {
        estadoManual = null;
        return enviarJson(res, 200, { ok: true });
      }

      // MANUAL
      if (modo === "manual") {
        const mensagem = body.input || body.mensagem || "";

        if (!mensagem) {
          return enviarJson(res, 400, { erro: "Campo 'input' não enviado." });
        }

        let resposta;

        if (MODO_TESTE) {
          resposta = "[TESTE] Análise manual simulada.";
          estadoManual = { cenarioOriginal: mensagem, analiseAtual: resposta };
        } else if (estadoManual) {
          const respostaBruta = await gerarRefinamentoManual(mensagem, estadoManual);
          const ehNovo = respostaBruta.startsWith("[NOVO]");
          resposta = respostaBruta.replace(/^\[(NOVO|FOLLOW-UP)\]\s*/, "");
          if (ehNovo) {
            estadoManual = { cenarioOriginal: mensagem, analiseAtual: resposta };
          } else {
            estadoManual.analiseAtual = resposta;
          }
          console.log(`[OK] Manual ${ehNovo ? "nova análise" : "follow-up"} concluído.`);
        } else {
          resposta = await gerarAnaliseManual(mensagem);
          estadoManual = { cenarioOriginal: mensagem, analiseAtual: resposta };
          console.log("[OK] Análise manual concluída.");
        }

        return enviarJson(res, 200, { modo: "manual", resposta });
      }

      // 🔍 BUSCAR
      if (modo === "buscar") {
        const busca = extrairBusca(input);

        const lugares = await buscarLugares(busca);

        if (!lugares.length) {
          return enviarJson(res, 200, {
            erro: "Nenhum resultado encontrado",
          });
        }

        console.log(`[OK] Busca retornou ${lugares.length} resultado(s).`);
        return enviarJson(res, 200, {
          modo: "selecao",
          resultados: lugares.map((l) => ({
            id: l.id,
            nome: l.displayName?.text,
            nota: l.rating,
            avaliacoes: l.userRatingCount,
            endereco: l.formattedAddress,
          })),
        });
      }

      // 📊 ANALISAR
      if (modo === "analisar") {
        const detalhes = await buscarDetalhes(placeId);

        const dados = {
          nome: detalhes.displayName?.text,
          categoria: detalhes.primaryTypeDisplayName?.text,
          nota: detalhes.rating,
          avaliacoes: detalhes.userRatingCount,
          telefone: detalhes.nationalPhoneNumber,
          site: detalhes.websiteUri,
          endereco: detalhes.formattedAddress,
        };

        let resposta;

        if (MODO_TESTE) {
          resposta = "Teste ativo";
        } else {
          resposta = await gerarAnalise(dados);
        }

        console.log("[OK] Análise Google concluída.");
        return enviarJson(res, 200, {
          modo: "analise",
          dados,
          resposta,
        });
      }

      // LEADS
      if (modo === "leads") {
        const busca = extrairBusca(input);
        const lugares = await buscarLugaresLeads(busca);

        if (!lugares.length) {
          return enviarJson(res, 200, { erro: "Nenhum resultado encontrado para essa busca." });
        }

        const classificados = lugares.map((l) => ({
          id: l.id,
          nome: l.displayName?.text || "Sem nome",
          nota: l.rating || null,
          avaliacoes: l.userRatingCount || null,
          telefone: l.nationalPhoneNumber || null,
          site: l.websiteUri || null,
          endereco: l.formattedAddress || null,
          categoria: l.primaryTypeDisplayName?.text || null,
          prioridade: classificarLead(l.rating, l.userRatingCount, !!l.websiteUri),
        }));

        const leads = classificados.filter((l) => l.prioridade !== "DESCARTE");
        const descartados = classificados.filter((l) => l.prioridade === "DESCARTE");

        const ordemPrioridade = { ALTA: 0, MEDIA: 1, BAIXA: 2 };
        leads.sort((a, b) => {
          const diff = ordemPrioridade[a.prioridade] - ordemPrioridade[b.prioridade];
          if (diff !== 0) return diff;
          return (a.telefone ? 0 : 1) - (b.telefone ? 0 : 1);
        });

        // Cap de pré-computação: ALTA sempre + MÉDIA preenche até 12
        const CAP_PRECOMPUTE = 12;
        const ordenadosParaAnalise = leads.filter((l) => l.prioridade === "ALTA" || l.prioridade === "MEDIA");
        const altas = ordenadosParaAnalise.filter(l => l.prioridade === "ALTA");
        const medias = ordenadosParaAnalise.filter(l => l.prioridade === "MEDIA");
        const slotsRestantes = Math.max(0, CAP_PRECOMPUTE - altas.length);
        const leadsParaAnalisar = [...altas, ...medias.slice(0, slotsRestantes)];

        if (!MODO_TESTE && leadsParaAnalisar.length > 0) {
          const analises = await Promise.all(
            leadsParaAnalisar.map((l) =>
              gerarAnalise({
                nome: l.nome,
                nota: l.nota,
                avaliacoes: l.avaliacoes,
                telefone: l.telefone,
                site: l.site,
                endereco: l.endereco,
                categoria: l.categoria,
              }).catch(() => null)
            )
          );
          leadsParaAnalisar.forEach((l, i) => { l.analise = analises[i]; });
        }

        const resumo = {
          total: lugares.length,
          alta: leads.filter((l) => l.prioridade === "ALTA").length,
          media: leads.filter((l) => l.prioridade === "MEDIA").length,
          baixa: leads.filter((l) => l.prioridade === "BAIXA").length,
          descartados: descartados.length,
        };

        console.log(`[OK] Leads: ${resumo.alta} ALTA, ${resumo.media} MÉDIA, ${resumo.baixa} BAIXA, ${resumo.descartados} descartados.`);
        return enviarJson(res, 200, { modo: "leads", resumo, leads, descartados });
      }

    } catch (err) {
      console.error("ERRO:", err);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // ================================
  // ROTA CRM
  // ================================
  if (req.method === "POST" && pathname === "/api/crm") {
    try {
      const body = await lerBody(req);
      const { modo } = body;

      if (modo === "listar") {
        return enviarJson(res, 200, await lerCRM());
      }

      if (modo === "salvar") {
        const crm = await lerCRM();
        const lead = body.lead;
        const existing = crm.leads.find(l => l.id === lead.id);
        if (existing) {
          return enviarJson(res, 200, { ok: true, lead: existing, jaExiste: true });
        }
        const agora = new Date().toISOString();
        const novo = {
          id: lead.id,
          nome: lead.nome || "",
          telefone: lead.telefone || null,
          categoria: lead.categoria || null,
          endereco: lead.endereco || null,
          nota: lead.nota || null,
          avaliacoes: lead.avaliacoes || null,
          prioridade: lead.prioridade || "BAIXA",
          status: "novo",
          ultimoMovimento: null,
          statusConversa: null,
          ultimaInteracaoEm: null,
          mensagemInicial: lead.mensagemInicial || "",
          followUp: "",
          notas: "",
          criadoEm: agora,
          atualizadoEm: agora,
        };
        await salvarLead(novo);
        console.log(`[CRM] Lead salvo: ${novo.nome}`);
        return enviarJson(res, 200, { ok: true, lead: novo });
      }

      if (modo === "atualizar") {
        const crm = await lerCRM();
        const idx = crm.leads.findIndex(l => l.id === body.id);
        if (idx < 0) return enviarJson(res, 404, { erro: "Lead não encontrado" });
        const CAMPOS_PERMITIDOS = [
          "status", "ultimoMovimento", "statusConversa", "ultimaInteracaoEm",
          "mensagemInicial", "followUp", "notas",
        ];
        CAMPOS_PERMITIDOS.forEach(c => {
          if (body[c] !== undefined) crm.leads[idx][c] = body[c];
        });
        crm.leads[idx].atualizadoEm = new Date().toISOString();
        await salvarLead(crm.leads[idx]);
        return enviarJson(res, 200, { ok: true, lead: crm.leads[idx] });
      }

      if (modo === "status") {
        const crm = await lerCRM();
        const idx = crm.leads.findIndex(l => l.id === body.id);
        if (idx < 0) return enviarJson(res, 404, { erro: "Lead não encontrado" });
        crm.leads[idx].status = body.status;
        crm.leads[idx].atualizadoEm = new Date().toISOString();
        await salvarLead(crm.leads[idx]);
        return enviarJson(res, 200, { ok: true });
      }

      if (modo === "notas") {
        const crm = await lerCRM();
        const idx = crm.leads.findIndex(l => l.id === body.id);
        if (idx < 0) return enviarJson(res, 404, { erro: "Lead não encontrado" });
        crm.leads[idx].notas = body.notas;
        crm.leads[idx].atualizadoEm = new Date().toISOString();
        await salvarLead(crm.leads[idx]);
        return enviarJson(res, 200, { ok: true });
      }

      if (modo === "remover") {
        await removerLead(body.id);
        return enviarJson(res, 200, { ok: true });
      }

      return enviarJson(res, 400, { erro: "Modo CRM inválido" });
    } catch (err) {
      console.error("ERRO CRM:", err);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // ================================
  // ROTAS CRIATIVOS
  // ================================

  // Servir imagens estáticas de /uploads/ (fallback local sem Supabase)
  if (req.method === "GET" && pathname.startsWith("/uploads/")) {
    if (supabase) { res.writeHead(404); return res.end(); } // Supabase serve direto por URL pública
    const filePath = path.join(__dirname, pathname);
    if (!filePath.startsWith(UPLOADS_DIR)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end(); }
    const ext = path.extname(filePath).toLowerCase();
    const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": "max-age=3600" });
    return fs.createReadStream(filePath).pipe(res);
  }

  // GET /api/criativos/listar?cliente=rivano
  if (req.method === "GET" && pathname === "/api/criativos/listar") {
    const cliente = new URL(req.url, "http://localhost").searchParams.get("cliente") || "";
    if (!CLIENTES_CRIATIVOS.includes(cliente)) return enviarJson(res, 400, { erro: "Cliente inválido." });

    if (supabase) {
      const { data, error } = await supabase.storage.from(cliente).list("", { sortBy: { column: "created_at", order: "desc" } });
      if (error) return enviarJson(res, 500, { erro: error.message });
      const imagens = (data || [])
        .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name))
        .map(f => ({
          nome: f.name,
          url: `${SUPABASE_URL}/storage/v1/object/public/${cliente}/${f.name}`,
        }));
      return enviarJson(res, 200, { imagens });
    }

    // fallback local
    const dir = path.join(UPLOADS_DIR, cliente);
    const arquivos = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f)).map(f => ({ nome: f, url: `/uploads/${cliente}/${f}` }))
      : [];
    return enviarJson(res, 200, { imagens: arquivos });
  }

  // POST /api/criativos/upload  { cliente, nome, base64, mimeType }
  if (req.method === "POST" && pathname === "/api/criativos/upload") {
    try {
      const body = await lerBody(req);
      const { cliente, nome, base64, mimeType } = body;
      if (!CLIENTES_CRIATIVOS.includes(cliente)) return enviarJson(res, 400, { erro: "Cliente inválido." });
      if (!base64 || !nome) return enviarJson(res, 400, { erro: "base64 e nome são obrigatórios." });
      const ext = (mimeType || "image/jpeg").split("/")[1].replace("jpeg", "jpg");
      const nomeSeguro = nome.replace(/[^a-zA-Z0-9_\-\.]/g, "_").replace(/\.[^.]+$/, "") + "." + ext;

      if (supabase) {
        const buffer = Buffer.from(base64, "base64");
        const { error } = await supabase.storage.from(cliente).upload(nomeSeguro, buffer, {
          contentType: mimeType || "image/jpeg",
          upsert: true,
        });
        if (error) return enviarJson(res, 500, { erro: error.message });
        const url = `${SUPABASE_URL}/storage/v1/object/public/${cliente}/${nomeSeguro}`;
        console.log(`[Criativos] Upload Supabase: ${cliente}/${nomeSeguro}`);
        return enviarJson(res, 200, { ok: true, url, nome: nomeSeguro });
      }

      // fallback local
      const dest = path.join(UPLOADS_DIR, cliente, nomeSeguro);
      fs.writeFileSync(dest, Buffer.from(base64, "base64"));
      console.log(`[Criativos] Upload local: ${cliente}/${nomeSeguro}`);
      return enviarJson(res, 200, { ok: true, url: `/uploads/${cliente}/${nomeSeguro}`, nome: nomeSeguro });
    } catch (err) {
      console.error("ERRO upload:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/criativos/analytics  { cliente, campanhas? }
  if (req.method === "POST" && pathname === "/api/criativos/analytics") {
    try {
      const body = await lerBody(req);
      const { cliente, campanhas } = body;
      if (!cliente) return enviarJson(res, 400, { erro: "cliente é obrigatório." });
      let dados = campanhas || null;
      // Tenta buscar Meta Ads se não foi passado
      if (!dados && META_ACCESS_TOKEN && META_AD_ACCOUNT_ID) {
        try { dados = await buscarInsightsMeta(); } catch { dados = null; }
      }
      const briefing = await analisarCriativoAnalytics(cliente, dados);
      console.log(`[Criativos] Analytics-agent: ${cliente}`);
      return enviarJson(res, 200, { briefing });
    } catch (err) {
      console.error("ERRO analytics-agent:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/criativos/analisar-e-briefar  { cliente, imagemBase64, mimeType }
  // Faz analytics da campanha ativa + gera briefing estruturado (CTA, tagline, objetivo, formato)
  if (req.method === "POST" && pathname === "/api/criativos/analisar-e-briefar") {
    try {
      const body = await lerBody(req);
      const { cliente, imagemBase64, mimeType } = body;
      if (!cliente || !imagemBase64) return enviarJson(res, 400, { erro: "cliente e imagemBase64 são obrigatórios." });

      // Passo 1: buscar dados de campanha do Meta Ads (se disponível)
      let dadosMeta = null;
      if (META_ACCESS_TOKEN && META_AD_ACCOUNT_ID) {
        try { dadosMeta = await buscarInsightsMeta(); } catch { dadosMeta = null; }
      }

      // Passo 2: analytics-agent analisa a campanha
      const analise = await analisarCriativoAnalytics(cliente, dadosMeta);
      console.log(`[Criativos] Analytics concluído para ${cliente}`);

      // Perfis de cliente
      const CLIENTES = {
        rivano: {
          nome: "Rivano", segmento: "óculos / eyewear", posicionamento: "premium acessível",
          estilo: "editorial, elegante, minimalista", objetivo: "gerar desejo e percepção de valor",
          canal: "Instagram + WhatsApp", erros: "visual poluído, promoção agressiva",
        },
        "com-tempero": {
          nome: "Com Tempero", segmento: "alimentação / restaurante", posicionamento: "acessível, local, direto",
          estilo: "chamativo, apetitoso, direto", objetivo: "gerar desejo imediato e pedido",
          canal: "WhatsApp / delivery", erros: "visual frio, sem apelo de comida",
        },
      };
      const cfg = CLIENTES[cliente] || CLIENTES["rivano"];

      // Passo 3: gerar briefing estruturado com base na análise + imagem + perfil do cliente
      const mimeDetectado = detectMimeFromBase64(imagemBase64);
      const mimeReal = mimeDetectado || mimeType || null;
      const MIMES_SUPORTADOS = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      const imagemSuportada = mimeReal && MIMES_SUPORTADOS.includes(mimeReal);
      if (!imagemSuportada && imagemBase64) {
        console.warn(`[Criativos] Formato não suportado pelo OpenAI (${mimeReal || "desconhecido"}) — briefing sem visão`);
      }

      const promptBriefing = `Você é um gestor de tráfego sênior. Com base na análise de campanha abaixo${imagemSuportada ? " e na imagem fornecida" : ""}, defina o briefing do próximo criativo.

ANÁLISE DA CAMPANHA ATIVA:
${analise}

PERFIL DO CLIENTE:
- Nome: ${cfg.nome}
- Segmento: ${cfg.segmento}
- Posicionamento: ${cfg.posicionamento}
- Estilo: ${cfg.estilo}
- Objetivo de negócio: ${cfg.objetivo}
- Canal: ${cfg.canal}
- Erros a evitar: ${cfg.erros}

Com base na análise${imagemSuportada ? " e na imagem" : ""}, defina o melhor criativo para resolver o problema identificado.

Responda APENAS neste JSON (sem explicação, sem markdown):
{
  "cta": "texto exato do CTA — máx 5 palavras",
  "legenda": "tagline curta alinhada ao posicionamento — máx 6 palavras",
  "objetivo": "conversao | brand | engajamento",
  "formato": "feed | story",
  "contexto": "1 frase explicando a estratégia por trás deste criativo",
  "diagnostico": "1 frase resumindo o problema da campanha que este criativo resolve"
}`;

      const contentBriefing = [{ type: "text", text: promptBriefing }];
      if (imagemSuportada) {
        contentBriefing.push({ type: "image_url", image_url: { url: `data:${mimeReal};base64,${imagemBase64}` } });
      }

      const mensagens = [{ role: "user", content: contentBriefing }];

      const resp = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: mensagens,
        max_tokens: 250,
        temperature: 0.3,
      });

      const texto = resp.choices[0].message.content.trim();
      const jsonMatch = texto.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return enviarJson(res, 500, { erro: "Resposta inválida do modelo." });

      const briefing = JSON.parse(jsonMatch[0]);
      console.log(`[Criativos] Briefing automático gerado: ${cliente}`);
      return enviarJson(res, 200, { briefing, analise });
    } catch (err) {
      console.error("ERRO analisar-e-briefar:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/criativos/briefing-auto  { cliente, imagemBase64, mimeType }
  if (req.method === "POST" && pathname === "/api/criativos/briefing-auto") {
    try {
      const body = await lerBody(req);
      const { cliente, imagemBase64, mimeType } = body;
      if (!cliente || !imagemBase64) return enviarJson(res, 400, { erro: "cliente e imagemBase64 são obrigatórios." });

      const CLIENTES = {
        rivano: {
          nome: "Rivano",
          segmento: "óculos / eyewear",
          posicionamento: "premium acessível",
          estilo: "editorial, elegante, minimalista",
          comunicacao: "sutil, não agressiva",
          objetivo: "gerar desejo e percepção de valor",
          canal: "Instagram + WhatsApp",
          erros: "visual poluído, promoção agressiva, estética popular",
        },
        "com-tempero": {
          nome: "Com Tempero",
          segmento: "alimentação / restaurante",
          posicionamento: "acessível, local, direto",
          estilo: "chamativo, apetitoso, direto",
          comunicacao: "clara, objetiva, voltada para conversão",
          objetivo: "gerar desejo imediato e pedido",
          canal: "WhatsApp / delivery",
          erros: "visual frio, sem apelo de comida, estética muito sofisticada",
        },
      };

      const cfg = CLIENTES[cliente] || CLIENTES["rivano"];

      const mimeDetBA = detectMimeFromBase64(imagemBase64);
      const mimeRealBA = mimeDetBA || mimeType || null;
      const imagemSupBA = mimeRealBA && ["image/jpeg","image/png","image/gif","image/webp"].includes(mimeRealBA);
      if (!imagemSupBA && imagemBase64) console.warn(`[briefing-auto] Formato não suportado (${mimeRealBA}) — sem visão`);

      const contentBA = [
        {
          type: "text",
          text: `Você é um gestor de tráfego sênior. ${imagemSupBA ? "Analise a imagem e gere" : "Gere"} um briefing de criativo para anúncio.

Cliente: ${cfg.nome}
Segmento: ${cfg.segmento}
Posicionamento: ${cfg.posicionamento}
Estilo: ${cfg.estilo}
Comunicação: ${cfg.comunicacao}
Objetivo: ${cfg.objetivo}
Canal: ${cfg.canal}
Erros a evitar: ${cfg.erros}

Com base no perfil do cliente${imagemSupBA ? " e na imagem" : ""}, gere:
- CTA direto e adequado à marca (máx 5 palavras)
- Legenda/tagline curta e alinhada ao posicionamento (máx 6 palavras)
- Objetivo do anúncio: conversao | brand | engajamento
- Formato ideal: feed | story

Responda APENAS neste JSON (sem explicação, sem markdown):
{
  "cta": "...",
  "legenda": "...",
  "objetivo": "...",
  "formato": "...",
  "contexto": "..."
}`,
        },
      ];
      if (imagemSupBA) contentBA.push({ type: "image_url", image_url: { url: `data:${mimeRealBA};base64,${imagemBase64}` } });

      const mensagens = [{ role: "user", content: contentBA }];

      const resp = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: mensagens,
        max_tokens: 200,
        temperature: 0.4,
      });

      const texto = resp.choices[0].message.content.trim();
      // Extrair JSON mesmo que venha com markdown
      const jsonMatch = texto.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return enviarJson(res, 500, { erro: "Resposta inválida da IA." });
      const briefing = JSON.parse(jsonMatch[0]);
      console.log(`[Criativos] Briefing automático gerado: ${cliente}`);
      return enviarJson(res, 200, { briefing });
    } catch (err) {
      console.error("ERRO briefing-auto:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/criativos/designer  { cliente, briefing, imagemBase64, mimeType }
  if (req.method === "POST" && pathname === "/api/criativos/designer") {
    try {
      const body = await lerBody(req);
      const { cliente, cta, legenda, objetivo, formato, contexto, imagemBase64, mimeType } = body;
      if (!cliente || !imagemBase64) return enviarJson(res, 400, { erro: "cliente e imagemBase64 são obrigatórios." });
      if (!cta && !legenda) return enviarJson(res, 400, { erro: "Informe ao menos CTA ou legenda." });
      const resultado = await gerarPromptDesigner({ cliente, cta, legenda, objetivo, formato, contexto, imagemBase64, mimeType: mimeType || "image/jpeg" });
      console.log(`[Criativos] Designer-agent: ${cliente}`);
      return enviarJson(res, 200, { prompt: resultado.prompt, edit_prompt: resultado.edit_prompt });
    } catch (err) {
      console.error("ERRO designer-agent:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/crm/mensagem  { lead }
  // Gera 5 variações de mensagem via Outreach para o lead do CRM
  if (req.method === "POST" && pathname === "/api/crm/mensagem") {
    try {
      const body = await lerBody(req);
      const { lead } = body;
      if (!lead || !lead.nome) return enviarJson(res, 400, { erro: "lead com nome é obrigatório." });

      const variacoes = await gerarVariacoesOutreach(lead);
      console.log(`[CRM] Variações geradas via Outreach: ${lead.nome}`);
      return enviarJson(res, 200, { variacoes });
    } catch (err) {
      console.error("ERRO /api/crm/mensagem:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/gerar-variacoes  { lead }
  // Gera 5 variações de mensagem via Outreach (usado pelo drawer de prospecção)
  if (req.method === "POST" && pathname === "/api/gerar-variacoes") {
    try {
      const body = await lerBody(req);
      const { lead } = body;
      if (!lead || !lead.nome) return enviarJson(res, 400, { erro: "lead com nome é obrigatório." });

      const variacoes = await gerarVariacoesOutreach(lead);
      console.log(`[OK] Variações geradas: ${lead.nome}`);
      return enviarJson(res, 200, { variacoes });
    } catch (err) {
      console.error("ERRO /api/gerar-variacoes:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/criativos/editar  { imagemBase64, mimeType, promptEdicao }
  if (req.method === "POST" && pathname === "/api/criativos/editar") {
    try {
      const body = await lerBody(req);
      const { imagemBase64, mimeType, promptEdicao } = body;
      if (!imagemBase64 || !promptEdicao) {
        return enviarJson(res, 400, { erro: "imagemBase64 e promptEdicao são obrigatórios." });
      }
      if (!GOOGLE_GEMINI_API_KEY) {
        console.error("[Gemini] GOOGLE_GEMINI_API_KEY / GEMINI_API_KEY não definida no .env");
        return enviarJson(res, 400, { erro: "Chave Gemini não configurada. Adicione GEMINI_API_KEY no arquivo .env e reinicie o servidor." });
      }
      // Validação de guarda: prompt deve conter instrução de preservação
      const termoPreservacao = /\b(preserv|mantenha|edite|altere|ajuste|melhore)\b/i;
      if (!termoPreservacao.test(promptEdicao)) {
        console.warn("[Gemini] Prompt sem instrução de preservação bloqueado:", promptEdicao.substring(0, 80));
        return enviarJson(res, 400, { erro: "Prompt de edição sem instrução de preservação. Regere via designer-agent." });
      }
      console.log("[Gemini] Iniciando 3 variações de edição...");
      const variacoes = await editarImagemGemini(imagemBase64, mimeType || "image/jpeg", promptEdicao);
      const ok = variacoes.filter(v => v.ok).length;
      console.log(`[Gemini] Concluído: ${ok}/3 variações geradas.`);
      return enviarJson(res, 200, { variacoes });
    } catch (err) {
      console.error("ERRO /api/criativos/editar:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /ads/chat
  if (req.method === "POST" && pathname === "/ads/chat") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const body = await lerBody(req);
      const { campanha, mensagem, historico = [], accountKey } = body;
      if (!campanha || !mensagem) {
        return enviarJson(res, 400, { erro: "campanha e mensagem são obrigatórios." });
      }
      const resultado = await chatGestorTrafego(campanha, mensagem, historico, accountKey || null);
      console.log(`[OK] Chat tráfego (${accountKey || "auto"}) — acao:${resultado.analise?.acao} confianca:${resultado.analise?.confianca}`);
      return enviarJson(res, 200, resultado);
    } catch (err) {
      console.error("ERRO /ads/chat:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/estrategia
  if (req.method === "POST" && pathname === "/api/estrategia") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const body = await lerBody(req);
      const { pergunta, historico = [] } = body;
      if (!pergunta || !pergunta.trim()) {
        return enviarJson(res, 400, { erro: "Pergunta não pode estar vazia." });
      }
      const p = pergunta.trim();
      const modo = detectarModo(p);
      const crm = await lerCRM();
      const leads = crm.leads || [];
      const contexto = montarContextoDiretor(modo, leads);
      const systemPrompt = promptSistemaDiretor(modo, contexto);
      const hist = historico.slice(-10); // máx 5 trocas (10 msgs)

      let resposta = await chamarDirectorIA(modo, systemPrompt, hist, p, 0.35);
      let aviso = false;

      if (!validarOutputDiretor(resposta, modo)) {
        const retryPrompt = modo === "conversa"
          ? "Só a mensagem. Até 2 linhas. Sem introdução."
          : modo === "prospeccao"
          ? "Só a mensagem de contato. Até 3 linhas. Nada mais."
          : "Decida. Uma ação concreta. Sem condicionais. Sem explicação.";
        const systemRetry = systemPrompt + `\n\nINSTRUÇÃO DIRETA: ${retryPrompt}`;
        resposta = await chamarDirectorIA(modo, systemRetry, hist, p, 0);
        if (!validarOutputDiretor(resposta, modo)) aviso = true;
      }

      console.log(`[OK] Director (${modo})${aviso ? " [aviso]" : ""}`);
      return enviarJson(res, 200, { resposta, modo, aviso });
    } catch (err) {
      console.error("ERRO Estratégia:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // GET /ads/accounts — lista contas disponíveis para o frontend
  if (req.method === "GET" && pathname === "/ads/accounts") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return enviarJson(res, 200, { contas: listarContas() });
  }

  // GET /ads/insights?account=rivano
  if (req.method === "GET" && pathname === "/ads/insights") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      // Lê accountKey da query string — ?account=rivano ou ?account=com_tempero
      const urlObj = new URL(req.url, `http://localhost`);
      const accountKey = urlObj.searchParams.get("account") || null;
      const campanhas = await buscarInsightsMeta(accountKey);
      // Só analisa se houver campanhas
      const analise = campanhas.length > 0 ? await analisarCampanhas(campanhas) : null;
      const nomeConta = accountKey ? (ACCOUNT_CONFIG[accountKey]?.name || accountKey) : "conta padrão";
      console.log(`[OK] Insights Meta (${nomeConta}): ${campanhas.length} campanha(s).`);
      return enviarJson(res, 200, { campanhas, analise });
    } catch (err) {
      console.error("ERRO Meta:", err.message);
      // Retorna 200 com erro descritivo — frontend exibe mensagem útil, não crash
      return enviarJson(res, 200, {
        campanhas: [],
        analise: null,
        erro: err.message,
        tipo_erro: err.tipo || "desconhecido",
      });
    }
  }

  // ── ROTA UNIFICADA SLACK — multi-agente ──────────────────────────────────
  // POST /api/slack — despacha para 1+ agentes com Magic Prompt
  if (req.method === "POST" && pathname === "/api/slack") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const body = await lerBody(req);
      const { mensagem, historicoPorAgente = {} } = body;
      if (!mensagem || !mensagem.trim()) {
        return enviarJson(res, 400, { erro: "mensagem é obrigatória." });
      }
      if (mensagem.length > 2000) {
        return enviarJson(res, 400, { erro: "Mensagem muito longa. Máximo 2000 caracteres." });
      }

      // Detectar agentes explícitos ou inferir pelo conteúdo
      let agentesAlvo = parseAgentes(mensagem);
      if (!agentesAlvo) agentesAlvo = [inferirAgente(mensagem)];

      console.log(`[Slack] Despachando para: ${agentesAlvo.join(", ")}`);

      const resultados = await Promise.allSettled(
        agentesAlvo.map(async (agente) => {
          // Histórico relevante do agente (últimas 4 mensagens)
          const histRaw = historicoPorAgente[agente] || [];
          const hist = histRaw.slice(-4).map(m => ({
            role: m.tipo === "user" ? "user" : "assistant",
            content: m.text || ""
          }));

          // Magic Prompt enriquece o input
          const inputFinal = await magicPrompt(mensagem, agente, null);

          const systemPrompt = PROMPTS_AGENTES[agente];
          if (!systemPrompt) throw new Error(`Agente "${agente}" não configurado.`);

          const msgs = [
            { role: "system", content: systemPrompt },
            ...hist,
            { role: "user", content: inputFinal }
          ];

          const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: msgs,
            response_format: { type: "json_object" },
            temperature: 0.35,
            max_tokens: 1200,
          });

          const raw = completion.choices[0].message.content;
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = { resposta: raw, acao: null }; }
          if (!ACOES_VALIDAS.has(parsed.acao)) parsed.acao = null;

          // Atualiza histórico server-side do agente
          if (!historicoAgentes[agente]) historicoAgentes[agente] = [];
          historicoAgentes[agente].push({ role: "user", content: inputFinal });
          historicoAgentes[agente].push({ role: "assistant", content: raw });
          if (historicoAgentes[agente].length > 8) {
            historicoAgentes[agente] = historicoAgentes[agente].slice(-8);
          }

          return { agente, resposta: parsed.resposta || "", acao: parsed.acao || null };
        })
      );

      const respostas = resultados.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.error(`[Slack] Falha no agente ${agentesAlvo[i]}:`, r.reason?.message);
        return { agente: agentesAlvo[i], resposta: "Erro ao processar. Tente novamente.", acao: null, erro: true };
      });

      console.log(`[OK] Slack: ${respostas.length} resposta(s).`);
      return enviarJson(res, 200, { respostas });
    } catch (err) {
      console.error("ERRO /api/slack:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // ── ROTAS DE AGENTES INDIVIDUAIS ──────────────────────────────────────────
  // POST /api/director | /api/analytics | /api/gestor | /api/outreach | + novos
  const AGENTES_VALIDOS = TODOS_AGENTES;
  const nomeAgente = pathname.replace("/api/", "");
  if (req.method === "POST" && AGENTES_VALIDOS.includes(nomeAgente)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      // Rate limit
      if (!verificarRateLimit(nomeAgente)) {
        return enviarJson(res, 429, { erro: "Muitas requisições. Aguarde um momento." });
      }

      const body = await lerBody(req);
      const { input, context } = body;

      // Validação
      const texto = (input || "").trim();
      if (!texto) return enviarJson(res, 400, { erro: "input é obrigatório." });
      if (texto.length < 3) return enviarJson(res, 400, { erro: "Input muito curto." });
      if (texto.length > 1500) return enviarJson(res, 400, { erro: "Input muito longo. Máximo 1500 caracteres." });

      // Processa através do agente
      const resultado = await processarAgente(nomeAgente, texto, context || "");

      console.log(`[OK] Agente ${nomeAgente} respondeu (gpt-4o + Magic Prompt). Trocas: ${resultado.trocas}/4`);
      return enviarJson(res, 200, {
        agente: resultado.agente,
        resposta: resultado.resposta,
        acao: resultado.acao,
        trocas: resultado.trocas,
      });

    } catch (err) {
      console.error(`ERRO /api/${nomeAgente}:`, err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/agente/reset — limpa histórico de um agente
  if (req.method === "POST" && pathname === "/api/agente/reset") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const body = await lerBody(req);
      const { agente } = body;
      if (agente && TODOS_AGENTES.includes(agente)) {
        historicoAgentes[agente] = [];
        return enviarJson(res, 200, { ok: true, agente });
      }
      // Reset todos
      TODOS_AGENTES.forEach(k => { historicoAgentes[k] = []; });
      return enviarJson(res, 200, { ok: true, agente: "todos" });
    } catch (err) {
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/trafego — análise de tráfego com dados reais (para Slack)
  if (req.method === "POST" && pathname === "/api/trafego") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const body = await lerBody(req);
      const { mensagem, accountKey = "rivano" } = body;
      if (!mensagem || !mensagem.trim()) {
        return enviarJson(res, 400, { erro: "mensagem é obrigatória." });
      }

      // Busca campanhas da conta
      const campanhas = await buscarInsightsMeta(accountKey);
      if (!campanhas || campanhas.length === 0) {
        return enviarJson(res, 200, {
          resposta: "Nenhuma campanha encontrada para análise nesta conta.",
          acao: null,
        });
      }

      // Pega primeira campanha como referência
      const campanha = campanhas[0];

      // Roda análise via @analytics com contexto enriquecido
      const resultado = await analisarCampanha(campanha, mensagem, [], accountKey);

      console.log(`[OK] Análise de tráfego no Slack (${accountKey}) — ${resultado.parsed?.acao}`);
      return enviarJson(res, 200, {
        resposta: `${resultado.parsed?.justificativa}\n\nAção: ${resultado.parsed?.acao}`,
        acao: resultado.parsed?.acao || null,
      });
    } catch (err) {
      console.error(`ERRO /api/trafego:`, err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/gerar-mensagem — gera mensagem de abordagem via Outreach
  if (req.method === "POST" && pathname === "/api/gerar-mensagem") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const body = await lerBody(req);
      const { input, context } = body;
      if (!input || !input.trim()) {
        return enviarJson(res, 400, { erro: "input é obrigatório." });
      }
      const mensagem = await chamarOutreachInterno(input.trim(), context || "");
      console.log(`[OK] Mensagem gerada via Outreach.`);
      return enviarJson(res, 200, { mensagem });
    } catch (err) {
      console.error(`ERRO /api/gerar-mensagem:`, err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error("[Handler] Erro não capturado:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ erro: err.message || "Erro interno" }));
  }
}

async function inicializarSupabase() {
  if (!supabase) return;

  // 1. Criar buckets de Storage se não existirem
  for (const bucket of CLIENTES_CRIATIVOS) {
    const { error } = await supabase.storage.createBucket(bucket, { public: true });
    if (error && !error.message.includes("already exists")) {
      console.error(`[Supabase] Erro ao criar bucket ${bucket}:`, error.message);
    } else if (!error) {
      console.log(`[Supabase] Bucket criado: ${bucket}`);
    }
  }

  // 2. Migrar leads do arquivo local para Supabase (só se Supabase estiver vazio)
  if (fs.existsSync(CRM_FILE)) {
    try {
      const { count, error: cntErr } = await supabase.from("leads").select("*", { count: "exact", head: true });
      if (cntErr) {
        console.error("[Supabase] ⚠️  Erro ao acessar tabela 'leads':", cntErr.message);
        console.error("[Supabase] Execute este SQL no Supabase → Table Editor → SQL:");
        console.error(`
          CREATE TABLE leads (
            id TEXT PRIMARY KEY,
            dados JSONB NOT NULL
          );
          ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
          CREATE POLICY "service_role_all" ON leads FOR ALL USING (true);
        `);
        return;
      }
      if ((count || 0) === 0) {
        const local = JSON.parse(fs.readFileSync(CRM_FILE, "utf8"));
        const leads = local.leads || [];
        if (leads.length > 0) {
          const rows = leads.map(l => ({ id: l.id, dados: l }));
          const { error } = await supabase.from("leads").upsert(rows);
          if (error) console.error("[Supabase] Erro na migração:", error.message);
          else console.log(`[Supabase] ✔️  ${leads.length} lead(s) migrado(s).`);
        }
      } else {
        console.log(`[Supabase] ✔️  ${count} lead(s) já presentes.`);
      }
    } catch (e) {
      console.error("[Supabase] Erro ao verificar migração:", e.message);
    }
  }
}

// Inicializa Supabase ao carregar o módulo
if (supabase) {
  inicializarSupabase().catch(e => console.error("[Init] Erro:", e.message));
}

module.exports = { handler };