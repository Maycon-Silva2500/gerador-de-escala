/**
 * ============================================================================
 * SISTEMA AUTOMÁTICO DE ESCALA DE TRABALHO DO SETOR - MONITORAMENTO DA FROTA
 * ============================================================================
 * Arquitetura:
 * 1. StorageService: Persistência em localStorage, validação JSON e ganchos
 *    prontos para futura sincronização com Google Sheets / Supabase.
 * 2. ScheduleEngine: Cálculo automático de escalas (6x1, 5x2, 12x36 por hora,
 *    S/D-1 e S/D-2 com alternância de fim de semana, e ciclos personalizados),
 *    continuidade entre meses, anos bissextos, feriados e férias.
 * 3. SheetRenderer: Renderização da tabela fiel à planilha de referência
 *    e exportação de alta resolução (html2canvas + Fallback Nativo Canvas 2D).
 * ============================================================================
 */

const STORAGE_KEY = 'MONITORAMENTO_FROTA_ESCALA_V1';

const MONTH_NAMES = [
  'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'
];

const WEEKDAY_LETTERS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

/**
 * Feriados nacionais fixos brasileiros (Mês 1..12 -> array de dias)
 */
const DEFAULT_NATIONAL_HOLIDAYS = {
  1: [1],
  4: [21, 23], // Tiradentes + São Jorge (RJ)
  5: [1],
  9: [7],
  10: [12],
  11: [2, 15, 20], // Finados, Proclamação da República, Consciência Negra
  12: [25]
};

/**
 * Gera o estado inicial baseado na planilha de referência (Novembro 2026)
 * Permite ao usuário editar tudo ou limpar para começar do zero.
 */
function getInitialReferenceState() {
  return {
    selectedMonth: 11, // Novembro
    selectedYear: 2026,
    sortOrder: 'custom',
    searchQuery: '',
    config: {
      sectorTitle: 'MONITORAMENTO DA FROTA',
      leftBadge: 'EFETIVO',
      customSubtitle: '',
      minCoverage: 4,
      periodStartDay: 1,
      periodEndDay: 0, // 0 = automático até o último dia do mês
      showWorkSymbol: false, // Na planilha original, dias trabalhados ficam em branco
      showWeekdayRow: false,
      highlightAllFolgasYellow: false, // Destaca feriados em amarelo como na imagem (ou todas as folgas se ativado)
      repeatHeaderPerBlock: true,
      symbols: {
        work: 'T',
        off: 'F',
        holiday: 'FE',
        vacation: 'FER',
        leave: 'AF'
      },
      colors: {
        headerBg: '#757575',
        yellowHighlight: '#ffff00',
        weekendBg: '#d9d9d9',
        scaleBadge: '#5b9bd5'
      },
      // Feriados configurados por chave "YYYY-MM"
      holidaysByMonth: {
        '2026-11': [2, 20] // Dias 2 e 20 em amarelo na planilha de referência
      }
    },
    groups: [
      { id: 'grp_manha', name: 'Turno da Manhã (05:00 às 14:00)', order: 1, repeatHeader: false, spacerBefore: false },
      { id: 'grp_inter', name: 'Turno Dupla Pegada (05:00-09:00 / 15:00-19:00)', order: 2, repeatHeader: false, spacerBefore: true },
      { id: 'grp_tarde', name: 'Turno da Tarde / Noite (13:00 / 14:00 às 23:00)', order: 3, repeatHeader: true, spacerBefore: true }
    ],
    employees: [
      {
        id: 'emp_1',
        name: 'RODNEY GUSTAVO',
        matricula: '33854',
        entryTime: '05:00',
        exitTime: '14:00',
        breakMinutes: 60,
        hasSecondShift: false,
        entryTime2: '',
        exitTime2: '',
        groupId: 'grp_manha',
        scaleLabel: 'S/D-2',
        scaleColor: '#5b9bd5',
        ruleType: 'SD2',
        cycleStartDate: '2026-11-02',
        workDays: 6,
        offDays: 1,
        status: 'ativo',
        notes: 'Turno manhã'
      },
      {
        id: 'emp_2',
        name: 'TIAGO PEDRO',
        matricula: '32992',
        entryTime: '05:00',
        exitTime: '14:00',
        breakMinutes: 60,
        hasSecondShift: false,
        entryTime2: '',
        exitTime2: '',
        groupId: 'grp_manha',
        scaleLabel: 'S/D-1',
        scaleColor: '#5b9bd5',
        ruleType: 'SD1',
        cycleStartDate: '2026-11-01',
        workDays: 6,
        offDays: 1,
        status: 'ativo',
        notes: 'Turno manhã'
      },
      {
        id: 'emp_3',
        name: 'FABIO BARBOSA',
        matricula: '32067',
        entryTime: '05:00',
        exitTime: '14:00',
        breakMinutes: 60,
        hasSecondShift: false,
        entryTime2: '',
        exitTime2: '',
        groupId: 'grp_manha',
        scaleLabel: 'S/D-2',
        scaleColor: '#5b9bd5',
        ruleType: 'SD2',
        cycleStartDate: '2026-11-01',
        workDays: 6,
        offDays: 1,
        status: 'ativo',
        notes: 'Turno manhã'
      },
      {
        id: 'emp_4',
        name: 'MATHEUS ARRUDA',
        matricula: '39326',
        entryTime: '05:00',
        exitTime: '09:00',
        breakMinutes: 0,
        hasSecondShift: true,
        entryTime2: '15:00',
        exitTime2: '19:00',
        groupId: 'grp_inter',
        scaleLabel: 'S/D-1',
        scaleColor: '#5b9bd5',
        ruleType: '5x2',
        cycleStartDate: '2026-11-02',
        workDays: 5,
        offDays: 2,
        status: 'ativo',
        notes: 'Dupla pegada (05:00-09:00 e 15:00-19:00)'
      },
      {
        id: 'emp_5',
        name: 'RODRIGO SANTOS',
        matricula: '40865',
        entryTime: '14:00',
        exitTime: '23:00',
        breakMinutes: 60,
        hasSecondShift: false,
        entryTime2: '',
        exitTime2: '',
        groupId: 'grp_tarde',
        scaleLabel: 'S/D-1',
        scaleColor: '#5b9bd5',
        ruleType: 'SD1',
        cycleStartDate: '2026-11-02',
        workDays: 6,
        offDays: 1,
        status: 'ativo',
        notes: 'Turno tarde/noite'
      },
      {
        id: 'emp_6',
        name: 'MAYCON ALEXANDRE',
        matricula: '42617',
        entryTime: '14:00',
        exitTime: '23:00',
        breakMinutes: 60,
        hasSecondShift: false,
        entryTime2: '',
        exitTime2: '',
        groupId: 'grp_tarde',
        scaleLabel: 'S/D-2',
        scaleColor: '#5b9bd5',
        ruleType: 'SD2',
        cycleStartDate: '2026-11-01',
        workDays: 6,
        offDays: 1,
        status: 'ativo',
        notes: 'Turno tarde/noite'
      },
      {
        id: 'emp_7',
        name: 'GABRIEL QUEIROZ',
        matricula: '42724',
        entryTime: '13:00',
        exitTime: '21:20',
        breakMinutes: 60,
        hasSecondShift: false,
        entryTime2: '',
        exitTime2: '',
        groupId: 'grp_tarde',
        scaleLabel: 'S/D-1',
        scaleColor: '#5b9bd5',
        ruleType: 'SD2',
        cycleStartDate: '2026-11-02',
        workDays: 6,
        offDays: 1,
        status: 'ativo',
        notes: 'Turno tarde/noite'
      },
      {
        id: 'emp_8',
        name: 'ALAN BRITO',
        matricula: '37750',
        entryTime: '',
        exitTime: '',
        breakMinutes: 60,
        hasSecondShift: false,
        entryTime2: '',
        exitTime2: '',
        groupId: 'grp_tarde',
        scaleLabel: 'S/D-2',
        scaleColor: '#5b9bd5',
        ruleType: 'SD2',
        cycleStartDate: '2026-11-01',
        workDays: 6,
        offDays: 1,
        status: 'ferias',
        notes: 'Férias em Novembro/2026'
      }
    ],
    vacations: [
      {
        id: 'vac_1',
        employeeId: 'emp_8',
        type: 'FERIAS',
        displayMode: 'footer_bar',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        notes: 'Férias programadas Novembro 2026'
      }
    ],
    // Ajustes específicos de feriados/folgas de Novembro/2026 para espelhar 100% a planilha de referência
    manualOverrides: {
      '2026-11': {
        'emp_1_20': { status: 'F', yellow: 'default', note: 'Folga feriado 20/11' },
        'emp_2_2':  { status: 'F', yellow: 'default', note: 'Folga feriado 02/11' },
        'emp_3_7':  { status: 'F', yellow: 'default', note: 'Folga sábado 07/11' },
        'emp_3_8':  { status: 'T', yellow: 'default', note: 'Trabalho domingo 08/11' },
        'emp_3_20': { status: 'F', yellow: 'default', note: 'Folga feriado 20/11' },
        'emp_4_1':  { status: 'F', yellow: 'default', note: 'Folga domingo' },
        'emp_4_2':  { status: 'F', yellow: 'default', note: 'Folga feriado 02/11' },
        'emp_4_20': { status: 'F', yellow: 'default', note: 'Folga feriado 20/11' },
        'emp_5_1':  { status: 'T', yellow: 'default', note: 'Trabalho domingo 01/11' },
        'emp_5_20': { status: 'F', yellow: 'default', note: 'Folga feriado 20/11' },
        'emp_5_21': { status: 'F', yellow: 'default', note: 'Folga sábado 21/11' },
        'emp_5_22': { status: 'T', yellow: 'default', note: 'Trabalho domingo 22/11' },
        'emp_6_1':  { status: 'F', yellow: 'default', note: 'Folga domingo 01/11' },
        'emp_6_2':  { status: 'F', yellow: 'default', note: 'Folga feriado 02/11' },
        'emp_6_7':  { status: 'F', yellow: 'default', note: 'Folga sábado 07/11' },
        'emp_6_8':  { status: 'T', yellow: 'default', note: 'Trabalho domingo 08/11' },
        'emp_6_21': { status: 'T', yellow: 'default', note: 'Trabalho sábado 21/11' },
        'emp_6_22': { status: 'F', yellow: 'default', note: 'Folga domingo 22/11' },
        'emp_7_20': { status: 'F', yellow: 'default', note: 'Folga feriado 20/11' }
      }
    },
    undoStack: []
  };
}

/**
 * ============================================================================
 * 1. CAMADA DE PERSISTÊNCIA (StorageService)
 * ============================================================================
 */
const StorageService = {
  loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const initial = getInitialReferenceState();
        this.saveState(initial);
        return initial;
      }
      const parsed = JSON.parse(raw);
      return this.validateAndMergeState(parsed);
    } catch (err) {
      console.error('Erro ao ler localStorage, usando estado padrão:', err);
      return getInitialReferenceState();
    }
  },

  saveState(stateToSave) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
      // Gancho preparado para futura integração com Google Sheets / Supabase:
      // if (window.CloudSyncAdapter) { window.CloudSyncAdapter.push(stateToSave); }
    } catch (err) {
      console.error('Erro ao salvar no localStorage:', err);
      alert('Atenção: Não foi possível salvar no armazenamento local do navegador.');
    }
  },

  validateAndMergeState(data) {
    const def = getInitialReferenceState();
    if (!data || typeof data !== 'object') return def;
    return {
      selectedMonth: Number(data.selectedMonth) || def.selectedMonth,
      selectedYear: Number(data.selectedYear) || def.selectedYear,
      sortOrder: data.sortOrder || 'custom',
      searchQuery: data.searchQuery || '',
      config: {
        ...def.config,
        ...(data.config || {}),
        symbols: { ...def.config.symbols, ...(data.config?.symbols || {}) },
        colors: { ...def.config.colors, ...(data.config?.colors || {}) },
        holidaysByMonth: { ...def.config.holidaysByMonth, ...(data.config?.holidaysByMonth || {}) }
      },
      groups: Array.isArray(data.groups) && data.groups.length > 0 ? data.groups : def.groups,
      employees: Array.isArray(data.employees) ? data.employees : def.employees,
      vacations: Array.isArray(data.vacations) ? data.vacations : def.vacations,
      manualOverrides: data.manualOverrides && typeof data.manualOverrides === 'object' ? data.manualOverrides : {},
      undoStack: Array.isArray(data.undoStack) ? data.undoStack.slice(-30) : []
    };
  }
};

let appState = StorageService.loadState();
let lastGeneratedDataUrl = null;

/**
 * ============================================================================
 * 2. MOTOR DE CÁLCULO DE DATAS, CICLOS E HORAS (ScheduleEngine)
 * ============================================================================
 */
const ScheduleEngine = {
  /**
   * Retorna a quantidade exata de dias do mês, tratando fevereiro em anos bissextos.
   */
  getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  },

  /**
   * Formata chave "YYYY-MM"
   */
  getMonthKey(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
  },

  /**
   * Formata data "YYYY-MM-DD"
   */
  formatDateISO(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  },

  /**
   * Converte string "YYYY-MM-DD" para número inteiro de dias UTC desde 1970-01-01
   * (Garante cálculo exato entre meses sem interferência de horário de verão/fuso)
   */
  dateToEpochDays(dateStr) {
    const parts = (dateStr || '2026-11-01').split('-').map(Number);
    return Math.floor(Date.UTC(parts[0], (parts[1] || 1) - 1, parts[2] || 1) / 86400000);
  },

  /**
   * Retorna os feriados configurados para o mês/ano ou sugere os nacionais
   */
  getHolidaysForMonth(year, month) {
    const key = this.getMonthKey(year, month);
    if (Array.isArray(appState.config.holidaysByMonth[key])) {
      return appState.config.holidaysByMonth[key];
    }
    return DEFAULT_NATIONAL_HOLIDAYS[month] || [];
  },

  /**
   * Calcula a carga horária diária líquida de um funcionário em horas decimais,
   * tratando turnos que atravessam a meia-noite (ex: 22:00 às 06:00) e dupla pegada.
   */
  calculateDailyNetHours(emp) {
    const calcSpan = (startStr, endStr) => {
      if (!startStr || !endStr) return 0;
      const [sh, sm] = startStr.split(':').map(Number);
      const [eh, em] = endStr.split(':').map(Number);
      if (isNaN(sh) || isNaN(eh)) return 0;
      const startMinutes = sh * 60 + (sm || 0);
      let endMinutes = eh * 60 + (em || 0);
      // Tratamento para turnos que atravessam a meia-noite
      if (endMinutes <= startMinutes) {
        endMinutes += 24 * 60;
      }
      return endMinutes - startMinutes;
    };

    let totalMinutes = calcSpan(emp.entryTime, emp.exitTime);
    if (emp.hasSecondShift && emp.entryTime2 && emp.exitTime2) {
      totalMinutes += calcSpan(emp.entryTime2, emp.exitTime2);
    }

    const breakMins = Number(emp.breakMinutes) || 0;
    const netMinutes = Math.max(0, totalMinutes - breakMins);
    return netMinutes / 60;
  },

  /**
   * Verifica se o funcionário possui férias ou afastamento cadastrado em uma data específica
   */
  getVacationForEmployeeOnDate(empId, dateISO) {
    return appState.vacations.find(v => {
      if (v.employeeId !== empId) return false;
      return dateISO >= v.startDate && dateISO <= v.endDate;
    }) || null;
  },

  /**
   * Verifica se o funcionário deve ser exibido na seção inferior "FÉRIAS" no mês selecionado
   */
  isEmployeeInFooterVacationSection(emp, year, month) {
    if (emp.status === 'ferias') return true;
    const daysInMonth = this.getDaysInMonth(year, month);
    const monthStart = this.formatDateISO(year, month, 1);
    const monthEnd = this.formatDateISO(year, month, daysInMonth);

    return appState.vacations.some(v => {
      if (v.employeeId !== emp.id) return false;
      if (v.type !== 'FERIAS') return false;
      if (v.displayMode !== 'footer_bar' && v.displayMode !== 'both') return false;
      return v.startDate <= monthEnd && v.endDate >= monthStart;
    });
  },

  /**
   * Calcula automaticamente o status de um dia (sem considerar o override manual)
   * Retorna: 'T' (Trabalho), 'F' (Folga), 'FER' (Férias inline), 'AF' (Afastamento)
   */
  calculateAutomaticDayStatus(emp, year, month, day) {
    const dateISO = this.formatDateISO(year, month, day);

    // 1. Verifica Férias / Afastamentos cadastrados no módulo de Férias (modo inline)
    const vac = this.getVacationForEmployeeOnDate(emp.id, dateISO);
    if (vac) {
      if (vac.type === 'FERIAS' && (vac.displayMode === 'inline_days' || vac.displayMode === 'both')) {
        return 'FER';
      }
      if (vac.type !== 'FERIAS') {
        return 'AF';
      }
    }

    if (emp.status === 'afastado') {
      return 'AF';
    }

    const targetEpochDay = this.dateToEpochDays(dateISO);
    const startEpochDay = this.dateToEpochDays(emp.cycleStartDate || '2026-11-01');
    const diffDays = targetEpochDay - startEpochDay;

    const jsDate = new Date(year, month - 1, day);
    const dayOfWeek = jsDate.getDay(); // 0 = Dom, 6 = Sáb

    // 2. Regra 12x36 (baseada em horas reais de início e término do turno)
    if (emp.ruleType === '12x36') {
      const [sh, sm] = (emp.entryTime || '06:00').split(':').map(Number);
      const startHourFraction = ((sh || 0) * 60 + (sm || 0)) / 60;
      // Cada ciclo completo de 12h trabalho + 36h descanso = 48 horas (2 dias exatos a partir do timestamp inicial)
      const startTimestampHours = startEpochDay * 24 + startHourFraction;
      const targetShiftTimestampHours = targetEpochDay * 24 + startHourFraction;
      const elapsedHours = targetShiftTimestampHours - startTimestampHours;
      const modHours = ((elapsedHours % 48) + 48) % 48;
      return modHours < 12 ? 'T' : 'F';
    }

    // 3. Regra S/D-1 e S/D-2 (Revezamento de Sábado e Domingo entre semanas)
    if (emp.ruleType === 'SD1' || emp.ruleType === 'SD2') {
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        return 'T'; // Segunda a Sexta trabalha normalmente
      }
      // Índice da semana contínua desde o início da época (alinhado na segunda-feira)
      const weekIndex = Math.floor((targetEpochDay + 3) / 7);
      const isEvenWeek = ((weekIndex % 2) + 2) % 2 === 0;

      if (emp.ruleType === 'SD1') {
        // S/D-1 alterna folga entre Sábado numa semana e Domingo na outra
        if (isEvenWeek) {
          return dayOfWeek === 6 ? 'F' : 'T';
        } else {
          return dayOfWeek === 0 ? 'F' : 'T';
        }
      } else {
        // S/D-2 faz o par oposto ao S/D-1 para garantir cobertura no fim de semana
        if (isEvenWeek) {
          return dayOfWeek === 0 ? 'F' : 'T';
        } else {
          return dayOfWeek === 6 ? 'F' : 'T';
        }
      }
    }

    // 4. Regras de Ciclo Contínuo (6x1, 5x2, Personalizada)
    let workDays = Number(emp.workDays) || 6;
    let offDays = Number(emp.offDays) || 1;
    if (emp.ruleType === '6x1') { workDays = 6; offDays = 1; }
    if (emp.ruleType === '5x2') { workDays = 5; offDays = 2; }

    const cycleLength = Math.max(1, workDays + offDays);
    const posInCycle = ((diffDays % cycleLength) + cycleLength) % cycleLength;

    return posInCycle < workDays ? 'T' : 'F';
  },

  /**
   * Obtém o estado final de uma célula (combinando cálculo automático + edição manual)
   */
  getCellData(emp, year, month, day) {
    const monthKey = this.getMonthKey(year, month);
    const cellKey = `${emp.id}_${day}`;
    const manual = appState.manualOverrides[monthKey]?.[cellKey] || null;
    const autoStatus = this.calculateAutomaticDayStatus(emp, year, month, day);

    const status = manual && manual.status && manual.status !== 'AUTO' ? manual.status : autoStatus;
    const isManual = Boolean(manual && manual.status && manual.status !== 'AUTO' && manual.status !== autoStatus);

    const jsDate = new Date(year, month - 1, day);
    const dayOfWeek = jsDate.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const holidays = this.getHolidaysForMonth(year, month);
    const isHolidayCol = holidays.includes(day);

    // Determina se a célula recebe destaque amarelo
    let isYellow = false;
    if (manual && manual.yellow === 'yes') {
      isYellow = true;
    } else if (manual && manual.yellow === 'no') {
      isYellow = false;
    } else {
      if (isHolidayCol) isYellow = true;
      if (appState.config.highlightAllFolgasYellow && (status === 'F' || status === 'FE')) {
        isYellow = true;
      }
    }

    // Determina o texto exibido na célula
    const sym = appState.config.symbols;
    let displayText = '';
    if (status === 'T') {
      displayText = appState.config.showWorkSymbol ? (sym.work || 'T') : '';
    } else if (status === 'F') {
      displayText = sym.off || 'F';
    } else if (status === 'FE') {
      displayText = sym.holiday || 'FE';
    } else if (status === 'FER') {
      displayText = sym.vacation || 'FER';
    } else if (status === 'AF') {
      displayText = sym.leave || 'AF';
    } else {
      displayText = status;
    }

    return {
      status,
      autoStatus,
      isManual,
      isWeekend,
      isHolidayCol,
      isYellow,
      displayText,
      note: manual?.note || ''
    };
  },

  /**
   * Gera a lista de dias visíveis do período selecionado no mês
   */
  getActiveDaysList(year, month) {
    const totalDays = this.getDaysInMonth(year, month);
    const startDay = Math.max(1, Math.min(totalDays, Number(appState.config.periodStartDay) || 1));
    const rawEnd = Number(appState.config.periodEndDay) || 0;
    const endDay = rawEnd > 0 ? Math.max(startDay, Math.min(totalDays, rawEnd)) : totalDays;

    const days = [];
    for (let d = startDay; d <= endDay; d++) {
      days.push(d);
    }
    return days;
  },

  /**
   * Calcula estatísticas completas do mês (por funcionário, por dia e alertas de validação)
   */
  computeMonthAnalytics(year, month) {
    const days = this.getActiveDaysList(year, month);
    const employeeStats = {};
    const dailyStats = {};
    const alerts = [];

    days.forEach(d => {
      dailyStats[d] = { working: 0, off: 0, vacationOrLeave: 0 };
    });

    const activeEmployees = [];
    const vacationFooterEmployees = [];

    appState.employees.forEach(emp => {
      const inVacationBar = this.isEmployeeInFooterVacationSection(emp, year, month);
      if (inVacationBar) {
        vacationFooterEmployees.push(emp);
      } else {
        activeEmployees.push(emp);
      }

      const netDailyHours = this.calculateDailyNetHours(emp);
      let workCount = 0;
      let offCount = 0;
      let otherCount = 0;
      let manualCount = 0;
      let currentWorkStreak = 0;
      let maxWorkStreak = 0;

      if (!emp.matricula || !emp.name) {
        alerts.push({
          level: 'danger',
          text: `Cadastro incompleto: Funcionário "${emp.name || 'Sem nome'}" está sem matrícula ou nome.`
        });
      }

      days.forEach(d => {
        if (inVacationBar) {
          otherCount++;
          dailyStats[d].vacationOrLeave++;
          return;
        }

        const cell = this.getCellData(emp, year, month, d);
        if (cell.isManual) manualCount++;

        if (cell.status === 'T') {
          workCount++;
          dailyStats[d].working++;
          currentWorkStreak++;
          if (currentWorkStreak > maxWorkStreak) maxWorkStreak = currentWorkStreak;
        } else if (cell.status === 'F' || cell.status === 'FE') {
          offCount++;
          dailyStats[d].off++;
          currentWorkStreak = 0;
        } else {
          otherCount++;
          dailyStats[d].vacationOrLeave++;
          currentWorkStreak = 0;
        }
      });

      if (!inVacationBar && maxWorkStreak > 6) {
        alerts.push({
          level: 'warn',
          text: `Conferência de Ciclo: ${emp.name} (${emp.matricula}) possui ${maxWorkStreak} dias consecutivos de trabalho no período.`
        });
      }

      employeeStats[emp.id] = {
        emp,
        inVacationBar,
        netDailyHours,
        workCount,
        offCount,
        otherCount,
        manualCount,
        totalHours: workCount * netDailyHours
      };
    });

    // Verifica cobertura mínima diária
    const minCov = Number(appState.config.minCoverage) || 0;
    const lowCoverageDays = [];
    days.forEach(d => {
      if (dailyStats[d].working < minCov) {
        lowCoverageDays.push(d);
      }
    });

    if (lowCoverageDays.length > 0) {
      alerts.push({
        level: 'danger',
        text: `Cobertura abaixo do mínimo (${minCov} funcionários) nos dias: ${lowCoverageDays.join(', ')}.`
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        level: 'ok',
        text: 'Nenhum conflito ou falha de cobertura detectado para o período selecionado.'
      });
    }

    return {
      days,
      totalEmployees: appState.employees.length,
      activeCount: activeEmployees.length,
      vacationCount: vacationFooterEmployees.length,
      employeeStats,
      dailyStats,
      alerts
    };
  }
};

/**
 * ============================================================================
 * 3. RENDERIZADOR DA PLANILHA OFICIAL (SheetRenderer)
 * ============================================================================
 */
const SheetRenderer = {
  /**
   * Atualiza variáveis CSS com as cores escolhidas pelo usuário
   */
  applyThemeVariables() {
    const root = document.documentElement;
    const c = appState.config.colors;
    root.style.setProperty('--sheet-header-bg', c.headerBg || '#757575');
    root.style.setProperty('--sheet-yellow', c.yellowHighlight || '#ffff00');
    root.style.setProperty('--sheet-weekend-bg', c.weekendBg || '#d9d9d9');
    root.style.setProperty('--sheet-scale-badge', c.scaleBadge || '#5b9bd5');
  },

  /**
   * Filtra e ordena funcionários conforme busca e seletor de ordenação
   */
  getFilteredAndSortedEmployees(employeesList) {
    const q = (appState.searchQuery || '').trim().toLowerCase();
    let list = employeesList.filter(emp => {
      if (!q) return true;
      return (
        (emp.name || '').toLowerCase().includes(q) ||
        (emp.matricula || '').toLowerCase().includes(q) ||
        (emp.scaleLabel || '').toLowerCase().includes(q)
      );
    });

    const sortOrder = appState.sortOrder || 'custom';
    if (sortOrder === 'name') {
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortOrder === 'matricula') {
      list.sort((a, b) => (a.matricula || '').localeCompare(b.matricula || ''));
    } else if (sortOrder === 'entryTime') {
      list.sort((a, b) => (a.entryTime || '99:99').localeCompare(b.entryTime || '99:99'));
    }
    return list;
  },

  /**
   * Constrói o HTML da tabela de escala (fiel à imagem de referência)
   * @param {Object} options { interactive: boolean, customDaysArray: number[] | null }
   */
  buildScheduleTableHTML(options = { interactive: true, customDaysArray: null }) {
    this.applyThemeVariables();

    const year = appState.selectedYear;
    const month = appState.selectedMonth;
    const days = options.customDaysArray || ScheduleEngine.getActiveDaysList(year, month);
    const totalCols = 5 + days.length;

    const sectorTitle = appState.config.sectorTitle || 'MONITORAMENTO DA FROTA';
    const leftBadge = appState.config.leftBadge || 'EFETIVO';
    const subtitle = (appState.config.customSubtitle || '').trim() ||
      `ESCALA DE ${MONTH_NAMES[month - 1]} ${year}`;

    // Constrói colgroup para garantir alinhamento idêntico em todas as colunas
    let colgroupHTML = `
      <colgroup>
        <col class="col-peg">
        <col class="col-larg">
        <col class="col-mat">
        <col class="col-name">
        <col class="col-scale">
        ${days.map(() => `<col class="col-day">`).join('')}
      </colgroup>
    `;

    // Função auxiliar para gerar a linha de cabeçalho das colunas (Peg., Larg., Matrícula...)
    const buildColumnHeadersRow = () => {
      let html = `
        <tr class="row-col-headers">
          <th>Peg.</th>
          <th>Larg.</th>
          <th>Matrícula</th>
          <th>Assistentes:</th>
          <th>Escala</th>
          ${days.map(d => `<th>${d}</th>`).join('')}
        </tr>
      `;
      if (appState.config.showWeekdayRow) {
        html += `
          <tr class="row-weekdays">
            <th colspan="5">Dia da Semana</th>
            ${days.map(d => {
              const wd = new Date(year, month - 1, d).getDay();
              return `<th>${WEEKDAY_LETTERS[wd]}</th>`;
            }).join('')}
          </tr>
        `;
      }
      return html;
    };

    // Separa funcionários ativos (nos blocos) e funcionários na faixa de FÉRIAS
    const allFiltered = this.getFilteredAndSortedEmployees(appState.employees);
    const activeEmployees = [];
    const vacationFooterEmployees = [];

    allFiltered.forEach(emp => {
      if (ScheduleEngine.isEmployeeInFooterVacationSection(emp, year, month)) {
        vacationFooterEmployees.push(emp);
      } else {
        activeEmployees.push(emp);
      }
    });

    // Ordena os grupos/blocos
    const sortedGroups = [...appState.groups].sort((a, b) => (a.order || 0) - (b.order || 0));

    let bodyRowsHTML = '';
    let renderedBlocksCount = 0;

    sortedGroups.forEach(group => {
      const groupEmps = activeEmployees.filter(e => e.groupId === group.id);
      if (groupEmps.length === 0) return;

      // Se não for o primeiro bloco, verifica espaçador e repetição de cabeçalho
      if (renderedBlocksCount > 0) {
        if (group.spacerBefore !== false) {
          bodyRowsHTML += `
            <tr class="row-block-spacer">
              <td colspan="${totalCols}"></td>
            </tr>
          `;
        }
        if (appState.config.repeatHeaderPerBlock && group.repeatHeader) {
          bodyRowsHTML += buildColumnHeadersRow();
        }
      }

      // Renderiza cada funcionário do bloco
      groupEmps.forEach(emp => {
        const dayCellsHTML = days.map(d => {
          const cell = ScheduleEngine.getCellData(emp, year, month, d);
          const classes = ['cell-day'];
          if (cell.isWeekend) classes.push('is-weekend');
          if (cell.isYellow) classes.push('is-yellow');
          if (cell.status === 'FER') classes.push('is-vacation');
          if (cell.status === 'AF') classes.push('is-leave');
          if (cell.isManual) classes.push('is-manual');

          const titleAttr = cell.note
            ? `${emp.name} - Dia ${d}: ${cell.status} (${cell.note})`
            : `${emp.name} - Dia ${d}`;

          const dataAttrs = options.interactive
            ? `data-emp-id="${emp.id}" data-day="${d}" title="${titleAttr}"`
            : '';

          return `<td class="${classes.join(' ')}" ${dataAttrs}>${cell.displayText}</td>`;
        }).join('');

        const scaleBgStyle = emp.scaleColor
          ? `style="background-color: ${emp.scaleColor};"`
          : '';

        bodyRowsHTML += `
          <tr class="row-employee">
            <td class="cell-time">${emp.entryTime || ''}</td>
            <td class="cell-time">${emp.exitTime || ''}</td>
            <td class="cell-mat">${emp.matricula || ''}</td>
            <td class="cell-name">${emp.name || ''}</td>
            <td class="cell-scale-badge" ${scaleBgStyle}>${emp.scaleLabel || ''}</td>
            ${dayCellsHTML}
          </tr>
        `;

        // Se o funcionário tiver Dupla Pegada (2º horário no mesmo dia, como MATHEUS ARRUDA na imagem)
        if (emp.hasSecondShift && (emp.entryTime2 || emp.exitTime2)) {
          bodyRowsHTML += `
            <tr class="row-second-shift">
              <td class="cell-time">${emp.entryTime2 || ''}</td>
              <td class="cell-time">${emp.exitTime2 || ''}</td>
              <td colspan="${totalCols - 2}" style="background:#f2f2f2;"></td>
            </tr>
          `;
        }
      });

      renderedBlocksCount++;
    });

    // Funcionários sem grupo vinculado (caso algum grupo tenha sido removido)
    const orphanEmps = activeEmployees.filter(e => !sortedGroups.some(g => g.id === e.groupId));
    orphanEmps.forEach(emp => {
      const dayCellsHTML = days.map(d => {
        const cell = ScheduleEngine.getCellData(emp, year, month, d);
        const classes = ['cell-day'];
        if (cell.isWeekend) classes.push('is-weekend');
        if (cell.isYellow) classes.push('is-yellow');
        if (cell.isManual) classes.push('is-manual');
        const dataAttrs = options.interactive ? `data-emp-id="${emp.id}" data-day="${d}"` : '';
        return `<td class="${classes.join(' ')}" ${dataAttrs}>${cell.displayText}</td>`;
      }).join('');

      bodyRowsHTML += `
        <tr class="row-employee">
          <td class="cell-time">${emp.entryTime || ''}</td>
          <td class="cell-time">${emp.exitTime || ''}</td>
          <td class="cell-mat">${emp.matricula || ''}</td>
          <td class="cell-name">${emp.name || ''}</td>
          <td class="cell-scale-badge">${emp.scaleLabel || ''}</td>
          ${dayCellsHTML}
        </tr>
      `;
    });

    // Seção separada de FÉRIAS no final da planilha (Faixa cinza identificada como "FÉRIAS")
    if (vacationFooterEmployees.length > 0) {
      bodyRowsHTML += `
        <tr class="row-vacation-spacer">
          <td colspan="${totalCols}"></td>
        </tr>
      `;
      vacationFooterEmployees.forEach(emp => {
        const scaleBgStyle = emp.scaleColor
          ? `style="background-color: ${emp.scaleColor};"`
          : '';
        bodyRowsHTML += `
          <tr class="row-vacation-bar">
            <td class="cell-time"></td>
            <td class="cell-time"></td>
            <td class="cell-mat">${emp.matricula || ''}</td>
            <td class="cell-name">${emp.name || ''}</td>
            <td class="cell-scale-badge" ${scaleBgStyle}>${emp.scaleLabel || ''}</td>
            <td colspan="${days.length}" class="vacation-merged-banner">FÉRIAS</td>
          </tr>
        `;
      });
    }

    const modeClass = options.interactive ? 'interactive-mode' : 'print-mode';

    return `
      <div class="official-sheet-paper ${modeClass}">
        <table class="fleet-schedule-table">
          ${colgroupHTML}
          <thead>
            <tr class="row-main-title">
              <th colspan="${totalCols}">${sectorTitle}</th>
            </tr>
            <tr class="row-subtitle">
              <th colspan="3" class="th-efetivo">${leftBadge}</th>
              <th colspan="${totalCols - 3}" class="th-month-title">${subtitle}</th>
            </tr>
            ${buildColumnHeadersRow()}
          </thead>
          <tbody>
            ${bodyRowsHTML}
          </tbody>
        </table>
      </div>
    `;
  },

  /**
   * Motor Nativo Canvas 2D (Fallback caso html2canvas CDN não esteja disponível offline)
   * Desenha a tabela completa diretamente em um elemento <canvas> de alta resolução.
   */
  renderNativeCanvasFallback(scaleFactor = 2) {
    const year = appState.selectedYear;
    const month = appState.selectedMonth;
    const days = ScheduleEngine.getActiveDaysList(year, month);
    const colWidths = [48, 48, 66, 185, 54, ...days.map(() => 26)];
    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 24;

    const allFiltered = this.getFilteredAndSortedEmployees(appState.employees);
    const activeEmps = allFiltered.filter(e => !ScheduleEngine.isEmployeeInFooterVacationSection(e, year, month));
    const vacEmps = allFiltered.filter(e => ScheduleEngine.isEmployeeInFooterVacationSection(e, year, month));

    const rowH = 24;
    const estimatedRows = 6 + activeEmps.length * 2 + vacEmps.length + appState.groups.length * 2;
    const totalHeight = estimatedRows * rowH + 40;

    const canvas = document.createElement('canvas');
    canvas.width = totalWidth * scaleFactor;
    canvas.height = totalHeight * scaleFactor;
    const ctx = canvas.getContext('2d');
    ctx.scale(scaleFactor, scaleFactor);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    let y = 12;
    const xStart = 12;
    const tableW = totalWidth - 24;

    const drawCell = (x, cy, w, h, bg, text, font = 'bold 11px Arial', color = '#000000') => {
      ctx.fillStyle = bg;
      ctx.fillRect(x, cy, w, h);
      ctx.strokeStyle = '#404040';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, cy, w, h);
      if (text !== undefined && text !== null && text !== '') {
        ctx.fillStyle = color;
        ctx.font = font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(text), x + w / 2, cy + h / 2);
      }
    };

    // 1. Título Principal
    drawCell(xStart, y, tableW, 32, '#ffffff', appState.config.sectorTitle || 'MONITORAMENTO DA FROTA', 'bold 18px Arial', '#000000');
    y += 32;

    // 2. Subtítulo
    const wEfetivo = colWidths[0] + colWidths[1] + colWidths[2];
    const subtitle = (appState.config.customSubtitle || '').trim() || `ESCALA DE ${MONTH_NAMES[month - 1]} ${year}`;
    drawCell(xStart, y, wEfetivo, 28, appState.config.colors.headerBg, appState.config.leftBadge || 'EFETIVO', 'bold 12px Arial', '#ffffff');
    drawCell(xStart + wEfetivo, y, tableW - wEfetivo, 28, appState.config.colors.headerBg, subtitle, 'bold 16px Arial', '#ffffff');
    y += 28;

    const drawHeaders = () => {
      const headers = ['Peg.', 'Larg.', 'Matrícula', 'Assistentes:', 'Escala', ...days.map(String)];
      let cx = xStart;
      headers.forEach((h, idx) => {
        drawCell(cx, y, colWidths[idx], rowH, appState.config.colors.headerBg, h, 'bold 11px Arial', '#ffffff');
        cx += colWidths[idx];
      });
      y += rowH;
    };

    drawHeaders();

    const sortedGroups = [...appState.groups].sort((a, b) => (a.order || 0) - (b.order || 0));
    let blockIdx = 0;

    sortedGroups.forEach(grp => {
      const emps = activeEmps.filter(e => e.groupId === grp.id);
      if (emps.length === 0) return;

      if (blockIdx > 0) {
        drawCell(xStart, y, tableW, rowH, '#f2f2f2', '');
        y += rowH;
        if (appState.config.repeatHeaderPerBlock && grp.repeatHeader) {
          drawHeaders();
        }
      }

      emps.forEach(emp => {
        let cx = xStart;
        drawCell(cx, y, colWidths[0], rowH, '#ffffff', emp.entryTime, '11px Arial'); cx += colWidths[0];
        drawCell(cx, y, colWidths[1], rowH, '#ffffff', emp.exitTime, '11px Arial'); cx += colWidths[1];
        drawCell(cx, y, colWidths[2], rowH, '#ffffff', emp.matricula, '11px Arial'); cx += colWidths[2];
        drawCell(cx, y, colWidths[3], rowH, '#ffffff', emp.name, 'bold 11px Arial'); cx += colWidths[3];
        drawCell(cx, y, colWidths[4], rowH, emp.scaleColor || appState.config.colors.scaleBadge, emp.scaleLabel, 'bold 11px Arial'); cx += colWidths[4];

        days.forEach((d, idx) => {
          const cell = ScheduleEngine.getCellData(emp, year, month, d);
          let bg = '#ffffff';
          if (cell.isWeekend) bg = appState.config.colors.weekendBg;
          if (cell.isYellow) bg = appState.config.colors.yellowHighlight;
          const w = colWidths[5 + idx];
          drawCell(cx, y, w, rowH, bg, cell.displayText, 'bold 11px Arial');
          cx += w;
        });
        y += rowH;

        if (emp.hasSecondShift && (emp.entryTime2 || emp.exitTime2)) {
          let scx = xStart;
          drawCell(scx, y, colWidths[0], rowH, '#ffffff', emp.entryTime2, '11px Arial'); scx += colWidths[0];
          drawCell(scx, y, colWidths[1], rowH, '#ffffff', emp.exitTime2, '11px Arial'); scx += colWidths[1];
          drawCell(scx, y, tableW - colWidths[0] - colWidths[1], rowH, '#f2f2f2', '');
          y += rowH;
        }
      });

      blockIdx++;
    });

    if (vacEmps.length > 0) {
      y += rowH;
      vacEmps.forEach(emp => {
        let cx = xStart;
        drawCell(cx, y, colWidths[0], rowH, '#ffffff', ''); cx += colWidths[0];
        drawCell(cx, y, colWidths[1], rowH, '#ffffff', ''); cx += colWidths[1];
        drawCell(cx, y, colWidths[2], rowH, '#ffffff', emp.matricula, '11px Arial'); cx += colWidths[2];
        drawCell(cx, y, colWidths[3], rowH, '#ffffff', emp.name, 'bold 11px Arial'); cx += colWidths[3];
        drawCell(cx, y, colWidths[4], rowH, emp.scaleColor || appState.config.colors.scaleBadge, emp.scaleLabel, 'bold 11px Arial'); cx += colWidths[4];
        const daysWidth = tableW - (cx - xStart);
        drawCell(cx, y, daysWidth, rowH, '#bfbfbf', 'FÉRIAS', 'bold 12px Arial');
        y += rowH;
      });
    }

    // Recorta o canvas na altura exata utilizada
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = totalWidth * scaleFactor;
    finalCanvas.height = (y + 14) * scaleFactor;
    const fCtx = finalCanvas.getContext('2d');
    fCtx.drawImage(canvas, 0, 0);
    return finalCanvas.toDataURL('image/png');
  },

  /**
   * Gera a imagem PNG em alta resolução a partir da área limpa de impressão
   */
  async generateHighResPNG() {
    const statusBadge = document.getElementById('exportStatusBadge');
    const previewContainer = document.getElementById('exportImagePreviewContainer');
    const scaleRes = Number(document.getElementById('exportScaleResolution')?.value) || 2;

    statusBadge.textContent = 'Renderizando imagem em alta definição...';
    statusBadge.style.background = '#fef08a';

    // Monta a tabela limpa (sem indicadores de edição nem botões) na área de staging
    const stagingEl = document.getElementById('officialPrintableSheet');
    stagingEl.innerHTML = this.buildScheduleTableHTML({ interactive: false });

    const targetPaper = stagingEl.querySelector('.official-sheet-paper');

    try {
      let dataUrl = null;
      if (typeof window.html2canvas === 'function') {
        const canvas = await window.html2canvas(targetPaper, {
          scale: scaleRes,
          backgroundColor: '#ffffff',
          useCORS: true,
          logging: false,
          width: targetPaper.scrollWidth,
          height: targetPaper.scrollHeight,
          windowWidth: targetPaper.scrollWidth + 100
        });
        dataUrl = canvas.toDataURL('image/png');
      } else {
        // Fallback nativo se estiver sem internet para carregar o CDN
        dataUrl = this.renderNativeCanvasFallback(scaleRes);
      }

      lastGeneratedDataUrl = dataUrl;
      previewContainer.innerHTML = `<img src="${dataUrl}" alt="Escala Oficial Monitoramento da Frota">`;
      statusBadge.textContent = '✅ Imagem PNG gerada com sucesso!';
      statusBadge.style.background = '#bbf7d0';
      document.getElementById('btnDownloadPng').disabled = false;
      return dataUrl;
    } catch (err) {
      console.error('Erro no html2canvas, acionando motor nativo:', err);
      const fallbackUrl = this.renderNativeCanvasFallback(scaleRes);
      lastGeneratedDataUrl = fallbackUrl;
      previewContainer.innerHTML = `<img src="${fallbackUrl}" alt="Escala Oficial Monitoramento da Frota">`;
      statusBadge.textContent = '✅ Imagem PNG gerada (Motor Nativo)!';
      statusBadge.style.background = '#bbf7d0';
      document.getElementById('btnDownloadPng').disabled = false;
      return fallbackUrl;
    }
  }
};

/**
 * ============================================================================
 * 4. CONTROLADOR DE INTERFACE E EVENTOS (UIController)
 * ============================================================================
 */
const UIController = {
  init() {
    this.populateTopSelectors();
    this.bindNavigation();
    this.bindTopbarEvents();
    this.bindSheetInteractionEvents();
    this.bindEmployeeEvents();
    this.bindConfigEvents();
    this.bindVacationEvents();
    this.bindExportEvents();
    this.bindBackupEvents();
    this.refreshAllViews();
  },

  populateTopSelectors() {
    const monthSel = document.getElementById('topMonthSelect');
    const yearInput = document.getElementById('topYearSelect');

    monthSel.innerHTML = MONTH_NAMES.map((name, idx) =>
      `<option value="${idx + 1}">${name}</option>`
    ).join('');

    monthSel.value = appState.selectedMonth;
    yearInput.value = appState.selectedYear;
  },

  switchView(viewName) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });
    this.refreshAllViews();
  },

  bindNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });

    document.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.goto));
    });

    document.getElementById('btnToggleSidebar').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
    });
  },

  bindTopbarEvents() {
    document.getElementById('topMonthSelect').addEventListener('change', (e) => {
      appState.selectedMonth = Number(e.target.value);
      StorageService.saveState(appState);
      this.refreshAllViews();
    });

    document.getElementById('topYearSelect').addEventListener('change', (e) => {
      const val = Number(e.target.value);
      if (val >= 2020 && val <= 2050) {
        appState.selectedYear = val;
        StorageService.saveState(appState);
        this.refreshAllViews();
      }
    });

    document.getElementById('globalSearchInput').addEventListener('input', (e) => {
      appState.searchQuery = e.target.value;
      this.refreshAllViews();
    });

    document.getElementById('btnUndoManual').addEventListener('click', () => {
      if (!appState.undoStack || appState.undoStack.length === 0) return;
      const lastAction = appState.undoStack.pop();
      if (lastAction) {
        const { monthKey, cellKey, previousValue } = lastAction;
        if (!appState.manualOverrides[monthKey]) appState.manualOverrides[monthKey] = {};
        if (previousValue === null || previousValue === undefined) {
          delete appState.manualOverrides[monthKey][cellKey];
        } else {
          appState.manualOverrides[monthKey][cellKey] = previousValue;
        }
        StorageService.saveState(appState);
        this.refreshAllViews();
      }
    });

    document.getElementById('btnRecalculateAll').addEventListener('click', () => {
      const monthKey = ScheduleEngine.getMonthKey(appState.selectedYear, appState.selectedMonth);
      const hasManual = appState.manualOverrides[monthKey] && Object.keys(appState.manualOverrides[monthKey]).length > 0;

      if (hasManual) {
        const resetManual = confirm(
          'A escala atual possui ajustes manuais.\n\n' +
          'Clique em "OK" para recalcular mantendo seus ajustes manuais.\n' +
          'Se desejar APAGAR os ajustes manuais e voltar 100% ao ciclo automático, use o botão "Restaurar Automático" na aba Montar Escala.'
        );
        if (!resetManual) return;
      }
      StorageService.saveState(appState);
      this.refreshAllViews();
      alert('Cálculos automáticos de ciclo e horas atualizados com sucesso!');
    });

    // Botões rápidos de "GERAR IMAGEM DA ESCALA"
    const triggerImageGenerationFlow = async () => {
      this.switchView('exportar');
      await SheetRenderer.generateHighResPNG();
    };

    document.getElementById('btnQuickGenerateImg').addEventListener('click', triggerImageGenerationFlow);
    document.getElementById('btnTopGenerateImg').addEventListener('click', triggerImageGenerationFlow);
    document.getElementById('btnDashGenerateImg').addEventListener('click', triggerImageGenerationFlow);
    document.getElementById('btnSheetGenerateImg').addEventListener('click', triggerImageGenerationFlow);
  },

  /**
   * Eventos da Tabela Interativa (Edição Manual ao clicar nas células dos dias)
   */
  bindSheetInteractionEvents() {
    document.getElementById('sheetSortSelect').addEventListener('change', (e) => {
      appState.sortOrder = e.target.value;
      StorageService.saveState(appState);
      this.refreshAllViews();
    });

    document.getElementById('chkShowWorkSymbol').addEventListener('change', (e) => {
      appState.config.showWorkSymbol = e.target.checked;
      StorageService.saveState(appState);
      this.refreshAllViews();
    });

    document.getElementById('chkShowWeekdayRow').addEventListener('change', (e) => {
      appState.config.showWeekdayRow = e.target.checked;
      StorageService.saveState(appState);
      this.refreshAllViews();
    });

    document.getElementById('btnRestoreAutoAll').addEventListener('click', () => {
      const monthKey = ScheduleEngine.getMonthKey(appState.selectedYear, appState.selectedMonth);
      const count = Object.keys(appState.manualOverrides[monthKey] || {}).length;
      if (count === 0) {
        alert('Não há ajustes manuais neste mês. A escala já está 100% no cálculo automático.');
        return;
      }
      if (confirm(`Tem certeza que deseja remover os ${count} ajustes manuais deste mês e restaurar o cálculo automático de todos os funcionários?`)) {
        delete appState.manualOverrides[monthKey];
        appState.undoStack = [];
        StorageService.saveState(appState);
        this.refreshAllViews();
      }
    });

    // Delegação de clique nas células de dias da escala
    document.getElementById('interactiveSheetContainer').addEventListener('click', (e) => {
      const cellEl = e.target.closest('td.cell-day');
      if (!cellEl) return;
      const empId = cellEl.dataset.empId;
      const day = Number(cellEl.dataset.day);
      if (!empId || !day) return;

      const quickMode = document.getElementById('quickPaintMode').value;
      if (quickMode === 'modal') {
        this.openCellEditModal(empId, day);
      } else {
        this.applyCellOverride(empId, day, quickMode);
      }
    });

    // Modal de Edição de Célula
    document.getElementById('cellStatusSelect').addEventListener('change', (e) => {
      document.getElementById('cellCustomSymbolGroup').style.display =
        e.target.value === 'CUSTOM' ? 'flex' : 'none';
    });

    document.getElementById('btnCloseCellModal').addEventListener('click', () => {
      document.getElementById('modalCellEdit').style.display = 'none';
    });
    document.getElementById('btnCancelCellModal').addEventListener('click', () => {
      document.getElementById('modalCellEdit').style.display = 'none';
    });

    document.getElementById('formCellEdit').addEventListener('submit', (e) => {
      e.preventDefault();
      const empId = document.getElementById('cellEmpId').value;
      const day = Number(document.getElementById('cellDayNumber').value);
      let status = document.getElementById('cellStatusSelect').value;
      if (status === 'CUSTOM') {
        status = (document.getElementById('cellCustomSymbol').value || 'T').trim().toUpperCase();
      }
      const yellow = document.getElementById('cellYellowHighlight').value;
      const note = document.getElementById('cellNoteInput').value.trim();

      this.saveManualCellState(empId, day, status, yellow, note);
      document.getElementById('modalCellEdit').style.display = 'none';
    });
  },

  openCellEditModal(empId, day) {
    const emp = appState.employees.find(e => e.id === empId);
    if (!emp) return;

    const year = appState.selectedYear;
    const month = appState.selectedMonth;
    const monthKey = ScheduleEngine.getMonthKey(year, month);
    const cellKey = `${empId}_${day}`;
    const existingManual = appState.manualOverrides[monthKey]?.[cellKey] || null;
    const autoStatus = ScheduleEngine.calculateAutomaticDayStatus(emp, year, month, day);

    document.getElementById('cellEmpId').value = empId;
    document.getElementById('cellDayNumber').value = day;
    document.getElementById('modalCellTitle').textContent = `Dia ${day}/${String(month).padStart(2, '0')}/${year} — ${emp.name}`;
    document.getElementById('modalCellSubtitle').textContent =
      `Ciclo Automático neste dia: ${autoStatus === 'T' ? 'Trabalho (T)' : 'Folga (F)'} | Escala: ${emp.scaleLabel}`;

    const selectEl = document.getElementById('cellStatusSelect');
    const customGroup = document.getElementById('cellCustomSymbolGroup');
    const customInput = document.getElementById('cellCustomSymbol');

    if (!existingManual) {
      selectEl.value = 'AUTO';
      customGroup.style.display = 'none';
    } else if (['AUTO', 'T', 'F', 'FE', 'FER', 'AF'].includes(existingManual.status)) {
      selectEl.value = existingManual.status;
      customGroup.style.display = 'none';
    } else {
      selectEl.value = 'CUSTOM';
      customGroup.style.display = 'flex';
      customInput.value = existingManual.status;
    }

    document.getElementById('cellYellowHighlight').value = existingManual?.yellow || 'default';
    document.getElementById('cellNoteInput').value = existingManual?.note || '';
    document.getElementById('modalCellEdit').style.display = 'flex';
  },

  applyCellOverride(empId, day, mode) {
    if (mode === 'AUTO') {
      this.saveManualCellState(empId, day, 'AUTO', 'default', '');
    } else if (mode === 'F_YELLOW') {
      this.saveManualCellState(empId, day, 'F', 'yes', 'Folga destacada');
    } else {
      this.saveManualCellState(empId, day, mode, 'default', '');
    }
  },

  saveManualCellState(empId, day, status, yellow, note) {
    const monthKey = ScheduleEngine.getMonthKey(appState.selectedYear, appState.selectedMonth);
    const cellKey = `${empId}_${day}`;
    if (!appState.manualOverrides[monthKey]) {
      appState.manualOverrides[monthKey] = {};
    }

    const previousValue = appState.manualOverrides[monthKey][cellKey]
      ? { ...appState.manualOverrides[monthKey][cellKey] }
      : null;

    appState.undoStack.push({ monthKey, cellKey, previousValue });

    if (status === 'AUTO' && yellow === 'default' && !note) {
      delete appState.manualOverrides[monthKey][cellKey];
    } else {
      appState.manualOverrides[monthKey][cellKey] = { status, yellow, note };
    }

    StorageService.saveState(appState);
    this.refreshAllViews();
  },

  /**
   * Eventos do Módulo de Funcionários (CRUD Completo)
   */
  bindEmployeeEvents() {
    document.getElementById('btnOpenNewEmployeeModal').addEventListener('click', () => {
      this.openEmployeeModal(null);
    });

    document.getElementById('btnCloseEmployeeModal').addEventListener('click', () => {
      document.getElementById('modalEmployee').style.display = 'none';
    });
    document.getElementById('btnCancelEmployeeModal').addEventListener('click', () => {
      document.getElementById('modalEmployee').style.display = 'none';
    });

    document.getElementById('empHasSecondShift').addEventListener('change', (e) => {
      const show = e.target.value === 'yes';
      document.querySelectorAll('.second-shift-field').forEach(el => {
        el.style.display = show ? 'flex' : 'none';
      });
    });

    document.getElementById('empRuleType').addEventListener('change', (e) => {
      const rule = e.target.value;
      const wInput = document.getElementById('empWorkDays');
      const oInput = document.getElementById('empOffDays');
      if (rule === '6x1' || rule === 'SD1' || rule === 'SD2') {
        wInput.value = 6; oInput.value = 1;
      } else if (rule === '5x2') {
        wInput.value = 5; oInput.value = 2;
      } else if (rule === '12x36') {
        wInput.value = 1; oInput.value = 1;
      }
    });

    document.getElementById('empFilterGroup').addEventListener('change', () => this.renderEmployeesTable());
    document.getElementById('empFilterStatus').addEventListener('change', () => this.renderEmployeesTable());

    document.getElementById('formEmployee').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('empId').value || `emp_${Date.now()}`;
      const empData = {
        id,
        name: document.getElementById('empName').value.trim().toUpperCase(),
        matricula: document.getElementById('empMatricula').value.trim(),
        status: document.getElementById('empStatus').value,
        entryTime: document.getElementById('empEntryTime').value,
        exitTime: document.getElementById('empExitTime').value,
        breakMinutes: Number(document.getElementById('empBreakMinutes').value) || 0,
        hasSecondShift: document.getElementById('empHasSecondShift').value === 'yes',
        entryTime2: document.getElementById('empEntryTime2').value,
        exitTime2: document.getElementById('empExitTime2').value,
        groupId: document.getElementById('empGroupId').value,
        scaleLabel: document.getElementById('empScaleLabel').value.trim().toUpperCase(),
        scaleColor: document.getElementById('empScaleColor').value,
        ruleType: document.getElementById('empRuleType').value,
        cycleStartDate: document.getElementById('empCycleStartDate').value,
        workDays: Number(document.getElementById('empWorkDays').value) || 6,
        offDays: Number(document.getElementById('empOffDays').value) || 1,
        notes: document.getElementById('empNotes').value.trim()
      };

      const existingIdx = appState.employees.findIndex(x => x.id === id);
      if (existingIdx >= 0) {
        appState.employees[existingIdx] = empData;
      } else {
        appState.employees.push(empData);
      }

      StorageService.saveState(appState);
      document.getElementById('modalEmployee').style.display = 'none';
      this.refreshAllViews();
    });
  },

  openEmployeeModal(empId) {
    const groupSelect = document.getElementById('empGroupId');
    groupSelect.innerHTML = appState.groups.map(g =>
      `<option value="${g.id}">${g.name}</option>`
    ).join('');

    const emp = empId ? appState.employees.find(e => e.id === empId) : null;
    document.getElementById('modalEmployeeTitle').textContent = emp ? 'Editar Funcionário' : 'Cadastrar Novo Funcionário';

    document.getElementById('empId').value = emp ? emp.id : '';
    document.getElementById('empName').value = emp ? emp.name : '';
    document.getElementById('empMatricula').value = emp ? emp.matricula : '';
    document.getElementById('empStatus').value = emp ? emp.status : 'ativo';
    document.getElementById('empEntryTime').value = emp ? emp.entryTime : '05:00';
    document.getElementById('empExitTime').value = emp ? emp.exitTime : '14:00';
    document.getElementById('empBreakMinutes').value = emp ? emp.breakMinutes : 60;
    document.getElementById('empHasSecondShift').value = emp?.hasSecondShift ? 'yes' : 'no';
    document.getElementById('empEntryTime2').value = emp?.entryTime2 || '15:00';
    document.getElementById('empExitTime2').value = emp?.exitTime2 || '19:00';
    document.getElementById('empGroupId').value = emp ? emp.groupId : (appState.groups[0]?.id || '');
    document.getElementById('empScaleLabel').value = emp ? emp.scaleLabel : 'S/D-1';
    document.getElementById('empScaleColor').value = emp?.scaleColor || '#5b9bd5';
    document.getElementById('empRuleType').value = emp ? emp.ruleType : 'SD1';
    document.getElementById('empCycleStartDate').value = emp ? emp.cycleStartDate : `${appState.selectedYear}-${String(appState.selectedMonth).padStart(2, '0')}-01`;
    document.getElementById('empWorkDays').value = emp ? emp.workDays : 6;
    document.getElementById('empOffDays').value = emp ? emp.offDays : 1;
    document.getElementById('empNotes').value = emp?.notes || '';

    document.querySelectorAll('.second-shift-field').forEach(el => {
      el.style.display = emp?.hasSecondShift ? 'flex' : 'none';
    });

    document.getElementById('modalEmployee').style.display = 'flex';
  },

  /**
   * Eventos de Configuração do Mês, Blocos e Estilo Visual
   */
  bindConfigEvents() {
    document.getElementById('formMonthConfig').addEventListener('submit', (e) => {
      e.preventDefault();
      appState.config.sectorTitle = document.getElementById('cfgSectorTitle').value.trim();
      appState.config.leftBadge = document.getElementById('cfgLeftBadge').value.trim();
      appState.config.customSubtitle = document.getElementById('cfgCustomSubtitle').value.trim();
      appState.config.minCoverage = Number(document.getElementById('cfgMinCoverage').value) || 0;
      appState.config.periodStartDay = Number(document.getElementById('cfgPeriodStartDay').value) || 1;
      appState.config.periodEndDay = Number(document.getElementById('cfgPeriodEndDay').value) || 0;
      appState.config.highlightAllFolgasYellow = document.getElementById('cfgHighlightAllFolgasYellow').checked;
      appState.config.repeatHeaderPerBlock = document.getElementById('cfgRepeatHeaderPerBlock').checked;

      const rawHolidays = document.getElementById('cfgMonthHolidays').value;
      const parsedDays = rawHolidays
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n >= 1 && n <= 31);

      const monthKey = ScheduleEngine.getMonthKey(appState.selectedYear, appState.selectedMonth);
      appState.config.holidaysByMonth[monthKey] = parsedDays;

      StorageService.saveState(appState);
      this.refreshAllViews();
      alert('Configurações do mês atualizadas com sucesso!');
    });

    document.getElementById('btnAddGroup').addEventListener('click', () => {
      const name = prompt('Digite o nome do novo Bloco / Turno / Equipe:');
      if (!name || !name.trim()) return;
      appState.groups.push({
        id: `grp_${Date.now()}`,
        name: name.trim(),
        order: appState.groups.length + 1,
        repeatHeader: true,
        spacerBefore: true
      });
      StorageService.saveState(appState);
      this.refreshAllViews();
    });

    document.getElementById('formVisualConfig').addEventListener('submit', (e) => {
      e.preventDefault();
      appState.config.symbols.work = document.getElementById('cfgSymWork').value.trim() || 'T';
      appState.config.symbols.off = document.getElementById('cfgSymOff').value.trim() || 'F';
      appState.config.symbols.holiday = document.getElementById('cfgSymHoliday').value.trim() || 'FE';
      appState.config.symbols.vacation = document.getElementById('cfgSymVacation').value.trim() || 'FER';

      appState.config.colors.headerBg = document.getElementById('cfgColorHeader').value;
      appState.config.colors.yellowHighlight = document.getElementById('cfgColorYellow').value;
      appState.config.colors.weekendBg = document.getElementById('cfgColorWeekend').value;
      appState.config.colors.scaleBadge = document.getElementById('cfgColorScaleBadge').value;

      StorageService.saveState(appState);
      this.refreshAllViews();
      alert('Configurações visuais salvas com sucesso!');
    });
  },

  /**
   * Eventos do Módulo de Férias e Afastamentos
   */
  bindVacationEvents() {
    document.getElementById('formVacation').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('vacId').value || `vac_${Date.now()}`;
      const startDate = document.getElementById('vacStartDate').value;
      const endDate = document.getElementById('vacEndDate').value;

      if (endDate < startDate) {
        alert('A data final não pode ser anterior à data inicial.');
        return;
      }

      const vacRecord = {
        id,
        employeeId: document.getElementById('vacEmployeeId').value,
        type: document.getElementById('vacType').value,
        displayMode: document.getElementById('vacDisplayMode').value,
        startDate,
        endDate,
        notes: document.getElementById('vacNotes').value.trim()
      };

      const idx = appState.vacations.findIndex(v => v.id === id);
      if (idx >= 0) {
        appState.vacations[idx] = vacRecord;
      } else {
        appState.vacations.push(vacRecord);
      }

      document.getElementById('formVacation').reset();
      document.getElementById('vacId').value = '';
      document.getElementById('btnCancelVacEdit').style.display = 'none';

      StorageService.saveState(appState);
      this.refreshAllViews();
    });

    document.getElementById('btnCancelVacEdit').addEventListener('click', () => {
      document.getElementById('formVacation').reset();
      document.getElementById('vacId').value = '';
      document.getElementById('btnCancelVacEdit').style.display = 'none';
    });
  },

  /**
   * Eventos de Exportação (PNG, Impressão, PDF, CSV)
   */
  bindExportEvents() {
    document.getElementById('btnGenerateImageMain').addEventListener('click', async () => {
      await SheetRenderer.generateHighResPNG();
    });

    document.getElementById('btnDownloadPng').addEventListener('click', async () => {
      if (!lastGeneratedDataUrl) {
        await SheetRenderer.generateHighResPNG();
      }
      if (!lastGeneratedDataUrl) return;
      const link = document.createElement('a');
      const monthName = MONTH_NAMES[appState.selectedMonth - 1];
      link.download = `ESCALA_${monthName}_${appState.selectedYear}.png`;
      link.href = lastGeneratedDataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });

    document.getElementById('btnPrintSchedule').addEventListener('click', () => {
      const stagingEl = document.getElementById('officialPrintableSheet');
      const pageMode = document.getElementById('exportPageMode').value;
      const days = ScheduleEngine.getActiveDaysList(appState.selectedYear, appState.selectedMonth);

      if (pageMode === 'split_pages' && days.length > 15) {
        const firstHalf = days.filter(d => d <= 15);
        const secondHalf = days.filter(d => d > 15);
        stagingEl.innerHTML =
          SheetRenderer.buildScheduleTableHTML({ interactive: false, customDaysArray: firstHalf }) +
          `<div style="page-break-before: always; height: 20px;"></div>` +
          SheetRenderer.buildScheduleTableHTML({ interactive: false, customDaysArray: secondHalf });
      } else {
        stagingEl.innerHTML = SheetRenderer.buildScheduleTableHTML({ interactive: false });
      }
      window.print();
    });

    document.getElementById('btnExportPdf').addEventListener('click', async () => {
      if (!lastGeneratedDataUrl) {
        await SheetRenderer.generateHighResPNG();
      }
      if (window.jspdf && window.jspdf.jsPDF && lastGeneratedDataUrl) {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const imgProps = pdf.getImageProperties(lastGeneratedDataUrl);
        const pageWidth = pdf.internal.pageSize.getWidth() - 12;
        const pageHeight = (imgProps.height * pageWidth) / imgProps.width;
        pdf.addImage(lastGeneratedDataUrl, 'PNG', 6, 6, pageWidth, Math.min(pageHeight, 195));
        const monthName = MONTH_NAMES[appState.selectedMonth - 1];
        pdf.save(`ESCALA_${monthName}_${appState.selectedYear}.pdf`);
      } else {
        // Fallback nativo: aciona impressão paisagem onde o usuário pode salvar como PDF
        document.getElementById('btnPrintSchedule').click();
      }
    });

    const exportScheduleToCSV = () => {
      const year = appState.selectedYear;
      const month = appState.selectedMonth;
      const days = ScheduleEngine.getActiveDaysList(year, month);
      const headers = ['Peg.', 'Larg.', 'Matricula', 'Assistente', 'Escala', ...days.map(d => `Dia ${d}`), 'Trab. Mes', 'Folgas Mes', 'Horas Previstas'];

      const analytics = ScheduleEngine.computeMonthAnalytics(year, month);
      const rows = [headers.join(';')];

      appState.employees.forEach(emp => {
        const st = analytics.employeeStats[emp.id];
        if (st.inVacationBar) {
          const vacCols = days.map(() => 'FERIAS');
          rows.push([
            emp.entryTime || '',
            emp.exitTime || '',
            emp.matricula || '',
            `"${emp.name || ''}"`,
            emp.scaleLabel || '',
            ...vacCols,
            0,
            0,
            '0.0'
          ].join(';'));
        } else {
          const dayCols = days.map(d => {
            const c = ScheduleEngine.getCellData(emp, year, month, d);
            return c.status;
          });
          rows.push([
            emp.entryTime || '',
            emp.exitTime || '',
            emp.matricula || '',
            `"${emp.name || ''}"`,
            emp.scaleLabel || '',
            ...dayCols,
            st.workCount,
            st.offCount,
            st.totalHours.toFixed(1)
          ].join(';'));
        }
      });

      const csvContent = '\uFEFF' + rows.join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ESCALA_${MONTH_NAMES[month - 1]}_${year}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    document.getElementById('btnExportCsv').addEventListener('click', exportScheduleToCSV);
    document.getElementById('btnExportReportCsv').addEventListener('click', exportScheduleToCSV);

    document.getElementById('btnBackToEdit').addEventListener('click', () => {
      this.switchView('montar-escala');
    });
  },

  /**
   * Eventos de Backup JSON (Exportar / Importar / Limpar)
   */
  bindBackupEvents() {
    document.getElementById('btnExportJson').addEventListener('click', () => {
      const jsonStr = JSON.stringify(appState, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup_escala_frota_${appState.selectedYear}_${String(appState.selectedMonth).padStart(2, '0')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    document.getElementById('inputImportJson').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          if (!parsed || (!Array.isArray(parsed.employees) && !parsed.config)) {
            alert('Arquivo JSON inválido: estrutura de escala não reconhecida.');
            return;
          }
          if (confirm('Deseja substituir os dados atuais pelos dados do backup JSON selecionado?')) {
            appState = StorageService.validateAndMergeState(parsed);
            StorageService.saveState(appState);
            this.populateTopSelectors();
            this.refreshAllViews();
            alert('Backup importado com sucesso!');
          }
        } catch (err) {
          alert('Erro ao ler o arquivo JSON: ' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('btnLoadReferenceData').addEventListener('click', () => {
      if (confirm('Deseja restaurar os cadastros e a escala de referência (Novembro 2026)? Isso substituirá as alterações atuais.')) {
        appState = getInitialReferenceState();
        StorageService.saveState(appState);
        this.populateTopSelectors();
        this.refreshAllViews();
      }
    });

    document.getElementById('btnClearAllData').addEventListener('click', () => {
      if (confirm('ATENÇÃO: Isso removerá todos os funcionários e férias cadastrados para que você comece do zero. Confirmar?')) {
        appState.employees = [];
        appState.vacations = [];
        appState.manualOverrides = {};
        appState.undoStack = [];
        StorageService.saveState(appState);
        this.refreshAllViews();
      }
    });
  },

  /**
   * Atualiza todas as telas e contadores
   */
  refreshAllViews() {
    const year = appState.selectedYear;
    const month = appState.selectedMonth;
    const analytics = ScheduleEngine.computeMonthAnalytics(year, month);

    // Botão Desfazer
    document.getElementById('btnUndoManual').disabled =
      !appState.undoStack || appState.undoStack.length === 0;

    // Sincroniza checkboxes da barra da escala
    document.getElementById('chkShowWorkSymbol').checked = Boolean(appState.config.showWorkSymbol);
    document.getElementById('chkShowWeekdayRow').checked = Boolean(appState.config.showWeekdayRow);
    document.getElementById('lblWorkSymbolPreview').textContent = appState.config.symbols.work || 'T';

    // 1. Atualiza Dashboard
    this.renderDashboard(analytics);

    // 2. Atualiza Tabela Interativa Principal
    document.getElementById('interactiveSheetContainer').innerHTML =
      SheetRenderer.buildScheduleTableHTML({ interactive: true });

    // 3. Atualiza Tabela de Funcionários
    this.renderEmployeesTable();

    // 4. Atualiza Formulários de Configuração e Blocos
    this.renderConfigForms();

    // 5. Atualiza Férias e Afastamentos
    this.renderVacationsView();

    // 6. Atualiza Relatórios
    this.renderReportsView(analytics);
  },

  renderDashboard(analytics) {
    const totalHoursAll = Object.values(analytics.employeeStats)
      .reduce((acc, st) => acc + st.totalHours, 0);

    document.getElementById('dashboardKpis').innerHTML = `
      <div class="kpi-card">
        <div class="kpi-title">Total Cadastrados</div>
        <div class="kpi-value">${analytics.totalEmployees}</div>
        <div class="kpi-sub">Funcionários no setor</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Efetivo Ativo no Mês</div>
        <div class="kpi-value">${analytics.activeCount}</div>
        <div class="kpi-sub">Escalados nos turnos</div>
      </div>
      <div class="kpi-card kpi-warn">
        <div class="kpi-title">Em Férias / Rodapé</div>
        <div class="kpi-value">${analytics.vacationCount}</div>
        <div class="kpi-sub">Na seção FÉRIAS</div>
      </div>
      <div class="kpi-card kpi-dark">
        <div class="kpi-title">Total Horas Previstas</div>
        <div class="kpi-value">${totalHoursAll.toFixed(0)}h</div>
        <div class="kpi-sub">Soma líquida no período</div>
      </div>
    `;

    document.getElementById('dashboardAlerts').innerHTML = analytics.alerts.map(a => `
      <li class="alert-item ${a.level === 'ok' ? 'ok' : a.level === 'danger' ? 'danger' : ''}">
        ${a.text}
      </li>
    `).join('');

    const minCov = Number(appState.config.minCoverage) || 0;
    document.getElementById('dashboardCoverageStrip').innerHTML = analytics.days.map(d => {
      const ds = analytics.dailyStats[d];
      const isLow = ds.working < minCov;
      return `
        <div class="cov-day-box ${isLow ? 'low-cov' : ''}" title="Dia ${d}: ${ds.working} trabalhando | ${ds.off} de folga">
          <div class="cov-day-num">Dia ${d}</div>
          <div><strong>T:</strong> ${ds.working}</div>
          <div><strong>F:</strong> ${ds.off}</div>
        </div>
      `;
    }).join('');

    document.getElementById('dashboardSheetPreview').innerHTML =
      SheetRenderer.buildScheduleTableHTML({ interactive: false });
  },

  renderEmployeesTable() {
    const filterGrp = document.getElementById('empFilterGroup');
    const currentGrpVal = filterGrp.value || 'ALL';
    filterGrp.innerHTML = `<option value="ALL">Todos os Turnos / Grupos</option>` +
      appState.groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
    filterGrp.value = currentGrpVal;

    const statusFilter = document.getElementById('empFilterStatus').value || 'ALL';
    const filtered = SheetRenderer.getFilteredAndSortedEmployees(appState.employees).filter(emp => {
      if (currentGrpVal !== 'ALL' && emp.groupId !== currentGrpVal) return false;
      if (statusFilter !== 'ALL' && emp.status !== statusFilter) return false;
      return true;
    });

    const tbody = document.getElementById('employeesTableBody');
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">Nenhum funcionário encontrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(emp => {
      const grp = appState.groups.find(g => g.id === emp.groupId);
      const hoursLabel = emp.hasSecondShift && emp.entryTime2
        ? `${emp.entryTime}-${emp.exitTime} / ${emp.entryTime2}-${emp.exitTime2}`
        : `${emp.entryTime || '--:--'} às ${emp.exitTime || '--:--'}`;

      return `
        <tr>
          <td><strong>${emp.matricula}</strong></td>
          <td><strong>${emp.name}</strong></td>
          <td>${hoursLabel}</td>
          <td>${grp ? grp.name : 'Sem bloco'}</td>
          <td><span class="badge" style="background:${emp.scaleColor || '#5b9bd5'};color:#000;">${emp.scaleLabel}</span></td>
          <td>${emp.ruleType} (${emp.workDays}x${emp.offDays})</td>
          <td>${emp.cycleStartDate}</td>
          <td><span class="status-pill ${emp.status}">${emp.status}</span></td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-sm btn-outline" data-edit-emp="${emp.id}">✏️ Editar</button>
              <button class="btn btn-sm btn-outline" data-reset-emp="${emp.id}" title="Restaurar automático deste funcionário">♻️ Auto</button>
              <button class="btn btn-sm btn-danger" data-del-emp="${emp.id}">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-edit-emp]').forEach(btn => {
      btn.addEventListener('click', () => this.openEmployeeModal(btn.dataset.editEmp));
    });

    tbody.querySelectorAll('[data-reset-emp]').forEach(btn => {
      btn.addEventListener('click', () => {
        const empId = btn.dataset.resetEmp;
        const emp = appState.employees.find(e => e.id === empId);
        const monthKey = ScheduleEngine.getMonthKey(appState.selectedYear, appState.selectedMonth);
        if (confirm(`Restaurar o cálculo automático de ${emp?.name} neste mês?`)) {
          if (appState.manualOverrides[monthKey]) {
            Object.keys(appState.manualOverrides[monthKey]).forEach(k => {
              if (k.startsWith(`${empId}_`)) delete appState.manualOverrides[monthKey][k];
            });
          }
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });

    tbody.querySelectorAll('[data-del-emp]').forEach(btn => {
      btn.addEventListener('click', () => {
        const empId = btn.dataset.delEmp;
        const emp = appState.employees.find(e => e.id === empId);
        if (confirm(`Deseja realmente excluir o funcionário "${emp?.name}"?`)) {
          appState.employees = appState.employees.filter(e => e.id !== empId);
          appState.vacations = appState.vacations.filter(v => v.employeeId !== empId);
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });
  },

  renderConfigForms() {
    document.getElementById('cfgSectorTitle').value = appState.config.sectorTitle || '';
    document.getElementById('cfgLeftBadge').value = appState.config.leftBadge || '';
    document.getElementById('cfgCustomSubtitle').value = appState.config.customSubtitle || '';
    document.getElementById('cfgMinCoverage').value = appState.config.minCoverage ?? 4;
    document.getElementById('cfgPeriodStartDay').value = appState.config.periodStartDay || 1;
    document.getElementById('cfgPeriodEndDay').value = appState.config.periodEndDay || 0;
    document.getElementById('cfgHighlightAllFolgasYellow').checked = Boolean(appState.config.highlightAllFolgasYellow);
    document.getElementById('cfgRepeatHeaderPerBlock').checked = Boolean(appState.config.repeatHeaderPerBlock);

    const holidays = ScheduleEngine.getHolidaysForMonth(appState.selectedYear, appState.selectedMonth);
    document.getElementById('cfgMonthHolidays').value = holidays.join(', ');

    // Siglas e cores
    document.getElementById('cfgSymWork').value = appState.config.symbols.work || 'T';
    document.getElementById('cfgSymOff').value = appState.config.symbols.off || 'F';
    document.getElementById('cfgSymHoliday').value = appState.config.symbols.holiday || 'FE';
    document.getElementById('cfgSymVacation').value = appState.config.symbols.vacation || 'FER';

    document.getElementById('cfgColorHeader').value = appState.config.colors.headerBg || '#757575';
    document.getElementById('cfgColorYellow').value = appState.config.colors.yellowHighlight || '#ffff00';
    document.getElementById('cfgColorWeekend').value = appState.config.colors.weekendBg || '#d9d9d9';
    document.getElementById('cfgColorScaleBadge').value = appState.config.colors.scaleBadge || '#5b9bd5';

    // Lista de Blocos/Grupos
    const groupsContainer = document.getElementById('groupsListContainer');
    const sortedGroups = [...appState.groups].sort((a, b) => (a.order || 0) - (b.order || 0));

    groupsContainer.innerHTML = sortedGroups.map((g, idx) => {
      const count = appState.employees.filter(e => e.groupId === g.id).length;
      return `
        <div class="group-item-card">
          <div>
            <strong>${idx + 1}. ${g.name}</strong>
            <div class="help-text">${count} funcionário(s) neste bloco</div>
          </div>
          <div class="inline-actions">
            <label class="checkbox-label">
              <input type="checkbox" data-grp-header="${g.id}" ${g.repeatHeader ? 'checked' : ''}>
              Repetir cabeçalho
            </label>
            <button class="btn btn-sm btn-outline" data-grp-up="${g.id}" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-sm btn-outline" data-grp-down="${g.id}" ${idx === sortedGroups.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-sm btn-outline" data-grp-rename="${g.id}">✏️</button>
            <button class="btn btn-sm btn-danger" data-grp-del="${g.id}">🗑️</button>
          </div>
        </div>
      `;
    }).join('');

    groupsContainer.querySelectorAll('[data-grp-header]').forEach(chk => {
      chk.addEventListener('change', () => {
        const grp = appState.groups.find(g => g.id === chk.dataset.grpHeader);
        if (grp) {
          grp.repeatHeader = chk.checked;
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });

    groupsContainer.querySelectorAll('[data-grp-up]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = sortedGroups.findIndex(g => g.id === btn.dataset.grpUp);
        if (idx > 0) {
          const temp = sortedGroups[idx - 1].order;
          sortedGroups[idx - 1].order = sortedGroups[idx].order;
          sortedGroups[idx].order = temp;
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });

    groupsContainer.querySelectorAll('[data-grp-down]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = sortedGroups.findIndex(g => g.id === btn.dataset.grpDown);
        if (idx < sortedGroups.length - 1) {
          const temp = sortedGroups[idx + 1].order;
          sortedGroups[idx + 1].order = sortedGroups[idx].order;
          sortedGroups[idx].order = temp;
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });

    groupsContainer.querySelectorAll('[data-grp-rename]').forEach(btn => {
      btn.addEventListener('click', () => {
        const grp = appState.groups.find(g => g.id === btn.dataset.grpRename);
        if (!grp) return;
        const newName = prompt('Novo nome para o bloco/turno:', grp.name);
        if (newName && newName.trim()) {
          grp.name = newName.trim();
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });

    groupsContainer.querySelectorAll('[data-grp-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (appState.groups.length <= 1) {
          alert('É necessário manter pelo menos 1 bloco cadastrado.');
          return;
        }
        const grpId = btn.dataset.grpDel;
        if (confirm('Excluir este bloco? Os funcionários vinculados serão movidos para o primeiro bloco disponível.')) {
          appState.groups = appState.groups.filter(g => g.id !== grpId);
          const fallbackId = appState.groups[0].id;
          appState.employees.forEach(e => {
            if (e.groupId === grpId) e.groupId = fallbackId;
          });
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });
  },

  renderVacationsView() {
    const empSelect = document.getElementById('vacEmployeeId');
    empSelect.innerHTML = appState.employees.map(e =>
      `<option value="${e.id}">${e.name} (${e.matricula})</option>`
    ).join('');

    const tbody = document.getElementById('vacationsTableBody');
    if (appState.vacations.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">Nenhuma férias ou afastamento registrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = appState.vacations.map(v => {
      const emp = appState.employees.find(e => e.id === v.employeeId);
      const modeLabel = v.displayMode === 'footer_bar'
        ? 'Faixa FÉRIAS no rodapé'
        : v.displayMode === 'inline_days' ? 'Dias na linha' : 'Ambos';

      return `
        <tr>
          <td><strong>${emp ? emp.name : 'Removido'}</strong></td>
          <td>${v.type}</td>
          <td>${v.startDate} até ${v.endDate}</td>
          <td>${modeLabel}</td>
          <td>${v.notes || '-'}</td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-sm btn-outline" data-edit-vac="${v.id}">✏️</button>
              <button class="btn btn-sm btn-danger" data-del-vac="${v.id}">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-edit-vac]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = appState.vacations.find(x => x.id === btn.dataset.editVac);
        if (!v) return;
        document.getElementById('vacId').value = v.id;
        document.getElementById('vacEmployeeId').value = v.employeeId;
        document.getElementById('vacType').value = v.type;
        document.getElementById('vacDisplayMode').value = v.displayMode;
        document.getElementById('vacStartDate').value = v.startDate;
        document.getElementById('vacEndDate').value = v.endDate;
        document.getElementById('vacNotes').value = v.notes || '';
        document.getElementById('btnCancelVacEdit').style.display = 'inline-flex';
      });
    });

    tbody.querySelectorAll('[data-del-vac]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Excluir este registro de férias/afastamento?')) {
          appState.vacations = appState.vacations.filter(x => x.id !== btn.dataset.delVac);
          StorageService.saveState(appState);
          this.refreshAllViews();
        }
      });
    });
  },

  renderReportsView(analytics) {
    const tbody = document.getElementById('reportEmployeeBody');
    const list = SheetRenderer.getFilteredAndSortedEmployees(appState.employees);

    tbody.innerHTML = list.map(emp => {
      const st = analytics.employeeStats[emp.id];
      const hoursText = emp.hasSecondShift && emp.entryTime2
        ? `${emp.entryTime}-${emp.exitTime} + ${emp.entryTime2}-${emp.exitTime2}`
        : `${emp.entryTime || '--:--'} às ${emp.exitTime || '--:--'}`;

      return `
        <tr>
          <td>${emp.matricula}</td>
          <td><strong>${emp.name}</strong></td>
          <td>${hoursText}</td>
          <td>${emp.scaleLabel} (${emp.ruleType})</td>
          <td>${st.netDailyHours.toFixed(2)}h / dia</td>
          <td><strong>${st.workCount}</strong></td>
          <td><strong>${st.offCount}</strong></td>
          <td>${st.inVacationBar ? 'FÉRIAS (Mês)' : st.otherCount}</td>
          <td><strong>${st.totalHours.toFixed(1)}h</strong></td>
          <td>${st.manualCount > 0 ? `<span class="status-pill afastado">${st.manualCount} ajuste(s)</span>` : 'Automático'}</td>
        </tr>
      `;
    }).join('');
  }
};

// Inicializa o sistema quando o DOM estiver carregado
document.addEventListener('DOMContentLoaded', () => {
  UIController.init();
});