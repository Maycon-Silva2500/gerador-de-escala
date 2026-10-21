/* ==========================================================================
   FROTA.OS v5.0 - script.js
   Engine do Sistema, Estado, Renderização e Componentes do App Shell
   ========================================================================== */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // 0. UTILITÁRIOS DE SEGURANÇA E FORMATAGEM
  // --------------------------------------------------------------------------
  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function validateColorHex(color) {
    return /^#[0-9a-f]{6}$/i.test(color) ? color : '#3b82f6';
  }

  function sanitizeId(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  // --------------------------------------------------------------------------
  // 1. Dicionário de LAYOUTS OFICIAIS (Fonte Única de Verdade)
  // --------------------------------------------------------------------------
  const LAYOUTS = {
    classico: {
      id: 'classico',
      name: 'Clássico',
      colNameW: 160,
      colMatW: 70,
      colEscalaW: 60,
      colDayW: 25,
      rowH: 25,
      fontSize: 11,
      bgHeader: '#757575',
      textHeader: '#ffffff',
      bgBlue: '#5b9bd5',
      bgYellow: '#ffff00',
      bgWeekend: '#d9d9d9'
    },
    compacto: {
      id: 'compacto',
      name: 'Compacto',
      colNameW: 130,
      colMatW: 55,
      colEscalaW: 50,
      colDayW: 20,
      rowH: 20,
      fontSize: 9,
      bgHeader: '#757575',
      textHeader: '#ffffff',
      bgBlue: '#5b9bd5',
      bgYellow: '#ffff00',
      bgWeekend: '#d9d9d9'
    },
    moderno: {
      id: 'moderno',
      name: 'Verde Moderno',
      colNameW: 160,
      colMatW: 70,
      colEscalaW: 60,
      colDayW: 25,
      rowH: 25,
      fontSize: 11,
      bgHeader: '#14532d',
      textHeader: '#ffffff',
      bgBlue: '#0ea5e9',
      bgYellow: '#fde047',
      bgWeekend: '#e2e8f0'
    },
    alto_contraste: {
      id: 'alto_contraste',
      name: 'Alto Contraste',
      colNameW: 160,
      colMatW: 70,
      colEscalaW: 60,
      colDayW: 25,
      rowH: 25,
      fontSize: 11,
      bgHeader: '#ffffff',
      textHeader: '#000000',
      bgBlue: '#ffffff',
      bgYellow: '#ffff00',
      bgWeekend: '#d9d9d9'
    },
    semana: {
      id: 'semana',
      name: 'Divisão Semanal',
      colNameW: 160,
      colMatW: 70,
      colEscalaW: 60,
      colDayW: 25,
      rowH: 25,
      fontSize: 11,
      bgHeader: '#1e3a8a',
      textHeader: '#ffffff',
      bgBlue: '#3b82f6',
      bgYellow: '#ffff00',
      bgWeekend: '#cbd5e1'
    }
  };

  // --------------------------------------------------------------------------
  // 2. ScheduleEngine (Lógica de Escalas)
  // --------------------------------------------------------------------------
  const ScheduleEngine = {
    formatDateISO(year, monthIndex, day) {
      const y = String(year).padStart(4, '0');
      const m = String(monthIndex + 1).padStart(2, '0');
      const d = String(day).padStart(2, '0');
      return `${y}-${m}-${d}`;
    },

    getDaysInMonth(year, monthIndex) {
      return new Date(year, monthIndex + 1, 0).getDate();
    },

    getDayOfWeek(year, monthIndex, day) {
      return new Date(year, monthIndex, day).getDay(); // 0 = Dom, 6 = Sáb
    },

    isWeekend(year, monthIndex, day) {
      const dw = this.getDayOfWeek(year, monthIndex, day);
      return dw === 0 || dw === 6;
    },

    parseISODate(isoStr) {
      if (!isoStr) return new Date();
      const parts = isoStr.split('-');
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    },

    daysBetween(dateA, dateB) {
      const utc1 = Date.UTC(dateA.getFullYear(), dateA.getMonth(), dateA.getDate());
      const utc2 = Date.UTC(dateB.getFullYear(), dateB.getMonth(), dateB.getDate());
      return Math.floor((utc2 - utc1) / (1000 * 60 * 60 * 24));
    },

    getAutoStatus(employee, year, monthIndex, day) {
      const targetDate = new Date(year, monthIndex, day);
      const startDate = this.parseISODate(employee.cycleStartDate || `${year}-01-01`);
      const diffDays = this.daysBetween(startDate, targetDate);
      const rule = employee.rule || 'SD1';
      const dayOfWeek = this.getDayOfWeek(year, monthIndex, day);

      if (rule === 'SD1') {
        if (dayOfWeek === 6) return 'F';
        return 'T';
      }
      if (rule === 'SD2') {
        if (dayOfWeek === 0) return 'F';
        return 'T';
      }
      if (rule === '5x2') {
        if (dayOfWeek === 0 || dayOfWeek === 6) return 'F';
        return 'T';
      }
      if (rule === '6x1') {
        const mod = ((diffDays % 7) + 7) % 7;
        return mod === 6 ? 'F' : 'T';
      }
      if (rule === '12x36') {
        const mod = ((diffDays % 2) + 2) % 2;
        return mod === 0 ? 'T' : 'F';
      }
      return 'T';
    },

    resolveCell(employee, year, monthIndex, day, config, vacations, manualOverrides, overtime) {
      const isoDate = this.formatDateISO(year, monthIndex, day);
      const empId = employee.id;

      // 1. Verficar Férias em registro oficial
      const hasVacation = vacations.some(v => v.employeeId === empId && isoDate >= v.startDate && isoDate <= v.endDate);
      if (hasVacation) {
        return { status: 'FERIAS', text: 'FÉR', isVacation: true, isOverride: false, isYellow: true };
      }

      // 2. Verificar Ajuste Manual
      const overrideKey = `${empId}_${isoDate}`;
      const overrideVal = manualOverrides[overrideKey];

      let baseStatus = overrideVal ? overrideVal.status : this.getAutoStatus(employee, year, monthIndex, day);
      const isOverride = !!overrideVal;

      // 3. Feriados e Amarelar
      const isHoliday = (config.holidays || []).includes(isoDate);
      let isYellow = isHoliday;

      if (baseStatus === 'F' && config.yellowAllOff) {
        isYellow = true;
      }

      // 4. Checar Horas Extras
      const heData = overtime[overrideKey];

      let text = baseStatus;
      if (baseStatus === 'FER') text = 'FER';

      return {
        status: baseStatus,
        text: text,
        isVacation: false,
        isOverride: isOverride,
        isYellow: isYellow,
        isHoliday: isHoliday,
        he: heData || null
      };
    }
  };

  // --------------------------------------------------------------------------
  // 3. GERENCIADOR DE ESTADO (STORE COM UNDO/REDO E PERSISTÊNCIA)
  // --------------------------------------------------------------------------
  const Store = {
    state: {
      config: {
        mainTitle: 'MONITORAMENTO DA FROTA',
        subtitle: '',
        year: new Date().getFullYear(),
        monthIndex: new Date().getMonth(),
        minCoverage: 4,
        emptyRowsPerBlock: 3,
        yellowAllOff: false,
        sheetLayout: 'classico',
        holidays: []
      },
      blocks: [
        { id: 'b1', name: 'Manhã', order: 1 },
        { id: 'b2', name: 'Dupla Pegada', order: 2 },
        { id: 'b3', name: 'Tarde', order: 3 }
      ],
      employees: [],
      vacations: [],
      manualOverrides: {},
      overtime: {},
      activeTab: 'tabDashboard',
      activeBrush: 'SELECT',
      theme: 'dark',
      previewHidden: false,
      previewZoom: 1.0,
      searchQuery: '',
      selectedCell: null,
      isReadOnly: false
    },

    undoStack: [],
    redoStack: [],
    listeners: [],

    init() {
      this.checkLegacyData();
      this.loadLocal();
      this.sanitizeState();
    },

    checkLegacyData() {
      const legacyV3 = localStorage.getItem('FROTA_OS_SCHEDULE_STATE_V3');
      const legacyV4 = localStorage.getItem('FROTA_OS_SCHEDULE_STATE_V4');
      if (legacyV3 || legacyV4) {
        const modal = document.getElementById('legacyDataModal');
        if (modal) modal.removeAttribute('hidden');
      }
    },

    wipeLegacyData() {
      localStorage.removeItem('FROTA_OS_SCHEDULE_STATE_V3');
      localStorage.removeItem('FROTA_OS_SCHEDULE_STATE_V4');
      localStorage.removeItem('MONITORAMENTO_FROTA_ESCALA_V1');
      localStorage.removeItem('MONITORAMENTO_FROTA_ESCALA_V2');
    },

    subscribe(fn) {
      this.listeners.push(fn);
    },

    notify() {
      this.saveLocal();
      this.listeners.forEach(fn => fn(this.state));
    },

    saveLocal() {
      try {
        const payload = {
          config: this.state.config,
          blocks: this.state.blocks,
          employees: this.state.employees,
          vacations: this.state.vacations,
          manualOverrides: this.state.manualOverrides,
          overtime: this.state.overtime
        };
        localStorage.setItem('FROTA_OS_V5_STATE', JSON.stringify(payload));
      } catch (e) {
        console.error('Erro ao salvar localmente', e);
      }
    },

    loadLocal() {
      try {
        const raw = localStorage.getItem('FROTA_OS_V5_STATE');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.config) Object.assign(this.state.config, parsed.config);
          if (Array.isArray(parsed.blocks)) this.state.blocks = parsed.blocks;
          if (Array.isArray(parsed.employees)) this.state.employees = parsed.employees;
          if (Array.isArray(parsed.vacations)) this.state.vacations = parsed.vacations;
          if (parsed.manualOverrides) this.state.manualOverrides = parsed.manualOverrides;
          if (parsed.overtime) this.state.overtime = parsed.overtime;
        }
      } catch (e) {
        console.error('Erro ao carregar do localStorage', e);
      }
    },

    sanitizeState() {
      if (!LAYOUTS[this.state.config.sheetLayout]) {
        this.state.config.sheetLayout = 'classico';
      }
      this.state.config.emptyRowsPerBlock = Math.max(0, Math.min(10, parseInt(this.state.config.emptyRowsPerBlock, 10) || 3));
    },

    snapshot() {
      if (this.undoStack.length > 30) this.undoStack.shift();
      this.undoStack.push(JSON.stringify({
        employees: this.state.employees,
        manualOverrides: this.state.manualOverrides,
        overtime: this.state.overtime,
        vacations: this.state.vacations
      }));
      this.redoStack = [];
    },

    undo() {
      if (this.undoStack.length === 0) return;
      const current = JSON.stringify({
        employees: this.state.employees,
        manualOverrides: this.state.manualOverrides,
        overtime: this.state.overtime,
        vacations: this.state.vacations
      });
      this.redoStack.push(current);
      const previous = JSON.parse(this.undoStack.pop());
      this.state.employees = previous.employees;
      this.state.manualOverrides = previous.manualOverrides;
      this.state.overtime = previous.overtime;
      this.state.vacations = previous.vacations;
      this.notify();
    },

    redo() {
      if (this.redoStack.length === 0) return;
      const current = JSON.stringify({
        employees: this.state.employees,
        manualOverrides: this.state.manualOverrides,
        overtime: this.state.overtime,
        vacations: this.state.vacations
      });
      this.undoStack.push(current);
      const next = JSON.parse(this.redoStack.pop());
      this.state.employees = next.employees;
      this.state.manualOverrides = next.manualOverrides;
      this.state.overtime = next.overtime;
      this.state.vacations = next.vacations;
      this.notify();
    },

    wipeAllData() {
      this.state.employees = [];
      this.state.vacations = [];
      this.state.manualOverrides = {};
      this.state.overtime = {};
      this.notify();
    }
  };

  // --------------------------------------------------------------------------
  // 4. BUILDER DE PLANILHA (HTML E IMPRESSÃO)
  // --------------------------------------------------------------------------
  const SheetBuilder = {
    buildHTML(options = {}) {
      const { interactive = false, ignoreSearch = false } = options;
      const cfg = Store.state.config;
      const layout = LAYOUTS[cfg.sheetLayout] || LAYOUTS.classico;
      const daysCount = ScheduleEngine.getDaysInMonth(cfg.year, cfg.monthIndex);

      const monthNames = [
        'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
        'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'
      ];

      const monthTitleStr = `${monthNames[cfg.monthIndex]} ${cfg.year}`;
      const subtitleStr = cfg.subtitle ? escapeHTML(cfg.subtitle.toUpperCase()) : monthTitleStr;

      let html = `<div class="sheet-container" data-sheet-layout="${escapeHTML(layout.id)}">`;
      html += `<table class="official-table">`;

      // Linha 1: Título Principal
      html += `<tr class="row-main-title"><th colspan="${4 + daysCount}">${escapeHTML(cfg.mainTitle)}</th></tr>`;

      // Linha 2: Subtítulo
      html += `<tr class="row-subtitle"><th colspan="${4 + daysCount}">${subtitleStr}</th></tr>`;

      // Linha 3: Cabeçalhos das Colunas
      html += `<tr class="row-col-headers">`;
      html += `<th class="th-efetivo" style="width:${layout.colNameW}px;">EFETIVO</th>`;
      html += `<th style="width:${layout.colMatW}px;">Matrícula</th>`;
      html += `<th style="width:${layout.colEscalaW}px;">Escala</th>`;
      html += `<th class="th-month-title" style="width:${layout.colDayW * daysCount}px;" colspan="${daysCount}">${monthTitleStr}</th>`;
      html += `<th>Assistentes:</th>`;
      html += `</tr>`;

      // Linha 4: Dias do Mês
      html += `<tr class="row-col-headers">`;
      html += `<th colspan="3"></th>`;
      for (let d = 1; d <= daysCount; d++) {
        const isWk = ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d);
        const cls = isWk ? 'cell-weekend' : '';
        html += `<th class="${cls}" style="width:${layout.colDayW}px;">${d}</th>`;
      }
      html += `<th></th>`;
      html += `</tr>`;

      // Processar Blocos e Funcionários
      const sortedBlocks = [...Store.state.blocks].sort((a, b) => a.order - b.order);

      let filteredEmployees = Store.state.employees;
      if (!ignoreSearch && Store.state.searchQuery) {
        const q = Store.state.searchQuery.toLowerCase();
        filteredEmployees = filteredEmployees.filter(e =>
          e.name.toLowerCase().includes(q) || e.registration.toLowerCase().includes(q)
        );
      }

      sortedBlocks.forEach(block => {
        // Cabeçalho do Bloco
        html += `<tr class="block-spacer"><td colspan="${4 + daysCount}">${escapeHTML(block.name.toUpperCase())}</td></tr>`;

        const blockEmps = filteredEmployees.filter(e => e.blockId === block.id);

        blockEmps.forEach(emp => {
          html += `<tr>`;
          html += `<td class="cell-name">${escapeHTML(emp.name)}</td>`;
          html += `<td class="cell-mat">${escapeHTML(emp.registration)}</td>`;
          
          const escalaAttr = interactive ? `data-emp-id="${escapeHTML(emp.id)}" class="col-escala cursor-pointer"` : `class="col-escala"`;
          html += `<td ${escalaAttr}>${escapeHTML(emp.rule)}</td>`;

          // Células de Dias
          for (let d = 1; d <= daysCount; d++) {
            const cellData = ScheduleEngine.resolveCell(
              emp, cfg.year, cfg.monthIndex, d,
              cfg, Store.state.vacations, Store.state.manualOverrides, Store.state.overtime
            );

            let classes = [];
            if (cellData.isYellow) classes.push('cell-feriado');
            else if (ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d)) classes.push('cell-weekend');

            const cellAttr = interactive ? `data-emp-id="${escapeHTML(emp.id)}" data-day="${d}" class="${classes.join(' ')} interactive-cell"` : `class="${classes.join(' ')}"`;

            html += `<td ${cellAttr}>`;
            if (cellData.isOverride) {
              html += `<div class="manual-override-marker"></div>`;
            }
            html += escapeHTML(cellData.text);
            if (cellData.he) {
              html += `<span class="he-indicator">${escapeHTML(cellData.he.customTag || 'HE')}</span>`;
            }
            html += `</td>`;
          }

          html += `<td></td>`; // Coluna Assistentes
          html += `</tr>`;
        });

        // Desenhar Esqueleto de Linhas em Branco (.row-empty)
        const emptyCount = cfg.emptyRowsPerBlock;
        for (let i = 0; i < emptyCount; i++) {
          html += `<tr class="row-empty">`;
          html += `<td class="cell-name">&nbsp;</td>`;
          html += `<td></td><td></td>`;
          for (let d = 1; d <= daysCount; d++) {
            const isWk = ScheduleEngine.isWeekend(cfg.year, cfg.monthIndex, d);
            const isoDate = ScheduleEngine.formatDateISO(cfg.year, cfg.monthIndex, d);
            const isHoliday = (cfg.holidays || []).includes(isoDate);

            let cls = '';
            if (isHoliday) cls = 'cell-feriado';
            else if (isWk) cls = 'cell-weekend';

            html += `<td class="${cls}"></td>`;
          }
          html += `<td></td>`;
          html += `</tr>`;
        }
      });

      html += `</table></div>`;
      return html;
    }
  };

  // --------------------------------------------------------------------------
  // 5. RENDERIZADORES DE INTERFACE E ABA
  // --------------------------------------------------------------------------
  const Renderer = {
    renderAll() {
      this.renderTopbar();
      this.renderDashboard();
      this.renderInteractiveGrid();
      this.renderLivePreview();
      this.renderEmployeesTable();
      this.renderVacationsTable();
      this.renderLayoutConfig();
      this.renderReportsTable();
      this.renderHelpTab();
      this.renderAccountTab();
    },

    renderTopbar() {
      const chip = document.getElementById('cloudStatusChip');
      const text = document.getElementById('cloudStatusText');
      if (chip && text) {
        if (Store.state.isReadOnly) {
          chip.setAttribute('data-status', 'offline');
          text.textContent = 'Somente Leitura';
        } else {
          chip.setAttribute('data-status', 'local');
          text.textContent = 'Modo Local';
        }
      }
    },

    renderDashboard() {
      const totalEmp = Store.state.employees.length;
      const kpiTotal = document.getElementById('kpiTotalEmp');
      if (kpiTotal) kpiTotal.textContent = totalEmp;

      const checklist = document.getElementById('initialChecklist');
      if (checklist) {
        checklist.hidden = totalEmp > 0;
      }

      const emptyEmployees = document.getElementById('employeesEmptyState');
      if (emptyEmployees) emptyEmployees.hidden = totalEmp > 0;

      const empTableWrap = document.getElementById('employeesTableWrapper');
      if (empTableWrap) empTableWrap.hidden = totalEmp === 0;

      // Render Canvas de Cobertura
      this.renderCoverageChart();
    },

    renderCoverageChart() {
      const canvas = document.getElementById('coverageChartCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const daysCount = ScheduleEngine.getDaysInMonth(Store.state.config.year, Store.state.config.monthIndex);

      canvas.width = canvas.parentElement.clientWidth || 400;
      canvas.height = 180;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const counts = [];
      for (let d = 1; d <= daysCount; d++) {
        let working = 0;
        Store.state.employees.forEach(emp => {
          const res = ScheduleEngine.resolveCell(
            emp, Store.state.config.year, Store.state.config.monthIndex, d,
            Store.state.config, Store.state.vacations, Store.state.manualOverrides, Store.state.overtime
          );
          if (res.status === 'T') working++;
        });
        counts.push(working);
      }

      // Desenhar Linhas de Histograma
      const stepX = canvas.width / daysCount;
      const maxVal = Math.max(...counts, Store.state.config.minCoverage, 5);

      ctx.fillStyle = 'rgba(59, 130, 246, 0.5)';
      counts.forEach((val, i) => {
        const h = (val / maxVal) * (canvas.height - 30);
        const x = i * stepX;
        const y = canvas.height - h - 20;

        if (val < Store.state.config.minCoverage) ctx.fillStyle = 'rgba(239, 68, 68, 0.7)';
        else ctx.fillStyle = 'rgba(16, 185, 129, 0.7)';

        ctx.fillRect(x + 2, y, stepX - 4, h);
      });

      // Linha de Cobertura Mínima
      const minY = canvas.height - ((Store.state.config.minCoverage / maxVal) * (canvas.height - 30)) - 20;
      ctx.strokeStyle = '#ef4444';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, minY);
      ctx.lineTo(canvas.width, minY);
      ctx.stroke();
      ctx.setLineDash([]);
    },

    renderInteractiveGrid() {
      const shell = document.getElementById('interactiveGridShell');
      if (!shell) return;
      shell.innerHTML = SheetBuilder.buildHTML({ interactive: true });

      // Atualizar legenda de mês no editor
      const lblMonth = document.getElementById('editorCurrentMonthLbl');
      if (lblMonth) {
        const monthNames = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
        lblMonth.textContent = `${monthNames[Store.state.config.monthIndex]} ${Store.state.config.year}`;
      }
    },

    renderLivePreview() {
      const previewBox = document.getElementById('livePreviewContainer');
      if (!previewBox) return;
      previewBox.innerHTML = SheetBuilder.buildHTML({ interactive: false });

      // Aplicar Zoom
      const container = previewBox.querySelector('.sheet-container');
      if (container) {
        container.style.transform = `scale(${Store.state.previewZoom})`;
        container.style.transformOrigin = 'top center';
      }
    },

    renderEmployeesTable() {
      const tbody = document.getElementById('employeesTableBody');
      if (!tbody) return;

      tbody.innerHTML = Store.state.employees.map((emp, index) => {
        const block = Store.state.blocks.find(b => b.id === emp.blockId);
        return `
          <tr>
            <td>${index + 1}</td>
            <td><strong>${escapeHTML(emp.name)}</strong></td>
            <td class="cell-mat">${escapeHTML(emp.registration)}</td>
            <td>${escapeHTML(block ? block.name : '-')}</td>
            <td>${escapeHTML(emp.shiftHours || '08:00 - 17:00')}</td>
            <td><span class="badge mono-badge">${escapeHTML(emp.rule)}</span></td>
            <td>${escapeHTML(emp.cycleStartDate || '-')}</td>
            <td style="text-align:right;">
              <button type="button" class="btn btn-ghost btn-xs btn-edit-emp" data-id="${escapeHTML(emp.id)}">Editar</button>
              <button type="button" class="btn btn-ghost btn-xs btn-del-emp" data-id="${escapeHTML(emp.id)}" style="color:var(--danger);">Excluir</button>
            </td>
          </tr>
        `;
      }).join('');
    },

    renderVacationsTable() {
      const tbody = document.getElementById('vacationsTableBody');
      if (!tbody) return;

      tbody.innerHTML = Store.state.vacations.map(vac => {
        const emp = Store.state.employees.find(e => e.id === vac.employeeId);
        const days = ScheduleEngine.daysBetween(ScheduleEngine.parseISODate(vac.startDate), ScheduleEngine.parseISODate(vac.endDate)) + 1;
        return `
          <tr>
            <td><strong>${escapeHTML(emp ? emp.name : 'Desconhecido')}</strong></td>
            <td>${escapeHTML(vac.startDate)}</td>
            <td>${escapeHTML(vac.endDate)}</td>
            <td>${days} dias</td>
            <td><span class="badge badge-status ok">Agendado</span></td>
            <td style="text-align:right;">
              <button type="button" class="btn btn-ghost btn-xs btn-del-vac" data-id="${escapeHTML(vac.id)}" style="color:var(--danger);">Remover</button>
            </td>
          </tr>
        `;
      }).join('');
    },

    renderLayoutConfig() {
      const inputTitle = document.getElementById('cfgMainTitle');
      if (inputTitle && document.activeElement !== inputTitle) inputTitle.value = Store.state.config.mainTitle;

      const inputSub = document.getElementById('cfgSubtitle');
      if (inputSub && document.activeElement !== inputSub) inputSub.value = Store.state.config.subtitle || '';

      const inputEmptyRows = document.getElementById('cfgEmptyRowsPerBlock');
      if (inputEmptyRows && document.activeElement !== inputEmptyRows) inputEmptyRows.value = Store.state.config.emptyRowsPerBlock;

      // Atualizar seleção na Galeria
      document.querySelectorAll('.layout-card').forEach(card => {
        if (card.dataset.layoutId === Store.state.config.sheetLayout) card.classList.add('selected');
        else card.classList.remove('selected');
      });

      // Renderizar Blocos
      const blocksStack = document.getElementById('blocksStack');
      if (blocksStack) {
        blocksStack.innerHTML = Store.state.blocks.map(b => `
          <div class="block-item" data-id="${escapeHTML(b.id)}">
            <span><strong>${escapeHTML(b.name)}</strong></span>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-xs btn-rename-block" data-id="${escapeHTML(b.id)}">Renomear</button>
              <button type="button" class="btn btn-ghost btn-xs btn-del-block" data-id="${escapeHTML(b.id)}" style="color:var(--danger);">Excluir</button>
            </div>
          </div>
        `).join('');
      }
    },

    renderReportsTable() {
      const tbody = document.getElementById('reportsTableBody');
      if (!tbody) return;

      const daysCount = ScheduleEngine.getDaysInMonth(Store.state.config.year, Store.state.config.monthIndex);

      tbody.innerHTML = Store.state.employees.map(emp => {
        let worked = 0;
        let off = 0;
        let he50 = 0;
        let he100 = 0;

        for (let d = 1; d <= daysCount; d++) {
          const cell = ScheduleEngine.resolveCell(
            emp, Store.state.config.year, Store.state.config.monthIndex, d,
            Store.state.config, Store.state.vacations, Store.state.manualOverrides, Store.state.overtime
          );

          if (cell.status === 'T') worked++;
          else if (cell.status === 'F') off++;

          if (cell.he) {
            if (cell.he.type === '50') he50 += 2;
            else if (cell.he.type === '100') he100 += 2;
          }
        }

        return `
          <tr>
            <td><strong>${escapeHTML(emp.name)}</strong></td>
            <td class="cell-mat">${escapeHTML(emp.registration)}</td>
            <td>${worked}</td>
            <td>${off}</td>
            <td>${he50}h</td>
            <td>${he100}h</td>
            <td>0h</td>
          </tr>
        `;
      }).join('');
    },

    renderHelpTab() {
      const helpSteps = [
        { title: '1. Login e Acesso', desc: 'Acesse via formulário seguro de e-mail/senha ou no Modo Local Offline.' },
        { title: '2. Galeria de Layouts', desc: 'Escolha o visual oficial da planilha (Clássico, Compacto, Moderno, Alto Contraste ou Semanal).' },
        { title: '3. Parâmetros e Titulação', desc: 'Configure o título, mês, número de linhas em branco e feriados nacionais.' },
        { title: '4. Cadastro de Funcionários', desc: 'Adicione os membros da equipe associando a regra de escala desejada (6x1, 5x2, 12x36).' },
        { title: '5. Pincéis e Edição Rápida', desc: 'Utilize os atalhos T, F, E e H para ajustar células interativamente na grade.' }
      ];

      const stepperNav = document.getElementById('helpStepperNav');
      if (stepperNav && stepperNav.children.length === 0) {
        stepperNav.innerHTML = helpSteps.map((s, i) => `
          <div class="step-dot ${i === 0 ? 'active' : ''}" data-step="${i}">${i + 1}</div>
        `).join('');
      }

      const cardContent = document.getElementById('helpStepContent');
      if (cardContent && !cardContent.innerHTML) {
        cardContent.innerHTML = `
          <h3>1. Login e Acesso no FROTA.OS</h3>
          <p style="margin-top:0.5rem;" class="text-muted-sm">Acesse o sistema garantindo sincronização e persistência dos dados da sua frota.</p>
          <div class="step-figure" style="margin-top:1rem;">
            <svg viewBox="0 0 400 150" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="400" height="150" rx="8" fill="#1e293b"/>
              <rect x="20" y="20" width="160" height="110" rx="4" fill="#0f172a"/>
              <circle cx="100" cy="50" r="15" fill="#10b981"/>
              <rect x="50" y="80" width="100" height="8" rx="2" fill="#334155"/>
              <rect x="200" y="20" width="180" height="110" rx="4" fill="#334155"/>
            </svg>
            <div class="callout-badge" style="top:30px; left:90px;">1</div>
          </div>
        `;
      }
    },

    renderAccountTab() {
      const emailLbl = document.getElementById('lblAccountEmail');
      if (emailLbl) {
        emailLbl.textContent = (window.AuthManager && window.AuthManager.currentUser)
          ? window.AuthManager.currentUser.email
          : 'Modo Local (Não Autenticado)';
      }
    }
  };

  // --------------------------------------------------------------------------
  // 6. ATRIBUIÇÃO DE EVENTOS E INTERAÇÃO DA GRADE
  // --------------------------------------------------------------------------
  function setupEventListeners() {
    // Alternar Abas da Sidebar
    document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const tabTarget = item.dataset.tab;
        Store.state.activeTab = tabTarget;

        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        document.querySelectorAll('.tab-content').forEach(tc => tc.hidden = true);
        const targetSection = document.getElementById(tabTarget);
        if (targetSection) targetSection.hidden = false;

        Renderer.renderAll();
      });
    });

    // Pincéis de Edição
    document.querySelectorAll('.brush-btn[data-brush]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Store.state.activeBrush = btn.dataset.brush;
      });
    });

    // Clique em Célula da Grade Interativa
    const gridShell = document.getElementById('interactiveGridShell');
    if (gridShell) {
      gridShell.addEventListener('click', (e) => {
        if (Store.state.isReadOnly) return;

        const td = e.target.closest('.interactive-cell');
        if (!td) return;

        const empId = td.dataset.empId;
        const day = parseInt(td.dataset.day, 10);
        if (!empId || !day) return;

        const isoDate = ScheduleEngine.formatDateISO(Store.state.config.year, Store.state.config.monthIndex, day);
        const brush = Store.state.activeBrush;
        const key = `${empId}_${isoDate}`;

        Store.snapshot();

        if (brush === 'T') Store.state.manualOverrides[key] = { status: 'T' };
        else if (brush === 'F') Store.state.manualOverrides[key] = { status: 'F' };
        else if (brush === 'FER') Store.state.manualOverrides[key] = { status: 'FER' };
        else if (brush === 'AF') Store.state.manualOverrides[key] = { status: 'AF' };
        else if (brush === 'AUTO') delete Store.state.manualOverrides[key];
        else if (brush === 'HE') {
          openHEModal(empId, day);
          return;
        }

        Store.notify();
        Renderer.renderInteractiveGrid();
        Renderer.renderLivePreview();
        Renderer.renderDashboard();
      });
    }

    // Atalhos de Teclado
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

      if (e.key === 't' || e.key === 'T') setBrush('T');
      if (e.key === 'f' || e.key === 'F') setBrush('F');
      if (e.key === 'e' || e.key === 'E') setBrush('FER');
      if (e.key === 'y' || e.key === 'Y') setBrush('AUTO');
      if (e.key === 'h' || e.key === 'H') setBrush('HE');

      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); Store.undo(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); Store.redo(); }
    });

    // Galeria de Layouts
    const gallery = document.getElementById('layoutGallery');
    if (gallery) {
      gallery.addEventListener('click', (e) => {
        const card = e.target.closest('.layout-card');
        if (!card) return;
        const layoutId = card.dataset.layoutId;
        if (LAYOUTS[layoutId]) {
          Store.state.config.sheetLayout = layoutId;
          Store.notify();
          Renderer.renderLayoutConfig();
          Renderer.renderInteractiveGrid();
          Renderer.renderLivePreview();
        }
      });
    }

    // Configuração de Parâmetros
    const inputTitle = document.getElementById('cfgMainTitle');
    if (inputTitle) {
      inputTitle.addEventListener('input', (e) => {
        Store.state.config.mainTitle = e.target.value;
        Store.saveLocal();
        Renderer.renderInteractiveGrid();
        Renderer.renderLivePreview();
      });
    }

    const inputSub = document.getElementById('cfgSubtitle');
    if (inputSub) {
      inputSub.addEventListener('input', (e) => {
        Store.state.config.subtitle = e.target.value;
        Store.saveLocal();
        Renderer.renderInteractiveGrid();
        Renderer.renderLivePreview();
      });
    }

    // Botão Limpar Tudo (com Modal de confirmação/backup)
    const btnWipe = document.getElementById('btnWipeAllData');
    if (btnWipe) {
      btnWipe.addEventListener('click', () => {
        if (confirm('Deseja limpar todos os funcionários, férias e ajustes? Os parâmetros de layout serão mantidos.')) {
          Store.wipeAllData();
          Renderer.renderAll();
        }
      });
    }
  }

  function setBrush(brushName) {
    Store.state.activeBrush = brushName;
    document.querySelectorAll('.brush-btn').forEach(b => {
      if (b.dataset.brush === brushName) b.classList.add('active');
      else b.classList.remove('active');
    });
  }

  function openHEModal(empId, day) {
    const modal = document.getElementById('heModal');
    if (!modal) return;
    document.getElementById('heEmpId').value = empId;
    document.getElementById('heDay').value = day;
    modal.removeAttribute('hidden');
  }

  // --------------------------------------------------------------------------
  // 7. INICIALIZAÇÃO
  // --------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    Store.init();
    setupEventListeners();
    Renderer.renderAll();
  });

  // Exportar Store globalmente para testes
  window.Store = Store;
  window.ScheduleEngine = ScheduleEngine;
  window.SheetBuilder = SheetBuilder;
  window.Renderer = Renderer;

})();