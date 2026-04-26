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

// ── AGENTES ──────────────────────────────────────────────────────────────────
// Histórico leve por agente: últimas 6 mensagens (3 trocas)
const historicoAgentes = { director: [], designer: [], gestor: [], outreach: [] };
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
Responda em JSON: {"resposta":"...","acao":null}`
};

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

async function buscarInsightsMeta() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    throw new Error("META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID não definidos no .env");
  }

  const fields = "campaign_name,spend,impressions,clicks,cpc,ctr";
  const url = `https://graph.facebook.com/v19.0/act_${META_AD_ACCOUNT_ID}/insights?fields=${fields}&date_preset=last_30d&level=campaign&access_token=${META_ACCESS_TOKEN}`;

  const resp = await fetch(url);
  const json = await resp.json();

  if (json.error) throw new Error(json.error.message);

  return (json.data || []).map((c) => ({
    campanha: c.campaign_name || "Sem nome",
    gasto: parseFloat(c.spend || 0),
    impressoes: parseInt(c.impressions || 0),
    cliques: parseInt(c.clicks || 0),
    cpc: parseFloat(c.cpc || 0),
    ctr: parseFloat(c.ctr || 0),
  }));
}

async function chatGestorTrafego(campanha, mensagem, historico) {
  const sistema = `Você é um gestor de tráfego pago experiente. Responde de forma direta e prática, sem teoria longa. Sempre termina com uma ação concreta. Máximo 4 parágrafos curtos por resposta.

Dados da campanha em foco:
Nome: ${campanha.campanha}
Gasto (30d): R$ ${campanha.gasto.toFixed(2)}
Impressões: ${campanha.impressoes.toLocaleString("pt-BR")}
Cliques: ${campanha.cliques.toLocaleString("pt-BR")}
CTR: ${campanha.ctr.toFixed(2)}%
CPC: R$ ${campanha.cpc.toFixed(2)}

Regras de diagnóstico:
- CTR < 1% → criativo fraco, trocar ângulo ou formato
- CPC > R$ 5 → público ruim ou leilão competitivo
- Gasto alto com cliques = 0 → problema de entrega ou pixel mal configurado
- Impressões altas e cliques baixos → criativo não chama atenção
- Tudo baixo (gasto < R$5, impressões < 100) → campanha não está entregando, revisar orçamento e status`;

  const msgs = [
    { role: "system", content: sistema },
    ...historico.map((h) => ({ role: h.tipo === "user" ? "user" : "assistant", content: h.texto })),
    { role: "user", content: mensagem },
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: msgs,
    max_tokens: 350,
    temperature: 0.3,
  });

  return resp.choices[0].message.content.trim();
}

async function analisarCampanhas(campanhas) {
  const prompt = `
Você é um especialista em tráfego pago. Analise as campanhas abaixo e retorne um diagnóstico direto.

Campanhas:
${JSON.stringify(campanhas, null, 2)}

Regras de análise:
- gasto > 100 e cliques = 0 → problema grave de entrega ou segmentação
- ctr < 1% → criativo fraco
- cpc alto (> R$5 para negócio local) → público ruim ou leilão competitivo
- impressões altas e cliques baixos → criativo não chama atenção
- tudo baixo (gasto < 5, impressões < 100) → campanha não está entregando

Retorne SOMENTE um JSON válido neste formato, sem texto adicional:
{
  "resumo": "frase curta e direta sobre o estado geral das campanhas",
  "problemas": ["problema 1", "problema 2"],
  "acoes": ["ação 1", "ação 2", "ação 3"]
}
`.trim();

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
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
      const { campanha, mensagem, historico = [] } = body;
      if (!campanha || !mensagem) {
        return enviarJson(res, 400, { erro: "campanha e mensagem são obrigatórios." });
      }
      const resposta = await chatGestorTrafego(campanha, mensagem, historico);
      console.log("[OK] Chat tráfego respondido.");
      return enviarJson(res, 200, { resposta });
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

  // GET /ads/insights
  if (req.method === "GET" && pathname === "/ads/insights") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const campanhas = await buscarInsightsMeta();
      const analise = await analisarCampanhas(campanhas);
      console.log("[OK] Insights Meta carregados.");
      return enviarJson(res, 200, { campanhas, analise });
    } catch (err) {
      console.error("ERRO Meta:", err.message);
      return enviarJson(res, 500, { erro: err.message });
    }
  }

  // ── ROTAS DE AGENTES ─────────────────────────────────────────────────────
  // POST /api/director | /api/designer | /api/gestor | /api/outreach
  const AGENTES_VALIDOS = ["director", "designer", "gestor", "outreach"];
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

      const systemPrompt = PROMPTS_AGENTES[nomeAgente];
      const hist = historicoAgentes[nomeAgente];

      // Auto-contexto do CRM se pergunta menciona leads/performance
      let autoContext = context;
      if (nomeAgente === "director" || nomeAgente === "gestor") {
        const palavrasChave = ["prospectei", "leads", "hoje", "pipeline", "quantos", "performance", "contatos", "responderam", "fechei"];
        const temPalavra = palavrasChave.some(p => texto.toLowerCase().includes(p));
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
            autoContext = autoContext ? `${crmSummary}\n\n${context}` : crmSummary;
          } catch (e) { /* silently fail, use context normal */ }
        }
      }

      const userContent = autoContext && autoContext.trim()
        ? `Contexto: ${autoContext.trim()}\n\n${texto}`
        : texto;

      const messages = [
        { role: "system", content: systemPrompt },
        ...hist,
        { role: "user", content: userContent }
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.35,
        max_tokens: 1000
      });

      const rawText = completion.choices[0].message.content;
      let parsed;
      try { parsed = JSON.parse(rawText); } catch { parsed = { resposta: rawText, acao: null }; }

      // Valida acao contra enum (sem "executar")
      if (!ACOES_VALIDAS.has(parsed.acao)) parsed.acao = null;

      // Atualiza histórico — mantém últimas 6 msgs (3 trocas)
      historicoAgentes[nomeAgente].push({ role: "user", content: userContent });
      historicoAgentes[nomeAgente].push({ role: "assistant", content: rawText });
      if (historicoAgentes[nomeAgente].length > 6) {
        historicoAgentes[nomeAgente] = historicoAgentes[nomeAgente].slice(-6);
      }

      console.log(`[OK] Agente ${nomeAgente} respondeu. Trocas no contexto: ${historicoAgentes[nomeAgente].length / 2}/3`);
      return enviarJson(res, 200, {
        resposta: parsed.resposta || "",
        acao: parsed.acao || null,
        trocas: historicoAgentes[nomeAgente].length / 2
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
      if (agente && historicoAgentes[agente] !== undefined) {
        historicoAgentes[agente] = [];
        return enviarJson(res, 200, { ok: true, agente });
      }
      // Reset todos
      Object.keys(historicoAgentes).forEach(k => { historicoAgentes[k] = []; });
      return enviarJson(res, 200, { ok: true, agente: "todos" });
    } catch (err) {
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