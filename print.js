/* ==========================================================================
   FROTA.OS v5.0 - app-wiring.js
   Liga tudo que existe no index.html mas não tinha ação no script.js:
   modal legado, cadastro de funcionários, férias, hora extra, blocos,
   parâmetros do mês, feriados, tema, sidebar, zoom da prévia, desfazer,
   exportação PNG/PDF/CSV/impressão, backup JSON, dashboard e ajuda.
   Carregar DEPOIS do script.js e ANTES do auth.js.
   ========================================================================== */
(function () {
  'use strict';

  const Store = window.Store;
  const Renderer = window.Renderer;
  const Engine = window.ScheduleEngine;
  const Sheet = window.SheetBuilder;
  if (!Store || !Renderer || !Engine || !Sheet) {
    console.error('[app-wiring] script.js não carregou. Confira a ordem dos <script>.');
    return;
  }

  /* ----------------------------- Utilitários ------------------------------ */
  const $ = (id) => document.getElementById(id);
  const MONTHS = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
  const RULES = ['SD1', 'SD2', '6x1', '5x2', '12x36'];
  const LAYOUT_IDS = ['classico', 'compacto', 'moderno', 'alto_contraste', 'semana'];
  const pad = (n) => String(n).padStart(2, '0');
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 80);
  const sid = (v, fallback) => (/^[A-Za-z0-9_-]{1,60}$/.test(String(v)) ? String(v) : fallback);
  const clamp = (v, min, max, fb) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb; };
  const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const iso = (y, mi, d) => Engine.formatDateISO(y, mi, d);

  function toast(msg, type) {
    const box = $('toastContainer');
    if (!box) return;
    box.style.zIndex = '10001';
    const el = document.createElement('div');
    el.className = 'toast-item ' + (type || 'ok');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  const openModal = (id) => { const m = $(id); if (m) m.hidden = false; };
  const closeModal = (id) => { const m = $(id); if (m) m.hidden = true; };

  function download(filename, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadDataUrl(filename, dataUrl) {
    const a = document.createElement('a');
    a.href = dataUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* Diálogos próprios (sem alert/confirm/prompt) */
  function dialog(opts) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-overlay';
      back.style.zIndex = '80';
      back.innerHTML =
        '<div class="modal-card modal-sm" role="dialog" aria-modal="true">' +
        '<div class="modal-head"><h3></h3></div>' +
        '<div class="modal-body"><p style="white-space:pre-line"></p>' +
        (opts.input ? '<div class="form-group" style="margin-top:.75rem"><input type="text" class="form-control" maxlength="60"></div>' : '') +
        '</div><div class="modal-foot">' +
        '<button type="button" class="btn btn-outline" data-c></button>' +
        '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-o></button>' +
        '</div></div>';
      back.querySelector('h3').textContent = opts.title || 'Confirmação';
      back.querySelector('p').textContent = opts.message || '';
      back.querySelector('[data-c]').textContent = opts.cancelText || 'Cancelar';
      back.querySelector('[data-o]').textContent = opts.okText || 'OK';
      const field = back.querySelector('input');
      if (field) field.value = opts.defaultValue || '';
      const done = (v) => { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(v); };
      const ok = () => done(opts.input ? (field.value.trim() || null) : true);
      const cancel = () => done(opts.input ? null : false);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        else if (e.key === 'Enter' && opts.input) { e.preventDefault(); ok(); }
      };
      back.querySelector('[data-o]').addEventListener('click', ok);
      back.querySelector('[data-c]').addEventListener('click', cancel);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      (field || back.querySelector('[data-o]')).focus();
    });
  }
  const confirmDialog = (message, okText, danger) => dialog({ message, okText: okText || 'Confirmar', danger: !!danger });
  const promptDialog = (title, message, defaultValue) => dialog({ title, message, input: true, defaultValue });

  /* ------------------------ Cálculos para o dashboard ---------------------- */
  function heMinutes(he) {
    if (!he) return 0;
    if (Number.isFinite(he.minutes)) return he.minutes;
    const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(he.hours || ''));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
  }

  function heKind(he, cell, d) {
    const t = String(he.type || 'AUTO');
    if (t === '50') return 'm50';
    if (t === '100') return 'm100';
    if (t === 'BANCO') return 'banco';
    const cfg = Store.state.config;
    return (Engine.isWeekend(cfg.year, cfg.monthIndex, d) || cell.isHoliday || cell.status === 'F') ? 'm100' : 'm50';
  }

  function fmtMin(m) {
    const h = Math.floor(m / 60), r = m % 60;
    return r ? h + 'h' + pad(r) : h + 'h';
  }

  function computeMonth() {
    const s = Store.state, cfg = s.config;
    const n = Engine.getDaysInMonth(cfg.year, cfg.monthIndex);
    const perDay = new Array(n).fill(0);
    const perBlock = {};
    s.blocks.forEach((b) => { perBlock[b.id] = new Array(n).fill(0); });
    const stats = {};
    const alerts = [];
    let heTotal = 0;

    s.employees.forEach((emp) => {
      const st = { worked: 0, off: 0, m50: 0, m100: 0, banco: 0, statuses: [] };
      let streak = 0, maxStreak = 0, firstDay = 0;
      for (let d = 1; d <= n; d++) {
        const c = Engine.resolveCell(emp, cfg.year, cfg.monthIndex, d, cfg, s.vacations, s.manualOverrides, s.overtime);
        st.statuses.push(c.status);
        if (c.status === 'T') {
          perDay[d - 1]++;
          if (perBlock[emp.blockId]) perBlock[emp.blockId][d - 1]++;
          st.worked++; streak++;
          if (streak > maxStreak) { maxStreak = streak; if (streak === 7) firstDay = d; }
        } else {
          streak = 0;
          if (c.status === 'F') st.off++;
        }
        if (c.he) {
          const m = heMinutes(c.he);
          st[heKind(c.he, c, d)] += m;
          if (c.he.type !== 'BANCO') heTotal += m;
        }
      }
      if (maxStreak > 6) alerts.push({ level: 'warn', text: emp.name + ': ' + maxStreak + ' dias seguidos de trabalho (a partir do dia ' + firstDay + ').' });
      stats[emp.id] = st;
    });

    const hasEmp = s.employees.length > 0;
    const low = [];
    if (hasEmp) perDay.forEach((v, i) => { if (v < cfg.minCoverage) low.push(i + 1); });
    if (low.length) {
      alerts.unshift({ level: 'critico', text: 'Cobertura abaixo de ' + cfg.minCoverage + ' em ' + low.length + ' dia(s): ' + low.slice(0, 10).join(', ') + (low.length > 10 ? '…' : '') + '.' });
    }
    return { n, perDay, perBlock, stats, alerts, heTotal, minWorking: hasEmp ? Math.min.apply(null, perDay) : 0, hasEmp };
  }

  function renderDashboardExtras() {
    const s = Store.state, cfg = s.config;
    const m = computeMonth();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };

    set('kpiMinCoverage', m.minWorking + ' / ' + cfg.minCoverage);
    const box = $('kpiCoverageBox');
    if (box) box.classList.toggle('danger', m.hasEmp && m.minWorking < cfg.minCoverage);

    const first = iso(cfg.year, cfg.monthIndex, 1), last = iso(cfg.year, cfg.monthIndex, m.n);
    set('kpiVacationsCount', String(new Set(s.vacations.filter((v) => v.startDate <= last && v.endDate >= first).map((v) => v.employeeId)).size));
    set('kpiOvertimeHours', fmtMin(m.heTotal));

    // Alertas
    const list = $('dashAlertsList');
    if (list) {
      let rows = m.alerts;
      if (!m.hasEmp) rows = [];
      else if (!rows.length) rows = [{ level: 'ok', text: 'Escala sem conflitos de cobertura ou jornada.' }];
      list.innerHTML = rows.length
        ? rows.map((a) => '<div class="alert-row ' + a.level + '">' + esc(a.text) + '</div>').join('')
        : '<div class="empty-state" style="padding:1rem;">Nenhum alerta detectado</div>';
      set('alertsCountBadge', String(m.alerts.length));
    }

    // Mapa de calor
    const head = $('heatmapHeaderRow'), body = $('heatmapBody');
    if (head && body) {
      let h = '<th>Turno</th>';
      for (let d = 1; d <= m.n; d++) h += '<th>' + d + '</th>';
      head.innerHTML = h;
      const blocks = s.blocks.slice().sort((a, b) => a.order - b.order);
      body.innerHTML = blocks.map((b) => {
        const has = s.employees.some((e) => e.blockId === b.id);
        let tds = '';
        for (let d = 0; d < m.n; d++) {
          if (!has) { tds += '<td>-</td>'; continue; }
          const v = m.perBlock[b.id][d];
          tds += '<td class="' + (v === 0 ? 'hm-low' : v === 1 ? 'hm-ok' : 'hm-high') + '">' + v + '</td>';
        }
        return '<tr><td style="text-align:left;white-space:nowrap;">' + esc(b.name) + '</td>' + tds + '</tr>';
      }).join('');
    }
    return m;
  }

  /* --------------------------- Relatórios (override) ----------------------- */
  Renderer.renderReportsTable = function () {
    const tbody = $('reportsTableBody');
    if (!tbody) return;
    const s = Store.state;
    const m = computeMonth();
    if (!s.employees.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted-sm" style="text-align:center;">Nenhum funcionário cadastrado.</td></tr>';
      return;
    }
    tbody.innerHTML = s.employees.map((emp) => {
      const st = m.stats[emp.id];
      return '<tr><td><strong>' + esc(emp.name) + '</strong></td><td class="cell-mat">' + esc(emp.registration) + '</td><td>' + st.worked +
        '</td><td>' + st.off + '</td><td>' + fmtMin(st.m50) + '</td><td>' + fmtMin(st.m100) + '</td><td>' + fmtMin(st.banco) + '</td></tr>';
    }).join('');
  };

  function csvCell(v) {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  }

  function exportCSV() {
    const s = Store.state, cfg = s.config;
    const m = computeMonth();
    const head = ['Funcionario', 'Matricula', 'Bloco', 'Regra', 'Dias Trabalhados', 'Folgas', 'HE 50% (h)', 'HE 100% (h)', 'Banco (h)'];
    for (let d = 1; d <= m.n; d++) head.push('Dia ' + d);
    const rows = [head.map(csvCell).join(';')];
    s.employees.forEach((emp) => {
      const st = m.stats[emp.id];
      const b = s.blocks.find((x) => x.id === emp.blockId);
      const dec = (x) => (x / 60).toFixed(2).replace('.', ',');
      rows.push([emp.name, emp.registration, b ? b.name : '', emp.rule, st.worked, st.off, dec(st.m50), dec(st.m100), dec(st.banco)].concat(st.statuses).map(csvCell).join(';'));
    });
    download('RELATORIO_' + MONTHS[cfg.monthIndex] + '_' + cfg.year + '.csv', '\uFEFF' + rows.join('\r\n'), 'text/csv;charset=utf-8;');
    toast('CSV exportado.');
  }

  /* ----------------------------- Ajuda com figuras ------------------------- */
  const HELP_STEPS = [
    { title: '1. Entrar no sistema', text: 'Entre com e-mail e senha (nuvem) ou toque em "Continuar Offline" para usar só neste navegador.', kind: 'login', hl: [225, 40, 175, 150] },
    { title: '2. Escolher o layout da escala', text: 'Em "Turnos & Mês", escolha um dos 5 modelos. A prévia à direita muda na hora.', kind: 'app', hl: [105, 40, 325, 60], nav: 4 },
    { title: '3. Título, mês e cobertura mínima', text: 'Ajuste o título, o mês, a cobertura mínima por dia e as linhas em branco de cada bloco.', kind: 'app', hl: [105, 105, 325, 55], nav: 4 },
    { title: '4. Blocos (turnos)', text: 'Crie, renomeie ou exclua blocos como Manhã, Dupla Pegada e Tarde.', kind: 'app', hl: [105, 165, 325, 60], nav: 4 },
    { title: '5. Cadastrar funcionários', text: 'Em "Funcionários", clique em "+ Novo Funcionário". Informe nome, matrícula, bloco, regra e a data inicial do ciclo.', kind: 'app', hl: [330, 14, 100, 22], nav: 2 },
    { title: '6. Ajustar a grade', text: 'Em "Montar Escala", escolha um pincel (T, F, E, Y) e clique nos dias. Ctrl+Z desfaz. Clique na coluna Escala para inverter a fase S/D.', kind: 'app', hl: [105, 40, 325, 24], nav: 1 },
    { title: '7. Lançar hora extra', text: 'Escolha o pincel "Lançar HE" (tecla H), clique no dia e informe HH:MM e o tipo (50%, 100% ou banco).', kind: 'app', hl: [330, 40, 100, 24], nav: 1 },
    { title: '8. Exportar', text: 'Use PNG, PDF ou Imprimir no topo. A exportação sempre leva a escala completa, sem filtro de busca.', kind: 'app', hl: [250, 8, 180, 28], nav: 0 }
  ];
  let helpStep = 0;

  function helpFigure(step, index) {
    const hl = step.hl;
    let body;
    if (step.kind === 'login') {
      body = '<rect x="10" y="10" width="200" height="200" rx="6" fill="#0f172a"/><circle cx="60" cy="60" r="16" fill="#10b981"/>' +
        '<rect x="30" y="100" width="130" height="8" rx="3" fill="#334155"/><rect x="30" y="120" width="100" height="8" rx="3" fill="#334155"/>' +
        '<rect x="220" y="10" width="210" height="200" rx="6" fill="#1e293b"/>' +
        '<rect x="235" y="50" width="180" height="22" rx="4" fill="#0f172a"/><rect x="235" y="82" width="180" height="22" rx="4" fill="#0f172a"/>' +
        '<rect x="235" y="118" width="180" height="24" rx="4" fill="#3b82f6"/><rect x="235" y="150" width="180" height="22" rx="4" fill="none" stroke="#475569"/>';
    } else {
      let nav = '';
      for (let i = 0; i < 6; i++) nav += '<rect x="16" y="' + (22 + i * 26) + '" width="72" height="16" rx="3" fill="' + (i === step.nav ? '#3b82f6' : '#334155') + '"/>';
      body = '<rect x="10" y="10" width="86" height="200" rx="4" fill="#1e293b"/>' + nav +
        '<rect x="100" y="10" width="330" height="26" rx="4" fill="#1e293b"/>' +
        '<rect x="105" y="40" width="325" height="170" rx="4" fill="#0f172a"/>' +
        '<g fill="#334155"><rect x="112" y="72" width="311" height="10"/><rect x="112" y="90" width="311" height="10"/><rect x="112" y="108" width="311" height="10"/><rect x="112" y="126" width="311" height="10"/><rect x="112" y="144" width="311" height="10"/></g>';
    }
    return '<svg viewBox="0 0 440 220" role="img" aria-label="' + esc(step.title) + '" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="440" height="220" rx="8" fill="#020617"/>' + body +
      '<rect x="' + hl[0] + '" y="' + hl[1] + '" width="' + hl[2] + '" height="' + hl[3] + '" rx="5" fill="rgba(239,68,68,.12)" stroke="#ef4444" stroke-width="2" stroke-dasharray="5 3"/>' +
      '<circle cx="' + hl[0] + '" cy="' + hl[1] + '" r="11" fill="#ef4444"/>' +
      '<text x="' + hl[0] + '" y="' + (hl[1] + 4) + '" text-anchor="middle" font-size="12" font-weight="bold" fill="#fff" font-family="sans-serif">' + (index + 1) + '</text></svg>';
  }

  function renderHelp() {
    const nav = $('helpStepperNav'), box = $('helpStepContent');
    if (!nav || !box) return;
    nav.innerHTML = HELP_STEPS.map((_, i) => '<div class="step-dot ' + (i === helpStep ? 'active' : '') + '" data-step="' + i + '" role="button" tabindex="0">' + (i + 1) + '</div>').join('');
    const st = HELP_STEPS[helpStep];
    box.innerHTML = '<div class="step-card"><h3>' + esc(st.title) + '</h3><p class="text-muted-sm" style="font-size:.9rem;">' + esc(st.text) + '</p>' +
      '<div class="step-figure" id="helpFigure" title="Clique para ampliar">' + helpFigure(st, helpStep) + '</div></div>';
    const prev = $('btnHelpPrev'), next = $('btnHelpNext');
    if (prev) prev.disabled = helpStep === 0;
    if (next) next.disabled = helpStep === HELP_STEPS.length - 1;
  }
  Renderer.renderHelpTab = renderHelp;

  /* ------------------------------- Render extra ---------------------------- */
  function syncConfigInputs() {
    const cfg = Store.state.config;
    const active = document.activeElement;
    const put = (id, v) => { const el = $(id); if (el && el !== active) el.value = v; };
    put('cfgMonthYear', cfg.year + '-' + pad(cfg.monthIndex + 1));
    put('cfgMinCoverage', cfg.minCoverage);
    const y = $('cfgYellowAllOff');
    if (y) y.checked = !!cfg.yellowAllOff;

    const box = $('cfgHolidaysList');
    if (box) {
      const prefix = cfg.year + '-' + pad(cfg.monthIndex + 1) + '-';
      const mine = (cfg.holidays || []).filter((h) => h.indexOf(prefix) === 0).sort();
      box.innerHTML = mine.length
        ? 'Feriados do mês: ' + mine.map((h) => '<span class="badge mono-badge" style="margin-right:4px;">' + esc(h.slice(8)) + ' <a href="#" data-rm-holiday="' + esc(h) + '" aria-label="Remover feriado" style="color:var(--danger);text-decoration:none;">×</a></span>').join('')
        : 'Nenhum feriado marcado neste mês.';
    }
  }

  function renderExtras() {
    syncConfigInputs();
    renderDashboardExtras();
    const has = Store.state.vacations.length > 0;
    const e = $('vacationsEmptyState'), w = $('vacationsTableWrapper');
    if (e) e.hidden = has;
    if (w) w.hidden = !has;
    const pz = $('btnZoomFit');
    if (pz) pz.textContent = Math.round(Store.state.previewZoom * 100) + '%';
  }

  const baseRenderAll = Renderer.renderAll;
  Renderer.renderAll = function () {
    baseRenderAll.apply(this, arguments);
    try { renderExtras(); } catch (err) { console.error('[app-wiring] renderExtras:', err); }
  };
  // Qualquer Store.notify() (inclusive desfazer/refazer por teclado) redesenha a tela.
  Store.subscribe(() => Renderer.renderAll());

  /* --------------------------- Funcionários -------------------------------- */
  function openEmpModal(id) {
    const s = Store.state;
    if (!s.blocks.length) { toast('Crie ao menos um bloco antes de cadastrar funcionários.', 'warn'); return; }
    const emp = id ? s.employees.find((e) => e.id === id) : null;
    const blocks = s.blocks.slice().sort((a, b) => a.order - b.order);
    $('empModalBlock').innerHTML = blocks.map((b) => '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>').join('');
    $('empModalTitle').textContent = emp ? 'Editar Funcionário' : 'Novo Funcionário';
    $('empModalId').value = emp ? emp.id : '';
    $('empModalName').value = emp ? emp.name : '';
    $('empModalMat').value = emp ? emp.registration : '';
    $('empModalBlock').value = emp ? emp.blockId : blocks[0].id;
    $('empModalRule').value = emp ? emp.rule : 'SD1';
    $('empModalStartDate').value = emp ? emp.cycleStartDate : s.config.year + '-' + pad(s.config.monthIndex + 1) + '-01';
    openModal('empModal');
    setTimeout(() => $('empModalName').focus(), 30);
  }

  async function removeEmployee(id) {
    const s = Store.state;
    const emp = s.employees.find((e) => e.id === id);
    if (!emp) return;
    if (!(await confirmDialog('Excluir "' + emp.name + '"? As férias e os ajustes dele também serão removidos.', 'Excluir', true))) return;
    Store.snapshot();
    s.employees = s.employees.filter((e) => e.id !== id);
    s.vacations = s.vacations.filter((v) => v.employeeId !== id);
    [s.manualOverrides, s.overtime].forEach((map) => Object.keys(map).forEach((k) => { if (k.indexOf(id + '_') === 0) delete map[k]; }));
    Store.notify();
    toast('Funcionário excluído.', 'warn');
  }

  /* -------------------------------- Feriados -------------------------------- */
  function easter(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    return { month: Math.floor((h + l - 7 * m + 114) / 31), day: ((h + l - 7 * m + 114) % 31) + 1 };
  }

  function nationalHolidays(year) {
    const list = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map((x) => year + '-' + x);
    const e = easter(year), base = Date.UTC(year, e.month - 1, e.day);
    [-47, -2, 60].forEach((off) => {
      const dt = new Date(base + off * 86400000);
      list.push(dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()));
    });
    return list;
  }

  /* ---------------------------- Exportação ---------------------------------- */
  function sheetHost() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;background:#fff;z-index:-1;';
    host.innerHTML = Sheet.buildHTML({ interactive: false, ignoreSearch: true });
    document.body.appendChild(host);
    return host;
  }

  async function renderCanvas(scale) {
    if (typeof window.html2canvas !== 'function') throw new Error('LIB');
    const host = sheetHost();
    try {
      return await window.html2canvas(host.firstElementChild, { scale: scale || 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    } finally { host.remove(); }
  }

  const fileBase = () => 'ESCALA_' + MONTHS[Store.state.config.monthIndex] + '_' + Store.state.config.year;

  async function exportPNG() {
    try {
      toast('Gerando PNG…', 'warn');
      const canvas = await renderCanvas(2);
      downloadDataUrl(fileBase() + '.png', canvas.toDataURL('image/png'));
      toast('PNG gerado.');
    } catch (err) { exportError(err); }
  }

  async function exportPDF() {
    try {
      if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('LIB');
      toast('Gerando PDF…', 'warn');
      const canvas = await renderCanvas(2);
      const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const margin = 6, maxW = pdf.internal.pageSize.getWidth() - margin * 2, maxH = pdf.internal.pageSize.getHeight() - margin * 2;
      const wScale = maxW / canvas.width, fit = Math.min(wScale, maxH / canvas.height);
      if (fit >= wScale * 0.6) {
        const w = canvas.width * fit, h = canvas.height * fit;
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin + (maxW - w) / 2, margin, w, h);
      } else {
        const slice = Math.floor(maxH / wScale);
        let first = true;
        for (let y = 0; y < canvas.height; y += slice) {
          const hPx = Math.min(slice, canvas.height - y);
          const part = document.createElement('canvas');
          part.width = canvas.width; part.height = hPx;
          part.getContext('2d').drawImage(canvas, 0, y, canvas.width, hPx, 0, 0, canvas.width, hPx);
          if (!first) pdf.addPage();
          first = false;
          pdf.addImage(part.toDataURL('image/png'), 'PNG', margin, margin, maxW, hPx * wScale);
        }
      }
      pdf.save(fileBase() + '.pdf');
      toast('PDF gerado.');
    } catch (err) { exportError(err); }
  }

  function exportError(err) {
    console.error('[export]', err);
    toast(err && err.message === 'LIB'
      ? 'Biblioteca de exportação não carregou (sem internet). Use Imprimir e "Salvar como PDF".'
      : 'Erro ao exportar. Veja o console.', 'error');
  }

  function printSheet() {
    const area = $('printArea');
    if (!area) return;
    area.innerHTML = Sheet.buildHTML({ interactive: false, ignoreSearch: true });
    window.print();
  }
  window.addEventListener('afterprint', () => { const a = $('printArea'); if (a) a.innerHTML = ''; });

  /* ------------------------------ Backup JSON ------------------------------- */
  function exportJson() {
    const s = Store.state;
    const payload = { schemaVersion: 5, exportedAt: new Date().toISOString(), config: s.config, blocks: s.blocks, employees: s.employees, vacations: s.vacations, manualOverrides: s.manualOverrides, overtime: s.overtime };
    download('FROTA_OS_BACKUP_' + Date.now() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('Backup baixado.');
  }

  function sanitizeImport(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cur = Store.state.config, c = raw.config && typeof raw.config === 'object' ? raw.config : {};
    const config = {
      mainTitle: str(c.mainTitle == null ? cur.mainTitle : c.mainTitle, 80),
      subtitle: str(c.subtitle, 80),
      year: clamp(c.year, 2020, 2060, cur.year),
      monthIndex: clamp(c.monthIndex, 0, 11, cur.monthIndex),
      minCoverage: clamp(c.minCoverage, 0, 500, 4),
      emptyRowsPerBlock: clamp(c.emptyRowsPerBlock, 0, 10, 3),
      yellowAllOff: !!c.yellowAllOff,
      sheetLayout: LAYOUT_IDS.indexOf(c.sheetLayout) >= 0 ? c.sheetLayout : 'classico',
      holidays: (Array.isArray(c.holidays) ? c.holidays : []).filter((h) => ISO_RE.test(String(h))).map(String)
    };
    let blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map((b, i) => ({ id: sid(b && b.id, 'b' + (i + 1)), name: str(b && b.name, 60) || 'Bloco ' + (i + 1), order: clamp(b && b.order, 1, 999, i + 1) }));
    if (!blocks.length) blocks = Store.state.blocks.length ? Store.state.blocks : [{ id: 'b1', name: 'Manhã', order: 1 }];
    const blockIds = blocks.map((b) => b.id);
    const rawEmps = Array.isArray(raw.employees) ? raw.employees : [];
    if (rawEmps.length && !rawEmps.some((e) => e && e.registration != null)) return 'LEGACY';
    const seen = {};
    const employees = [];
    rawEmps.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      let id = sid(e.id, 'emp_imp_' + i);
      if (seen[id]) id = id + '_' + i;
      seen[id] = true;
      employees.push({
        id, name: str(e.name, 80).toUpperCase() || 'SEM NOME', registration: str(e.registration, 20),
        blockId: blockIds.indexOf(e.blockId) >= 0 ? e.blockId : blockIds[0],
        rule: RULES.indexOf(e.rule) >= 0 ? e.rule : 'SD1',
        cycleStartDate: ISO_RE.test(String(e.cycleStartDate)) ? e.cycleStartDate : config.year + '-' + pad(config.monthIndex + 1) + '-01'
      });
    });
    const keyRe = /^([A-Za-z0-9_-]+)_(\d{4}-\d{2}-\d{2})$/;
    const manualOverrides = {};
    Object.keys(raw.manualOverrides || {}).forEach((k) => {
      const m = keyRe.exec(k), v = raw.manualOverrides[k];
      if (m && seen[m[1]] && v && ['T', 'F', 'FER', 'AF'].indexOf(v.status) >= 0) manualOverrides[k] = { status: v.status };
    });
    const overtime = {};
    Object.keys(raw.overtime || {}).forEach((k) => {
      const m = keyRe.exec(k), v = raw.overtime[k];
      if (!m || !seen[m[1]] || !v) return;
      const minutes = heMinutes(v);
      if (minutes > 0 && minutes <= 1440) overtime[k] = { minutes, hours: pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60), type: ['AUTO', '50', '100', 'BANCO'].indexOf(v.type) >= 0 ? v.type : 'AUTO', customTag: str(v.customTag, 4) };
    });
    const vacations = (Array.isArray(raw.vacations) ? raw.vacations : []).filter((v) => v && seen[v.employeeId] && ISO_RE.test(String(v.startDate)) && ISO_RE.test(String(v.endDate)) && v.endDate >= v.startDate)
      .map((v, i) => ({ id: sid(v.id, 'vac_imp_' + i), employeeId: v.employeeId, startDate: v.startDate, endDate: v.endDate }));
    return { config, blocks, employees, vacations, manualOverrides, overtime };
  }

  /* --------------------------------- Eventos -------------------------------- */
  function bind() {
    const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

    /* Modal da versão anterior */
    on('btnKeepLegacyData', 'click', () => closeModal('legacyDataModal'));
    on('btnWipeAndBackupLegacy', 'click', () => {
      const backup = {};
      ['FROTA_OS_SCHEDULE_STATE_V3', 'FROTA_OS_SCHEDULE_STATE_V4', 'MONITORAMENTO_FROTA_ESCALA_V1', 'MONITORAMENTO_FROTA_ESCALA_V2'].forEach((k) => {
        const v = localStorage.getItem(k);
        if (v) backup[k] = v;
      });
      download('FROTA_OS_BACKUP_VERSAO_ANTERIOR.json', JSON.stringify(backup, null, 2), 'application/json');
      Store.wipeLegacyData();
      closeModal('legacyDataModal');
      toast('Backup baixado e dados antigos removidos.');
    });

    /* Fechar modais */
    document.addEventListener('click', (e) => {
      const close = e.target.closest('.btn-modal-close');
      if (close) { const ov = close.closest('.modal-overlay'); if (ov) ov.hidden = true; }
      const ctx = $('escalaContextMenu');
      if (ctx && !ctx.hidden && !e.target.closest('#escalaContextMenu')) ctx.hidden = true;
    });

    /* Tema */
    const savedTheme = localStorage.getItem('FROTA_OS_THEME');
    if (savedTheme === 'light' || savedTheme === 'dark') Store.state.theme = savedTheme;
    document.documentElement.setAttribute('data-theme', Store.state.theme || 'dark');
    on('btnToggleTheme', 'click', () => {
      Store.state.theme = Store.state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', Store.state.theme);
      localStorage.setItem('FROTA_OS_THEME', Store.state.theme);
    });

    /* Sidebar */
    on('btnToggleSidebar', 'click', () => {
      const sb = $('appSidebar'); if (!sb) return;
      sb.classList.toggle('collapsed');
      const label = $('btnToggleSidebar').querySelector('span');
      if (label) label.textContent = sb.classList.contains('collapsed') ? '' : 'Recolher';
    });
    on('btnMobileSidebarToggle', 'click', () => { const sb = $('appSidebar'); if (sb) sb.classList.toggle('open'); });
    document.querySelectorAll('.nav-item[data-tab]').forEach((n) => n.addEventListener('click', () => { const sb = $('appSidebar'); if (sb) sb.classList.remove('open'); }));

    /* Atalhos "Ir" do checklist */
    document.querySelectorAll('[data-nav-tab]').forEach((b) => b.addEventListener('click', () => {
      const item = document.querySelector('.nav-item[data-tab="' + b.dataset.navTab + '"]');
      if (item) item.click();
    }));
    on('btnGoToExportStep', 'click', exportPNG);

    /* Prévia: zoom e ocultar */
    const setZoom = (z) => { Store.state.previewZoom = Math.max(0.3, Math.min(2, z)); Renderer.renderLivePreview(); const b = $('btnZoomFit'); if (b) b.textContent = Math.round(Store.state.previewZoom * 100) + '%'; };
    on('btnZoomIn', 'click', () => setZoom(Store.state.previewZoom + 0.1));
    on('btnZoomOut', 'click', () => setZoom(Store.state.previewZoom - 0.1));
    on('btnZoomFit', 'click', () => {
      const box = $('livePreviewContainer'), sheet = box && box.querySelector('.sheet-container');
      if (box && sheet) setZoom((box.clientWidth - 32) / sheet.offsetWidth);
    });
    const togglePreview = () => { const w = $('workspaceArea'); if (w) w.classList.toggle('preview-hidden'); };
    on('btnTogglePreviewHide', 'click', togglePreview);

    /* Desfazer / refazer */
    on('btnUndo', 'click', () => Store.undo());
    on('btnRedo', 'click', () => Store.redo());

    /* Navegação de mês */
    const shiftMonth = (delta) => {
      const cfg = Store.state.config;
      let m = cfg.monthIndex + delta, y = cfg.year;
      if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
      cfg.monthIndex = m; cfg.year = y;
      Store.notify();
    };
    on('btnPrevMonth', 'click', () => shiftMonth(-1));
    on('btnNextMonth', 'click', () => shiftMonth(1));
    on('cfgMonthYear', 'change', (e) => {
      const m = /^(\d{4})-(\d{2})$/.exec(e.target.value);
      if (!m) return;
      Store.state.config.year = clamp(m[1], 2020, 2060, Store.state.config.year);
      Store.state.config.monthIndex = clamp(parseInt(m[2], 10) - 1, 0, 11, Store.state.config.monthIndex);
      Store.notify();
    });
    on('cfgMinCoverage', 'input', (e) => { Store.state.config.minCoverage = clamp(e.target.value, 0, 500, 0); Store.notify(); });
    on('cfgYellowAllOff', 'change', (e) => { Store.state.config.yellowAllOff = e.target.checked; Store.notify(); });
    on('cfgEmptyRowsPerBlock', 'input', (e) => { Store.state.config.emptyRowsPerBlock = clamp(e.target.value, 0, 10, 3); Store.notify(); });

    /* Feriados */
    on('btnSuggestHolidays', 'click', () => {
      const cfg = Store.state.config;
      const set = new Set(cfg.holidays || []);
      nationalHolidays(cfg.year).forEach((h) => set.add(h));
      cfg.holidays = Array.from(set).sort();
      Store.notify();
      toast('Feriados nacionais de ' + cfg.year + ' adicionados.');
    });
    on('cfgHolidaysList', 'click', (e) => {
      const a = e.target.closest('[data-rm-holiday]');
      if (!a) return;
      e.preventDefault();
      Store.state.config.holidays = (Store.state.config.holidays || []).filter((h) => h !== a.dataset.rmHoliday);
      Store.notify();
    });

    /* Blocos */
    on('btnAddBlock', 'click', async () => {
      const name = await promptDialog('Novo bloco', 'Nome do bloco / turno:', '');
      if (!name) return;
      const s = Store.state;
      s.blocks.push({ id: uid('b'), name: str(name, 60), order: s.blocks.reduce((m, b) => Math.max(m, b.order), 0) + 1 });
      Store.notify();
    });
    on('blocksStack', 'click', async (e) => {
      const s = Store.state;
      const ren = e.target.closest('.btn-rename-block'), del = e.target.closest('.btn-del-block');
      if (ren) {
        const b = s.blocks.find((x) => x.id === ren.dataset.id);
        if (!b) return;
        const name = await promptDialog('Renomear bloco', 'Novo nome:', b.name);
        if (name) { b.name = str(name, 60); Store.notify(); }
      } else if (del) {
        if (s.blocks.length <= 1) { toast('Mantenha pelo menos um bloco.', 'warn'); return; }
        const b = s.blocks.find((x) => x.id === del.dataset.id);
        if (!b || !(await confirmDialog('Excluir o bloco "' + b.name + '"? Os funcionários dele vão para o primeiro bloco.', 'Excluir', true))) return;
        s.blocks = s.blocks.filter((x) => x.id !== b.id);
        const fallback = s.blocks.slice().sort((x, y) => x.order - y.order)[0].id;
        s.employees.forEach((emp) => { if (emp.blockId === b.id) emp.blockId = fallback; });
        Store.notify();
      }
    });

    /* Funcionários */
    ['btnQuickAddEmp', 'btnOpenAddEmpModal', 'btnEmptyAddEmp'].forEach((id) => on(id, 'click', () => openEmpModal(null)));
    on('employeesTableBody', 'click', (e) => {
      const ed = e.target.closest('.btn-edit-emp'), del = e.target.closest('.btn-del-emp');
      if (ed) openEmpModal(ed.dataset.id);
      else if (del) removeEmployee(del.dataset.id);
    });
    on('formEmpModal', 'submit', (e) => {
      e.preventDefault();
      const s = Store.state, id = $('empModalId').value;
      const name = str($('empModalName').value, 80).toUpperCase(), reg = str($('empModalMat').value, 20);
      if (!name || !reg) { toast('Informe nome e matrícula.', 'warn'); return; }
      if (s.employees.some((x) => x.id !== id && String(x.registration || '').trim().toLowerCase() === reg.toLowerCase())) {
        toast('A matrícula ' + reg + ' já está cadastrada.', 'error'); return;
      }
      const start = $('empModalStartDate').value;
      const data = {
        id: id || uid('emp'), name, registration: reg,
        blockId: $('empModalBlock').value,
        rule: RULES.indexOf($('empModalRule').value) >= 0 ? $('empModalRule').value : 'SD1',
        cycleStartDate: ISO_RE.test(start) ? start : s.config.year + '-' + pad(s.config.monthIndex + 1) + '-01'
      };
      Store.snapshot();
      const idx = s.employees.findIndex((x) => x.id === id);
      if (idx >= 0) s.employees[idx] = Object.assign({}, s.employees[idx], data); else s.employees.push(data);
      closeModal('empModal');
      Store.notify();
      toast('Funcionário salvo.');
    });

    /* Férias */
    on('btnOpenAddVacationModal', 'click', () => {
      const s = Store.state;
      if (!s.employees.length) { toast('Cadastre um funcionário antes de agendar férias.', 'warn'); return; }
      $('vacEmpSelect').innerHTML = s.employees.map((e) => '<option value="' + esc(e.id) + '">' + esc(e.name) + ' (' + esc(e.registration) + ')</option>').join('');
      $('vacStartDate').value = ''; $('vacEndDate').value = '';
      openModal('vacationModal');
    });
    on('formVacationModal', 'submit', (e) => {
      e.preventDefault();
      const s = Store.state, empId = $('vacEmpSelect').value, a = $('vacStartDate').value, b = $('vacEndDate').value;
      if (!ISO_RE.test(a) || !ISO_RE.test(b) || b < a) { toast('A data final deve ser igual ou posterior à inicial.', 'error'); return; }
      const clash = s.vacations.find((v) => v.employeeId === empId && v.startDate <= b && v.endDate >= a);
      if (clash) { toast('Período sobreposto a outro já cadastrado (' + clash.startDate + ' a ' + clash.endDate + ').', 'error'); return; }
      Store.snapshot();
      s.vacations.push({ id: uid('vac'), employeeId: empId, startDate: a, endDate: b });
      closeModal('vacationModal');
      Store.notify();
      toast('Férias agendadas.');
    });
    on('vacationsTableBody', 'click', async (e) => {
      const del = e.target.closest('.btn-del-vac');
      if (!del) return;
      if (!(await confirmDialog('Remover este período de férias?', 'Remover', true))) return;
      Store.snapshot();
      Store.state.vacations = Store.state.vacations.filter((v) => v.id !== del.dataset.id);
      Store.notify();
    });

    /* Hora extra */
    const heModal = $('heModal');
    if (heModal && window.MutationObserver) {
      new MutationObserver(() => {
        if (heModal.hidden) return;
        const key = $('heEmpId').value + '_' + iso(Store.state.config.year, Store.state.config.monthIndex, parseInt($('heDay').value, 10));
        const cur = Store.state.overtime[key];
        $('heHours').value = cur ? (cur.hours || fmtHHMM(heMinutes(cur))) : '01:00';
        $('heType').value = cur ? (cur.type || 'AUTO') : 'AUTO';
        $('heCustomTag').value = cur ? (cur.customTag || '') : '';
        setTimeout(() => $('heHours').focus(), 30);
      }).observe(heModal, { attributes: true, attributeFilter: ['hidden'] });
    }
    on('formHEModal', 'submit', (e) => {
      e.preventDefault();
      const s = Store.state, cfg = s.config;
      const empId = $('heEmpId').value, day = parseInt($('heDay').value, 10);
      const emp = s.employees.find((x) => x.id === empId);
      const m = /^(\d{1,2}):([0-5]\d)$/.exec($('heHours').value.trim());
      if (!emp || !m) { toast('Informe as horas no formato HH:MM (ex.: 02:00).', 'error'); return; }
      const minutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      const key = empId + '_' + iso(cfg.year, cfg.monthIndex, day);
      const cell = Engine.resolveCell(emp, cfg.year, cfg.monthIndex, day, cfg, s.vacations, s.manualOverrides, s.overtime);
      if (cell.status === 'FERIAS' || cell.status === 'FER' || cell.status === 'AF') { toast('Não é possível lançar hora extra em férias/afastamento.', 'error'); return; }
      if (minutes > 1440) { toast('Máximo de 24:00 por dia.', 'error'); return; }
      Store.snapshot();
      if (minutes === 0) delete s.overtime[key];
      else s.overtime[key] = { minutes, hours: pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60), type: $('heType').value, customTag: str($('heCustomTag').value, 4) };
      closeModal('heModal');
      Store.notify();
      toast(minutes === 0 ? 'Hora extra removida.' : 'Hora extra lançada.');
    });

    /* Menu da coluna Escala */
    const gridShell = $('interactiveGridShell');
    const ctx = $('escalaContextMenu');
    let ctxEmp = null;
    const openCtx = (e) => {
      const td = e.target.closest('td.col-escala[data-emp-id]');
      if (!td || !ctx || Store.state.isReadOnly) return false;
      e.preventDefault(); e.stopPropagation();
      ctxEmp = td.dataset.empId;
      ctx.hidden = false;
      ctx.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
      ctx.style.top = Math.min(e.clientY, window.innerHeight - 130) + 'px';
      return true;
    };
    if (gridShell) {
      gridShell.addEventListener('contextmenu', openCtx);
      gridShell.addEventListener('click', openCtx);
    }
    const shiftCycle = (days) => {
      const emp = Store.state.employees.find((x) => x.id === ctxEmp);
      if (!emp) return;
      if (emp.rule !== '6x1' && emp.rule !== '12x36') { toast('A regra ' + emp.rule + ' não depende da data inicial do ciclo.', 'warn'); ctx.hidden = true; return; }
      Store.snapshot();
      const d = Engine.parseISODate(emp.cycleStartDate);
      d.setDate(d.getDate() + days);
      emp.cycleStartDate = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      ctx.hidden = true;
      Store.notify();
    };
    on('ctxShiftPlus1', 'click', () => shiftCycle(1));
    on('ctxShiftMinus1', 'click', () => shiftCycle(-1));
    on('ctxInvertPhase', 'click', () => {
      const emp = Store.state.employees.find((x) => x.id === ctxEmp);
      if (!emp) return;
      if (emp.rule !== 'SD1' && emp.rule !== 'SD2') { toast('Inverter fase só vale para S/D-1 e S/D-2.', 'warn'); ctx.hidden = true; return; }
      Store.snapshot();
      emp.rule = emp.rule === 'SD1' ? 'SD2' : 'SD1';
      ctx.hidden = true;
      Store.notify();
    });

    /* Exportação */
    on('btnTopExportPNG', 'click', exportPNG);
    on('btnTopExportPDF', 'click', exportPDF);
    on('btnTopPrint', 'click', printSheet);
    on('btnExportCSV', 'click', exportCSV);

    /* Backup JSON */
    on('btnExportJson', 'click', exportJson);
    on('btnTriggerImportJson', 'click', () => { const f = $('inputImportJson'); if (f) f.click(); });
    on('inputImportJson', 'change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        let clean = null;
        try { clean = sanitizeImport(JSON.parse(reader.result)); } catch (err) { clean = null; }
        if (clean === 'LEGACY') { toast('Este backup é de uma versão anterior e não é compatível com a v5.', 'error'); return; }
        if (!clean) { toast('Arquivo JSON inválido.', 'error'); return; }
        if (!(await confirmDialog('Substituir os dados atuais pelos do backup (' + clean.employees.length + ' funcionários)?', 'Importar', true))) return;
        Store.snapshot();
        const s = Store.state;
        Object.assign(s.config, clean.config);
        s.blocks = clean.blocks; s.employees = clean.employees; s.vacations = clean.vacations;
        s.manualOverrides = clean.manualOverrides; s.overtime = clean.overtime;
        Store.notify();
        toast('Backup importado.');
      };
      reader.readAsText(file);
    });

    /* Ajuda */
    on('btnHelpPrev', 'click', () => { if (helpStep > 0) { helpStep--; renderHelp(); } });
    on('btnHelpNext', 'click', () => { if (helpStep < HELP_STEPS.length - 1) { helpStep++; renderHelp(); } });
    on('helpStepperNav', 'click', (e) => { const d = e.target.closest('[data-step]'); if (d) { helpStep = parseInt(d.dataset.step, 10) || 0; renderHelp(); } });
    on('helpStepContent', 'click', (e) => {
      const fig = e.target.closest('#helpFigure');
      if (!fig) return;
      $('lightboxContent').innerHTML = fig.innerHTML;
      $('lightboxOverlay').hidden = false;
    });
    on('btnCloseLightbox', 'click', () => { $('lightboxOverlay').hidden = true; });
    on('lightboxOverlay', 'click', (e) => { if (e.target === $('lightboxOverlay')) $('lightboxOverlay').hidden = true; });

    /* Teclado: V alterna prévia, Esc fecha o que estiver aberto */
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not([hidden])').forEach((m) => { if (m.id !== 'legacyDataModal') m.hidden = true; });
        const lb = $('lightboxOverlay'); if (lb) lb.hidden = true;
        if (ctx) ctx.hidden = true;
      } else if (!typing && !e.ctrlKey && !e.metaKey && (e.key === 'v' || e.key === 'V')) {
        togglePreview();
      }
    });
  }

  function fmtHHMM(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }

  function boot() {
    try { bind(); Renderer.renderAll(); }
    catch (err) { console.error('[app-wiring] erro ao ligar a interface:', err); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();