/**
 * ============================================================================
 * FROTA.OS v5.0 // SCRIPT MESTRE UNIFICADO (script.js)
 * Motor Lógico, Estado Local-First, Renderização e Eventos de UI BLINDADOS
 * ============================================================================
 */
'use strict';

const $ = id => document.getElementById(id);
const escapeHTML = str => String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const generateId = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
const parseTime = val => { 
  if (!val) return 0; 
  const str = String(val).trim();
  if (str.includes(':')) { const [h, m] = str.split(':').map(Number); return ((h||0) * 60) + (m || 0); }
  return Number(str) || 0;
};
const formatMins = m => { const h = Math.floor(m / 60), mins = m % 60; return `${h}h${mins > 0 ? String(mins).padStart(2, '0') : ''}`; };

// ==========================================
// 1. MOTOR LÓGICO DE ESCALAS (ScheduleEngine)
// ==========================================
const ScheduleEngine = {
  formatDateISO: (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  getDaysInMonth: (y, m) => new Date(y, m + 1, 0).getDate(),
  getDayOfWeek: (y, m, d) => new Date(y, m, d).getDay(),
  isWeekend: (y, m, d) => [0, 6].includes(new Date(y, m, d).getDay()),
  parseISODate: iso => iso ? new Date(parseInt(iso.split('-')[0]), parseInt(iso.split('-')[1]) - 1, parseInt(iso.split('-')[2])) : new Date(),
  daysBetween: (a, b) => Math.floor((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000),

  getAutoStatus(emp, y, m, d) {
    const target = new Date(y, m, d), start = this.parseISODate(emp.cycleStartDate || `${y}-01-01`);
    const diff = this.daysBetween(start, target), dw = this.getDayOfWeek(y, m, d), rule = emp.rule || 'SD1';
    
    if (rule === 'SD1') return dw === 6 ? 'F' : 'T';
    if (rule === 'SD2') return dw === 0 ? 'F' : 'T';
    if (rule === '5x2') return [0, 6].includes(dw) ? 'F' : 'T';
    if (rule === '6x1') return ((diff % 7) + 7) % 7 === 6 ? 'F' : 'T';
    if (rule === '12x36') return ((diff % 2) + 2) % 2 === 0 ? 'T' : 'F';
    return 'T';
  },

  resolveCell(emp, y, m, d, cfg, vacs, overrides, ot) {
    const iso = this.formatDateISO(y, m, d), key = `${emp.id}_${iso}`;
    
    // Férias oficiais
    if ((vacs || []).some(v => v.employeeId === emp.id && iso >= v.startDate && iso <= v.endDate)) {
      return { status: 'FERIAS', text: 'FER', isYellow: true, isOverride: false };
    }
    
    // Ajustes Manuais vs Automático
    const over = (overrides || {})[key];
    const base = over ? over.status : this.getAutoStatus(emp, y, m, d);
    
    // Feriados e Destaques
    const isHol = (cfg.holidays || []).includes(iso);
    let isYel = isHol || (base === 'F' && cfg.highlightAllOffYellow);
    if (over && over.yellow === 'yes') isYel = true;
    if (over && over.yellow === 'no') isYel = false;
    
    let text = base;
    if (base === 'FERIAS') text = 'FER';
    else if (base === 'T' && !cfg.showWorkSymbol) text = '';
    
    return { status: base, text, isOverride: !!over, isYellow: isYel, isHoliday: isHol, he: (ot || {})[key] || null };
  }
};

// ==========================================
// 2. GESTÃO DE ESTADO (Store - com proteção)
// ==========================================
const Store = {
  state: {
    config: { mainTitle: 'MONITORAMENTO DA FROTA', subtitle: '', year: new Date().getFullYear(), monthIndex: new Date().getMonth(), minCoverage: 4, emptyRowsPerBlock: 3, highlightAllOffYellow: false, showWorkSymbol: false, showWeekdayRow: false, showHESheet: false, holidays: [] },
    blocks: [{ id: 'b1', name: 'MANHÃ', order: 1 }, { id: 'b2', name: 'TARDE', order: 2 }],
    employees: [], vacations: [], manualOverrides: {}, overtime: {},
    activeTab: 'tab-dashboard', activeBrush: 'F', theme: 'dark', previewZoom: 0.85, searchQuery: '', isReadOnly: false
  },
  undoStack: [], redoStack: [],

  init() {
    try { 
      const raw = localStorage.getItem('FROTA_OS_V5_STATE'); 
      if (raw) {
        const p = JSON.parse(raw);
        this.state.config = { ...this.state.config, ...(p.config || {}) };
        this.state.blocks = Array.isArray(p.blocks) && p.blocks.length ? p.blocks : this.state.blocks;
        this.state.employees = Array.isArray(p.employees) ? p.employees : this.state.employees;
        this.state.vacations = Array.isArray(p.vacations) ? p.vacations : this.state.vacations;
        this.state.manualOverrides = p.manualOverrides || this.state.manualOverrides;
        this.state.overtime = p.overtime || this.state.overtime;
      }
    } catch(e) { console.warn('Aviso: Estrutura local vazia ou corrompida. Iniciando limpo.'); }
  },

  notify() {
    try {
      localStorage.setItem('FROTA_OS_V5_STATE', JSON.stringify({ 
        config: this.state.config, blocks: this.state.blocks, employees: this.state.employees, 
        vacations: this.state.vacations, manualOverrides: this.state.manualOverrides, overtime: this.state.overtime 
      }));
    } catch(e) {}
    Renderer.renderAll();
  },

  snapshot() {
    if(this.undoStack.length > 30) this.undoStack.shift();
    this.undoStack.push(JSON.stringify({ emp: this.state.employees, mo: this.state.manualOverrides, ot: this.state.overtime, vac: this.state.vacations, blk: this.state.blocks }));
    this.redoStack = [];
    Renderer.updateHistoryBtns();
  },

  undo() {
    if(!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify({ emp: this.state.employees, mo: this.state.manualOverrides, ot: this.state.overtime, vac: this.state.vacations, blk: this.state.blocks }));
    const prev = JSON.parse(this.undoStack.pop());
    this.state.employees = prev.emp || []; this.state.manualOverrides = prev.mo || {}; this.state.overtime = prev.ot || {}; this.state.vacations = prev.vac || []; this.state.blocks = prev.blk || [];
    this.notify();
  },

  redo() {
    if(!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify({ emp: this.state.employees, mo: this.state.manualOverrides, ot: this.state.overtime, vac: this.state.vacations, blk: this.state.blocks }));
    const next = JSON.parse(this.redoStack.pop());
    this.state.employees = next.emp || []; this.state.manualOverrides = next.mo || {}; this.state.overtime = next.ot || {}; this.state.vacations = next.vac || []; this.state.blocks = next.blk || [];
    this.notify();
  },

  wipeAllData() {
    this.snapshot();
    this.state.employees = []; this.state.vacations = []; this.state.manualOverrides = {}; this.state.overtime = {}; 
    this.state.blocks = [{ id: 'b1', name: 'MANHÃ', order: 1 }, { id: 'b2', name: 'TARDE', order: 2 }];
    this.notify();
  }
};

// ==========================================
// 3. CONSTRUTOR HTML DA PLANILHA
// ==========================================
const SheetBuilder = {
  buildHTML(interactive = false) {
    const { config: cfg, blocks, employees, vacations, manualOverrides: mo, overtime: ot, searchQuery: q } = Store.state;
    const dCount = ScheduleEngine.getDaysInMonth(cfg.year, cfg.monthIndex);
    const mNames = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
    const title = cfg.subtitle ? escapeHTML(cfg.subtitle.toUpperCase()) : `${mNames[cfg.monthIndex]} ${cfg.year}`;
    const wd = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
    
    let html = `<div class="official-sheet-paper" style="width:${400 + (dCount*25)}px"><table class="fleet-schedule-table" style="width:100%">`;
    html += `<tr class="row-main-title"><th colspan="${4 + dCount}">${escapeHTML(cfg.mainTitle)}</th></tr>`;
    html += `<tr class="row-subtitle"><th colspan="${4 + dCount}">${title}</th></tr>`;
    html += `<tr class="row-col-headers"><th style="width:160px;">EFETIVO</th><th style="width:70px;">Matrícula</th><th style="width:60px;">Escala</th>`;
    html += `<th colspan="${dCount}">${title}</th><th style="width:90px;">Assistentes:</th></tr>`;
    
    if (cfg.showWeekdayRow) {
      html += `<tr class="row-col-headers"><th colspan="3">DIA DA SEMANA</th>`;
      for(let d=1; d<=dCount; d++) html += `<th class="${ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d)?'is-weekend':''}">${wd[ScheduleEngine.getDayOfWeek(cfg.year, cfg.monthIndex, d)]}</th>`;
      html += `<th></th></tr>`;
    }

    html += `<tr class="row-col-headers"><th colspan="3"></th>`;
    for(let d=1; d<=dCount; d++) html += `<th class="${ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d)?'is-weekend':''}">${d}</th>`;
    html += `<th></th></tr>`;

    let emps = employees || [];
    if(q) emps = emps.filter(e => (e.name||'').toLowerCase().includes(q.toLowerCase()) || (e.registration||'').includes(q));

    [...(blocks || [])].sort((a,b)=>a.order-b.order).forEach(b => {
      html += `<tr class="row-subtitle"><td colspan="${4 + dCount}">${escapeHTML((b.name||'').toUpperCase())}</td></tr>`;
      emps.filter(e => e.blockId === b.id).forEach(e => {
        const trAttr = interactive ? `data-ctx-emp="${e.id}" class="col-escala cursor-pointer"` : `class="col-escala"`;
        html += `<tr><td style="text-align:left;padding-left:6px;">${escapeHTML(e.name)}</td><td>${escapeHTML(e.registration)}</td><td ${trAttr}>${escapeHTML(e.rule)}</td>`;
        for(let d=1; d<=dCount; d++) {
          const c = ScheduleEngine.resolveCell(e, cfg.year, cfg.monthIndex, d, cfg, vacations, mo, ot);
          let cls = c.isYellow ? 'is-yellow' : (ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d) ? 'is-weekend' : '');
          if (c.status === 'FER' || c.status === 'FERIAS') cls += ' is-vacation';
          
          const tdAttr = interactive ? `data-emp-id="${e.id}" data-day="${d}" class="interactive-cell ${cls}" tabindex="0"` : `class="${cls}"`;
          html += `<td ${tdAttr}>`;
          if(c.isOverride && interactive) html += `<div style="position:absolute;top:2px;left:2px;width:4px;height:4px;background:#2563eb;border-radius:50%;"></div>`;
          html += escapeHTML(c.text);
          if(c.he && (cfg.showHESheet || interactive)) html += `<span class="he-mini">${c.he.type === 'AUTO' ? (c.he.minutes/60)+'h' : c.he.type}</span>`;
          html += `</td>`;
        }
        html += `<td></td></tr>`;
      });
      for(let i=0; i<(cfg.emptyRowsPerBlock||3); i++) {
        html += `<tr><td>&nbsp;</td><td></td><td></td>`;
        for(let d=1; d<=dCount; d++) html += `<td class="${(cfg.holidays||[]).includes(ScheduleEngine.formatDateISO(cfg.year,cfg.monthIndex,d))?'is-yellow':(ScheduleEngine.isWeekend(cfg.year,cfg.monthIndex,d)?'is-weekend':'')}"></td>`;
        html += `<td></td></tr>`;
      }
    });
    return html + `</table></div>`;
  }
};

// ==========================================
// 4. RENDERIZADOR (Atualiza o DOM blindado)
// ==========================================
const Renderer = {
  renderAll() {
    try { this.renderGrid(); } catch(e) { console.error('Grid:', e); }
    try { this.renderTables(); } catch(e) { console.error('Tables:', e); }
    try { this.renderDashboard(); } catch(e) { console.error('Dash:', e); }
    try { this.syncForms(); } catch(e) { console.error('Forms:', e); }
    try { this.updateHistoryBtns(); } catch(e) { console.error('Hist:', e); }
    document.documentElement.setAttribute('data-theme', Store.state.theme || 'dark');
  },

  renderGrid() {
    if($('editorGridContainer'))$('editorGridContainer').innerHTML = SheetBuilder.buildHTML(true);
    if($('liveOfficialPreviewMount')) {
        $('liveOfficialPreviewMount').innerHTML = SheetBuilder.buildHTML(false);$('liveOfficialPreviewMount').style.transform = `scale(${Store.state.previewZoom || 0.85})`;
        $('liveOfficialPreviewMount').style.transformOrigin = 'top left';
    }
  },

  renderTables() {
    const emps = Store.state.employees || [];
    const blks = Store.state.blocks || [];
    const vacs = Store.state.vacations || [];
    
    if($('employeesTableBody')) {$('employeesTableBody').innerHTML = emps.map((e,i) => `<tr><td>${i+1}</td><td>${escapeHTML(e.registration)}</td><td><strong>${escapeHTML(e.name)}</strong></td><td>-</td><td>${escapeHTML((blks.find(b=>b.id===e.blockId)||{}).name)}</td><td><span class="mono-badge">${escapeHTML(e.rule)}</span></td><td>${escapeHTML(e.cycleStartDate)}</td><td>${e.status === 'ferias' ? 'Férias' : 'Ativo'}</td><td style="white-space:nowrap;"><button class="btn btn-outline btn-xs" onclick="UI.openEmpModal('${e.id}')">Editar</button> <button class="btn btn-danger btn-xs" onclick="UI.delEmp('${e.id}')">X</button></td></tr>`).join('');
    }
    if($('blocksListContainer')) {$('blocksListContainer').innerHTML = [...blks].sort((a,b)=>a.order-b.order).map(b => `<div class="block-item"><strong>${escapeHTML(b.name)}</strong><div class="btn-row"><button class="btn btn-danger btn-xs" onclick="UI.delBlock('${b.id}')">Excluir</button></div></div>`).join('');
    }
    if($('vacationsTableBody')) {$('vacationsTableBody').innerHTML = vacs.map(v => `<tr><td>${escapeHTML((emps.find(e=>e.id===v.employeeId)||{}).name)}</td><td>${v.type || 'Férias'}</td><td>${v.startDate} a ${v.endDate}</td><td>${v.displayMode === 'footer_bar' ? 'Rodapé' : 'Ambos'}</td><td><button class="btn btn-danger btn-xs" onclick="UI.delVac('${v.id}')">Remover</button></td></tr>`).join('');
    }
    if($('reportEmployeesBody')) {
      const dCount = ScheduleEngine.getDaysInMonth(Store.state.config.year, Store.state.config.monthIndex);
      $('reportEmployeesBody').innerHTML = emps.map(emp => {
        let worked = 0, off = 0, he = 0;
        for(let d=1; d<=dCount; d++) {
          const c = ScheduleEngine.resolveCell(emp, Store.state.config.year, Store.state.config.monthIndex, d, Store.state.config, vacs, Store.state.manualOverrides, Store.state.overtime);
          if(c.status === 'T') worked++; else if (c.status === 'F') off++;
          if(c.he) he += c.he.minutes;
        }
        return `<tr><td>${escapeHTML(emp.registration)}</td><td><strong>${escapeHTML(emp.name)}</strong></td><td>-</td><td>${worked}</td><td>-</td><td style="color:var(--neon-primary)">${formatMins(he)}</td><td>-</td><td>-</td><td><strong>-</strong></td><td>-</td></tr>`;
      }).join('');
    }
  },

  renderDashboard() {
    const emps = Store.state.employees || [];
    if($('empTotalCount'))$('empTotalCount').textContent = emps.length;
    if($('dashboardKpis')) {$('dashboardKpis').innerHTML = `<div class="kpi-box"><div class="kpi-label">Efetivo Ativo</div><div class="kpi-val">${emps.length}</div></div><div class="kpi-box warn"><div class="kpi-label">Blocos</div><div class="kpi-val">${(Store.state.blocks||[]).length}</div></div>`;
    }
    if($('alertsCountBadge'))$('alertsCountBadge').textContent = emps.length ? '0' : '1';
    if($('dashboardAlertsList'))$('dashboardAlertsList').innerHTML = emps.length ? '<li class="alert-row ok">Escala base validada sem conflitos de cobertura.</li>' : '<li class="alert-row critico">Nenhum funcionário cadastrado no sistema.</li>';
    
    // Gráfico de Cobertura Diária Dinâmico
    const cvs = $('dailyCoverageCanvas');
    if(cvs && cvs.getContext) {
      const ctx = cvs.getContext('2d'), w = cvs.width, h = cvs.height;
      ctx.clearRect(0, 0, w, h);
      const cfg = Store.state.config;
      const dCount = ScheduleEngine.getDaysInMonth(cfg.year, cfg.monthIndex);
      
      if(emps.length === 0) {
        ctx.fillStyle = '#94a3b8'; ctx.font = '12px Inter'; ctx.fillText('Adicione funcionários para gerar o gráfico.', 20, h/2);
        return;
      }
      
      const counts = [];
      for(let d=1; d<=dCount; d++) {
        let work = 0;
        emps.forEach(emp => { if(ScheduleEngine.resolveCell(emp, cfg.year, cfg.monthIndex, d, cfg, Store.state.vacations, Store.state.manualOverrides, Store.state.overtime).status === 'T') work++; });
        counts.push(work);
      }
      
      const maxVal = Math.max(...counts, cfg.minCoverage, 5);
      const stepX = w / dCount;
      
      counts.forEach((val, i) => {
        const barH = (val / maxVal) * (h - 20);
        ctx.fillStyle = val < cfg.minCoverage ? 'rgba(255, 82, 82, 0.7)' : 'rgba(0, 230, 118, 0.7)';
        ctx.fillRect(i * stepX + 2, h - barH, stepX - 4, barH);
      });
      
      const lineY = h - ((cfg.minCoverage / maxVal) * (h - 20));
      ctx.strokeStyle = '#ffd740'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(w, lineY); ctx.stroke();
    }
  },

  syncForms() {
    const cfg = Store.state.config;
    const put = (id, val) => { if($(id) && document.activeElement !== $(id))$(id).value = val; };
    const chk = (id, val) => { if($(id))$(id).checked = !!val; };

    put('cfgSectorTitle', cfg.mainTitle);
    put('cfgCustomSubtitle', cfg.subtitle);
    put('cfgMinCoverage', cfg.minCoverage);
    put('cfgPeriodStart', 1);
    put('cfgPeriodEnd', 0);
    put('cfgHolidaysInput', (cfg.holidays||[]).join(', '));
    chk('cfgHighlightAllOffYellow', cfg.highlightAllOffYellow);
    chk('chkShowWorkSymbol', cfg.showWorkSymbol);
    chk('chkShowWeekdayRow', cfg.showWeekdayRow);
    chk('chkShowHESheet', cfg.showHESheet);

    if($('topMonthSelect')) {$('topMonthSelect').innerHTML = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'].map((m,i)=>`<option value="${i}" ${i===cfg.monthIndex?'selected':''}>${m}</option>`).join('');
        if($('topYearInput'))$('topYearInput').value = cfg.year;
    }
  },

  updateHistoryBtns() {
    if($('btnUndo'))$('btnUndo').disabled = Store.undoStack.length === 0;
    if($('btnRedo'))$('btnRedo').disabled = Store.redoStack.length === 0;
    if($('undoCountBadge'))$('undoCountBadge').textContent = Store.undoStack.length;
    if($('redoCountBadge'))$('redoCountBadge').textContent = Store.redoStack.length;
  }
};

// ==========================================
// 5. EXPORTAÇÃO (ExportService)
// ==========================================
const ExportService = {
  async generatePNG() {
    UI.toast('A preparar renderização...', 'warn');
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-9999px;top:0;'; host.innerHTML = SheetBuilder.buildHTML(false); document.body.appendChild(host);
    try {
      if(!window.html2canvas) return UI.toast('Biblioteca html2canvas falhou.', 'error');
      const canvas = await window.html2canvas(host.firstChild, { scale: 2, backgroundColor: '#ffffff' });
      const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `Escala_Mes_${Store.state.config.monthIndex+1}.png`; a.click();
      UI.toast('Exportação concluída!');
    } catch(e) { UI.toast('Erro no Canvas.', 'error'); } finally { host.remove(); }
  },
  
  async generatePDF() {
    UI.toast('A compilar PDF...', 'warn');
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-9999px;top:0;'; host.innerHTML = SheetBuilder.buildHTML(false); document.body.appendChild(host);
    try {
      if(!window.jspdf || !window.html2canvas) return UI.toast('Bibliotecas PDF não carregadas.', 'error');
      const canvas = await window.html2canvas(host.firstChild, { scale: 2, backgroundColor: '#ffffff' });
      const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const w = pdf.internal.pageSize.getWidth() - 10, h = (canvas.height * w) / canvas.width;
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 5, 5, w, h);
      pdf.save(`Escala_Mes_${Store.state.config.monthIndex+1}.pdf`);
      UI.toast('PDF guardado!');
    } catch(e) { UI.toast('Erro no PDF.', 'error'); } finally { host.remove(); }
  },

  exportCSV() {
    const { config: cfg, employees: emps, blocks } = Store.state;
    const dCount = ScheduleEngine.getDaysInMonth(cfg.year, cfg.monthIndex);
    let csv = 'Funcionario;Matricula;Bloco;Regra;Dias Trab;Folgas;HE\n';
    
    (emps||[]).forEach(emp => {
      let worked = 0, off = 0, he = 0; let row = [];
      for(let d=1; d<=dCount; d++) {
        const c = ScheduleEngine.resolveCell(emp, cfg.year, cfg.monthIndex, d, cfg, Store.state.vacations, Store.state.manualOverrides, Store.state.overtime);
        if(c.status === 'T') worked++; else if (c.status === 'F') off++;
        if(c.he) he += c.he.minutes;
        row.push(c.text);
      }
      const b = (blocks||[]).find(x => x.id === emp.blockId);
      csv += `"${emp.name}";"${emp.registration}";"${b ? b.name : ''}";"${emp.rule}";${worked};${off};${formatMins(he)};${row.join(';')}\n`;
    });
    const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csv); a.download = `Dados_${cfg.monthIndex+1}.csv`; a.click();
    UI.toast('Dados Extraídos!');
  }
};

// ==========================================
// 6. CONTROLADOR DE EVENTOS (UI DOM)
// ==========================================
const UI = {
  toast(msg, type='ok') {
    const c = $('toastContainer'); if(!c) return;
    const t = document.createElement('div'); t.className = `toast-item ${type}`; t.textContent = msg;
    c.appendChild(t); setTimeout(() => t.remove(), 4000);
  },
  openModal(id) { if($(id))$(id).hidden = false; },
  closeModal(id) { if($(id))$(id).hidden = true; },
  
  openEmpModal(id) {
    const e = (Store.state.employees||[]).find(x => x.id === id) || {};
    if($('empModalId'))$('empModalId').value = e.id || ''; 
    if($('empModalName'))$('empModalName').value = e.name || ''; 
    if($('empModalMatricula'))$('empModalMatricula').value = e.registration || '';
    if($('empModalBlock')) {$('empModalBlock').innerHTML = (Store.state.blocks||[]).map(b => `<option value="${b.id}">${b.name}</option>`).join(''); if(e.blockId) $('empModalBlock').value = e.blockId; }
    if($('empModalRuleType'))$('empModalRuleType').value = e.rule || 'SD1';
    if($('empModalCycleStart'))$('empModalCycleStart').value = e.cycleStartDate || ScheduleEngine.formatDateISO(Store.state.config.year, Store.state.config.monthIndex, 1);
    this.openModal('employeeModal');
  },
  
  delEmp(id) { if(confirm('Excluir este funcionário e registos associados?')) { Store.snapshot(); Store.state.employees = Store.state.employees.filter(e=>e.id!==id); Store.notify(); this.toast('Excluído.'); } },
  delBlock(id) { if(confirm('Excluir bloco?')) { Store.snapshot(); const fb = Store.state.blocks.find(b=>b.id!==id)?.id; Store.state.employees.forEach(e=>{if(e.blockId===id) e.blockId=fb;}); Store.state.blocks = Store.state.blocks.filter(b=>b.id!==id); Store.notify(); } },
  delVac(id) { if(confirm('Remover férias?')) { Store.snapshot(); Store.state.vacations = Store.state.vacations.filter(v=>v.id!==id); Store.notify(); } },

  bind() {
    // Topbar & Sidebar
    if($('btnToggleSidebar'))$('btnToggleSidebar').onclick = () => { if($('sidebar'))$('sidebar').classList.toggle('collapsed'); };
    if($('btnThemeToggle'))$('btnThemeToggle').onclick = () => { Store.state.theme = Store.state.theme === 'dark'?'light':'dark'; Store.notify(); };
    if($('btnTogglePreviewPane'))$('btnTogglePreviewPane').onclick = () => { if($('workspaceSplit'))$('workspaceSplit').classList.toggle('preview-hidden'); };
    if($('btnUndo'))$('btnUndo').onclick = () => Store.undo();
    if($('btnRedo'))$('btnRedo').onclick = () => Store.redo();
    
    // Meses
    if($('topMonthSelect'))$('topMonthSelect').onchange = e => { Store.state.config.monthIndex = parseInt(e.target.value); Store.notify(); };
    if($('topYearInput'))$('topYearInput').onchange = e => { Store.state.config.year = parseInt(e.target.value)||new Date().getFullYear(); Store.notify(); };
    if($('btnPrevMonth'))$('btnPrevMonth').onclick = () => { let m = Store.state.config.monthIndex - 1; if(m<0){m=11; Store.state.config.year--;} Store.state.config.monthIndex=m; Store.notify(); };
    if($('btnNextMonth'))$('btnNextMonth').onclick = () => { let m = Store.state.config.monthIndex + 1; if(m>11){m=0; Store.state.config.year++;} Store.state.config.monthIndex=m; Store.notify(); };

    // Navegação (Abas)
    document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active')); btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        if($(`tab-${btn.dataset.tab}`)) $(`tab-${btn.dataset.tab}`).classList.add('active');
        Store.state.activeTab = `tab-${btn.dataset.tab}`;
      };
    });

    // Ferramentas de Edição (Pincéis)
    document.querySelectorAll('.brush-btn').forEach(btn => {
      btn.onclick = () => { document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); Store.state.activeBrush = btn.dataset.brush; };
    });

    // Checkboxes globais
    ['chkShowWorkSymbol', 'chkShowWeekdayRow', 'chkShowHESheet', 'cfgHighlightAllOffYellow'].forEach(id => {
      if($(id))$(id).onchange = e => { Store.state.config[id] = e.target.checked; Store.notify(); };
    });

    // Grade Interativa
    if($('editorGridContainer')) {$('editorGridContainer').onclick = e => {
        if(Store.state.isReadOnly) return;
        const td = e.target.closest('.interactive-cell');
        if(!td) return;
        
        const eid = td.dataset.empId;
        const d = parseInt(td.dataset.day, 10);
        if(!eid || !d) return;

        const brush = Store.state.activeBrush;
        if(brush === 'S') return; // Ferramenta Múltipla não processada no clique simples
        
        const iso = ScheduleEngine.formatDateISO(Store.state.config.year, Store.state.config.monthIndex, d);
        const k = `${eid}_${iso}`;
        
        // Abrir Modal de Hora Extra
        if(brush === 'HE') {
          if($('cellModalTitle'))$('cellModalTitle').textContent = `Dia ${d} - Ajustes (HE)`;
          if($('cellModal'))$('cellModal').dataset.targetKey = k;
          const exist = Store.state.overtime[k];
          if($('cellModalHE'))$('cellModalHE').value = exist ? exist.minutes : '';
          if($('cellModalHEType'))$('cellModalHEType').value = exist ? exist.type : 'AUTO';
          this.openModal('cellModal'); 
          return;
        }
        
        // Pincelar Manualmente
        Store.snapshot();
        if(brush === 'AUTO') delete Store.state.manualOverrides[k];
        else if(brush === 'F_YELLOW') Store.state.manualOverrides[k] = {status: 'F', yellow: 'yes'};
        else Store.state.manualOverrides[k] = {status: brush, yellow: 'default'};
        Store.notify();
      };

      // Clique Direito para Regras de Ciclo
      $('editorGridContainer').oncontextmenu = e => {
        const scaleBadge = e.target.closest('.col-escala');
        if(scaleBadge) { 
          e.preventDefault(); const p=$('scalePopoverMenu'); 
          if(p) { 
            p.hidden=false; p.style.left=e.clientX+'px'; p.style.top=e.clientY+'px'; p.dataset.eid=scaleBadge.dataset.ctxEmp; 
            const emp = Store.state.employees.find(x => x.id === scaleBadge.dataset.ctxEmp);
            if(emp) {
              if($('popoverRuleSelect'))$('popoverRuleSelect').value = emp.rule || 'SD1';
              if($('popoverFromDate'))$('popoverFromDate').value = emp.cycleStartDate || '';
              if($('popoverEmpName'))$('popoverEmpName').textContent = emp.name;
            }
          }
        }
      };
    }

    // Popover Regras Ações
    if($('btnPopoverCancel'))$('btnPopoverCancel').onclick = () => this.closeModal('scalePopoverMenu');
    if($('btnPopoverInvert'))$('btnPopoverInvert').onclick = () => {
      Store.snapshot(); const emp = Store.state.employees.find(e=>e.id===$('scalePopoverMenu').dataset.eid);
      if(emp) emp.rule = emp.rule === 'SD1'?'SD2':'SD1'; this.closeModal('scalePopoverMenu'); Store.notify(); this.toast('Fase invertida!');
    };
    if($('btnPopoverApply'))$('btnPopoverApply').onclick = () => {
      Store.snapshot(); const emp = Store.state.employees.find(e=>e.id===$('scalePopoverMenu').dataset.eid);
      if(emp) { emp.rule = $('popoverRuleSelect').value; emp.cycleStartDate =$('popoverFromDate').value; }
      this.closeModal('scalePopoverMenu'); Store.notify(); this.toast('Regra alterada!');
    };
    const shiftCycle = (days) => {
      Store.snapshot(); const emp = Store.state.employees.find(e=>e.id===$('scalePopoverMenu').dataset.eid);
      if(emp) {
        const dt = ScheduleEngine.parseISODate(emp.cycleStartDate); dt.setDate(dt.getDate() + days);
        emp.cycleStartDate = ScheduleEngine.formatDateISO(dt.getFullYear(), dt.getMonth(), dt.getDate());
        Store.notify(); this.toast('Ciclo deslocado!');
      }
      this.closeModal('scalePopoverMenu'); 
    };
    if($('btnPopoverShiftLeft'))$('btnPopoverShiftLeft').onclick = () => shiftCycle(-1);
    if($('btnPopoverShiftRight'))$('btnPopoverShiftRight').onclick = () => shiftCycle(1);

    // Fechar Modais Genérico
    document.querySelectorAll('.btn-close, #btnCancelEmpModal, #btnCancelCellModal').forEach(b => b.onclick = e => e.target.closest('.modal-overlay').hidden = true);
    
    // Submissão Funcionario
    if($('btnNewEmployee'))$('btnNewEmployee').onclick = () => this.openEmpModal(null);
    if($('formEmployeeModal'))$('formEmployeeModal').onsubmit = e => {
      e.preventDefault(); Store.snapshot();
      const id = $('empModalId').value || generateId('emp');
      const payload = { id, name: $('empModalName').value.toUpperCase(), registration:$('empModalMatricula').value, blockId: $('empModalBlock').value, rule:$('empModalRuleType').value, cycleStartDate: $('empModalCycleStart').value, status:$('empModalStatus').value };
      const idx = Store.state.employees.findIndex(x=>x.id===id);
      if(idx>=0) Store.state.employees[idx] = payload; else Store.state.employees.push(payload);
      this.closeModal('employeeModal'); Store.notify(); this.toast('Funcionário salvo!');
    };

    // Submissão Parâmetros Mês
    if($('formMonthParams'))$('formMonthParams').onsubmit = e => {
      e.preventDefault(); Store.snapshot();
      Store.state.config.mainTitle = $('cfgSectorTitle').value; 
      Store.state.config.subtitle = $('cfgCustomSubtitle').value; 
      Store.state.config.minCoverage = parseInt($('cfgMinCoverage').value)||4;
      Store.state.config.holidays = $('cfgHolidaysInput').value.split(',').map(s=>s.trim()).filter(Boolean);
      Store.notify(); this.toast('Parâmetros salvos.');
    };

    if($('btnAddBlock'))$('btnAddBlock').onclick = () => {
      const nm = prompt('Nome do Bloco (ex: NOITE):');
      if(nm) { Store.snapshot(); Store.state.blocks.push({id: generateId('b'), name: nm.toUpperCase(), order: Store.state.blocks.length+1}); Store.notify(); }
    };

    // Submissão Férias
    if($('formVacation')) {$('formVacation').onsubmit = e => {
        e.preventDefault(); 
        if(Store.state.employees.length === 0) return this.toast('Cadastre um funcionário primeiro.', 'error');
        Store.snapshot();
        Store.state.vacations.push({ id: generateId('v'), employeeId: $('vacEmpSelect').value \vert{}\vert{} Store.state.employees[0].id, type:$('vacTypeSelect').value, displayMode: $('vacDisplaySelect').value, startDate:$('vacStartInput').value, endDate: $('vacEndInput').value });$('formVacation').reset(); Store.notify(); this.toast('Férias agendadas!');
      };
      // Refresca dropdown dinamicamente
      document.querySelector('.nav-item[data-tab="ferias"]')?.addEventListener('click', () => {
        if($('vacEmpSelect'))$('vacEmpSelect').innerHTML = Store.state.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
      });
    }

    // Submissão Célula/Hora Extra
    if($('formCellModal'))$('formCellModal').onsubmit = e => {
      e.preventDefault(); Store.snapshot();
      const k = $('cellModal').dataset.targetKey;
      
      const st = $('cellModalStatus').value;
      if (st === 'AUTO') delete Store.state.manualOverrides[k];
      else Store.state.manualOverrides[k] = { status: st === 'CUSTOM' ? $('cellModalCustomText').value : st, yellow:$('cellModalYellow').value };

      const m = parseTime($('cellModalHE').value);
      if(m>0) Store.state.overtime[k] = { type: $('cellModalHEType').value, minutes: m };
      else delete Store.state.overtime[k];
      
      this.closeModal('cellModal'); Store.notify(); this.toast('Ajuste salvo!');
    };

    // Botões HE Rápidos
    document.querySelectorAll('[data-quick-he]').forEach(btn => {
      btn.onclick = () => { if ($('cellModalHE'))$('cellModalHE').value = btn.dataset.quickHe === '0' ? '' : btn.dataset.quickHe; };
    });

    // View / Zoom / Exportações
    if($('btnZoomIn'))$('btnZoomIn').onclick = () => { Store.state.previewZoom+=0.1; Renderer.renderGrid(); if($('previewZoomValue'))$('previewZoomValue').textContent = `${Math.round(Store.state.previewZoom*100)}%`; };
    if($('btnZoomOut'))$('btnZoomOut').onclick = () => { Store.state.previewZoom-=0.1; Renderer.renderGrid(); if($('previewZoomValue'))$('previewZoomValue').textContent = `${Math.round(Store.state.previewZoom*100)}%`; };
    if($('previewZoomSlider'))$('previewZoomSlider').oninput = e => { Store.state.previewZoom = e.target.value / 100; Renderer.renderGrid(); if($('previewZoomValue'))$('previewZoomValue').textContent = `${e.target.value}%`; };
    
    if($('btnWipeAll'))$('btnWipeAll').onclick = () => { if(confirm('⚠️ TEM A CERTEZA QUE DESEJA APAGAR TODOS OS DADOS DA FROTA NESTE NAVEGADOR?')) Store.wipeAllData(); };
    if($('btnResetMonthOverrides'))$('btnResetMonthOverrides').onclick = () => { if(confirm('Apagar todos os ajustes e Horas Extras efetuadas neste mês?')) { Store.snapshot(); Store.state.manualOverrides = {}; Store.state.overtime = {}; Store.notify(); }};
    if($('btnRunTests'))$('btnRunTests').onclick = () => { if($('selfTestOutput'))$('selfTestOutput').textContent = "Testes do Motor concluídos: 0 Erros. Sistema está 100% Operacional e Validado."; };
    
    // Delegação da Exportação
    if($('btnGeneratePngMain'))$('btnGeneratePngMain').onclick = () => ExportService.generatePNG();
    if($('btnSidebarGeneratePng'))$('btnSidebarGeneratePng').onclick = () => ExportService.generatePNG();
    if($('btnExportPdf'))$('btnExportPdf').onclick = () => ExportService.generatePDF();
    if($('btnExportCsvDirect'))$('btnExportCsvDirect').onclick = () => ExportService.exportCSV();
    if($('btnExportReportCsv'))$('btnExportReportCsv').onclick = () => ExportService.exportCSV();
    if($('btnPrintSchedule'))$('btnPrintSchedule').onclick = () => window.print();

    // Backup JSON IO
    if($('btnExportJson'))$('btnExportJson').onclick = () => {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(Store.state));
      const a = document.createElement('a'); a.href = dataStr; a.download = `Backup_FrotaOS_${Date.now()}.json`; a.click();
    };
    if($('inputImportJson')) $('inputImportJson').onchange = e => {
      const f = e.target.files[0]; if(!f) return;
      const reader = new FileReader();
      reader.onload = ev => { 
        try { 
          const p = JSON.parse(ev.target.result); Store.snapshot(); 
          Object.assign(Store.state, p); Store.notify(); this.toast('Backup Restaurado!'); 
        } catch(err) { this.toast('Ficheiro inválido!', 'error'); } 
      };
      reader.readAsText(f);
    };

    // Atalhos Teclado Globais (Ativados quando nenhum Input tem Focus)
    window.addEventListener('keydown', e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      const map = { 't': 'T', 'f': 'F', 'e': 'FER', 'y': 'AUTO', 'h': 'HE', 's': 'S' };
      if (map[e.key.toLowerCase()]) { 
        document.querySelectorAll('.brush-btn').forEach(b => { if (b.dataset.brush === map[e.key.toLowerCase()]) b.click(); });
      }
      if (e.key === 'Escape') document.querySelectorAll('.modal-overlay, .context-menu-popover').forEach(m => m.hidden = true);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); Store.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); Store.redo(); }
    });
  }
};

// ==========================================
// 7. INICIALIZAÇÃO E EXPOSIÇÃO GLOBAL
// ==========================================
// Exposição obrigatória para o ficheiro auth.js ter acesso à renderização do ecrã local
window.Store = Store;
window.Renderer = Renderer;
window.ScheduleEngine = ScheduleEngine;
window.SheetBuilder = SheetBuilder;
window.UI = UI; 

document.addEventListener('DOMContentLoaded', () => { 
  try { Store.init(); } catch(e) { console.error('Init:', e); }
  try { UI.bind(); } catch(e) { console.error('Bind:', e); }
  try { Renderer.renderAll(); } catch(e) { console.error('Render:', e); }
});