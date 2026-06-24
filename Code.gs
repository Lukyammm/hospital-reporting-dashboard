/***********************************************************************
 * RELATÓRIO ANALÍTICO CRP — backend Apps Script
 *
 * Arquitetura: o servidor lê a base CRP uma única vez por requisição,
 * classifica cada item dos indicadores (Conforme / Não conforme / N.A.)
 * e devolve um dataset compacto. Todo o filtro, agregação e montagem do
 * documento acontecem no navegador — sem novas viagens ao servidor a
 * cada mudança de filtro.
 *
 * Rotas:
 *   doGet                      → serve index.html
 *   doGet?api=dados            → dataset compacto + configuração pública
 *   doGet?api=configrel        → configuração completa (admin)
 *
 * RPCs (google.script.run):
 *   obterDadosRelatorio()      → mesmo payload de api=dados
 *   obterConfigRelCRP()      → configuração completa (admin)
 *   salvarConfigRelCRP(cfg)  → grava configuração
 *   restaurarConfigRelCRP()  → restaura configuração padrão
 ***********************************************************************/

/* ===== Parametrização ===== */
const PLANILHAS = {
  principal: '1XUtI9TSMJmTpbtfLjZbJ-uarRN94lu_Aqpsc46Lxmt4',
  relatorios: '1DjE-1Gx33RfWPkUtUW883-5SM2NVdeuDsq4wQ0XxGUw',
  // Planilha de gerenciamento das análises dos óbitos (CRO). A base da CRO fica
  // numa planilha própria; pode ser sobrescrita por cfg.planilhaIdCRO.
  relatoriosCRO: '1Tqit0LGFH9-5WZVNj3mhJZdBxw1bpm2TUxeXL2WDMy8'
};
const ABA_RELATORIO_CRP = 'BASE_DADOS(NÃOEDITAR)';
const ABA_RELATORIO_CRO = 'CRO';
const ABA_CRO_MORTALIDADE_INST = 'TX_MORTALIDADE_INST';
const FUSO_HORARIO = 'America/Fortaleza';
const META_INSTITUCIONAL = 80;
const LOGO_PADRAO = 'https://i.ibb.co/tTGkBCXj/oie-transparent.png';
const RODAPE_PADRAO = 'https://i.ibb.co/VYv0RyF3/Rodape-1.png';
const CACHE_EXECUCAO_PLANILHAS = {};
const CACHE_EXECUCAO_BASE_RELATORIO = {};

const ORDEM_MESES = {
  'JANEIRO': 1, 'FEVEREIRO': 2, 'MARÇO': 3, 'MARCO': 3, 'ABRIL': 4,
  'MAIO': 5, 'JUNHO': 6, 'JULHO': 7, 'AGOSTO': 8, 'SETEMBRO': 9,
  'OUTUBRO': 10, 'NOVEMBRO': 11, 'DEZEMBRO': 12,
  'JAN': 1, 'JAN.': 1, 'FEV': 2, 'FEV.': 2, 'MAR': 3, 'MAR.': 3,
  'ABR': 4, 'ABR.': 4, 'MAI': 5, 'MAI.': 5, 'JUN': 6, 'JUN.': 6,
  'JUL': 7, 'JUL.': 7, 'AGO': 8, 'AGO.': 8, 'SET': 9, 'SET.': 9,
  'OUT': 10, 'OUT.': 10, 'NOV': 11, 'NOV.': 11, 'DEZ': 12, 'DEZ.': 12
};
const MESES_CANONICOS = {
  1: 'Janeiro', 2: 'Fevereiro', 3: 'Março', 4: 'Abril', 5: 'Maio', 6: 'Junho',
  7: 'Julho', 8: 'Agosto', 9: 'Setembro', 10: 'Outubro', 11: 'Novembro', 12: 'Dezembro'
};

/* ===== Estrutura oficial da base CRP (A até AQ) ===== */
const RELATORIO_CRP_CAMPOS_FIXOS = [
  { chave: 'ano', letra: 'A', idx: 0, nome: 'Ano' },
  { chave: 'mes', letra: 'B', idx: 1, nome: 'Mês' },
  { chave: 'avaliacaoTerminada', letra: 'C', idx: 2, nome: 'Avaliação Terminada? Se não, falta avaliação de:' },
  { chave: 'enviadoEm', letra: 'D', idx: 3, nome: 'DATA E HORA DE ENVIO DO FORMS' },
  { chave: 'email', letra: 'E', idx: 4, nome: 'Endereço de e-mail' },
  { chave: 'prontuario', letra: 'F', idx: 5, nome: 'Inserir nº do prontuário:' },
  { chave: 'unidade', letra: 'G', idx: 6, nome: 'Unidade:' },
  { chave: 'eixo', letra: 'H', idx: 7, nome: 'Eixo' },
  { chave: 'paciente', letra: 'I', idx: 8, nome: 'Nome do paciente (completo e sem abreviaturas)' },
  { chave: 'categoria', letra: 'J', idx: 9, nome: 'Categoria de avaliação' },
  { chave: 'satisfacao', letra: 'K', idx: 10, nome: 'NÍVEL DE SATISFAÇÃO' }
];

const RELATORIO_CRP_INDICADORES = [
  'REG. INTER',
  'ID.PACIENTE',
  'LEGIBILIDADE',
  'Admissão Médica',
  'Admissão de Enfermagem',
  'Controle Hemodinâmico',
  'Evolução Médica',
  'Evolução de Enfermagem',
  'Plano Terapêutico',
  'Transferência Interna',
  'Termo de Consentimento para exames de Imagem e laudo',
  'Registro de Transporte',
  'Relatório de Alta ou Óbito ou SVO ou IML',
  'Termo de Consentimento Cirúrgico',
  'Formulário da SAEP',
  'Evolução pós-cirúrgica',
  'Descrição Cirúrgica',
  'Termo de Consentimento Anestésico',
  'Formulário de avaliação pré anestésica',
  'Ficha de Anestesia',
  'Ficha de Avaliação Social',
  'Avaliação Nutricional ou Diagnóstico de Risco nutricional',
  'Admissão de Fisioterapia',
  'Evolução de Fisioterapia',
  'Avaliação Admissional Fonoaudiológica',
  'Evolução Fonoaudiológica',
  'Conciliação Medicamentosa',
  'Admissão Psicologia',
  'Evolução Psicologia'
];

const RELATORIO_CRP_CAMPOS_RESULTADO = [
  { chave: 'numerador', letra: 'AO', idx: 40, nome: 'NUMERADOR' },
  { chave: 'denominador', letra: 'AP', idx: 41, nome: 'DENOMINADOR' },
  { chave: 'resultado', letra: 'AQ', idx: 42, nome: 'RESULTADO' }
];

const RELATORIO_CRP_ESTRUTURA = RELATORIO_CRP_CAMPOS_FIXOS
  .concat(RELATORIO_CRP_INDICADORES.map((nome, offset) => ({
    chave: `indicador${offset + 1}`,
    letra: colunaParaLetra(11 + offset),
    idx: 11 + offset,
    nome: nome,
    indicador: true
  })))
  .concat(RELATORIO_CRP_CAMPOS_RESULTADO);

const RELATORIO_CRP_COLUNAS = RELATORIO_CRP_ESTRUTURA.reduce((acc, campo) => {
  acc[campo.chave] = campo.idx;
  return acc;
}, {
  inicioIndicadores: 11,
  fimIndicadores: 39
});

const RELATORIO_ABAS_POR_COMISSAO = {
  CRP: [ABA_RELATORIO_CRP, 'BASE_DADOS(NAOEDITAR)', 'BASE CRP', 'CRP - BASE', 'RELATÓRIO CRP', 'RELATORIO CRP'],
  CRO: [ABA_RELATORIO_CRO, 'BASE CRO', 'CRO - BASE', 'RELATÓRIO CRO', 'RELATORIO CRO']
};

/* ===== doGet ===== */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.api === 'dados' || params.api === 'relatorios' || params.api === '1') {
    const refresh = params.refresh === '1' || params.refresh === 'true';
    const comissao = String(params.comissao || '').trim().toUpperCase() === 'CRO' ? 'CRO' : 'CRP';
    return responderJson(executarRota('api-dados', () =>
      comissao === 'CRO' ? montarPayloadDadosCRO(refresh) : montarPayloadDados(refresh)));
  }

  if (params.api === 'configrel') {
    return responderJson(obterConfigRelAdmin(params.refresh === '1' || params.refresh === 'true'));
  }

  try {
    const template = HtmlService.createTemplateFromFile('index');
    template.appUrl = ScriptApp.getService().getUrl();
    return template
      .evaluate()
      .setTitle('Relatório Analítico — CRP e CRO')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (erro) {
    registrarErro('html-route', erro);
    return HtmlService
      .createHtmlOutput('<!doctype html><meta charset="utf-8"><title>Erro</title><body style="font-family:system-ui,Arial,sans-serif;padding:32px">Não foi possível abrir o relatório.</body>')
      .setTitle('Erro ao abrir relatório');
  }
}

/* ===== Infraestrutura ===== */
function responderJson(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function executarRota(nomeRota, callback) {
  try {
    return callback();
  } catch (erro) {
    registrarErro(nomeRota, erro);
    return montarPayloadErro('Não foi possível carregar os dados agora.', nomeRota, erro);
  }
}

function montarPayloadErro(mensagem, origem, erro) {
  return {
    success: false,
    origem: origem || 'apps-script',
    mensagem: mensagem || 'Falha inesperada no Apps Script.',
    detalhe: erro && erro.message ? erro.message : String(erro || ''),
    geradoEm: carimboAgora()
  };
}

function registrarErro(origem, erro) {
  const detalhe = erro && erro.stack ? erro.stack : (erro && erro.message ? erro.message : String(erro || 'Erro desconhecido'));
  console.error(`[${origem}] ${detalhe}`);
}

function carimboAgora() {
  return Utilities.formatDate(new Date(), FUSO_HORARIO, "dd/MM/yyyy 'às' HH:mm");
}

function abrirPlanilhaPorIdCache(id, contexto) {
  const planilhaId = String(id || '').trim();
  if (!planilhaId) {
    throw new Error(`ID da planilha não informado${contexto ? ' para ' + contexto : ''}.`);
  }

  if (CACHE_EXECUCAO_PLANILHAS[planilhaId]) {
    return CACHE_EXECUCAO_PLANILHAS[planilhaId];
  }

  try {
    const ss = SpreadsheetApp.openById(planilhaId);
    CACHE_EXECUCAO_PLANILHAS[planilhaId] = ss;
    return ss;
  } catch (erro) {
    throw new Error(`Falha ao abrir a planilha${contexto ? ' ' + contexto : ''} (${planilhaId}): ${erro.message || erro}`);
  }
}

/* ===== Normalização ===== */
function normalizarTexto(valor) {
  return String(valor == null ? '' : valor)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function normalizarCabecalho(valor) {
  return normalizarTexto(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function colunaParaLetra(indiceZeroBased) {
  let numero = Number(indiceZeroBased) + 1;
  let letra = '';

  while (numero > 0) {
    const resto = (numero - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    numero = Math.floor((numero - 1) / 26);
  }

  return letra;
}

function normalizarMes(valor) {
  const texto = normalizarTexto(valor);
  if (!texto) return '';

  if (ORDEM_MESES[texto]) {
    return MESES_CANONICOS[ORDEM_MESES[texto]];
  }

  const numero = Number(texto);
  if (!Number.isNaN(numero) && numero >= 1 && numero <= 12) {
    return MESES_CANONICOS[numero];
  }

  const base = String(valor == null ? '' : valor).trim().toLowerCase();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
}

function normalizarAno(valor) {
  return String(valor == null ? '' : valor).trim();
}

/* ============================================================
   CONFIGURAÇÃO SELF-SERVICE DO RELATÓRIO
   A configuração editável vive na aba CRP_REL_CONFIG da própria
   planilha. Script Properties é apenas espelho técnico/fallback.
   ============================================================ */
const CONFIG_REL_PROP_KEY = 'CRP_REL_CONFIG_V1';
const CONFIG_REL_BOOTSTRAP_PROP_KEY = 'CRP_REL_CONFIG_SPREADSHEET_ID';
const CONFIG_REL_ADMINS_PROP_KEY = 'CRP_REL_ADMINS';
const CONFIG_REL_SHEET = 'CRP_REL_CONFIG';
const CONFIG_REL_LOG_SHEET = 'CRP_REL_CONFIG_LOG';
const CONFIG_REL_SCHEMA_VERSION = '2.0';
const CONFIG_REL_CACHE_KEY = 'CRP_REL_CONFIG_CACHE_V2';
const CONFIG_REL_CACHE_TTL_SECONDS = 21600; // 6 horas
const CONFIG_REL_CRO_PROP_KEY = 'CRO_REL_CONFIG_V1';
const CONFIG_REL_CRO_SHEET = 'CRO_REL_CONFIG';
const CONFIG_REL_CRO_LOG_SHEET = 'CRO_REL_CONFIG_LOG';
const CONFIG_REL_CRO_CACHE_KEY = 'CRO_REL_CONFIG_CACHE_V1';
const TEXTOS_REL_SHEET = 'REL_TEXTOS';
const DADOS_CRO_CACHE_KEY = 'CRO_DADOS_CACHE_V1';
const DADOS_CRO_CACHE_TTL = 300; // 5 minutos

const TEXTOS_PADRAO_REL = {
  intro: 'Este relatório apresenta a análise consolidada da comissão {comissao} para o período {periodo}, considerando {setores}. O objetivo é sintetizar o desempenho dos registros avaliados, evidenciar conformidades e não conformidades e apoiar decisões de melhoria contínua.',
  metodo: 'A base foi lida diretamente da aba {abaEncontrada} da planilha institucional, usando a estrutura oficial da CRP de A até AQ. Para cálculo de conformidade, entram no denominador apenas itens classificados como Conforme ou Não Conforme; itens Não se Aplica, vazios ou marcados com hífen são apresentados separadamente para transparência da amostra.',
  analise: 'No recorte selecionado, foram identificadas {totalAvaliacoes} avaliações e {totalAuditavel} itens auditáveis. A taxa de prontuários avaliados como Bons ou Excelentes foi de {taxaBonsExcelentes} ({excelentes} excelentes e {bons} bons em {prontuariosClassificados} prontuários classificados). A conformidade geral dos itens foi de {conformidadeGeral}, com {conformes} conformidades e {naoConformes} não conformidades. Os principais pontos de atenção foram: {criticos}. Como fortalezas, destacam-se: {fortalezas}.',
  plano: 'Recomenda-se priorizar os indicadores com menor conformidade, revisar rotinas de preenchimento junto às equipes assistenciais, reforçar orientação sobre completude documental e acompanhar mensalmente os setores com maior volume de não conformidades. A gestão deve pactuar responsáveis, prazos e evidências de conclusão para cada ação corretiva.',
  conclusao: 'A análise demonstra o panorama atual da qualidade dos registros da comissão {comissao} e direciona intervenções objetivas para elevar a aderência documental. A continuidade do monitoramento por período, setor e categoria permitirá verificar tendência, sustentabilidade das melhorias e alinhamento à meta institucional de {metaInstitucional}.'
};

function configPadraoRel() {
  return {
    metaInstitucional: META_INSTITUCIONAL,
    planilhaId: PLANILHAS.relatorios,
    abaNome: ABA_RELATORIO_CRP,
    tipoRelatorio: 'executivo',
    logoUrl: LOGO_PADRAO,
    rodapeUrl: RODAPE_PADRAO,
    indicadores: RELATORIO_CRP_INDICADORES.slice(),
    termosConforme: ['CONFORME'],
    termosNaoConforme: ['NÃO CONFORME', 'NAO CONFORME'],
    termosNaoSeAplica: ['NÃO SE APLICA', 'NAO SE APLICA', 'N/A', 'NA'],
    textosPadrao: {
      intro: TEXTOS_PADRAO_REL.intro,
      metodo: TEXTOS_PADRAO_REL.metodo,
      analise: TEXTOS_PADRAO_REL.analise,
      plano: TEXTOS_PADRAO_REL.plano,
      conclusao: TEXTOS_PADRAO_REL.conclusao
    },
    atualizadoEm: '',
    atualizadoPor: ''
  };
}

function obterCacheConfigRel() {
  try {
    const raw = CacheService.getScriptCache().get(CONFIG_REL_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (erro) {
    registrarErro('cache-config-rel-get', erro);
    return null;
  }
}

function salvarCacheConfigRel(cfg) {
  try {
    CacheService.getScriptCache().put(CONFIG_REL_CACHE_KEY, JSON.stringify(cfg), CONFIG_REL_CACHE_TTL_SECONDS);
  } catch (erro) {
    registrarErro('cache-config-rel-put', erro);
  }
}

function invalidarCacheConfigRel() {
  try {
    CacheService.getScriptCache().remove(CONFIG_REL_CACHE_KEY);
  } catch (erro) {
    registrarErro('cache-config-rel-remove', erro);
  }
}

function executarComLockConfigRel(origem, callback) {
  const lock = LockService.getScriptLock();
  const conseguiuLock = lock.tryLock(30000);
  if (!conseguiuLock) {
    throw new Error('Tempo esgotado ao aguardar a fila de gravação. Tente novamente em alguns instantes.');
  }
  try {
    return callback();
  } catch (erro) {
    registrarErro(origem || 'lock-config-rel', erro);
    throw erro;
  } finally {
    lock.releaseLock();
  }
}

function obterConfigRel(forcarRefresh) {
  const padrao = configPadraoRel();
  if (forcarRefresh) invalidarCacheConfigRel();
  const cfgCache = forcarRefresh ? null : obterCacheConfigRel();
  if (cfgCache) return mesclarConfigRel(padrao, cfgCache);

  try {
    const cfgInicial = obterConfigRelDePropertiesOuPadrao(padrao);
    const ssConfig = obterPlanilhaConfiguracaoRel(cfgInicial.planilhaId || padrao.planilhaId);
    let sh = ssConfig.getSheetByName(CONFIG_REL_SHEET);

    if (!sh) {
      return executarComLockConfigRel('obter-config-rel-criar-aba', () => {
        sh = ssConfig.getSheetByName(CONFIG_REL_SHEET);
        if (!sh) {
          sh = ssConfig.insertSheet(CONFIG_REL_SHEET);
          escreverConfigRelNaAba(sh, cfgInicial, 'Configuração inicial criada automaticamente');
          espelharConfigRelEmPropertiesSemCache(cfgInicial);
        }
        const cfgCriada = lerConfigRelDaAba(sh, padrao) || cfgInicial;
        salvarCacheConfigRel(cfgCriada);
        return cfgCriada;
      });
    }

    const cfgPlanilha = lerConfigRelDaAba(sh, padrao);
    if (cfgPlanilha) {
      espelharConfigRelEmPropertiesSemCache(cfgPlanilha);
      salvarCacheConfigRel(cfgPlanilha);
      return cfgPlanilha;
    }
  } catch (erro) {
    registrarErro('obter-config-rel-aba', erro);
  }

  const cfgFallback = obterConfigRelDePropertiesOuPadrao(padrao);
  salvarCacheConfigRel(cfgFallback);
  return cfgFallback;
}

function obterConfigRelDePropertiesOuPadrao(padrao) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(CONFIG_REL_PROP_KEY);
    if (!raw) return padrao;
    return mesclarConfigRel(padrao, JSON.parse(raw));
  } catch (erro) {
    registrarErro('obter-config-rel-properties', erro);
    return padrao;
  }
}

function obterPlanilhaConfiguracaoRel(planilhaIdPreferencial) {
  try {
    const ativa = SpreadsheetApp.getActiveSpreadsheet();
    if (ativa) return ativa;
  } catch (erro) {
    // Em Web Apps standalone não há planilha ativa; usa fallback por ID.
  }

  const props = PropertiesService.getScriptProperties();
  const idPersistido = props.getProperty(CONFIG_REL_BOOTSTRAP_PROP_KEY);
  const id = idPersistido || planilhaIdPreferencial || PLANILHAS.relatorios;
  return abrirPlanilhaPorIdCache(id, 'de configuração do relatório');
}

function obterOuCriarAbaConfigRel(ss, padrao) {
  let sh = ss.getSheetByName(CONFIG_REL_SHEET);
  if (sh) return sh;

  sh = ss.insertSheet(CONFIG_REL_SHEET);
  aplicarLayoutAbaConfigRel(sh);
  escreverConfigRelNaAba(sh, padrao, 'Configuração inicial criada automaticamente');
  return sh;
}

function aplicarLayoutAbaConfigRel(sh) {
  try {
    sh.setTabColor('#0f766e');
    sh.setFrozenRows(1);
    sh.getRange('A1:B1')
      .setValues([['Campo', 'Valor']])
      .setFontWeight('bold')
      .setBackground('#0f766e')
      .setFontColor('#ffffff');
    sh.setColumnWidths(1, 1, 260);
    sh.setColumnWidths(2, 1, 520);
    sh.getRange('A:B').setWrap(true).setVerticalAlignment('top');
  } catch (erro) {
    registrarErro('layout-config-rel', erro);
  }
}

function mapaLinhasConfigRel(sh) {
  const values = sh.getDataRange().getValues();
  const mapa = {};
  values.forEach(row => {
    const chave = String(row[0] || '').trim();
    if (chave) mapa[chave] = row[1];
  });
  return mapa;
}

function lerListaConfigRel(valor) {
  return String(valor == null ? '' : valor)
    .split(/\r?\n|;/)
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function lerIndicadoresConfigRel(mapa, padrao) {
  const indicadores = padrao.indicadores.slice();
  indicadores.forEach((nomePadrao, i) => {
    const valor = mapa[`Indicador ${i + 1}`];
    if (valor && String(valor).trim()) indicadores[i] = String(valor).trim();
  });
  return indicadores;
}

function lerConfigRelDaAba(sh, padrao) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    escreverConfigRelNaAba(sh, padrao, 'Configuração recriada porque a aba estava vazia');
    return padrao;
  }

  const mapa = mapaLinhasConfigRel(sh);
  const bruto = {
    metaInstitucional: mapa['Meta institucional (%)'],
    planilhaId: mapa['ID da planilha do relatório'],
    abaNome: mapa['Aba da base CRP'],
    tipoRelatorio: mapa['Tipo do relatório'],
    logoUrl: mapa['Logo do cabeçalho (URL)'],
    rodapeUrl: mapa['Imagem do rodapé (URL)'],
    termosConforme: lerListaConfigRel(mapa['Termos conforme']),
    termosNaoConforme: lerListaConfigRel(mapa['Termos não conforme']),
    termosNaoSeAplica: lerListaConfigRel(mapa['Termos não se aplica']),
    textosPadrao: {
      intro: mapa['Mensagem padrão - Introdução'],
      metodo: mapa['Mensagem padrão - Metodologia'],
      analise: mapa['Mensagem padrão - Análise crítica'],
      plano: mapa['Mensagem padrão - Plano de ação'],
      conclusao: mapa['Mensagem padrão - Conclusão']
    },
    indicadores: lerIndicadoresConfigRel(mapa, padrao),
    atualizadoEm: String(mapa['Atualizado em'] || ''),
    atualizadoPor: String(mapa['Atualizado por'] || '')
  };

  return mesclarConfigRel(padrao, bruto);
}

function escreverConfigRelNaAba(sh, cfg, observacao) {
  const rows = [
    ['Campo', 'Valor'],
    ['Versão do esquema', CONFIG_REL_SCHEMA_VERSION],
    ['Meta institucional (%)', cfg.metaInstitucional],
    ['ID da planilha do relatório', cfg.planilhaId || PLANILHAS.relatorios],
    ['Aba da base CRP', cfg.abaNome || ABA_RELATORIO_CRP],
    ['Tipo do relatório', cfg.tipoRelatorio || 'executivo'],
    ['Logo do cabeçalho (URL)', cfg.logoUrl || LOGO_PADRAO],
    ['Imagem do rodapé (URL)', cfg.rodapeUrl || RODAPE_PADRAO],
    ['Mensagem padrão - Introdução', (cfg.textosPadrao && cfg.textosPadrao.intro) || ''],
    ['Mensagem padrão - Metodologia', (cfg.textosPadrao && cfg.textosPadrao.metodo) || ''],
    ['Mensagem padrão - Análise crítica', (cfg.textosPadrao && cfg.textosPadrao.analise) || ''],
    ['Mensagem padrão - Plano de ação', (cfg.textosPadrao && cfg.textosPadrao.plano) || ''],
    ['Mensagem padrão - Conclusão', (cfg.textosPadrao && cfg.textosPadrao.conclusao) || ''],
    ['Termos conforme', (cfg.termosConforme || []).join('\n')],
    ['Termos não conforme', (cfg.termosNaoConforme || []).join('\n')],
    ['Termos não se aplica', (cfg.termosNaoSeAplica || []).join('\n')],
    ['Atualizado em', cfg.atualizadoEm || ''],
    ['Atualizado por', cfg.atualizadoPor || ''],
    ['Observação', observacao || 'Edite preferencialmente pela tela Administração do relatório.'],
    ['', ''],
    ['Indicadores da CRP', 'Renomeie abaixo mantendo a ordem dos indicadores da base']
  ];

  (cfg.indicadores || []).forEach((nome, i) => rows.push([`Indicador ${i + 1}`, nome || '']));

  sh.clear();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  aplicarLayoutAbaConfigRel(sh);
  try {
    sh.getRange(21, 1, 1, 2).setFontWeight('bold').setBackground('#e4f5f2').setFontColor('#0b4f4a');
    sh.getRange(5, 2).setNote('Nome exato da aba que contem a base CRP.');
    sh.getRange(9, 2, 5, 1).setNote('Use tokens como {comissao}, {periodo}, {setores}, {conformidadeGeral}, {taxaBonsExcelentes}, {excelentes}, {bons}, {criticos}, {fortalezas} e {metaInstitucional}.');
    sh.getRange(14, 2, 3, 1).setNote('Um termo por linha. A comparacao ignora maiusculas/minusculas e espacos extras.');
  } catch (erro) {
    registrarErro('formatar-config-rel', erro);
  }
}

function salvarConfigRelNaAba(cfg) {
  const ssConfig = obterPlanilhaConfiguracaoRel(cfg.planilhaId || PLANILHAS.relatorios);
  const sh = obterOuCriarAbaConfigRel(ssConfig, cfg);
  escreverConfigRelNaAba(sh, cfg, 'Última gravação feita pela tela Administração do relatório');
  espelharConfigRelEmProperties(cfg);
}

function espelharConfigRelEmPropertiesSemCache(cfg) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(CONFIG_REL_PROP_KEY, JSON.stringify(cfg));
    if (cfg && cfg.planilhaId) props.setProperty(CONFIG_REL_BOOTSTRAP_PROP_KEY, String(cfg.planilhaId).trim());
  } catch (erro) {
    registrarErro('espelhar-config-rel-properties', erro);
  }
}

function espelharConfigRelEmProperties(cfg) {
  espelharConfigRelEmPropertiesSemCache(cfg);
  invalidarCacheConfigRel();
  salvarCacheConfigRel(cfg);
}

function removerConfigRelDaAba(cfgRestaurada) {
  const ssConfig = obterPlanilhaConfiguracaoRel(PLANILHAS.relatorios);
  const cfgPadrao = cfgRestaurada || configPadraoRel();
  const sh = obterOuCriarAbaConfigRel(ssConfig, cfgPadrao);
  escreverConfigRelNaAba(sh, cfgPadrao, 'Configuração restaurada para o padrão pela tela Administração do relatório');
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(CONFIG_REL_PROP_KEY);
    props.deleteProperty(CONFIG_REL_BOOTSTRAP_PROP_KEY);
    invalidarCacheConfigRel();
  } catch (erro) {
    registrarErro('limpar-config-rel-properties', erro);
  }
}

function mesclarConfigRel(padrao, salvo) {
  if (!salvo || typeof salvo !== 'object') return padrao;
  const cfg = JSON.parse(JSON.stringify(padrao));
  const meta = Number(salvo.metaInstitucional);
  if (!Number.isNaN(meta) && meta >= 0 && meta <= 100) cfg.metaInstitucional = meta;
  if (salvo.planilhaId && String(salvo.planilhaId).trim()) cfg.planilhaId = String(salvo.planilhaId).trim();
  if (salvo.abaNome && String(salvo.abaNome).trim()) cfg.abaNome = String(salvo.abaNome).trim();
  if (salvo.tipoRelatorio && String(salvo.tipoRelatorio).trim()) cfg.tipoRelatorio = String(salvo.tipoRelatorio).trim();
  if (salvo.logoUrl != null && String(salvo.logoUrl).trim()) cfg.logoUrl = String(salvo.logoUrl).trim();
  if (salvo.rodapeUrl != null && String(salvo.rodapeUrl).trim()) cfg.rodapeUrl = String(salvo.rodapeUrl).trim();
  if (salvo.textosPadrao && typeof salvo.textosPadrao === 'object') {
    ['intro', 'metodo', 'analise', 'plano', 'conclusao'].forEach(chave => {
      if (salvo.textosPadrao[chave] != null && String(salvo.textosPadrao[chave]).trim()) {
        cfg.textosPadrao[chave] = String(salvo.textosPadrao[chave]).trim();
      }
    });
  }
  if (Array.isArray(salvo.indicadores) && salvo.indicadores.length) {
    // Preserva quantidade/ordem dos padrões; aplica nomes salvos por posição.
    cfg.indicadores = padrao.indicadores.map((nomePadrao, i) => {
      const nomeSalvo = salvo.indicadores[i];
      return nomeSalvo && String(nomeSalvo).trim() ? String(nomeSalvo).trim() : nomePadrao;
    });
  }
  ['termosConforme', 'termosNaoConforme', 'termosNaoSeAplica'].forEach(chave => {
    if (Array.isArray(salvo[chave])) {
      const lista = salvo[chave].map(t => String(t || '').trim()).filter(Boolean);
      if (lista.length) cfg[chave] = lista;
    }
  });
  cfg.atualizadoEm = salvo.atualizadoEm || '';
  cfg.atualizadoPor = salvo.atualizadoPor || '';
  return cfg;
}

function mesclarConfigRelCRO(padrao, salvo) {
  if (!salvo || typeof salvo !== 'object') return padrao;
  const cfg = JSON.parse(JSON.stringify(padrao));
  if (salvo.planilhaIdCRO && String(salvo.planilhaIdCRO).trim()) cfg.planilhaIdCRO = String(salvo.planilhaIdCRO).trim();
  if (salvo.abaNomeCRO && String(salvo.abaNomeCRO).trim()) cfg.abaNomeCRO = String(salvo.abaNomeCRO).trim();
  if (salvo.logoUrl != null && String(salvo.logoUrl).trim()) cfg.logoUrl = String(salvo.logoUrl).trim();
  if (salvo.rodapeUrl != null && String(salvo.rodapeUrl).trim()) cfg.rodapeUrl = String(salvo.rodapeUrl).trim();
  cfg.atualizadoEm = salvo.atualizadoEm || '';
  cfg.atualizadoPor = salvo.atualizadoPor || '';
  return cfg;
}

function configRelCROLegado(cfgCRP) {
  const cfg = configPadraoRelCRO();
  cfg.logoUrl = (cfgCRP && cfgCRP.logoUrl) || LOGO_PADRAO;
  cfg.rodapeUrl = (cfgCRP && cfgCRP.rodapeUrl) || RODAPE_PADRAO;
  if (cfgCRP && cfgCRP.planilhaIdCRO) cfg.planilhaIdCRO = cfgCRP.planilhaIdCRO;
  if (cfgCRP && cfgCRP.abaNomeCRO) cfg.abaNomeCRO = cfgCRP.abaNomeCRO;
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(CONFIG_REL_PROP_KEY);
    if (raw) {
      const antigo = JSON.parse(raw);
      if (antigo.planilhaIdCRO) cfg.planilhaIdCRO = String(antigo.planilhaIdCRO).trim();
      if (antigo.abaNomeCRO) cfg.abaNomeCRO = String(antigo.abaNomeCRO).trim();
    }
  } catch (erro) {
    registrarErro('config-cro-legado-properties', erro);
  }
  try {
    const ssConfig = obterPlanilhaConfiguracaoRel((cfgCRP && cfgCRP.planilhaId) || PLANILHAS.relatorios);
    const sh = ssConfig.getSheetByName(CONFIG_REL_SHEET);
    if (sh) {
      const mapa = mapaLinhasConfigRel(sh);
      if (mapa['ID da planilha da CRO']) cfg.planilhaIdCRO = String(mapa['ID da planilha da CRO']).trim();
      if (mapa['Aba da base CRO']) cfg.abaNomeCRO = String(mapa['Aba da base CRO']).trim();
    }
  } catch (erro) {
    registrarErro('config-cro-legado-aba-crp', erro);
  }
  return cfg;
}

function obterCacheConfigRelCRO() {
  try {
    const raw = CacheService.getScriptCache().get(CONFIG_REL_CRO_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (erro) {
    registrarErro('cache-config-rel-cro-get', erro);
    return null;
  }
}

function salvarCacheConfigRelCRO(cfg) {
  try {
    CacheService.getScriptCache().put(CONFIG_REL_CRO_CACHE_KEY, JSON.stringify(cfg), CONFIG_REL_CACHE_TTL_SECONDS);
  } catch (erro) {
    registrarErro('cache-config-rel-cro-put', erro);
  }
}

function invalidarCacheConfigRelCRO() {
  try {
    CacheService.getScriptCache().remove(CONFIG_REL_CRO_CACHE_KEY);
  } catch (erro) {
    registrarErro('cache-config-rel-cro-remove', erro);
  }
}

function obterConfigRelCRODePropertiesOuPadrao(padrao) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(CONFIG_REL_CRO_PROP_KEY);
    return raw ? mesclarConfigRelCRO(padrao, JSON.parse(raw)) : padrao;
  } catch (erro) {
    registrarErro('obter-config-rel-cro-properties', erro);
    return padrao;
  }
}

function mapaLinhasConfigRelCRO(sh) {
  const values = sh.getDataRange().getValues();
  const mapa = {};
  values.forEach(row => {
    const chave = String(row[0] || '').trim();
    if (chave) mapa[chave] = row[1];
  });
  return mapa;
}

function lerConfigRelCRODaAba(sh, padrao) {
  if (sh.getLastRow() < 2) {
    escreverConfigRelCRONaAba(sh, padrao, 'Configuracao da CRO recriada porque a aba estava vazia');
    return padrao;
  }
  const mapa = mapaLinhasConfigRelCRO(sh);
  return mesclarConfigRelCRO(padrao, {
    planilhaIdCRO: mapa['ID da planilha da CRO'],
    abaNomeCRO: mapa['Aba da base CRO'],
    logoUrl: mapa['Logo do cabecalho (URL)'] || mapa['Logo do cabeÃ§alho (URL)'],
    rodapeUrl: mapa['Imagem do rodape (URL)'] || mapa['Imagem do rodapÃ© (URL)'],
    atualizadoEm: mapa['Atualizado em'],
    atualizadoPor: mapa['Atualizado por']
  });
}

function aplicarLayoutAbaConfigRelCRO(sh) {
  try {
    sh.setTabColor('#2563eb');
    sh.setFrozenRows(1);
    sh.getRange('A1:B1')
      .setValues([['Campo', 'Valor']])
      .setFontWeight('bold')
      .setBackground('#2563eb')
      .setFontColor('#ffffff');
    sh.setColumnWidths(1, 1, 260);
    sh.setColumnWidths(2, 1, 520);
    sh.getRange('A:B').setWrap(true).setVerticalAlignment('top');
  } catch (erro) {
    registrarErro('layout-config-rel-cro', erro);
  }
}

function escreverConfigRelCRONaAba(sh, cfg, observacao) {
  const rows = [
    ['Campo', 'Valor'],
    ['Versao do esquema', CONFIG_REL_SCHEMA_VERSION],
    ['ID da planilha da CRO', cfg.planilhaIdCRO || PLANILHAS.relatoriosCRO],
    ['Aba da base CRO', cfg.abaNomeCRO || ABA_RELATORIO_CRO],
    ['Logo do cabecalho (URL)', cfg.logoUrl || LOGO_PADRAO],
    ['Imagem do rodape (URL)', cfg.rodapeUrl || RODAPE_PADRAO],
    ['Atualizado em', cfg.atualizadoEm || ''],
    ['Atualizado por', cfg.atualizadoPor || ''],
    ['Observacao', observacao || 'Configuracao exclusiva do relatorio da CRO.']
  ];
  sh.clear();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  aplicarLayoutAbaConfigRelCRO(sh);
  try {
    sh.getRange(3, 2).setNote('ID da planilha que contem a base da CRO.');
    sh.getRange(4, 2).setNote('Nome exato da aba que contem a base da CRO.');
  } catch (erro) {
    registrarErro('formatar-config-rel-cro', erro);
  }
}

function obterOuCriarAbaConfigRelCRO(ss, padrao) {
  let sh = ss.getSheetByName(CONFIG_REL_CRO_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(CONFIG_REL_CRO_SHEET);
  escreverConfigRelCRONaAba(sh, padrao, 'Configuracao inicial da CRO criada automaticamente');
  return sh;
}

function espelharConfigRelCROEmPropertiesSemCache(cfg) {
  try {
    PropertiesService.getScriptProperties().setProperty(CONFIG_REL_CRO_PROP_KEY, JSON.stringify(cfg));
  } catch (erro) {
    registrarErro('espelhar-config-rel-cro-properties', erro);
  }
}

function espelharConfigRelCROEmProperties(cfg) {
  espelharConfigRelCROEmPropertiesSemCache(cfg);
  invalidarCacheConfigRelCRO();
  salvarCacheConfigRelCRO(cfg);
}

function obterConfigRelCRO(forcarRefresh, cfgCRP) {
  cfgCRP = cfgCRP || obterConfigRel(forcarRefresh === true);
  const padrao = configRelCROLegado(cfgCRP);
  if (forcarRefresh) invalidarCacheConfigRelCRO();
  const cfgCache = forcarRefresh ? null : obterCacheConfigRelCRO();
  if (cfgCache) return mesclarConfigRelCRO(padrao, cfgCache);

  const cfgInicial = obterConfigRelCRODePropertiesOuPadrao(padrao);
  try {
    const ssCRO = abrirPlanilhaPorIdCache(cfgInicial.planilhaIdCRO || PLANILHAS.relatoriosCRO, 'de configuracao da CRO');
    let sh = ssCRO.getSheetByName(CONFIG_REL_CRO_SHEET);
    if (!sh) {
      return executarComLockConfigRel('obter-config-rel-cro-criar-aba', () => {
        sh = ssCRO.getSheetByName(CONFIG_REL_CRO_SHEET);
        if (!sh) {
          sh = ssCRO.insertSheet(CONFIG_REL_CRO_SHEET);
          escreverConfigRelCRONaAba(sh, cfgInicial, 'Configuracao inicial da CRO criada automaticamente');
          espelharConfigRelCROEmPropertiesSemCache(cfgInicial);
        }
        const cfgCriada = lerConfigRelCRODaAba(sh, cfgInicial) || cfgInicial;
        salvarCacheConfigRelCRO(cfgCriada);
        return cfgCriada;
      });
    }
    const cfgPlanilha = lerConfigRelCRODaAba(sh, cfgInicial);
    espelharConfigRelCROEmPropertiesSemCache(cfgPlanilha);
    salvarCacheConfigRelCRO(cfgPlanilha);
    return cfgPlanilha;
  } catch (erro) {
    registrarErro('obter-config-rel-cro-aba', erro);
  }

  salvarCacheConfigRelCRO(cfgInicial);
  return cfgInicial;
}

function salvarConfigRelCRONaAba(cfg) {
  const ssCRO = abrirPlanilhaPorIdCache(cfg.planilhaIdCRO || PLANILHAS.relatoriosCRO, 'de configuracao da CRO');
  const sh = obterOuCriarAbaConfigRelCRO(ssCRO, cfg);
  escreverConfigRelCRONaAba(sh, cfg, 'Ultima gravacao feita pela tela Administracao do relatorio');
  espelharConfigRelCROEmProperties(cfg);
}

function removerConfigRelCRODaAba(cfgRestaurada) {
  const cfg = cfgRestaurada || configPadraoRelCRO();
  const ssCRO = abrirPlanilhaPorIdCache(cfg.planilhaIdCRO || PLANILHAS.relatoriosCRO, 'de configuracao da CRO');
  const sh = obterOuCriarAbaConfigRelCRO(ssCRO, cfg);
  escreverConfigRelCRONaAba(sh, cfg, 'Configuracao da CRO restaurada para o padrao');
  try {
    PropertiesService.getScriptProperties().deleteProperty(CONFIG_REL_CRO_PROP_KEY);
    invalidarCacheConfigRelCRO();
  } catch (erro) {
    registrarErro('limpar-config-rel-cro-properties', erro);
  }
}

function combinarConfigsRelAdmin(cfgCRP, cfgCRO) {
  const combinado = JSON.parse(JSON.stringify(cfgCRP || configPadraoRel()));
  cfgCRO = cfgCRO || configPadraoRelCRO();
  combinado.planilhaIdCRO = cfgCRO.planilhaIdCRO || PLANILHAS.relatoriosCRO;
  combinado.abaNomeCRO = cfgCRO.abaNomeCRO || ABA_RELATORIO_CRO;
  combinado.atualizadoEmCRO = cfgCRO.atualizadoEm || '';
  combinado.atualizadoPorCRO = cfgCRO.atualizadoPor || '';
  return combinado;
}

function abrirPlanilhaRelatorio(cfg) {
  cfg = cfg || obterConfigRel();
  const id = cfg.planilhaId || PLANILHAS.relatorios;
  return abrirPlanilhaPorIdCache(id, 'do relatório');
}

/* ===== Permissões e log de administração ===== */
function emailUsuarioAtualRel() {
  try {
    const ativo = Session.getActiveUser() && Session.getActiveUser().getEmail();
    if (ativo) return ativo;
    return (Session.getEffectiveUser() && Session.getEffectiveUser().getEmail()) || '';
  } catch (erro) { return ''; }
}

function listaAdminsRel() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(CONFIG_REL_ADMINS_PROP_KEY) || '';
    return raw.split(/[;,]/).map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
  } catch (erro) { return []; }
}

function usuarioPodeEditarRel() {
  const admins = listaAdminsRel();
  if (!admins.length) return true;
  const email = emailUsuarioAtualRel().toLowerCase();
  return !!email && admins.indexOf(email) !== -1;
}

function obterConfigRelAdmin(forcarRefresh) {
  return executarRota('rpc-configrel-get', () => {
    const refresh = forcarRefresh === true || forcarRefresh === '1';
    const cfgCRP = obterConfigRel(refresh);
    const cfgCRO = obterConfigRelCRO(refresh, cfgCRP);
    return {
      success: true,
      config: combinarConfigsRelAdmin(cfgCRP, cfgCRO),
      podeEditar: usuarioPodeEditarRel(),
      usuario: emailUsuarioAtualRel(),
      geradoEm: carimboAgora()
    };
  });
}

function salvarConfigRelAdmin(novaConfig) {
  return executarRota('rpc-configrel-save', () => executarComLockConfigRel('rpc-configrel-save-lock', () => {
    if (!usuarioPodeEditarRel()) return { success: false, mensagem: 'Voce nao tem permissao para alterar as configuracoes.' };
    const usuario = emailUsuarioAtualRel() || 'desconhecido';
    const carimbo = carimboAgora();

    const mergedCRP = mesclarConfigRel(configPadraoRel(), novaConfig || {});
    mergedCRP.atualizadoEm = carimbo;
    mergedCRP.atualizadoPor = usuario;
    salvarConfigRelNaAba(mergedCRP);

    const mergedCRO = mesclarConfigRelCRO(configRelCROLegado(mergedCRP), novaConfig || {});
    mergedCRO.atualizadoEm = carimbo;
    mergedCRO.atualizadoPor = usuario;
    salvarConfigRelCRONaAba(mergedCRO);

    registrarLogRelSemLock(usuario, 'Configuracao do relatorio atualizada', mergedCRP);
    registrarLogRelCROSemLock(usuario, 'Configuracao da CRO atualizada', mergedCRO);
    try { CacheService.getScriptCache().remove(DADOS_CRO_CACHE_KEY); } catch (_) {}
    return { success: true, config: combinarConfigsRelAdmin(mergedCRP, mergedCRO), mensagem: 'Configuracoes salvas com sucesso.' };
  }));
}

function restaurarConfigRelAdmin() {
  return executarRota('rpc-configrel-reset', () => executarComLockConfigRel('rpc-configrel-reset-lock', () => {
    if (!usuarioPodeEditarRel()) return { success: false, mensagem: 'Voce nao tem permissao para alterar as configuracoes.' };
    const usuario = emailUsuarioAtualRel() || 'desconhecido';
    const carimbo = carimboAgora();
    const cfgPadraoAtualizada = configPadraoRel();
    cfgPadraoAtualizada.atualizadoEm = carimbo;
    cfgPadraoAtualizada.atualizadoPor = usuario;
    removerConfigRelDaAba(cfgPadraoAtualizada);
    salvarCacheConfigRel(cfgPadraoAtualizada);

    const cfgCROPadrao = configRelCROLegado(cfgPadraoAtualizada);
    cfgCROPadrao.atualizadoEm = carimbo;
    cfgCROPadrao.atualizadoPor = usuario;
    removerConfigRelCRODaAba(cfgCROPadrao);
    salvarCacheConfigRelCRO(cfgCROPadrao);

    registrarLogRelSemLock(usuario, 'Configuracao do relatorio restaurada para o padrao', cfgPadraoAtualizada);
    registrarLogRelCROSemLock(usuario, 'Configuracao da CRO restaurada para o padrao', cfgCROPadrao);
    return { success: true, config: combinarConfigsRelAdmin(cfgPadraoAtualizada, cfgCROPadrao), mensagem: 'Configuracoes restauradas para o padrao.' };
  }));
}

// ── Textos personalizados do relatório salvos na planilha ────────────────
// A aba REL_TEXTOS tem colunas: Comissão | Chave | Texto | Atualizado em | Por
// Cada seção editável de cada comissão ocupa uma linha (upsert por chave).

function obterTextosPersonalizadosRel(comissao) {
  try {
    const ss = obterPlanilhaConfiguracaoRel(PLANILHAS.relatorios);
    const sh = ss.getSheetByName(TEXTOS_REL_SHEET);
    if (!sh) return {};
    const all = sh.getDataRange().getValues();
    if (all.length < 2) return {};
    const dados = all.slice(1).map(function(r) { return [r[0], r[1], r[2]]; });
    const comissaoNorm = String(comissao || 'CRP').toUpperCase();
    const resultado = {};
    dados.forEach(function(row) {
      if (String(row[0]).trim().toUpperCase() === comissaoNorm && row[1]) {
        resultado[String(row[1]).trim()] = String(row[2] == null ? '' : row[2]);
      }
    });
    return resultado;
  } catch (e) {
    return {};
  }
}

function salvarTextosPersonalizadosRel(comissao, textos) {
  return executarRota('rpc-textos-salvar', function() {
    return executarComLockConfigRel('rpc-textos-salvar-lock', function() {
      const ss = obterPlanilhaConfiguracaoRel(PLANILHAS.relatorios);
      let sh = ss.getSheetByName(TEXTOS_REL_SHEET);
      if (!sh) {
        sh = ss.insertSheet(TEXTOS_REL_SHEET);
        sh.getRange('A1:E1').setValues([['Comissão', 'Chave', 'Texto', 'Atualizado em', 'Por']]);
        sh.setFrozenRows(1);
        try { sh.setTabColor('#7c3aed'); } catch (_) {}
      }
      const comissaoNorm = String(comissao || 'CRP').toUpperCase();
      const usuario = emailUsuarioAtualRel() || 'anônimo';
      const carimbo = carimboAgora();
      // Re-read inside the lock to get the authoritative row positions.
      const lastRow = sh.getLastRow();
      const existente = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];

      Object.keys(textos || {}).forEach(function(chave) {
        if (!chave) return;
        const texto = textos[chave];
        let linha = -1;
        for (let i = 0; i < existente.length; i++) {
          if (String(existente[i][0]).trim().toUpperCase() === comissaoNorm && String(existente[i][1]).trim() === chave) {
            linha = i + 2;
            break;
          }
        }
        if (linha > 0) {
          sh.getRange(linha, 3, 1, 3).setValues([[texto, carimbo, usuario]]);
        } else {
          sh.appendRow([comissaoNorm, chave, texto, carimbo, usuario]);
          existente.push([comissaoNorm, chave]);
        }
      });
      return { success: true };
    });
  });
}

function limparTextosPersonalizadosRel(comissao, chaves) {
  return executarRota('rpc-textos-limpar', function() {
    return executarComLockConfigRel('rpc-textos-limpar-lock', function() {
      const ss = obterPlanilhaConfiguracaoRel(PLANILHAS.relatorios);
      const sh = ss.getSheetByName(TEXTOS_REL_SHEET);
      if (!sh || sh.getLastRow() < 2) return { success: true };
      const comissaoNorm = String(comissao || 'CRP').toUpperCase();
      const chavesArr = Array.isArray(chaves) ? chaves.map(String) : [String(chaves)];
      const chavesSet = {};
      chavesArr.forEach(function(c) { chavesSet[c] = true; });
      // Re-read inside the lock so row indices are authoritative at delete time.
      const dados = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
      const paraApagar = [];
      for (let i = 0; i < dados.length; i++) {
        if (String(dados[i][0]).trim().toUpperCase() === comissaoNorm && chavesSet[String(dados[i][1]).trim()]) {
          paraApagar.push(i + 2);
        }
      }
      for (let i = paraApagar.length - 1; i >= 0; i--) {
        sh.deleteRow(paraApagar[i]);
      }
      return { success: true };
    });
  });
}

function obterConfigRelCRP(forcarRefresh) {
  return obterConfigRelAdmin(forcarRefresh);
}

function salvarConfigRelCRP(novaConfig) {
  return salvarConfigRelAdmin(novaConfig);
}

function restaurarConfigRelCRP() {
  return restaurarConfigRelAdmin();
}

function registrarLogRelSemLock(usuario, acao, cfg) {
  try {
    const ss = abrirPlanilhaRelatorio(cfg || obterConfigRel());
    let sh = ss.getSheetByName(CONFIG_REL_LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(CONFIG_REL_LOG_SHEET);
      sh.getRange(1, 1, 1, 3).setValues([['Data/Hora', 'Usuário', 'Ação']]);
      sh.setFrozenRows(1);
      sh.getRange('A1:C1').setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    }
    const row = [Utilities.formatDate(new Date(), FUSO_HORARIO, 'dd/MM/yyyy HH:mm:ss'), usuario || '', acao || ''];
    sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  } catch (erro) { registrarErro('config-rel-log', erro); }
}

function registrarLogRelCROSemLock(usuario, acao, cfg) {
  try {
    cfg = cfg || obterConfigRelCRO(false);
    const ss = abrirPlanilhaPorIdCache(cfg.planilhaIdCRO || PLANILHAS.relatoriosCRO, 'de log da CRO');
    let sh = ss.getSheetByName(CONFIG_REL_CRO_LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(CONFIG_REL_CRO_LOG_SHEET);
      sh.getRange(1, 1, 1, 3).setValues([['Data/Hora', 'Usuario', 'Acao']]);
      sh.setFrozenRows(1);
      sh.getRange('A1:C1').setFontWeight('bold').setBackground('#2563eb').setFontColor('#ffffff');
    }
    const row = [Utilities.formatDate(new Date(), FUSO_HORARIO, 'dd/MM/yyyy HH:mm:ss'), usuario || '', acao || ''];
    sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  } catch (erro) { registrarErro('config-rel-cro-log', erro); }
}

/* ===== Leitura e validação da base ===== */
function obterAbaRelatorio(ss, comissao, cfg) {
  const comNorm = comissao === 'CRO' ? 'CRO' : 'CRP';
  let nomes = RELATORIO_ABAS_POR_COMISSAO[comNorm] || RELATORIO_ABAS_POR_COMISSAO.CRP;
  if (comNorm === 'CRP' && cfg && cfg.abaNome) nomes = [cfg.abaNome].concat(nomes);
  for (let i = 0; i < nomes.length; i++) {
    const sh = ss.getSheetByName(nomes[i]);
    if (sh) return sh;
  }
  return null;
}

function obterLinhasRelatorio(ss, comissao, cfg) {
  const comissaoNormalizada = comissao === 'CRO' ? 'CRO' : 'CRP';
  const planilhaId = cfg && cfg.planilhaId ? String(cfg.planilhaId).trim() : (ss && ss.getId ? ss.getId() : PLANILHAS.relatorios);
  const abaCfg = cfg && cfg.abaNome ? String(cfg.abaNome).trim() : '';
  const chaveCache = [planilhaId, comissaoNormalizada, abaCfg].join('::');

  if (CACHE_EXECUCAO_BASE_RELATORIO[chaveCache]) {
    return CACHE_EXECUCAO_BASE_RELATORIO[chaveCache];
  }

  const sh = obterAbaRelatorio(ss, comissaoNormalizada, cfg);
  if (!sh) {
    const vazio = { abaEncontrada: '', headers: [], linhas: [], alertasEstrutura: ['Aba da CRP não encontrada.'] };
    CACHE_EXECUCAO_BASE_RELATORIO[chaveCache] = vazio;
    return vazio;
  }

  // Evita getDataRange(): em planilhas com milhares de linhas formatadas,
  // getDataRange() pode varrer colunas/linhas vazias e deixar o Web App preso
  // no carregamento inicial. O relatório oficial usa A:AQ, então lemos somente
  // as colunas necessárias e apenas até a última linha realmente existente.
  const ultimaLinha = Math.max(sh.getLastRow(), 1);
  const totalColunas = comissaoNormalizada === 'CRP'
    ? RELATORIO_CRP_COLUNAS.resultado + 1
    : Math.max(sh.getLastColumn(), 1);
  const values = sh.getRange(1, 1, ultimaLinha, totalColunas).getValues();
  const headers = values.length ? values[0].map(item => String(item || '').trim()) : [];
  const base = {
    abaEncontrada: sh.getName(),
    headers: headers,
    linhas: values.slice(1).filter(row => row.some(cell => String(cell == null ? '' : cell).trim() !== '')),
    alertasEstrutura: comissaoNormalizada === 'CRP' ? validarEstruturaCRP(headers) : []
  };

  CACHE_EXECUCAO_BASE_RELATORIO[chaveCache] = base;
  return base;
}

function validarEstruturaCRP(headers) {
  const alertas = [];
  const totalColunasEsperado = RELATORIO_CRP_COLUNAS.resultado + 1;

  if ((headers || []).length < totalColunasEsperado) {
    alertas.push(`A base CRP deve ir de A até AQ (${totalColunasEsperado} colunas), mas o cabeçalho possui ${(headers || []).length} colunas preenchidas.`);
  }

  RELATORIO_CRP_ESTRUTURA.forEach(campo => {
    const encontrado = String((headers || [])[campo.idx] || '').trim();
    if (!encontrado) {
      alertas.push(`Coluna ${campo.letra} sem cabeçalho. Esperado: ${campo.nome}.`);
      return;
    }

    if (normalizarCabecalho(encontrado) !== normalizarCabecalho(campo.nome)) {
      alertas.push(`Coluna ${campo.letra}: encontrado "${encontrado}"; esperado "${campo.nome}".`);
    }
  });

  return alertas;
}

/* ===== Dataset compacto enviado ao cliente =====
   Cada registro é um array posicional:
   [ano, mes, status, unidade, eixo, categoria, satisfacao, flags, numerador, denominador, resultado]
   onde "flags" é uma string com 1 caractere por indicador:
   C = conforme · N = não conforme · A = não se aplica · V = vazio/hífen · O = outro valor */
function montarTermosClassificacao(cfg) {
  return {
    conforme: new Set((cfg.termosConforme || []).map(normalizarTexto)),
    naoConforme: new Set((cfg.termosNaoConforme || []).map(normalizarTexto)),
    naoSeAplica: new Set((cfg.termosNaoSeAplica || []).map(normalizarTexto))
  };
}

function codigoClassificacao(valor, termos) {
  const texto = normalizarTexto(valor);
  if (!texto || texto === '-') return 'V';
  if (termos.conforme.has(texto)) return 'C';
  if (termos.naoConforme.has(texto)) return 'N';
  if (termos.naoSeAplica.has(texto)) return 'A';
  return 'O';
}

function numeroOuNull(valor) {
  if (valor == null || String(valor).trim() === '') return null;
  const numero = Number(valor);
  return Number.isNaN(numero) ? null : numero;
}

function obterPlanoDeAcaoDados(ss) {
  try {
    const sh = ss.getSheetByName('Plano de Ação');
    if (!sh) {
      const abas = ss.getSheets().map(s => s.getName()).join(', ');
      return { sucesso: false, acoes: [], debug: 'Aba não encontrada. Abas disponíveis: ' + abas };
    }

    const ultimaLinha = Math.max(sh.getLastRow(), 1);
    const totalCols = Math.max(sh.getLastColumn(), 12);
    const values = sh.getRange(1, 1, ultimaLinha, totalCols).getValues();

    const acoes = [];
    let mesAtual = null;
    let anoAtual = null;
    const debugColA = [];

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const colA = row[0];
      const colI = row.length > 8 ? row[8] : '';
      const colL = row.length > 11 ? row[11] : '';

      if (i < 10) debugColA.push(typeof colA + ':' + String(colA).slice(0, 30));

      if (colA) {
        let data = null;
        if (typeof colA === 'object' && colA !== null && typeof colA.getMonth === 'function') {
          data = colA;
        } else if (typeof colA === 'number' && colA > 1) {
          // número serial do Google Sheets (dias desde 30/12/1899)
          data = new Date((colA - 25569) * 86400000);
        } else {
          const str = String(colA).trim();
          // DD/MM/AAAA (formato brasileiro): mês é o 2º grupo.
          const br = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (br) {
            mesAtual = Number(br[2]);
            anoAtual = Number(br[3]);
          } else if (str.match(/^\d{4}[-\/]\d{2}/)) {
            data = new Date(str);
          }
        }
        if (data && !isNaN(data.getTime())) {
          mesAtual = data.getMonth() + 1;
          anoAtual = data.getFullYear();
        }
      }

      const acao = String(colI || '').trim();
      const responsavel = String(colL || '').trim();
      const acaoNorm = acao.toUpperCase().replace(/\s+/g, ' ');

      if (acao && !acaoNorm.startsWith('AÇÕES') && !acaoNorm.startsWith('ACOES') && mesAtual && anoAtual) {
        acoes.push({ mes: mesAtual, ano: anoAtual, acao, responsavel });
      }
    }

    return { sucesso: true, acoes, debug: 'linhas:' + ultimaLinha + ' | colA[0-9]:' + debugColA.join(' | ') };
  } catch (e) {
    return { sucesso: false, acoes: [], debug: 'Erro: ' + String(e.message || e) };
  }
}

function montarPayloadDados(forcarRefresh) {
  const cfg = obterConfigRel(forcarRefresh === true);
  const ss = abrirPlanilhaRelatorio(cfg);
  const base = obterLinhasRelatorio(ss, 'CRP', cfg);
  const termos = montarTermosClassificacao(cfg);
  const col = RELATORIO_CRP_COLUNAS;
  const plano = obterPlanoDeAcaoDados(ss);

  const registros = base.linhas.map(row => {
    let flags = '';
    for (let idx = col.inicioIndicadores; idx <= col.fimIndicadores; idx++) {
      flags += codigoClassificacao(row[idx], termos);
    }
    return [
      normalizarAno(row[col.ano]) || 'Não informado',
      normalizarMes(row[col.mes]) || 'Não informado',
      String(row[col.avaliacaoTerminada] == null ? '' : row[col.avaliacaoTerminada]).trim() || 'Não informado',
      String(row[col.unidade] == null ? '' : row[col.unidade]).trim() || 'Não informado',
      String(row[col.eixo] == null ? '' : row[col.eixo]).trim() || 'Não informado',
      String(row[col.categoria] == null ? '' : row[col.categoria]).trim() || 'Não informado',
      String(row[col.satisfacao] == null ? '' : row[col.satisfacao]).trim() || 'Não informado',
      flags,
      numeroOuNull(row[col.numerador]),
      numeroOuNull(row[col.denominador]),
      numeroOuNull(row[col.resultado])
    ];
  });

  return {
    success: true,
    geradoEm: carimboAgora(),
    config: {
      metaInstitucional: cfg.metaInstitucional,
      tipoRelatorio: cfg.tipoRelatorio || 'executivo',
      logoUrl: cfg.logoUrl || LOGO_PADRAO,
      rodapeUrl: cfg.rodapeUrl || RODAPE_PADRAO,
      indicadores: cfg.indicadores || RELATORIO_CRP_INDICADORES.slice(),
      textosPadrao: cfg.textosPadrao
    },
    base: {
      comissao: 'CRP',
      aba: base.abaEncontrada,
      totalRegistros: registros.length,
      alertasEstrutura: base.alertasEstrutura || [],
      registros: registros
    },
    planoAcao: plano.acoes || [],
    planoAcaoDebug: plano.debug || '',
    textosPersonalizados: obterTextosPersonalizadosRel('CRP')
  };
}

function obterDadosRelatorio(opcoes) {
  return executarRota('rpc-dados', () => montarPayloadDados(Boolean(opcoes && opcoes.refresh)));
}

/* ============================================================
   RELATÓRIO CRO — Comissão de Revisão de Óbitos
   ------------------------------------------------------------
   Diferente da CRP (conformidade de itens do prontuário), a CRO
   analisa óbitos. A base é achatada: 1 linha por óbito, no modelo
   da aba "Distribuição e análises dos Óbitos", com unidade do
   óbito, mês/ano, status da 1ª avaliação (SIM / NÃO / LONDRES
   AVALIADO), ocorrência de evento adverso, sexo, faixa etária,
   macrorregião, unidade de origem, comorbidades e as datas de
   internação e óbito (para o tempo de permanência).

   O servidor lê a base, mapeia as colunas por NOME de cabeçalho
   (tolerante a reordenação, ao sufixo "GRÁFICO" e a cabeçalhos de
   múltiplas linhas) e devolve um dataset compacto. Filtro,
   agregação e montagem do documento acontecem no navegador.
   ============================================================ */
const META_CRO_AVALIACAO = 100;

// Nomes de aba aceitos para a base da CRO, em ordem de preferência.
const RELATORIO_CRO_ABAS = [
  'Distribuição e análises dos Óbitos',
  'Distribuição e análises dos Óbi',
  'Distribuição e Análise dos Óbitos',
  'Distribuição e Análise dos Óbit',
  'CRO', 'BASE CRO', 'BASE_CRO', 'CRO - BASE', 'RELATÓRIO CRO', 'RELATORIO CRO'
];

// Sinônimos de cabeçalho → campo lógico. A comparação usa
// normalizarCabecalho (sem acento, só A-Z0-9) e casa a frase
// delimitada por espaços, evitando falso positivo como IDADE dentro
// de "UNIDADE". O sufixo "GRÁFICO" e quebras de linha são ignorados.
const RELATORIO_CRO_CABECALHOS = [
  { chave: 'unidadeObito',   termos: ['UNIDADE DO OBITO', 'UNIDADE OBITO'] },
  { chave: 'mes',            termos: ['MES'] },
  { chave: 'ano',            termos: ['ANO'] },
  { chave: 'status',         termos: ['STATUS'] },
  { chave: 'avaliacao1',     termos: ['1 AVALIACAO CONCLUIDA', 'AVALIACAO CONCLUIDA', 'AVALIACAO REALIZADA', 'AVALIADO'] },
  { chave: 'eventoAdverso',  termos: ['EV ADVERSO', 'EVENTO ADVERSO'] },
  { chave: 'prontuario',     termos: ['PRONT', 'PRONTUARIO'] },
  { chave: 'idade',          termos: ['IDADE'] },
  { chave: 'faixaEtaria',    termos: ['FAIXA ETARIA', 'FAIXA ETARIA GRAFICO'] },
  { chave: 'sexo',           termos: ['SEXO', 'GENERO'] },
  { chave: 'comorbidades',   termos: ['COMORBIDADES', 'COMORBIDADE'] },
  { chave: 'macrorregiao',   termos: ['MACRORREGIAO', 'MACRO REGIAO'] },
  { chave: 'unidadeOrigem',  termos: ['UNIDADE DE ORIGEM', 'UNIDADE ORIGEM'] },
  { chave: 'dataInternacao', termos: ['DATA INTERNACAO', 'DATA DE INTERNACAO'] },
  { chave: 'dataObito',      termos: ['DATA OBITO', 'DATA DO OBITO'] }
];

const TEXTOS_PADRAO_CRO = {
  apresentacao: 'No período {periodo}, ocorreram {totalObitos} óbitos no HUC, sendo {taxaAnalisados} deles analisados pela Comissão de Revisão de Óbitos (CRO). Na primeira avaliação, {londres} óbito(s) foram classificados como "A esclarecer" e encaminhados a uma segunda avaliação, usando como ferramenta de investigação o Protocolo de Londres — que considera os fatores institucionais, ambientais, tecnológicos, individuais dos profissionais e do próprio paciente. Foram identificados {eventosAdversos} óbito(s) com eventos adversos graves/moderados que contribuíram, direta ou indiretamente, para o desfecho.',
  epidemiologia: 'No recorte {periodo}, a maioria dos óbitos ocorreu em {unidadeTop} ({unidadeTopPct} do total). Quanto ao perfil, {sexoMasculino} eram do sexo masculino e {sexoFeminino} do feminino, com predomínio da faixa etária {faixaTop}. Em relação à procedência, {macroTop} concentrou a maior parte dos casos. As comorbidades mais frequentes entre os óbitos foram {comorbidadesTop}.',
  indicadores: 'O indicador de avaliação de óbitos (1ª análise) alcançou {taxaAnalisados} no período (meta {metaInstitucional}). A taxa de óbitos "a esclarecer", encaminhados ao Protocolo de Londres, foi de {taxaLondres}. Os indicadores são monitorados mensalmente para sustentar a melhoria contínua e a segurança assistencial.',
  acoes: 'As ações abaixo decorrem dos planos de ação elaborados na investigação dos óbitos classificados como "a esclarecer" e dos eventos adversos identificados, com responsáveis, prazos e evidências de conclusão pactuados pela gestão.',
  conclusao: 'A análise consolidada da Comissão de Revisão de Óbitos evidencia o panorama do período {periodo} e direciona intervenções para reduzir eventos adversos evitáveis e qualificar a assistência. A continuidade do monitoramento por período e unidade permitirá verificar tendências e a sustentabilidade das melhorias.'
};

function configPadraoRelCRO() {
  return {
    comissao: 'CRO',
    metaInstitucional: META_CRO_AVALIACAO,
    planilhaIdCRO: PLANILHAS.relatoriosCRO,
    abaNomeCRO: ABA_RELATORIO_CRO,
    logoUrl: LOGO_PADRAO,
    rodapeUrl: RODAPE_PADRAO,
    textosPadrao: {
      apresentacao: TEXTOS_PADRAO_CRO.apresentacao,
      epidemiologia: TEXTOS_PADRAO_CRO.epidemiologia,
      indicadores: TEXTOS_PADRAO_CRO.indicadores,
      acoes: TEXTOS_PADRAO_CRO.acoes,
      conclusaoCRO: TEXTOS_PADRAO_CRO.conclusao
    }
  };
}

function limparValorCRO(valor) {
  const texto = String(valor == null ? '' : valor).trim();
  if (!texto || texto === '#REF!' || texto === '#DIV/0!' || texto === '-') return '';
  return texto;
}

function cabecalhoCROContemTermo(headerNorm, termo) {
  return (' ' + headerNorm + ' ').indexOf(' ' + termo + ' ') !== -1;
}

// Localiza a linha de cabeçalho (entre as primeiras linhas) e devolve o
// índice da linha e o mapa campo→coluna, casando por nome.
function mapearColunasCRO(values, limiteLinhas) {
  const limite = Math.min(values.length, limiteLinhas || 8);
  let melhor = null;
  for (let r = 0; r < limite; r++) {
    const headerNorm = (values[r] || []).map(c => normalizarCabecalho(c));
    const mapa = {};
    RELATORIO_CRO_CABECALHOS.forEach(def => {
      for (let c = 0; c < headerNorm.length; c++) {
        if (mapa[def.chave] != null) break;
        if (!headerNorm[c]) continue;
        if (def.termos.some(t => cabecalhoCROContemTermo(headerNorm[c], t))) {
          mapa[def.chave] = c;
          break;
        }
      }
    });
    const achados = Object.keys(mapa).length;
    if (!melhor || achados > melhor.achados) melhor = { linha: r, mapa, achados };
    if (achados >= RELATORIO_CRO_CABECALHOS.length) break;
  }
  return melhor || { linha: 0, mapa: {}, achados: 0 };
}

function obterAbaRelatorioCRO(ss, cfg) {
  const nomes = (cfg && cfg.abaNomeCRO ? [cfg.abaNomeCRO] : []).concat(RELATORIO_CRO_ABAS);
  for (let i = 0; i < nomes.length; i++) {
    const sh = ss.getSheetByName(nomes[i]);
    if (sh) return sh;
  }
  return null;
}

function diasEntreDatas(inicio, fim) {
  if (!(inicio instanceof Date) || !(fim instanceof Date)) return null;
  if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return null;
  const ms = fim.getTime() - inicio.getTime();
  if (ms < 0) return null;
  return Math.round(ms / 86400000);
}

function normalizarSexoCRO(valor) {
  const t = normalizarTexto(valor);
  if (!t) return 'Não informado';
  if (t === 'M' || t.indexOf('MASC') === 0) return 'Masculino';
  if (t === 'F' || t.indexOf('FEM') === 0) return 'Feminino';
  return 'Não informado';
}

function faixaPorIdadeCRO(idade) {
  if (idade < 20) return '<= 19 ANOS';
  if (idade >= 100) return '>= 100 ANOS';
  const dezena = Math.floor(idade / 10) * 10;
  return `${dezena} A ${dezena + 9} ANOS`;
}

// A idade é a fonte autoritativa da faixa etária. Quando a planilha não tem
// idade, a coluna de faixa costuma cair no default de fórmula "<= 19 ANOS"
// (data de nascimento vazia); nesse caso classificamos como "Não informado"
// para não inflar a faixa mais jovem.
function faixaEtariaCRO(valorIdade, valorFaixa) {
  const idade = numeroOuNull(limparValorCRO(valorIdade));
  if (idade != null && idade >= 0 && idade < 130) return faixaPorIdadeCRO(idade);
  const faixa = limparValorCRO(valorFaixa);
  if (!faixa) return 'Não informado';
  const norm = normalizarTexto(faixa);
  if (norm === '<= 19 ANOS' || norm === '<=19 ANOS' || norm === '< 20 ANOS') return 'Não informado';
  return faixa;
}

// Subconjunto público da configuração da CRO entregue pela rota api=dados.
// Espelha o cuidado de montarPayloadDados (CRP): expõe só o que o documento
// precisa (meta, imagens e textos) e nunca o ID da planilha nem os campos de
// auditoria (atualizadoEm/atualizadoPor — este último é o e-mail do admin),
// que ficam restritos à rota autenticada api=configrel / tela Administração.
function configPublicaCRO(cfg) {
  cfg = cfg || {};
  return {
    comissao: 'CRO',
    metaInstitucional: cfg.metaInstitucional != null ? cfg.metaInstitucional : META_CRO_AVALIACAO,
    logoUrl: cfg.logoUrl || LOGO_PADRAO,
    rodapeUrl: cfg.rodapeUrl || RODAPE_PADRAO,
    textosPadrao: cfg.textosPadrao
  };
}

function periodoCRODeValor(valor) {
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return {
      ano: String(valor.getFullYear()),
      mes: MESES_CANONICOS[valor.getMonth() + 1] || ''
    };
  }

  const texto = String(valor == null ? '' : valor).trim();
  if (!texto) return { ano: '', mes: '' };

  const partes = texto.match(/([A-Za-zÀ-ÿ.çÇ]+|\d{1,2})\D+(\d{2,4})/);
  if (partes) {
    const mes = normalizarMes(partes[1]);
    let ano = String(partes[2] || '').trim();
    if (ano.length === 2) ano = '20' + ano;
    return { ano: normalizarAno(ano), mes: mes };
  }

  const ano = texto.match(/\b(20\d{2}|19\d{2})\b/);
  return { ano: ano ? ano[1] : '', mes: normalizarMes(texto) };
}

function obterIndicadoresGerenciadosCRO(ss) {
  const sh = ss.getSheetByName(ABA_CRO_MORTALIDADE_INST);
  const resultado = { mortalidadeInstitucional: [], alertas: [] };
  if (!sh) {
    resultado.alertas.push(`Aba "${ABA_CRO_MORTALIDADE_INST}" não encontrada para a taxa de mortalidade institucional.`);
    return resultado;
  }

  // getDataRange() reads dimensions and data in a single API call.
  const all = sh.getDataRange().getValues();
  if (all.length < 2) return resultado;

  // W:Y = col 23-25 (0-indexed: 22-24) — período, numerador, denominador.
  const values = all.map(function(row) { return [row[22], row[23], row[24]]; });
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const periodoBruto = row[0];
    const numerador = numeroOuNull(row[1]);
    const denominador = numeroOuNull(row[2]);
    const periodo = periodoCRODeValor(periodoBruto);

    if (!String(periodoBruto == null ? '' : periodoBruto).trim() && numerador == null && denominador == null) continue;
    if (numerador == null && denominador == null) continue;

    resultado.mortalidadeInstitucional.push({
      periodo: String(periodoBruto == null ? '' : periodoBruto).trim(),
      ano: periodo.ano || 'Não informado',
      mes: periodo.mes || 'Não informado',
      numerador: numerador,
      denominador: denominador,
      taxa: denominador ? Number(((Number(numerador || 0) / denominador) * 100).toFixed(1)) : null
    });
  }

  return resultado;
}

function montarPayloadDadosCRO(forcarRefresh) {
  // Fast path: return cached payload when not forcing a refresh.
  if (!forcarRefresh) {
    try {
      const raw = CacheService.getScriptCache().get(DADOS_CRO_CACHE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
  }

  const cfgCRP = obterConfigRel(forcarRefresh === true);
  const cfg = obterConfigRelCRO(forcarRefresh === true, cfgCRP);
  const configPublica = configPublicaCRO(cfg);

  const id = (cfg.planilhaIdCRO && String(cfg.planilhaIdCRO).trim()) || PLANILHAS.relatoriosCRO || cfgCRP.planilhaId || PLANILHAS.relatorios;
  const ss = abrirPlanilhaPorIdCache(id, 'do relatório CRO');
  const sh = obterAbaRelatorioCRO(ss, cfg);
  const indicadoresGerenciados = obterIndicadoresGerenciadosCRO(ss);

  if (!sh) {
    return {
      success: true,
      geradoEm: carimboAgora(),
      config: configPublica,
      base: {
        comissao: 'CRO', aba: '', totalRegistros: 0,
        alertasEstrutura: ['Base da CRO não encontrada. Esperado uma aba como "Distribuição e análises dos Óbitos" ou "CRO".'].concat(indicadoresGerenciados.alertas || []),
        registros: [],
        indicadoresGerenciados: indicadoresGerenciados
      },
      textosPersonalizados: obterTextosPersonalizadosRel('CRO')
    };
  }

  // Single API call: read everything at once, then detect header in memory.
  const values = sh.getDataRange().getValues();
  const ultimaLinha = values.length;
  const linhasBuscaCabecalho = Math.min(ultimaLinha, 30);

  const alertas = [];
  const { linha: linhaHeader, mapa, achados } = mapearColunasCRO(values, linhasBuscaCabecalho);

  if (achados < 6) {
    alertas.push(`A base da CRO foi localizada em "${sh.getName()}", mas só ${achados} colunas conhecidas foram reconhecidas no cabeçalho.`);
    alertas.push('A leitura foi interrompida para evitar varrer a planilha inteira. Confira os cabeçalhos nas primeiras 30 linhas.');
    return {
      success: true,
      geradoEm: carimboAgora(),
      config: configPublica,
      base: {
        comissao: 'CRO',
        aba: sh.getName(),
        totalRegistros: 0,
        alertasEstrutura: alertas,
        registros: [],
        indicadoresGerenciados: indicadoresGerenciados
      },
      textosPersonalizados: obterTextosPersonalizadosRel('CRO')
    };
  }

  ['unidadeObito', 'avaliacao1', 'mes'].forEach(chave => {
    if (mapa[chave] == null) alertas.push(`Coluna "${chave}" não encontrada no cabeçalho da base da CRO.`);
  });

  const col = chave => (mapa[chave] != null ? mapa[chave] : -1);
  const valorCol = (row, chave) => { const c = col(chave); return c >= 0 ? row[c] : ''; };

  const registros = [];
  for (let r = linhaHeader + 1; r < values.length; r++) {
    const row = values[r];
    const prontuario = limparValorCRO(valorCol(row, 'prontuario'));
    const unidade = limparValorCRO(valorCol(row, 'unidadeObito'));
    const mes = normalizarMes(valorCol(row, 'mes'));
    const ano = normalizarAno(limparValorCRO(valorCol(row, 'ano')));
    // Linha é válida se tem ao menos prontuário, unidade ou mês reconhecível.
    if (!prontuario && !unidade && !mes) continue;

    const dias = diasEntreDatas(valorCol(row, 'dataInternacao'), valorCol(row, 'dataObito'));
    const idadeNum = numeroOuNull(limparValorCRO(valorCol(row, 'idade')));

    registros.push([
      ano || 'Não informado',
      mes || 'Não informado',
      unidade || 'Não informado',
      normalizarTexto(valorCol(row, 'avaliacao1')) || 'NÃO INFORMADO',
      normalizarTexto(valorCol(row, 'eventoAdverso')) || '',
      normalizarSexoCRO(valorCol(row, 'sexo')),
      faixaEtariaCRO(valorCol(row, 'idade'), valorCol(row, 'faixaEtaria')),
      limparValorCRO(valorCol(row, 'macrorregiao')) || 'Não informado',
      limparValorCRO(valorCol(row, 'unidadeOrigem')) || 'Não informado',
      limparValorCRO(valorCol(row, 'comorbidades')),
      dias,
      idadeNum,
      normalizarTexto(valorCol(row, 'status') || row[3]) || ''
    ]);
  }

  return {
    success: true,
    geradoEm: carimboAgora(),
    config: configPublica,
    base: {
      comissao: 'CRO',
      aba: sh.getName(),
      totalRegistros: registros.length,
      alertasEstrutura: alertas.concat(indicadoresGerenciados.alertas || []),
      registros: registros,
      indicadoresGerenciados: indicadoresGerenciados
    },
    textosPersonalizados: obterTextosPersonalizadosRel('CRO')
  };

  // Cache the payload so repeat loads within 5 min skip all Sheets reads.
  try {
    const serialized = JSON.stringify(payload);
    CacheService.getScriptCache().put(DADOS_CRO_CACHE_KEY, serialized, DADOS_CRO_CACHE_TTL);
  } catch (_) { /* payload too large for cache — skip silently */ }

  return payload;
}

function obterDadosRelatorioCRO(opcoes) {
  return executarRota('rpc-dados-cro', () => montarPayloadDadosCRO(Boolean(opcoes && opcoes.refresh)));
}
