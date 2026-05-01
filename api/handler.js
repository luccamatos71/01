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
let estadoManual = null; // { cenarioOriginal, analiseAtual, analiseEstruturada }
let leadSeenIndex = [];

const DEBUG_PROSPECCAO_PREFIX = "[DEBUG_PROSPECCAO]";

function debugProspeccao(evento, dados = {}) {
  console.log(DEBUG_PROSPECCAO_PREFIX, evento, dados);
}

function debugProspeccaoErro(evento, erro, dados = {}) {
  console.error(DEBUG_PROSPECCAO_PREFIX, evento, {
    ...dados,
    erro: erro?.message || erro?.erro || String(erro || "erro desconhecido"),
    detalhes: erro?.detalhes || erro?.stack || "",
  });
}

function debugProspeccaoNichoLocal(query) {
  const texto = String(query || "").trim();
  const match = texto.match(/^(.+?)\s+em\s+(.+)$/i);
  return {
    query: texto,
    nicho: match ? match[1].trim() : texto,
    local: match ? match[2].trim() : "",
  };
}

function debugContarPrioridades(leads = []) {
  return leads.reduce((acc, lead) => {
    const prioridade = String(lead?.prioridade || "BAIXA").toUpperCase();
    if (prioridade === "ALTA") acc.alta += 1;
    else if (prioridade === "MEDIA") acc.media += 1;
    else if (prioridade === "DESCARTE") acc.descartado += 1;
    else acc.baixa += 1;
    return acc;
  }, { alta: 0, media: 0, baixa: 0, descartado: 0 });
}

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
  const resposta = parsed.resposta || "";
  const contextoValidacao = { nome: input, categoria: context || input, anguloAbordagem: context || input };
  const validacao = validarMensagemOutreach(resposta, contextoValidacao);
  if (validacao.ok) return resposta;

  const retry = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      ...messages,
      { role: "assistant", content: rawText },
      {
        role: "user",
        content: `Reescreva a mensagem. Falhas: ${validacao.motivos.join(", ")}. Maximo 2 frases, com pergunta leve, sem pedir reuniao/call/15 minutos e sem termos internos.`
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0.35,
    max_tokens: 400
  });
  let reparsed;
  try { reparsed = JSON.parse(retry.choices[0].message.content); } catch { reparsed = { resposta: "" }; }
  const corrigida = reparsed.resposta || "";
  return validarMensagemOutreach(corrigida, contextoValidacao).ok ? corrigida : "";
}

function normalizarListaOutreach(valor) {
  if (Array.isArray(valor)) return valor.filter(Boolean).map(item => String(item));
  if (!valor) return [];
  return [String(valor)];
}

function calcularIntensidadeOutreach(lead = {}) {
  const score = Number.isFinite(Number(lead.score)) ? Number(lead.score) : 0;
  const confianca = Number.isFinite(Number(lead.scoreConfianca)) ? Number(lead.scoreConfianca) : 0;
  const prioridade = normalizarPrioridadeAnalise(lead.prioridade);
  const sinaisFracos = normalizarListaOutreach(lead.sinaisFracos).join(" ").toLowerCase();
  const semTelefone = !String(lead.telefone || "").trim() || sinaisFracos.includes("sem telefone");
  const riscoForte = /consolidado|franquia|marca|descarte|dados insuficientes/.test(removerAcentos(sinaisFracos));

  if (semTelefone || prioridade === "BAIXA" || prioridade === "DESCARTE" || score < 60 || confianca < 55 || riscoForte) {
    return "leve";
  }
  if (score >= 82 && confianca >= 70 && prioridade === "ALTA") {
    return "direta";
  }
  return "normal";
}

function definirObjetivoOutreach(lead = {}, intensidade = "normal") {
  const score = Number.isFinite(Number(lead.score)) ? Number(lead.score) : 0;
  const confianca = Number.isFinite(Number(lead.scoreConfianca)) ? Number(lead.scoreConfianca) : 0;
  if (!String(lead.telefone || "").trim()) return "validar canal";
  if (score < 60 || confianca < 55) return "testar interesse";
  if (intensidade === "direta") return "puxar conversa";
  return "abrir porta";
}

function montarContextoOutreachLead(lead = {}) {
  const intensidade = calcularIntensidadeOutreach(lead);
  return {
    id: lead.id || lead.placeId || lead.nome || "",
    nome: lead.nome || "negocio",
    categoria: lead.categoria || "negocio local",
    endereco: lead.endereco || "nao informado",
    prioridade: lead.prioridade || "BAIXA",
    score: Number.isFinite(Number(lead.score)) ? Number(lead.score) : null,
    scoreConfianca: Number.isFinite(Number(lead.scoreConfianca)) ? Number(lead.scoreConfianca) : null,
    sinaisFortes: normalizarListaOutreach(lead.sinaisFortes),
    sinaisFracos: normalizarListaOutreach(lead.sinaisFracos),
    proximoPasso: lead.proximoPasso || "",
    anguloAbordagem: lead.anguloAbordagem || "validacao manual do contexto antes da abordagem",
    contextoAbordagem: lead.contextoAbordagem || "",
    gatilhoConversacional: lead.gatilhoConversacional || "",
    riscoTom: lead.riscoTom || intensidade,
    intensidade,
    objetivoMensagem: definirObjetivoOutreach(lead, intensidade),
  };
}

function sanitizarSinalOutreach(sinal) {
  const texto = String(sinal || "").trim();
  if (!texto) return "";

  const normalizado = removerAcentos(texto).toLowerCase();
  if (normalizado.includes("sem telefone")) return "sem telefone, abordagem precisa ser mais leve";
  if (normalizado.includes("avaliac")) {
    if (normalizado.includes("pequeno")) return "negocio pequeno com espaco para disputar atencao";
    if (normalizado.includes("tracao") || normalizado.includes("demanda")) {
      return "demanda local ja aparece, sem soar consolidado demais";
    }
    if (normalizado.includes("consolidado") || normalizado.includes("muito")) {
      return "negocio parece mais consolidado, abordagem deve ser leve";
    }
    return "historico local sugere ajustar a intensidade da abordagem";
  }
  if (normalizado.includes("nota")) return "reputacao com margem para conversa comercial";
  if (normalizado.includes("score") || normalizado.includes("confianca") || normalizado.includes("prioridade")) return "";

  return texto.replace(/\b\d+([.,]\d+)?\b/g, "").replace(/\s{2,}/g, " ").trim();
}

function sanitizarListaOutreach(lista) {
  return normalizarListaOutreach(lista).map(sanitizarSinalOutreach).filter(Boolean);
}

function montarUserMsgOutreach(contexto) {
  const sinaisFortes = sanitizarListaOutreach(contexto.sinaisFortes);
  const sinaisFracos = sanitizarListaOutreach(contexto.sinaisFracos);
  const fortes = sinaisFortes.length ? sinaisFortes.join("; ") : "sem sinais fortes claros";
  const fracos = sinaisFracos.length ? sinaisFracos.join("; ") : "sem sinais fracos relevantes";
  const score = contexto.score === null ? "nao informado" : contexto.score;
  const scoreConfianca = contexto.scoreConfianca === null ? "nao informado" : contexto.scoreConfianca;

  return `Contexto do SDR para guiar a mensagem:
Nome: ${contexto.nome}
Categoria/nicho: ${contexto.categoria}
Localizacao: ${contexto.endereco}
Prioridade interna: ${contexto.prioridade}
Score interno: ${score}
Confianca interna: ${scoreConfianca}
Angulo principal: ${contexto.anguloAbordagem}
Contexto do angulo: ${contexto.contextoAbordagem || "nao informado"}
Gatilho conversacional: ${contexto.gatilhoConversacional || "nao informado"}
Risco de tom: ${contexto.riscoTom || contexto.intensidade || "normal"}
Sinais fortes: ${fortes}
Sinais fracos: ${fracos}
Proximo passo interno: ${contexto.proximoPasso || "nao informado"}
Intensidade sugerida: ${contexto.intensidade || "normal"}
Objetivo da mensagem: ${contexto.objetivoMensagem || "abrir porta"}

Use o angulo e o gatilho conversacional como direcao da conversa. Use sinais fortes para personalizar. Use sinais fracos e risco de tom para deixar a abordagem mais leve quando necessario.
Nao cite nenhum dado interno, score, confianca, prioridade, sinais, intensidade, objetivo, nota, numero de avaliacoes ou analise SDR.`;
}

const CHAVES_VARIACOES_OUTREACH = ["leve", "direta", "provocativa", "followup", "reuniao"];

const SEGUNDA_MENSAGEM_PATTERNS = [
  {
    id: "automotivo",
    descricao: "estetica automotiva, lava jato premium, polimento e servicos de maior valor",
    match: /automot|carro|polimento|veiculo|lava\s*jato|martelinho|estetica automotiva/,
    comportamento: "pede orcamento e depois some",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
  {
    id: "restaurante_pizzaria",
    descricao: "restaurantes, pizzarias, delivery, comida local e pedidos por WhatsApp",
    match: /restaurante|pizz|delivery|pedido|comida|lanch|hamburg|ifood|\bbar\b/,
    comportamento: "pede uma vez e depois nao volta",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
  {
    id: "clinica_estetica_odonto",
    descricao: "clinicas, odontologia, estetica, saude e procedimentos com agendamento",
    match: /odont|dent|saude|clinica|paciente|estetic|procedimento|botox|laser|harmonizacao|dermato/,
    comportamento: "chama, tira duvida e nao agenda",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
  {
    id: "barbearia_salao",
    descricao: "barbearia, salao, beleza e servicos de retorno frequente",
    match: /barbear|salao|cabelo|manicure|sobrancelha|beleza/,
    comportamento: "vai uma vez e depois nao retorna",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
  {
    id: "advocacia_consultivo",
    descricao: "advocacia, contabilidade, consultoria e negocios consultivos",
    match: /advoc|advog|jurid|consultiv|contabil|contador|imobiliaria|corretor/,
    comportamento: "chama, explica o caso e depois nao avanca",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
  {
    id: "academia_pilates",
    descricao: "academia, pilates, fitness e recorrencia de matricula",
    match: /academ|pilates|fitness|funcional|crossfit|musculacao|matricula|treino/,
    comportamento: "chama, demonstra interesse e depois nao comeca",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
  {
    id: "loja_varejo",
    descricao: "lojas locais, varejo, pet shop e atendimento direto por WhatsApp",
    match: /loja|varejo|boutique|moda|calcad|roupa|pet|veterin|otica|farmacia|mercado/,
    comportamento: "pergunta preco e depois nao volta",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
  {
    id: "generico_local",
    descricao: "negocio local sem nicho claro",
    match: /./,
    comportamento: "chama, demonstra interesse e depois some",
    consequencia: "isso as vezes passa batido no WhatsApp",
  },
];

const CONECTIVOS_SEGUNDA_MENSAGEM = ["", "entao,", "assim,", "na real,"];

const CONECTIVOS_POR_VARIACAO_SEGUNDA_MENSAGEM = {
  leve: ["", "entao,"],
  direta: ["entao,", ""],
  provocativa: ["na real,", ""],
  followup: ["", "assim,"],
  reuniao: ["entao,", "assim,"],
};

function hashTextoOutreach(texto) {
  return String(texto || "").split("").reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) >>> 0;
  }, 0);
}

function normalizarTextoOutreach(texto) {
  return removerAcentos(String(texto || "").toLowerCase());
}

function fonteSegundaMensagemOutreach(contexto = {}) {
  return normalizarTextoOutreach([
    contexto.nome,
    contexto.categoria,
    contexto.anguloAbordagem,
    contexto.contextoAbordagem,
    contexto.gatilhoConversacional,
    ...(normalizarListaOutreach(contexto.sinaisFortes || [])),
    ...(normalizarListaOutreach(contexto.sinaisFracos || [])),
  ].filter(Boolean).join(" "));
}

function obterPadraoSegundaMensagemOutreach(patternId) {
  return SEGUNDA_MENSAGEM_PATTERNS.find(pattern => pattern.id === patternId) || null;
}

function escolherPadraoFallbackOutreach(contexto = {}) {
  const fonte = fonteSegundaMensagemOutreach(contexto);
  return SEGUNDA_MENSAGEM_PATTERNS.find(pattern => pattern.id !== "generico_local" && pattern.match.test(fonte))
    || obterPadraoSegundaMensagemOutreach("generico_local");
}

function normalizarTomSegundaMensagem(tom, contexto = {}) {
  const valor = normalizarTextoOutreach(tom);
  if (["leve", "direta", "normal"].includes(valor)) return valor;
  if (["leve", "direta", "normal"].includes(contexto.intensidade)) return contexto.intensidade;
  return "normal";
}

async function escolherPadraoSegundaMensagemOutreach(contexto = {}) {
  const fallback = escolherPadraoFallbackOutreach(contexto);
  const opcoes = SEGUNDA_MENSAGEM_PATTERNS
    .map(pattern => `${pattern.id}: ${pattern.descricao}`)
    .join("\n");

  try {
    debugProspeccao("openai_chamada", { fluxo: "outreach_pattern", lead: contexto.nome || "", modelo: "gpt-4o-mini" });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Voce escolhe um padrao de segunda mensagem de WhatsApp. Nao escreva a mensagem final.
Retorne apenas JSON com:
{"patternId":"um_id_da_lista","tom":"leve|normal|direta"}

IDs disponiveis:
${opcoes}

Regras:
- use categoria, angulo e sinais apenas para escolher o patternId
- se estiver em duvida, escolha o mais especifico
- nunca escreva texto de mensagem`,
        },
        {
          role: "user",
          content: montarUserMsgOutreach(contexto),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 90,
    });
    const parsed = JSON.parse(completion.choices[0].message.content || "{}");
    const pattern = obterPadraoSegundaMensagemOutreach(parsed.patternId);
    if (!pattern) {
      debugProspeccao("fallback_ativado", { tipo: "outreach_pattern", motivo: "pattern_invalido", lead: contexto.nome || "" });
      return { pattern: fallback, tom: normalizarTomSegundaMensagem("", contexto), origem: "fallback" };
    }
    debugProspeccao("openai_resposta", { fluxo: "outreach_pattern", lead: contexto.nome || "", patternId: pattern.id });
    return { pattern, tom: normalizarTomSegundaMensagem(parsed.tom, contexto), origem: "ia" };
  } catch (err) {
    debugProspeccaoErro("openai_erro", err, { fluxo: "outreach_pattern", lead: contexto.nome || "" });
    debugProspeccao("fallback_ativado", { tipo: "outreach_pattern", motivo: "openai_erro", lead: contexto.nome || "" });
    return { pattern: fallback, tom: normalizarTomSegundaMensagem("", contexto), origem: "fallback" };
  }
}

function palavrasDeAnguloOutreach(contexto = {}) {
  const fonte = normalizarTextoOutreach([
    contexto.anguloAbordagem,
    contexto.categoria,
    contexto.nome,
  ].filter(Boolean).join(" "));
  const palavras = fonte
    .split(/[^a-z0-9]+/)
    .filter(p => p.length >= 5)
    .filter(p => !["local", "negocio", "validacao", "contexto", "antes", "abordagem"].includes(p));

  const base = new Set(palavras);
  if (/whatsapp|orcamento|pedido|direto/.test(fonte)) {
    ["whatsapp", "pedido", "orcamento", "direto", "mensagem"].forEach(p => base.add(p));
  }
  if (/agenda|horario|retorno/.test(fonte)) {
    ["agenda", "horario", "retorno", "fluxo", "agendamento"].forEach(p => base.add(p));
  }
  if (/confianca|reputacao|autoridade/.test(fonte)) {
    ["confianca", "bairro", "regiao", "seguranca", "autoridade"].forEach(p => base.add(p));
  }
  if (/estetic|procedimento|clinica/.test(fonte)) {
    ["procedimento", "duvida", "seguranca", "primeira", "agenda", "whatsapp"].forEach(p => base.add(p));
  }
  if (/recorrencia|matricula|retencao|cuidados/.test(fonte)) {
    ["recorrencia", "matricula", "retorno", "frequencia", "cuidados"].forEach(p => base.add(p));
  }
  if (/automot|carro|servico/.test(fonte)) {
    ["carro", "servico", "automotivo", "polimento", "orcamento"].forEach(p => base.add(p));
  }
  if (/advoc|advog|consultiv|jurid/.test(fonte)) {
    ["consultivo", "triagem", "caso", "juridico", "bairro"].forEach(p => base.add(p));
  }
  return Array.from(base);
}

function perguntaFinalOutreach(texto) {
  const perguntas = String(texto || "").match(/[^?]+\?/g) || [];
  if (!perguntas.length) return "";
  const trecho = perguntas[perguntas.length - 1].trim();
  const corte = Math.max(trecho.lastIndexOf("."), trecho.lastIndexOf("!"), trecho.lastIndexOf(";"));
  return corte >= 0 ? trecho.slice(corte + 1).trim() : trecho;
}

function textoAntesPerguntaOutreach(texto) {
  const original = String(texto || "");
  const idx = original.indexOf("?");
  return idx >= 0 ? original.slice(0, idx) : original;
}

function temMicroPercepcaoOutreach(texto, contexto = {}) {
  const antes = normalizarTextoOutreach(textoAntesPerguntaOutreach(texto));
  const palavras = antes.split(/\s+/).filter(Boolean);
  if (palavras.length < 8) return false;

  const indicadores = /bairro|regiao|local|agenda|horario|retorno|whatsapp|pedido|orcamento|indicacao|confianca|duvida|triagem|caso|servico|matricula|frequencia|recorrencia|paciente|cliente|movimento|app|semana|compar|pesquis|procur|esfri|escap|perder|ocioso|recompra|margem|primeiro contato|demora|encaixa/;
  const nomeTokens = normalizarTextoOutreach(contexto.nome || "").split(/[^a-z0-9]+/).filter(p => p.length >= 4);
  const citaNome = nomeTokens.length > 0 && nomeTokens.some(p => antes.includes(p));
  const palavrasAngulo = palavrasDeAnguloOutreach(contexto);
  const citaAngulo = palavrasAngulo.some(p => antes.includes(p));

  return indicadores.test(antes) || citaNome || citaAngulo;
}

function temRiscoOuOportunidadeOutreach(texto, contexto = {}) {
  const t = normalizarTextoOutreach(texto);
  const indicadores = /perder|escap|esfri|ocioso|parado|margem|so em app|depende|demora|duvida|compar|pesquis|concorr|indicacao|whatsapp|orcamento|recompra|triagem|agenda|retorno|recorrencia|frequencia|matricula|relacionamento|confianca|procura|chamar|encaixa|dias mais parados/;
  if (indicadores.test(t)) return true;
  return palavrasDeAnguloOutreach(contexto).some(p => t.includes(p));
}

function perguntaGenericaOutreach(texto) {
  const pergunta = normalizarTextoOutreach(perguntaFinalOutreach(texto));
  if (!pergunta) return true;
  const genericas = [
    /como (esta|ta|estao|vai) (o )?(movimento|fluxo|agenda)/,
    /ta bom ou ruim/,
    /como voces? (tem|t[ae]m|estao) lidando/,
    /como voce tem lidado/,
    /posso te mandar uma ideia/,
    /faz sentido falar rapidinho/,
    /quer conversar/,
    /podemos conversar/,
    /posso apresentar/,
    /tem interesse/,
  ];
  return genericas.some(regex => regex.test(pergunta));
}

function validarMensagemAberturaOutreach(texto, contexto = {}) {
  const original = String(texto || "").trim();
  const t = normalizarTextoOutreach(original);
  const motivos = [];
  const pergunta = perguntaFinalOutreach(original);
  const palavrasPergunta = pergunta.split(/\s+/).filter(Boolean).length;

  if (!original) motivos.push("mensagem vazia");
  if (original.length > 230 || original.split(/\s+/).filter(Boolean).length > 42) motivos.push("mensagem longa demais");
  if ((original.match(/[.!?]+/g) || []).length > 3) motivos.push("mais de duas frases reais");
  if (!original.includes("?")) motivos.push("nao faz pergunta leve");
  if (palavrasPergunta > 18) motivos.push("pergunta final longa demais");
  if (perguntaGenericaOutreach(original)) motivos.push("pergunta final generica");
  if (!temMicroPercepcaoOutreach(original, contexto)) motivos.push("sem micro percepcao antes da pergunta");
  if (!temRiscoOuOportunidadeOutreach(original, contexto)) motivos.push("sem risco ou oportunidade clara");

  const proibidos = [
    ["score", /\bscore\b|pontuacao/],
    ["prioridade", /\bprioridade\b/],
    ["confianca interna", /confianca interna|score de confianca|confianca do score|nivel de confianca/],
    ["analise interna", /analise|analisei|sdr|sinais?/],
    ["nota/avaliacao", /\bnota\b|avaliac|estrelas/],
    ["identifiquei", /identifiquei|identificamos/],
    ["estrategia de marketing", /estrategia de marketing|marketing digital|trafego pago/],
    ["diagnostico/insight no primeiro contato", /diagnostico|insight/],
    ["reuniao direta", /reuniao|call|chamada|videochamada|15\s?min|20\s?min|agendar|marcar|agenda[rm]\s+(uma\s+)?(call|reuniao|conversa)/],
    ["pitch generico", /aumentar visibilidade|atrair mais clientes|crescer seu negocio|temos uma solucao|poderia te ajudar|oportunidade de crescimento/],
    ["google/avaliacoes", /vi suas avaliacoes|google maps|maps/],
  ];
  proibidos.forEach(([motivo, regex]) => {
    if (regex.test(t)) motivos.push(motivo);
  });

  const genericos = [
    "ola, tudo bem?",
    "gostaria de apresentar",
    "me chamo",
    "sou da",
    "trabalho com marketing",
    "ajudamos empresas",
  ];
  if (genericos.some(g => t.includes(g))) motivos.push("abertura generica ou institucional");

  const palavrasAngulo = palavrasDeAnguloOutreach(contexto);
  const temRelacaoComAngulo = palavrasAngulo.length === 0 || palavrasAngulo.some(p => t.includes(p));
  const nomeTokens = normalizarTextoOutreach(contexto.nome || "").split(/[^a-z0-9]+/).filter(p => p.length >= 4);
  const citaNome = nomeTokens.length > 0 && nomeTokens.some(p => t.includes(p));
  if (!temRelacaoComAngulo && !citaNome) motivos.push("sem relacao clara com o angulo");

  return { ok: motivos.length === 0, motivos };
}

function validarMensagemOutreach(texto, contexto = {}) {
  return validarMensagemAberturaOutreach(texto, contexto);
}

function validarMensagemContinuidadeOutreach(texto, contexto = {}) {
  const original = String(texto || "").trim();
  const t = normalizarTextoOutreach(original);
  const motivos = [];

  if (!original) motivos.push("mensagem vazia");
  if (original.length > 360 || original.split(/\s+/).filter(Boolean).length > 68) motivos.push("mensagem longa demais");
  if ((original.match(/[.!?]+/g) || []).length > 5) motivos.push("frases demais para WhatsApp");
  if (!original.includes("?")) motivos.push("nao fecha com pergunta natural");

  const proibidos = [
    ["score", /\bscore\b|pontuacao/],
    ["prioridade", /\bprioridade\b/],
    ["confianca interna", /confianca interna|score de confianca|nivel de confianca/],
    ["analise interna", /analise|analisei|sdr|sinais?/],
    ["nota/avaliacao", /\bnota\b|avaliac|estrelas/],
    ["identifiquei", /identifiquei|identificamos/],
    ["estrategia", /estrategia/],
    ["pitch generico", /aumentar visibilidade|atrair mais clientes|crescer seu negocio|temos uma solucao|poderia te ajudar|oportunidade de crescimento/],
    ["tom de agencia", /sou da|trabalho com marketing|marketing digital|trafego pago|nossa agencia/],
    ["convite duro", /agendar call|marcar call|marcar reuniao|agendar reuniao|vamos marcar|podemos agendar|calendly/],
  ];
  proibidos.forEach(([motivo, regex]) => {
    if (regex.test(t)) motivos.push(motivo);
  });

  if (!/sem compromisso|sem pressao|rapidinho|rapido|15\s?min|quinze/.test(t)) {
    motivos.push("nao deixa a conversa leve");
  }
  if (!/diagnostico|insight|ponto|olhada|ideia/.test(t)) {
    motivos.push("nao menciona diagnostico ou insight leve");
  }

  const palavrasAngulo = palavrasDeAnguloOutreach(contexto);
  const temRelacaoComAngulo = palavrasAngulo.length === 0 || palavrasAngulo.some(p => t.includes(p));
  const nomeTokens = normalizarTextoOutreach(contexto.nome || "").split(/[^a-z0-9]+/).filter(p => p.length >= 4);
  const citaNome = nomeTokens.length > 0 && nomeTokens.some(p => t.includes(p));
  if (!temRelacaoComAngulo && !citaNome) motivos.push("sem relacao clara com o angulo");

  return { ok: motivos.length === 0, motivos };
}

function validarMensagemSegundaOutreach(texto, contexto = {}) {
  const original = String(texto || "").trim();
  const t = normalizarTextoOutreach(original);
  const motivos = [];

  if (!original) motivos.push("mensagem vazia");
  if (original.includes("\n")) motivos.push("mensagem com quebra de linha");
  if (original.includes("?")) motivos.push("pergunta direta");
  if (original.length > 230) motivos.push("mensagem longa demais");

  const proibidos = [
    ["score", /\bscore\b|pontuacao/],
    ["prioridade", /\bprioridade\b/],
    ["analise interna", /analise|analisei|sdr|sinais?|confianca interna/],
    ["nota/avaliacao", /\bnota\b|avaliac|estrelas/],
    ["conectivo artificial", /^boa,|^olha,|^passando rapido,/],
    ["conforme analise", /conforme analise/],
    ["diagnostico", /diagnostico/],
    ["identifiquei", /identifiquei|identificamos/],
    ["estrategia", /estrategia/],
    ["otimizacao", /otimiz/],
    ["linguagem montada", /costuma|ocorre|pode estar acontecendo devido a/],
    ["tom de agencia", /sou da|trabalho com marketing|marketing digital|trafego pago|nossa agencia|especialista em marketing/],
    ["pitch generico", /aumentar visibilidade|atrair mais clientes|crescer seu negocio|temos uma solucao|poderia te ajudar|oportunidade de crescimento/],
    ["convite duro", /agendar|agenda uma|agenda um|ver agenda|call|reuniao|marcar|calendly/],
    ["formal demais", /gostaria de apresentar|venho apresentar|prezado|caro responsavel/],
  ];
  proibidos.forEach(([motivo, regex]) => {
    if (regex.test(t)) motivos.push(motivo);
  });

  const comportamentos = SEGUNDA_MENSAGEM_PATTERNS
    .map(pattern => normalizarTextoOutreach(pattern.comportamento))
    .filter(Boolean);
  const temComportamento = comportamentos.some(comportamento => t.includes(comportamento));
  if (!temComportamento) motivos.push("sem comportamento do nicho");
  if (!t.includes("isso as vezes passa batido no whatsapp")) motivos.push("sem consequencia padrao");
  if (!t.includes("se fizer sentido te mostro rapido")) motivos.push("sem convite leve padrao");

  return { ok: motivos.length === 0, motivos };
}

function normalizarVariacoesOutreach(parsed = {}) {
  return CHAVES_VARIACOES_OUTREACH.reduce((acc, key) => {
    acc[key] = String(parsed?.[key] || "").trim();
    return acc;
  }, {});
}

function validarVariacoesOutreach(variacoes, contexto) {
  const resultado = {};
  const invalidas = [];
  CHAVES_VARIACOES_OUTREACH.forEach((key) => {
    const validacao = validarMensagemSegundaOutreach(variacoes[key], contexto);
    resultado[key] = validacao.ok ? variacoes[key] : "";
    if (!validacao.ok) {
      invalidas.push({ key, texto: variacoes[key] || "", motivos: validacao.motivos });
    }
  });
  return { variacoes: resultado, invalidas };
}

function montarPromptCorrecaoOutreach(contexto, invalidas) {
  const falhas = invalidas
    .map(item => `- ${item.key}: ${item.motivos.join(", ")}`)
    .join("\n");
  return `Algumas variacoes falharam no controle de qualidade:
${falhas}

Reescreva TODAS as 5 variacoes em JSON.
Regras inegociaveis:
- segunda mensagem, usada depois que o lead respondeu
- maximo 3 linhas curtas
- estrutura: abertura leve + situacao real + conexao com o negocio + curiosidade + convite leve para ver em 15min
- nao explique o problema; apenas sugira
- precisa gerar curiosidade sem parecer pitch
- pode falar "15min", "te mostro" ou "te mando um ponto"
- escreva como WhatsApp digitado rapido, com frases que poderiam ser faladas em voz alta
- troque explicacao por situacao real: "muita gente chama e some", "entra contato mas nao vira nada", "o pessoal pede e depois nao volta"
- nao pedir reuniao, call, agenda ou marcar horario
- nao citar dados internos, score, nota, avaliacoes, SDR ou analise
- nao usar "costuma", "ocorre", "estrategia", "identifiquei", "otimizacao" ou linguagem de agencia
- precisa se conectar ao angulo: ${contexto.anguloAbordagem}
- objetivo: ${contexto.objetivoMensagem}
- intensidade: ${contexto.intensidade}

Retorne APENAS JSON com as chaves leve, direta, provocativa, followup e reuniao.`;
}

function resumirAnguloOutreach(contexto = {}) {
  const fonte = normalizarTextoOutreach([contexto.anguloAbordagem, contexto.categoria].filter(Boolean).join(" "));
  if (/whatsapp|pedido|orcamento|direto|delivery|pizz/.test(fonte)) return "pedidos e conversas pelo WhatsApp";
  if (/agenda|horario|retorno|barbear|salao|estetic/.test(fonte)) return "agenda e retorno de clientes";
  if (/odont|saude|clinica|paciente|captacao/.test(fonte)) return "entrada de novos clientes da regiao";
  if (/advoc|advog|jurid|consultiv|contabil/.test(fonte)) return "demanda consultiva da regiao";
  if (/automot|carro|polimento|veiculo/.test(fonte)) return "orcamentos de servicos automotivos";
  if (/academ|pilates|fitness|matricula|retencao/.test(fonte)) return "matriculas e frequencia local";
  if (/reputacao|confianca|autoridade/.test(fonte)) return "confianca local antes do contato";
  return "novos contatos pelo WhatsApp";
}

function gerarFallbackMensagemOutreach(contexto = {}, tipo = "direta") {
  const nome = String(contexto.nome || "seu negocio").trim();
  const tema = resumirAnguloOutreach(contexto);
  const fonte = normalizarTextoOutreach([contexto.anguloAbordagem, contexto.categoria].filter(Boolean).join(" "));

  if (tipo === "followup") {
    return `${nome}, quando o primeiro contato fica sem resposta, uma oportunidade sobre ${tema} pode esfriar rapido. Vale eu mandar um ponto mais direto por aqui?`;
  }
  if (tipo === "reuniao") {
    return `${nome}, esse ponto de ${tema} costuma mostrar rapido se existe abertura real. Isso acontece ai tambem?`;
  }
  if (tipo === "provocativa") {
    return `${nome}, quando tudo depende so de indicacao, alguns contatos bons acabam escapando sem virar conversa. Isso acontece ai tambem?`;
  }
  if (/advoc|advog|jurid|consultiv|contabil/.test(fonte)) {
    return `${nome}, no consultivo muita gente pesquisa e demora para chamar porque ainda nao sabe se o caso encaixa. Voces fazem alguma triagem simples antes da conversa?`;
  }
  if (/automot|carro|polimento|veiculo/.test(fonte)) {
    return `${nome}, servico automotivo de maior valor costuma esfriar quando o orcamento demora no WhatsApp. Voces respondem esses pedidos direto por la?`;
  }
  if (/restaurante|pizz|delivery|pedido/.test(fonte)) {
    return `${nome}, negocio de comida local costuma perder margem quando o pedido cai so em app. Hoje voces puxam recompra pelo WhatsApp ou fica mais no espontaneo?`;
  }
  if (/agenda|horario|retorno|barbear|salao|estetic/.test(fonte)) {
    return `${nome}, agenda com horario ocioso costuma aparecer sem o cliente perceber no dia a dia. Voces puxam retorno pelo WhatsApp ou fica mais na indicacao?`;
  }
  if (/odont|saude|clinica|paciente/.test(fonte)) {
    return `${nome}, em clinica muita gente compara confianca antes de chamar pela primeira vez. Quando aparece duvida no WhatsApp, voces conseguem puxar orcamento ou esfria?`;
  }
  if (/academ|pilates|fitness|matricula|retencao/.test(fonte)) {
    return `${nome}, em academia pequena muita matricula esfria quando a pessoa tira duvida e some. Voces fazem algum retorno rapido no WhatsApp?`;
  }
  return `${nome}, negocio local costuma perder contato bom quando tudo fica so na indicacao. Hoje entra mais por indicacao ou pelo WhatsApp?`;
}

function mensagemSeguraOutreach(texto, contexto, tipo = "direta") {
  const tentativa = String(texto || "").trim();
  if (validarMensagemAberturaOutreach(tentativa, contexto).ok) return tentativa;
  const fallback = gerarFallbackMensagemOutreach(contexto, tipo);
  if (validarMensagemAberturaOutreach(fallback, contexto).ok) return fallback;
  return `${contexto.nome || "Seu negocio"}, quando esse ponto de ${resumirAnguloOutreach(contexto)} nao fica claro, alguns contatos bons esfriam. Isso acontece ai tambem?`;
}

function normalizarMensagemLinhaUnicaOutreach(texto) {
  return String(texto || "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*,+/g, ",")
    .replace(/^(entao,|assim,|na real,)\s+(entao,|assim,|na real,)\s+/i, "$1 ")
    .replace(/\s+,/g, ",")
    .trim();
}

function escolherConectivoSegundaMensagem(contexto = {}, tipo = "direta", usados = []) {
  const opcoes = CONECTIVOS_POR_VARIACAO_SEGUNDA_MENSAGEM[tipo] || CONECTIVOS_SEGUNDA_MENSAGEM;
  const base = [
    contexto.id,
    contexto.nome,
    contexto.categoria,
    contexto.anguloAbordagem,
    tipo,
  ].filter(Boolean).join("|");
  let escolhido = opcoes[hashTextoOutreach(base) % opcoes.length] || "";
  const ultimos = usados.slice(-2);

  if (ultimos.length === 2 && ultimos.every(conectivo => conectivo === escolhido)) {
    escolhido = escolhido ? "" : "entao,";
  }

  return CONECTIVOS_SEGUNDA_MENSAGEM.includes(escolhido) ? escolhido : "";
}

function montarMensagemSemiFixaOutreach(pattern, contexto = {}, tipo = "direta", conectivoInformado = null) {
  const padrao = pattern || escolherPadraoFallbackOutreach(contexto);
  const conectivo = conectivoInformado === null
    ? escolherConectivoSegundaMensagem(contexto, tipo)
    : conectivoInformado;
  const prefixo = conectivo ? `${conectivo} ` : "";
  const consequencia = padrao.consequencia || "isso as vezes passa batido no WhatsApp";
  return normalizarMensagemLinhaUnicaOutreach(
    `${prefixo}hoje em dia muita gente ${padrao.comportamento}, ${consequencia}, se fizer sentido te mostro rapido`
  );
}

function montarVariacoesSemiFixasOutreach(pattern, contexto = {}) {
  const usados = [];
  return CHAVES_VARIACOES_OUTREACH.reduce((acc, key) => {
    const conectivo = escolherConectivoSegundaMensagem(contexto, key, usados);
    usados.push(conectivo);
    acc[key] = montarMensagemSemiFixaOutreach(pattern, contexto, key, conectivo);
    return acc;
  }, {});
}

function gerarFallbackSegundaOutreach(contexto = {}, tipo = "direta") {
  return montarMensagemSemiFixaOutreach(escolherPadraoFallbackOutreach(contexto), contexto, tipo);
}

function mensagemSeguraSegundaOutreach(texto, contexto, tipo = "direta") {
  const tentativa = String(texto || "").trim();
  if (validarMensagemSegundaOutreach(tentativa, contexto).ok) return tentativa;
  const fallback = gerarFallbackSegundaOutreach(contexto, tipo);
  if (validarMensagemSegundaOutreach(fallback, contexto).ok) return fallback;
  return "hoje em dia muita gente chama, demonstra interesse e depois some, isso as vezes passa batido no WhatsApp, se fizer sentido te mostro rapido";
}

function preencherVariacoesFallbackOutreach(variacoes, contexto) {
  return CHAVES_VARIACOES_OUTREACH.reduce((acc, key) => {
    acc[key] = mensagemSeguraSegundaOutreach(variacoes?.[key], contexto, key);
    return acc;
  }, {});
}

function gerarFallbackContinuidadeOutreach(contexto = {}, respostaLead = "") {
  const nome = String(contexto.nome || "por ai").trim();
  const tema = resumirAnguloOutreach(contexto);
  const respondeu = String(respostaLead || "").trim();
  const ganchoResposta = respondeu
    ? `Boa, ${nome}, entendi.`
    : `Boa, ${nome}, obrigado por responder.`;
  return `${ganchoResposta} Tem um ponto simples sobre ${tema} que talvez valha uma olhada sem compromisso; te mando um diagnóstico rápido em 15 min por aqui mesmo?`;
}

function mensagemContinuidadeSeguraOutreach(texto, contexto, respostaLead = "") {
  const tentativa = String(texto || "").trim();
  if (validarMensagemSegundaOutreach(tentativa, contexto).ok) return tentativa;
  const fallback = gerarFallbackSegundaOutreach(contexto, "reuniao");
  if (validarMensagemSegundaOutreach(fallback, contexto).ok) return fallback;
  return mensagemSeguraSegundaOutreach("", contexto, "reuniao");
}

async function gerarMensagemPrincipalOutreach(lead) {
  const contextoOutreach = montarContextoOutreachLead(lead);
  const systemPrompt = `Voce escreve uma unica primeira mensagem de WhatsApp para prospeccao local.
Objetivo: gerar resposta e interesse real, nao vender.
Estilo: contextual discreto, humano, sem parecer agencia.
Use nome, nicho, localizacao, sinais e angulo principal sem parecer que voce analisou o negocio.
Use o gatilho conversacional se existir.
Estrutura obrigatoria:
1. micro percepcao plausivel sobre o negocio, nicho, bairro, agenda, WhatsApp, recorrencia, confianca ou concorrencia
2. risco ou oportunidade leve que o dono entenda rapido
3. pergunta final curta, concreta e facil de responder em ate 2 segundos

Maximo 2 frases, ate 42 palavras.
Nao faca pergunta solta: sempre traga uma percepcao antes.
Nao use perguntas genericas como "como esta o movimento?", "ta bom ou ruim?", "como voce tem lidado..." ou "posso te mandar uma ideia?"
Nao invente dado factual especifico; use percepcao plausivel de nicho/contexto.
Nao cite score, prioridade, sinais, confianca, SDR, analise, nota, avaliacoes, reuniao, call, 15min, diagnostico, insight ou termos tecnicos.
Evite "acredito", "estrategia", "identifiquei", "aumentar visibilidade", "atrair clientes" e frases prontas.
Retorne APENAS JSON: {"mensagem":"..."}`;

  const userMsg = montarUserMsgOutreach(contextoOutreach);

  try {
    debugProspeccao("openai_chamada", { fluxo: "outreach_principal", lead: contextoOutreach.nome || "", modelo: "gpt-4o-mini" });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg }
      ],
      response_format: { type: "json_object" },
      temperature: 0.45,
      max_tokens: 180
    });
    const raw = completion.choices[0].message.content || "{}";
    const parsed = JSON.parse(raw);
    debugProspeccao("openai_resposta", { fluxo: "outreach_principal", lead: contextoOutreach.nome || "" });
    return mensagemSeguraOutreach(parsed.mensagem, contextoOutreach, "direta");
  } catch (err) {
    debugProspeccaoErro("openai_erro", err, { fluxo: "outreach_principal", lead: contextoOutreach.nome || "" });
    debugProspeccao("fallback_ativado", { tipo: "outreach_principal", motivo: "openai_erro", lead: contextoOutreach.nome || "" });
    return mensagemSeguraOutreach("", contextoOutreach, "direta");
  }
}

async function gerarMensagemContinuidadeOutreach(lead, respostaLead = "") {
  const contextoOutreach = montarContextoOutreachLead(lead);
  const escolha = await escolherPadraoSegundaMensagemOutreach(contextoOutreach);
  const tipo = respostaLead ? "reuniao" : "direta";
  const mensagem = montarMensagemSemiFixaOutreach(escolha.pattern, contextoOutreach, tipo);
  return mensagemSeguraSegundaOutreach(mensagem, contextoOutreach, tipo);
}

// Gera 5 variacoes de segunda mensagem guiadas pelo contexto do SDR.
async function gerarVariacoesOutreach(lead) {
  const contextoOutreach = montarContextoOutreachLead(lead);
  debugProspeccao("outreach_variacoes_inicio", { id: lead?.id || "", nome: lead?.nome || "" });
  const escolha = await escolherPadraoSegundaMensagemOutreach(contextoOutreach);
  const variacoes = montarVariacoesSemiFixasOutreach(escolha.pattern, contextoOutreach);
  debugProspeccao("outreach_variacoes_ok", { id: lead?.id || "", nome: lead?.nome || "", origemPattern: escolha.origem || "" });
  return preencherVariacoesFallbackOutreach(validarVariacoesOutreach(variacoes, contextoOutreach).variacoes, contextoOutreach);
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

  outreach_legacy: `Você é o especialista em Outreach da Lumyn. Gera mensagens de primeiro contato para prospecção local via WhatsApp.

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

  outreach: `Voce e o especialista em Outreach da Lumyn. Escreve primeira mensagem de WhatsApp para prospeccao local.

OBJETIVO:
- abrir conversa
- testar interesse
- pedir permissao leve
- nunca vender de cara
- nunca pedir reuniao/call no primeiro contato

PADRAO:
- maximo 2 frases
- observacao especifica sobre o negocio
- gancho comercial ligado ao contexto recebido
- pergunta leve no final
- tom humano, sem cara de script

TOM:
- barbearia/restaurante/pizzaria/loja/pet: informal e direto
- clinica/estetica/academia/escola: leve e proximo
- advocacia/contabilidade/consultoria/imobiliaria: consultivo, sem giria

PROIBIDO:
- score, nota, avaliacoes, prioridade, SDR, analise interna
- "identifiquei"
- "analisei seu negocio"
- "estrategia de marketing"
- "aumentar visibilidade"
- "atrair mais clientes"
- "temos uma solucao"
- "poderia te ajudar a crescer"
- pedir reuniao, call, 15 minutos ou agenda direta
- mensagem generica que serviria para qualquer negocio

SE FALTAR CONTEXTO:
- ainda gere uma mensagem curta, mas com pergunta de validacao.

Use "acao":"copiar" sempre que gerar mensagem pronta para enviar.
Responda em JSON: {"resposta":"...","acao":"copiar"}`,

  analytics: `Voce e um gestor de trafego real falando no ritmo do dia a dia.

Seu trabalho e responder perguntas simples sobre Meta Ads com uma decisao pratica:
- "gastei 260 e nao vendeu"
- "pauso?"
- "subo orcamento?"
- "criativo ta ruim?"
- "publico?"
- "o que faco agora?"

TOM:
- curto, direto, humano
- sem relatorio
- sem consultoria
- sem formalidade
- sem encher linguica
- nao soe como dashboard

FORMATO PADRAO, exceto se o usuario pedir "analise completa":
leitura rápida: 1 frase sobre o que está acontecendo.
hipótese: 1 frase sobre a causa mais provável.
ação agora: 1 ação clara, executável agora.
não fazer: 1 coisa que não deve fazer agora.

MODO RAPIDO:
- maximo 4 linhas
- uma ideia por linha
- nao liste varias estrategias
- nao de aula

MODO COMPLETO:
Use apenas quando o usuario pedir "analise completa", "explica melhor", "detalha" ou algo parecido.
Ainda assim mantenha direto: leitura, dados usados, hipótese, ação, não fazer.

REGRAS DE DECISAO:
- CTR baixo -> criativo/gancho fraco
- CTR bom e sem conversao -> oferta, pagina, checkout ou pixel
- add_to_cart sem checkout -> carrinho/oferta/pagina
- checkout sem compra -> frete, pagamento, checkout ou confianca
- clique sem LPV -> pagina lenta, link ruim ou carregamento
- frequencia alta -> publico saturado ou criativo cansado
- pouco gasto, poucas impressoes ou dataQuality=dados_fracos -> nao pausar, nao escalar, nao trocar publico agressivamente
- pixel novo -> cuidado com certeza demais

QUANDO DATAQUALITY FOR dados_fracos:
- fale que a base esta fraca
- reduza certeza
- bloqueie decisao forte
- recomende manter/aguardar dados/validar rastreamento
- nunca mande pausar, duplicar, criar conjunto ou subir orcamento

PROIBIDO:
- "talvez"
- "pode ser"
- "uma possibilidade"
- resposta generica
- falar de metrica que nao veio no contexto
- sugerir varias acoes ao mesmo tempo
- usar tom de relatorio corporativo

Se faltar dado importante, diga exatamente qual dado falta.
Se a pergunta for curta, responda curta.
Se o usuario perguntar "pauso?", responda sim/nao primeiro e explique em seguida.

Responda em texto natural, nao em JSON.`,

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
const CRM_LEARNING_MIN_AMOSTRA = 5;
const CRM_LEARNING_TIPOS_MENSAGEM = new Set(["ultra_leve", "segunda_mensagem", "followup", "reuniao"]);

function numeroCRM(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function horasEntreCRM(inicio, fim) {
  if (!inicio || !fim) return null;
  const a = new Date(inicio).getTime();
  const b = new Date(fim).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round(((b - a) / 3600000) * 10) / 10;
}

function normalizarTipoMensagemLearning(tipo) {
  const t = String(tipo || "").trim();
  return CRM_LEARNING_TIPOS_MENSAGEM.has(t) ? t : "segunda_mensagem";
}

const CRM_NICHO_CANONICO_TAXONOMIAS = [
  {
    id: "estetica_automotiva",
    label: "estetica automotiva",
    termos: ["estetica automotiva", "higienizacao automotiva", "lava rapido", "polimento", "vitrificacao", "martelinho", "detailing"],
    fragmentos: ["automot", "veicul", "carro"],
  },
  {
    id: "odonto",
    label: "clinica odontologica",
    termos: ["clinica odontologica", "odontologia", "dentista", "dental", "dente", "implante", "clareamento"],
    fragmentos: ["odont", "ortodont"],
  },
  {
    id: "clinica_estetica",
    label: "clinica estetica",
    termos: ["clinica estetica", "clinica", "estetica", "esteticista", "harmonizacao", "botox", "depilacao", "laser", "sobrancelha", "spa", "massagem"],
    fragmentos: ["estetic"],
  },
  {
    id: "barbearia",
    label: "barbearia",
    termos: ["barbearia", "barbeiro", "barber", "salao", "salao de beleza", "manicure"],
  },
  {
    id: "restaurante",
    label: "restaurante e delivery",
    termos: ["pizzaria", "restaurante", "delivery", "lanchonete", "comida", "bar"],
    fragmentos: ["hamburg", "marmit"],
  },
  {
    id: "academia",
    label: "academia e fitness",
    termos: ["academia", "fitness", "pilates", "crossfit", "personal", "treino funcional", "sala de fitness"],
  },
  {
    id: "pet",
    label: "pet e veterinaria",
    termos: ["pet shop", "veterinaria", "veterinario", "banho e tosa"],
    fragmentos: ["veterin"],
  },
  {
    id: "advocacia",
    label: "advocacia",
    termos: ["advocacia", "advogado", "advogada", "juridico"],
  },
  {
    id: "contabilidade",
    label: "contabilidade",
    termos: ["contabilidade", "contador", "contabil"],
    fragmentos: ["contabil"],
  },
  {
    id: "profissional",
    label: "servico profissional",
    termos: ["consultoria", "imobiliaria", "arquitetura", "corretor"],
  },
  {
    id: "loja",
    label: "loja local",
    termos: ["loja", "boutique", "moda", "roupa", "calcado", "moveis", "otica", "farmacia", "mercado"],
  },
];

function classificarNichoCanonicoLead(lead = {}) {
  const texto = removerAcentos([
    lead.nome,
    lead.categoria,
    lead.categoriaGoogle,
    lead.endereco,
    lead.anguloAbordagem,
  ].filter(Boolean).join(" ")).toLowerCase();

  const termoRegex = (termo) => {
    const escaped = String(termo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  };
  const temTermo = (termos = []) => termos.some((termo) => termoRegex(removerAcentos(termo).toLowerCase()).test(texto));
  const temFragmento = (termos = []) => termos.some((termo) => texto.includes(removerAcentos(termo).toLowerCase()));
  const taxonomia = CRM_NICHO_CANONICO_TAXONOMIAS.find((item) => temTermo(item.termos) || temFragmento(item.fragmentos));

  if (taxonomia) return { id: taxonomia.id, label: taxonomia.label };
  return { id: "generico", label: "nicho pouco claro" };
}

function normalizarMensagensUsadasCRM(lead = {}) {
  const eventos = Array.isArray(lead.mensagensUsadas) ? lead.mensagensUsadas : [];
  const normalizados = eventos
    .map(ev => ({
      tipo: normalizarTipoMensagemLearning(ev.tipo || ev.etapa),
      etapa: normalizarTipoMensagemLearning(ev.etapa || ev.tipo),
      variacao: String(ev.variacao || "").trim(),
      texto: String(ev.texto || "").trim(),
      enviadoEm: ev.enviadoEm || ev.criadoEm || null,
      patternId: ev.patternId || lead.outreachPatternId || "",
    }))
    .filter(ev => ev.tipo && (ev.texto || ev.enviadoEm));

  if (!normalizados.length && lead.mensagemInicial && lead.primeiraMensagemEnviadaEm) {
    normalizados.push({
      tipo: "ultra_leve",
      etapa: "ultra_leve",
      variacao: lead.tipoMensagemInicial || "",
      texto: lead.mensagemInicial,
      enviadoEm: lead.primeiraMensagemEnviadaEm,
      patternId: "",
    });
  }
  if (lead.mensagemFollowUp && lead.followUpEnviadoEm && !normalizados.some(ev => ev.tipo === "followup")) {
    normalizados.push({
      tipo: "followup",
      etapa: "followup",
      variacao: "followup",
      texto: lead.mensagemFollowUp,
      enviadoEm: lead.followUpEnviadoEm,
      patternId: lead.outreachPatternId || "",
    });
  }
  return normalizados.slice(-30);
}

function resultadoComercialCRM(lead = {}) {
  const status = lead.status || "";
  if (status === "fechado") return "fechado";
  if (status === "perdido") return "perdido";
  if (lead.virouReuniao || status === "reuniao" || status === "proposta") return "reuniao";
  if (lead.respondeu || status === "conversando" || status === "respondeu") return "respondeu";
  if (lead.primeiraMensagemEnviadaEm || lead.mensagemInicial || ["abordado", "follow_up"].includes(status)) return "sem_resposta";
  return "sem_contato";
}

function sinalScoreResultadoCRM(lead = {}) {
  const score = numeroCRM(lead.score);
  const resultado = resultadoComercialCRM(lead);
  if (score === null || resultado === "sem_contato") return "dados_insuficientes";
  const positivo = ["respondeu", "reuniao", "fechado"].includes(resultado);
  if (score >= 75 && positivo) return "score_alto_com_sinal_positivo";
  if (score >= 75 && ["sem_resposta", "perdido"].includes(resultado)) return "score_alto_sem_retorno";
  if (score < 60 && positivo) return "score_baixo_com_sinal_positivo";
  return "neutro";
}

function normalizarLeadCRM(lead = {}) {
  const status = lead.status || "novo";
  const respondeu = !!(lead.respondeu || status === "respondeu" || status === "conversando");
  const virouReuniao = !!(lead.virouReuniao || status === "reuniao" || status === "proposta" || status === "fechado");
  const primeiraMensagemEnviadaEm = lead.primeiraMensagemEnviadaEm || null;
  const respondeuEm = lead.respondeuEm || null;
  const reuniaoEm = lead.reuniaoEm || null;
  const tempoAteRespostaHoras = numeroCRM(lead.tempoAteRespostaHoras) ?? horasEntreCRM(primeiraMensagemEnviadaEm, respondeuEm);
  const tempoAteReuniaoHoras = numeroCRM(lead.tempoAteReuniaoHoras) ?? horasEntreCRM(primeiraMensagemEnviadaEm, reuniaoEm);
  const categoriaGoogle = lead.categoriaGoogle || lead.categoria || "";
  const nichoCanonico = classificarNichoCanonicoLead({ ...lead, categoriaGoogle });

  const normalizado = {
    ...lead,
    status,
    categoriaGoogle,
    nichoCanonico: nichoCanonico.id,
    nichoLabel: nichoCanonico.label,
    statusConversa: lead.statusConversa ?? null,
    ultimoMovimento: lead.ultimoMovimento ?? null,
    ultimaInteracaoEm: lead.ultimaInteracaoEm || null,
    needsFollowUp: !!lead.needsFollowUp,
    respondeu,
    usouFollowUp: !!lead.usouFollowUp,
    virouReuniao,
    estagioFinal: lead.estagioFinal || status,
    nicho: lead.nicho || nichoCanonico.label || lead.categoria || "",
    score: numeroCRM(lead.score),
    scoreConfianca: numeroCRM(lead.scoreConfianca),
    scoreVersion: lead.scoreVersion || null,
    scoreBreakdown: lead.scoreBreakdown || null,
    anguloAbordagem: lead.anguloAbordagem || "",
    contextoAbordagem: lead.contextoAbordagem || "",
    gatilhoConversacional: lead.gatilhoConversacional || "",
    tipoMensagemInicial: lead.tipoMensagemInicial || "",
    mensagemInicial: lead.mensagemInicial || "",
    mensagemFollowUp: lead.mensagemFollowUp || lead.followUp || "",
    followUp: lead.followUp || lead.mensagemFollowUp || "",
    primeiraMensagemEnviadaEm,
    followUpEnviadoEm: lead.followUpEnviadoEm || null,
    respondeuEm,
    reuniaoEm,
    perdidoEm: lead.perdidoEm || null,
    learningTags: Array.isArray(lead.learningTags) ? lead.learningTags : [],
    motivoPerda: lead.motivoPerda || "",
    outreachPatternId: lead.outreachPatternId || "",
    outreachVariationUsada: lead.outreachVariationUsada || "",
    ultimaMensagemTipo: lead.ultimaMensagemTipo || "",
    tempoAteRespostaHoras,
    tempoAteReuniaoHoras,
  };
  normalizado.mensagensUsadas = normalizarMensagensUsadasCRM(normalizado);
  normalizado.resultadoComercial = resultadoComercialCRM(normalizado);
  normalizado.sinalScoreResultado = sinalScoreResultadoCRM(normalizado);
  return normalizado;
}

function normalizarCRMData(crm = { leads: [] }) {
  const leads = (crm.leads || []).map(normalizarLeadCRM);
  leads.sort((a, b) => (new Date(b.atualizadoEm || b.criadoEm || 0) - new Date(a.atualizadoEm || a.criadoEm || 0)));
  return { ...crm, leads };
}

function leadCRMAbordado(lead = {}) {
  return !!(
    lead.primeiraMensagemEnviadaEm ||
    lead.mensagemInicial ||
    ["abordado", "follow_up", "conversando", "respondeu", "reuniao", "proposta", "fechado", "perdido"].includes(lead.status)
  );
}

function taxaCRM(valor, total) {
  if (!total) return 0;
  return Math.round((valor / total) * 1000) / 10;
}

function scoreRangeCRM(score) {
  const n = numeroCRM(score);
  if (n === null) return "sem_score";
  if (n < 40) return "0-39";
  if (n < 60) return "40-59";
  if (n < 75) return "60-74";
  if (n < 90) return "75-89";
  return "90-100";
}

function criarStatsLearning(chave) {
  return {
    chave,
    leads: 0,
    abordados: 0,
    respostas: 0,
    reunioes: 0,
    fechados: 0,
    perdidos: 0,
    followups: 0,
    taxaResposta: 0,
    taxaReuniao: 0,
    taxaFechamento: 0,
    dadosInsuficientes: true,
  };
}

function adicionarLeadStatsLearning(stats, lead) {
  stats.leads += 1;
  if (leadCRMAbordado(lead)) stats.abordados += 1;
  if (lead.respondeu || ["conversando", "respondeu", "reuniao", "proposta", "fechado"].includes(lead.status)) stats.respostas += 1;
  if (lead.virouReuniao || ["reuniao", "proposta", "fechado"].includes(lead.status)) stats.reunioes += 1;
  if (lead.status === "fechado") stats.fechados += 1;
  if (lead.status === "perdido") stats.perdidos += 1;
  if (lead.usouFollowUp || lead.followUpEnviadoEm) stats.followups += 1;
}

function finalizarStatsLearning(stats) {
  stats.taxaResposta = taxaCRM(stats.respostas, stats.abordados);
  stats.taxaReuniao = taxaCRM(stats.reunioes, stats.abordados);
  stats.taxaFechamento = taxaCRM(stats.fechados, stats.abordados);
  stats.dadosInsuficientes = stats.abordados < CRM_LEARNING_MIN_AMOSTRA;
  return stats;
}

function agruparLearningPorLead(leads, obterChave) {
  const mapa = new Map();
  leads.forEach(lead => {
    const valor = obterChave(lead);
    const meta = valor && typeof valor === "object" ? valor : {};
    const chaveBase = meta.chave || meta.nichoLabel || meta.label || meta.id || valor;
    const chave = String(chaveBase || "nao informado").trim() || "nao informado";
    if (!mapa.has(chave)) mapa.set(chave, criarStatsLearning(chave));
    if (meta && typeof meta === "object") {
      Object.assign(mapa.get(chave), meta, { chave });
    }
    adicionarLeadStatsLearning(mapa.get(chave), lead);
  });
  return Array.from(mapa.values())
    .map(finalizarStatsLearning)
    .sort((a, b) => b.abordados - a.abordados || b.taxaResposta - a.taxaResposta)
    .slice(0, 12);
}

function agruparLearningPorMensagem(leads, obterChave) {
  const mapa = new Map();
  leads.forEach(lead => {
    const eventos = Array.isArray(lead.mensagensUsadas) ? lead.mensagensUsadas : [];
    const chaves = new Set(eventos.map(obterChave).filter(Boolean));
    if (!chaves.size && lead.ultimaMensagemTipo) chaves.add(lead.ultimaMensagemTipo);
    chaves.forEach(chave => {
      const key = String(chave || "nao informado").trim() || "nao informado";
      if (!mapa.has(key)) mapa.set(key, criarStatsLearning(key));
      adicionarLeadStatsLearning(mapa.get(key), lead);
    });
  });
  return Array.from(mapa.values())
    .map(finalizarStatsLearning)
    .sort((a, b) => b.abordados - a.abordados || b.taxaResposta - a.taxaResposta)
    .slice(0, 12);
}

function recomendacoesLearningCRM({ resumo, porNicho, porAngulo, porTipoMensagem }) {
  const recomendacoes = [];
  const avisos = [];
  const grupos = [
    { nome: "nicho", lista: porNicho },
    { nome: "angulo", lista: porAngulo },
    { nome: "tipoMensagem", lista: porTipoMensagem },
  ];

  grupos.forEach(({ nome, lista }) => {
    const validos = lista.filter(item => !item.dadosInsuficientes);
    if (!validos.length) {
      avisos.push(`${nome}: dados insuficientes (minimo ${CRM_LEARNING_MIN_AMOSTRA} leads abordados)`);
      return;
    }
    const melhorResposta = validos[0];
    if (melhorResposta && melhorResposta.taxaResposta >= Math.max(20, resumo.taxaResposta + 5)) {
      recomendacoes.push(`${nome} "${melhorResposta.chave}" respondeu acima da media (${melhorResposta.taxaResposta}%).`);
    }
    const melhorReuniao = [...validos].sort((a, b) => b.taxaReuniao - a.taxaReuniao)[0];
    if (melhorReuniao && melhorReuniao.taxaReuniao >= Math.max(10, resumo.taxaReuniao + 3)) {
      recomendacoes.push(`${nome} "${melhorReuniao.chave}" gerou mais reunioes (${melhorReuniao.taxaReuniao}%).`);
    }
  });

  if (!recomendacoes.length) {
    avisos.push(`dados insuficientes para recomendacoes confiaveis; use pelo menos ${CRM_LEARNING_MIN_AMOSTRA} leads abordados por grupo.`);
  }
  return { recomendacoes: recomendacoes.slice(0, 6), avisos: Array.from(new Set(avisos)).slice(0, 6) };
}

function calcularCRMLearning(leads = []) {
  const normalizados = leads.map(normalizarLeadCRM);
  const abordados = normalizados.filter(leadCRMAbordado);
  const respostas = normalizados.filter(l => l.respondeu || ["conversando", "respondeu", "reuniao", "proposta", "fechado"].includes(l.status));
  const reunioes = normalizados.filter(l => l.virouReuniao || ["reuniao", "proposta", "fechado"].includes(l.status));
  const fechados = normalizados.filter(l => l.status === "fechado");
  const perdidos = normalizados.filter(l => l.status === "perdido");
  const temposResposta = normalizados.map(l => numeroCRM(l.tempoAteRespostaHoras)).filter(n => n !== null);
  const tempoMedioRespostaHoras = temposResposta.length
    ? Math.round((temposResposta.reduce((a, b) => a + b, 0) / temposResposta.length) * 10) / 10
    : null;

  const resumo = {
    totalLeads: normalizados.length,
    abordados: abordados.length,
    responderam: respostas.length,
    reunioes: reunioes.length,
    fechados: fechados.length,
    perdidos: perdidos.length,
    taxaResposta: taxaCRM(respostas.length, abordados.length),
    taxaReuniao: taxaCRM(reunioes.length, abordados.length),
    taxaFechamento: taxaCRM(fechados.length, abordados.length),
    tempoMedioRespostaHoras,
    amostraMinima: CRM_LEARNING_MIN_AMOSTRA,
  };

  const porNicho = agruparLearningPorLead(normalizados, l => ({
    chave: l.nichoLabel || l.nichoCanonico || l.nicho || l.categoria,
    nichoCanonico: l.nichoCanonico || "",
    nichoLabel: l.nichoLabel || "",
  }));
  const porAngulo = agruparLearningPorLead(normalizados, l => l.anguloAbordagem || "sem angulo");
  const porScoreRange = agruparLearningPorLead(normalizados, l => scoreRangeCRM(l.score));
  const porTipoMensagem = agruparLearningPorMensagem(normalizados, ev => ev.tipo || ev.etapa);
  const porPatternOutreach = agruparLearningPorMensagem(normalizados, ev => ev.patternId);
  const sinaisScoreResultado = agruparLearningPorLead(normalizados, l => l.sinalScoreResultado);
  const { recomendacoes, avisos } = recomendacoesLearningCRM({ resumo, porNicho, porAngulo, porTipoMensagem });

  return {
    ok: true,
    resumo,
    porNicho,
    porAngulo,
    porScoreRange,
    porTipoMensagem,
    porPatternOutreach,
    sinaisScoreResultado,
    recomendacoes,
    avisos,
  };
}

function dataReferenciaRadarCRM(lead = {}) {
  const candidatos = [
    lead.primeiraMensagemEnviadaEm,
    lead.ultimaInteracaoEm,
    lead.atualizadoEm,
    lead.criadoEm,
  ];
  for (const valor of candidatos) {
    if (!valor) continue;
    const ts = new Date(valor).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function criarStatsRadarSDR(meta = {}) {
  return {
    nichoCanonico: meta.nichoCanonico || "",
    nichoLabel: meta.nichoLabel || meta.chave || "nicho pouco claro",
    chave: meta.chave || meta.nichoLabel || meta.nichoCanonico || "nicho pouco claro",
    leads: 0,
    abordados: 0,
    conversando: 0,
    reunioes: 0,
    fechados: 0,
    perdidos: 0,
    followupsPendentes: 0,
    taxaResposta: 0,
    taxaReuniao: 0,
    statusAmostra: "dados_insuficientes",
    sinal: "insuficiente",
    motivo: "",
    sugestaoBusca: "",
    pontuacaoRadar: 0,
  };
}

function finalizarStatsRadarSDR(stats, resumoBase) {
  stats.taxaResposta = taxaCRM(stats.conversando, stats.abordados);
  stats.taxaReuniao = taxaCRM(stats.reunioes, stats.abordados);
  stats.statusAmostra = stats.abordados >= CRM_LEARNING_MIN_AMOSTRA ? "amostra_ok" : "dados_insuficientes";

  const taxaPerda = taxaCRM(stats.perdidos, stats.abordados);
  stats.pontuacaoRadar = stats.statusAmostra === "amostra_ok"
    ? Math.round((
      (stats.taxaResposta * 0.45) +
      (stats.taxaReuniao * 0.35) +
      (Math.min(stats.abordados, 20) * 0.6) +
      (stats.fechados * 4) -
      (stats.followupsPendentes * 1.5) -
      (taxaPerda * 0.15)
    ) * 10) / 10
    : Math.min(stats.abordados, CRM_LEARNING_MIN_AMOSTRA - 1);

  if (stats.statusAmostra !== "amostra_ok") {
    stats.sinal = "insuficiente";
    stats.motivo = `dados insuficientes (${stats.abordados}/${CRM_LEARNING_MIN_AMOSTRA} abordados)`;
  } else if (stats.reunioes > 0 || stats.taxaReuniao >= Math.max(8, resumoBase.taxaReuniao + 2)) {
    stats.sinal = "quente";
    stats.motivo = "gerou reuniao ou sinal forte no periodo";
  } else if (stats.taxaResposta >= Math.max(15, resumoBase.taxaResposta)) {
    stats.sinal = "promissor";
    stats.motivo = "boa taxa de resposta recente";
  } else if (stats.followupsPendentes >= Math.max(2, Math.ceil(stats.abordados * 0.35))) {
    stats.sinal = "cuidado";
    stats.motivo = "muito follow-up pendente, abordar com cuidado";
  } else {
    stats.sinal = "estavel";
    stats.motivo = "base abordada sem pico claro ainda";
  }

  stats.sugestaoBusca = `${stats.nichoLabel || stats.chave} em `;
  return stats;
}

function calcularRadarSDR(leads = [], opcoes = {}) {
  const janelaDiasRaw = Number(opcoes.janelaDias);
  const janelaDias = [1, 7, 30].includes(janelaDiasRaw) ? janelaDiasRaw : 7;
  const agora = Date.now();
  const inicioJanela = agora - (janelaDias * 24 * 60 * 60 * 1000);
  const normalizados = leads.map(normalizarLeadCRM);
  const noPeriodo = normalizados.filter((lead) => {
    const ref = dataReferenciaRadarCRM(lead);
    return ref && ref >= inicioJanela && ref <= agora;
  });

  const abordados = noPeriodo.filter(leadCRMAbordado);
  const conversando = noPeriodo.filter(l => l.respondeu || ["conversando", "respondeu", "reuniao", "proposta", "fechado"].includes(l.status));
  const reunioes = noPeriodo.filter(l => l.virouReuniao || ["reuniao", "proposta", "fechado"].includes(l.status));
  const fechados = noPeriodo.filter(l => l.status === "fechado");
  const perdidos = noPeriodo.filter(l => l.status === "perdido");
  const followupsPendentes = noPeriodo.filter(l => l.needsFollowUp);

  const resumo = {
    totalLeads: noPeriodo.length,
    abordados: abordados.length,
    conversando: conversando.length,
    reunioes: reunioes.length,
    fechados: fechados.length,
    perdidos: perdidos.length,
    followupsPendentes: followupsPendentes.length,
    taxaResposta: taxaCRM(conversando.length, abordados.length),
    taxaReuniao: taxaCRM(reunioes.length, abordados.length),
    amostraMinima: CRM_LEARNING_MIN_AMOSTRA,
  };

  const mapa = new Map();
  noPeriodo.forEach((lead) => {
    const chave = lead.nichoCanonico || lead.nichoLabel || lead.nicho || lead.categoria || "generico";
    if (!mapa.has(chave)) {
      mapa.set(chave, criarStatsRadarSDR({
        chave,
        nichoCanonico: lead.nichoCanonico || "",
        nichoLabel: lead.nichoLabel || lead.nicho || lead.categoria || "nicho pouco claro",
      }));
    }
    const stats = mapa.get(chave);
    stats.leads += 1;
    if (leadCRMAbordado(lead)) stats.abordados += 1;
    if (lead.respondeu || ["conversando", "respondeu", "reuniao", "proposta", "fechado"].includes(lead.status)) stats.conversando += 1;
    if (lead.virouReuniao || ["reuniao", "proposta", "fechado"].includes(lead.status)) stats.reunioes += 1;
    if (lead.status === "fechado") stats.fechados += 1;
    if (lead.status === "perdido") stats.perdidos += 1;
    if (lead.needsFollowUp) stats.followupsPendentes += 1;
  });

  const grupos = Array.from(mapa.values())
    .map(stats => finalizarStatsRadarSDR(stats, resumo))
    .sort((a, b) => b.pontuacaoRadar - a.pontuacaoRadar || b.abordados - a.abordados || b.taxaResposta - a.taxaResposta);

  const topNichos = grupos.slice(0, 5);
  const alertas = [];
  if (!noPeriodo.length) alertas.push("sem historico no periodo selecionado");
  if (noPeriodo.length && !topNichos.some(item => item.statusAmostra === "amostra_ok")) {
    alertas.push(`dados insuficientes por nicho; use ao menos ${CRM_LEARNING_MIN_AMOSTRA} abordados por grupo`);
  }
  if (followupsPendentes.length) alertas.push(`${followupsPendentes.length} lead(s) precisam de follow-up`);

  const sugestoes = topNichos
    .filter(item => item.statusAmostra === "amostra_ok" && ["quente", "promissor"].includes(item.sinal))
    .slice(0, 3)
    .map(item => `prospectar ${item.nichoLabel}`);

  return {
    ok: true,
    janelaDias,
    geradoEm: new Date().toISOString(),
    resumo,
    topNichos,
    alertas,
    sugestoes,
  };
}

async function lerCRM() {
  debugProspeccao("crm_leitura_inicio", { fonte: supabase ? "supabase" : "arquivo_local" });
  if (supabase) {
    // Tenta ler com ordem se a coluna existir, senão sem ordem
    let query = supabase.from("leads").select("*");
    const { data, error } = await query;
    if (error) {
      debugProspeccaoErro("crm_leitura_erro", error, { fonte: "supabase" });
      debugProspeccao("fallback_ativado", { tipo: "crm_arquivo_local", motivo: "supabase_erro" });
      console.error("[CRM] Erro ao ler Supabase:", error.message, "— usando arquivo local como fallback");
      // fallback para arquivo local se Supabase falhar
      try {
        if (!fs.existsSync(CRM_FILE)) return { leads: [] };
        const local = normalizarCRMData(JSON.parse(fs.readFileSync(CRM_FILE, "utf8")));
        debugProspeccao("crm_leitura_ok", { fonte: "arquivo_local_fallback", total: local.leads.length });
        return local;
      } catch (err) {
        debugProspeccaoErro("crm_leitura_erro", err, { fonte: "arquivo_local_fallback" });
        return { leads: [] };
      }
    }
    // Ordena no JS se tiver dados
    const leads = (data || []).map(r => r.dados);
    const crm = normalizarCRMData({ leads });
    debugProspeccao("crm_leitura_ok", { fonte: "supabase", total: crm.leads.length });
    return crm;
  }
  try {
    debugProspeccao("fallback_ativado", { tipo: "crm_arquivo_local", motivo: "supabase_indisponivel" });
    if (!fs.existsSync(CRM_FILE)) return { leads: [] };
    const crm = normalizarCRMData(JSON.parse(fs.readFileSync(CRM_FILE, "utf8")));
    debugProspeccao("crm_leitura_ok", { fonte: "arquivo_local", total: crm.leads.length });
    return crm;
  } catch (err) {
    debugProspeccaoErro("crm_leitura_erro", err, { fonte: "arquivo_local" });
    return { leads: [] };
  }
}

async function salvarLead(lead) {
  const leadNormalizado = normalizarLeadCRM(lead);
  debugProspeccao("crm_salvamento_inicio", { id: leadNormalizado.id, nome: leadNormalizado.nome || "", fonte: supabase ? "supabase" : "arquivo_local" });
  if (supabase) {
    const { error } = await supabase.from("leads").upsert({ id: leadNormalizado.id, dados: leadNormalizado });
    if (error) {
      debugProspeccaoErro("crm_salvamento_erro", error, { id: leadNormalizado.id, fonte: "supabase" });
      console.error("[CRM] Erro ao salvar lead:", error.message);
    } else {
      debugProspeccao("crm_salvamento_ok", { id: leadNormalizado.id, fonte: "supabase" });
    }
    return;
  }
  // fallback local
  try {
    debugProspeccao("fallback_ativado", { tipo: "crm_arquivo_local", motivo: "salvar_sem_supabase" });
    const crm = fs.existsSync(CRM_FILE) ? JSON.parse(fs.readFileSync(CRM_FILE, "utf8")) : { leads: [] };
    const idx = crm.leads.findIndex(l => l.id === leadNormalizado.id);
    if (idx >= 0) crm.leads[idx] = leadNormalizado; else crm.leads.unshift(leadNormalizado);
    fs.writeFileSync(CRM_FILE, JSON.stringify(crm, null, 2), "utf8");
    debugProspeccao("crm_salvamento_ok", { id: leadNormalizado.id, fonte: "arquivo_local", total: crm.leads.length });
  } catch (e) {
    debugProspeccaoErro("crm_salvamento_erro", e, { id: leadNormalizado.id, fonte: "arquivo_local" });
    console.error("[CRM] Erro fallback local:", e.message);
  }
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
  debugProspeccao("google_maps_chamada", { endpoint: "places:searchText", modo: "buscar", ...debugProspeccaoNichoLocal(query) });

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
  debugProspeccao("google_maps_resposta", { modo: "buscar", status: response.status, quantidade: Array.isArray(data.places) ? data.places.length : 0 });
  if (data.error) debugProspeccaoErro("google_maps_erro", data.error, { modo: "buscar", status: response.status });

  if (!data.places) return [];

  return data.places;
}

async function buscarDetalhes(placeId) {
  console.log("[DETALHES]:", placeId);
  debugProspeccao("google_maps_chamada", { endpoint: "places/{placeId}", modo: "detalhes", placeId });

  const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_API_KEY,
      "X-Goog-FieldMask":
        "displayName,formattedAddress,rating,userRatingCount,websiteUri,nationalPhoneNumber,googleMapsUri,primaryTypeDisplayName,businessStatus",
    },
  });

  const data = await response.json();
  debugProspeccao("google_maps_resposta", { modo: "detalhes", status: response.status, placeId, temNome: !!data?.displayName?.text });
  if (data.error) debugProspeccaoErro("google_maps_erro", data.error, { modo: "detalhes", status: response.status, placeId });
  return data;
}

async function buscarLugaresLeadsPagina(query, pageToken = null) {
  const body = { textQuery: query, languageCode: "pt-BR", maxResultCount: 20 };
  if (pageToken) body.pageToken = pageToken;
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName,places.googleMapsUri,places.businessStatus",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.error) {
    console.warn("[LEADS BUSCA] Google API error:", data.error.message || JSON.stringify(data.error));
    return { places: [], nextPageToken: null };
  }
  return { places: data.places || [], nextPageToken: data.nextPageToken || null };
}

async function buscarLugaresLeads(query) {
  console.log("[LEADS BUSCA]:", query);
  debugProspeccao("google_maps_chamada", { endpoint: "places:searchText", modo: "leads_inicio", ...debugProspeccaoNichoLocal(query) });

  const tentativas = [query];
  if (!query.toLowerCase().includes("brasil") && !query.match(/,\s*[A-Z]{2}$/i)) {
    tentativas.push(query + ", Brasil");
  }

  for (const tentativa of tentativas) {
    try {
      debugProspeccao("google_maps_tentativa", { tentativa, ...debugProspeccaoNichoLocal(tentativa) });
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_API_KEY,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName,places.googleMapsUri,places.businessStatus",
        },
        body: JSON.stringify({
          textQuery: tentativa,
          languageCode: "pt-BR",
          maxResultCount: 20,
        }),
      });
      const data = await response.json();
      debugProspeccao("google_maps_resposta", {
        modo: "leads",
        tentativa,
        status: response.status,
        quantidade: Array.isArray(data.places) ? data.places.length : 0,
      });
      if (data.error) {
        debugProspeccaoErro("google_maps_erro", data.error, { modo: "leads", tentativa, status: response.status });
        console.warn("[LEADS BUSCA] Google API error:", data.error.message || JSON.stringify(data.error));
        break;
      }
      if (data.places && data.places.length > 0) return data.places;
    } catch (e) {
      debugProspeccaoErro("google_maps_excecao", e, { modo: "leads", tentativa });
      console.warn("[LEADS BUSCA] erro na tentativa:", e.message);
    }
  }
  debugProspeccao("google_maps_sem_resultado", { modo: "leads", tentativas: tentativas.length });
  return [];
}

function gerarVariantesQuery(query) {
  const variantes = new Set([query]);
  const partes = query.split(/\s+em\s+|\s+no?\s+|\s+na\s+/i);
  const nicho = partes[0]?.trim() || query;
  const local = partes[1]?.trim() || "";
  if (local) {
    variantes.add(`${nicho} em ${local}, Brasil`);
    variantes.add(`${nicho} ${local}`);
  } else if (!/,\s*\w/.test(query) && !/brasil/i.test(query)) {
    variantes.add(query + ", Brasil");
    variantes.add(query + " centro");
  }
  return [...variantes].slice(0, 3);
}

async function buscarLugaresLeadsParalelo(query) {
  // Chamada principal — função original intacta, retorna array
  const placesPrimario = await buscarLugaresLeads(query);
  const idsSeen = new Set();
  const placesUnicos = [];

  for (const place of placesPrimario) {
    if (place.id && !idsSeen.has(place.id)) {
      idsSeen.add(place.id);
      placesUnicos.push(place);
    }
  }

  // Variantes extras só se a principal funcionou
  if (placesPrimario.length > 0) {
    const variantesExtras = gerarVariantesQuery(query).slice(1);
    if (variantesExtras.length > 0) {
      debugProspeccao("leads_variantes_query", { query, variantesExtras });
      const extras = await Promise.allSettled(variantesExtras.map(v => buscarLugaresLeadsPagina(v)));
      for (const r of extras) {
        if (r.status === "fulfilled") {
          for (const place of r.value.places) {
            if (place.id && !idsSeen.has(place.id)) {
              idsSeen.add(place.id);
              placesUnicos.push(place);
            }
          }
        }
      }
    }
  }

  debugProspeccao("leads_variantes_merge", { totalPrimario: placesPrimario.length, totalUnicos: placesUnicos.length });
  return placesUnicos;
}

async function geocodificarCidadeOSM(cidade) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cidade)}&format=json&limit=1&countrycodes=br`;
    const res = await fetch(url, { headers: { "User-Agent": "Lumyn/1.0 (app)" } });
    const data = await res.json();
    debugProspeccao("osm_geocode_resposta", { cidade, status: res.status, quantidade: Array.isArray(data) ? data.length : 0 });
    if (!data.length) return null;
    const { boundingbox } = data[0];
    return {
      south: parseFloat(boundingbox[0]),
      north: parseFloat(boundingbox[1]),
      west:  parseFloat(boundingbox[2]),
      east:  parseFloat(boundingbox[3]),
    };
  } catch (err) {
    debugProspeccaoErro("osm_geocode_erro", err, { cidade });
    return null;
  }
}

async function buscarLugaresLeadsFallback(busca) {
  console.log("[LEADS OSM]:", busca);
  debugProspeccao("fallback_ativado", { tipo: "osm", busca });

  const match = busca.match(/^(.+?)\s+em\s+(.+)$/i);
  const categoria = match ? match[1].trim() : busca;
  const cidade    = match ? match[2].trim() : "";

  let bbox = null;
  if (cidade) {
    bbox = await geocodificarCidadeOSM(cidade);
    if (!bbox) bbox = await geocodificarCidadeOSM(cidade + ", Brasil");
  }
  if (!bbox) {
    debugProspeccao("fallback_osm_sem_bbox", { cidade });
    console.warn("[LEADS OSM] Não foi possível geocodificar:", cidade);
    return [];
  }

  const { south, north, west, east } = bbox;
  const overpassQuery = `[out:json][timeout:15];(nwr["name"](${south},${west},${north},${east}););out body 40;`;

  try {
    debugProspeccao("osm_overpass_chamada", { categoria, cidade });
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: "data=" + encodeURIComponent(overpassQuery),
    });
    const data = await res.json();
    debugProspeccao("osm_overpass_resposta", { status: res.status, quantidade: Array.isArray(data.elements) ? data.elements.length : 0 });
    if (!data.elements || !data.elements.length) return [];

    const catNorm = removerAcentos(categoria).toLowerCase();
    const filtrados = data.elements.filter((el) => {
      if (!el.tags?.name) return false;
      const nome = removerAcentos(el.tags.name).toLowerCase();
      const amenity = removerAcentos(el.tags?.amenity || el.tags?.shop || el.tags?.leisure || "").toLowerCase();
      return nome.includes(catNorm) || amenity.includes(catNorm);
    });

    const fonte = filtrados.length > 0 ? filtrados : data.elements.filter((el) => el.tags?.name);

    const normalizados = fonte.slice(0, 20).map((el) => ({
      id: String(el.id),
      displayName: { text: el.tags?.name || "Sem nome" },
      formattedAddress: [el.tags?.["addr:street"], el.tags?.["addr:city"] || cidade].filter(Boolean).join(", "),
      nationalPhoneNumber: el.tags?.phone || el.tags?.["contact:phone"] || null,
      websiteUri: el.tags?.website || el.tags?.["contact:website"] || null,
      googleMapsUri: null,
      businessStatus: "OPERATIONAL",
      rating: null,
      userRatingCount: null,
      primaryTypeDisplayName: { text: el.tags?.amenity || el.tags?.shop || categoria },
    }));
    debugProspeccao("osm_dados_normalizados", { quantidade: normalizados.length });
    return normalizados;
  } catch (e) {
    debugProspeccaoErro("osm_overpass_erro", e, { categoria, cidade });
    console.warn("[LEADS OSM] Overpass error:", e.message);
    return [];
  }
}

function classificarLead(nota, avaliacoes, temSite) {
  if (!nota || !avaliacoes) return "BAIXA";
  if (avaliacoes > 300 && nota > 4.3 && temSite) return "DESCARTE";
  if (avaliacoes > 300) return "BAIXA";
  if (avaliacoes < 20) return "ALTA";
  if (avaliacoes <= 150 && nota >= 3.0 && nota <= 4.3) return "ALTA";
  return "MEDIA";
}

function removerAcentos(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function contemTermo(texto, termos) {
  return termos.some((termo) => texto.includes(termo));
}

function limitarNumero(valor, min, max) {
  return Math.max(min, Math.min(max, valor));
}

function scoreLeadV2(lead = {}) {
  const texto = removerAcentos([
    lead.nome,
    lead.categoria,
    lead.endereco,
  ].filter(Boolean).join(" ")).toLowerCase();

  const notaRaw = Number(lead.nota);
  const avaliacoesRaw = Number(lead.avaliacoes);
  const nota = Number.isFinite(notaRaw) ? notaRaw : 0;
  const avaliacoes = Number.isFinite(avaliacoesRaw) ? avaliacoesRaw : 0;
  const temNota = nota > 0;
  const temAvaliacoes = avaliacoes > 0;
  const temTelefone = Boolean(String(lead.telefone || "").trim());
  const temSite = Boolean(lead.site);
  const prioridadeBase = normalizarPrioridadeAnalise(lead.prioridade)
    || classificarLead(nota, avaliacoes, temSite);

  const sinaisFortes = [];
  const sinaisFracos = [];
  const adicionarSinal = (lista, sinal) => {
    if (sinal && !lista.includes(sinal)) lista.push(sinal);
  };

  const termoRegex = (termo) => {
    const escaped = String(termo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  };
  const temTermo = (termos) => termos.some((termo) => termoRegex(removerAcentos(termo).toLowerCase()).test(texto));
  const temFragmento = (termos) => termos.some((termo) => texto.includes(removerAcentos(termo).toLowerCase()));

  const marcasConsolidadas = [
    "smart fit", "bodytech", "mcdonald", "mc donald", "burger king",
    "subway", "boticario", "cacau show", "magazine luiza", "casas bahia",
    "renner", "riachuelo", "americanas", "drogasil", "pague menos",
  ];

  const taxonomias = [
    {
      id: "estetica_automotiva",
      label: "estetica automotiva",
      peso: 14,
      termos: ["estetica automotiva", "detailing", "detail", "lava rapido", "higienizacao automotiva", "polimento", "vitrificacao", "martelinho"],
      angulos: ["servicos de alto valor e recorrencia local", "orcamentos de servicos pelo WhatsApp", "confianca local para cuidados automotivos"],
    },
    {
      id: "odonto",
      label: "clinica odontologica",
      peso: 16,
      termos: ["odont", "dentista", "dental", "ortodont", "implante", "clareamento", "sorriso"],
      fragmentos: ["odont", "ortodont"],
      angulos: ["confianca local para novos pacientes", "orcamentos pelo WhatsApp", "primeira consulta e agenda qualificada", "autoridade local em tratamentos de maior valor"],
    },
    {
      id: "clinica_estetica",
      label: "clinica estetica",
      peso: 16,
      termos: ["clinica estetica", "estetica", "harmonizacao", "botox", "depilacao", "laser", "sobrancelha", "spa"],
      angulos: ["agenda, retorno e procedimentos recorrentes", "agendamentos pelo WhatsApp", "confianca local para procedimentos esteticos", "diferenciacao em bairro competitivo"],
    },
    {
      id: "barbearia",
      label: "barbearia",
      peso: 17,
      termos: ["barbearia", "barber", "barbeiro"],
      angulos: ["agenda, retorno e horarios preenchidos", "agendamento direto pelo WhatsApp", "retorno de clientes do bairro"],
    },
    {
      id: "restaurante",
      label: "restaurante e delivery",
      peso: 17,
      termos: ["pizzaria", "restaurante", "hamburgueria", "hamburg", "delivery", "lanchonete", "marmit", "comida", "bar"],
      fragmentos: ["hamburg", "marmit"],
      angulos: ["pedidos diretos e recorrencia pelo WhatsApp", "movimento local em dias fracos", "recorrencia sem depender so de aplicativo"],
    },
    {
      id: "academia",
      label: "academia e fitness",
      peso: 15,
      termos: ["academia", "fitness", "pilates", "crossfit", "personal"],
      angulos: ["recorrencia, matriculas e retencao local", "primeiras matriculas do bairro", "retorno de alunos e frequencia semanal"],
    },
    {
      id: "pet",
      label: "pet e veterinaria",
      peso: 15,
      termos: ["pet shop", "veterinaria", "veterinario", "banho e tosa"],
      fragmentos: ["veterin"],
      angulos: ["recorrencia de cuidados e relacionamento local", "agenda de banho e tosa pelo WhatsApp", "confianca local para tutores"],
    },
    {
      id: "loja",
      label: "loja local",
      peso: 12,
      termos: ["loja", "boutique", "moda", "roupa", "calcado", "moveis", "otica"],
      angulos: ["movimento local e conversas pelo WhatsApp", "vitrine local e atendimento direto", "retorno de clientes do bairro"],
    },
    {
      id: "educacao",
      label: "educacao local",
      peso: 13,
      termos: ["escola", "curso", "idioma", "reforco", "aula"],
      angulos: ["matriculas e recorrencia local", "confianca dos pais e demanda do bairro", "turmas abertas e conversa pelo WhatsApp"],
    },
    {
      id: "advocacia",
      label: "advocacia",
      peso: 9,
      termos: ["advocacia", "advogado", "advogada", "juridico"],
      angulos: ["autoridade local e demanda consultiva", "primeira conversa e triagem consultiva", "posicionamento local em area especifica"],
    },
    {
      id: "contabilidade",
      label: "contabilidade",
      peso: 9,
      termos: ["contabilidade", "contador", "contabil"],
      fragmentos: ["contabil"],
      angulos: ["autoridade local e demanda consultiva", "organizacao financeira para negocios locais", "primeira conversa consultiva"],
    },
    {
      id: "profissional",
      label: "servico profissional",
      peso: 8,
      termos: ["consultoria", "imobiliaria", "arquitetura"],
      angulos: ["autoridade local e captacao consultiva", "prova de confianca no bairro", "primeira conversa consultiva"],
    },
  ];

  const marcaConsolidada = temFragmento(marcasConsolidadas);
  const taxonomia = taxonomias.find((item) => temTermo(item.termos) || (item.fragmentos && temFragmento(item.fragmentos))) || {
    id: "generico",
    label: "nicho pouco claro",
    peso: 7,
    termos: [],
    angulos: ["validacao manual do contexto antes da abordagem"],
  };
  const nichoConhecido = taxonomia.id !== "generico";
  const subnichoConsultivo = ["advocacia", "contabilidade", "profissional"].includes(taxonomia.id);
  const consolidadoForte = avaliacoes >= 400 && nota >= 4.4 && temSite;
  const statusInativo = lead.businessStatus && lead.businessStatus !== "OPERATIONAL";

  const faixaAvaliacoes = !temAvaliacoes ? "sem_dados"
    : avaliacoes < 20 ? "pequeno"
    : avaliacoes <= 80 ? "tracao_inicial"
    : avaliacoes <= 150 ? "medio"
    : avaliacoes <= 300 ? "maduro"
    : "consolidado";

  const escolherPorNome = (opcoes) => {
    const base = removerAcentos(String(lead.nome || lead.categoria || taxonomia.id || "")).toLowerCase();
    const soma = base.split("").reduce((total, char) => total + char.charCodeAt(0), 0);
    return opcoes[soma % opcoes.length] || opcoes[0];
  };

  let anguloAbordagem = escolherPorNome(taxonomia.angulos);
  if (!temTelefone) {
    anguloAbordagem = taxonomia.id === "generico"
      ? "validacao de canal antes da abordagem"
      : `validacao de canal para ${taxonomia.label}`;
  } else if (consolidadoForte || faixaAvaliacoes === "consolidado") {
    anguloAbordagem = "diferenciacao local em mercado maduro";
  } else if (!temSite && ["odonto", "clinica_estetica", "estetica_automotiva", "barbearia", "restaurante", "loja", "pet"].includes(taxonomia.id)) {
    const porWhatsApp = {
      odonto: "orcamentos pelo WhatsApp",
      clinica_estetica: "agendamentos pelo WhatsApp",
      estetica_automotiva: "orcamentos de servicos pelo WhatsApp",
      barbearia: "agendamento direto pelo WhatsApp",
      restaurante: "pedidos diretos e recorrencia pelo WhatsApp",
      loja: "movimento local e conversas pelo WhatsApp",
      pet: "agenda de banho e tosa pelo WhatsApp",
    };
    anguloAbordagem = porWhatsApp[taxonomia.id] || anguloAbordagem;
  } else if (faixaAvaliacoes === "pequeno") {
    const iniciais = {
      odonto: "confianca local para novos pacientes",
      clinica_estetica: "confianca local para procedimentos esteticos",
      estetica_automotiva: "confianca local para cuidados automotivos",
      academia: "primeiras matriculas do bairro",
      restaurante: "movimento local em dias fracos",
      barbearia: "retorno de clientes do bairro",
    };
    anguloAbordagem = iniciais[taxonomia.id] || anguloAbordagem;
  } else if (temNota && nota <= 4.3 && ["odonto", "clinica_estetica", "loja", "pet"].includes(taxonomia.id)) {
    anguloAbordagem = taxonomia.id === "odonto"
      ? "reputacao e seguranca para novos pacientes"
      : "confianca local e percepcao de valor";
  }
  const anguloClaro = taxonomia.id !== "generico";

  let nicho = marcaConsolidada ? 1 : taxonomia.peso;
  if (marcaConsolidada) {
    adicionarSinal(sinaisFracos, "marca/franquia com baixa chance de decisao local");
  } else if (nichoConhecido) {
    adicionarSinal(sinaisFortes, `${taxonomia.label}: contexto com gancho comercial claro`);
  } else {
    adicionarSinal(sinaisFracos, "nicho pouco claro, exige validacao antes de priorizar");
  }

  const contato = temTelefone ? 16 : 0;
  if (temTelefone) {
    adicionarSinal(sinaisFortes, "telefone disponivel para abordagem direta");
  } else {
    adicionarSinal(sinaisFracos, "sem telefone, exige busca manual antes da abordagem");
  }

  let tracao = 3;
  if (!temAvaliacoes) {
    adicionarSinal(sinaisFracos, "dados insuficientes para validar tracao local");
  } else if (avaliacoes < 20) {
    tracao = 10;
    adicionarSinal(sinaisFortes, `${avaliacoes} avaliacoes: negocio pequeno com espaco para disputar atencao`);
  } else if (avaliacoes <= 80) {
    tracao = 14;
    adicionarSinal(sinaisFortes, `${avaliacoes} avaliacoes: tracao local inicial com espaco para crescer`);
  } else if (avaliacoes <= 150) {
    tracao = 13;
    adicionarSinal(sinaisFortes, `${avaliacoes} avaliacoes: demanda validada sem parecer consolidado demais`);
  } else if (avaliacoes <= 300) {
    tracao = 7;
    adicionarSinal(sinaisFracos, `${avaliacoes} avaliacoes: negocio mais maduro, menor urgencia comercial`);
  } else {
    tracao = 2;
    adicionarSinal(sinaisFracos, `${avaliacoes} avaliacoes: negocio muito consolidado para prospeccao fria`);
  }

  let oportunidade = 6;
  if (!temNota || !temAvaliacoes) {
    oportunidade = 4;
    adicionarSinal(sinaisFracos, "dados insuficientes para medir oportunidade com confianca");
  } else if (avaliacoes < 20) {
    oportunidade = nota >= 4.6 ? 12 : 14;
  } else if (avaliacoes <= 150 && nota >= 3.0 && nota <= 4.3) {
    oportunidade = 18;
    adicionarSinal(sinaisFortes, `nota ${nota}: reputacao com margem clara de melhoria`);
  } else if (avaliacoes <= 150 && nota > 4.3) {
    oportunidade = temSite ? 11 : 14;
  } else if (avaliacoes <= 300 && nota < 4.4) {
    oportunidade = 10;
  } else if (avaliacoes > 300 && nota < 4.0) {
    oportunidade = 8;
    adicionarSinal(sinaisFortes, `nota ${nota}: volume alto com reputacao abaixo do ideal`);
  } else if (avaliacoes > 300) {
    oportunidade = 2;
  }

  let maturidade = temSite ? 3 : 8;
  if (!temSite) {
    adicionarSinal(sinaisFortes, "presenca digital menos madura, possivel abertura comercial");
  } else {
    adicionarSinal(sinaisFracos, "tem site proprio, sinal de presenca digital mais estruturada");
  }
  if (avaliacoes > 300 && temSite) maturidade = 0;

  let riscoConsolidacao = 0;
  if (avaliacoes > 150) riscoConsolidacao -= 5;
  if (avaliacoes > 300) riscoConsolidacao -= 10;
  if (temSite && nota >= 4.4 && avaliacoes >= 150) {
    riscoConsolidacao -= 7;
    adicionarSinal(sinaisFracos, "site e reputacao fortes reduzem urgencia comercial");
  }
  if (consolidadoForte) {
    riscoConsolidacao -= 16;
    adicionarSinal(sinaisFracos, "400+ avaliacoes, nota alta e site: negocio muito consolidado para prospeccao fria");
  }
  if (marcaConsolidada) riscoConsolidacao -= 28;
  if (statusInativo) {
    riscoConsolidacao -= 35;
    adicionarSinal(sinaisFracos, "status do negocio no Google nao esta operacional");
  }
  riscoConsolidacao = limitarNumero(riscoConsolidacao, -38, 0);

  let clarezaAbordagem = 0;
  if (temTelefone) clarezaAbordagem += 4;
  if (nichoConhecido) clarezaAbordagem += 4;
  if (anguloClaro) clarezaAbordagem += 3;
  if (lead.categoria) clarezaAbordagem += 1;
  if (!temTelefone) clarezaAbordagem -= 3;
  clarezaAbordagem = limitarNumero(clarezaAbordagem, 0, 12);

  if (subnichoConsultivo) {
    adicionarSinal(sinaisFracos, "ciclo consultivo exige abordagem mais cuidadosa");
  }

  const scoreBreakdown = {
    nicho,
    tracao,
    contato,
    oportunidade,
    maturidade,
    riscoConsolidacao,
    clarezaAbordagem,
  };

  const rawScore = Object.values(scoreBreakdown).reduce((total, valor) => total + valor, 0);
  let score = rawScore;
  const caps = [];

  const aplicarCap = (limite, motivo) => {
    if (score > limite) {
      score = limite;
      caps.push(motivo);
    }
  };

  if (!temTelefone) aplicarCap(52, "sem telefone limita prioridade pratica");
  if (!temTelefone && (!temNota || !temAvaliacoes)) aplicarCap(42, "sem canal e dados incompletos");
  if (!temAvaliacoes || !temNota) aplicarCap(68, "dados incompletos impedem leitura quente");
  if (faixaAvaliacoes === "pequeno") aplicarCap(88, "pouco historico impede score maximo");
  if (faixaAvaliacoes === "tracao_inicial" && !temSite) aplicarCap(89, "lead promissor, mas ainda precisa validacao");
  if (faixaAvaliacoes === "medio" && !temSite) aplicarCap(87, "lead medio bom, nao excepcional automaticamente");
  if (faixaAvaliacoes === "medio" && temSite) aplicarCap(80, "site reduz urgencia comercial");
  if (faixaAvaliacoes === "maduro" && !temSite) aplicarCap(74, "negocio maduro exige cuidado");
  if (faixaAvaliacoes === "maduro" && temSite) aplicarCap(68, "negocio maduro com site tem menor urgencia");
  if (faixaAvaliacoes === "consolidado") aplicarCap(48, "negocio consolidado perde prioridade");
  if (subnichoConsultivo) aplicarCap(82, "ciclo consultivo raramente e abordagem quente imediata");
  if (marcaConsolidada) aplicarCap(30, "marca/franquia reduz chance de decisao local");
  if (consolidadoForte) aplicarCap(28, "presenca forte demais para prospeccao fria");
  if (prioridadeBase === "DESCARTE") aplicarCap(25, "classificacao antiga marcou descarte");
  if (statusInativo) aplicarCap(18, "negocio nao operacional");

  score = limitarNumero(Math.round(score), 0, 100);

  if (caps.length) {
    adicionarSinal(sinaisFracos, `nao chegou ao topo: ${caps[0]}`);
  } else if (score >= 85) {
    adicionarSinal(sinaisFortes, "combina canal direto, nicho claro e oportunidade comercial");
  }

  let scoreConfianca = 32;
  if (temTelefone) scoreConfianca += 14; else scoreConfianca -= 18;
  if (nichoConhecido) scoreConfianca += 14; else scoreConfianca -= 8;
  if (temAvaliacoes) scoreConfianca += avaliacoes >= 10 ? 12 : 8; else scoreConfianca -= 10;
  if (temNota) scoreConfianca += 10; else scoreConfianca -= 10;
  if (anguloClaro) scoreConfianca += 8; else scoreConfianca -= 6;
  if (lead.categoria) scoreConfianca += 4;
  if (statusInativo) scoreConfianca -= 25;
  scoreConfianca = limitarNumero(Math.round(scoreConfianca), 0, 94);

  let proximoPasso = "Salvar no CRM e validar contexto antes de abordar.";
  if (statusInativo) {
    proximoPasso = "Descartar por enquanto; o negocio nao aparece como operacional no Google.";
  } else if (!temTelefone) {
    proximoPasso = "Buscar Instagram ou outro canal antes de tentar abordagem.";
  } else if (prioridadeBase === "DESCARTE" || consolidadoForte || marcaConsolidada) {
    proximoPasso = "Nao priorizar agora; usar apenas se sobrar tempo ou houver motivo especifico.";
  } else if (score < 55 || scoreConfianca < 55) {
    proximoPasso = "Enriquecer o lead antes de abordar.";
  } else if (score >= 85) {
    proximoPasso = "Priorizar hoje: abrir o lead, gerar mensagem no Outreacher e abordar por WhatsApp.";
  } else if (score >= 70) {
    proximoPasso = "Abordar depois dos leads mais quentes, mantendo a mensagem bem contextual.";
  } else {
    proximoPasso = "Salvar e abordar somente se o contexto do bairro reforcar a oportunidade.";
  }

  let riscoTom = "normal";
  if (!temTelefone || score < 60 || scoreConfianca < 55 || consolidadoForte || marcaConsolidada || subnichoConsultivo) {
    riscoTom = "leve";
  } else if (score >= 85 && scoreConfianca >= 70 && prioridadeBase === "ALTA") {
    riscoTom = "direto";
  }

  const contextoAbordagem = [
    taxonomia.label,
    faixaAvaliacoes === "pequeno" ? "negocio pequeno, abordagem deve soar proxima" : "",
    faixaAvaliacoes === "medio" ? "demanda local validada, ainda com espaco para conversa" : "",
    faixaAvaliacoes === "maduro" || faixaAvaliacoes === "consolidado" ? "negocio mais maduro, tom precisa ser cuidadoso" : "",
    !temSite ? "presenca digital menos estruturada pode abrir conversa" : "",
    !temTelefone ? "canal precisa ser validado antes de abordar" : "",
  ].filter(Boolean).join("; ");

  const gatilhoFonte = removerAcentos(anguloAbordagem).toLowerCase();
  let gatilhoConversacional = "perguntar se novos clientes chegam mais por indicacao ou conversa direta";
  if (/whatsapp|orcamento|pedido|direto/.test(gatilhoFonte)) {
    gatilhoConversacional = "puxar assunto sobre contatos, pedidos ou orcamentos pelo WhatsApp";
  } else if (/agenda|horario|retorno/.test(gatilhoFonte)) {
    gatilhoConversacional = "puxar assunto sobre agenda, horarios livres e retorno de clientes";
  } else if (/confianca|reputacao|seguranca|autoridade/.test(gatilhoFonte)) {
    gatilhoConversacional = "puxar assunto sobre confianca antes do primeiro contato";
  } else if (/matricula|recorrencia|retencao/.test(gatilhoFonte)) {
    gatilhoConversacional = "puxar assunto sobre recorrencia e frequencia de clientes";
  }

  return {
    scoreVersion: "v2.2",
    score,
    scoreConfianca,
    scoreBreakdown,
    sinaisFortes: sinaisFortes.slice(0, 5),
    sinaisFracos: sinaisFracos.slice(0, 5),
    proximoPasso,
    anguloAbordagem,
    contextoAbordagem,
    gatilhoConversacional,
    riscoTom,
  };
}

function normalizarPrioridadeAnalise(valor) {
  const base = removerAcentos(String(valor || "").trim().toUpperCase());
  if (!base) return "";
  if (base === "ALTA" || base === "BAIXA" || base === "MEDIA" || base === "DESCARTE") {
    return base;
  }
  if (base.includes("MEDIA")) return "MEDIA";
  if (base.includes("DESCARTE")) return "DESCARTE";
  if (base.includes("ALTA")) return "ALTA";
  if (base.includes("BAIXA")) return "BAIXA";
  return "";
}

function normalizarValeAbordar(valor) {
  const base = removerAcentos(String(valor || "").trim().toUpperCase());
  if (!base) return "";
  if (base.startsWith("SIM")) return "SIM";
  if (base.startsWith("NAO")) return "NAO";
  return "";
}

function criarAnaliseEstruturada(prioridade = "BAIXA", overrides = {}) {
  const prioridadeNormalizada = normalizarPrioridadeAnalise(prioridade) || "BAIXA";
  const motivos = Array.isArray(overrides.motivos)
    ? overrides.motivos.map(m => String(m || "").trim()).filter(Boolean)
    : [];

  return {
    valeAbordar: normalizarValeAbordar(overrides.valeAbordar) || (prioridadeNormalizada === "DESCARTE" ? "NAO" : "SIM"),
    prioridade: prioridadeNormalizada,
    motivos,
    problemaProvavel: String(overrides.problemaProvavel || "").trim(),
    comoAbordar: String(overrides.comoAbordar || "").trim(),
    canalSugerido: String(overrides.canalSugerido || "").trim(),
  };
}

function clonarAnaliseEstruturada(analise) {
  return criarAnaliseEstruturada(analise?.prioridade || "BAIXA", {
    valeAbordar: analise?.valeAbordar,
    motivos: analise?.motivos,
    problemaProvavel: analise?.problemaProvavel,
    comoAbordar: analise?.comoAbordar,
    canalSugerido: analise?.canalSugerido,
  });
}

function extrairValorPorRotulo(texto, rotulo) {
  const linhas = String(texto || "").split(/\r?\n/);
  const alvo = removerAcentos(rotulo).toUpperCase();

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    const linhaNormalizada = removerAcentos(linha).toUpperCase();
    if (!linhaNormalizada.startsWith(alvo)) continue;

    const idx = Math.max(linha.indexOf(":"), linha.indexOf("?"));
    const naMesmaLinha = idx >= 0 ? linha.slice(idx + 1).trim() : "";
    if (naMesmaLinha) return naMesmaLinha;

    for (let j = i + 1; j < linhas.length; j++) {
      const proxima = linhas[j].trim();
      if (proxima) return proxima;
    }
  }

  return "";
}

function extrairMotivosAnalise(texto) {
  const linhas = String(texto || "").split(/\r?\n/);
  const motivos = [];
  let coletando = false;

  for (const linha of linhas) {
    const trim = linha.trim();
    const normalizada = removerAcentos(trim).toUpperCase();

    if (!coletando && normalizada.startsWith("POR QU")) {
      coletando = true;
      continue;
    }

    if (!coletando) continue;

    if (
      normalizada.startsWith("PROBLEMA MAIS PROV") ||
      normalizada.startsWith("COMO ABORDAR") ||
      normalizada.startsWith("CANAL SUGERIDO:") ||
      normalizada.startsWith("MENSAGEM PRONTA:")
    ) {
      break;
    }

    if (trim.startsWith("-")) {
      motivos.push(trim.replace(/^-+\s*/, "").trim());
    }
  }

  return motivos.filter(Boolean);
}

function extrairAnaliseEstruturada(texto, fallback) {
  const base = fallback ? clonarAnaliseEstruturada(fallback) : criarAnaliseEstruturada("BAIXA", { valeAbordar: "NAO" });
  const prioridadeExtraida = normalizarPrioridadeAnalise(extrairValorPorRotulo(texto, "Prioridade"));
  const valeAbordarExtraido = normalizarValeAbordar(extrairValorPorRotulo(texto, "Vale abordar"));
  const motivosExtraidos = extrairMotivosAnalise(texto);
  const problemaProvavel = extrairValorPorRotulo(texto, "Problema mais prov");
  const comoAbordar = extrairValorPorRotulo(texto, "Como abordar");
  const canalSugerido = extrairValorPorRotulo(texto, "Canal sugerido");

  const extraiuAlgo = Boolean(
    prioridadeExtraida ||
    valeAbordarExtraido ||
    motivosExtraidos.length ||
    problemaProvavel ||
    comoAbordar ||
    canalSugerido
  );

  const analiseEstruturada = criarAnaliseEstruturada(prioridadeExtraida || base.prioridade, {
    valeAbordar: valeAbordarExtraido || base.valeAbordar,
    motivos: motivosExtraidos.length ? motivosExtraidos : base.motivos,
    problemaProvavel: problemaProvavel || base.problemaProvavel,
    comoAbordar: comoAbordar || base.comoAbordar,
    canalSugerido: canalSugerido || base.canalSugerido,
  });

  return { analiseEstruturada, extraiuAlgo, prioridadeExtraida };
}

function criarFallbackManualEstruturado(resposta) {
  if (/preciso de mais contexto para analisar/i.test(String(resposta || ""))) {
    return criarAnaliseEstruturada("BAIXA", {
      valeAbordar: "NAO",
      motivos: ["Contexto insuficiente para analisar."],
      problemaProvavel: "Contexto insuficiente.",
    });
  }

  return criarAnaliseEstruturada("BAIXA", {
    valeAbordar: "NAO",
    motivos: ["Nao foi possivel estruturar a resposta da analise manual."],
  });
}

function criarFallbackGoogleEstruturado(prioridadeOficial) {
  const prioridade = normalizarPrioridadeAnalise(prioridadeOficial) || "BAIXA";
  const motivos = prioridade === "DESCARTE"
    ? [`Classificacao deterministica: ${prioridade}.`]
    : [`Classificacao deterministica: ${prioridade}.`];

  return criarAnaliseEstruturada(prioridade, {
    valeAbordar: prioridade === "DESCARTE" ? "NAO" : "SIM",
    motivos,
  });
}

function aplicarPrioridadeOficial(analiseEstruturada, prioridadeOficial, prioridadeIA, contexto) {
  const prioridadeNormalizada = normalizarPrioridadeAnalise(prioridadeOficial);
  if (!prioridadeNormalizada) return clonarAnaliseEstruturada(analiseEstruturada);

  if (prioridadeIA && prioridadeIA !== prioridadeNormalizada) {
    console.warn(`[SDR] Divergencia de prioridade em ${contexto}: IA=${prioridadeIA} | oficial=${prioridadeNormalizada}`);
  }

  const final = clonarAnaliseEstruturada(analiseEstruturada);
  final.prioridade = prioridadeNormalizada;
  if (!final.valeAbordar || prioridadeNormalizada === "DESCARTE") {
    final.valeAbordar = prioridadeNormalizada === "DESCARTE" ? "NAO" : "SIM";
  }
  return final;
}

async function chamarTextoAnaliseSDR(prompt, origem) {
  console.log(`[IA] Chamando OpenAI (${origem})...`);
  debugProspeccao("openai_chamada", { fluxo: "sdr", origem, modelo: "gpt-4o-mini" });

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  console.log("[IA] Resposta recebida.");
  debugProspeccao("openai_resposta", { fluxo: "sdr", origem, choices: resp?.choices?.length || 0 });
  return resp.choices[0].message.content;
}

/*
  IA
*/
async function gerarAnalise(dados, prioridadeOficial) {
  const prioridadeLabel = prioridadeOficial || "não definida";
  const angulo = dados.anguloAbordagem
    ? `\nÂngulo pré-calculado: ${dados.anguloAbordagem}`
    : "";
  const sinais = Array.isArray(dados.sinaisFortes) && dados.sinaisFortes.length
    ? `\nSinais identificados: ${dados.sinaisFortes.join(" | ")}`
    : "";

  const prompt = `
Você é um SDR. A prioridade desse lead já foi calculada com base em dados determinísticos.

Prioridade calculada: ${prioridadeLabel}${angulo}${sinais}

Dados do negócio (Google Maps):
${JSON.stringify(dados, null, 2)}

---

TAREFA:
Confirme a prioridade com os números reais dos dados. Use "anguloAbordagem" e "sinaisFortes" dos dados como base para os bullets e para o ângulo de abordagem, se presentes.

PROIBIDO:
- Inventar dado ausente
- Usar "pode", "talvez", "potencial", "pode indicar"
- Contradizer a prioridade sem dado concreto que justifique
- Gerar mensagem pronta (pertence ao Outreacher)

LINGUAGEM — afirmações diretas com o número real dos dados:
- "38 avaliações → baixa tração digital → confirma ${prioridadeLabel}"
- "nota 3.8 → espaço de melhoria → confirma ${prioridadeLabel}"
- "sem site → presença digital menos estruturada"

---

Responda EXATAMENTE neste formato. Sem blocos extras.

Vale abordar? SIM ou NÃO
Prioridade: ALTA / MÉDIA / BAIXA

Por quê:
- [razão com número real dos dados]
- [razão com número real dos dados]
- [razão 3 se necessário — senão omita]

Problema mais provável:
[1 frase. Se for hipótese: (hipótese)]

Como abordar (1 linha):
[canal + tom + momento ideal]

Canal sugerido: WhatsApp / Instagram / Outro

Próximo passo:
[1 linha operacional. Não escreva mensagem de contato.]

Ângulo de abordagem:
[tema comercial específico do nicho — nunca mensagem pronta]

---

Regras finais:
- Nunca invente dado ausente. Se faltar algo relevante, escreva: "dado ausente".
- Não gere mensagem pronta. Mensagens pertencem somente ao Outreacher.
- Sem frases de consultoria genéricas.
`;

  return chamarTextoAnaliseSDR(prompt, "Google");
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

Próximo passo:
[1 linha operacional. Não escreva mensagem de contato.]

Ângulo de abordagem:
[opcional. Apenas tema comercial, nunca mensagem pronta.]

---

FORMATO QUANDO NÃO VALE ABORDAR (NÃO):

Vale abordar? NÃO
Prioridade: BAIXA

Por quê:
- [sinais positivos presentes, sem falha explícita]
- [ausência de problema mencionado]
`;
  return chamarTextoAnaliseSDR(prompt, "manual");
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

Próximo passo:
[1 linha operacional. Não escreva mensagem de contato.]

Ângulo de abordagem:
[opcional. Apenas tema comercial, nunca mensagem pronta.]

---

Regras finais:
- Nunca inventar dado não descrito
- Não gere mensagem pronta. Mensagens pertencem somente ao Outreacher.
- Sem frases de consultoria
`;
  return chamarTextoAnaliseSDR(prompt, "refinamento manual");
}

async function analisarLeadSDR({ origem, mensagem, dadosLead, estado, prioridadeOficial, executarIA = true, contexto = "" }) {
  debugProspeccao("sdr_chamada", {
    origem,
    contexto,
    executarIA,
    lead: dadosLead?.nome || "",
    prioridadeOficial: prioridadeOficial || "",
  });
  if (origem === "manual") {
    if (!mensagem) {
      debugProspeccao("fallback_ativado", { tipo: "sdr_manual", motivo: "mensagem_vazia", contexto });
      return {
        resposta: "",
        analiseEstruturada: criarFallbackManualEstruturado(""),
        ehNovoCenario: false,
      };
    }

    if (!executarIA) {
      debugProspeccao("fallback_ativado", { tipo: "sdr_manual", motivo: "executarIA_false", contexto });
      return {
        resposta: "",
        analiseEstruturada: criarFallbackManualEstruturado(""),
        ehNovoCenario: false,
      };
    }

    if (estado?.cenarioOriginal) {
      const respostaBruta = await gerarRefinamentoManual(mensagem, estado);
      const ehNovoCenario = respostaBruta.startsWith("[NOVO]");
      const resposta = respostaBruta.replace(/^\[(NOVO|FOLLOW-UP)\]\s*/, "");
      const analiseAnterior = estado.analiseEstruturada
        ? clonarAnaliseEstruturada(estado.analiseEstruturada)
        : extrairAnaliseEstruturada(estado.analiseAtual, criarFallbackManualEstruturado(estado.analiseAtual)).analiseEstruturada;

      const extraida = extrairAnaliseEstruturada(resposta, analiseAnterior);
      if (!extraida.extraiuAlgo && !ehNovoCenario) {
        debugProspeccao("fallback_ativado", { tipo: "sdr_manual", motivo: "mantem_analise_anterior", contexto });
      }
      const analiseEstruturada = ehNovoCenario
        ? extraida.analiseEstruturada
        : (extraida.extraiuAlgo ? extraida.analiseEstruturada : analiseAnterior);

      debugProspeccao("classificacao_sdr", { origem, contexto, prioridade: analiseEstruturada.prioridade, valeAbordar: analiseEstruturada.valeAbordar });
      return { resposta, analiseEstruturada, ehNovoCenario };
    }

    const resposta = await gerarAnaliseManual(mensagem);
    const extraida = extrairAnaliseEstruturada(resposta, criarFallbackManualEstruturado(resposta));
    if (!extraida.extraiuAlgo) {
      debugProspeccao("fallback_ativado", { tipo: "sdr_manual", motivo: "analise_nao_estruturada", contexto });
    }
    debugProspeccao("classificacao_sdr", { origem, contexto, prioridade: extraida.analiseEstruturada.prioridade, valeAbordar: extraida.analiseEstruturada.valeAbordar });
    return {
      resposta,
      analiseEstruturada: extraida.analiseEstruturada,
      ehNovoCenario: true,
    };
  }

  if (origem === "google") {
    const prioridadeBase = normalizarPrioridadeAnalise(prioridadeOficial) || classificarLead(
      dadosLead?.nota,
      dadosLead?.avaliacoes,
      !!dadosLead?.site
    );

    const fallback = criarFallbackGoogleEstruturado(prioridadeBase);

    if (!executarIA) {
      debugProspeccao("fallback_ativado", { tipo: "sdr_google", motivo: "executarIA_false", contexto: contexto || "google" });
      return {
        resposta: "",
        analiseEstruturada: aplicarPrioridadeOficial(fallback, prioridadeBase, "", contexto || "google"),
      };
    }

    const resposta = await gerarAnalise(dadosLead, prioridadeBase);
    const extraida = extrairAnaliseEstruturada(resposta, fallback);
    if (!extraida.extraiuAlgo) {
      debugProspeccao("fallback_ativado", { tipo: "sdr_google", motivo: "analise_nao_estruturada", contexto: contexto || "google" });
    }
    const analiseEstruturada = aplicarPrioridadeOficial(
      extraida.analiseEstruturada,
      prioridadeBase,
      extraida.prioridadeExtraida,
      contexto || "google"
    );

    debugProspeccao("classificacao_sdr", { origem, contexto: contexto || "google", prioridade: analiseEstruturada.prioridade, valeAbordar: analiseEstruturada.valeAbordar });
    return { resposta, analiseEstruturada };
  }

  throw new Error(`Origem de analise SDR nao suportada: ${origem}`);
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
  const contagem = { novo: 0, abordado: 0, conversando: 0, respondeu: 0, reuniao: 0, proposta: 0, fechado: 0, perdido: 0 };
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
    `${contagem.conversando + contagem.respondeu} conversando`,
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

const META_GRAPH_VERSION = "v19.0";
const META_CAMPANHA_FIELDS = [
  "id", "name", "status", "effective_status", "configured_status", "objective",
  "daily_budget", "lifetime_budget", "budget_remaining", "start_time", "stop_time",
];
const META_ADSET_FIELDS = [
  "id", "name", "campaign_id", "status", "effective_status", "configured_status",
  "optimization_goal", "billing_event", "daily_budget", "lifetime_budget",
  "budget_remaining", "attribution_spec", "start_time", "end_time",
];
const META_AD_FIELDS = [
  "id", "name", "campaign_id", "adset_id", "status", "effective_status", "configured_status",
  "creative{id,name,thumbnail_url,body,title,object_story_spec,asset_feed_spec,call_to_action_type}",
];
const META_INSIGHTS_SAFE_BASE_FIELDS = [
  "spend", "impressions", "clicks", "cpc", "ctr", "cpm", "frequency",
  "actions", "action_values",
];
const META_INSIGHTS_BASE_FIELDS = [
  ...META_INSIGHTS_SAFE_BASE_FIELDS,
  "reach", "inline_link_clicks", "cost_per_inline_link_click",
  "outbound_clicks", "cost_per_outbound_click", "cost_per_action_type",
  "video_play_actions", "video_thruplay_watched_actions", "video_avg_time_watched_actions",
];
const META_INSIGHTS_FIELDS_BY_LEVEL = {
  campaign: ["campaign_id", "campaign_name", ...META_INSIGHTS_BASE_FIELDS],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name", ...META_INSIGHTS_BASE_FIELDS],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", ...META_INSIGHTS_BASE_FIELDS],
};
const META_INSIGHTS_SAFE_FIELDS_BY_LEVEL = {
  campaign: ["campaign_id", "campaign_name", ...META_INSIGHTS_SAFE_BASE_FIELDS],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name", ...META_INSIGHTS_SAFE_BASE_FIELDS],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", ...META_INSIGHTS_SAFE_BASE_FIELDS],
};
const META_INSIGHTS_FIELDS = META_INSIGHTS_FIELDS_BY_LEVEL.campaign;
const META_METRICAS_IMPORTANTES_FALTANTES = [
  "adset_id", "adset_name", "ad_id", "ad_name",
  "optimization_goal", "attribution_setting", "daily_budget", "lifetime_budget",
  "reach", "link_clicks", "outbound_clicks", "landing_page_views",
  "cost_per_landing_page_view", "cost_per_outbound_click",
  "view_content", "purchase", "purchase_value", "cost_per_add_to_cart",
  "cost_per_initiate_checkout", "cost_per_purchase", "creative_id", "thumbnail_url",
  "primary_text", "headline", "description", "call_to_action", "video_plays",
  "thruplays", "average_watch_time",
];

function dataMetaYYYYMMDD(date) {
  return date.toISOString().slice(0, 10);
}

function normalizarPeriodoMeta(period) {
  const raw = String(period || "").trim().toLowerCase();
  if (!raw) {
    return {
      chave: "30d",
      label: "ultimos 30 dias",
      modo: "date_preset",
      query: { date_preset: "last_30d" },
      defaultPreservado: true,
    };
  }

  const mapaDias = { hoje: 1, today: 1, "1d": 1, "7d": 7, "14d": 14, "30d": 30 };
  const dias = mapaDias[raw] || 30;
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(hoje.getDate() - (dias - 1));

  return {
    chave: dias === 1 ? "hoje" : `${dias}d`,
    label: dias === 1 ? "hoje" : `ultimos ${dias} dias`,
    modo: "time_range",
    since: dataMetaYYYYMMDD(inicio),
    until: dataMetaYYYYMMDD(hoje),
    query: {
      time_range: JSON.stringify({
        since: dataMetaYYYYMMDD(inicio),
        until: dataMetaYYYYMMDD(hoje),
      }),
    },
    defaultPreservado: false,
  };
}

function criarDebugMeta({ accountKey, cfg, periodo }) {
  return {
    conta: {
      key: accountKey || "default",
      nome: cfg?.name || "conta padrao",
      accountIdConfigurado: !!(cfg?.accountId || META_AD_ACCOUNT_ID),
    },
    graphVersion: META_GRAPH_VERSION,
    periodo: {
      chave: periodo.chave,
      label: periodo.label,
      modo: periodo.modo,
      since: periodo.since || null,
      until: periodo.until || null,
      defaultPreservado: periodo.defaultPreservado,
    },
    endpointsChamados: [],
    camposSolicitados: {
      campanhas: META_CAMPANHA_FIELDS,
      adsets: META_ADSET_FIELDS,
      ads: META_AD_FIELDS,
      insightsPorNivel: META_INSIGHTS_FIELDS_BY_LEVEL,
    },
    camposAusentes: [],
    erros: [],
    quantidades: {
      campanhasRetornadas: 0,
      insightsSolicitados: 0,
      insightsComDados: 0,
      insightsComErro: 0,
      adsetsRetornados: 0,
      adsRetornados: 0,
      insightsAdsetsComDados: 0,
      insightsAdsComDados: 0,
      usouFallbackInsights: {
        campaign: false,
        adset: false,
        ad: false,
      },
    },
    metricasFaltantesPlanejadas: META_METRICAS_IMPORTANTES_FALTANTES,
    tempoRespostaMs: null,
  };
}

function finalizarDebugMeta(debug, inicioMs) {
  if (!debug) return null;
  debug.camposAusentes = Array.from(new Set(debug.camposAusentes)).sort();
  debug.erros = debug.erros.slice(0, 30);
  debug.endpointsChamados = debug.endpointsChamados.slice(0, 80);
  debug.tempoRespostaMs = Date.now() - inicioMs;
  return debug;
}

function registrarEndpointDebugMeta(debug, endpoint) {
  if (debug) debug.endpointsChamados.push(endpoint);
}

function registrarErroDebugMeta(debug, erro) {
  if (!debug) return;
  debug.erros.push({
    etapa: erro.etapa || "desconhecida",
    campanha: erro.campanha || null,
    codigo: erro.codigo || null,
    mensagem: erro.mensagem || erro.message || String(erro),
  });
}

function registrarCamposAusentesDebugMeta(debug, insight = {}) {
  if (!debug) return;
  META_INSIGHTS_BASE_FIELDS.forEach((campo) => {
    if (insight[campo] == null) debug.camposAusentes.push(campo);
  });
  const actions = Array.isArray(insight.actions) ? insight.actions : [];
  const values = Array.isArray(insight.action_values) ? insight.action_values : [];
  const temAction = (tipos) => actions.some(a => tipos.includes(a.action_type));
  const temValue = (tipos) => values.some(a => tipos.includes(a.action_type));
  if (!temAction(["purchase", "offsite_conversion.fb_pixel_purchase"])) debug.camposAusentes.push("purchase");
  if (!temValue(["purchase", "offsite_conversion.fb_pixel_purchase"])) debug.camposAusentes.push("purchase_value");
  if (!temAction(["add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"])) debug.camposAusentes.push("add_to_cart");
  if (!temAction(["initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"])) debug.camposAusentes.push("initiate_checkout");
  if (!temAction(["view_content", "offsite_conversion.fb_pixel_view_content"])) debug.camposAusentes.push("view_content");
  if (!temAction(["landing_page_view"])) debug.camposAusentes.push("landing_page_views");
  if (insight.outbound_clicks == null && !temAction(["outbound_click"])) debug.camposAusentes.push("outbound_clicks");
  if (insight.video_play_actions == null && !temAction(["video_view"])) debug.camposAusentes.push("video_plays");
  if (insight.video_thruplay_watched_actions == null) debug.camposAusentes.push("thruplays");
  if (insight.video_avg_time_watched_actions == null) debug.camposAusentes.push("average_watch_time");
  if (!temAction(["lead", "offsite_conversion.fb_pixel_lead"])) debug.camposAusentes.push("lead");
}

function parseNumeroMeta(valor) {
  if (valor == null || valor === "") return null;
  if (Array.isArray(valor)) return null;
  const numero = parseFloat(valor);
  return Number.isFinite(numero) ? numero : null;
}

function parseInteiroMeta(valor) {
  const numero = parseNumeroMeta(valor);
  return numero == null ? null : Math.round(numero);
}

function parseBudgetMeta(valor) {
  const numero = parseNumeroMeta(valor);
  return numero == null ? null : parseFloat((numero / 100).toFixed(2));
}

function arredondarMeta(valor, casas = 2) {
  if (valor == null || !Number.isFinite(valor)) return null;
  return parseFloat(valor.toFixed(casas));
}

function extrairActionMeta(arr, tipos) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const found = arr.find(a => tipos.includes(a.action_type));
  if (!found || found.value == null) return null;
  return parseNumeroMeta(found.value);
}

function extrairNumeroMistoMeta(valor, tipos = []) {
  if (Array.isArray(valor)) {
    if (tipos.length > 0) return extrairActionMeta(valor, tipos);
    const primeiro = valor.find(item => item && item.value != null);
    return primeiro ? parseNumeroMeta(primeiro.value) : null;
  }
  return parseNumeroMeta(valor);
}

function dividirMeta(numerador, denominador, multiplicador = 1, casas = 2) {
  if (numerador == null || denominador == null || denominador <= 0) return null;
  return arredondarMeta((numerador / denominador) * multiplicador, casas);
}

function normalizarAttributionSpecMeta(spec) {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const partes = spec
    .map(item => {
      if (!item) return null;
      const evento = item.event_type || item.event || null;
      const janela = item.window_days != null ? `${item.window_days}d` : null;
      return [evento, janela].filter(Boolean).join(":");
    })
    .filter(Boolean);
  return partes.length ? partes.join(", ") : null;
}

function normalizarCriativoMeta(creative = {}) {
  const objectStory = creative.object_story_spec || {};
  const linkData = objectStory.link_data || {};
  const videoData = objectStory.video_data || {};
  const templateData = objectStory.template_data || {};
  const assetFeed = creative.asset_feed_spec || {};
  const primeiroTexto = (arr, campo = "text") => Array.isArray(arr) && arr[0] ? (arr[0][campo] || arr[0].value || null) : null;

  return {
    creative_id: creative.id || null,
    creative_name: creative.name || null,
    thumbnail_url: creative.thumbnail_url || null,
    primary_text: creative.body || linkData.message || videoData.message || templateData.message || primeiroTexto(assetFeed.bodies) || null,
    headline: creative.title || linkData.name || videoData.title || templateData.name || primeiroTexto(assetFeed.titles) || null,
    description: linkData.description || templateData.description || primeiroTexto(assetFeed.descriptions) || null,
    call_to_action:
      creative.call_to_action_type ||
      linkData.call_to_action?.type ||
      videoData.call_to_action?.type ||
      templateData.call_to_action?.type ||
      (Array.isArray(assetFeed.call_to_action_types) ? assetFeed.call_to_action_types[0] : null) ||
      null,
  };
}

function normalizarMetricasInsightMeta(insight = {}) {
  const rawActions = Array.isArray(insight.actions) ? insight.actions : [];
  const rawActionValues = Array.isArray(insight.action_values) ? insight.action_values : [];
  const rawCostPerAction = Array.isArray(insight.cost_per_action_type) ? insight.cost_per_action_type : [];

  const gasto = parseNumeroMeta(insight.spend);
  const impressoes = parseInteiroMeta(insight.impressions);
  const reach = parseInteiroMeta(insight.reach);
  const cliques = parseInteiroMeta(insight.clicks);
  const link_clicks =
    parseInteiroMeta(insight.inline_link_clicks) ??
    parseInteiroMeta(extrairActionMeta(rawActions, ["link_click"]));
  const ctr = parseNumeroMeta(insight.ctr);
  const cpc = parseNumeroMeta(insight.cpc);
  const cpm = parseNumeroMeta(insight.cpm);
  const frequencia = parseNumeroMeta(insight.frequency);

  const view_content = extrairActionMeta(rawActions, ["view_content", "offsite_conversion.fb_pixel_view_content"]);
  const purchase = extrairActionMeta(rawActions, ["purchase", "offsite_conversion.fb_pixel_purchase"]);
  const purchase_value = extrairActionMeta(rawActionValues, ["purchase", "offsite_conversion.fb_pixel_purchase"]);
  const add_to_cart = extrairActionMeta(rawActions, ["add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"]);
  const initiate_checkout = extrairActionMeta(rawActions, ["initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"]);
  const leads = extrairActionMeta(rawActions, ["lead", "offsite_conversion.fb_pixel_lead"]);
  const landing_page_views = extrairActionMeta(rawActions, ["landing_page_view"]);

  const outbound_clicks = parseInteiroMeta(extrairNumeroMistoMeta(insight.outbound_clicks, ["outbound_click"]));
  const cost_per_outbound_click = extrairNumeroMistoMeta(insight.cost_per_outbound_click, ["outbound_click"]);
  const cost_per_landing_page_view = extrairActionMeta(rawCostPerAction, ["landing_page_view"]);
  const cost_per_view_content = extrairActionMeta(rawCostPerAction, ["view_content", "offsite_conversion.fb_pixel_view_content"]);
  const cost_per_add_to_cart = extrairActionMeta(rawCostPerAction, ["add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"]);
  const cost_per_initiate_checkout = extrairActionMeta(rawCostPerAction, ["initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"]);
  const cost_per_purchase = extrairActionMeta(rawCostPerAction, ["purchase", "offsite_conversion.fb_pixel_purchase"]);

  const video_plays = parseInteiroMeta(extrairNumeroMistoMeta(insight.video_play_actions, ["video_view", "video_play"]));
  const thruplays = parseInteiroMeta(extrairNumeroMistoMeta(insight.video_thruplay_watched_actions, ["video_view", "thruplay"]));
  const average_watch_time = extrairNumeroMistoMeta(insight.video_avg_time_watched_actions, ["video_view"]);

  const roas = (gasto != null && gasto > 0 && purchase_value != null && purchase_value > 0)
    ? arredondarMeta(purchase_value / gasto, 2)
    : null;
  const custoPorConversao = (purchase != null && purchase > 0 && gasto != null && gasto > 0)
    ? arredondarMeta(gasto / purchase, 2)
    : null;

  return {
    gasto,
    impressoes,
    reach,
    cliques,
    link_clicks,
    ctr,
    cpc,
    cpm,
    frequencia,
    view_content,
    purchase,
    purchase_value,
    conversoes: purchase,
    add_to_cart,
    initiate_checkout,
    leads,
    roas,
    custoPorConversao,
    cost_per_view_content,
    cost_per_add_to_cart,
    cost_per_initiate_checkout,
    cost_per_purchase: cost_per_purchase ?? custoPorConversao,
    outbound_clicks,
    landing_page_views,
    cost_per_outbound_click,
    cost_per_landing_page_view,
    outbound_ctr: dividirMeta(outbound_clicks, impressoes, 100, 2),
    link_click_rate: dividirMeta(link_clicks, cliques, 100, 2),
    landing_page_view_rate: dividirMeta(landing_page_views, outbound_clicks ?? link_clicks, 100, 2),
    checkout_rate: dividirMeta(initiate_checkout, add_to_cart, 100, 2),
    purchase_rate: dividirMeta(purchase, initiate_checkout, 100, 2),
    video_plays,
    thruplays,
    average_watch_time,
    _actions: rawActions,
    _action_values: rawActionValues,
    _cost_per_action_type: rawCostPerAction,
  };
}

function montarCamadasMetricasMeta(metricas) {
  return {
    entrega: {
      gasto: metricas.gasto,
      impressoes: metricas.impressoes,
      reach: metricas.reach,
      cliques: metricas.cliques,
      link_clicks: metricas.link_clicks,
      ctr: metricas.ctr,
      cpc: metricas.cpc,
      cpm: metricas.cpm,
      frequencia: metricas.frequencia,
    },
    funil: {
      view_content: metricas.view_content,
      add_to_cart: metricas.add_to_cart,
      initiate_checkout: metricas.initiate_checkout,
      purchase: metricas.purchase,
      purchase_value: metricas.purchase_value,
      roas: metricas.roas,
      cost_per_view_content: metricas.cost_per_view_content,
      cost_per_add_to_cart: metricas.cost_per_add_to_cart,
      cost_per_initiate_checkout: metricas.cost_per_initiate_checkout,
      cost_per_purchase: metricas.cost_per_purchase,
    },
    qualidade: {
      outbound_clicks: metricas.outbound_clicks,
      landing_page_views: metricas.landing_page_views,
      cost_per_outbound_click: metricas.cost_per_outbound_click,
      cost_per_landing_page_view: metricas.cost_per_landing_page_view,
      outbound_ctr: metricas.outbound_ctr,
      link_click_rate: metricas.link_click_rate,
      landing_page_view_rate: metricas.landing_page_view_rate,
      checkout_rate: metricas.checkout_rate,
      purchase_rate: metricas.purchase_rate,
    },
    video: {
      video_plays: metricas.video_plays,
      thruplays: metricas.thruplays,
      average_watch_time: metricas.average_watch_time,
    },
  };
}

function indexarPorCampo(lista, campo) {
  const map = new Map();
  (lista || []).forEach(item => {
    const chave = item?.[campo];
    if (chave != null && chave !== "") map.set(String(chave), item);
  });
  return map;
}

function agruparPorCampo(lista, campo) {
  const map = new Map();
  (lista || []).forEach(item => {
    const chave = item?.[campo];
    if (chave == null || chave === "") return;
    const key = String(chave);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
}

function erroMetaApi(jsonError) {
  const codigo = jsonError?.code || null;
  let msg = jsonError?.message || "Erro desconhecido na API Meta.";
  if (codigo === 190) msg = "Token Meta expirado ou invalido. Gere um novo em developers.facebook.com.";
  else if (codigo === 100) msg = "Campo, parametro ou ID invalido na API Meta.";
  else if (codigo === 10 || codigo === 200) msg = "Permissoes insuficientes. O token precisa de ads_read.";
  const err = new Error(msg);
  err.tipo = "api";
  err.codigo = codigo;
  return err;
}

async function buscarListaMetaPaginada(urlInicial, { debugMeta, endpointDebug, etapa, maxPaginas = 2 } = {}) {
  const dados = [];
  let urlAtual = urlInicial;
  let pagina = 1;
  while (urlAtual && pagina <= maxPaginas) {
    registrarEndpointDebugMeta(debugMeta, { ...(endpointDebug || {}), pagina });
    let resp;
    try {
      resp = await fetch(urlAtual);
    } catch {
      const err = new Error("Sem conexao com a API do Meta. Verifique sua internet.");
      err.tipo = "rede";
      throw err;
    }
    const json = await resp.json();
    if (json.error) throw erroMetaApi(json.error);
    if (Array.isArray(json.data)) dados.push(...json.data);
    urlAtual = json.paging?.next || null;
    pagina += 1;
  }
  return dados;
}

async function buscarInsightsNivelMeta({ accountId, token, periodo, level, fields, fallbackFields, debugMeta }) {
  const montarUrl = (listaCampos) => {
    const params = new URLSearchParams({
      fields: listaCampos.join(","),
      level,
      limit: "500",
      access_token: token,
    });
    Object.entries(periodo.query).forEach(([chave, valor]) => params.set(chave, valor));
    return `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${accountId}/insights?${params.toString()}`;
  };

  const endpointBase = {
    etapa: `insights_${level}`,
    metodo: "GET",
    endpoint: `/${META_GRAPH_VERSION}/act_{account}/insights`,
    level,
    periodo: periodo.chave,
  };

  try {
    const dados = await buscarListaMetaPaginada(montarUrl(fields), {
      debugMeta,
      etapa: `insights_${level}`,
      endpointDebug: { ...endpointBase, fields },
      maxPaginas: 4,
    });
    return { dados, erro: null, fallback: false };
  } catch (e) {
    registrarErroDebugMeta(debugMeta, {
      etapa: `insights_${level}`,
      codigo: e.codigo || null,
      mensagem: e.message,
    });

    if (!fallbackFields || fallbackFields.join(",") === fields.join(",")) {
      return { dados: [], erro: e.message, fallback: false };
    }

    try {
      const dados = await buscarListaMetaPaginada(montarUrl(fallbackFields), {
        debugMeta,
        etapa: `insights_${level}_fallback`,
        endpointDebug: { ...endpointBase, etapa: `insights_${level}_fallback`, fields: fallbackFields, fallback: true },
        maxPaginas: 4,
      });
      return { dados, erro: null, fallback: true };
    } catch (fallbackErr) {
      registrarErroDebugMeta(debugMeta, {
        etapa: `insights_${level}_fallback`,
        codigo: fallbackErr.codigo || null,
        mensagem: fallbackErr.message,
      });
      return { dados: [], erro: fallbackErr.message, fallback: true };
    }
  }
}

async function buscarEdgeMeta({ accountId, token, edge, fields, debugMeta, etapa }) {
  const params = new URLSearchParams({
    fields: fields.join(","),
    limit: "500",
    access_token: token,
  });
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${accountId}/${edge}?${params.toString()}`;
  try {
    const dados = await buscarListaMetaPaginada(url, {
      debugMeta,
      etapa,
      endpointDebug: {
        etapa,
        metodo: "GET",
        endpoint: `/${META_GRAPH_VERSION}/act_{account}/${edge}`,
        fields,
      },
      maxPaginas: 4,
    });
    return { dados, erro: null };
  } catch (e) {
    registrarErroDebugMeta(debugMeta, {
      etapa,
      codigo: e.codigo || null,
      mensagem: e.message,
    });
    return { dados: [], erro: e.message };
  }
}

function montarAdsetDetalhadoMeta(adset = {}, insight = {}) {
  const metricas = normalizarMetricasInsightMeta(insight);
  return {
    adset_id: adset.id || insight.adset_id || null,
    adset_name: adset.name || insight.adset_name || null,
    status: adset.status || null,
    effective_status: adset.effective_status || null,
    configured_status: adset.configured_status || null,
    optimization_goal: adset.optimization_goal || null,
    billing_event: adset.billing_event || null,
    daily_budget: parseBudgetMeta(adset.daily_budget),
    lifetime_budget: parseBudgetMeta(adset.lifetime_budget),
    budget_remaining: parseBudgetMeta(adset.budget_remaining),
    attribution_setting: normalizarAttributionSpecMeta(adset.attribution_spec),
    start_time: adset.start_time || null,
    end_time: adset.end_time || null,
    ...montarCamadasMetricasMeta(metricas),
  };
}

function montarAdDetalhadoMeta(ad = {}, insight = {}, criativo = {}) {
  const metricas = normalizarMetricasInsightMeta(insight);
  return {
    ad_id: ad.id || insight.ad_id || null,
    ad_name: ad.name || insight.ad_name || null,
    adset_id: ad.adset_id || insight.adset_id || null,
    adset_name: insight.adset_name || null,
    status: ad.status || null,
    effective_status: ad.effective_status || null,
    configured_status: ad.configured_status || null,
    creative_id: criativo.creative_id || ad.creative?.id || null,
    creative: criativo,
    ...montarCamadasMetricasMeta(metricas),
  };
}

function montarErrosParciaisMeta(partes) {
  return Object.entries(partes || {})
    .filter(([, valor]) => !!valor)
    .map(([etapa, mensagem]) => ({ etapa, mensagem }));
}

async function buscarInsightsMetaLegacy(accountKey, opcoes = {}) {
  const inicioDebug = Date.now();
  const periodo = normalizarPeriodoMeta(opcoes.period || opcoes.periodo);
  const debugAtivo = !!opcoes.debug;
  // Resolve token e accountId para a conta selecionada
  const cfg = (accountKey && ACCOUNT_CONFIG[accountKey]) ? ACCOUNT_CONFIG[accountKey] : null;
  const token     = (accountKey && META_TOKENS[accountKey]) ? META_TOKENS[accountKey] : META_ACCESS_TOKEN;
  const accountId = cfg?.accountId || META_AD_ACCOUNT_ID;
  const debugMeta = debugAtivo ? criarDebugMeta({ accountKey, cfg, periodo }) : null;

  if (!token || !accountId) {
    const err = new Error(
      accountKey
        ? `Conta "${accountKey}" não configurada. Verifique META_ACCESS_TOKEN e META_AD_ACCOUNT_ID no .env.`
        : "API Meta não configurada. Adicione META_ACCESS_TOKEN e META_AD_ACCOUNT_ID nas variáveis de ambiente."
    );
    err.tipo = "config";
    registrarErroDebugMeta(debugMeta, { etapa: "config", mensagem: err.message });
    err.metaDebug = finalizarDebugMeta(debugMeta, inicioDebug);
    throw err;
  }

  let resp;
  try {
    // Buscar lista de campanhas com objective para distinguir tráfego vs conversão
    const paramsCampanhas = new URLSearchParams({
      fields: META_CAMPANHA_FIELDS.join(","),
      access_token: token,
    });
    const urlCampanhas = `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${accountId}/campaigns?${paramsCampanhas.toString()}`;
    registrarEndpointDebugMeta(debugMeta, {
      etapa: "campanhas",
      metodo: "GET",
      endpoint: `/${META_GRAPH_VERSION}/act_{account}/campaigns`,
      fields: META_CAMPANHA_FIELDS,
    });
    resp = await fetch(urlCampanhas);
  } catch (e) {
    const err = new Error("Sem conexão com a API do Meta. Verifique sua internet.");
    err.tipo = "rede";
    registrarErroDebugMeta(debugMeta, { etapa: "campanhas", mensagem: err.message });
    err.metaDebug = finalizarDebugMeta(debugMeta, inicioDebug);
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
    registrarErroDebugMeta(debugMeta, { etapa: "campanhas", codigo, mensagem: msg });
    err.metaDebug = finalizarDebugMeta(debugMeta, inicioDebug);
    throw err;
  }

  const campanhas = jsonCampanhas.data || [];
  if (debugMeta) debugMeta.quantidades.campanhasRetornadas = campanhas.length;
  if (campanhas.length === 0) {
    if (debugMeta) return { campanhas: [], metaDebug: finalizarDebugMeta(debugMeta, inicioDebug) };
    return [];
  }

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
        if (debugMeta) debugMeta.quantidades.insightsSolicitados += 1;
        const paramsInsights = new URLSearchParams({
          fields: META_INSIGHTS_FIELDS.join(","),
          access_token: token,
        });
        Object.entries(periodo.query).forEach(([chave, valor]) => paramsInsights.set(chave, valor));
        const urlInsights = `https://graph.facebook.com/${META_GRAPH_VERSION}/${camp.id}/insights?${paramsInsights.toString()}`;
        registrarEndpointDebugMeta(debugMeta, {
          etapa: "insights",
          metodo: "GET",
          endpoint: `/${META_GRAPH_VERSION}/{campaign-id}/insights`,
          campanha: camp.name || "Sem nome",
          fields: META_INSIGHTS_FIELDS,
          periodo: periodo.chave,
        });
        const respInsights = await fetch(urlInsights);
        const jsonInsights = await respInsights.json();

        if (jsonInsights.error) {
          console.warn(`[Meta] Erro ao buscar insights de ${camp.name}:`, jsonInsights.error.message);
          if (debugMeta) debugMeta.quantidades.insightsComErro += 1;
          registrarErroDebugMeta(debugMeta, {
            etapa: "insights",
            campanha: camp.name || "Sem nome",
            codigo: jsonInsights.error.code || null,
            mensagem: jsonInsights.error.message,
          });
          // Retorna campanha com flag de erro — não silencia, não inventa dados
          return {
            campanha: camp.name || "Sem nome",
            status:   camp.status || null,
            erro:     jsonInsights.error.message,
          };
        }

        const insight = (jsonInsights.data && jsonInsights.data[0]) || {};
        if (jsonInsights.data && jsonInsights.data.length > 0 && debugMeta) debugMeta.quantidades.insightsComDados += 1;
        registrarCamposAusentesDebugMeta(debugMeta, insight);

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
        if (debugMeta) debugMeta.quantidades.insightsComErro += 1;
        registrarErroDebugMeta(debugMeta, {
          etapa: "processar_campanha",
          campanha: camp.name || "Sem nome",
          mensagem: e.message,
        });
        return {
          campanha: camp.name || "Sem nome",
          status:   camp.status || null,
          erro:     e.message,
        };
      }
    })
  );

  const resultado = campanhasComInsights.filter(c => c !== null);
  if (debugMeta) return { campanhas: resultado, metaDebug: finalizarDebugMeta(debugMeta, inicioDebug) };
  return resultado;
}

// ── GESTOR: PERSISTÊNCIA DE RESTRIÇÕES (memória server-side por conta) ────────
async function buscarInsightsMeta(accountKey, opcoes = {}) {
  const inicioDebug = Date.now();
  const periodo = normalizarPeriodoMeta(opcoes.period || opcoes.periodo);
  const debugAtivo = !!opcoes.debug;
  const cfg = (accountKey && ACCOUNT_CONFIG[accountKey]) ? ACCOUNT_CONFIG[accountKey] : null;
  const token = (accountKey && META_TOKENS[accountKey]) ? META_TOKENS[accountKey] : META_ACCESS_TOKEN;
  const accountId = cfg?.accountId || META_AD_ACCOUNT_ID;
  const debugMeta = debugAtivo ? criarDebugMeta({ accountKey, cfg, periodo }) : null;

  if (!token || !accountId) {
    const err = new Error(
      accountKey
        ? `Conta "${accountKey}" nao configurada. Verifique META_ACCESS_TOKEN e META_AD_ACCOUNT_ID no .env.`
        : "API Meta nao configurada. Adicione META_ACCESS_TOKEN e META_AD_ACCOUNT_ID nas variaveis de ambiente."
    );
    err.tipo = "config";
    registrarErroDebugMeta(debugMeta, { etapa: "config", mensagem: err.message });
    err.metaDebug = finalizarDebugMeta(debugMeta, inicioDebug);
    throw err;
  }

  let campanhas = [];
  try {
    const paramsCampanhas = new URLSearchParams({
      fields: META_CAMPANHA_FIELDS.join(","),
      limit: "500",
      access_token: token,
    });
    const urlCampanhas = `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${accountId}/campaigns?${paramsCampanhas.toString()}`;
    campanhas = await buscarListaMetaPaginada(urlCampanhas, {
      debugMeta,
      etapa: "campanhas",
      endpointDebug: {
        etapa: "campanhas",
        metodo: "GET",
        endpoint: `/${META_GRAPH_VERSION}/act_{account}/campaigns`,
        fields: META_CAMPANHA_FIELDS,
      },
      maxPaginas: 4,
    });
  } catch (err) {
    registrarErroDebugMeta(debugMeta, {
      etapa: "campanhas",
      codigo: err.codigo || null,
      mensagem: err.message,
    });
    err.metaDebug = finalizarDebugMeta(debugMeta, inicioDebug);
    throw err;
  }

  if (debugMeta) debugMeta.quantidades.campanhasRetornadas = campanhas.length;
  if (campanhas.length === 0) {
    if (debugMeta) return { campanhas: [], metaDebug: finalizarDebugMeta(debugMeta, inicioDebug) };
    return [];
  }

  if (debugMeta) debugMeta.quantidades.insightsSolicitados = campanhas.length;

  const [
    insightsCampanhaRes,
    insightsAdsetsRes,
    insightsAdsRes,
    adsetsRes,
    adsRes,
  ] = await Promise.all([
    buscarInsightsNivelMeta({
      accountId,
      token,
      periodo,
      level: "campaign",
      fields: META_INSIGHTS_FIELDS_BY_LEVEL.campaign,
      fallbackFields: META_INSIGHTS_SAFE_FIELDS_BY_LEVEL.campaign,
      debugMeta,
    }),
    buscarInsightsNivelMeta({
      accountId,
      token,
      periodo,
      level: "adset",
      fields: META_INSIGHTS_FIELDS_BY_LEVEL.adset,
      fallbackFields: META_INSIGHTS_SAFE_FIELDS_BY_LEVEL.adset,
      debugMeta,
    }),
    buscarInsightsNivelMeta({
      accountId,
      token,
      periodo,
      level: "ad",
      fields: META_INSIGHTS_FIELDS_BY_LEVEL.ad,
      fallbackFields: META_INSIGHTS_SAFE_FIELDS_BY_LEVEL.ad,
      debugMeta,
    }),
    buscarEdgeMeta({ accountId, token, edge: "adsets", fields: META_ADSET_FIELDS, debugMeta, etapa: "adsets" }),
    buscarEdgeMeta({ accountId, token, edge: "ads", fields: META_AD_FIELDS, debugMeta, etapa: "ads" }),
  ]);

  if (debugMeta) {
    debugMeta.quantidades.insightsComDados = insightsCampanhaRes.dados.length;
    debugMeta.quantidades.insightsComErro = insightsCampanhaRes.erro ? campanhas.length : 0;
    debugMeta.quantidades.adsetsRetornados = adsetsRes.dados.length;
    debugMeta.quantidades.adsRetornados = adsRes.dados.length;
    debugMeta.quantidades.insightsAdsetsComDados = insightsAdsetsRes.dados.length;
    debugMeta.quantidades.insightsAdsComDados = insightsAdsRes.dados.length;
    debugMeta.quantidades.usouFallbackInsights = {
      campaign: insightsCampanhaRes.fallback,
      adset: insightsAdsetsRes.fallback,
      ad: insightsAdsRes.fallback,
    };
  }

  const insightCampanhaPorId = indexarPorCampo(insightsCampanhaRes.dados, "campaign_id");
  const insightCampanhaPorNome = indexarPorCampo(insightsCampanhaRes.dados, "campaign_name");
  const adsetsPorCampanha = agruparPorCampo(adsetsRes.dados, "campaign_id");
  const adsPorCampanha = agruparPorCampo(adsRes.dados, "campaign_id");
  const insightsAdsetsPorCampanha = agruparPorCampo(insightsAdsetsRes.dados, "campaign_id");
  const insightsAdsPorCampanha = agruparPorCampo(insightsAdsRes.dados, "campaign_id");
  const adsetsPorId = indexarPorCampo(adsetsRes.dados, "id");
  const adsPorId = indexarPorCampo(adsRes.dados, "id");
  const insightsAdsetsPorId = indexarPorCampo(insightsAdsetsRes.dados, "adset_id");
  const insightsAdsPorId = indexarPorCampo(insightsAdsRes.dados, "ad_id");

  const campanhasComInsights = campanhas.map((camp) => {
    try {
      const insight = insightCampanhaPorId.get(String(camp.id)) || insightCampanhaPorNome.get(String(camp.name || "")) || {};
      registrarCamposAusentesDebugMeta(debugMeta, insight);
      const metricas = normalizarMetricasInsightMeta(insight);
      const camadas = montarCamadasMetricasMeta(metricas);

      const adsetsMeta = adsetsPorCampanha.get(String(camp.id)) || [];
      const adsetInsights = insightsAdsetsPorCampanha.get(String(camp.id)) || [];
      const adsetIds = new Set([
        ...adsetsMeta.map(a => a.id).filter(Boolean).map(String),
        ...adsetInsights.map(i => i.adset_id).filter(Boolean).map(String),
      ]);
      const adsets = Array.from(adsetIds).map((id) => {
        const adset = adsetsPorId.get(id) || {};
        const adsetInsight = insightsAdsetsPorId.get(id) || {};
        return montarAdsetDetalhadoMeta(adset, adsetInsight);
      });

      const adsMeta = adsPorCampanha.get(String(camp.id)) || [];
      const adInsights = insightsAdsPorCampanha.get(String(camp.id)) || [];
      const adIds = new Set([
        ...adsMeta.map(a => a.id).filter(Boolean).map(String),
        ...adInsights.map(i => i.ad_id).filter(Boolean).map(String),
      ]);
      const criativosPorId = new Map();
      const ads = Array.from(adIds).map((id) => {
        const ad = adsPorId.get(id) || {};
        const adInsight = insightsAdsPorId.get(id) || {};
        const criativo = normalizarCriativoMeta(ad.creative || {});
        if (criativo.creative_id) {
          const existente = criativosPorId.get(criativo.creative_id) || { ...criativo, ad_ids: [], ad_names: [], adset_ids: [] };
          if (ad.id) existente.ad_ids.push(ad.id);
          if (ad.name) existente.ad_names.push(ad.name);
          if (ad.adset_id) existente.adset_ids.push(ad.adset_id);
          criativosPorId.set(criativo.creative_id, existente);
        }
        return montarAdDetalhadoMeta(ad, adInsight, criativo);
      });
      const criativos = Array.from(criativosPorId.values()).map(c => ({
        ...c,
        ad_ids: Array.from(new Set(c.ad_ids)),
        ad_names: Array.from(new Set(c.ad_names)),
        adset_ids: Array.from(new Set(c.adset_ids)),
      }));
      const attribution_setting = Array.from(new Set(adsets.map(a => a.attribution_setting).filter(Boolean)))[0] || null;
      const erros_parciais = montarErrosParciaisMeta({
        insights_campaign: insightsCampanhaRes.erro,
        insights_adset: insightsAdsetsRes.erro,
        insights_ad: insightsAdsRes.erro,
        adsets: adsetsRes.erro,
        ads: adsRes.erro,
      });

      return {
        campanha: camp.name || insight.campaign_name || "Sem nome",
        gasto: metricas.gasto,
        ctr: metricas.ctr,
        cpc: metricas.cpc,
        roas: metricas.roas,
        conversoes: metricas.conversoes,
        add_to_cart: metricas.add_to_cart,
        initiate_checkout: metricas.initiate_checkout,

        campaign_id: camp.id || insight.campaign_id || null,
        status: camp.status || null,
        effective_status: camp.effective_status || null,
        configured_status: camp.configured_status || null,
        objective: camp.objective || null,
        daily_budget: parseBudgetMeta(camp.daily_budget),
        lifetime_budget: parseBudgetMeta(camp.lifetime_budget),
        budget_remaining: parseBudgetMeta(camp.budget_remaining),
        attribution_setting,
        start_time: camp.start_time || null,
        stop_time: camp.stop_time || null,

        impressoes: metricas.impressoes,
        reach: metricas.reach,
        cliques: metricas.cliques,
        link_clicks: metricas.link_clicks,
        cpm: metricas.cpm,
        frequencia: metricas.frequencia,
        view_content: metricas.view_content,
        purchase: metricas.purchase,
        purchase_value: metricas.purchase_value,
        leads: metricas.leads,
        custoPorConversao: metricas.custoPorConversao,
        cost_per_view_content: metricas.cost_per_view_content,
        cost_per_add_to_cart: metricas.cost_per_add_to_cart,
        cost_per_initiate_checkout: metricas.cost_per_initiate_checkout,
        cost_per_purchase: metricas.cost_per_purchase,
        outbound_clicks: metricas.outbound_clicks,
        landing_page_views: metricas.landing_page_views,
        cost_per_outbound_click: metricas.cost_per_outbound_click,
        cost_per_landing_page_view: metricas.cost_per_landing_page_view,
        outbound_ctr: metricas.outbound_ctr,
        link_click_rate: metricas.link_click_rate,
        landing_page_view_rate: metricas.landing_page_view_rate,
        checkout_rate: metricas.checkout_rate,
        purchase_rate: metricas.purchase_rate,
        video_plays: metricas.video_plays,
        thruplays: metricas.thruplays,
        average_watch_time: metricas.average_watch_time,

        resumo: {
          campaign_id: camp.id || insight.campaign_id || null,
          campanha: camp.name || insight.campaign_name || "Sem nome",
          status: camp.status || null,
          objective: camp.objective || null,
          daily_budget: parseBudgetMeta(camp.daily_budget),
          lifetime_budget: parseBudgetMeta(camp.lifetime_budget),
          attribution_setting,
          ...camadas,
        },
        adsets,
        ads,
        criativos,
        erros_parciais,
        erro: insightsCampanhaRes.erro || undefined,
        _actions: metricas._actions,
        _action_values: metricas._action_values,
        _cost_per_action_type: metricas._cost_per_action_type,
      };
    } catch (e) {
      console.warn(`[Meta] Erro ao processar campanha ${camp.name}:`, e.message);
      if (debugMeta) debugMeta.quantidades.insightsComErro += 1;
      registrarErroDebugMeta(debugMeta, {
        etapa: "processar_campanha",
        campanha: camp.name || "Sem nome",
        mensagem: e.message,
      });
      return {
        campanha: camp.name || "Sem nome",
        campaign_id: camp.id || null,
        status: camp.status || null,
        objective: camp.objective || null,
        erro: e.message,
      };
    }
  });

  const resultado = campanhasComInsights.filter(c => c !== null);
  if (debugMeta) return { campanhas: resultado, metaDebug: finalizarDebugMeta(debugMeta, inicioDebug) };
  return resultado;
}

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
function numeroQualidadeTrafego(valor) {
  if (valor == null || valor === "") return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function somaEventosQualidadeTrafego(...valores) {
  return valores.reduce((total, valor) => {
    const numero = numeroQualidadeTrafego(valor);
    return numero == null ? total : total + Math.max(0, numero);
  }, 0);
}

function avaliarQualidadeDadosTrafego(snapshot = {}) {
  const gasto = numeroQualidadeTrafego(snapshot.gasto);
  const impressoes = numeroQualidadeTrafego(snapshot.impressoes);
  const cliques = numeroQualidadeTrafego(snapshot.cliques);
  const outbound = numeroQualidadeTrafego(snapshot.outbound_clicks);
  const lpv = numeroQualidadeTrafego(snapshot.landing_page_views);
  const viewContent = numeroQualidadeTrafego(snapshot.view_content);
  const addToCart = numeroQualidadeTrafego(snapshot.add_to_cart);
  const checkout = numeroQualidadeTrafego(snapshot.initiate_checkout);
  const compras = numeroQualidadeTrafego(snapshot.conversoes ?? snapshot.purchase);
  const leads = numeroQualidadeTrafego(snapshot.leads);
  const adsetsCount = Array.isArray(snapshot.adsets) ? snapshot.adsets.length : 0;
  const adsCount = Array.isArray(snapshot.ads) ? snapshot.ads.length : 0;
  const criativosCount = Array.isArray(snapshot.criativos) ? snapshot.criativos.length : 0;

  let score = 0;
  const sinais = [];
  const motivos = [];
  const eventosPixelPresentes = [viewContent, addToCart, checkout, compras, leads].filter(v => v != null).length;
  const totalEventosPixel = somaEventosQualidadeTrafego(viewContent, addToCart, checkout, compras, leads);

  if (snapshot.erro) motivos.push(`erro parcial: ${snapshot.erro}`);

  if (gasto == null) motivos.push("gasto ausente");
  else if (gasto >= 100) { score += 2; sinais.push("gasto relevante"); }
  else if (gasto >= 30) { score += 1; sinais.push("gasto minimo para leitura inicial"); }
  else if (gasto > 0) { score += 0.5; motivos.push("gasto baixo"); }
  else motivos.push("sem gasto");

  if (impressoes == null) motivos.push("impressoes ausentes");
  else if (impressoes >= 1000) { score += 2; sinais.push("volume de impressoes bom"); }
  else if (impressoes >= 300) { score += 1; sinais.push("volume de impressoes inicial"); }
  else if (impressoes > 0) { score += 0.5; motivos.push("poucas impressoes"); }
  else motivos.push("sem entrega");

  if (cliques == null) motivos.push("cliques ausentes");
  else if (cliques >= 30) { score += 1; sinais.push("volume de cliques util"); }
  else if (cliques >= 10) score += 0.5;

  if (outbound != null) { score += 1; sinais.push("outbound clicks visiveis"); }
  else motivos.push("outbound clicks ausentes");

  if (lpv != null) { score += 1; sinais.push("landing page views visiveis"); }
  else motivos.push("landing page views ausentes");

  if (eventosPixelPresentes >= 3) { score += 2; sinais.push("funil de pixel visivel"); }
  else if (eventosPixelPresentes >= 1) { score += 1; sinais.push("algum evento de pixel visivel"); }
  else motivos.push("sem eventos de pixel visiveis");

  if (compras != null && compras >= 3) { score += 2; sinais.push("volume de compras permite leitura"); }
  else if (totalEventosPixel >= 10) { score += 1.5; sinais.push("volume de eventos permite leitura parcial"); }
  else if (totalEventosPixel > 0) score += 0.5;
  else motivos.push("volume de conversoes/eventos insuficiente");

  if (adsetsCount > 0) score += 0.5;
  else motivos.push("sem detalhe por conjunto");
  if (adsCount > 0) score += 0.5;
  else motivos.push("sem detalhe por anuncio");
  if (criativosCount > 0) score += 0.5;
  else motivos.push("sem criativo identificado");

  const baseMuitoFraca =
    !!snapshot.erro ||
    gasto == null ||
    impressoes == null ||
    impressoes < 100 ||
    (gasto < 20 && totalEventosPixel < 3);

  let classificacao = "dados_ok";
  if (baseMuitoFraca || score < 4.5) classificacao = "dados_fracos";
  else if (score >= 8 && (eventosPixelPresentes >= 2 || compras != null)) classificacao = "dados_bons";

  const confiancaMaxima = classificacao === "dados_bons" ? 90 : classificacao === "dados_ok" ? 70 : 40;
  const resumo = classificacao === "dados_fracos"
    ? "Base fraca: use leitura conservadora e evite pausar ou escalar."
    : classificacao === "dados_bons"
      ? "Base boa: ja da para recomendar com mais firmeza."
      : "Base ok: da para orientar, mas sem agressividade.";

  return {
    classificacao,
    score: Math.round(score * 10) / 10,
    confiancaMaxima,
    resumo,
    sinais: Array.from(new Set(sinais)),
    motivos: Array.from(new Set(motivos)).slice(0, 8),
    bloqueios: classificacao === "dados_fracos"
      ? ["pausar", "duplicar campanha", "criar novo conjunto", "escalar orcamento", "aumentar orcamento"]
      : [],
    base: {
      gasto,
      impressoes,
      cliques,
      outbound_clicks: outbound,
      landing_page_views: lpv,
      eventosPixelPresentes,
      totalEventosPixel,
      compras,
      adsets: adsetsCount,
      ads: adsCount,
      criativos: criativosCount,
    },
  };
}

function textoNormalizadoTrafego(texto = "") {
  return String(texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function recomendacaoForteComDadosFracos(parsed = {}) {
  const acao = textoNormalizadoTrafego(parsed.acao || "");
  if (["pausar", "duplicar campanha", "criar novo conjunto"].includes(acao)) return true;
  const texto = textoNormalizadoTrafego([
    parsed.resposta,
    parsed.justificativa,
    parsed.base_dados,
  ].filter(Boolean).join(" "));
  const textoSemNegacao = texto.replace(
    /\b(nao|sem)\s+([^.;\n]{0,40})?(paus\w*|duplicar campanha|criar novo conjunto|escalar|subir orcamento|aumentar orcamento|aumentar verba|subir verba)/g,
    ""
  );
  return /\bpaus|duplicar campanha|criar novo conjunto|escalar|subir orcamento|aumentar orcamento|aumentar verba|subir verba/.test(textoSemNegacao);
}

function aplicarTravaQualidadeDados(parsed = {}, dataQuality) {
  if (!dataQuality) return parsed;

  const resultado = { ...parsed, dataQuality };
  if (resultado.confianca != null) {
    const confianca = Number(resultado.confianca);
    resultado.confianca = Number.isFinite(confianca)
      ? Math.min(confianca, dataQuality.confiancaMaxima)
      : dataQuality.confiancaMaxima;
  } else if (dataQuality.classificacao === "dados_fracos" && resultado.acao) {
    resultado.confianca = dataQuality.confiancaMaxima;
  }

  if (dataQuality.classificacao !== "dados_fracos") return resultado;
  if (!recomendacaoForteComDadosFracos(resultado)) return resultado;

  return {
    ...resultado,
    resposta: "",
    acao: "aguardar dados",
    justificativa: "Base de dados fraca. Nao vou recomendar pausa, escala ou novo conjunto sem volume minimo confiavel.",
    base_dados: dataQuality.motivos.length ? dataQuality.motivos.join("; ") : dataQuality.resumo,
    confianca: Math.min(resultado.confianca ?? dataQuality.confiancaMaxima, dataQuality.confiancaMaxima),
    bloqueado_por_data_quality: true,
  };
}

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

// Fallback determinístico — rule-based, zero IA, sempre conservador
function fallbackDeterministico(restricoes, campanha, accountConfig, dataQuality = null) {
  let acao = "manter", justificativa = "", base_dados = "";

  if (dataQuality?.classificacao === "dados_fracos") {
    acao = "aguardar dados";
    justificativa = "Dados fracos para decisao agressiva. Vou segurar pausa, escala ou novo conjunto ate ter base melhor.";
    base_dados = dataQuality.motivos?.length ? dataQuality.motivos.join("; ") : dataQuality.resumo;
  } else if (restricoes.some(r => r.tipo === "sem_verba")) {
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

  return { acao, justificativa, base_dados, confianca: 0, fallback: true, dataQuality };
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
        const crmSummary = `[CRM] Total de leads: ${leads.length} | Prospectados hoje: ${prospectadosHoje} | Novos: ${statusCount.novo || 0} | Abordados: ${statusCount.abordado || 0} | Conversando: ${(statusCount.conversando || 0) + (statusCount.respondeu || 0)} | Reunião agendada: ${statusCount.reuniao || 0} | Fechados: ${statusCount.fechado || 0}`;
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

  // @analytics retorna texto natural (sem JSON obrigatório)
  const isAnalytics = nomeAgente === "analytics";
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    ...(isAnalytics ? {} : { response_format: { type: "json_object" } }),
    temperature: isAnalytics ? 0.3 : 0.35,
    max_tokens: 1200,
  });

  const rawText = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { resposta: rawText, acao: null };
  }

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

  const dataQuality = avaliarQualidadeDadosTrafego(campanha);
  const listaCurta = (itens) => Array.isArray(itens) && itens.length ? itens.join("; ") : "nenhum";

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
    `View Content: ${ni(campanha.view_content)} | Outbound: ${ni(campanha.outbound_clicks)} | LPV: ${ni(campanha.landing_page_views)}`,
    `Detalhe: ${dataQuality.base.adsets} conjunto(s), ${dataQuality.base.ads} anuncio(s), ${dataQuality.base.criativos} criativo(s)`,
    ``,
    `DATA QUALITY`,
    `Classificacao: ${dataQuality.classificacao} | Score: ${dataQuality.score}/10 | Confianca maxima: ${dataQuality.confiancaMaxima}%`,
    `Leitura: ${dataQuality.resumo}`,
    `Sinais: ${listaCurta(dataQuality.sinais)}`,
    `Limites: ${listaCurta(dataQuality.motivos)}`,
    dataQuality.classificacao === "dados_fracos"
      ? `REGRA: dados_fracos bloqueia recomendacao forte de pausar, duplicar, criar novo conjunto ou escalar orcamento. Use manter ou aguardar dados.`
      : "",
    ``,
    `FORMATO DA RESPOSTA`,
    `Use exatamente estas linhas por padrao:`,
    `leitura rápida: ...`,
    `hipótese: ...`,
    `ação agora: ...`,
    `não fazer: ...`,
    `Se o usuario pedir analise completa, pode detalhar; caso contrario, responda curto.`,
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
    const fallback = fallbackDeterministico(restricoes, campanha, accountConfig, dataQuality);
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
    // Se resultado é já estruturado (JSON), usa como está
    if (resultado.resposta && typeof resultado.resposta === "object") {
      parsed = resultado.resposta;
    } else if (typeof resultado.resposta === "string" && resultado.resposta.trim().startsWith("{")) {
      // Tenta parsear se parece JSON
      try {
        parsed = JSON.parse(resultado.resposta);
      } catch {
        parsed = { resposta: resultado.resposta, acao: null };
      }
    } else {
      // Resposta em texto natural — não força parseamento
      parsed = {
        resposta: resultado.resposta,
        acao: resultado.acao || null,
        justificativa: resultado.resposta,
        base_dados: ""
      };
    }
  } catch (e) {
    parsed = {
      resposta: resultado.resposta,
      acao: resultado.acao || null,
      justificativa: resultado.resposta,
      base_dados: ""
    };
  }

  // Validar contra restrições
  for (const r of restricoes) {
    if (r.tipo === "sem_verba" && ["duplicar campanha", "criar novo conjunto"].includes(parsed.acao)) {
      console.warn(`[Gestor] Ação "${parsed.acao}" viola restrição sem_verba`);
      parsed.acao = "manter";
      parsed.justificativa = "Restrição ativa: sem orçamento disponível para escalar.";
    }
  }

  parsed = aplicarTravaQualidadeDados(parsed, dataQuality);

  // Audit trail
  await registrarLog({
    accountId,
    campanha: campanha.campanha,
    dados_utilizados: {
      gasto: campanha.gasto, ctr: campanha.ctr, cpc: campanha.cpc,
      roas: campanha.roas, conversoes: campanha.conversoes,
    },
    data_quality: dataQuality,
    contexto_negocio: accountConfig.objetivo,
    restricoes: restricoes.map(r => r.tipo),
    acao_recomendada: parsed?.acao,
    confianca: parsed?.confianca ?? null,
    validacao_status: "ok",
    usou_fallback: false,
    mensagem_usuario: mensagem,
  });

  return { parsed, restricoes, accountConfig, accountId, dataQuality };
}

// Formata resultado para o frontend — mantém texto natural do @analytics
async function chatGestorTrafego(campanha, mensagem, historico, accountKey) {
  const resultado = await analisarCampanha(campanha, mensagem, historico, accountKey);
  const { parsed, dataQuality } = resultado;

  // Se é resposta em texto livre (conversacional), retorna como está
  if (parsed.resposta && typeof parsed.resposta === "string" && parsed.resposta.length > 20 && !parsed.acao) {
    return {
      resposta: parsed.resposta,
      analise: {
        acao: null,
        justificativa: parsed.resposta,
        base_dados: "",
        confianca: dataQuality?.classificacao === "dados_fracos" ? dataQuality.confiancaMaxima : null,
        dataQuality,
        fallback: false,
      },
    };
  }

  // Se e estruturado (JSON), formata no estilo de gestor do trafego.
  const linhas = [];
  const leituraRapida = parsed.base_dados || parsed.justificativa || "Dados lidos.";
  const hipotese = parsed.hipotese || parsed.justificativa || "O principal sinal esta nos dados da campanha.";
  const acaoAgora = parsed.acao || "manter";
  const naoFazer = parsed.nao_fazer || parsed.naoFazer || (
    parsed.bloqueado_por_data_quality || dataQuality?.classificacao === "dados_fracos"
      ? "nao pausar, escalar ou criar conjunto com essa base fraca."
      : "nao fazer varias mudancas ao mesmo tempo."
  );
  linhas.push(`leitura rápida: ${leituraRapida}`);
  linhas.push(`hipótese: ${hipotese}`);
  linhas.push(`ação agora: ${acaoAgora}`);
  linhas.push(`não fazer: ${naoFazer}`);
  if (parsed.confianca != null && parsed.confianca < 50) {
    linhas.push(`confianca: baixa (${parsed.confianca}%).`);
  }

  return {
    resposta: linhas.join("\n"),
    analise: {
      acao: parsed.acao || null,
      justificativa: parsed.justificativa || "",
      base_dados: parsed.base_dados || "",
      confianca: parsed.confianca ?? null,
      dataQuality: parsed.dataQuality || dataQuality,
      bloqueado_por_data_quality: !!parsed.bloqueado_por_data_quality,
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
      c.dataQuality ? `Qualidade dos dados: ${c.dataQuality.classificacao} (${c.dataQuality.score}/10) | ${c.dataQuality.resumo}` : "",
      `Gasto: ${nd(c.gasto, "R$")} | Impressões: ${ni(c.impressoes)} | Cliques: ${ni(c.cliques)}`,
      `CTR: ${nd(c.ctr, "", "%")} | CPC: ${nd(c.cpc, "R$")} | CPM: ${nd(c.cpm, "R$")}`,
      `Frequência: ${nd(c.frequencia, "", "x", 1)}`,
      `Compras: ${ni(c.conversoes)} | Receita: ${nd(c.purchase_value, "R$")} | ROAS: ${nd(c.roas, "", "x")}`,
      `Custo/compra: ${nd(c.custoPorConversao, "R$")}`,
      `Add to Cart: ${ni(c.add_to_cart)} | Checkout iniciado: ${ni(c.initiate_checkout)} | Leads: ${ni(c.leads)}`,
    ];
    return linhas.filter(Boolean).join("\n");
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
      debugProspeccao("rota_recebida", { route: pathname, modo, placeId: placeId || "", ...debugProspeccaoNichoLocal(input) });

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
        let analiseEstruturada;
        let ehNovoCenario = false;

        if (MODO_TESTE) {
          resposta = "[TESTE] Análise manual simulada.";
          analiseEstruturada = criarFallbackManualEstruturado(resposta);
          ehNovoCenario = true;
        } else {
          const resultado = await analisarLeadSDR({
            origem: "manual",
            mensagem,
            estado: estadoManual,
          });
          resposta = resultado.resposta;
          analiseEstruturada = resultado.analiseEstruturada;
          ehNovoCenario = !!resultado.ehNovoCenario;
        }

        if (!analiseEstruturada) {
          analiseEstruturada = criarFallbackManualEstruturado(resposta);
        }

        if (!estadoManual || ehNovoCenario) {
          estadoManual = { cenarioOriginal: mensagem, analiseAtual: resposta, analiseEstruturada };
        } else {
          estadoManual.analiseAtual = resposta;
          estadoManual.analiseEstruturada = analiseEstruturada;
        }

        console.log(`[OK] Manual ${ehNovoCenario ? "nova análise" : "follow-up"} concluído.`);
        return enviarJson(res, 200, { modo: "manual", resposta, analiseEstruturada });
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
          mapsUrl: detalhes.googleMapsUri,
          businessStatus: detalhes.businessStatus,
          endereco: detalhes.formattedAddress,
        };

        const prioridadeOficial = classificarLead(dados.nota, dados.avaliacoes, !!dados.site);
        Object.assign(dados, {
          prioridade: prioridadeOficial,
          origemBusca: input || placeId,
          ...scoreLeadV2({ ...dados, prioridade: prioridadeOficial, origemBusca: input || placeId }),
        });
        let resposta;
        let analiseEstruturada;

        if (MODO_TESTE) {
          resposta = "Teste ativo";
          analiseEstruturada = criarFallbackGoogleEstruturado(prioridadeOficial);
        } else {
          const resultado = await analisarLeadSDR({
            origem: "google",
            dadosLead: dados,
            prioridadeOficial,
            contexto: `google placeId=${placeId}`,
          });
          resposta = resultado.resposta;
          analiseEstruturada = resultado.analiseEstruturada;
        }

        console.log("[OK] Análise Google concluída.");
        return enviarJson(res, 200, {
          modo: "analise",
          dados,
          resposta,
          analiseEstruturada,
        });
      }

      // LEADS
      if (modo === "leads") {
        leadSeenIndex = [];
        const busca = extrairBusca(input);
        const filtrosInput = body?.filtros && typeof body.filtros === "object" ? body.filtros : {};
        const avaliacoesMinRaw = Number.parseInt(filtrosInput.avaliacoesMin, 10);
        const avaliacoesMaxRaw = Number.parseInt(filtrosInput.avaliacoesMax, 10);
        const avaliacoesMin = Number.isFinite(avaliacoesMinRaw) && avaliacoesMinRaw >= 0 ? avaliacoesMinRaw : null;
        const avaliacoesMax = Number.isFinite(avaliacoesMaxRaw) && avaliacoesMaxRaw >= 0 ? avaliacoesMaxRaw : null;
        const filtroAvaliacoesAtivo = avaliacoesMin !== null || avaliacoesMax !== null;

        const PRIORIDADES_VALIDAS = ["ALTA", "MEDIA", "BAIXA", "DESCARTE"];
        const prioridadeAlvoRaw = String(filtrosInput.prioridadeAlvo || "").toUpperCase().trim();
        const prioridadeAlvo = PRIORIDADES_VALIDAS.includes(prioridadeAlvoRaw) ? prioridadeAlvoRaw : null;
        const quantidadeAlvoRaw = Number.parseInt(filtrosInput.quantidadeAlvo, 10);
        const quantidadeAlvo = Number.isFinite(quantidadeAlvoRaw) && quantidadeAlvoRaw > 0
          ? Math.min(quantidadeAlvoRaw, 60)
          : 20;

        const seenIdsRaw = Array.isArray(body?.seenIds) ? body.seenIds : [];
        const seenIdsSet = new Set(seenIdsRaw.map(id => String(id).trim()).filter(Boolean));

        debugProspeccao("leads_busca_recebida", { ...debugProspeccaoNichoLocal(busca), prioridadeAlvo, quantidadeAlvo, seenIdsCount: seenIdsSet.size });

        let lugares = await buscarLugaresLeadsParalelo(busca);
        debugProspeccao("leads_google_resultados", { quantidade: lugares.length });

        if (!lugares.length) {
          debugProspeccao("fallback_ativado", { tipo: "osm", motivo: "google_zero_resultados", busca });
          console.log("[LEADS] Google retornou vazio, tentando OSM...");
          lugares = await buscarLugaresLeadsFallback(busca).catch((err) => {
            debugProspeccaoErro("fallback_osm_erro", err, { busca });
            return [];
          });
          debugProspeccao("leads_fallback_resultados", { tipo: "osm", quantidade: lugares.length });
        }

        if (!lugares.length) {
          debugProspeccao("leads_sem_resultados", debugProspeccaoNichoLocal(busca));
          return enviarJson(res, 200, { erro: "Nenhum resultado encontrado para essa busca." });
        }

        lugares = lugares.filter(l => !l.businessStatus || l.businessStatus === "OPERATIONAL");

        const classificados = lugares.map((l) => {
          const prioridade = classificarLead(l.rating, l.userRatingCount, !!l.websiteUri);
          const lead = {
            id: l.id,
            nome: l.displayName?.text || "Sem nome",
            nota: l.rating || null,
            avaliacoes: l.userRatingCount || null,
            telefone: l.nationalPhoneNumber || null,
            site: l.websiteUri || null,
            mapsUrl: l.googleMapsUri || null,
            businessStatus: l.businessStatus || null,
            endereco: l.formattedAddress || null,
            categoria: l.primaryTypeDisplayName?.text || null,
            prioridade,
            origemBusca: busca,
          };
          return { ...lead, ...scoreLeadV2(lead) };
        });

        // Aplica filtro de avaliações
        let classificadosFiltrados = filtroAvaliacoesAtivo
          ? classificados.filter((lead) => {
              const totalAvaliacoes = Number(lead.avaliacoes);
              if (!Number.isFinite(totalAvaliacoes)) return false;
              if (avaliacoesMin !== null && totalAvaliacoes < avaliacoesMin) return false;
              if (avaliacoesMax !== null && totalAvaliacoes > avaliacoesMax) return false;
              return true;
            })
          : classificados;
        debugProspeccao("leads_filtro_avaliacoes", {
          ativo: filtroAvaliacoesAtivo,
          avaliacoesMin,
          avaliacoesMax,
          totalAntes: classificados.length,
          totalDepois: classificadosFiltrados.length,
        });

        // Aplica filtro de prioridade alvo e limita à quantidade alvo
        if (prioridadeAlvo) {
          classificadosFiltrados = classificadosFiltrados.filter(l => l.prioridade === prioridadeAlvo);
          classificadosFiltrados = classificadosFiltrados.slice(0, quantidadeAlvo);
          debugProspeccao("leads_filtro_prioridade_alvo", {
            prioridadeAlvo,
            quantidadeAlvo,
            totalDepois: classificadosFiltrados.length,
          });
        }

        const classificadosNovos = classificadosFiltrados.filter((lead) => {
          const chave = String(lead.id || lead.telefone || "").trim();
          if (!chave) return false;
          if (seenIdsSet.size > 0 && seenIdsSet.has(chave)) return false;
          return !leadSeenIndex.includes(chave);
        });

        if (!classificadosNovos.length) {
          return enviarJson(res, 200, {
            modo: "leads",
            resumo: { total: 0, alta: 0, media: 0, baixa: 0, descartados: 0 },
            leads: [],
            descartados: [],
          });
        }

        leadSeenIndex.push(
          ...classificadosNovos
            .map((lead) => String(lead.id || lead.telefone || "").trim())
            .filter(Boolean)
        );

        // Filtrar leads já salvos no CRM (persistência cross-sessão)
        const crmData = await lerCRM();
        const crmIds = new Set(
          (crmData.leads || []).map(l => String(l.id || "").trim()).filter(Boolean)
        );
        const semCRM = classificadosNovos.filter(l => {
          const chave = String(l.id || "").trim();
          return !chave || !crmIds.has(chave);
        });
        debugProspeccao("leads_filtro_crm", {
          totalAntes: classificadosNovos.length,
          filtradosCRM: classificadosNovos.length - semCRM.length,
          totalDepois: semCRM.length,
        });

        if (!semCRM.length) {
          return enviarJson(res, 200, {
            modo: "leads",
            resumo: { total: 0, alta: 0, media: 0, baixa: 0, descartados: 0 },
            leads: [],
            descartados: [],
          });
        }

        classificados.length = 0;
        classificados.push(...semCRM);

        const leadsCRMNormalizados = (crmData.leads || []).map(normalizarLeadCRM);
        const statsNicho = new Map();
        leadsCRMNormalizados.forEach((lead) => {
          const chave = String(lead.nichoCanonico || lead.nichoLabel || lead.nicho || lead.categoria || "generico").trim() || "generico";
          if (!statsNicho.has(chave)) {
            statsNicho.set(chave, { abordados: 0, reunioes: 0 });
          }
          const stats = statsNicho.get(chave);
          if (leadCRMAbordado(lead)) stats.abordados += 1;
          if (lead.virouReuniao || ["reuniao", "proposta", "fechado"].includes(lead.status)) stats.reunioes += 1;
        });

        const nichosValidos = Array.from(statsNicho.entries())
          .map(([chave, stats]) => ({
            chave,
            abordados: stats.abordados,
            taxaReuniao: taxaCRM(stats.reunioes, stats.abordados),
          }))
          .filter((item) => item.abordados >= CRM_LEARNING_MIN_AMOSTRA);
        const mediaTaxaReuniao = nichosValidos.length
          ? nichosValidos.reduce((acc, item) => acc + item.taxaReuniao, 0) / nichosValidos.length
          : 0;
        const boostPorNicho = new Map(
          nichosValidos.map((item) => {
            const delta = item.taxaReuniao - mediaTaxaReuniao;
            const boost = Math.max(0, Math.min(8, Math.round(delta / 2)));
            return [item.chave, boost];
          })
        );
        classificados.forEach((lead) => {
          const chave = String(lead.nichoCanonico || lead.nichoLabel || lead.nicho || lead.categoria || "generico").trim() || "generico";
          lead.boostRankingNicho = boostPorNicho.get(chave) || 0;
        });
        debugProspeccao("ranking_nicho_learning", {
          nichosValidos: nichosValidos.length,
          mediaTaxaReuniao: Math.round(mediaTaxaReuniao * 10) / 10,
          boostsAtivos: Array.from(boostPorNicho.entries()).filter(([, boost]) => boost > 0).length,
        });

        debugProspeccao("dados_normalizados", {
          quantidade: classificados.length,
          amostra: classificados.slice(0, 3).map((l) => ({
            id: l.id,
            nome: l.nome,
            prioridade: l.prioridade,
            score: l.score ?? null,
          })),
        });
        debugProspeccao("classificacao_sdr_pre", debugContarPrioridades(classificados));

        classificados.forEach((lead) => {
          lead.analiseEstruturada = criarFallbackGoogleEstruturado(lead.prioridade);
        });
        debugProspeccao("fallback_ativado", { tipo: "analise_estruturada_pre_sdr", total: classificados.length });

        const leads = classificados.filter((l) => l.prioridade !== "DESCARTE");
        const descartados = classificados.filter((l) => l.prioridade === "DESCARTE");

        const ordemPrioridade = { ALTA: 0, MEDIA: 1, BAIXA: 2 };
        leads.sort((a, b) => {
          const diff = ordemPrioridade[a.prioridade] - ordemPrioridade[b.prioridade];
          if (diff !== 0) return diff;
          const scoreAjustadoA = (a.score || 0) + (a.boostRankingNicho || 0);
          const scoreAjustadoB = (b.score || 0) + (b.boostRankingNicho || 0);
          const scoreDiff = scoreAjustadoB - scoreAjustadoA;
          if (scoreDiff !== 0) return scoreDiff;
          return (a.telefone ? 0 : 1) - (b.telefone ? 0 : 1);
        });

        // Cap de pré-computação: só ALTAs + MEDIAs até 5 total
        const CAP_PRECOMPUTE = 5;
        const ordenadosParaAnalise = leads.filter((l) => l.prioridade === "ALTA" || l.prioridade === "MEDIA");
        const altas = ordenadosParaAnalise.filter(l => l.prioridade === "ALTA");
        const medias = ordenadosParaAnalise.filter(l => l.prioridade === "MEDIA");
        const slotsRestantes = Math.max(0, CAP_PRECOMPUTE - altas.length);
        const leadsParaAnalisar = [...altas, ...medias.slice(0, slotsRestantes)];
        debugProspeccao("sdr_lote_preparado", {
          total: leadsParaAnalisar.length,
          altas: altas.length,
          medias: Math.min(medias.length, slotsRestantes),
          modoTeste: MODO_TESTE,
        });

        if (!MODO_TESTE && leadsParaAnalisar.length > 0) {
          const analises = await Promise.all(
            leadsParaAnalisar.map((l) =>
              analisarLeadSDR({
                origem: "google",
                dadosLead: {
                  nome: l.nome,
                  nota: l.nota,
                  avaliacoes: l.avaliacoes,
                  telefone: l.telefone,
                  site: l.site,
                  endereco: l.endereco,
                  categoria: l.categoria,
                  anguloAbordagem: l.anguloAbordagem || "",
                  sinaisFortes: l.sinaisFortes || [],
                  gatilhoConversacional: l.gatilhoConversacional || "",
                },
                prioridadeOficial: l.prioridade,
                contexto: `leads placeId=${l.id}`,
              }).catch((err) => {
                debugProspeccaoErro("sdr_erro", err, { id: l.id, nome: l.nome || "" });
                return null;
              })
            )
          );
          leadsParaAnalisar.forEach((l, i) => {
            if (!analises[i]) return;
            const prioridadeAntes = l.prioridade;
            l.analise = analises[i].resposta;
            l.analiseEstruturada = analises[i].analiseEstruturada;
            l.prioridade = analises[i].analiseEstruturada.prioridade;
            debugProspeccao("classificacao_sdr_lead", {
              id: l.id,
              nome: l.nome || "",
              antes: prioridadeAntes,
              depois: l.prioridade,
            });
          });
        } else if (MODO_TESTE) {
          debugProspeccao("fallback_ativado", { tipo: "modo_teste_sem_sdr", total: leadsParaAnalisar.length });
        }

        const resumo = {
          total: classificados.length,
          alta: leads.filter((l) => l.prioridade === "ALTA").length,
          media: leads.filter((l) => l.prioridade === "MEDIA").length,
          baixa: leads.filter((l) => l.prioridade === "BAIXA").length,
          descartados: descartados.length,
        };

        console.log(`[OK] Leads: ${resumo.alta} ALTA, ${resumo.media} MÉDIA, ${resumo.baixa} BAIXA, ${resumo.descartados} descartados.`);
        debugProspeccao("classificacao_sdr_final", debugContarPrioridades([...leads, ...descartados]));
        return enviarJson(res, 200, { modo: "leads", resumo, leads, descartados });
      }

    } catch (err) {
      debugProspeccaoErro("analisar_rota_erro", err, { route: pathname });
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
      debugProspeccao("rota_recebida", { route: pathname, modo: modo || "" });

      if (modo === "listar") {
        const crm = await lerCRM();
        debugProspeccao("crm_listar_ok", { total: (crm.leads || []).length });
        return enviarJson(res, 200, crm);
      }

      if (modo === "learning") {
        debugProspeccao("crm_learning_leitura_inicio");
        const crm = await lerCRM();
        const learning = calcularCRMLearning(crm.leads || []);
        debugProspeccao("crm_learning_leitura_ok", {
          totalLeads: (crm.leads || []).length,
          abordados: learning?.resumo?.abordados || 0,
        });
        return enviarJson(res, 200, learning);
      }

      if (modo === "radar_sdr") {
        const crm = await lerCRM();
        debugProspeccao("crm_learning_radar_leitura_ok", { totalLeads: (crm.leads || []).length, janelaDias: body.janelaDias || 7 });
        return enviarJson(res, 200, calcularRadarSDR(crm.leads || [], { janelaDias: body.janelaDias }));
      }

      if (modo === "salvar") {
        const crm = await lerCRM();
        const lead = body.lead;
        debugProspeccao("crm_salvar_rota_inicio", { id: lead?.id || "", nome: lead?.nome || "" });
        const existing = crm.leads.find(l => l.id === lead.id);
        if (existing) {
          debugProspeccao("crm_salvar_rota_existente", { id: lead.id, nome: existing.nome || "" });
          return enviarJson(res, 200, { ok: true, lead: existing, jaExiste: true });
        }
        const agora = new Date().toISOString();
        const nichoCanonico = classificarNichoCanonicoLead(lead);
        const novo = {
          id: lead.id,
          nome: lead.nome || "",
          telefone: lead.telefone || null,
          categoria: lead.categoria || null,
          categoriaGoogle: lead.categoriaGoogle || lead.categoria || null,
          nichoCanonico: nichoCanonico.id,
          nichoLabel: nichoCanonico.label,
          endereco: lead.endereco || null,
          site: lead.site || null,
          mapsUrl: lead.mapsUrl || null,
          businessStatus: lead.businessStatus || null,
          nota: lead.nota || null,
          avaliacoes: lead.avaliacoes || null,
          prioridade: lead.prioridade || "BAIXA",
          scoreVersion: lead.scoreVersion || null,
          score: Number.isFinite(Number(lead.score)) ? Number(lead.score) : null,
          scoreConfianca: Number.isFinite(Number(lead.scoreConfianca)) ? Number(lead.scoreConfianca) : null,
          scoreBreakdown: lead.scoreBreakdown || null,
          sinaisFortes: Array.isArray(lead.sinaisFortes) ? lead.sinaisFortes : [],
          sinaisFracos: Array.isArray(lead.sinaisFracos) ? lead.sinaisFracos : [],
          proximoPasso: lead.proximoPasso || "",
          anguloAbordagem: lead.anguloAbordagem || "",
          contextoAbordagem: lead.contextoAbordagem || "",
          gatilhoConversacional: lead.gatilhoConversacional || "",
          riscoTom: lead.riscoTom || "",
          origemBusca: lead.origemBusca || null,
          status: "novo",
          ultimoMovimento: null,
          statusConversa: null,
          needsFollowUp: false,
          ultimaInteracaoEm: null,
          mensagemInicial: lead.mensagemInicial || "",
          tipoMensagemInicial: lead.tipoMensagemInicial || "",
          mensagemFollowUp: lead.mensagemFollowUp || "",
          followUp: "",
          respondeu: false,
          usouFollowUp: false,
          virouReuniao: false,
          estagioFinal: "novo",
          nicho: lead.nicho || lead.nichoLabel || nichoCanonico.label || lead.categoria || "",
          primeiraMensagemEnviadaEm: null,
          followUpEnviadoEm: null,
          respondeuEm: null,
          reuniaoEm: null,
          perdidoEm: null,
          learningTags: [],
          motivoPerda: "",
          mensagensUsadas: [],
          outreachPatternId: lead.outreachPatternId || "",
          outreachVariationUsada: lead.outreachVariationUsada || "",
          ultimaMensagemTipo: lead.ultimaMensagemTipo || "",
          tempoAteRespostaHoras: null,
          tempoAteReuniaoHoras: null,
          resultadoComercial: "sem_contato",
          sinalScoreResultado: "dados_insuficientes",
          notas: "",
          criadoEm: agora,
          atualizadoEm: agora,
        };
        await salvarLead(novo);
        debugProspeccao("crm_salvar_rota_ok", { id: novo.id, nome: novo.nome || "", prioridade: novo.prioridade || "" });
        console.log(`[CRM] Lead salvo: ${novo.nome}`);
        return enviarJson(res, 200, { ok: true, lead: novo });
      }

      if (modo === "atualizar") {
        if (supabase) {
          const { data, error } = await supabase.from("leads").select("*").eq("id", body.id).limit(1).maybeSingle();
          if (error) throw error;
          if (!data) return enviarJson(res, 404, { erro: "Lead não encontrado" });
          const leadAtual = normalizarLeadCRM(data.dados || data);
          const CAMPOS_PERMITIDOS = [
            "status", "ultimoMovimento", "statusConversa", "ultimaInteracaoEm",
            "needsFollowUp", "mensagemInicial", "tipoMensagemInicial", "mensagemFollowUp", "followUp", "notas",
            "respondeu", "usouFollowUp", "virouReuniao", "estagioFinal", "nicho",
            "primeiraMensagemEnviadaEm", "followUpEnviadoEm", "respondeuEm", "reuniaoEm", "perdidoEm",
            "learningTags", "motivoPerda", "mensagensUsadas", "outreachPatternId", "outreachVariationUsada",
            "ultimaMensagemTipo", "tempoAteRespostaHoras", "tempoAteReuniaoHoras", "resultadoComercial", "sinalScoreResultado",
            "site", "mapsUrl", "businessStatus", "categoriaGoogle", "nichoCanonico", "nichoLabel",
            "scoreVersion", "score", "scoreConfianca", "scoreBreakdown", "sinaisFortes", "sinaisFracos",
            "proximoPasso", "anguloAbordagem", "contextoAbordagem", "gatilhoConversacional", "riscoTom", "origemBusca",
          ];
          CAMPOS_PERMITIDOS.forEach(c => {
            if (body[c] !== undefined) leadAtual[c] = body[c];
          });
          leadAtual.atualizadoEm = new Date().toISOString();
          await salvarLead(leadAtual);
          return enviarJson(res, 200, { ok: true, lead: normalizarLeadCRM(leadAtual) });
        }

        const crm = await lerCRM();
        const idx = crm.leads.findIndex(l => l.id === body.id);
        if (idx < 0) return enviarJson(res, 404, { erro: "Lead não encontrado" });
        crm.leads[idx] = normalizarLeadCRM(crm.leads[idx]);
        const CAMPOS_PERMITIDOS = [
          "status", "ultimoMovimento", "statusConversa", "ultimaInteracaoEm",
          "needsFollowUp", "mensagemInicial", "tipoMensagemInicial", "mensagemFollowUp", "followUp", "notas",
          "respondeu", "usouFollowUp", "virouReuniao", "estagioFinal", "nicho",
          "primeiraMensagemEnviadaEm", "followUpEnviadoEm", "respondeuEm", "reuniaoEm", "perdidoEm",
          "learningTags", "motivoPerda", "mensagensUsadas", "outreachPatternId", "outreachVariationUsada",
          "ultimaMensagemTipo", "tempoAteRespostaHoras", "tempoAteReuniaoHoras", "resultadoComercial", "sinalScoreResultado",
          "site", "mapsUrl", "businessStatus", "categoriaGoogle", "nichoCanonico", "nichoLabel",
          "scoreVersion", "score", "scoreConfianca", "scoreBreakdown", "sinaisFortes", "sinaisFracos",
          "proximoPasso", "anguloAbordagem", "contextoAbordagem", "gatilhoConversacional", "riscoTom", "origemBusca",
        ];
        CAMPOS_PERMITIDOS.forEach(c => {
          if (body[c] !== undefined) crm.leads[idx][c] = body[c];
        });
        crm.leads[idx].atualizadoEm = new Date().toISOString();
        crm.leads[idx] = normalizarLeadCRM(crm.leads[idx]);
        await salvarLead(crm.leads[idx]);
        return enviarJson(res, 200, { ok: true, lead: crm.leads[idx] });
      }

      if (modo === "status") {
        if (supabase) {
          const { data, error } = await supabase.from("leads").select("*").eq("id", body.id).limit(1).maybeSingle();
          if (error) throw error;
          if (!data) return enviarJson(res, 404, { erro: "Lead não encontrado" });
          const leadAtual = normalizarLeadCRM(data.dados || data);
          leadAtual.status = body.status;
          leadAtual.atualizadoEm = new Date().toISOString();
          await salvarLead(leadAtual);
          return enviarJson(res, 200, { ok: true });
        }

        const crm = await lerCRM();
        const idx = crm.leads.findIndex(l => l.id === body.id);
        if (idx < 0) return enviarJson(res, 404, { erro: "Lead não encontrado" });
        crm.leads[idx].status = body.status;
        crm.leads[idx].atualizadoEm = new Date().toISOString();
        await salvarLead(crm.leads[idx]);
        return enviarJson(res, 200, { ok: true });
      }

      if (modo === "notas") {
        if (supabase) {
          const { data, error } = await supabase.from("leads").select("*").eq("id", body.id).limit(1).maybeSingle();
          if (error) throw error;
          if (!data) return enviarJson(res, 404, { erro: "Lead não encontrado" });
          const leadAtual = normalizarLeadCRM(data.dados || data);
          leadAtual.notas = body.notas;
          leadAtual.atualizadoEm = new Date().toISOString();
          await salvarLead(leadAtual);
          return enviarJson(res, 200, { ok: true });
        }

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
      debugProspeccaoErro("crm_rota_erro", err, { route: pathname });
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
      const { lead, modo } = body;
      debugProspeccao("rota_recebida", { route: pathname, modo: modo || "variacoes", id: lead?.id || "", nome: lead?.nome || "" });
      if (!lead || !lead.nome) return enviarJson(res, 400, { erro: "lead com nome é obrigatório." });

      if (modo === "principal") {
        debugProspeccao("openai_rota_outreach_chamada", { route: pathname, modo: modo || "principal", id: lead.id || "", nome: lead.nome || "" });
        const mensagem = await gerarMensagemPrincipalOutreach(lead);
        console.log(`[CRM] Mensagem principal gerada via Outreach: ${lead.nome}`);
        return enviarJson(res, 200, { mensagem });
      }

      if (modo === "continuidade") {
        debugProspeccao("openai_rota_outreach_chamada", { route: pathname, modo: "continuidade", id: lead.id || "", nome: lead.nome || "" });
        const mensagem = await gerarMensagemContinuidadeOutreach(lead, body.respostaLead || "");
        console.log(`[CRM] Continuidade gerada via Outreach: ${lead.nome}`);
        return enviarJson(res, 200, { mensagem });
      }

      debugProspeccao("openai_rota_outreach_chamada", { route: pathname, modo: "variacoes", id: lead.id || "", nome: lead.nome || "" });
      const variacoes = await gerarVariacoesOutreach(lead);
      console.log(`[CRM] Variações geradas via Outreach: ${lead.nome}`);
      return enviarJson(res, 200, { variacoes });
    } catch (err) {
      debugProspeccaoErro("outreach_rota_erro", err, { route: pathname });
      console.error("ERRO /api/crm/mensagem:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // POST /api/gerar-variacoes  { lead }
  // Gera 5 variações de mensagem via Outreach (usado pelo drawer de prospecção)
  if (req.method === "POST" && pathname === "/api/gerar-variacoes") {
    try {
      const body = await lerBody(req);
      const { lead, modo } = body;
      debugProspeccao("rota_recebida", { route: pathname, modo: modo || "variacoes", id: lead?.id || "", nome: lead?.nome || "" });
      if (!lead || !lead.nome) return enviarJson(res, 400, { erro: "lead com nome é obrigatório." });

      if (modo === "principal") {
        debugProspeccao("openai_rota_outreach_chamada", { route: pathname, modo: modo || "principal", id: lead.id || "", nome: lead.nome || "" });
        const mensagem = await gerarMensagemPrincipalOutreach(lead);
        console.log(`[OK] Mensagem principal gerada: ${lead.nome}`);
        return enviarJson(res, 200, { mensagem });
      }

      debugProspeccao("openai_rota_outreach_chamada", { route: pathname, modo: "variacoes", id: lead.id || "", nome: lead.nome || "" });
      const variacoes = await gerarVariacoesOutreach(lead);
      console.log(`[OK] Variações geradas: ${lead.nome}`);
      return enviarJson(res, 200, { variacoes });
    } catch (err) {
      debugProspeccaoErro("outreach_rota_erro", err, { route: pathname });
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
    const urlObj = new URL(req.url, `http://localhost`);
    const accountKey = urlObj.searchParams.get("account") || null;
    const debugAtivo = ["1", "true", "sim"].includes(String(urlObj.searchParams.get("debug") || "").toLowerCase());
    const period = urlObj.searchParams.get("period") || urlObj.searchParams.get("periodo") || null;
    try {
      // Lê accountKey da query string — ?account=rivano ou ?account=com_tempero
      const resultadoMeta = await buscarInsightsMeta(accountKey, { debug: debugAtivo, period });
      const campanhas = Array.isArray(resultadoMeta) ? resultadoMeta : (resultadoMeta.campanhas || []);
      campanhas.forEach(c => {
        if (c && !c.dataQuality) c.dataQuality = avaliarQualidadeDadosTrafego(c);
      });
      // Só analisa se houver campanhas
      const analise = campanhas.length > 0 ? await analisarCampanhas(campanhas) : null;
      const nomeConta = accountKey ? (ACCOUNT_CONFIG[accountKey]?.name || accountKey) : "conta padrão";
      console.log(`[OK] Insights Meta (${nomeConta}): ${campanhas.length} campanha(s).`);
      const payload = { campanhas, analise };
      if (debugAtivo && !Array.isArray(resultadoMeta)) payload.metaDebug = resultadoMeta.metaDebug;
      return enviarJson(res, 200, payload);
    } catch (err) {
      console.error("ERRO Meta:", err.message);
      // Retorna 200 com erro descritivo — frontend exibe mensagem útil, não crash
      const payloadErro = {
        campanhas: [],
        analise: null,
        erro: err.message,
        tipo_erro: err.tipo || "desconhecido",
      };
      if (debugAtivo && err.metaDebug) payloadErro.metaDebug = err.metaDebug;
      return enviarJson(res, 200, payloadErro);
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

      // DELEGAÇÃO: Se @analytics + pergunta sobre tráfego, analisa com dados reais
      if (nomeAgente === "analytics") {
        const msgLower = texto.toLowerCase();
        const temPalavrasTrafe = ["campanha", "tráfego", "ad", "ads", "roas", "ctr", "cpc", "criativo", "anúncio", "performance", "gasto", "análise", "conjunto", "gestor"];
        const temPalavra = temPalavrasTrafe.some(p => msgLower.includes(p));

        if (temPalavra) {
          try {
            let accountKey = "rivano";
            if (msgLower.includes("tempero") || msgLower.includes("com tempero")) {
              accountKey = "com_tempero";
            }

            const campanhas = await buscarInsightsMeta(accountKey);
            if (campanhas && campanhas.length > 0) {
              const campanha = campanhas[0];
              const resultado = await analisarCampanha(campanha, texto, [], accountKey);
              console.log(`[OK] @analytics → traffic analysis (${accountKey}) — ${resultado.parsed?.acao}`);
              return enviarJson(res, 200, {
                agente: nomeAgente,
                resposta: resultado.parsed?.justificativa || "Análise realizada",
                acao: resultado.parsed?.acao || null,
                trocas: 1,
              });
            }
          } catch (e) {
            console.warn(`[Analytics delegation] ${e.message}`);
            // Falls through to normal processing
          }
        }
      }

      // Processa através do agente normalmente
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

module.exports = { handler };// Deploy timestamp: Sun Apr 26 19:53:23 HPB 2026
