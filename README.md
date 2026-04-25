# Lumyn — Plataforma de Prospecção com IA

API de análise inteligente para leads, integrada com Google Maps, OpenAI e Meta Ads.

## Setup Local

```bash
# 1. Instalar dependências
npm install

# 2. Configurar .env (copiar de .env.example ou criar manualmente)
# Variáveis obrigatórias:
# - OPENAI_API_KEY
# - GOOGLE_API_KEY
# - SUPABASE_URL (opcional, fallback para arquivo local)
# - SUPABASE_KEY (opcional)

# 3. Rodar servidor
node server.js
# Abre em http://localhost:3000
```

## Deploy no Vercel

### Via CLI (recomendado para primeira vez)

```bash
npm install -g vercel
vercel login
vercel --prod
```

### Via GitHub (recomendado para CI/CD)

1. Push para GitHub: `git push origin main`
2. Acesse https://vercel.com/new
3. Selecione "Import Git Repository"
4. Escolha este repo
5. Em "Environment Variables", adicione:
   - `OPENAI_API_KEY`
   - `GOOGLE_API_KEY`
   - `GEMINI_API_KEY`
   - `META_ACCESS_TOKEN`
   - `META_AD_ACCOUNT_ID`
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
6. Clique "Deploy"

### Pós-Deploy

Após deploy, o app estará em: `https://<seu-projeto>.vercel.app`

**Importante:** 
- A pasta `uploads/` é efêmera no Vercel — use Supabase Storage (já configurado)
- O arquivo `leads-crm.json` local também é efêmero — use Supabase (já integrado)
- Todas as imagens são armazenadas no Supabase Storage (`rivano`, `com-tempero`)
- Todos os leads são persistidos no Supabase PostgreSQL

## Estrutura

```
├── server.js              # Entry point local
├── api/handler.js         # Handler para Vercel (mesma lógica)
├── index.html             # Frontend
├── vercel.json            # Config Vercel
├── .env                   # Variáveis de ambiente (não commitar)
└── leads-crm.json         # Local CRM (fallback, não use em produção)
```

## Endpoints

- `GET /` — Frontend (index.html)
- `POST /api/analisar` — Análise SDR (manual ou Google)
- `POST /api/buscar-leads` — Buscar por categoria + cidade
- `POST /api/criativos/upload` — Upload de imagem
- `POST /api/criativos/analisar-e-briefar` — Gerar briefing automático
- `POST /api/criativos/gerar` — Gerar 3 variações de criativo
- `GET /api/crm` — Listar todos os leads
- `POST /api/crm/salvar` — Salvar lead
- `POST /api/crm/remover` — Remover lead
- `GET /api/criativos/listar` — Listar imagens armazenadas

## Variáveis de Ambiente Necessárias

| Variável | Descrição | Obrigatória |
|---|---|---|
| `OPENAI_API_KEY` | Chave da API OpenAI (para análises e geração de prompts) | ✔️ |
| `GOOGLE_API_KEY` | Chave da Google Places API | ✔️ |
| `GEMINI_API_KEY` | Chave Google Gemini (para edição de imagens) | ❌ |
| `META_ACCESS_TOKEN` | Token de acesso Meta Ads | ❌ |
| `META_AD_ACCOUNT_ID` | ID da conta de anúncios Meta | ❌ |
| `SUPABASE_URL` | URL do projeto Supabase | ❌ |
| `SUPABASE_KEY` | Chave de serviço do Supabase | ❌ |

## PWA (Progressive Web App)

Para usar como app no celular:
1. Acesse a URL do Vercel no navegador do celular
2. Menu → "Instalar" (ou "Add to Home Screen")
3. O app estará disponível offline com cache

Manifesto: `manifest.json` (em desenvolvimento)
Service Worker: `sw.js` (em desenvolvimento)

## Troubleshooting

### "Supabase not configured"
Se SUPABASE_URL/KEY não forem configuradas:
- CRM usa arquivo local (`leads-crm.json`)
- Storage usa pasta local (`uploads/`)
- Funcionamento normal em desenvolvimento

### "Bucket not found"
Supabase Storage buckets são criados automaticamente no primeiro uso. Se errar:
1. Acesse https://supabase.com → seu projeto
2. Storage → Create new bucket: `rivano`, `com-tempero` (ambos public)
3. Reinicie o servidor

### "column leads.id does not exist"
A tabela PostgreSQL não foi criada no Supabase:
1. Acesse Supabase → SQL Editor
2. Execute:
```sql
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  dados JSONB NOT NULL
);
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON leads FOR ALL USING (true);
```
3. Reinicie o servidor

## Stack Técnico

- **Backend:** Node.js puro (módulo `http` nativo, sem Express)
- **Frontend:** Vanilla JS + HTML + CSS
- **IA:** OpenAI GPT-4o, Gemini 2.5 Flash
- **Dados:** Supabase PostgreSQL + Storage
- **APIs externas:** Google Places, Meta Ads
- **Deploy:** Vercel Serverless Functions

---

**Última atualização:** Abril 2026
