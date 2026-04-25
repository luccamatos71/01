# Checklist de Deploy — Vercel

## Antes de Fazer Deploy

- [ ] Supabase configurado e testado localmente
  - [ ] Tabela `leads` criada (com RLS + policy)
  - [ ] Buckets `rivano` e `com-tempero` criados (public)
  - [ ] `.env` tem SUPABASE_URL + SUPABASE_KEY
  
- [ ] APIs OpenAI e Google configuradas
  - [ ] OPENAI_API_KEY funciona (teste: POST /api/analisar)
  - [ ] GOOGLE_API_KEY funciona (teste: buscar lead por Maps)

- [ ] Servidor local roda sem erros
  ```bash
  node server.js
  # Deve mostrar: ✔  Servidor rodando em http://localhost:3000
  ```

- [ ] `.gitignore` adicionado (não commitar .env, node_modules/, uploads/)

- [ ] `vercel.json` + `api/handler.js` + `server.js` refatorizado

## Opção A: Deploy via CLI (Mais Controle)

```bash
# 1. Instalar Vercel CLI
npm install -g vercel

# 2. Login
vercel login

# 3. Deploy em preview (recomendado testar primeiro)
vercel

# 4. Deploy em produção
vercel --prod
```

**Durante deploy, Vercel perguntará:**
```
? Set up and deploy "~/IA - APP - LUMYN"? [Y/n] Y
? Which scope should contain your project? [seu-user]
? Link to existing project? [y/N] N (primeira vez) ou Y (atualizar)
? What's your project's name? lumyn
? In which directory is your code? [.] (Enter)
? Want to override the settings? [y/N] N
```

Depois **configure env vars no Vercel:**
1. https://vercel.com/dashboard
2. Seu projeto → Settings → Environment Variables
3. Adicione cada uma das 8 variáveis (ver README.md)
4. Redeploy: `vercel --prod`

---

## Opção B: Deploy via GitHub (Automático)

**1. Criar repositório GitHub**
```bash
git init
git add .
git commit -m "Initial commit — Lumyn app ready for Vercel"
git branch -M main
git remote add origin https://github.com/seu-usuario/lumyn.git
git push -u origin main
```

**2. Conectar Vercel ao GitHub**
- Acesse https://vercel.com/new
- "Import Git Repository"
- Escolha seu repo `seu-usuario/lumyn`
- Vercel detecta `vercel.json` automaticamente

**3. Configurar Environment Variables**
- Na tela "Environment Variables" antes de deploy, adicione:
  - OPENAI_API_KEY = `sk-...`
  - GOOGLE_API_KEY = `AIza...`
  - SUPABASE_URL = `https://...supabase.co`
  - SUPABASE_KEY = `eyJ...`
  - META_ACCESS_TOKEN (se usar)
  - META_AD_ACCOUNT_ID (se usar)
  - GEMINI_API_KEY (se usar)

**4. Deploy**
- Clique "Deploy"
- Vercel compila e serve automaticamente
- URL: `https://lumyn-xxx.vercel.app`

**5. Atualizações futuras**
- Faça push para main: `git push origin main`
- Vercel redeploya automaticamente (webhook)

---

## Verificar Deploy

Após deploy bem-sucedido:

```bash
# Teste o endpoint (substitua com sua URL Vercel)
curl -X GET https://seu-projeto.vercel.app/

# Deve retornar o HTML do index.html
# Se der 404 ou erro, check Vercel logs: vercel logs seu-projeto
```

---

## Troubleshooting Deploy

### "Build failed"
1. Veja logs: `vercel logs seu-projeto --follow`
2. Comum: variável de env faltando
3. Solução: adicione em Vercel Dashboard → Environment Variables

### "404 on API endpoints"
1. Verifique `vercel.json` routes
2. Verifique que `api/handler.js` está no root do projeto (não em node_modules)
3. Redeploy: `vercel --prod`

### "Image upload failed"
1. Supabase Storage buckets precisam ser public
2. Verify em Supabase Dashboard → Storage
3. Se precisar criar: clique "New Bucket" → name: `rivano` → unchecked "Private"

### "Supabase connection failed"
1. Verify env vars: SUPABASE_URL + SUPABASE_KEY estão corretos
2. Testar no Supabase: https://supabase.com → seu projeto → API
3. Copy exatos: SUPABASE_URL e chave de service_role

---

## Rollback

Se algo deu errado após deploy:

```bash
# Ver deployments
vercel list

# Fazer rollback para deployment anterior
vercel rollback
```

Ou via GitHub: revert o último commit e push para main.

---

## Monitoramento Pós-Deploy

- **Analytics:** https://vercel.com/dashboard → seu projeto → Analytics
- **Logs:** `vercel logs seu-projeto --follow`
- **Erros:** Monitor OpenAI/Google API quotas

---

## Dicas

- **Local testing antes de deploy:** `PORT=3001 node server.js` (testar com porta diferente)
- **Testar Supabase antes:** confirmar que leads migraram e buckets estão Ok
- **Usar preview deployments:** `vercel` (sem --prod) para staging antes de produção
- **Monitorar quotas:** OpenAI e Google APIs têm limites — configure alertas nas dashboards

---

**Pronto para deploy! 🚀**
