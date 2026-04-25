# Workflow padrão do time Lumyn

## Toda mudança segue estas 4 etapas. Nunca pule uma.

---

## 1. Diagnóstico

**Quem:** `product-architect` ou `sdr-copy` (depende da natureza do problema)

**O que faz:**
- Identifica a causa raiz — não o sintoma
- Mapeia quais arquivos e módulos são afetados
- Classifica: bug / refinamento / feature nova / mudança de lógica

**Entrega:** causa identificada + arquivos afetados + tipo de mudança

**Regra:** ninguém escreve código antes desta etapa estar concluída.

---

## 2. Proposta

**Quem:** `product-architect`

**O que faz:**
- Define o plano de ação com passos ordenados
- Atribui cada passo ao agente correto
- Aponta riscos e o que pode quebrar
- Documenta se a decisão afeta o CLAUDE.md

**Entrega:** plano aprovado pelo usuário

**Regra:** implementação só começa após aprovação explícita.

---

## 3. Implementação

**Quem:** agente responsável pelo domínio da mudança

| Tipo de mudança | Agente |
|---|---|
| Lógica SDR, prompts, copy | `sdr-copy` |
| CSS, componentes, design system | `ux-premium` |
| CRM, histórico, persistência, rotas | `growth-ops` |
| Integração Meta Ads / tráfego | `growth-ops` + `product-architect` |

**Regra:** cada agente toca apenas o seu domínio. Se a mudança cruzar domínios, os agentes atuam em sequência — nunca em paralelo no mesmo arquivo.

---

## 4. Teste

**Quem:** `builder-qa`

**O que faz:**
- Revisa o que foi implementado contra o checklist do CLAUDE.md
- Verifica estados não tratados (sem telefone, sem análise, API offline)
- Confirma que nenhuma funcionalidade existente foi quebrada
- Classifica issues encontrados por severidade e atribui ao agente dono

**Entrega:** lista de issues (se houver) ou aprovação para o usuário testar

**Regra:** o usuário só testa após o builder-qa aprovar.

---

## Fluxo resumido

```
Usuário descreve problema ou feature
           │
           ▼
    1. DIAGNÓSTICO
    product-architect / sdr-copy
           │
           ▼
     2. PROPOSTA
    product-architect
    ── aguarda aprovação do usuário ──
           │
           ▼
   3. IMPLEMENTAÇÃO
   sdr-copy / ux-premium / growth-ops
           │
           ▼
      4. TESTE
      builder-qa
    ── aprovação → usuário testa ──
```

---

## Exceções permitidas

| Situação | Atalho |
|---|---|
| Bug visual óbvio (cor errada, padding quebrado) | `ux-premium` direto, sem proposta formal |
| Ajuste de copy em UI sem impacto em lógica | `sdr-copy` direto |
| Hotfix crítico que quebrou fluxo em produção | Implementar → `builder-qa` imediato |
