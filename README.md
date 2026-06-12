# RELATORIOS

Web App em Google Apps Script para geração do Relatório Analítico COSEP com dados em Google Sheets.

## Arquitetura

O app segue o princípio **"dados no navegador"**:

1. O backend (`Code.gs`) lê a base CRP **uma única vez**, classifica cada item dos
   indicadores (Conforme / Não conforme / Não se aplica / vazio) e devolve um
   dataset compacto (uma string de flags por registro).
2. O frontend (`index.html`) faz **todo o filtro e agregação no navegador** —
   mudar um filtro recalcula o relatório instantaneamente, sem novas chamadas
   ao Apps Script.
3. O documento A4 é renderizado ao vivo; os textos narrativos são **editáveis
   diretamente no documento** (clique no parágrafo). Seções editadas à mão não
   são sobrescritas ao mudar filtros e podem ser restauradas para o texto
   automático individualmente.

Outras decisões de projeto:

- **Sem dependências obrigatórias de CDN**: CSS próprio, fontes do sistema e
  gráficos em SVG gerados pelo app. O único recurso externo opcional é a
  biblioteca `html2pdf` (botão "Baixar PDF"); se o CDN estiver bloqueado, o
  botão "Imprimir" gera o mesmo documento via navegador (texto vetorial).
- **Sem truncamento**: as páginas A4 usam `min-height` (nunca `height` fixo com
  `overflow: hidden`), então texto longo flui para a página seguinte na
  impressão em vez de ser cortado silenciosamente.
- **Backend em um único arquivo**: a antiga camada `Z_ConfigRelTextos.gs`
  (que redefinia funções do `Code.gs` contando com a ordem de carregamento)
  foi consolidada no próprio `Code.gs`.

## Estrutura da planilha

A planilha do relatório deve conter, no mínimo:

- `BASE_DADOS(NÃOEDITAR)`: base principal CRP com cabeçalhos de `A` até `AQ`.
- `CRO`: base futura/alternativa para CRO, quando disponível.
- `COSEP_REL_CONFIG`: aba criada automaticamente pelo app para guardar configurações editáveis do relatório.
- `COSEP_REL_CONFIG_LOG`: aba criada automaticamente para histórico de alterações administrativas.

## Filtros disponíveis

O relatório CRP suporta filtros por ano, mês, setor/unidade, eixo, categoria,
satisfação e status da avaliação. Os filtros são **facetados**: cada lista
mostra a contagem de registros considerando os demais filtros ativos.

A comissão `CRO` permanece como recurso futuro, desativada na interface.

## Documento gerado

- Página 1 — capa com placar de conformidade × meta, métricas, introdução,
  metodologia e gráficos (evolução mensal e distribuição dos itens).
- Página 2 — análise crítica, alertas de estrutura da base, indicadores
  críticos e fortalezas do recorte.
- Página 3 — setores com maior oportunidade, plano de ação, conclusão e
  bloco de assinaturas.
- Página 4 (opcional) — anexo com o desempenho completo dos 29 indicadores.

## Administração do relatório

A aba `COSEP_REL_CONFIG` armazena:

- meta institucional;
- ID da planilha do relatório e nome da aba da base CRP;
- tipo do relatório (executivo / técnico / síntese);
- URLs do logo do cabeçalho e da imagem do rodapé;
- mensagens padrão das cinco seções narrativas (com tokens);
- termos de classificação (`Conforme`, `Não conforme`, `Não se aplica`);
- nomes editáveis dos 29 indicadores da CRP;
- dados da última atualização.

A edição recomendada é pelo painel **Admin** dentro do app. Use
**Recarregar da planilha** quando alguém editar `COSEP_REL_CONFIG`
diretamente. Salvar configurações relê automaticamente a base, pois termos e
indicadores afetam a classificação dos itens.

Para restringir quem pode salvar, defina a Script Property `COSEP_REL_ADMINS`
com e-mails separados por vírgula ou ponto e vírgula.

## Rotas e RPCs

| Acesso | Função |
| --- | --- |
| `doGet` | serve o app |
| `doGet?api=dados` (`&refresh=1`) | dataset compacto + configuração pública |
| `doGet?api=configrel` (`&refresh=1`) | configuração completa |
| `obterDadosRelatorio({refresh})` | mesmo payload de `api=dados` |
| `obterConfigRelCosep(refresh)` / `salvarConfigRelCosep(cfg)` / `restaurarConfigRelCosep()` | administração |

## Publicação no Apps Script

Arquivos do projeto:

- `Code.gs`: backend completo (rotas JSON, leitura da planilha, classificação, configuração e log).
- `index.html`: interface, agregação client-side, documento A4 e exportação.
- `appsscript.json`: manifesto mínimo com runtime V8 e fuso `America/Fortaleza`.

Para publicar manualmente, copie os arquivos para o projeto Apps Script vinculado ao Web App e faça um novo deploy.

Se usar `clasp`, configure o `.clasp.json` local apontando para o Script ID do projeto e execute:

```bash
clasp push
clasp deploy
```

Não versionar `.clasp.json` se ele contiver identificadores de ambiente que não devem ser compartilhados.
