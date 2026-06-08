/***********************************************************************
 * RELATÓRIO ANALÍTICO COSEP — App independente (mesmo modelo do Boletim)
 * Backend Apps Script. Serve index.html e fornece os dados (CRP).
 * Autossuficiente: não depende do Code.gs do Boletim.
 ***********************************************************************/

/* ===== Configuração ===== */
const PLANILHAS = {
  principal: '1XUtI9TSMJmTpbtfLjZbJ-uarRN94lu_Aqpsc46Lxmt4',
  relatorios: '1DjE-1Gx33RfWPkUtUW883-5SM2NVdeuDsq4wQ0XxGUw'
};
const ABA_RELATORIO_CRP = 'BASE_DADOS(NÃOEDITAR)';
const ABA_RELATORIO_CRO = 'CRO';
const FUSO_HORARIO = 'America/Fortaleza';
const META_INSTITUCIONAL = 80;
const CACHE_EXECUCAO_PLANILHAS = {};
const CACHE_EXECUCAO_BASE_RELATORIO = {};

const ORDEM_MESES = {
  'JANEIRO': 1,
  'FEVEREIRO': 2,
  'MARÇO': 3,
  'MARCO': 3,
  'ABRIL': 4,
  'MAIO': 5,
  'JUNHO': 6,
  'JULHO': 7,
  'AGOSTO': 8,
  'SETEMBRO': 9,
  'OUTUBRO': 10,
  'NOVEMBRO': 11,
  'DEZEMBRO': 12,
  'JAN': 1,
  'JAN.': 1,
  'FEV': 2,
  'FEV.': 2,
  'MAR': 3,
  'MAR.': 3,
  'ABR': 4,
  'ABR.': 4,
  'MAI': 5,
  'MAI.': 5,
  'JUN': 6,
  'JUN.': 6,
  'JUL': 7,
  'JUL.': 7,
  'AGO': 8,
  'AGO.': 8,
  'SET': 9,
  'SET.': 9,
  'OUT': 10,
  'OUT.': 10,
  'NOV': 11,
  'NOV.': 11,
  'DEZ': 12,
  'DEZ.': 12
};
const MESES_CANONICOS = {
  1: 'Janeiro',
  2: 'Fevereiro',
  3: 'Março',
  4: 'Abril',
  5: 'Maio',
  6: 'Junho',
  7: 'Julho',
  8: 'Agosto',
  9: 'Setembro',
  10: 'Outubro',
  11: 'Novembro',
  12: 'Dezembro'
};

/* ===== doGet: serve o app de relatórios ===== */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.api === 'relatorios' || params.api === '1') {
    return responderJson(executarRota('api-relatorios', () => {
      const cfg = obterConfigRel();
      return montarPayloadRelatorios(abrirPlanilhaRelatorio(cfg), extrairFiltrosRelatorios(params), cfg);
    }));
  }

  if (params.api === 'configrel') {
    return responderJson(obterConfigRelCosep(params.refresh === '1' || params.refresh === 'true'));
  }

  try {
    const template = HtmlService.createTemplateFromFile('index');
    template.appUrl = ScriptApp.getService().getUrl();
    return template
      .evaluate()
      .setTitle('Relatório Analítico COSEP')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (erro) {
    registrarErro('html-route', erro);
    return HtmlService
      .createHtmlOutput('<!doctype html><meta charset="utf-8"><title>Erro</title><body style="font-family:Inter,Arial,sans-serif;padding:32px">Não foi possível abrir o relatório.</body>')
      .setTitle('Erro ao abrir relatório');
  }
}

/* ===== Infraestrutura e helpers compartilhados ===== */
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
    geradoEm: Utilities.formatDate(new Date(), FUSO_HORARIO, "dd/MM/yyyy 'às' HH:mm")
  };
}

function registrarErro(origem, erro) {
  const detalhe = erro && erro.stack ? erro.stack : (erro && erro.message ? erro.message : String(erro || 'Erro desconhecido'));
  console.error(`[${origem}] ${detalhe}`);
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

function abrirPlanilhaLeitura(chavePlanilha) {
  const id = PLANILHAS[chavePlanilha];
  if (!id) {
    throw new Error(`Planilha não parametrizada para a chave "${chavePlanilha}".`);
  }

  return abrirPlanilhaPorIdCache(id, `"${chavePlanilha}" para leitura`);
}

function executarComPlanilha(chavePlanilha, callback) {
  const ss = abrirPlanilhaLeitura(chavePlanilha);
  return callback(ss);
}

function extrairListaFiltros(rawValue, normalizerFn) {
  const brutoLista = Array.isArray(rawValue) ? rawValue : String(rawValue || '').split(/[|,]/);

  const valores = brutoLista
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .map(item => normalizerFn ? normalizerFn(item) : item)
    .filter(Boolean);

  return [...new Set(valores)];
}

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

function mesParaOrdem(valor) {
  const texto = normalizarTexto(valor);
  if (!texto) return 99;
  if (ORDEM_MESES[texto]) return ORDEM_MESES[texto];

  const numero = Number(texto);
  if (!Number.isNaN(numero) && numero >= 1 && numero <= 12) return numero;
  return 99;
}

function ordenarMeses(a, b) {
  const ordemA = mesParaOrdem(a);
  const ordemB = mesParaOrdem(b);
  if (ordemA !== ordemB) return ordemA - ordemB;
  return String(a).localeCompare(String(b), 'pt-BR');
}

function incrementarMapa(mapa, chave) {
  const valor = String(chave == null ? '' : chave).trim() || 'Não informado';
  mapa[valor] = (mapa[valor] || 0) + 1;
}

function ordenarMapaPorValor(mapa) {
  const ordenado = {};
  Object.keys(mapa)
    .sort((a, b) => mapa[b] - mapa[a] || a.localeCompare(b, 'pt-BR'))
    .forEach(chave => {
      ordenado[chave] = mapa[chave];
    });
  return ordenado;
}

/* ===== Bloco de relatórios (CRP/CRO) ===== */
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

/* ============================================================
   CONFIGURAÇÃO SELF-SERVICE DO RELATÓRIO (autodependência)
   A configuração editável agora fica na própria planilha, na aba
   COSEP_REL_CONFIG. Script Properties permanece apenas como espelho
   técnico/fallback para Web Apps standalone e migração segura.
   ============================================================ */
const CONFIG_REL_PROP_KEY = 'COSEP_REL_CONFIG_V1';
const CONFIG_REL_BOOTSTRAP_PROP_KEY = 'COSEP_REL_CONFIG_SPREADSHEET_ID';
const CONFIG_REL_ADMINS_PROP_KEY = 'COSEP_REL_ADMINS';
const CONFIG_REL_SHEET = 'COSEP_REL_CONFIG';
const CONFIG_REL_LOG_SHEET = 'COSEP_REL_CONFIG_LOG';
const CONFIG_REL_SCHEMA_VERSION = '1.0';
const CONFIG_REL_CACHE_KEY = 'COSEP_REL_CONFIG_CACHE_V1';
const CONFIG_REL_CACHE_TTL_SECONDS = 21600; // 6 horas


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

function configPadraoRel() {
  return {
    metaInstitucional: META_INSTITUCIONAL,
    planilhaId: PLANILHAS.relatorios,
    abaNome: ABA_RELATORIO_CRP,
    indicadores: RELATORIO_CRP_INDICADORES.slice(),
    termosConforme: ['CONFORME'],
    termosNaoConforme: ['NÃO CONFORME', 'NAO CONFORME'],
    termosNaoSeAplica: ['NÃO SE APLICA', 'NAO SE APLICA', 'N/A', 'NA'],
    atualizadoEm: '',
    atualizadoPor: ''
  };
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
    termosConforme: lerListaConfigRel(mapa['Termos conforme']),
    termosNaoConforme: lerListaConfigRel(mapa['Termos não conforme']),
    termosNaoSeAplica: lerListaConfigRel(mapa['Termos não se aplica']),
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
    sh.getRange(13, 1, 1, 2).setFontWeight('bold').setBackground('#e4f5f2').setFontColor('#0b4f4a');
    sh.getRange(5, 2).setNote('Nome exato da aba que contém a base CRP.');
    sh.getRange(6, 2, 3, 1).setNote('Um termo por linha. A comparação ignora maiúsculas/minúsculas e acentos nos termos já normalizados pelo sistema.');
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

function abrirPlanilhaRelatorio(cfg) {
  cfg = cfg || obterConfigRel();
  const id = cfg.planilhaId || PLANILHAS.relatorios;
  return abrirPlanilhaPorIdCache(id, 'do relatório');
}

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

function obterConfigRelCosep(forcarRefresh) {
  return executarRota('rpc-configrel-get', () => ({
    success: true,
    config: obterConfigRel(forcarRefresh === true || forcarRefresh === '1'),
    podeEditar: usuarioPodeEditarRel(),
    usuario: emailUsuarioAtualRel(),
    geradoEm: Utilities.formatDate(new Date(), FUSO_HORARIO, "dd/MM/yyyy 'às' HH:mm")
  }));
}

function salvarConfigRelCosep(novaConfig) {
  return executarRota('rpc-configrel-save', () => executarComLockConfigRel('rpc-configrel-save-lock', () => {
    if (!usuarioPodeEditarRel()) return { success: false, mensagem: 'Você não tem permissão para alterar as configurações.' };
    const merged = mesclarConfigRel(configPadraoRel(), novaConfig || {});
    merged.atualizadoEm = Utilities.formatDate(new Date(), FUSO_HORARIO, "dd/MM/yyyy 'às' HH:mm");
    merged.atualizadoPor = emailUsuarioAtualRel() || 'desconhecido';
    salvarConfigRelNaAba(merged);
    registrarLogRelSemLock(merged.atualizadoPor, 'Configuração do relatório atualizada', merged);
    return { success: true, config: merged, mensagem: 'Configurações salvas com sucesso.' };
  }));
}

function restaurarConfigRelCosep() {
  return executarRota('rpc-configrel-reset', () => executarComLockConfigRel('rpc-configrel-reset-lock', () => {
    if (!usuarioPodeEditarRel()) return { success: false, mensagem: 'Você não tem permissão para alterar as configurações.' };
    const cfgPadraoAtualizada = configPadraoRel();
    cfgPadraoAtualizada.atualizadoEm = Utilities.formatDate(new Date(), FUSO_HORARIO, "dd/MM/yyyy 'às' HH:mm");
    cfgPadraoAtualizada.atualizadoPor = emailUsuarioAtualRel() || 'desconhecido';
    removerConfigRelDaAba(cfgPadraoAtualizada);
    salvarCacheConfigRel(cfgPadraoAtualizada);
    registrarLogRelSemLock(cfgPadraoAtualizada.atualizadoPor, 'Configuração do relatório restaurada para o padrão', cfgPadraoAtualizada);
    return { success: true, config: cfgPadraoAtualizada, mensagem: 'Configurações restauradas para o padrão.' };
  }));
}

function registrarLogRel(usuario, acao) {
  return executarComLockConfigRel('config-rel-log-lock', () => registrarLogRelSemLock(usuario, acao, obterConfigRel()));
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

function extrairFiltrosRelatorios(params) {
  const bruto = params || {};
  return {
    comissao: normalizarComissaoRelatorio(bruto.comissao || bruto.tipo || 'CRP'),
    anos: extrairListaFiltros(bruto.anos || bruto.ano || '', normalizarAno),
    meses: extrairListaFiltros(bruto.meses || bruto.mes || '', normalizarMes),
    unidades: extrairListaFiltros(bruto.unidades || bruto.unidade || '', value => String(value || '').trim()),
    eixos: extrairListaFiltros(bruto.eixos || bruto.eixo || '', value => String(value || '').trim()),
    categorias: extrairListaFiltros(bruto.categorias || bruto.categoria || '', value => String(value || '').trim()),
    satisfacoes: extrairListaFiltros(bruto.satisfacoes || bruto.satisfacao || '', value => String(value || '').trim()),
    status: extrairListaFiltros(bruto.status || bruto.avaliacaoTerminada || '', value => String(value || '').trim())
  };
}

function normalizarComissaoRelatorio(valor) {
  const texto = normalizarTexto(valor);
  if (texto === 'CRO') return 'CRO';
  return 'CRP';
}

function obterAbaRelatorio(ss, comissao, cfg) {
  const comNorm = normalizarComissaoRelatorio(comissao);
  let nomes = RELATORIO_ABAS_POR_COMISSAO[comNorm] || RELATORIO_ABAS_POR_COMISSAO.CRP;
  if (comNorm === 'CRP' && cfg && cfg.abaNome) nomes = [cfg.abaNome].concat(nomes);
  for (let i = 0; i < nomes.length; i++) {
    const sh = ss.getSheetByName(nomes[i]);
    if (sh) return sh;
  }
  return null;
}

function obterLinhasRelatorio(ss, comissao, cfg) {
  const comissaoNormalizada = normalizarComissaoRelatorio(comissao);
  const planilhaId = cfg && cfg.planilhaId ? String(cfg.planilhaId).trim() : (ss && ss.getId ? ss.getId() : PLANILHAS.relatorios);
  const abaCfg = cfg && cfg.abaNome ? String(cfg.abaNome).trim() : '';
  const chaveCache = [planilhaId, comissaoNormalizada, abaCfg].join('::');

  if (CACHE_EXECUCAO_BASE_RELATORIO[chaveCache]) {
    return CACHE_EXECUCAO_BASE_RELATORIO[chaveCache];
  }

  const sh = obterAbaRelatorio(ss, comissaoNormalizada, cfg);
  if (!sh) {
    const vazio = { abaEncontrada: '', headers: [], linhas: [], estrutura: RELATORIO_CRP_ESTRUTURA, alertasEstrutura: ['Aba da CRP não encontrada.'] };
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
    estrutura: comissaoNormalizada === 'CRP' ? RELATORIO_CRP_ESTRUTURA : [],
    alertasEstrutura: comissaoNormalizada === 'CRP' ? validarEstruturaCRP(headers) : []
  };

  CACHE_EXECUCAO_BASE_RELATORIO[chaveCache] = base;
  return base;
}

function obterCampoCRPPorIndice(idx) {
  return RELATORIO_CRP_ESTRUTURA.find(campo => campo.idx === idx) || null;
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

function getRelatoriosFiltros(ss) {
  const base = obterLinhasRelatorio(ss, 'CRP');
  return coletarFiltrosRelatorio(base.linhas, base.abaEncontrada);
}

function coletarFiltrosRelatorio(linhas, abaEncontrada) {
  const col = RELATORIO_CRP_COLUNAS;
  const filtros = {
    comissoes: [{ codigo: 'CRP', nome: 'CRP', disponivel: true }, { codigo: 'CRO', nome: 'CRO', disponivel: false }],
    abaEncontrada: abaEncontrada || '',
    anos: {},
    meses: {},
    unidades: {},
    eixos: {},
    categorias: {},
    satisfacoes: {},
    status: {}
  };

  linhas.forEach(row => {
    const ano = normalizarAno(row[col.ano]);
    const mes = normalizarMes(row[col.mes]);
    const unidade = String(row[col.unidade] || '').trim() || 'Não informado';
    const eixo = String(row[col.eixo] || '').trim() || 'Não informado';
    const categoria = String(row[col.categoria] || '').trim() || 'Não informado';
    const satisfacao = String(row[col.satisfacao] || '').trim() || 'Não informado';
    const status = String(row[col.avaliacaoTerminada] || '').trim() || 'Não informado';

    if (ano) filtros.anos[ano] = true;
    if (mes) filtros.meses[mes] = true;
    if (unidade) filtros.unidades[unidade] = true;
    if (eixo) filtros.eixos[eixo] = true;
    if (categoria) filtros.categorias[categoria] = true;
    if (satisfacao) filtros.satisfacoes[satisfacao] = true;
    if (status) filtros.status[status] = true;
  });

  return {
    comissoes: filtros.comissoes,
    abaEncontrada: filtros.abaEncontrada,
    anos: Object.keys(filtros.anos).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b, 'pt-BR')),
    meses: Object.keys(filtros.meses).sort(ordenarMeses),
    unidades: Object.keys(filtros.unidades).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    eixos: Object.keys(filtros.eixos).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    categorias: Object.keys(filtros.categorias).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    satisfacoes: Object.keys(filtros.satisfacoes).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    status: Object.keys(filtros.status).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  };
}

function montarPayloadRelatorios(ss, filtros, cfg) {
  cfg = cfg || obterConfigRel();
  const filtrosAplicados = extrairFiltrosRelatorios(filtros || {});
  // Lê a base uma única vez (os filtros vêm sempre da CRP). Evita reler o
  // getDataRange() duas vezes por requisição.
  const baseCRP = obterLinhasRelatorio(ss, 'CRP', cfg);
  const baseProcessamento = filtrosAplicados.comissao === 'CRP'
    ? baseCRP
    : obterLinhasRelatorio(ss, filtrosAplicados.comissao, cfg);
  return {
    success: true,
    geradoEm: Utilities.formatDate(new Date(), FUSO_HORARIO, "dd/MM/yyyy 'às' HH:mm"),
    filtros: coletarFiltrosRelatorio(baseCRP.linhas, baseCRP.abaEncontrada),
    aplicado: filtrosAplicados,
    relatorio: processarRelatorioCRP(filtrosAplicados, baseProcessamento, cfg)
  };
}

function obterPayloadRelatorios(filtros) {
  return executarRota('rpc-relatorios', () => {
    const cfg = obterConfigRel();
    return montarPayloadRelatorios(abrirPlanilhaRelatorio(cfg), extrairFiltrosRelatorios(filtros || {}), cfg);
  });
}

function atendeFiltroRelatorio(valor, setFiltro, normalizerFn) {
  if (!setFiltro || !setFiltro.size) return true;
  const valorNormalizado = normalizerFn ? normalizerFn(valor) : String(valor || '').trim();
  return setFiltro.has(valorNormalizado);
}

function classificarValorIndicador(valor, termos) {
  const texto = normalizarTexto(valor);
  if (!texto || texto === '-') return 'vazio';
  if (termos) {
    if (termos.conforme.has(texto)) return 'conforme';
    if (termos.naoConforme.has(texto)) return 'naoConforme';
    if (termos.naoSeAplica.has(texto)) return 'naoSeAplica';
    return 'outro';
  }
  if (texto === 'CONFORME') return 'conforme';
  if (texto === 'NÃO CONFORME' || texto === 'NAO CONFORME') return 'naoConforme';
  if (texto === 'NÃO SE APLICA' || texto === 'NAO SE APLICA' || texto === 'N/A' || texto === 'NA') return 'naoSeAplica';
  return 'outro';
}

function nomeIndicadorRelatorio(header, fallback) {
  const texto = String(header || '').replace(/\s+/g, ' ').trim();
  if (!texto) return fallback;
  return texto.split(/\s{2,}| - /)[0].trim() || texto.substring(0, 90);
}

function percentualRelatorio(conformes, naoConformes) {
  const denominador = Number(conformes || 0) + Number(naoConformes || 0);
  return denominador ? Number(((Number(conformes || 0) / denominador) * 100).toFixed(1)) : null;
}

function processarRelatorioCRP(filtros, base, cfg) {
  cfg = cfg || obterConfigRel();
  if (!base) {
    const ss = abrirPlanilhaRelatorio(cfg);
    base = obterLinhasRelatorio(ss, filtros.comissao || 'CRP', cfg);
  }
  const col = RELATORIO_CRP_COLUNAS;
  const termos = {
    conforme: new Set((cfg.termosConforme || []).map(normalizarTexto)),
    naoConforme: new Set((cfg.termosNaoConforme || []).map(normalizarTexto)),
    naoSeAplica: new Set((cfg.termosNaoSeAplica || []).map(normalizarTexto))
  };
  const classifica = valor => classificarValorIndicador(valor, termos);
  const nomesIndicadores = cfg.indicadores || [];
  const anosFiltro = new Set((filtros.anos || []).map(normalizarAno).filter(Boolean));
  const mesesFiltro = new Set((filtros.meses || []).map(normalizarMes).filter(Boolean));
  const unidadesFiltro = new Set((filtros.unidades || []).map(item => String(item || '').trim()).filter(Boolean));
  const eixosFiltro = new Set((filtros.eixos || []).map(item => String(item || '').trim()).filter(Boolean));
  const categoriasFiltro = new Set((filtros.categorias || []).map(item => String(item || '').trim()).filter(Boolean));
  const satisfacoesFiltro = new Set((filtros.satisfacoes || []).map(item => String(item || '').trim()).filter(Boolean));
  const statusFiltro = new Set((filtros.status || []).map(item => String(item || '').trim()).filter(Boolean));

  const linhasFiltradas = base.linhas.filter(row => {
    if (!atendeFiltroRelatorio(row[col.ano], anosFiltro, normalizarAno)) return false;
    if (!atendeFiltroRelatorio(row[col.mes], mesesFiltro, normalizarMes)) return false;
    if (!atendeFiltroRelatorio(String(row[col.unidade] || '').trim() || 'Não informado', unidadesFiltro)) return false;
    if (!atendeFiltroRelatorio(String(row[col.eixo] || '').trim() || 'Não informado', eixosFiltro)) return false;
    if (!atendeFiltroRelatorio(String(row[col.categoria] || '').trim() || 'Não informado', categoriasFiltro)) return false;
    if (!atendeFiltroRelatorio(String(row[col.satisfacao] || '').trim() || 'Não informado', satisfacoesFiltro)) return false;
    if (!atendeFiltroRelatorio(String(row[col.avaliacaoTerminada] || '').trim() || 'Não informado', statusFiltro)) return false;
    return true;
  });

  const indicadores = [];
  for (let idx = col.inicioIndicadores; idx <= col.fimIndicadores; idx++) {
    const campo = obterCampoCRPPorIndice(idx);
    const nomeCfg = nomesIndicadores[idx - col.inicioIndicadores];
    indicadores.push({
      idx: idx,
      coluna: campo ? campo.letra : colunaParaLetra(idx),
      nome: (nomeCfg && String(nomeCfg).trim()) || (campo ? campo.nome : nomeIndicadorRelatorio(base.headers[idx], `Indicador ${idx + 1}`)),
      cabecalhoPlanilha: nomeIndicadorRelatorio(base.headers[idx], campo ? campo.nome : `Indicador ${idx + 1}`),
      conformes: 0,
      naoConformes: 0,
      naoSeAplica: 0,
      vazios: 0,
      outros: 0,
      avaliados: 0,
      percentual: null
    });
  }

  const porUnidade = {};
  const porEixo = {};
  const porCategoria = {};
  const porSatisfacao = {};
  const porStatus = {};
  const evolucaoMap = {};
  const resumoSetores = {};
  let conformes = 0;
  let naoConformes = 0;
  let naoSeAplica = 0;
  let vazios = 0;
  let outros = 0;
  let numeradorPlanilha = 0;
  let denominadorPlanilha = 0;
  let somaResultadoPlanilha = 0;
  let totalResultadoPlanilha = 0;

  linhasFiltradas.forEach(row => {
    const unidade = String(row[col.unidade] || '').trim() || 'Não informado';
    const eixo = String(row[col.eixo] || '').trim() || 'Não informado';
    const categoria = String(row[col.categoria] || '').trim() || 'Não informado';
    const satisfacao = String(row[col.satisfacao] || '').trim() || 'Não informado';
    const status = String(row[col.avaliacaoTerminada] || '').trim() || 'Não informado';
    const mes = normalizarMes(row[col.mes]) || 'Sem mês';

    incrementarMapa(porUnidade, unidade);
    incrementarMapa(porEixo, eixo);
    incrementarMapa(porCategoria, categoria);
    incrementarMapa(porSatisfacao, satisfacao);
    incrementarMapa(porStatus, status);
    if (!evolucaoMap[mes]) evolucaoMap[mes] = { conformes: 0, naoConformes: 0 };
    if (!resumoSetores[unidade]) resumoSetores[unidade] = { setor: unidade, avaliacoes: 0, conformes: 0, naoConformes: 0 };
    resumoSetores[unidade].avaliacoes++;

    const num = Number(row[col.numerador]);
    const den = Number(row[col.denominador]);
    const res = Number(row[col.resultado]);
    if (!Number.isNaN(num)) numeradorPlanilha += num;
    if (!Number.isNaN(den)) denominadorPlanilha += den;
    if (!Number.isNaN(res)) {
      somaResultadoPlanilha += res > 1 ? res : res * 100;
      totalResultadoPlanilha++;
    }

    indicadores.forEach(indicador => {
      const classe = classifica(row[indicador.idx]);
      if (classe === 'conforme') {
        indicador.conformes++;
        indicador.avaliados++;
        conformes++;
        evolucaoMap[mes].conformes++;
        resumoSetores[unidade].conformes++;
      } else if (classe === 'naoConforme') {
        indicador.naoConformes++;
        indicador.avaliados++;
        naoConformes++;
        evolucaoMap[mes].naoConformes++;
        resumoSetores[unidade].naoConformes++;
      } else if (classe === 'naoSeAplica') {
        indicador.naoSeAplica++;
        naoSeAplica++;
      } else if (classe === 'vazio') {
        indicador.vazios++;
        vazios++;
      } else {
        indicador.outros++;
        outros++;
      }
    });
  });

  indicadores.forEach(item => {
    item.percentual = percentualRelatorio(item.conformes, item.naoConformes);
  });

  const totalAuditavel = conformes + naoConformes;
  const conformidadeGeral = percentualRelatorio(conformes, naoConformes) || 0;
  const indicadoresOrdenados = indicadores.slice().sort((a, b) => {
    const pa = a.percentual == null ? 101 : a.percentual;
    const pb = b.percentual == null ? 101 : b.percentual;
    return pa - pb || b.naoConformes - a.naoConformes || a.nome.localeCompare(b.nome, 'pt-BR');
  });

  const evolucaoMensal = Object.keys(evolucaoMap).sort(ordenarMeses).map(mes => ({
    mes: mes,
    conformes: evolucaoMap[mes].conformes,
    naoConformes: evolucaoMap[mes].naoConformes,
    percentual: percentualRelatorio(evolucaoMap[mes].conformes, evolucaoMap[mes].naoConformes) || 0
  }));

  const rankingSetores = Object.keys(resumoSetores).map(setor => {
    const resumo = resumoSetores[setor];
    return {
      setor: setor,
      avaliacoes: resumo.avaliacoes,
      conformes: resumo.conformes,
      naoConformes: resumo.naoConformes,
      percentual: percentualRelatorio(resumo.conformes, resumo.naoConformes)
    };
  }).sort((a, b) => (a.percentual == null ? 101 : a.percentual) - (b.percentual == null ? 101 : b.percentual) || a.setor.localeCompare(b.setor, 'pt-BR'));

  const amostra = linhasFiltradas.slice(0, 25).map(row => ({
    prontuario: String(row[col.prontuario] || '').trim(),
    unidade: String(row[col.unidade] || '').trim(),
    eixo: String(row[col.eixo] || '').trim(),
    categoria: String(row[col.categoria] || '').trim(),
    satisfacao: String(row[col.satisfacao] || '').trim(),
    status: String(row[col.avaliacaoTerminada] || '').trim(),
    resultado: row[col.resultado]
  }));

  return {
    comissao: normalizarComissaoRelatorio(filtros.comissao),
    abaEncontrada: base.abaEncontrada,
    totalRegistrosBase: base.linhas.length,
    totalAvaliacoes: linhasFiltradas.length,
    totalAuditavel: totalAuditavel,
    conformes: conformes,
    naoConformes: naoConformes,
    naoSeAplica: naoSeAplica,
    vazios: vazios,
    outros: outros,
    conformidadeGeral: conformidadeGeral,
    metaInstitucional: cfg.metaInstitucional,
    diferencaMeta: Number((conformidadeGeral - cfg.metaInstitucional).toFixed(1)),
    numeradorPlanilha: numeradorPlanilha,
    denominadorPlanilha: denominadorPlanilha,
    resultadoPlanilha: denominadorPlanilha ? Number(((numeradorPlanilha / denominadorPlanilha) * 100).toFixed(1)) : (totalResultadoPlanilha ? Number((somaResultadoPlanilha / totalResultadoPlanilha).toFixed(1)) : null),
    estruturaColunas: base.estrutura || RELATORIO_CRP_ESTRUTURA,
    alertasEstrutura: base.alertasEstrutura || [],
    indicadores: indicadores,
    indicadoresCriticos: indicadoresOrdenados.filter(item => item.avaliados > 0).slice(0, 8),
    indicadoresExcelencia: indicadores.slice().filter(item => item.avaliados > 0).sort((a, b) => b.percentual - a.percentual || b.avaliados - a.avaliados).slice(0, 5),
    porUnidade: ordenarMapaPorValor(porUnidade),
    porEixo: ordenarMapaPorValor(porEixo),
    porCategoria: ordenarMapaPorValor(porCategoria),
    porSatisfacao: ordenarMapaPorValor(porSatisfacao),
    porStatus: ordenarMapaPorValor(porStatus),
    rankingSetores: rankingSetores,
    evolucaoMensal: evolucaoMensal,
    amostra: amostra
  };
}

