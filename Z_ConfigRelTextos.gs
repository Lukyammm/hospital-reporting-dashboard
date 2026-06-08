/*
 * Camada complementar para persistir tipo e mensagens padrão do relatório.
 * Mantém as mesmas APIs de Code.gs e estende a aba COSEP_REL_CONFIG.
 */

function configPadraoRel() {
  return {
    metaInstitucional: META_INSTITUCIONAL,
    planilhaId: PLANILHAS.relatorios,
    abaNome: ABA_RELATORIO_CRP,
    tipoRelatorio: 'executivo',
    indicadores: RELATORIO_CRP_INDICADORES.slice(),
    termosConforme: ['CONFORME'],
    termosNaoConforme: ['NÃO CONFORME', 'NAO CONFORME'],
    termosNaoSeAplica: ['NÃO SE APLICA', 'NAO SE APLICA', 'N/A', 'NA'],
    textosPadrao: {
      intro: 'Este relatório apresenta a análise consolidada da comissão {comissao} para o período {periodo}, considerando {setores}. O objetivo é sintetizar o desempenho dos registros avaliados, evidenciar conformidades e não conformidades e apoiar decisões de melhoria contínua.',
      metodo: 'A base foi lida diretamente da aba {abaEncontrada} da planilha institucional, usando a estrutura oficial da CRP de A até AQ. Para cálculo de conformidade, entram no denominador apenas itens classificados como Conforme ou Não Conforme; itens Não se Aplica, vazios ou marcados com hífen são apresentados separadamente para transparência da amostra.',
      analise: 'No recorte selecionado, foram identificadas {totalAvaliacoes} avaliações e {totalAuditavel} itens auditáveis. A conformidade geral foi de {conformidadeGeral}, com {conformes} conformidades e {naoConformes} não conformidades. Os principais pontos de atenção foram: {criticos}. Como fortalezas, destacam-se: {fortalezas}.',
      plano: 'Recomenda-se priorizar os indicadores com menor conformidade, revisar rotinas de preenchimento junto às equipes assistenciais, reforçar orientação sobre completude documental e acompanhar mensalmente os setores com maior volume de não conformidades. A gestão deve pactuar responsáveis, prazos e evidências de conclusão para cada ação corretiva.',
      conclusao: 'A análise demonstra o panorama atual da qualidade dos registros da comissão {comissao} e direciona intervenções objetivas para elevar a aderência documental. A continuidade do monitoramento por período, setor e categoria permitirá verificar tendência, sustentabilidade das melhorias e alinhamento à meta institucional de {metaInstitucional}.'
    },
    atualizadoEm: '',
    atualizadoPor: ''
  };
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
    sh.getRange(19, 1, 1, 2).setFontWeight('bold').setBackground('#e4f5f2').setFontColor('#0b4f4a');
    sh.getRange(5, 2).setNote('Nome exato da aba que contém a base CRP.');
    sh.getRange(7, 2, 5, 1).setNote('Use tokens como {comissao}, {periodo}, {setores}, {conformidadeGeral}, {criticos}, {fortalezas} e {metaInstitucional}.');
    sh.getRange(12, 2, 3, 1).setNote('Um termo por linha. A comparação ignora maiúsculas/minúsculas e acentos nos termos já normalizados pelo sistema.');
  } catch (erro) {
    registrarErro('formatar-config-rel-textos', erro);
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
  if (salvo.textosPadrao && typeof salvo.textosPadrao === 'object') {
    cfg.textosPadrao = cfg.textosPadrao || {};
    ['intro', 'metodo', 'analise', 'plano', 'conclusao'].forEach(chave => {
      if (salvo.textosPadrao[chave] != null && String(salvo.textosPadrao[chave]).trim()) {
        cfg.textosPadrao[chave] = String(salvo.textosPadrao[chave]).trim();
      }
    });
  }
  if (Array.isArray(salvo.indicadores) && salvo.indicadores.length) {
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
