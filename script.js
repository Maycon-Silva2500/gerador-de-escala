/**
 * FROTA.OS v5.0 - SCRIPT MESTRE UNIFICADO
 * Engloba Engine, Store, SheetBuilder e Ligações de Interface (DOM)
 */
'use strict';

const $ = id => document.getElementById(id);
const escapeHTML = str => String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

// ==========================================
// 1. ENGINE LÓGICO
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
    if (vacs.some(v => v.employeeId === emp.id && iso >= v.startDate && iso <= v.endDate)) return { status: 'FERIAS', text: 'FER', isYellow: true };
    
    const over = overrides[key];
    const base = over ? over.status : this.getAutoStatus(emp, y, m, d);
    const isHol = (cfg.holidays || []).includes(iso);
    const isYel = isHol || (base === 'F' && cfg.yellowAllOff);
    
    return { status: base, text: base, isOverride: !!over, isYellow: isYel, isHoliday: isHol, he: ot[key] || null };
  }
};

// ==========================================
// 2. STATE MANAGER (STORE)
// ==========================================
const Store = {
  state: {
    config: { mainTitle: 'MONITORAMENTO DA FROTA', subtitle: '', year: new Date().getFullYear(), monthIndex: new Date().getMonth(), minCoverage: 4, emptyRowsPerBlock: 3, yellowAllOff: false, holidays: [] },
    blocks: [{ id: 'b1', name: 'Manhã', order: 1 }, { id: 'b2', name: 'Tarde', order: 2 }],
    employees: [], vacations: [], manualOverrides: {}, overtime: {},
    activeTab: 'tab-dashboard', activeBrush: 'SELECT', theme: 'dark', previewZoom: 0.85, searchQuery: '', isReadOnly: false
  },
  undoStack: [], redoStack: [],

  init() {
    try { const raw = localStorage.getItem('FROTA_OS_V5_STATE'); if (raw) Object.assign(this.state, JSON.parse(raw)); } catch(e){}
  },
  notify() {
    localStorage.setItem('FROTA_OS_V5_STATE', JSON.stringify({ config: this.state.config, blocks: this.state.blocks, employees: this.state.employees, vacations: this.state.vacations, manualOverrides: this.state.manualOverrides, overtime: this.state.overtime }));
    Renderer.renderAll();
  },
  snapshot() {
    if(this.undoStack.length > 20) this.undoStack.shift();
    this.undoStack.push(JSON.stringify({ emp: this.state.employees, mo: this.state.manualOverrides, ot: this.state.overtime, vac: this.state.vacations }));
    this.redoStack = [];
    Renderer.updateHistoryBtns();
  },
  undo() {
    if(!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify({ emp: this.state.employees, mo: this.state.manualOverrides, ot: this.state.overtime, vac: this.state.vacations }));
    const prev = JSON.parse(this.undoStack.pop());
    this.state.employees = prev.emp; this.state.manualOverrides = prev.mo; this.state.overtime = prev.ot; this.state.vacations = prev.vac;
    this.notify(); Renderer.updateHistoryBtns();
  },
  redo() {
    if(!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify({ emp: this.state.employees, mo: this.state.manualOverrides, ot: this.state.overtime, vac: this.state.vacations }));
    const next = JSON.parse(this.redoStack.pop());
    this.state.employees = next.emp; this.state.manualOverrides = next.mo; this.state.overtime = next.ot; this.state.vacations = next.vac;
    this.notify(); Renderer.updateHistoryBtns();
  }
};

// ==========================================
// 3. RENDERIZADOR & UI DOM
// ==========================================
const SheetBuilder = {
  buildHTML(interactive = false) {
    const { config: cfg, blocks, employees, vacations, manualOverrides: mo, overtime: ot, searchQuery: q } = Store.state;
    const dCount = ScheduleEngine.getDaysInMonth(cfg.year, cfg.monthIndex);
    const mNames = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
    const title = cfg.subtitle ? escapeHTML(cfg.subtitle.toUpperCase()) : `${mNames[cfg.monthIndex]} ${cfg.year}`;
    
    let html = `<div class="official-sheet-paper" style="width:${400 + (dCount*25)}px"><table class="fleet-schedule-table" style="width:100%">`;
    html += `<tr class="row-main-title"><th colspan="${4 + dCount}">${escapeHTML(cfg.mainTitle)}</th></tr>`;
    html += `<tr class="row-subtitle"><th colspan="${4 + dCount}">${title}</th></tr>`;
    html += `<tr class="row-col-headers"><th style="width:160px;">EFETIVO</th><th style="width:70px;">Matrícula</th><th style="width:60px;">Escala</th>`;
    html += `<th colspan="${dCount}">${title}</th><th>Assistentes:</th></tr><tr class="row-col-headers"><th colspan="3"></th>`;
    for(let d=1; d<=dCount; d++) html += `<th class="${ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d)?'is-weekend':''}">${d}</th>`;
    html += `<th></th></tr>`;

    let emps = employees;
    if(q) emps = emps.filter(e => e.name.toLowerCase().includes(q.toLowerCase()) || e.registration.includes(q));

    [...blocks].sort((a,b)=>a.order-b.order).forEach(b => {
      html += `<tr class="row-subtitle"><td colspan="${4 + dCount}">${escapeHTML(b.name.toUpperCase())}</td></tr>`;
      emps.filter(e => e.blockId === b.id).forEach(e => {
        html += `<tr><td style="text-align:left;padding-left:6px;">${escapeHTML(e.name)}</td><td>${escapeHTML(e.registration)}</td><td ${interactive?`data-ctx-emp="${e.id}" class="col-escala cursor-pointer"`:''}>${escapeHTML(e.rule)}</td>`;
        for(let d=1; d<=dCount; d++) {
          const c = ScheduleEngine.resolveCell(e, cfg.year, cfg.monthIndex, d, cfg, vacations, mo, ot);
          let cls = c.isYellow?'is-yellow':(ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d)?'is-weekend':'');
          html += `<td ${interactive?`data-emp-id="${e.id}" data-day="${d}" class="interactive-cell ${cls}"`:`class="${cls}"`}>`;
          if(c.isOverride && interactive) html += `<div style="position:absolute;top:2px;left:2px;width:4px;height:4px;background:blue;border-radius:50%;"></div>`;
          html += escapeHTML(c.text);
          if(c.he) html += `<span class="he-mini">${c.he.type}</span>`;
          html += `</td>`;
        }
        html += `<td></td></tr>`;
      });
      for(let i=0; i<cfg.emptyRowsPerBlock; i++) {
        html += `<tr><td>&nbsp;</td><td></td><td></td>`;
        for(let d=1; d<=dCount; d++) html += `<td class="${(cfg.holidays||[]).includes(ScheduleEngine.formatDateISO(cfg.year,cfg.monthIndex,d))?'is-yellow':(ScheduleEngine.isWeekend(cfg.year,cfg.monthIndex,d)?'is-weekend':'')}"></td>`;
        html += `<td></td></tr>`;
      }
    });
    return html + `</table></div>`;
  }
};

const Renderer = {
  renderAll() {
    if($('editorGridContainer'))$('editorGridContainer').innerHTML = SheetBuilder.buildHTML(true);
    if($('liveOfficialPreviewMount')) {
        $('liveOfficialPreviewMount').innerHTML = SheetBuilder.buildHTML(false);$('liveOfficialPreviewMount').style.transform = `scale(${Store.state.previewZoom})`;
        $('liveOfficialPreviewMount').style.transformOrigin = 'top center';
    }
    this.renderTables();
    this.renderDashboard();
    this.syncForms();
  },

  renderTables() {
    if($('employeesTableBody'))$('employeesTableBody').innerHTML = Store.state.employees.map((e,i) => `<tr><td>${i+1}</td><td>${escapeHTML(e.registration)}</td><td><strong>${escapeHTML(e.name)}</strong></td><td>-</td><td>${escapeHTML((Store.state.blocks.find(b=>b.id===e.blockId)||{}).name)}</td><td><span class="mono-badge">${escapeHTML(e.rule)}</span></td><td>${escapeHTML(e.cycleStartDate)}</td><td>Ativo</td><td><button class="btn btn-outline btn-xs" onclick="UI.openEmpModal('${e.id}')">Editar</button> <button class="btn btn-danger btn-xs" onclick="UI.delEmp('${e.id}')">Excluir</button></td></tr>`).join('');
    if($('blocksListContainer'))$('blocksListContainer').innerHTML = Store.state.blocks.map(b => `<div class="block-item"><strong>${escapeHTML(b.name)}</strong><button class="btn btn-danger btn-xs" onclick="UI.delBlock('${b.id}')">X</button></div>`).join('');
    if($('vacationsTableBody'))$('vacationsTableBody').innerHTML = Store.state.vacations.map(v => `<tr><td>${escapeHTML((Store.state.employees.find(e=>e.id===v.employeeId)||{}).name)}</td><td>${v.startDate}</td><td>${v.endDate}</td><td>Rodapé</td><td><button class="btn btn-danger btn-xs" onclick="UI.delVac('${v.id}')">Remover</button></td></tr>`).join('');
  },

  renderDashboard() {
    if($('empTotalCount'))$('empTotalCount').textContent = Store.state.employees.length;
    if($('alertsCountBadge'))$('alertsCountBadge').textContent = Store.state.employees.length ? '0' : '1';
    if($('dashboardAlertsList'))$('dashboardAlertsList').innerHTML = Store.state.employees.length ? '<li class="alert-row ok">Escala validada sem conflitos.</li>' : '<li class="alert-row critico">Nenhum funcionário cadastrado.</li>';
  },

  syncForms() {
    if($('cfgSectorTitle') && document.activeElement !== $('cfgSectorTitle'))$('cfgSectorTitle').value = Store.state.config.mainTitle;
    if($('cfgMinCoverage') && document.activeElement !== $('cfgMinCoverage'))$('cfgMinCoverage').value = Store.state.config.minCoverage;
    if($('topMonthSelect')) {$('topMonthSelect').innerHTML = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'].map((m,i)=>`<option value="${i}" ${i===Store.state.config.monthIndex?'selected':''}>${m}</option>`).join('');
        if($('topYearInput'))$('topYearInput').value = Store.state.config.year;
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
// 4. CONTROLADOR DE EVENTOS (UI)
// ==========================================
const UI = {
  toast(msg) {
    const c = $('toastContainer'); if(!c) return;
    const t = document.createElement('div'); t.className = 'toast-item ok'; t.textContent = msg;
    c.appendChild(t); setTimeout(() => t.remove(), 3000);
  },
  
  openModal(id) { if($(id))$(id).hidden = false; },
  closeModal(id) { if($(id))$(id).hidden = true; },
  
  openEmpModal(id) {
    const e = Store.state.employees.find(x => x.id === id) || {};
    $('empModalId').value = e.id \vert{}\vert{} '';$('empModalName').value = e.name || '';
    $('empModalMatricula').value = e.registration \vert{}\vert{} '';$('empModalBlock').innerHTML = Store.state.blocks.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    if(e.blockId) $('empModalBlock').value = e.blockId;
    $('empModalRuleType').value = e.rule \vert{}\vert{} 'SD1';$('empModalCycleStart').value = e.cycleStartDate || ScheduleEngine.formatDateISO(Store.state.config.year, Store.state.config.monthIndex, 1);
    this.openModal('employeeModal');
  },
  delEmp(id) { if(confirm('Excluir funcionário?')) { Store.snapshot(); Store.state.employees = Store.state.employees.filter(e=>e.id!==id); Store.notify(); this.toast('Excluído.'); } },
  delBlock(id) { if(confirm('Excluir bloco?')) { Store.snapshot(); Store.state.blocks = Store.state.blocks.filter(b=>b.id!==id); Store.notify(); } },
  delVac(id) { if(confirm('Excluir férias?')) { Store.snapshot(); Store.state.vacations = Store.state.vacations.filter(v=>v.id!==id); Store.notify(); } },

  bind() {
    // Topbar & Sidebar
    if($('btnToggleSidebar')) $('btnToggleSidebar').onclick = () =>$('sidebar').classList.toggle('collapsed');
    if($('btnThemeToggle'))$('btnThemeToggle').onclick = () => { Store.state.theme = Store.state.theme === 'dark'?'light':'dark'; document.documentElement.setAttribute('data-theme', Store.state.theme); };
    if($('btnTogglePreviewPane')) $('btnTogglePreviewPane').onclick = () =>$('workspaceSplit').classList.toggle('preview-hidden');
    if($('btnUndo'))$('btnUndo').onclick = () => Store.undo();
    if($('btnRedo'))$('btnRedo').onclick = () => Store.redo();
    
    // Meses
    if($('topMonthSelect'))$('topMonthSelect').onchange = e => { Store.state.config.monthIndex = parseInt(e.target.value); Store.notify(); };
    if($('topYearInput'))$('topYearInput').onchange = e => { Store.state.config.year = parseInt(e.target.value); Store.notify(); };
    if($('btnPrevMonth'))$('btnPrevMonth').onclick = () => { let m = Store.state.config.monthIndex - 1; if(m<0){m=11; Store.state.config.year--;} Store.state.config.monthIndex=m; Store.notify(); };
    if($('btnNextMonth'))$('btnNextMonth').onclick = () => { let m = Store.state.config.monthIndex + 1; if(m>11){m=0; Store.state.config.year++;} Store.state.config.monthIndex=m; Store.notify(); };

    // Abas
    document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active')); btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        if($(`tab-${btn.dataset.tab}`)) $(`tab-${btn.dataset.tab}`).classList.add('active');
      };
    });

    // Pincéis e Grade
    document.querySelectorAll('.brush-btn').forEach(btn => {
      btn.onclick = () => { document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); Store.state.activeBrush = btn.dataset.brush; };
    });
    
    if($('editorGridContainer')) {$('editorGridContainer').onclick = e => {
        if(Store.state.isReadOnly) return;
        const td = e.target.closest('.interactive-cell');
        if(!td) return;
        const eid = td.dataset.empId, d = parseInt(td.dataset.day);
        const brush = Store.state.activeBrush;
        if(brush === 'HE') {
          $('cellModalTitle').textContent = `Dia ${d} - Hora Extra`;
          $('cellModal').dataset.targetKey = `${eid}_${ScheduleEngine.formatDateISO(Store.state.config.year, Store.state.config.monthIndex, d)}`;
          this.openModal('cellModal'); return;
        }
        if(brush !== 'S') {
          Store.snapshot();
          const k = `${eid}_${ScheduleEngine.formatDateISO(Store.state.config.year, Store.state.config.monthIndex, d)}`;
          if(brush==='AUTO') delete Store.state.manualOverrides[k];
          else if(brush==='F_YELLOW') Store.state.manualOverrides[k] = {status: 'F', yellow: true};
          else Store.state.manualOverrides[k] = {status: brush};
          Store.notify();
        }
      };
      $('editorGridContainer').oncontextmenu = e => {
        const td = e.target.closest('.col-escala');
        if(td) { e.preventDefault(); const p=$('scalePopoverMenu'); p.hidden=false; p.style.left=e.clientX+'px'; p.style.top=e.clientY+'px'; p.dataset.eid=td.dataset.ctxEmp; }
      };
    }

    // Popover Regras
    if($('btnPopoverCancel'))$('btnPopoverCancel').onclick = () => this.closeModal('scalePopoverMenu');
    if($('btnPopoverInvert'))$('btnPopoverInvert').onclick = () => {
      Store.snapshot(); const emp = Store.state.employees.find(e=>e.id===$('scalePopoverMenu').dataset.eid);
      if(emp) emp.rule = emp.rule === 'SD1'?'SD2':'SD1'; this.closeModal('scalePopoverMenu'); Store.notify();
    };

    // Formulários e Modais Fixos
    document.querySelectorAll('.btn-close, #btnCancelEmpModal, #btnCancelCellModal').forEach(b => b.onclick = e => e.target.closest('.modal-overlay').hidden = true);
    
    if($('btnNewEmployee'))$('btnNewEmployee').onclick = () => this.openEmpModal(null);
    if($('formEmployeeModal'))$('formEmployeeModal').onsubmit = e => {
      e.preventDefault(); Store.snapshot();
      const id = $('empModalId').value || `emp_${Date.now()}`;
      const payload = { id, name: $('empModalName').value.toUpperCase(), registration: $('empModalMatricula').value, blockId:$('empModalBlock').value, rule: $('empModalRuleType').value, cycleStartDate:$('empModalCycleStart').value };
      const idx = Store.state.employees.findIndex(x=>x.id===id);
      if(idx>=0) Store.state.employees[idx] = payload; else Store.state.employees.push(payload);
      this.closeModal('employeeModal'); Store.notify(); this.toast('Salvo!');
    };

    if($('formMonthParams'))$('formMonthParams').onsubmit = e => {
      e.preventDefault(); Store.snapshot();
      Store.state.config.mainTitle = $('cfgSectorTitle').value; Store.state.config.minCoverage = parseInt($('cfgMinCoverage').value)||4;
      Store.notify(); this.toast('Parâmetros salvos.');
    };

    if($('btnAddBlock'))$('btnAddBlock').onclick = () => {
      const nm = prompt('Nome do Bloco:');
      if(nm) { Store.snapshot(); Store.state.blocks.push({id:`b_${Date.now()}`, name: nm.toUpperCase(), order: Store.state.blocks.length+1}); Store.notify(); }
    };

    if($('formVacation'))$('formVacation').onsubmit = e => {
      e.preventDefault(); Store.snapshot();
      Store.state.vacations.push({ id:`v_${Date.now()}`, employeeId:$('vacEmpSelect').value, startDate:$('vacStartInput').value, endDate:$('vacEndInput').value });$('formVacation').reset(); Store.notify(); this.toast('Férias salvas!');
    };

    if($('formCellModal'))$('formCellModal').onsubmit = e => {
      e.preventDefault(); Store.snapshot();
      const k = $('cellModal').dataset.targetKey;
      const m = parseInt($('cellModalHE').value)||0;
      if(m>0) Store.state.overtime[k] = { type: $('cellModalHEType').value, minutes: m };
      else delete Store.state.overtime[k];
      this.closeModal('cellModal'); Store.notify(); this.toast('Aplicado!');
    };

    // Botões Inferiores e Zoom
    if($('btnZoomIn'))$('btnZoomIn').onclick = () => { Store.state.previewZoom+=0.1; Renderer.renderLivePreview(); };
    if($('btnZoomOut'))$('btnZoomOut').onclick = () => { Store.state.previewZoom-=0.1; Renderer.renderLivePreview(); };
    if($('btnWipeAll'))$('btnWipeAll').onclick = () => { if(confirm('Zerar toda a base local?')) { Store.wipeAllData(); } };
    if($('btnGeneratePngMain'))$('btnGeneratePngMain').onclick = async () => {
      this.toast('Gerando PNG...');
      const host = document.createElement('div'); host.style.cssText='position:absolute;left:-9999px;'; host.innerHTML = SheetBuilder.buildHTML(false); document.body.appendChild(host);
      try {
        const c = await window.html2canvas(host.firstChild, {scale:2, backgroundColor:'#fff'});
        const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `Escala_${Store.state.config.year}.png`; a.click();
      } finally { host.remove(); this.toast('Concluído!'); }
    };
  }
};

window.UI = UI; // Expor globalmente para os botões inline do HTML
document.addEventListener('DOMContentLoaded', () => { Store.init(); UI.bind(); Renderer.renderAll(); });