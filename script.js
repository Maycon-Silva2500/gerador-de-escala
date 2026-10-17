/**
 * ============================================================================
 * FROTA.OS // SISTEMA CRIADOR DE ESCALA DE TRABALHO (ES2022)
 * ============================================================================
 * Módulos:
 * 1. Security & Helpers (`escapeHTML`, sanitização e utilitários)
 * 2. CloudSyncAdapter (Adaptador documentado para Supabase / Google Sheets)
 * 3. ScheduleEngine (Motor de cálculo com suporte a 12x36, 24x48, 4x2, etc.)
 * 4. Store (Estado único reativo, Undo/Redo 50 passos e persistência local)
 * 5. Renderer (Renderização da Tabela, Prévia Ao Vivo e Gráficos)
 * 6. ExportService (PNG html2canvas + Fallback Nativo, PDF Paginado e CSV)
 * 7. UI (Controlador de interface, Modo Pincel, Modais e Drag-and-Drop)
 * 8. SelfTests (Suíte de testes automatizados para validar as regras do motor)
 * ============================================================================
 */

'use strict';

const STORAGE_KEY = 'FROTA_OS_SCHEDULE_STATE_V3';
const CURRENT_SCHEMA_VERSION = 3;

const MONTH_NAMES = [
  'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'
];

const WEEKDAY_LETTERS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

const FIXED_NATIONAL_HOLIDAYS = {
  1: [1],          // Confraternização Universal
  4: [21],         // Tiradentes
  5: [1],          // Dia do Trabalhador
  9: [7],          // Independência do Brasil
  10: [12],        // Nossa Sra. Aparecida
  11: [2, 15, 20], // Finados, Proclamação da República, Consciência Negra
  12: [25]         // Natal
};

/**
 * ============================================================================
 * 1. SEGURANÇA E UTILITÁRIOS
 * ============================================================================
 */
function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function debounce(fn, delayMs = 80) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * ============================================================================
 * 2. ADAPTADOR DE NUVEM
 * ============================================================================
 */
const CloudSyncAdapter = {
  enabled: false,
  endpointUrl: '',
  async pushState(_serializedState) {
    if (!this.enabled || !this.endpointUrl) return { synced: false, reason: 'offline_local_only' };
    return { synced: true };
  },
  async pullState() {
    if (!this.enabled || !this.endpointUrl) return null;
    return null;
  }
};

/**
 * ============================================================================
 * 3. MOTOR PURO DE CÁLCULO DE ESCALAS (ScheduleEngine)
 * ============================================================================
 */
const ScheduleEngine = {
  dateToEpochDays(dateStr) {
    const parts = String(dateStr || '2026-11-01').split('-').map(Number);
    const y = parts[0] || 2026;
    const m = (parts[1] || 1) - 1;
    const d = parts[2] || 1;
    return Math.floor(Date.UTC(y, m, d) / 86400000);
  },

  epochDaysToDateObj(epochDays) {
    const dt = new Date(epochDays * 86400000);
    const year = dt.getUTCFullYear();
    const month = dt.getUTCMonth() + 1;
    const day = dt.getUTCDate();
    const dayOfWeek = dt.getUTCDay();
    const dateISO = this.formatDateISO(year, month, day);
    return { year, month, day, dayOfWeek, dateISO };
  },

  formatDateISO(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  },

  getMonthKey(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
  },

  getDaysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  },

  getDayOfWeekUTC(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  },

  getEasterDate(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return { year, month, day, dateISO: this.formatDateISO(year, month, day) };
  },

  getMovableHolidaysForYear(year) {
    const easter = this.getEasterDate(year);
    const easterEpoch = this.dateToEpochDays(easter.dateISO);
    const offsets = [
      { offset: -48, name: 'Segunda de Carnaval' },
      { offset: -47, name: 'Terça de Carnaval' },
      { offset: -2, name: 'Sexta-feira Santa' },
      { offset: 0, name: 'Domingo de Páscoa' },
      { offset: 60, name: 'Corpus Christi' }
    ];
    return offsets.map(item => {
      const obj = this.epochDaysToDateObj(easterEpoch + item.offset);
      return { ...obj, name: item.name };
    });
  },

  getSuggestedHolidaysForMonth(year, month) {
    const fixed = FIXED_NATIONAL_HOLIDAYS[month] ? [...FIXED_NATIONAL_HOLIDAYS[month]] : [];
    const movable = this.getMovableHolidaysForYear(year)
      .filter(h => h.month === month)
      .map(h => h.day);
    return Array.from(new Set([...fixed, ...movable])).sort((a, b) => a - b);
  },

  getHolidaysForMonth(state, year, month) {
    const key = this.getMonthKey(year, month);
    const customList = state.config?.holidaysByMonth?.[key];
    if (Array.isArray(customList)) {
      return customList;
    }
    return this.getSuggestedHolidaysForMonth(year, month);
  },

  calculateWeekendAlternationStatus(ruleType, targetEpochDay, startEpochDay, dayOfWeek) {
    if (dayOfWeek >= 1 && dayOfWeek <= 5) return 'T';
    const targetIsoWeek = Math.floor((targetEpochDay + 3) / 7);
    const startIsoWeek = Math.floor((startEpochDay + 3) / 7);
    const weeksElapsed = targetIsoWeek - startIsoWeek;
    const isEvenPhase = ((weeksElapsed % 2) + 2) % 2 === 0;

    if (ruleType === 'SD1') {
      return isEvenPhase ? (dayOfWeek === 0 ? 'F' : 'T') : (dayOfWeek === 6 ? 'F' : 'T');
    }
    return isEvenPhase ? (dayOfWeek === 6 ? 'F' : 'T') : (dayOfWeek === 0 ? 'F' : 'T');
  },

  calculateRuleOnlyStatus(emp, year, month, day) {
    const dateISO = this.formatDateISO(year, month, day);
    const targetEpochDay = this.dateToEpochDays(dateISO);
    const startEpochDay = this.dateToEpochDays(emp.cycleStartDate || '2026-11-01');
    const diffDays = targetEpochDay - startEpochDay;
    const dayOfWeek = this.getDayOfWeekUTC(year, month, day);

    if (emp.ruleType === 'SD1' || emp.ruleType === 'SD2') {
      return this.calculateWeekendAlternationStatus(emp.ruleType, targetEpochDay, startEpochDay, dayOfWeek);
    }

    let workDays = 6;
    let offDays = 1;

    switch (emp.ruleType) {
      case '12x36': workDays = 1; offDays = 1; break; // Dia sim, dia não
      case '24x48': workDays = 1; offDays = 2; break; // 1 dia de trabalho, 2 de folga
      case '6x1':   workDays = 6; offDays = 1; break;
      case '5x2':   workDays = 5; offDays = 2; break;
      case '4x2':   workDays = 4; offDays = 2; break;
      case 'CUSTOM':
        workDays = Number(emp.workDays) || 6;
        offDays = Number(emp.offDays) || 1;
        break;
    }

    const cycleLen = Math.max(1, workDays + offDays);
    const pos = ((diffDays % cycleLen) + cycleLen) % cycleLen;
    return pos < workDays ? 'T' : 'F';
  },

  getVacationOnDate(state, empId, dateISO) {
    return (state.vacations || []).find(v =>
      v.employeeId === empId && dateISO >= v.startDate && dateISO <= v.endDate
    ) || null;
  },

  isEmployeeInFooterVacation(state, emp, year, month) {
    if (emp.status === 'ferias') return true;
    const totalDays = this.getDaysInMonth(year, month);
    const startISO = this.formatDateISO(year, month, 1);
    const endISO = this.formatDateISO(year, month, totalDays);

    return (state.vacations || []).some(v =>
      v.employeeId === emp.id &&
      v.type === 'FERIAS' &&
      (v.displayMode === 'footer_bar' || v.displayMode === 'both') &&
      v.startDate <= endISO &&
      v.endDate >= startISO
    );
  },

  resolveCell(state, emp, year, month, day) {
    const dateISO = this.formatDateISO(year, month, day);
    const monthKey = this.getMonthKey(year, month);
    const cellKey = `${emp.id}_${day}`;

    const ruleStatus = this.calculateRuleOnlyStatus(emp, year, month, day);

    let autoWithVacStatus = ruleStatus;
    if (emp.status === 'afastado') {
      autoWithVacStatus = 'AF';
    }
    const vac = this.getVacationOnDate(state, emp.id, dateISO);
    if (vac) {
      if (vac.type === 'FERIAS' && (vac.displayMode === 'inline_days' || vac.displayMode === 'both')) {
        autoWithVacStatus = 'FER';
      } else if (vac.type !== 'FERIAS') {
        autoWithVacStatus = 'AF';
      }
    }

    const manual = state.manualOverrides?.[monthKey]?.[cellKey] || null;
    const hasActiveOverride = Boolean(manual && manual.status && manual.status !== 'AUTO');
    const finalStatus = hasActiveOverride ? manual.status : autoWithVacStatus;
    const isManualDiff = hasActiveOverride && manual.status !== autoWithVacStatus;

    const dayOfWeek = this.getDayOfWeekUTC(year, month, day);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const holidays = this.getHolidaysForMonth(state, year, month);
    const isHolidayCol = holidays.includes(day);

    let isYellow = false;
    if (manual?.yellow === 'yes') {
      isYellow = true;
    } else if (manual?.yellow === 'no') {
      isYellow = false;
    } else {
      if (isHolidayCol) isYellow = true;
      if (state.config.highlightAllFolgasYellow && (finalStatus === 'F' || finalStatus === 'FE')) {
        isYellow = true;
      }
    }

    const sym = state.config.symbols;
    let displayText = '';
    if (finalStatus === 'T') {
      displayText = state.config.showWorkSymbol ? (sym.work || 'T') : '';
    } else if (finalStatus === 'F') {
      displayText = sym.off || 'F';
    } else if (finalStatus === 'FE') {
      displayText = sym.holiday || 'FE';
    } else if (finalStatus === 'FER') {
      displayText = sym.vacation || 'FER';
    } else if (finalStatus === 'AF') {
      displayText = sym.leave || 'AF';
    } else {
      displayText = finalStatus;
    }

    return {
      status: finalStatus,
      autoStatus: autoWithVacStatus,
      ruleStatus,
      isManual: hasActiveOverride,
      isManualDiff,
      isWeekend,
      isHolidayCol,
      isYellow,
      displayText,
      note: manual?.note || ''
    };
  },

  calculateDailyNetHours(emp) {
    const parseShiftMinutes = (entry, exit) => {
      if (!entry || !exit) return 0;
      const [h1, m1] = String(entry).split(':').map(Number);
      const [h2, m2] = String(exit).split(':').map(Number);
      if (Number.isNaN(h1) || Number.isNaN(h2)) return 0;
      const startMin = h1 * 60 + (m1 || 0);
      let endMin = h2 * 60 + (m2 || 0);
      if (endMin <= startMin) endMin += 24 * 60;
      return endMin - startMin;
    };

    let grossMinutes = parseShiftMinutes(emp.entryTime, emp.exitTime);
    if (emp.hasSecondShift && emp.entryTime2 && emp.exitTime2) {
      grossMinutes += parseShiftMinutes(emp.entryTime2, emp.exitTime2);
    }
    const breakMinutes = Math.max(0, Number(emp.breakMinutes) || 0);
    return Math.max(0, grossMinutes - breakMinutes) / 60;
  },

  getVisibleDays(state, year, month) {
    const maxDays = this.getDaysInMonth(year, month);
    const start = Math.max(1, Math.min(maxDays, Number(state.config.periodStartDay) || 1));
    const rawEnd = Number(state.config.periodEndDay) || 0;
    const end = rawEnd > 0 ? Math.max(start, Math.min(maxDays, rawEnd)) : maxDays;
    const list = [];
    for (let d = start; d <= end; d++) list.push(d);
    return list;
  },

  doPeriodsOverlap(startA, endA, startB, endB) {
    return startA <= endB && startB <= endA;
  },

  analyzeMonth(state, year, month) {
    const days = this.getVisibleDays(state, year, month);
    const employeeMetrics = {};
    const dailyTotals = {};
    const blockDailyWorking = {};
    const alerts = [];

    days.forEach(d => { dailyTotals[d] = { working: 0, off: 0, away: 0 }; });
    state.groups.forEach(g => {
      blockDailyWorking[g.id] = {};
      days.forEach(d => { blockDailyWorking[g.id][d] = 0; });
    });

    const matMap = new Map();
    state.employees.forEach(emp => {
      const m = (emp.matricula || '').trim();
      if (!m || !emp.name?.trim()) {
        alerts.push({ severity: 'critico', text: `Cadastro incompleto: "${emp.name || 'Sem Nome'}" sem matrícula ou nome.`, empId: emp.id });
      } else if (matMap.has(m)) {
        alerts.push({ severity: 'critico', text: `Matrícula duplicada (${m}): "${emp.name}" e "${matMap.get(m).name}".`, empId: emp.id });
      } else {
        matMap.set(m, emp);
      }
    });

    for (let i = 0; i < state.vacations.length; i++) {
      for (let j = i + 1; j < state.vacations.length; j++) {
        const v1 = state.vacations[i];
        const v2 = state.vacations[j];
        if (v1.employeeId === v2.employeeId && this.doPeriodsOverlap(v1.startDate, v1.endDate, v2.startDate, v2.endDate)) {
          const emp = state.employees.find(e => e.id === v1.employeeId);
          alerts.push({ severity: 'critico', text: `Sobreposição de férias para ${emp?.name || 'Funcionário'} (${v1.startDate} a ${v1.endDate}).`, empId: v1.employeeId });
        }
      }
    }

    let activeCount = 0;
    let footerVacationCount = 0;

    state.employees.forEach(emp => {
      const inFooterVac = this.isEmployeeInFooterVacation(state, emp, year, month);
      if (inFooterVac) footerVacationCount++;
      else if (emp.status === 'ativo') activeCount++;

      const dailyHours = this.calculateDailyNetHours(emp);
      let workDaysCount = 0, offDaysCount = 0, specialDaysCount = 0, manualAdjustments = 0;
      let consecutiveWork = 0, maxConsecutiveWork = 0, firstStreakExceedDay = null;
      let consecutiveSundaysWorked = 0, maxConsecutiveSundays = 0, exceedSundayDay = null;

      days.forEach(d => {
        if (inFooterVac) {
          specialDaysCount++;
          dailyTotals[d].away++;
          return;
        }

        const cell = this.resolveCell(state, emp, year, month, d);
        if (cell.isManualDiff) manualAdjustments++;

        const dow = this.getDayOfWeekUTC(year, month, d);

        if (cell.status === 'T') {
          workDaysCount++;
          dailyTotals[d].working++;
          if (blockDailyWorking[emp.groupId]) blockDailyWorking[emp.groupId][d]++;
          
          consecutiveWork++;
          if (consecutiveWork > maxConsecutiveWork) {
            maxConsecutiveWork = consecutiveWork;
            if (consecutiveWork === 7) firstStreakExceedDay = d;
          }
          if (dow === 0) {
            consecutiveSundaysWorked++;
            if (consecutiveSundaysWorked > maxConsecutiveSundays) {
              maxConsecutiveSundays = consecutiveSundaysWorked;
              if (consecutiveSundaysWorked >= 2) exceedSundayDay = d;
            }
          }
        } else if (cell.status === 'F') {
          offDaysCount++;
          dailyTotals[d].off++;
          consecutiveWork = 0;
          if (dow === 0) consecutiveSundaysWorked = 0;
        } else {
          specialDaysCount++;
          dailyTotals[d].away++;
          consecutiveWork = 0;
          if (dow === 0) consecutiveSundaysWorked = 0;
        }
      });

      if (!inFooterVac && maxConsecutiveWork > 6) {
        alerts.push({ severity: 'aviso', text: `${emp.name} (${emp.matricula}): ${maxConsecutiveWork} dias consecutivos de trabalho (a partir do dia ${firstStreakExceedDay}).`, empId: emp.id, day: firstStreakExceedDay });
      }

      if (!inFooterVac && maxConsecutiveSundays >= 2) {
        alerts.push({ severity: 'aviso', text: `${emp.name} (${emp.matricula}): ${maxConsecutiveSundays} domingos consecutivos trabalhados (dia ${exceedSundayDay}).`, empId: emp.id, day: exceedSundayDay });
      }

      employeeMetrics[emp.id] = {
        emp, inFooterVac, dailyHours, workDaysCount, offDaysCount, specialDaysCount,
        manualAdjustments, totalHours: workDaysCount * dailyHours
      };
    });

    const minCovGlobal = Number(state.config.minCoverage) || 0;
    let daysMeetingCoverage = 0;
    const lowGlobalDays = [];

    days.forEach(d => {
      if (dailyTotals[d].working >= minCovGlobal) daysMeetingCoverage++;
      else lowGlobalDays.push(d);
    });

    if (lowGlobalDays.length > 0) {
      alerts.push({ severity: 'critico', text: `Cobertura total abaixo do mínimo (${minCovGlobal}) em ${lowGlobalDays.length} dia(s).`, day: lowGlobalDays[0] });
    }

    const blockMetrics = state.groups.map(grp => {
      const activeInBlock = state.employees.filter(e => e.groupId === grp.id && !this.isEmployeeInFooterVacation(state, e, year, month));
      const minBlock = Number(grp.minCoverage) ?? 1;
      const dailyCounts = days.map(d => blockDailyWorking[grp.id]?.[d] || 0);
      const minObserved = dailyCounts.length > 0 ? Math.min(...dailyCounts) : 0;
      const avgWorking = dailyCounts.length > 0 ? dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length : 0;
      const totalBlockHours = activeInBlock.reduce((sum, e) => sum + (employeeMetrics[e.id]?.totalHours || 0), 0);

      const firstLowDay = days.find(d => (blockDailyWorking[grp.id]?.[d] || 0) < minBlock);
      if (firstLowDay !== undefined && activeInBlock.length > 0) {
        alerts.push({ severity: 'aviso', text: `Turno "${grp.name}": cobertura abaixo de ${minBlock} no dia ${firstLowDay} (${blockDailyWorking[grp.id][firstLowDay]} trabalhando).`, day: firstLowDay });
      }

      return { group: grp, activeCount: activeInBlock.length, minRequired: minBlock, avgWorking, minObserved, totalBlockHours, dailyMap: blockDailyWorking[grp.id] || {} };
    });

    if (alerts.length === 0) alerts.push({ severity: 'ok', text: 'Escala validada: 100% dos critérios de cobertura e limites atendidos.' });

    const coveragePercent = days.length > 0 ? Math.round((daysMeetingCoverage / days.length) * 100) : 100;

    return { days, totalEmployees: state.employees.length, activeCount, footerVacationCount, coveragePercent, employeeMetrics, dailyTotals, blockMetrics, alerts };
  }
};

/**
 * ============================================================================
 * 4. GERENCIADOR DE ESTADO E PERSISTÊNCIA (Store)
 * ============================================================================
 */
function createReferenceModelState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    theme: 'dark',
    selectedMonth: 11,
    selectedYear: 2026,
    sortOrder: 'custom',
    config: {
      sectorTitle: 'MONITORAMENTO DA FROTA',
      leftBadge: 'EFETIVO',
      customSubtitle: '',
      minCoverage: 4,
      periodStartDay: 1,
      periodEndDay: 0,
      showWorkSymbol: false,
      showWeekdayRow: false,
      highlightAllFolgasYellow: false,
      repeatHeaderPerBlock: true,
      symbols: { work: 'T', off: 'F', holiday: 'FE', vacation: 'FER', leave: 'AF' },
      colors: { headerBg: '#757575', yellowHighlight: '#ffff00', weekendBg: '#d9d9d9', scaleBadge: '#5b9bd5' },
      holidaysByMonth: { '2026-11': [2, 20] }
    },
    groups: [
      { id: 'grp_manha', name: 'Manhã', order: 1, minCoverage: 2, repeatHeader: false, spacerBefore: false },
      { id: 'grp_dupla', name: 'Dupla Pegada', order: 2, minCoverage: 1, repeatHeader: false, spacerBefore: true },
      { id: 'grp_tarde', name: 'Tarde', order: 3, minCoverage: 2, repeatHeader: true, spacerBefore: true }
    ],
    employees: [
      { id: 'emp_rodney', name: 'RODNEY GUSTAVO', matricula: '33854', entryTime: '05:00', exitTime: '14:00', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_manha', scaleLabel: 'S/D-2', scaleColor: '#5b9bd5', ruleType: 'SD2', cycleStartDate: '2026-11-01', workDays: 6, offDays: 1, status: 'ativo', notes: '' },
      { id: 'emp_tiago', name: 'TIAGO PEDRO', matricula: '32992', entryTime: '05:00', exitTime: '14:00', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_manha', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: 'SD1', cycleStartDate: '2026-11-01', workDays: 6, offDays: 1, status: 'ativo', notes: '' },
      { id: 'emp_fabio', name: 'FABIO BARBOSA', matricula: '32067', entryTime: '05:00', exitTime: '14:00', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_manha', scaleLabel: 'S/D-2', scaleColor: '#5b9bd5', ruleType: 'SD2', cycleStartDate: '2026-11-02', workDays: 6, offDays: 1, status: 'ativo', notes: '' },
      { id: 'emp_matheus', name: 'MATHEUS ARRUDA', matricula: '39326', entryTime: '05:00', exitTime: '09:00', breakMinutes: 0, hasSecondShift: true, entryTime2: '15:00', exitTime2: '19:00', groupId: 'grp_dupla', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: '5x2', cycleStartDate: '2026-11-02', workDays: 5, offDays: 2, status: 'ativo', notes: '' },
      { id: 'emp_rodrigo', name: 'RODRIGO SANTOS', matricula: '40865', entryTime: '14:00', exitTime: '23:00', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_tarde', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: 'SD1', cycleStartDate: '2026-11-02', workDays: 6, offDays: 1, status: 'ativo', notes: '' },
      { id: 'emp_maycon', name: 'MAYCON ALEXANDRE', matricula: '42617', entryTime: '14:00', exitTime: '23:00', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_tarde', scaleLabel: 'S/D-2', scaleColor: '#5b9bd5', ruleType: 'SD2', cycleStartDate: '2026-11-02', workDays: 6, offDays: 1, status: 'ativo', notes: '' },
      { id: 'emp_gabriel', name: 'GABRIEL QUEIROZ', matricula: '42724', entryTime: '13:00', exitTime: '21:20', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_tarde', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: 'SD1', cycleStartDate: '2026-11-02', workDays: 6, offDays: 1, status: 'ativo', notes: '' },
      { id: 'emp_alan', name: 'ALAN BRITO', matricula: '37750', entryTime: '', exitTime: '', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_tarde', scaleLabel: 'S/D-2', scaleColor: '#5b9bd5', ruleType: 'SD2', cycleStartDate: '2026-11-01', workDays: 6, offDays: 1, status: 'ferias', notes: 'Férias em Novembro/2026' }
    ],
    vacations: [{ id: 'vac_alan_nov26', employeeId: 'emp_alan', type: 'FERIAS', displayMode: 'footer_bar', startDate: '2026-11-01', endDate: '2026-11-30', notes: '' }],
    manualOverrides: {}
  };
}

const Store = {
  state: null,
  runtime: {
    searchQuery: '', activeTab: 'dashboard', brushMode: 'MODAL', selectedCells: new Set(),
    lastClickedCell: null, selectedRowEmpId: null, copiedRowPattern: null, previewZoom: 85,
    undoStack: [], redoStack: [], lastGeneratedPngUrl: null
  },
  listeners: new Set(),

  init() { this.state = this.loadFromStorage(); },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  notify(changedScope = 'all') { this.listeners.forEach(fn => fn(this.state, changedScope)); },

  sanitizeAndMigrate(rawObj) {
    const base = createReferenceModelState();
    if (!rawObj || typeof rawObj !== 'object') return base;
    const cleanStr = (v, fallback = '', maxLen = 120) => typeof v === 'string' ? v.trim().slice(0, maxLen) : fallback;
    const cleanColor = (v, fallback) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : fallback;

    const groups = Array.isArray(rawObj.groups) && rawObj.groups.length > 0 ? rawObj.groups.map((g, i) => ({
      id: cleanStr(g.id, `grp_${i}`, 40), name: cleanStr(g.name, `Bloco ${i + 1}`, 60), order: Number(g.order) || i + 1,
      minCoverage: Math.max(0, Number(g.minCoverage ?? 1)), repeatHeader: Boolean(g.repeatHeader), spacerBefore: g.spacerBefore !== false
    })) : base.groups;

    const validGroupIds = new Set(groups.map(g => g.id));
    const fallbackGroupId = groups[0].id;

    const employees = Array.isArray(rawObj.employees) ? rawObj.employees.map((e, i) => ({
      id: cleanStr(e.id, `emp_${Date.now()}_${i}`, 50), name: cleanStr(e.name, 'SEM NOME', 80).toUpperCase(), matricula: cleanStr(e.matricula, String(10000 + i), 30),
      entryTime: cleanStr(e.entryTime, '', 10), exitTime: cleanStr(e.exitTime, '', 10), breakMinutes: Math.max(0, Math.min(240, Number(e.breakMinutes ?? 60))),
      hasSecondShift: Boolean(e.hasSecondShift), entryTime2: cleanStr(e.entryTime2, '', 10), exitTime2: cleanStr(e.exitTime2, '', 10),
      groupId: validGroupIds.has(e.groupId) ? e.groupId : fallbackGroupId, scaleLabel: cleanStr(e.scaleLabel, 'S/D-1', 16).toUpperCase(),
      scaleColor: cleanColor(e.scaleColor, '#5b9bd5'), ruleType: ['SD1', 'SD2', '6x1', '5x2', '4x2', '12x36', '24x48', 'CUSTOM'].includes(e.ruleType) ? e.ruleType : 'SD1',
      cycleStartDate: /^\d{4}-\d{2}-\d{2}$/.test(e.cycleStartDate) ? e.cycleStartDate : '2026-11-01',
      workDays: Math.max(1, Math.min(31, Number(e.workDays) || 6)), offDays: Math.max(1, Math.min(31, Number(e.offDays) || 1)),
      status: ['ativo', 'ferias', 'afastado'].includes(e.status) ? e.status : 'ativo', notes: cleanStr(e.notes, '', 160)
    })) : base.employees;

    const vacations = Array.isArray(rawObj.vacations) ? rawObj.vacations.map((v, i) => ({
      id: cleanStr(v.id, `vac_${i}`, 50), employeeId: cleanStr(v.employeeId, '', 50), type: ['FERIAS', 'AFASTAMENTO', 'LICENCA'].includes(v.type) ? v.type : 'FERIAS',
      displayMode: ['footer_bar', 'inline_days', 'both'].includes(v.displayMode) ? v.displayMode : 'footer_bar',
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(v.startDate) ? v.startDate : '2026-11-01', endDate: /^\d{4}-\d{2}-\d{2}$/.test(v.endDate) ? v.endDate : '2026-11-30', notes: cleanStr(v.notes, '', 160)
    })) : base.vacations;

    const manualOverrides = {};
    if (rawObj.manualOverrides && typeof rawObj.manualOverrides === 'object') {
      for (const [mKey, monthObj] of Object.entries(rawObj.manualOverrides)) {
        if (/^\d{4}-\d{2}$/.test(mKey) && monthObj && typeof monthObj === 'object') {
          manualOverrides[mKey] = {};
          for (const [cKey, cellVal] of Object.entries(monthObj)) {
            if (cellVal && typeof cellVal === 'object') {
              manualOverrides[mKey][cleanStr(cKey, '', 60)] = { status: cleanStr(cellVal.status, 'AUTO', 6).toUpperCase(), yellow: ['default', 'yes', 'no'].includes(cellVal.yellow) ? cellVal.yellow : 'default', note: cleanStr(cellVal.note, '', 120) };
            }
          }
        }
      }
    }

    const holidaysByMonth = {};
    const srcHolidays = rawObj.config?.holidaysByMonth || base.config.holidaysByMonth;
    for (const [k, arr] of Object.entries(srcHolidays)) {
      if (/^\d{4}-\d{2}$/.test(k) && Array.isArray(arr)) holidaysByMonth[k] = arr.map(Number).filter(n => n >= 1 && n <= 31);
    }

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION, theme: rawObj.theme === 'light' ? 'light' : 'dark',
      selectedMonth: Math.max(1, Math.min(12, Number(rawObj.selectedMonth) || 11)), selectedYear: Math.max(2020, Math.min(2060, Number(rawObj.selectedYear) || 2026)),
      sortOrder: ['custom', 'entryTime', 'name', 'matricula'].includes(rawObj.sortOrder) ? rawObj.sortOrder : 'custom',
      config: {
        sectorTitle: cleanStr(rawObj.config?.sectorTitle, base.config.sectorTitle, 80), leftBadge: cleanStr(rawObj.config?.leftBadge, base.config.leftBadge, 30),
        customSubtitle: cleanStr(rawObj.config?.customSubtitle, '', 80), minCoverage: Math.max(0, Math.min(500, Number(rawObj.config?.minCoverage ?? 4))),
        periodStartDay: Math.max(1, Math.min(31, Number(rawObj.config?.periodStartDay) || 1)), periodEndDay: Math.max(0, Math.min(31, Number(rawObj.config?.periodEndDay) || 0)),
        showWorkSymbol: Boolean(rawObj.config?.showWorkSymbol), showWeekdayRow: Boolean(rawObj.config?.showWeekdayRow), highlightAllFolgasYellow: Boolean(rawObj.config?.highlightAllFolgasYellow),
        repeatHeaderPerBlock: rawObj.config?.repeatHeaderPerBlock !== false,
        symbols: { work: cleanStr(rawObj.config?.symbols?.work, 'T', 4), off: cleanStr(rawObj.config?.symbols?.off, 'F', 4), holiday: cleanStr(rawObj.config?.symbols?.holiday, 'FE', 4), vacation: cleanStr(rawObj.config?.symbols?.vacation, 'FER', 6), leave: cleanStr(rawObj.config?.symbols?.leave, 'AF', 4) },
        colors: { headerBg: cleanColor(rawObj.config?.colors?.headerBg, '#757575'), yellowHighlight: cleanColor(rawObj.config?.colors?.yellowHighlight, '#ffff00'), weekendBg: cleanColor(rawObj.config?.colors?.weekendBg, '#d9d9d9'), scaleBadge: cleanColor(rawObj.config?.colors?.scaleBadge, '#5b9bd5') },
        holidaysByMonth
      },
      groups, employees, vacations, manualOverrides
    };
  },

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('MONITORAMENTO_FROTA_ESCALA_V1') || localStorage.getItem('MONITORAMENTO_FROTA_ESCALA_V2');
      if (!raw) {
        const initial = createReferenceModelState();
        this.saveToStorageImmediate(initial);
        return initial;
      }
      return this.sanitizeAndMigrate(JSON.parse(raw));
    } catch (err) {
      console.error('Falha ao ler localStorage:', err);
      return createReferenceModelState();
    }
  },

  saveToStorageImmediate(stateObj) {
    try {
      const payload = JSON.stringify(stateObj);
      localStorage.setItem(STORAGE_KEY, payload);
      CloudSyncAdapter.pushState(payload);
    } catch (err) {
      UI.toast('Erro ao gravar dados. Armazenamento local pode estar cheio.', 'error');
    }
  },

  saveDebounced: null,

  recordHistory(actionLabel = 'Alteração') {
    const snapshot = deepClone({
      groups: this.state.groups, employees: this.state.employees, vacations: this.state.vacations,
      manualOverrides: this.state.manualOverrides, config: this.state.config
    });
    this.runtime.undoStack.push({ label: actionLabel, snapshot });
    if (this.runtime.undoStack.length > 50) this.runtime.undoStack.shift();
    this.runtime.redoStack = [];
  },

  undo() {
    if (this.runtime.undoStack.length === 0) return false;
    const currentSnapshot = deepClone({
      groups: this.state.groups, employees: this.state.employees, vacations: this.state.vacations,
      manualOverrides: this.state.manualOverrides, config: this.state.config
    });
    const prev = this.runtime.undoStack.pop();
    this.runtime.redoStack.push({ label: prev.label, snapshot: currentSnapshot });
    Object.assign(this.state, prev.snapshot);
    this.commit('all', false);
    UI.toast(`Desfeito: ${prev.label}`);
    return true;
  },

  redo() {
    if (this.runtime.redoStack.length === 0) return false;
    const currentSnapshot = deepClone({
      groups: this.state.groups, employees: this.state.employees, vacations: this.state.vacations,
      manualOverrides: this.state.manualOverrides, config: this.state.config
    });
    const next = this.runtime.redoStack.pop();
    this.runtime.undoStack.push({ label: next.label, snapshot: currentSnapshot });
    Object.assign(this.state, next.snapshot);
    this.commit('all', false);
    UI.toast(`Refeito: ${next.label}`);
    return true;
  },

  commit(scope = 'all', save = true) {
    if (save) {
      if (!this.saveDebounced) this.saveDebounced = debounce((st) => this.saveToStorageImmediate(st), 150);
      this.saveDebounced(this.state);
    }
    this.notify(scope);
  }
};

/**
 * ============================================================================
 * 5. RENDERIZADOR SELETIVO (Renderer)
 * ============================================================================
 */
const Renderer = {
  applyThemeAndColors(state) {
    document.documentElement.setAttribute('data-theme', state.theme || 'dark');
    const root = document.documentElement;
    const c = state.config.colors;
    root.style.setProperty('--sheet-header-bg', c.headerBg || '#757575');
    root.style.setProperty('--sheet-yellow', c.yellowHighlight || '#ffff00');
    root.style.setProperty('--sheet-weekend', c.weekendBg || '#d9d9d9');
    root.style.setProperty('--sheet-scale', c.scaleBadge || '#5b9bd5');
  },

  getProcessedEmployees(state, ignoreSearch = false) {
    const q = ignoreSearch ? '' : (Store.runtime.searchQuery || '').trim().toLowerCase();
    const list = state.employees.filter(emp => {
      if (!q) return true;
      return emp.name.toLowerCase().includes(q) || emp.matricula.toLowerCase().includes(q) || emp.scaleLabel.toLowerCase().includes(q);
    });
    const order = state.sortOrder || 'custom';
    if (order === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    else if (order === 'matricula') list.sort((a, b) => a.matricula.localeCompare(b.matricula, 'pt-BR'));
    else if (order === 'entryTime') list.sort((a, b) => (a.entryTime || '99:99').localeCompare(b.entryTime || '99:99'));
    return list;
  },

  buildOfficialSheetHTML(state, opts = {}) {
    const interactive = Boolean(opts.interactive);
    const ignoreSearch = Boolean(opts.ignoreSearch);
    const year = state.selectedYear;
    const month = state.selectedMonth;
    const days = opts.customDays || ScheduleEngine.getVisibleDays(state, year, month);
    const totalCols = 5 + days.length;

    const sectorTitle = escapeHTML(state.config.sectorTitle || 'MONITORAMENTO DA FROTA');
    const leftBadge = escapeHTML(state.config.leftBadge || 'EFETIVO');
    const rawSub = (state.config.customSubtitle || '').trim();
    const subtitle = escapeHTML(rawSub || `ESCALA DE ${MONTH_NAMES[month - 1]} ${year}`);

    const tableExactWidth = 384 + (days.length * 25);
    const paperExactWidth = tableExactWidth + 16;

    const colgroup = `<colgroup><col class="col-peg"><col class="col-larg"><col class="col-mat"><col class="col-name"><col class="col-scale">${days.map(() => '<col class="col-day">').join('')}</colgroup>`;

    const buildHeaderRows = () => {
      let h = `<tr class="row-col-headers"><th>Peg.</th><th>Larg.</th><th>Matrícula</th><th>Assistentes:</th><th>Escala</th>${days.map(d => `<th>${d}</th>`).join('')}</tr>`;
      if (state.config.showWeekdayRow) {
        h += `<tr class="row-weekdays"><th colspan="5">DIA DA SEMANA</th>${days.map(d => `<th>${WEEKDAY_LETTERS[ScheduleEngine.getDayOfWeekUTC(year, month, d)]}</th>`).join('')}</tr>`;
      }
      return h;
    };

    const filteredEmps = this.getProcessedEmployees(state, ignoreSearch);
    const activeEmps = [], footerVacEmps = [];
    filteredEmps.forEach(emp => {
      if (ScheduleEngine.isEmployeeInFooterVacation(state, emp, year, month)) footerVacEmps.push(emp);
      else activeEmps.push(emp);
    });

    const sortedGroups = [...state.groups].sort((a, b) => (a.order || 0) - (b.order || 0));
    let tbodyHTML = '';
    let renderedBlocks = 0;

    sortedGroups.forEach(grp => {
      const groupEmps = activeEmps.filter(e => e.groupId === grp.id);
      if (groupEmps.length === 0) return;
      if (renderedBlocks > 0) {
        if (grp.spacerBefore !== false) tbodyHTML += `<tr class="row-block-spacer"><td colspan="${totalCols}"></td></tr>`;
        if (state.config.repeatHeaderPerBlock && grp.repeatHeader) tbodyHTML += buildHeaderRows();
      }

      groupEmps.forEach(emp => {
        const isRowSelected = interactive && Store.runtime.selectedRowEmpId === emp.id;
        const cellsHTML = days.map(d => {
          const cell = ScheduleEngine.resolveCell(state, emp, year, month, d);
          const cls = ['cell-day'];
          if (cell.isWeekend) cls.push('is-weekend');
          if (cell.isYellow) cls.push('is-yellow');
          if (cell.status === 'FER') cls.push('is-vacation');
          if (cell.status === 'AF') cls.push('is-leave');
          if (interactive && cell.isManualDiff) cls.push('is-manual');
          if (interactive && Store.runtime.selectedCells.has(`${emp.id}|${d}`)) cls.push('cell-selected');

          const attrs = interactive ? `tabindex="0" role="gridcell" data-emp-id="${escapeHTML(emp.id)}" data-day="${d}" aria-label="${escapeHTML(emp.name)} dia ${d} status ${escapeHTML(cell.status)}" title="${escapeHTML(emp.name)} • Dia ${d}: ${escapeHTML(cell.status)}${cell.note ? ' (' + escapeHTML(cell.note) + ')' : ''}"` : '';
          return `<td class="${cls.join(' ')}" ${attrs}>${escapeHTML(cell.displayText)}</td>`;
        }).join('');

        const scaleStyle = `style="background-color:${escapeHTML(emp.scaleColor || state.config.colors.scaleBadge)};"`;
        const rowCls = isRowSelected ? 'row-employee row-selected' : 'row-employee';

        tbodyHTML += `<tr class="${rowCls}" data-row-emp="${escapeHTML(emp.id)}"><td class="cell-time">${escapeHTML(emp.entryTime)}</td><td class="cell-time">${escapeHTML(emp.exitTime)}</td><td class="cell-mat">${escapeHTML(emp.matricula)}</td><td class="cell-name" data-select-row="${escapeHTML(emp.id)}">${escapeHTML(emp.name)}</td><td class="cell-scale-badge" ${scaleStyle}>${escapeHTML(emp.scaleLabel)}</td>${cellsHTML}</tr>`;

        if (emp.hasSecondShift && (emp.entryTime2 || emp.exitTime2)) {
          tbodyHTML += `<tr class="row-second-shift"><td class="cell-time">${escapeHTML(emp.entryTime2)}</td><td class="cell-time">${escapeHTML(emp.exitTime2)}</td><td colspan="${totalCols - 2}" style="background:#f2f2f2;"></td></tr>`;
        }
      });
      renderedBlocks++;
    });

    if (footerVacEmps.length > 0) {
      tbodyHTML += `<tr class="row-vacation-spacer"><td colspan="${totalCols}"></td></tr>`;
      footerVacEmps.forEach(emp => {
        const scaleStyle = `style="background-color:${escapeHTML(emp.scaleColor || state.config.colors.scaleBadge)};"`;
        tbodyHTML += `<tr class="row-vacation-bar"><td class="cell-time"></td><td class="cell-time"></td><td class="cell-mat">${escapeHTML(emp.matricula)}</td><td class="cell-name">${escapeHTML(emp.name)}</td><td class="cell-scale-badge" ${scaleStyle}>${escapeHTML(emp.scaleLabel)}</td><td colspan="${days.length}" class="vacation-merged-banner">FÉRIAS</td></tr>`;
      });
    }

    return `
      <div class="official-sheet-paper ${interactive ? 'interactive-sheet' : 'static-sheet'}" style="width:${paperExactWidth}px;">
        <table class="fleet-schedule-table" role="grid" style="width:${tableExactWidth}px;">
          ${colgroup}
          <thead>
            <tr class="row-main-title"><th colspan="${totalCols}">${sectorTitle}</th></tr>
            <tr class="row-subtitle"><th colspan="3" class="th-efetivo">${leftBadge}</th><th colspan="${totalCols - 3}" class="th-month-title">${subtitle}</th></tr>
            ${buildHeaderRows()}
          </thead>
          <tbody>${tbodyHTML}</tbody>
        </table>
      </div>
    `;
  },

  updateLivePreviewDebounced: debounce((state) => {
    const mount = document.getElementById('liveOfficialPreviewMount');
    if (!mount) return;
    mount.innerHTML = Renderer.buildOfficialSheetHTML(state, { interactive: true, ignoreSearch: false });
    const stage = document.getElementById('previewScaleStage');
    const zoom = Store.runtime.previewZoom / 100;
    stage.style.transform = `scale(${zoom})`;
    const now = new Date();
    const stamp = document.getElementById('previewSyncStamp');
    if (stamp) stamp.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  }, 80),

  drawDailyCoverageChart(analytics, minCoverage) {
    const canvas = document.getElementById('dailyCoverageCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const days = analytics.days;
    if (days.length === 0) return;

    const padL = 32, padR = 14, padT = 18, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxVal = Math.max(minCoverage + 2, ...days.map(d => analytics.dailyTotals[d].working + analytics.dailyTotals[d].off));

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    }

    const colW = plotW / days.length;
    const barW = Math.max(4, colW * 0.38);

    days.forEach((d, idx) => {
      const cx = padL + idx * colW + colW / 2;
      const wCount = analytics.dailyTotals[d].working, fCount = analytics.dailyTotals[d].off;
      const wHeight = (wCount / maxVal) * plotH, fHeight = (fCount / maxVal) * plotH;

      ctx.fillStyle = wCount < minCoverage ? '#ff5252' : '#00e676';
      ctx.fillRect(cx - barW - 1, padT + plotH - wHeight, barW, wHeight);
      ctx.fillStyle = '#ffd740';
      ctx.fillRect(cx + 1, padT + plotH - fHeight, barW, fHeight);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 9.5px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(d), cx, h - 8);
    });

    if (minCoverage > 0) {
      const minY = padT + plotH - (minCoverage / maxVal) * plotH;
      ctx.strokeStyle = '#ff5252'; ctx.setLineDash([5, 4]); ctx.beginPath();
      ctx.moveTo(padL, minY); ctx.lineTo(w - padR, minY); ctx.stroke(); ctx.setLineDash([]);
    }
  },

  renderDashboard(state, analytics) {
    const totalHours = Object.values(analytics.employeeMetrics).reduce((acc, m) => acc + m.totalHours, 0);
    document.getElementById('dashboardKpis').innerHTML = `
      <div class="kpi-box"><div class="kpi-label">Efetivo Total</div><div class="kpi-val">${analytics.totalEmployees}</div><div class="kpi-sub">${analytics.activeCount} ativos na grade</div></div>
      <div class="kpi-box warn"><div class="kpi-label">Férias no Rodapé</div><div class="kpi-val">${analytics.footerVacationCount}</div><div class="kpi-sub">Faixa FÉRIAS</div></div>
      <div class="kpi-box"><div class="kpi-label">Horas Previstas</div><div class="kpi-val">${totalHours.toFixed(0)}h</div><div class="kpi-sub">Carga líquida mensal</div></div>
      <div class="kpi-box ${analytics.coveragePercent < 100 ? 'danger' : ''}"><div class="kpi-label">Meta de Cobertura</div><div class="kpi-val">${analytics.coveragePercent}%</div><div class="kpi-sub">Mínimo de ${state.config.minCoverage}/dia</div></div>
    `;

    document.getElementById('chartMinCovLabel').textContent = `Mín: ${state.config.minCoverage}`;
    this.drawDailyCoverageChart(analytics, state.config.minCoverage);
    document.getElementById('alertsCountBadge').textContent = String(analytics.alerts.length);
    const alertsEl = document.getElementById('dashboardAlertsList');
    alertsEl.innerHTML = analytics.alerts.map((a, idx) => `<li class="alert-row ${escapeHTML(a.severity)}" data-alert-idx="${idx}" tabindex="0"><strong>[${a.severity.toUpperCase()}]</strong> ${escapeHTML(a.text)}</li>`).join('');

    alertsEl.querySelectorAll('[data-alert-idx]').forEach(li => {
      li.addEventListener('click', () => {
        const alertObj = analytics.alerts[Number(li.dataset.alertIdx)];
        if (!alertObj) return;
        if (alertObj.day || alertObj.empId) {
          UI.switchTab('escala');
          setTimeout(() => {
            const selector = alertObj.empId && alertObj.day ? `#editorGridContainer td.cell-day[data-emp-id="${CSS.escape(alertObj.empId)}"][data-day="${alertObj.day}"]` : alertObj.day ? `#editorGridContainer td.cell-day[data-day="${alertObj.day}"]` : `#editorGridContainer tr[data-row-emp="${CSS.escape(alertObj.empId)}"] td.cell-day`;
            const target = document.querySelector(selector);
            if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); target.focus(); }
          }, 60);
        }
      });
    });

    const hmHeaders = analytics.days.map(d => `<th>${d}</th>`).join('');
    const hmRows = analytics.blockMetrics.map(bm => {
      const cells = analytics.days.map(d => {
        const val = bm.dailyMap[d] || 0;
        const cls = val < bm.minRequired ? 'hm-low' : val > bm.minRequired ? 'hm-high' : 'hm-ok';
        return `<td class="heatmap-cell ${cls}" data-hm-day="${d}" title="${escapeHTML(bm.group.name)} • Dia ${d}: ${val} trabalhando (Mín: ${bm.minRequired})">${val}</td>`;
      }).join('');
      return `<tr><td style="text-align:left;font-weight:700;white-space:nowrap;">${escapeHTML(bm.group.name)}</td>${cells}</tr>`;
    }).join('');

    const hmContainer = document.getElementById('coverageHeatmapContainer');
    hmContainer.innerHTML = `<table class="heatmap-table"><thead><tr><th style="text-align:left;">Turno / Bloco</th>${hmHeaders}</tr></thead><tbody>${hmRows}</tbody></table>`;
    hmContainer.querySelectorAll('[data-hm-day]').forEach(td => {
      td.addEventListener('click', () => {
        const day = Number(td.dataset.hmDay);
        UI.switchTab('escala');
        setTimeout(() => {
          const cell = document.querySelector(`#editorGridContainer td.cell-day[data-day="${day}"]`);
          if (cell) cell.focus();
        }, 50);
      });
    });
  },

  renderEditorGrid(state) {
    document.getElementById('chkShowWorkSymbol').checked = Boolean(state.config.showWorkSymbol);
    document.getElementById('chkShowWeekdayRow').checked = Boolean(state.config.showWeekdayRow);
    document.getElementById('lblWorkSym').textContent = state.config.symbols.work || 'T';
    document.getElementById('sheetSortSelect').value = state.sortOrder || 'custom';
    document.getElementById('btnPasteRow').disabled = !Store.runtime.copiedRowPattern;
    document.getElementById('editorGridContainer').innerHTML = this.buildOfficialSheetHTML(state, { interactive: true, ignoreSearch: false });
  },

  renderEmployeesTab(state) {
    document.getElementById('empTotalCount').textContent = String(state.employees.length);
    const blkSelect = document.getElementById('filterEmpBlock');
    const prevVal = blkSelect.value || 'ALL';
    blkSelect.innerHTML = `<option value="ALL">Todos os Turnos/Blocos</option>` + state.groups.map(g => `<option value="${escapeHTML(g.id)}">${escapeHTML(g.name)}</option>`).join('');
    blkSelect.value = prevVal;

    const statusFilter = document.getElementById('filterEmpStatus').value || 'ALL';
    const list = this.getProcessedEmployees(state, false).filter(emp => {
      if (blkSelect.value !== 'ALL' && emp.groupId !== blkSelect.value) return false;
      if (statusFilter !== 'ALL' && emp.status !== statusFilter) return false;
      return true;
    });

    const tbody = document.getElementById('employeesTableBody');
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">Nenhum funcionário encontrado para o filtro atual.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((emp) => {
      const grp = state.groups.find(g => g.id === emp.groupId);
      const timeDesc = emp.hasSecondShift && emp.entryTime2 ? `${escapeHTML(emp.entryTime)}-${escapeHTML(emp.exitTime)} + ${escapeHTML(emp.entryTime2)}-${escapeHTML(emp.exitTime2)}` : `${escapeHTML(emp.entryTime || '--:--')} às ${escapeHTML(emp.exitTime || '--:--')}`;
      return `
        <tr class="draggable-row" draggable="true" data-emp-row="${escapeHTML(emp.id)}">
          <td>::</td>
          <td style="font-family:var(--font-mono);font-weight:700;">${escapeHTML(emp.matricula)}</td>
          <td><strong>${escapeHTML(emp.name)}</strong></td>
          <td style="font-family:var(--font-mono);">${timeDesc}</td>
          <td>${escapeHTML(grp ? grp.name : 'Sem Bloco')}</td>
          <td><span class="mono-badge" style="background:${escapeHTML(emp.scaleColor)};color:#000;border:none;">${escapeHTML(emp.scaleLabel)}</span> <small>${escapeHTML(emp.ruleType)}</small></td>
          <td style="font-family:var(--font-mono);">${escapeHTML(emp.cycleStartDate)}</td>
          <td><span class="mono-badge">${escapeHTML(emp.status.toUpperCase())}</span></td>
          <td>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-xs" data-move-emp-up="${escapeHTML(emp.id)}" title="Subir">↑</button>
              <button type="button" class="btn btn-ghost btn-xs" data-move-emp-down="${escapeHTML(emp.id)}" title="Descer">↓</button>
              <button type="button" class="btn btn-outline btn-xs" data-edit-emp="${escapeHTML(emp.id)}">Editar</button>
              <button type="button" class="btn btn-danger btn-xs" data-del-emp="${escapeHTML(emp.id)}">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    UI.bindEmployeeRowActions(tbody);
  },

  renderBlocksAndMonthTab(state) {
    const activeEl = document.activeElement;
    const setValSafe = (id, val) => { const el = document.getElementById(id); if (el && activeEl !== el) el.value = val; };
    setValSafe('cfgSectorTitle', state.config.sectorTitle || '');
    setValSafe('cfgLeftBadge', state.config.leftBadge || '');
    setValSafe('cfgCustomSubtitle', state.config.customSubtitle || '');
    setValSafe('cfgMinCoverage', state.config.minCoverage ?? 4);
    setValSafe('cfgPeriodStart', state.config.periodStartDay || 1);
    setValSafe('cfgPeriodEnd', state.config.periodEndDay || 0);

    const holidays = ScheduleEngine.getHolidaysForMonth(state, state.selectedYear, state.selectedMonth);
    setValSafe('cfgHolidaysInput', holidays.join(', '));

    const movable = ScheduleEngine.getMovableHolidaysForYear(state.selectedYear).filter(h => h.month === state.selectedMonth);
    const hintEl = document.getElementById('movableHolidaysHint');
    if (hintEl) {
      const easter = ScheduleEngine.getEasterDate(state.selectedYear);
      hintEl.textContent = movable.length > 0 ? `Feriados móveis neste mês: ${movable.map(m => `Dia ${m.day} (${m.name})`).join(', ')} • Páscoa ${state.selectedYear}: ${easter.day}/0${easter.month}.` : `Páscoa ${state.selectedYear}: ${String(easter.day).padStart(2, '0')}/0${easter.month} (Sem feriados móveis neste mês).`;
    }

    document.getElementById('cfgHighlightAllOffYellow').checked = Boolean(state.config.highlightAllFolgasYellow);
    document.getElementById('cfgRepeatHeaderGlobal').checked = Boolean(state.config.repeatHeaderPerBlock);

    const sortedGroups = [...state.groups].sort((a, b) => (a.order || 0) - (b.order || 0));
    const container = document.getElementById('blocksListContainer');
    container.innerHTML = sortedGroups.map((g, idx) => {
      const count = state.employees.filter(e => e.groupId === g.id).length;
      return `
        <div class="block-item">
          <div><strong>${idx + 1}. ${escapeHTML(g.name)}</strong><div class="text-muted-sm">${count} funcionário(s) • Mín. Cobertura: ${g.minCoverage ?? 1}</div></div>
          <div class="btn-row">
            <label class="switch-label" title="Repetir cabeçalho"><input type="checkbox" data-blk-header="${escapeHTML(g.id)}" ${g.repeatHeader ? 'checked' : ''}><span>Cabeçalho</span></label>
            <label class="switch-label" title="Barra separadora"><input type="checkbox" data-blk-spacer="${escapeHTML(g.id)}" ${g.spacerBefore !== false ? 'checked' : ''}><span>Espaçador</span></label>
            <button type="button" class="btn btn-ghost btn-xs" data-blk-up="${escapeHTML(g.id)}" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="btn btn-ghost btn-xs" data-blk-down="${escapeHTML(g.id)}" ${idx === sortedGroups.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="btn btn-outline btn-xs" data-blk-edit="${escapeHTML(g.id)}">Renomear</button>
            <button type="button" class="btn btn-danger btn-xs" data-blk-del="${escapeHTML(g.id)}">Excluir</button>
          </div>
        </div>
      `;
    }).join('');

    UI.bindBlockListActions(container);
  },

  renderVacationsTab(state) {
    const empSel = document.getElementById('vacEmpSelect');
    const prevEmp = empSel.value;
    empSel.innerHTML = state.employees.map(e => `<option value="${escapeHTML(e.id)}">${escapeHTML(e.name)} (${escapeHTML(e.matricula)})</option>`).join('');
    if (prevEmp && state.employees.some(e => e.id === prevEmp)) empSel.value = prevEmp;

    const tbody = document.getElementById('vacationsTableBody');
    if (state.vacations.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;">Nenhum período cadastrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.vacations.map(v => {
      const emp = state.employees.find(e => e.id === v.employeeId);
      const modeText = v.displayMode === 'footer_bar' ? 'Faixa Rodapé' : v.displayMode === 'inline_days' ? 'Dias na Linha' : 'Ambos';
      return `
        <tr>
          <td><strong>${escapeHTML(emp ? emp.name : 'Removido')}</strong></td>
          <td><span class="mono-badge">${escapeHTML(v.type)}</span></td>
          <td style="font-family:var(--font-mono);">${escapeHTML(v.startDate)} → ${escapeHTML(v.endDate)}</td>
          <td>${modeText}</td>
          <td>
            <div class="btn-row">
              <button type="button" class="btn btn-outline btn-xs" data-edit-vac="${escapeHTML(v.id)}">Editar</button>
              <button type="button" class="btn btn-danger btn-xs" data-del-vac="${escapeHTML(v.id)}">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    UI.bindVacationActions(tbody);
  },

  renderReportsTab(state, analytics) {
    const blocksBody = document.getElementById('reportBlocksBody');
    blocksBody.innerHTML = analytics.blockMetrics.map(bm => `
      <tr>
        <td><strong>${escapeHTML(bm.group.name)}</strong></td>
        <td style="font-family:var(--font-mono);">${bm.activeCount}</td>
        <td style="font-family:var(--font-mono);">${bm.minRequired}</td>
        <td style="font-family:var(--font-mono);">${bm.avgWorking.toFixed(1)} / dia</td>
        <td style="font-family:var(--font-mono);">${bm.minObserved}</td>
        <td style="font-family:var(--font-mono);font-weight:700;">${bm.totalBlockHours.toFixed(1)}h</td>
      </tr>
    `).join('');

    const empBody = document.getElementById('reportEmployeesBody');
    const emps = this.getProcessedEmployees(state, false);
    empBody.innerHTML = emps.map(emp => {
      const m = analytics.employeeMetrics[emp.id];
      const shifts = emp.hasSecondShift && emp.entryTime2 ? `${escapeHTML(emp.entryTime)}-${escapeHTML(emp.exitTime)} + ${escapeHTML(emp.entryTime2)}-${escapeHTML(emp.exitTime2)}` : `${escapeHTML(emp.entryTime || '--:--')} às ${escapeHTML(emp.exitTime || '--:--')}`;
      return `
        <tr>
          <td style="font-family:var(--font-mono);">${escapeHTML(emp.matricula)}</td>
          <td><strong>${escapeHTML(emp.name)}</strong></td>
          <td style="font-family:var(--font-mono);">${shifts}</td>
          <td>${escapeHTML(emp.scaleLabel)} (${escapeHTML(emp.ruleType)})</td>
          <td style="font-family:var(--font-mono);">${m.dailyHours.toFixed(2)}h</td>
          <td style="font-family:var(--font-mono);font-weight:700;">${m.workDaysCount}</td>
          <td style="font-family:var(--font-mono);">${m.offDaysCount}</td>
          <td>${m.inFooterVac ? 'FÉRIAS (Mês)' : m.specialDaysCount}</td>
          <td style="font-family:var(--font-mono);font-weight:700;">${m.totalHours.toFixed(1)}h</td>
          <td>${m.manualAdjustments > 0 ? `<span class="mono-badge">${m.manualAdjustments} ajuste(s)</span>` : 'Automático'}</td>
        </tr>
      `;
    }).join('');
  },

  renderConfigTab(state) {
    const activeEl = document.activeElement;
    const setValSafe = (id, val) => { const el = document.getElementById(id); if (el && activeEl !== el) el.value = val; };
    setValSafe('cfgSymWork', state.config.symbols.work || 'T');
    setValSafe('cfgSymOff', state.config.symbols.off || 'F');
    setValSafe('cfgSymHoliday', state.config.symbols.holiday || 'FE');
    setValSafe('cfgSymVacation', state.config.symbols.vacation || 'FER');
    setValSafe('cfgColHeader', state.config.colors.headerBg || '#757575');
    setValSafe('cfgColYellow', state.config.colors.yellowHighlight || '#ffff00');
    setValSafe('cfgColWeekend', state.config.colors.weekendBg || '#d9d9d9');
    setValSafe('cfgColScale', state.config.colors.scaleBadge || '#5b9bd5');
  },

  renderAll(state, scope = 'all') {
    this.applyThemeAndColors(state);

    document.getElementById('topMonthSelect').value = String(state.selectedMonth);
    document.getElementById('topYearInput').value = String(state.selectedYear);
    document.getElementById('btnUndo').disabled = Store.runtime.undoStack.length === 0;
    document.getElementById('btnRedo').disabled = Store.runtime.redoStack.length === 0;
    document.getElementById('undoCountBadge').textContent = String(Store.runtime.undoStack.length);
    document.getElementById('redoCountBadge').textContent = String(Store.runtime.redoStack.length);

    const analytics = ScheduleEngine.analyzeMonth(state, state.selectedYear, state.selectedMonth);
    const activeTab = Store.runtime.activeTab;

    if (scope === 'all' || activeTab === 'dashboard') this.renderDashboard(state, analytics);
    if (scope === 'all' || activeTab === 'escala') this.renderEditorGrid(state);
    if (scope === 'all' || activeTab === 'funcionarios') this.renderEmployeesTab(state);
    if (scope === 'all' || activeTab === 'blocos') this.renderBlocksAndMonthTab(state);
    if (scope === 'all' || activeTab === 'ferias') this.renderVacationsTab(state);
    if (scope === 'all' || activeTab === 'relatorios') this.renderReportsTab(state, analytics);
    if (scope === 'all' || activeTab === 'config') this.renderConfigTab(state);

    this.updateLivePreviewDebounced(state);
  }
};

/**
 * ============================================================================
 * 6. SERVIÇO DE EXPORTAÇÃO (PNG, PDF MULTIPÁGINA E CSV)
 * ============================================================================
 */
const ExportService = {
  getDayChunks(state, splitMode) {
    const allDays = ScheduleEngine.getVisibleDays(state, state.selectedYear, state.selectedMonth);
    if (splitMode === 'fortnight' && allDays.length > 15) {
      const firstHalf = allDays.filter(d => d <= 15);
      const secondHalf = allDays.filter(d => d > 15);
      return [firstHalf, secondHalf].filter(arr => arr.length > 0);
    }
    return [allDays];
  },

  renderNativeCanvas2D(state, daysArray, scaleFactor = 2) {
    const year = state.selectedYear;
    const month = state.selectedMonth;
    const colWidths = [48, 48, 66, 184, 54, ...daysArray.map(() => 26)];
    const pad = 12;
    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const totalW = tableW + pad * 2;

    const allEmps = Renderer.getProcessedEmployees(state, true);
    const activeEmps = allEmps.filter(e => !ScheduleEngine.isEmployeeInFooterVacation(state, e, year, month));
    const vacEmps = allEmps.filter(e => ScheduleEngine.isEmployeeInFooterVacation(state, e, year, month));
    const sortedGroups = [...state.groups].sort((a, b) => (a.order || 0) - (b.order || 0));

    const rowH = 23;
    const weekdayH = state.config.showWeekdayRow ? 19 : 0;

    let exactHeight = pad + 32 + 28 + rowH + weekdayH;
    let blockCount = 0;
    sortedGroups.forEach(grp => {
      const grpEmps = activeEmps.filter(e => e.groupId === grp.id);
      if (grpEmps.length === 0) return;
      if (blockCount > 0) {
        if (grp.spacerBefore !== false) exactHeight += rowH;
        if (state.config.repeatHeaderPerBlock && grp.repeatHeader) exactHeight += rowH + weekdayH;
      }
      grpEmps.forEach(emp => {
        exactHeight += rowH;
        if (emp.hasSecondShift && (emp.entryTime2 || emp.exitTime2)) exactHeight += rowH;
      });
      blockCount++;
    });

    if (vacEmps.length > 0) exactHeight += 24 + vacEmps.length * rowH;
    exactHeight += pad;

    const canvas = document.createElement('canvas');
    canvas.width = totalW * scaleFactor;
    canvas.height = exactHeight * scaleFactor;
    const ctx = canvas.getContext('2d');
    ctx.scale(scaleFactor, scaleFactor);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, exactHeight);

    let y = pad;
    const x0 = pad;

    const drawBox = (x, cy, w, h, bg, text, font = 'bold 11px Arial', color = '#000000') => {
      ctx.fillStyle = bg;
      ctx.fillRect(x, cy, w, h);
      ctx.strokeStyle = '#333333';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, cy, w, h);
      if (text !== '' && text !== null && text !== undefined) {
        ctx.fillStyle = color; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(text), x + w / 2, cy + h / 2);
      }
    };

    drawBox(x0, y, tableW, 32, '#ffffff', state.config.sectorTitle || 'MONITORAMENTO DA FROTA', 'bold 18px Arial', '#000000');
    y += 32;

    const wEfetivo = colWidths[0] + colWidths[1] + colWidths[2];
    const sub = (state.config.customSubtitle || '').trim() || `ESCALA DE ${MONTH_NAMES[month - 1]} ${year}`;
    drawBox(x0, y, wEfetivo, 28, state.config.colors.headerBg, state.config.leftBadge || 'EFETIVO', 'bold 12px Arial', '#ffffff');
    drawBox(x0 + wEfetivo, y, tableW - wEfetivo, 28, state.config.colors.headerBg, sub, 'bold 16px Arial', '#ffffff');
    y += 28;

    const drawTableHeaders = () => {
      const labels = ['Peg.', 'Larg.', 'Matrícula', 'Assistentes:', 'Escala', ...daysArray.map(String)];
      let cx = x0;
      labels.forEach((lbl, i) => {
        drawBox(cx, y, colWidths[i], rowH, state.config.colors.headerBg, lbl, 'bold 11px Arial', '#ffffff');
        cx += colWidths[i];
      });
      y += rowH;

      if (state.config.showWeekdayRow) {
        const fixedW = colWidths.slice(0, 5).reduce((a, b) => a + b, 0);
        drawBox(x0, y, fixedW, weekdayH, '#525252', 'DIA DA SEMANA', 'bold 9.5px Arial', '#ffffff');
        let wx = x0 + fixedW;
        daysArray.forEach((d, idx) => {
          const wd = WEEKDAY_LETTERS[ScheduleEngine.getDayOfWeekUTC(year, month, d)];
          drawBox(wx, y, colWidths[5 + idx], weekdayH, '#525252', wd, 'bold 9.5px Arial', '#ffffff');
          wx += colWidths[5 + idx];
        });
        y += weekdayH;
      }
    };

    drawTableHeaders();

    let rendered = 0;
    sortedGroups.forEach(grp => {
      const grpEmps = activeEmps.filter(e => e.groupId === grp.id);
      if (grpEmps.length === 0) return;

      if (rendered > 0) {
        if (grp.spacerBefore !== false) { drawBox(x0, y, tableW, rowH, '#f2f2f2', ''); y += rowH; }
        if (state.config.repeatHeaderPerBlock && grp.repeatHeader) drawTableHeaders();
      }

      grpEmps.forEach(emp => {
        let cx = x0;
        drawBox(cx, y, colWidths[0], rowH, '#ffffff', emp.entryTime, '11px Arial'); cx += colWidths[0];
        drawBox(cx, y, colWidths[1], rowH, '#ffffff', emp.exitTime, '11px Arial'); cx += colWidths[1];
        drawBox(cx, y, colWidths[2], rowH, '#ffffff', emp.matricula, '11px Arial'); cx += colWidths[2];
        drawBox(cx, y, colWidths[3], rowH, '#ffffff', emp.name, 'bold 11px Arial'); cx += colWidths[3];
        drawBox(cx, y, colWidths[4], rowH, emp.scaleColor || state.config.colors.scaleBadge, emp.scaleLabel, 'bold 11px Arial'); cx += colWidths[4];

        daysArray.forEach((d, idx) => {
          const cell = ScheduleEngine.resolveCell(state, emp, year, month, d);
          let bg = '#ffffff';
          if (cell.isWeekend) bg = state.config.colors.weekendBg;
          if (cell.isYellow) bg = state.config.colors.yellowHighlight;
          if (cell.status === 'FER') bg = '#bfbfbf';
          if (cell.status === 'AF') bg = '#fed7aa';
          drawBox(cx, y, colWidths[5 + idx], rowH, bg, cell.displayText, 'bold 11px Arial');
          cx += colWidths[5 + idx];
        });
        y += rowH;

        if (emp.hasSecondShift && (emp.entryTime2 || emp.exitTime2)) {
          let scx = x0;
          drawBox(scx, y, colWidths[0], rowH, '#ffffff', emp.entryTime2, '11px Arial'); scx += colWidths[0];
          drawBox(scx, y, colWidths[1], rowH, '#ffffff', emp.exitTime2, '11px Arial'); scx += colWidths[1];
          drawBox(scx, y, tableW - colWidths[0] - colWidths[1], rowH, '#f2f2f2', '');
          y += rowH;
        }
      });
      rendered++;
    });

    if (vacEmps.length > 0) {
      y += 24;
      vacEmps.forEach(emp => {
        let cx = x0;
        drawBox(cx, y, colWidths[0], rowH, '#ffffff', ''); cx += colWidths[0];
        drawBox(cx, y, colWidths[1], rowH, '#ffffff', ''); cx += colWidths[1];
        drawBox(cx, y, colWidths[2], rowH, '#ffffff', emp.matricula, '11px Arial'); cx += colWidths[2];
        drawBox(cx, y, colWidths[3], rowH, '#ffffff', emp.name, 'bold 11px Arial'); cx += colWidths[3];
        drawBox(cx, y, colWidths[4], rowH, emp.scaleColor || state.config.colors.scaleBadge, emp.scaleLabel, 'bold 11px Arial'); cx += colWidths[4];
        const remW = tableW - (cx - x0);
        drawBox(cx, y, remW, rowH, '#bfbfbf', 'FÉRIAS', 'bold 12px Arial', '#000000');
        y += rowH;
      });
    }

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, pad, tableW, y - pad);

    return canvas;
  },

  async renderScheduleCanvases(state, splitMode = 'full', scaleFactor = 2) {
    const chunks = this.getDayChunks(state, splitMode);
    const staging = document.getElementById('printStagingArea');
    const canvases = [];

    for (const daysChunk of chunks) {
      staging.innerHTML = Renderer.buildOfficialSheetHTML(state, { interactive: false, ignoreSearch: true, customDays: daysChunk });
      const paperEl = staging.querySelector('.official-sheet-paper');
      const expectedWidth = 384 + (daysChunk.length * 25) + 16;

      if (typeof window.html2canvas === 'function' && paperEl) {
        try {
          const c = await window.html2canvas(paperEl, { scale: scaleFactor, backgroundColor: '#ffffff', useCORS: true, logging: false, width: expectedWidth, windowWidth: expectedWidth + 40 });
          if (c && c.width > 100 && c.width <= 16384 && c.height > 50) canvases.push(c);
          else canvases.push(this.renderNativeCanvas2D(state, daysChunk, scaleFactor));
        } catch (err) {
          canvases.push(this.renderNativeCanvas2D(state, daysChunk, scaleFactor));
        }
      } else {
        canvases.push(this.renderNativeCanvas2D(state, daysChunk, scaleFactor));
      }
    }
    return canvases;
  },

  combineCanvasesVertically(canvases, gap = 24) {
    if (canvases.length === 1) return canvases[0];
    const maxWidth = Math.max(...canvases.map(c => c.width));
    const totalHeight = canvases.reduce((sum, c) => sum + c.height, 0) + gap * (canvases.length - 1);
    const out = document.createElement('canvas');
    out.width = maxWidth; out.height = totalHeight;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, maxWidth, totalHeight);

    let y = 0;
    canvases.forEach(c => { ctx.drawImage(c, 0, y); y += c.height + gap; });
    return out;
  },

  async generatePNG(state) {
    const statusEl = document.getElementById('exportRenderStatus');
    const resultBox = document.getElementById('exportImageResultBox');
    const splitMode = document.getElementById('exportSplitMode').value || 'full';
    const scaleFactor = Number(document.getElementById('exportScaleSelect').value) || 2;

    statusEl.textContent = 'A renderizar...';
    resultBox.innerHTML = '<div class="empty-state">A gerar imagem de alta definição da escala completa...</div>';

    let canvases = await this.renderScheduleCanvases(state, splitMode, scaleFactor);
    let finalCanvas = this.combineCanvasesVertically(canvases, 30 * scaleFactor);
    let dataUrl = finalCanvas.toDataURL('image/png');

    if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length < 1000) {
      const chunks = this.getDayChunks(state, splitMode);
      canvases = chunks.map(daysChunk => this.renderNativeCanvas2D(state, daysChunk, scaleFactor));
      finalCanvas = this.combineCanvasesVertically(canvases, 30 * scaleFactor);
      dataUrl = finalCanvas.toDataURL('image/png');
    }

    Store.runtime.lastGeneratedPngUrl = dataUrl;
    resultBox.innerHTML = `<img src="${dataUrl}" alt="Imagem Oficial da Escala">`;
    statusEl.textContent = `Pronto (${finalCanvas.width}×${finalCanvas.height}px)`;
    document.getElementById('btnDownloadPng').disabled = false;
    UI.toast('Imagem PNG de alta resolução gerada com sucesso!');
    return dataUrl;
  },

  async downloadPNG(state) {
    let url = Store.runtime.lastGeneratedPngUrl;
    if (!url) url = await this.generatePNG(state);
    const a = document.createElement('a');
    a.href = url; a.download = `ESCALA_${MONTH_NAMES[state.selectedMonth - 1]}_${state.selectedYear}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  },

  async exportPDF(state) {
    const splitMode = document.getElementById('exportSplitMode').value || 'full';
    const scaleFactor = Number(document.getElementById('exportScaleSelect').value) || 2;

    UI.toast('Preparando documento PDF A4 Paisagem...');
    const canvases = await this.renderScheduleCanvases(state, splitMode, scaleFactor);

    if (!window.jspdf || !window.jspdf.jsPDF) {
      UI.toast('Biblioteca PDF offline: abrindo impressão paisagem nativa.', 'warn');
      this.printSchedule(state);
      return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const margin = 7, usableW = pageW - margin * 2, usableH = pageH - margin * 2;
    let firstPage = true;

    canvases.forEach(canvas => {
      const ratio = canvas.height / canvas.width;
      const renderedH = usableW * ratio;

      if (renderedH <= usableH) {
        if (!firstPage) pdf.addPage('a4', 'landscape');
        firstPage = false;
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, usableW, renderedH);
      } else {
        const pxPerMm = canvas.width / usableW;
        const sliceHeightPx = Math.floor(usableH * pxPerMm);
        let offsetY = 0;

        while (offsetY < canvas.height) {
          if (!firstPage) pdf.addPage('a4', 'landscape');
          firstPage = false;
          const currentSlicePx = Math.min(sliceHeightPx, canvas.height - offsetY);
          const sliceCanvas = document.createElement('canvas');
          sliceCanvas.width = canvas.width; sliceCanvas.height = currentSlicePx;
          const sCtx = sliceCanvas.getContext('2d');
          sCtx.fillStyle = '#ffffff'; sCtx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
          sCtx.drawImage(canvas, 0, offsetY, canvas.width, currentSlicePx, 0, 0, canvas.width, currentSlicePx);
          const sliceMmH = currentSlicePx / pxPerMm;
          pdf.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', margin, margin, usableW, sliceMmH);
          offsetY += currentSlicePx;
        }
      }
    });

    pdf.save(`ESCALA_${MONTH_NAMES[state.selectedMonth - 1]}_${state.selectedYear}.pdf`);
    UI.toast('Arquivo PDF exportado com sucesso!');
  },

  printSchedule(state) {
    const splitMode = document.getElementById('exportSplitMode').value || 'full';
    const chunks = this.getDayChunks(state, splitMode);
    const staging = document.getElementById('printStagingArea');
    staging.innerHTML = chunks.map((daysChunk, idx) => {
      const tableHTML = Renderer.buildOfficialSheetHTML(state, { interactive: false, ignoreSearch: true, customDays: daysChunk });
      return idx === 0 ? tableHTML : `<div class="print-page-break"></div>${tableHTML}`;
    }).join('');
    window.print();
  },

  exportCSV(state) {
    const year = state.selectedYear, month = state.selectedMonth;
    const days = ScheduleEngine.getVisibleDays(state, year, month);
    const analytics = ScheduleEngine.analyzeMonth(state, year, month);
    const allEmps = Renderer.getProcessedEmployees(state, true);

    const headerCols = ['Peg.', 'Larg.', '2a Peg.', '2a Larg.', 'Matricula', 'Assistente', 'Bloco', 'Escala', ...days.map(d => `Dia ${d}`), 'Dias Trabalhados', 'Folgas', 'Feriados/Ferias/Afast', 'Jornada Liquida/Dia (h)', 'Total Horas Mes'];
    const escapeCsvField = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const lines = [headerCols.map(escapeCsvField).join(';')];

    allEmps.forEach(emp => {
      const grp = state.groups.find(g => g.id === emp.groupId);
      const m = analytics.employeeMetrics[emp.id];
      const dayValues = days.map(d => {
        if (m.inFooterVac) return 'FERIAS';
        return ScheduleEngine.resolveCell(state, emp, year, month, d).status;
      });
      const row = [
        emp.entryTime || '', emp.exitTime || '',
        emp.hasSecondShift ? (emp.entryTime2 || '') : '', emp.hasSecondShift ? (emp.exitTime2 || '') : '',
        emp.matricula, emp.name, grp ? grp.name : '', emp.scaleLabel,
        ...dayValues,
        m.workDaysCount, m.offDaysCount, m.specialDaysCount,
        m.dailyHours.toFixed(2).replace('.', ','), m.totalHours.toFixed(2).replace('.', ',')
      ];
      lines.push(row.map(escapeCsvField).join(';'));
    });

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ESCALA_${MONTH_NAMES[month - 1]}_${year}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    UI.toast('Planilha CSV exportada com sucesso!');
  }
};

/**
 * ============================================================================
 * 7. CONTROLADOR DE INTERFACE, EVENTOS E MODAIS (UI)
 * ============================================================================
 */
const UI = {
  isPainting: false, paintedInStroke: new Set(), draggedEmpId: null,

  init() {
    this.initMonthDropdown(); this.bindSidebarAndTopbar(); this.bindPreviewControls();
    this.bindEditorGridEvents(); this.bindEmployeeModalEvents(); this.bindMonthAndBlockForms();
    this.bindVacationForm(); this.bindExportButtons(); this.bindConfigAndBackupEvents();
    this.bindGlobalKeyboardShortcuts();
    Store.subscribe((state, scope) => Renderer.renderAll(state, scope));
    Renderer.renderAll(Store.state, 'all');
  },

  toast(message, type = 'ok') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const item = document.createElement('div');
    item.className = `toast-item ${type}`; item.textContent = message;
    container.appendChild(item);
    setTimeout(() => item.remove(), 3400);
  },

  openDialog({ title, message, showPrompt = false, promptLabel = '', defaultValue = '', confirmText = 'Confirmar', cancelText = 'Cancelar' }) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('dialogModal');
      document.getElementById('dialogModalTitle').textContent = title || 'Confirmação';
      document.getElementById('dialogModalMessage').textContent = message || '';
      document.getElementById('btnDialogConfirm').textContent = confirmText;
      document.getElementById('btnDialogCancel').textContent = cancelText;

      const promptWrap = document.getElementById('dialogPromptWrap');
      const promptInput = document.getElementById('dialogPromptInput');
      if (showPrompt) {
        promptWrap.hidden = false;
        document.getElementById('dialogPromptLabel').textContent = promptLabel || 'Informe o valor:';
        promptInput.value = defaultValue || '';
      } else { promptWrap.hidden = true; }

      overlay.hidden = false;
      setTimeout(() => showPrompt ? promptInput.focus() : document.getElementById('btnDialogConfirm').focus(), 20);

      const closeAndResolve = (result) => {
        overlay.hidden = true;
        document.getElementById('btnDialogConfirm').removeEventListener('click', onConfirm);
        document.getElementById('btnDialogCancel').removeEventListener('click', onCancel);
        document.getElementById('btnCloseDialogModal').removeEventListener('click', onCancel);
        overlay.removeEventListener('keydown', onKeyDown);
        resolve(result);
      };

      const onConfirm = () => closeAndResolve(showPrompt ? promptInput.value.trim() : true);
      const onCancel = () => closeAndResolve(showPrompt ? null : false);
      const onKeyDown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if (e.key === 'Enter' && showPrompt) { e.preventDefault(); onConfirm(); }
      };

      document.getElementById('btnDialogConfirm').addEventListener('click', onConfirm);
      document.getElementById('btnDialogCancel').addEventListener('click', onCancel);
      document.getElementById('btnCloseDialogModal').addEventListener('click', onCancel);
      overlay.addEventListener('keydown', onKeyDown);
    });
  },

  initMonthDropdown() {
    document.getElementById('topMonthSelect').innerHTML = MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  },

  switchTab(tabId) {
    Store.runtime.activeTab = tabId;
    document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tabId}`));
    Renderer.renderAll(Store.state, tabId);
  },

  bindSidebarAndTopbar() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => this.switchTab(btn.dataset.tab)));
    document.querySelectorAll('[data-switch-tab]').forEach(btn => btn.addEventListener('click', () => this.switchTab(btn.dataset.switchTab)));
    document.getElementById('btnToggleSidebar').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('collapsed'));
    document.getElementById('btnSidebarGeneratePng').addEventListener('click', async () => { this.switchTab('exportar'); await ExportService.generatePNG(Store.state); });
    
    document.getElementById('topMonthSelect').addEventListener('change', (e) => { Store.state.selectedMonth = Number(e.target.value); Store.runtime.selectedCells.clear(); Store.commit('all'); });
    document.getElementById('topYearInput').addEventListener('change', (e) => { const y = Number(e.target.value); if (y >= 2020 && y <= 2060) { Store.state.selectedYear = y; Store.runtime.selectedCells.clear(); Store.commit('all'); } });
    
    document.getElementById('btnPrevMonth').addEventListener('click', () => {
      if (Store.state.selectedMonth === 1) { Store.state.selectedMonth = 12; Store.state.selectedYear = Math.max(2020, Store.state.selectedYear - 1); } else { Store.state.selectedMonth--; }
      Store.runtime.selectedCells.clear(); Store.commit('all');
    });
    document.getElementById('btnNextMonth').addEventListener('click', () => {
      if (Store.state.selectedMonth === 12) { Store.state.selectedMonth = 1; Store.state.selectedYear = Math.min(2060, Store.state.selectedYear + 1); } else { Store.state.selectedMonth++; }
      Store.runtime.selectedCells.clear(); Store.commit('all');
    });

    document.getElementById('globalSearchInput').addEventListener('input', (e) => { Store.runtime.searchQuery = e.target.value; Renderer.renderAll(Store.state, Store.runtime.activeTab); });
    document.getElementById('btnUndo').addEventListener('click', () => Store.undo());
    document.getElementById('btnRedo').addEventListener('click', () => Store.redo());
    document.getElementById('btnThemeToggle').addEventListener('click', () => { Store.state.theme = Store.state.theme === 'light' ? 'dark' : 'light'; Store.commit('all'); });
    document.getElementById('btnTogglePreviewPane').addEventListener('click', () => {
      const split = document.getElementById('workspaceSplit'); split.classList.remove('preview-maximized'); split.classList.toggle('preview-hidden');
    });

    document.getElementById('btnRecalculate').addEventListener('click', async () => {
      const mKey = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
      const overrideKeys = Object.keys(Store.state.manualOverrides[mKey] || {});
      if (overrideKeys.length > 0) {
        const discard = await this.openDialog({ title: 'Recalcular Ciclo', message: `Existem ${overrideKeys.length} ajuste(s) manual(is). Deseja descartar os ajustes manuais e reaplicar 100% a regra automática?`, confirmText: 'Descartar Manuais', cancelText: 'Manter Ajustes' });
        if (discard) { Store.recordHistory('Recalcular mês (limpando ajustes)'); delete Store.state.manualOverrides[mKey]; Store.commit('all'); this.toast(`Ciclo recalculado: ${overrideKeys.length} célula(s) voltaram ao padrão.`); return; }
      }
      Store.commit('all');
      this.toast(`Ciclo validado.`);
    });
  },

  bindPreviewControls() {
    const slider = document.getElementById('previewZoomSlider');
    const valBadge = document.getElementById('previewZoomValue');
    const stage = document.getElementById('previewScaleStage');

    const applyZoom = (z) => {
      const clamped = Math.max(50, Math.min(200, Number(z) || 85));
      Store.runtime.previewZoom = clamped; slider.value = String(clamped); valBadge.textContent = `${clamped}%`; stage.style.transform = `scale(${clamped / 100})`;
    };

    slider.addEventListener('input', (e) => applyZoom(e.target.value));
    document.getElementById('btnZoomOut').addEventListener('click', () => applyZoom(Store.runtime.previewZoom - 10));
    document.getElementById('btnZoomIn').addEventListener('click', () => applyZoom(Store.runtime.previewZoom + 10));
    document.getElementById('btnZoomFit').addEventListener('click', () => {
      const viewport = document.getElementById('previewViewport'), paper = document.querySelector('#liveOfficialPreviewMount .official-sheet-paper');
      if (viewport && paper) applyZoom(Math.floor(((viewport.clientWidth - 36) / paper.scrollWidth) * 100));
    });

    document.getElementById('btnExpandPreview').addEventListener('click', () => {
      const split = document.getElementById('workspaceSplit'); split.classList.remove('preview-hidden'); split.classList.toggle('preview-maximized');
    });

    document.getElementById('liveOfficialPreviewMount').addEventListener('click', (e) => {
      const cellEl = e.target.closest('td.cell-day');
      if (!cellEl) return;
      const empId = cellEl.dataset.empId, day = Number(cellEl.dataset.day);
      if (empId && day) this.handleCellInteraction(empId, day, e.shiftKey);
    });
  },

  bindEditorGridEvents() {
    document.querySelectorAll('#brushSelector .brush-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Store.runtime.brushMode = btn.dataset.brush;
        document.querySelectorAll('#brushSelector .brush-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    document.getElementById('sheetSortSelect').addEventListener('change', (e) => { Store.state.sortOrder = e.target.value; Store.commit('escala'); });
    document.getElementById('chkShowWorkSymbol').addEventListener('change', (e) => { Store.recordHistory('Alternar sigla de trabalho'); Store.state.config.showWorkSymbol = e.target.checked; Store.commit('escala'); });
    document.getElementById('chkShowWeekdayRow').addEventListener('change', (e) => { Store.recordHistory('Alternar linha de dias da semana'); Store.state.config.showWeekdayRow = e.target.checked; Store.commit('escala'); });

    document.getElementById('btnCopyRow').addEventListener('click', () => {
      const empId = Store.runtime.selectedRowEmpId || Store.runtime.lastClickedCell?.empId;
      const emp = Store.state.employees.find(e => e.id === empId);
      if (!emp) return this.toast('Clique primeiro em um funcionário ou célula da linha que deseja copiar.', 'warn');
      const year = Store.state.selectedYear, month = Store.state.selectedMonth;
      const pattern = {};
      ScheduleEngine.getVisibleDays(Store.state, year, month).forEach(d => {
        const resolved = ScheduleEngine.resolveCell(Store.state, emp, year, month, d);
        pattern[d] = { status: resolved.status, yellow: resolved.isYellow ? 'yes' : 'default' };
      });
      Store.runtime.copiedRowPattern = { sourceName: emp.name, pattern };
      document.getElementById('btnPasteRow').disabled = false;
      this.toast(`Linha de ${emp.name} copiada!`);
    });

    document.getElementById('btnPasteRow').addEventListener('click', () => {
      const targetEmpId = Store.runtime.selectedRowEmpId || Store.runtime.lastClickedCell?.empId;
      const targetEmp = Store.state.employees.find(e => e.id === targetEmpId);
      const copied = Store.runtime.copiedRowPattern;
      if (!targetEmp || !copied) return this.toast('Selecione o funcionário de destino para colar a linha.', 'warn');
      Store.recordHistory(`Colar linha em ${targetEmp.name}`);
      const mKey = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
      if (!Store.state.manualOverrides[mKey]) Store.state.manualOverrides[mKey] = {};
      for (const [dayStr, val] of Object.entries(copied.pattern)) {
        Store.state.manualOverrides[mKey][`${targetEmp.id}_${dayStr}`] = { status: val.status, yellow: val.yellow, note: `Colado de ${copied.sourceName}` };
      }
      Store.commit('all');
      this.toast(`Padrão colado em ${targetEmp.name}!`);
    });

    document.getElementById('btnResetMonthOverrides').addEventListener('click', async () => {
      const mKey = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
      const count = Object.keys(Store.state.manualOverrides[mKey] || {}).length;
      if (count === 0) return this.toast('Não há ajustes manuais neste mês.', 'warn');
      const ok = await this.openDialog({ title: 'Limpar Ajustes', message: `Remover todos os ${count} ajustes manuais deste mês e restaurar automático?` });
      if (ok) {
        Store.recordHistory('Limpar ajustes manuais do mês');
        delete Store.state.manualOverrides[mKey];
        Store.runtime.selectedCells.clear();
        Store.commit('all');
        this.toast('Ajustes manuais removidos.');
      }
    });

    const gridContainer = document.getElementById('editorGridContainer');

    gridContainer.addEventListener('mousedown', (e) => {
      const nameCell = e.target.closest('[data-select-row]');
      if (nameCell) { Store.runtime.selectedRowEmpId = nameCell.dataset.selectRow; Renderer.renderEditorGrid(Store.state); return; }
      const dayCell = e.target.closest('td.cell-day');
      if (!dayCell) return;
      const empId = dayCell.dataset.empId, day = Number(dayCell.dataset.day);
      if (!empId || !day) return;

      if (Store.runtime.brushMode !== 'MODAL' && !e.shiftKey) {
        this.isPainting = true; this.paintedInStroke.clear();
        Store.recordHistory(`Pintar células (${Store.runtime.brushMode})`);
        this.paintSingleCellWithoutCommit(empId, day, Store.runtime.brushMode);
        this.paintedInStroke.add(`${empId}|${day}`);
        Store.commit('all');
      } else {
        this.handleCellInteraction(empId, day, e.shiftKey);
      }
    });

    gridContainer.addEventListener('mouseover', (e) => {
      if (!this.isPainting) return;
      const dayCell = e.target.closest('td.cell-day');
      if (!dayCell) return;
      const empId = dayCell.dataset.empId, day = Number(dayCell.dataset.day), key = `${empId}|${day}`;
      if (empId && day && !this.paintedInStroke.has(key)) {
        this.paintedInStroke.add(key);
        this.paintSingleCellWithoutCommit(empId, day, Store.runtime.brushMode);
        Store.commit('all');
      }
    });

    window.addEventListener('mouseup', () => { this.isPainting = false; this.paintedInStroke.clear(); });

    gridContainer.addEventListener('keydown', (e) => {
      const cell = e.target.closest('td.cell-day');
      if (!cell) return;
      const empId = cell.dataset.empId, day = Number(cell.dataset.day);

      if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault(); this.moveGridFocus(empId, day, e.key); return;
      }
      const keyUpper = e.key.toUpperCase();
      if (['T', 'F', 'E', 'A'].includes(keyUpper) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const modeMap = { T: 'T', F: 'F', E: 'FE', A: 'AUTO' };
        this.applyQuickStatusToSelectionOrCell(empId, day, modeMap[keyUpper]);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); this.openCellModal(empId, day);
      }
    });

    document.getElementById('cellModalStatus').addEventListener('change', (e) => {
      document.getElementById('cellModalCustomWrap').hidden = e.target.value !== 'CUSTOM';
    });

    const closeCellModal = () => { document.getElementById('cellModal').hidden = true; };
    document.getElementById('btnCloseCellModal').addEventListener('click', closeCellModal);
    document.getElementById('btnCancelCellModal').addEventListener('click', closeCellModal);

    document.getElementById('formCellModal').addEventListener('submit', (e) => {
      e.preventDefault();
      let status = document.getElementById('cellModalStatus').value;
      if (status === 'CUSTOM') status = (document.getElementById('cellModalCustomText').value || 'T').trim().toUpperCase();
      const yellow = document.getElementById('cellModalYellow').value;
      const note = document.getElementById('cellModalNote').value.trim();

      const targets = Store.runtime.selectedCells.size > 0 ? Array.from(Store.runtime.selectedCells).map(k => { const [eId, dStr] = k.split('|'); return { empId: eId, day: Number(dStr) }; }) : Store.runtime.lastClickedCell ? [Store.runtime.lastClickedCell] : [];

      if (targets.length > 0) {
        Store.recordHistory(`Editar ${targets.length} célula(s)`);
        const mKey = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
        if (!Store.state.manualOverrides[mKey]) Store.state.manualOverrides[mKey] = {};

        targets.forEach(({ empId, day }) => {
          const cKey = `${empId}_${day}`;
          if (status === 'AUTO' && yellow === 'default' && !note) delete Store.state.manualOverrides[mKey][cKey];
          else Store.state.manualOverrides[mKey][cKey] = { status, yellow, note };
        });
        Store.commit('all');
      }
      closeCellModal();
    });
  },

  handleCellInteraction(empId, day, isShiftKey) {
    Store.runtime.selectedRowEmpId = empId;
    if (isShiftKey && Store.runtime.lastClickedCell && Store.runtime.lastClickedCell.empId === empId) {
      const startD = Math.min(Store.runtime.lastClickedCell.day, day);
      const endD = Math.max(Store.runtime.lastClickedCell.day, day);
      for (let d = startD; d <= endD; d++) Store.runtime.selectedCells.add(`${empId}|${d}`);
      Renderer.renderEditorGrid(Store.state);
      return;
    }
    Store.runtime.selectedCells.clear();
    Store.runtime.selectedCells.add(`${empId}|${day}`);
    Store.runtime.lastClickedCell = { empId, day };
    this.openCellModal(empId, day);
  },

  paintSingleCellWithoutCommit(empId, day, brushMode) {
    const mKey = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
    if (!Store.state.manualOverrides[mKey]) Store.state.manualOverrides[mKey] = {};
    const cKey = `${empId}_${day}`;
    if (brushMode === 'AUTO') delete Store.state.manualOverrides[mKey][cKey];
    else if (brushMode === 'F_YELLOW') Store.state.manualOverrides[mKey][cKey] = { status: 'F', yellow: 'yes', note: 'Destaque manual' };
    else Store.state.manualOverrides[mKey][cKey] = { status: brushMode, yellow: 'default', note: '' };
  },

  applyQuickStatusToSelectionOrCell(empId, day, status) {
    const targets = Store.runtime.selectedCells.size > 0 ? Array.from(Store.runtime.selectedCells).map(k => { const [eId, dStr] = k.split('|'); return { empId: eId, day: Number(dStr) }; }) : [{ empId, day }];
    Store.recordHistory(`Atalho ${status} (${targets.length} cél.)`);
    targets.forEach(t => this.paintSingleCellWithoutCommit(t.empId, t.day, status));
    Store.commit('all');
    setTimeout(() => { const el = document.querySelector(`#editorGridContainer td.cell-day[data-emp-id="${CSS.escape(empId)}"][data-day="${day}"]`); if (el) el.focus(); }, 30);
  },

  moveGridFocus(empId, day, arrowKey) {
    const allRows = Array.from(document.querySelectorAll('#editorGridContainer tr.row-employee'));
    const rowIdx = allRows.findIndex(r => r.dataset.rowEmp === empId);
    if (rowIdx === -1) return;

    let targetEmpId = empId, targetDay = day;
    if (arrowKey === 'ArrowLeft') targetDay = day - 1;
    else if (arrowKey === 'ArrowRight') targetDay = day + 1;
    else if (arrowKey === 'ArrowUp' && rowIdx > 0) targetEmpId = allRows[rowIdx - 1].dataset.rowEmp;
    else if (arrowKey === 'ArrowDown' && rowIdx < allRows.length - 1) targetEmpId = allRows[rowIdx + 1].dataset.rowEmp;

    const nextCell = document.querySelector(`#editorGridContainer td.cell-day[data-emp-id="${CSS.escape(targetEmpId)}"][data-day="${targetDay}"]`);
    if (nextCell) { Store.runtime.lastClickedCell = { empId: targetEmpId, day: targetDay }; nextCell.focus(); }
  },

  openCellModal(empId, day) {
    const emp = Store.state.employees.find(e => e.id === empId);
    if (!emp) return;
    const year = Store.state.selectedYear, month = Store.state.selectedMonth, mKey = ScheduleEngine.getMonthKey(year, month);
    const manual = Store.state.manualOverrides[mKey]?.[`${empId}_${day}`] || null;
    const resolved = ScheduleEngine.resolveCell(Store.state, emp, year, month, day);

    const selCount = Store.runtime.selectedCells.size;
    document.getElementById('cellModalTitle').textContent = selCount > 1 ? `Editar ${selCount} Células Selecionadas` : `Dia ${day}/${String(month).padStart(2, '0')}/${year} • ${emp.name}`;
    document.getElementById('cellModalInfo').textContent = `Regra Automática: ${resolved.autoStatus} | Escala: ${emp.scaleLabel}`;

    const statusSel = document.getElementById('cellModalStatus'), customWrap = document.getElementById('cellModalCustomWrap'), customInput = document.getElementById('cellModalCustomText');
    if (!manual) { statusSel.value = 'AUTO'; customWrap.hidden = true; }
    else if (['AUTO', 'T', 'F', 'FE', 'FER', 'AF'].includes(manual.status)) { statusSel.value = manual.status; customWrap.hidden = true; }
    else { statusSel.value = 'CUSTOM'; customWrap.hidden = false; customInput.value = manual.status; }

    document.getElementById('cellModalYellow').value = manual?.yellow || 'default';
    document.getElementById('cellModalNote').value = manual?.note || '';
    document.getElementById('cellModal').hidden = false;
  },

  bindEmployeeModalEvents() {
    document.getElementById('btnNewEmployee').addEventListener('click', () => this.openEmployeeModal(null));
    document.getElementById('filterEmpBlock').addEventListener('change', () => Renderer.renderEmployeesTab(Store.state));
    document.getElementById('filterEmpStatus').addEventListener('change', () => Renderer.renderEmployeesTab(Store.state));

    const closeEmpModal = () => { document.getElementById('employeeModal').hidden = true; };
    document.getElementById('btnCloseEmpModal').addEventListener('click', closeEmpModal);
    document.getElementById('btnCancelEmpModal').addEventListener('click', closeEmpModal);

    document.getElementById('empModalSecondShift').addEventListener('change', (e) => {
      const show = e.target.value === 'yes';
      document.querySelectorAll('.second-shift-row').forEach(el => { el.hidden = !show; });
    });

    document.getElementById('empModalRuleType').addEventListener('change', (e) => {
      const r = e.target.value;
      if (r === '6x1' || r === 'SD1' || r === 'SD2') { document.getElementById('empModalWorkDays').value = '6'; document.getElementById('empModalOffDays').value = '1'; }
      else if (r === '5x2') { document.getElementById('empModalWorkDays').value = '5'; document.getElementById('empModalOffDays').value = '2'; }
      else if (r === '4x2') { document.getElementById('empModalWorkDays').value = '4'; document.getElementById('empModalOffDays').value = '2'; }
      else if (r === '12x36') { document.getElementById('empModalWorkDays').value = '1'; document.getElementById('empModalOffDays').value = '1'; }
      else if (r === '24x48') { document.getElementById('empModalWorkDays').value = '1'; document.getElementById('empModalOffDays').value = '2'; }
    });

    document.getElementById('formEmployeeModal').addEventListener('submit', (e) => {
      e.preventDefault();
      const editingId = document.getElementById('empModalId').value;
      const name = document.getElementById('empModalName').value.trim().toUpperCase();
      const matricula = document.getElementById('empModalMatricula').value.trim();
      const status = document.getElementById('empModalStatus').value;
      const entryTime = document.getElementById('empModalEntry1').value.trim();
      const exitTime = document.getElementById('empModalExit1').value.trim();

      if (!name || !matricula) return this.toast('Preencha o nome completo e a matrícula.', 'error');
      
      const duplicate = Store.state.employees.find(emp => emp.matricula.toLowerCase() === matricula.toLowerCase() && emp.id !== editingId);
      if (duplicate) return this.toast(`Matrícula "${matricula}" já pertence a ${duplicate.name}!`, 'error');
      if (status === 'ativo' && (!entryTime || !exitTime)) return this.toast('Funcionários ativos precisam de horário de entrada e saída.', 'error');

      const payload = {
        id: editingId || `emp_${Date.now()}`, name, matricula, status, groupId: document.getElementById('empModalBlock').value,
        entryTime, exitTime, breakMinutes: Math.max(0, Number(document.getElementById('empModalBreak').value) || 0),
        hasSecondShift: document.getElementById('empModalSecondShift').value === 'yes',
        entryTime2: document.getElementById('empModalEntry2').value.trim(), exitTime2: document.getElementById('empModalExit2').value.trim(),
        scaleLabel: document.getElementById('empModalScaleLabel').value.trim().toUpperCase(), scaleColor: document.getElementById('empModalScaleColor').value,
        ruleType: document.getElementById('empModalRuleType').value, cycleStartDate: document.getElementById('empModalCycleStart').value,
        workDays: Math.max(1, Number(document.getElementById('empModalWorkDays').value) || 6),
        offDays: Math.max(1, Number(document.getElementById('empModalOffDays').value) || 1),
        notes: document.getElementById('empModalNotes').value.trim()
      };

      Store.recordHistory(editingId ? `Editar ${name}` : `Cadastrar ${name}`);
      const idx = Store.state.employees.findIndex(x => x.id === payload.id);
      if (idx >= 0) Store.state.employees[idx] = payload; else Store.state.employees.push(payload);

      Store.commit('all'); closeEmpModal(); this.toast(`Funcionário ${name} salvo com sucesso!`);
    });
  },

  openEmployeeModal(empId) {
    const blkSel = document.getElementById('empModalBlock');
    blkSel.innerHTML = Store.state.groups.map(g => `<option value="${escapeHTML(g.id)}">${escapeHTML(g.name)}</option>`).join('');

    const emp = empId ? Store.state.employees.find(e => e.id === empId) : null;
    document.getElementById('empModalTitle').textContent = emp ? `Editar: ${emp.name}` : 'Novo Funcionário';
    document.getElementById('empModalId').value = emp ? emp.id : '';
    document.getElementById('empModalName').value = emp ? emp.name : '';
    document.getElementById('empModalMatricula').value = emp ? emp.matricula : '';
    document.getElementById('empModalStatus').value = emp ? emp.status : 'ativo';
    document.getElementById('empModalBlock').value = emp ? emp.groupId : (Store.state.groups[0]?.id || '');
    document.getElementById('empModalEntry1').value = emp ? emp.entryTime : '05:00';
    document.getElementById('empModalExit1').value = emp ? emp.exitTime : '14:00';
    document.getElementById('empModalBreak').value = emp ? emp.breakMinutes : 60;
    document.getElementById('empModalSecondShift').value = emp?.hasSecondShift ? 'yes' : 'no';
    document.getElementById('empModalEntry2').value = emp?.entryTime2 || '15:00';
    document.getElementById('empModalExit2').value = emp?.exitTime2 || '19:00';
    document.getElementById('empModalScaleLabel').value = emp ? emp.scaleLabel : 'S/D-1';
    document.getElementById('empModalScaleColor').value = emp ? emp.scaleColor : '#5b9bd5';
    document.getElementById('empModalRuleType').value = emp ? emp.ruleType : 'SD1';
    document.getElementById('empModalCycleStart').value = emp ? emp.cycleStartDate : ScheduleEngine.formatDateISO(Store.state.selectedYear, Store.state.selectedMonth, 1);
    document.getElementById('empModalWorkDays').value = emp ? emp.workDays : 6;
    document.getElementById('empModalOffDays').value = emp ? emp.offDays : 1;
    document.getElementById('empModalNotes').value = emp ? emp.notes : '';

    document.querySelectorAll('.second-shift-row').forEach(el => { el.hidden = !emp?.hasSecondShift; });
    document.getElementById('employeeModal').hidden = false;
  },

  bindEmployeeRowActions(tbody) {
    tbody.querySelectorAll('[data-edit-emp]').forEach(btn => {
      btn.addEventListener('click', () => this.openEmployeeModal(btn.dataset.editEmp));
    });

    tbody.querySelectorAll('[data-del-emp]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const empId = btn.dataset.delEmp;
        const emp = Store.state.employees.find(e => e.id === empId);
        if (!emp) return;
        const ok = await this.openDialog({ title: 'Excluir Funcionário', message: `Excluir "${emp.name}" (${emp.matricula})? Isso também removerá férias e ajustes manuais vinculados a ele.` });
        if (!ok) return;

        Store.recordHistory(`Excluir ${emp.name}`);
        Store.state.employees = Store.state.employees.filter(e => e.id !== empId);
        Store.state.vacations = Store.state.vacations.filter(v => v.employeeId !== empId);
        for (const mObj of Object.values(Store.state.manualOverrides)) {
          for (const cKey of Object.keys(mObj)) { if (cKey.startsWith(`${empId}_`)) delete mObj[cKey]; }
        }
        Store.commit('all');
        this.toast(`Funcionário ${emp.name} removido.`);
      });
    });

    const moveEmp = (empId, dir) => {
      const idx = Store.state.employees.findIndex(e => e.id === empId);
      const targetIdx = idx + dir;
      if (idx < 0 || targetIdx < 0 || targetIdx >= Store.state.employees.length) return;
      Store.recordHistory('Reordenar funcionário');
      const [item] = Store.state.employees.splice(idx, 1);
      Store.state.employees.splice(targetIdx, 0, item);
      Store.state.sortOrder = 'custom';
      Store.commit('all');
    };

    tbody.querySelectorAll('[data-move-emp-up]').forEach(btn => { btn.addEventListener('click', () => moveEmp(btn.dataset.moveEmpUp, -1)); });
    tbody.querySelectorAll('[data-move-emp-down]').forEach(btn => { btn.addEventListener('click', () => moveEmp(btn.dataset.moveEmpDown, 1)); });

    tbody.querySelectorAll('tr[data-emp-row]').forEach(row => {
      row.addEventListener('dragstart', () => { this.draggedEmpId = row.dataset.empRow; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); this.draggedEmpId = null; });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const targetId = row.dataset.empRow;
        if (!this.draggedEmpId || this.draggedEmpId === targetId) return;

        const fromIdx = Store.state.employees.findIndex(x => x.id === this.draggedEmpId);
        const toIdx = Store.state.employees.findIndex(x => x.id === targetId);
        if (fromIdx === -1 || toIdx === -1) return;

        Store.recordHistory('Arrastar funcionário');
        const targetGroup = Store.state.employees[toIdx].groupId;
        const [moved] = Store.state.employees.splice(fromIdx, 1);
        moved.groupId = targetGroup;
        Store.state.employees.splice(toIdx, 0, moved);
        Store.state.sortOrder = 'custom';
        Store.commit('all');
      });
    });
  },

  bindMonthAndBlockForms() {
    document.getElementById('btnAutoFillHolidays').addEventListener('click', () => {
      const suggested = ScheduleEngine.getSuggestedHolidaysForMonth(Store.state.selectedYear, Store.state.selectedMonth);
      document.getElementById('cfgHolidaysInput').value = suggested.join(', ');
      this.toast(`Feriados sugeridos para ${MONTH_NAMES[Store.state.selectedMonth - 1]}: ${suggested.join(', ') || 'Nenhum'}`);
    });

    document.getElementById('formMonthParams').addEventListener('submit', (e) => {
      e.preventDefault();
      Store.recordHistory('Atualizar parâmetros do mês');
      Store.state.config.sectorTitle = document.getElementById('cfgSectorTitle').value.trim();
      Store.state.config.leftBadge = document.getElementById('cfgLeftBadge').value.trim();
      Store.state.config.customSubtitle = document.getElementById('cfgCustomSubtitle').value.trim();
      Store.state.config.minCoverage = Math.max(0, Number(document.getElementById('cfgMinCoverage').value) || 0);
      Store.state.config.periodStartDay = Math.max(1, Math.min(31, Number(document.getElementById('cfgPeriodStart').value) || 1));
      Store.state.config.periodEndDay = Math.max(0, Math.min(31, Number(document.getElementById('cfgPeriodEnd').value) || 0));
      Store.state.config.highlightAllFolgasYellow = document.getElementById('cfgHighlightAllOffYellow').checked;
      Store.state.config.repeatHeaderPerBlock = document.getElementById('cfgRepeatHeaderGlobal').checked;

      const rawHol = document.getElementById('cfgHolidaysInput').value;
      const daysList = rawHol.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n) && n >= 1 && n <= 31);
      const mKey = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
      Store.state.config.holidaysByMonth[mKey] = Array.from(new Set(daysList)).sort((a, b) => a - b);
      Store.commit('all');
      this.toast('Parâmetros do mês e feriados atualizados!');
    });

    document.getElementById('btnAddBlock').addEventListener('click', async () => {
      const name = await this.openDialog({ title: 'Novo Bloco / Turno', message: 'Informe o nome do novo turno ou equipe:', showPrompt: true, promptLabel: 'Nome do Bloco', defaultValue: 'Turno Especial' });
      if (!name) return;
      Store.recordHistory(`Criar bloco ${name}`);
      Store.state.groups.push({ id: `grp_${Date.now()}`, name, order: Store.state.groups.length + 1, minCoverage: 1, repeatHeader: true, spacerBefore: true });
      Store.commit('all');
      this.toast(`Bloco "${name}" adicionado!`);
    });
  },

  bindBlockListActions(container) {
    const sorted = [...Store.state.groups].sort((a, b) => (a.order || 0) - (b.order || 0));

    container.querySelectorAll('[data-blk-header]').forEach(chk => {
      chk.addEventListener('change', () => { const g = Store.state.groups.find(x => x.id === chk.dataset.blkHeader); if (g) { g.repeatHeader = chk.checked; Store.commit('all'); } });
    });

    container.querySelectorAll('[data-blk-spacer]').forEach(chk => {
      chk.addEventListener('change', () => { const g = Store.state.groups.find(x => x.id === chk.dataset.blkSpacer); if (g) { g.spacerBefore = chk.checked; Store.commit('all'); } });
    });

    container.querySelectorAll('[data-blk-up]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = sorted.findIndex(x => x.id === btn.dataset.blkUp);
        if (idx > 0) { Store.recordHistory('Reordenar bloco'); const tmp = sorted[idx - 1].order; sorted[idx - 1].order = sorted[idx].order; sorted[idx].order = tmp; Store.commit('all'); }
      });
    });

    container.querySelectorAll('[data-blk-down]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = sorted.findIndex(x => x.id === btn.dataset.blkDown);
        if (idx < sorted.length - 1) { Store.recordHistory('Reordenar bloco'); const tmp = sorted[idx + 1].order; sorted[idx + 1].order = sorted[idx].order; sorted[idx].order = tmp; Store.commit('all'); }
      });
    });

    container.querySelectorAll('[data-blk-edit]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const g = Store.state.groups.find(x => x.id === btn.dataset.blkEdit);
        if (!g) return;
        const val = await this.openDialog({ title: 'Editar Bloco / Cobertura Mínima', message: 'Use o formato "Nome do Bloco | Cobertura Mínima":', showPrompt: true, promptLabel: 'Nome | Mínimo', defaultValue: `${g.name} | ${g.minCoverage ?? 1}` });
        if (!val) return;
        const [newName, minStr] = val.split('|').map(s => s.trim());
        if (newName) {
          Store.recordHistory(`Renomear bloco ${g.name}`);
          g.name = newName;
          if (minStr !== undefined && !Number.isNaN(Number(minStr))) g.minCoverage = Math.max(0, Number(minStr));
          Store.commit('all');
        }
      });
    });

    container.querySelectorAll('[data-blk-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (Store.state.groups.length <= 1) return this.toast('A escala precisa ter pelo menos um bloco ativo.', 'warn');
        const gId = btn.dataset.blkDel;
        const g = Store.state.groups.find(x => x.id === gId);
        const ok = await this.openDialog({ title: 'Excluir Bloco', message: `Excluir o bloco "${g?.name}"? Os funcionários dele serão realocados automaticamente para o primeiro bloco.` });
        if (!ok) return;

        Store.recordHistory(`Excluir bloco ${g?.name}`);
        Store.state.groups = Store.state.groups.filter(x => x.id !== gId);
        const fallback = Store.state.groups[0].id;
        Store.state.employees.forEach(emp => { if (emp.groupId === gId) emp.groupId = fallback; });
        Store.commit('all');
        this.toast('Bloco excluído e funcionários realocados.');
      });
    });
  },

  bindVacationForm() {
    document.getElementById('formVacation').addEventListener('submit', (e) => {
      e.preventDefault();
      const editingId = document.getElementById('vacIdInput').value;
      const employeeId = document.getElementById('vacEmpSelect').value;
      const type = document.getElementById('vacTypeSelect').value;
      const displayMode = document.getElementById('vacDisplaySelect').value;
      const startDate = document.getElementById('vacStartInput').value;
      const endDate = document.getElementById('vacEndInput').value;
      const notes = document.getElementById('vacNotesInput').value.trim();

      if (!startDate || !endDate || endDate < startDate) return this.toast('A data final deve ser igual ou posterior à data inicial.', 'error');

      const conflict = Store.state.vacations.find(v => v.employeeId === employeeId && v.id !== editingId && ScheduleEngine.doPeriodsOverlap(startDate, endDate, v.startDate, v.endDate));
      if (conflict) return this.toast(`Conflito! Este funcionário já possui registro de ${conflict.startDate} a ${conflict.endDate}.`, 'error');

      Store.recordHistory('Salvar período de férias/afastamento');
      const record = { id: editingId || `vac_${Date.now()}`, employeeId, type, displayMode, startDate, endDate, notes };

      const idx = Store.state.vacations.findIndex(v => v.id === record.id);
      if (idx >= 0) Store.state.vacations[idx] = record; else Store.state.vacations.push(record);

      document.getElementById('formVacation').reset();
      document.getElementById('vacIdInput').value = '';
      document.getElementById('btnCancelVacEdit').hidden = true;
      Store.commit('all');
      this.toast('Período de férias/afastamento registrado!');
    });

    document.getElementById('btnCancelVacEdit').addEventListener('click', () => {
      document.getElementById('formVacation').reset(); document.getElementById('vacIdInput').value = ''; document.getElementById('btnCancelVacEdit').hidden = true;
    });
  },

  bindVacationActions(tbody) {
    tbody.querySelectorAll('[data-edit-vac]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = Store.state.vacations.find(x => x.id === btn.dataset.editVac);
        if (!v) return;
        document.getElementById('vacIdInput').value = v.id;
        document.getElementById('vacEmpSelect').value = v.employeeId;
        document.getElementById('vacTypeSelect').value = v.type;
        document.getElementById('vacDisplaySelect').value = v.displayMode;
        document.getElementById('vacStartInput').value = v.startDate;
        document.getElementById('vacEndInput').value = v.endDate;
        document.getElementById('vacNotesInput').value = v.notes || '';
        document.getElementById('btnCancelVacEdit').hidden = false;
      });
    });

    tbody.querySelectorAll('[data-del-vac]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await this.openDialog({ title: 'Remover Período', message: 'Deseja remover este registro de férias/afastamento?' });
        if (!ok) return;
        Store.recordHistory('Remover férias/afastamento');
        Store.state.vacations = Store.state.vacations.filter(x => x.id !== btn.dataset.delVac);
        Store.commit('all');
        this.toast('Registro removido.');
      });
    });
  },

  bindExportButtons() {
    document.getElementById('btnGeneratePngMain').addEventListener('click', () => ExportService.generatePNG(Store.state));
    document.getElementById('btnDownloadPng').addEventListener('click', () => ExportService.downloadPNG(Store.state));
    document.getElementById('btnExportPdf').addEventListener('click', () => ExportService.exportPDF(Store.state));
    document.getElementById('btnPrintSchedule').addEventListener('click', () => ExportService.printSchedule(Store.state));
    document.getElementById('btnExportCsvDirect').addEventListener('click', () => ExportService.exportCSV(Store.state));
    document.getElementById('btnExportReportCsv').addEventListener('click', () => ExportService.exportCSV(Store.state));
  },

  bindConfigAndBackupEvents() {
    document.getElementById('formVisualStyle').addEventListener('submit', (e) => {
      e.preventDefault();
      Store.recordHistory('Alterar estilo visual da planilha');
      Store.state.config.symbols.work = document.getElementById('cfgSymWork').value.trim() || 'T';
      Store.state.config.symbols.off = document.getElementById('cfgSymOff').value.trim() || 'F';
      Store.state.config.symbols.holiday = document.getElementById('cfgSymHoliday').value.trim() || 'FE';
      Store.state.config.symbols.vacation = document.getElementById('cfgSymVacation').value.trim() || 'FER';
      Store.state.config.colors.headerBg = document.getElementById('cfgColHeader').value;
      Store.state.config.colors.yellowHighlight = document.getElementById('cfgColYellow').value;
      Store.state.config.colors.weekendBg = document.getElementById('cfgColWeekend').value;
      Store.state.config.colors.scaleBadge = document.getElementById('cfgColScale').value;
      Store.commit('all');
      this.toast('Cores e siglas atualizadas!');
    });

    document.getElementById('btnExportJson').addEventListener('click', () => {
      const payload = JSON.stringify(Store.state, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `FROTA_ESCALA_BACKUP_v${CURRENT_SCHEMA_VERSION}_${Store.state.selectedYear}_${String(Store.state.selectedMonth).padStart(2, '0')}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      this.toast('Backup JSON exportado!');
    });

    document.getElementById('inputImportJson').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          if (!parsed || typeof parsed !== 'object' || (!Array.isArray(parsed.employees) && !parsed.config)) return this.toast('Arquivo JSON inválido: schema não reconhecido.', 'error');
          const incomingVersion = parsed.schemaVersion || 1;
          const ok = await this.openDialog({ title: 'Importar Backup JSON', message: `Backup detectado (schemaVersion: ${incomingVersion}, ${parsed.employees?.length || 0} funcionários). Deseja substituir os dados atuais?` });
          if (!ok) return;

          Store.recordHistory('Importar Backup JSON');
          Store.state = Store.sanitizeAndMigrate(parsed);
          Store.commit('all');
          this.toast('Backup importado e sanitizado com sucesso!');
        } catch (err) { this.toast('Erro ao processar arquivo JSON.', 'error'); }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('btnRestoreReference').addEventListener('click', async () => {
      const ok = await this.openDialog({ title: 'Carregar Modelo de Referência (Nov/2026)', message: 'Isso carregará os funcionários e blocos (Manhã, Tarde e Dupla Pegada) do modelo de referência de Novembro/2026. Confirmar?' });
      if (!ok) return;
      Store.recordHistory('Restaurar Modelo de Referência');
      Store.state = createReferenceModelState();
      Store.commit('all');
      this.toast('Modelo de referência carregado!');
    });

    document.getElementById('btnWipeAll').addEventListener('click', async () => {
      const ok = await this.openDialog({ title: 'Limpar Todos os Dados', message: 'Todos os funcionários, férias e ajustes manuais serão apagados para você começar do zero. Confirmar?' });
      if (!ok) return;
      Store.recordHistory('Limpar todos os dados');
      Store.state.employees = []; Store.state.vacations = []; Store.state.manualOverrides = {};
      Store.commit('all');
      this.toast('Dados limpos com sucesso.');
    });

    document.getElementById('btnRunTests').addEventListener('click', () => {
      const report = window.runSelfTests();
      document.getElementById('selfTestOutput').textContent = report.summaryText;
      this.toast(`Autotestes concluídos: ${report.passed}/${report.total} aprovados!`);
    });
  },

  bindGlobalKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !inInput) {
        e.preventDefault(); Store.undo();
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !inInput) ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z' && !inInput)
      ) {
        e.preventDefault(); Store.redo();
      } else if (e.key === 'Escape') {
        Store.runtime.selectedCells.clear();
        document.getElementById('cellModal').hidden = true;
        document.getElementById('employeeModal').hidden = true;
        Renderer.renderEditorGrid(Store.state);
      }
    });
  }
};

/**
 * ============================================================================
 * 8. SUÍTE DE AUTOTESTES DO MOTOR (`runSelfTests()`)
 * ============================================================================
 */
window.runSelfTests = function runSelfTests() {
  const results = [];
  const assert = (name, condition, details = '') => {
    results.push({ name, passed: Boolean(condition), details });
  };

  assert(
    '1. Fevereiro bissexto (2024=29, 2026=28)',
    ScheduleEngine.getDaysInMonth(2024, 2) === 29 && ScheduleEngine.getDaysInMonth(2026, 2) === 28
  );

  const emp12x36 = { id: 't1', ruleType: '12x36', cycleStartDate: '2026-11-01' }; // 01/Nov
  assert(
    '2. Escala 12x36 (Dia Sim / Dia Não)',
    ScheduleEngine.calculateRuleOnlyStatus(emp12x36, 2026, 11, 1) === 'T' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp12x36, 2026, 11, 2) === 'F' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp12x36, 2026, 11, 3) === 'T'
  );

  const emp24x48 = { id: 't2', ruleType: '24x48', cycleStartDate: '2026-11-01' }; // 1 Trab, 2 Folga
  assert(
    '3. Escala 24x48 (1 Dia Trab x 2 Folga)',
    ScheduleEngine.calculateRuleOnlyStatus(emp24x48, 2026, 11, 1) === 'T' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp24x48, 2026, 11, 2) === 'F' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp24x48, 2026, 11, 3) === 'F' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp24x48, 2026, 11, 4) === 'T'
  );

  const emp4x2 = { id: 't3', ruleType: '4x2', cycleStartDate: '2026-11-01', workDays: 4, offDays: 2 };
  assert(
    '4. Escala 4x2 (4 dias T + 2 dias F)',
    ScheduleEngine.calculateRuleOnlyStatus(emp4x2, 2026, 11, 4) === 'T' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp4x2, 2026, 11, 5) === 'F' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp4x2, 2026, 11, 6) === 'F' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp4x2, 2026, 11, 7) === 'T'
  );

  const emp6x1 = { id: 't4', ruleType: '6x1', cycleStartDate: '2026-11-01' };
  assert(
    '5. Ciclo 6x1 (6 dias T + 1 dia F)',
    ScheduleEngine.calculateRuleOnlyStatus(emp6x1, 2026, 11, 6) === 'T' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp6x1, 2026, 11, 7) === 'F' &&
    ScheduleEngine.calculateRuleOnlyStatus(emp6x1, 2026, 11, 8) === 'T'
  );

  const empSD1 = { id: 'sd1', ruleType: 'SD1', cycleStartDate: '2026-11-02' };
  const empSD2 = { id: 'sd2', ruleType: 'SD2', cycleStartDate: '2026-11-02' };
  const sd1Sat = ScheduleEngine.calculateRuleOnlyStatus(empSD1, 2026, 11, 7);
  const sd2Sat = ScheduleEngine.calculateRuleOnlyStatus(empSD2, 2026, 11, 7);
  const sd1Sun = ScheduleEngine.calculateRuleOnlyStatus(empSD1, 2026, 11, 8);
  const sd2Sun = ScheduleEngine.calculateRuleOnlyStatus(empSD2, 2026, 11, 8);
  assert(
    '6. S/D-1 vs S/D-2 fases opostas no Sábado e Domingo',
    sd1Sat !== sd2Sat && sd1Sun !== sd2Sun && sd1Sat !== sd1Sun
  );

  const empSD1Shifted = { id: 'sd1_s', ruleType: 'SD1', cycleStartDate: '2026-11-09' };
  const shiftedSat = ScheduleEngine.calculateRuleOnlyStatus(empSD1Shifted, 2026, 11, 7);
  assert('7. S/D-1 ancorado em cycleStartDate (efeito real da data inicial)', sd1Sat !== shiftedSat);

  const nightHours = ScheduleEngine.calculateDailyNetHours({
    entryTime: '22:00', exitTime: '06:00', breakMinutes: 60, hasSecondShift: false
  });
  assert('8. Jornada noturna cruzando meia-noite (22:00-06:00 - 1h = 7h)', nightHours === 7);

  const splitHours = ScheduleEngine.calculateDailyNetHours({
    entryTime: '05:00', exitTime: '09:00', breakMinutes: 0, hasSecondShift: true, entryTime2: '15:00', exitTime2: '19:00'
  });
  assert('9. Dupla pegada (05:00-09:00 + 15:00-19:00 = 8h)', splitHours === 8);

  const mockState = createReferenceModelState();
  const testEmp = mockState.employees[0];
  mockState.vacations.push({
    id: 'v_test', employeeId: testEmp.id, type: 'FERIAS', displayMode: 'inline_days',
    startDate: '2026-11-10', endDate: '2026-11-12', notes: ''
  });
  const cellVac = ScheduleEngine.resolveCell(mockState, testEmp, 2026, 11, 10);
  mockState.manualOverrides['2026-11'] = { [`${testEmp.id}_10`]: { status: 'T', yellow: 'default', note: 'Forçado' } };
  const cellOver = ScheduleEngine.resolveCell(mockState, testEmp, 2026, 11, 10);
  assert(
    '10. Prioridade: Override Manual > Férias > Automático',
    cellVac.status === 'FER' && cellOver.status === 'T'
  );

  const easter2026 = ScheduleEngine.getEasterDate(2026);
  const mov2026 = ScheduleEngine.getMovableHolidaysForYear(2026);
  const carnavalTuesday = mov2026.find(m => m.name === 'Terça de Carnaval');
  assert(
    '11. Feriado móvel: Páscoa 2026 = 05/04/2026 e Carnaval = 17/02/2026',
    easter2026.dateISO === '2026-04-05' && carnavalTuesday?.dateISO === '2026-02-17'
  );

  const malicious = '<script>alert("xss")</script>';
  const escaped = escapeHTML(malicious);
  assert('12. Proteção XSS (escapeHTML neutraliza tags <script>)', !escaped.includes('<script>'));

  assert(
    '13. Detecção de sobreposição de datas de férias',
    ScheduleEngine.doPeriodsOverlap('2026-11-05', '2026-11-15', '2026-11-12', '2026-11-20') === true &&
    ScheduleEngine.doPeriodsOverlap('2026-11-01', '2026-11-04', '2026-11-05', '2026-11-10') === false
  );

  const empDec = { id: 't_dec', ruleType: '6x1', cycleStartDate: '2026-12-28', workDays: 6, offDays: 1 };
  const stJan2 = ScheduleEngine.calculateRuleOnlyStatus(empDec, 2027, 1, 2);
  const stJan3 = ScheduleEngine.calculateRuleOnlyStatus(empDec, 2027, 1, 3);
  assert('14. Continuidade de ciclo na virada de ano (Dez/2026 -> Jan/2027)', stJan2 === 'T' && stJan3 === 'F');

  const passed = results.filter(r => r.passed).length;
  const summaryText = results.map(r => `${r.passed ? '[PASS]' : '[FAIL]'} ${r.name}`).join('\n') + '\n\nResultado Final: ' + passed + '/' + results.length + ' testes aprovados.';

  console.table(results);
  return { total: results.length, passed, results, summaryText };
};

// Inicialização segura ao carregar o DOM
document.addEventListener('DOMContentLoaded', () => {
  Store.init();
  UI.init();
});