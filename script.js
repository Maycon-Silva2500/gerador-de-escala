/**
 * ============================================================================
 * FROTA.OS // SISTEMA CRIADOR DE ESCALA DE TRABALHO (ES2022) - v4.5 Completo
 * ============================================================================
 * Módulos:
 * 1. Helpers & Sec
 * 2. CloudSyncAdapter (Firestore Integrado com AuthManager)
 * 3. ScheduleEngine (Regras, HE, Viagem no Tempo, Relatórios)
 * 4. Store (Estado, Undo/Redo)
 * 5. Renderer (DOM Patching)
 * 6. ExportService (PNG/PDF/CSV)
 * 7. UI (Context Menu, Drag&Drop, Modais, Reports)
 * 8. SelfTests (22 Testes)
 * ============================================================================
 */
'use strict';

const STORAGE_KEY = 'FROTA_OS_SCHEDULE_STATE_V4';
const CURRENT_SCHEMA_VERSION = 4;
const MONTH_NAMES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const WEEKDAY_LETTERS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const FIXED_NATIONAL_HOLIDAYS = { 1: [1], 4: [21], 5: [1], 9: [7], 10: [12], 11: [2, 15, 20], 12: [25] };

// Atalhos DOM
const $ = id => document.getElementById(id); const $$ = sel => document.querySelectorAll(sel);

// ============================================================================
// 1. HELPERS E SANITIZAÇÃO
// ============================================================================
function escapeHTML(val) {
  return String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeCSV(val) {
  let str = String(val ?? '').replace(/"/g, '""');
  if (/^[=+\-@]/.test(str)) str = "'" + str; 
  return `"${str}"`;
}
function debounce(fn, ms = 80) {
  let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function parseTime(val) {
  if(!val) return 0;
  if(String(val).includes(':')) {
    const [h,m] = String(val).split(':').map(Number);
    return (h*60) + (m||0);
  }
  return Number(val) || 0;
}
function formatMins(m) {
  const h = Math.floor(m/60), mins = m%60;
  return `${h}h${mins>0 ? String(mins).padStart(2,'0') : ''}`;
}

// ============================================================================
// 2. FIREBASE & CLOUD ADAPTER (Sincronizado com auth.js)
// ============================================================================
const CloudSyncAdapter = {
  db: null, enabled: false, user: null, role: null, workspaceId: 'default_ws', unsubMeta: null, unsubMonth: null, isPendingWrite: false,
  
  init() {
    if (typeof firebase !== 'undefined' && firebase.apps.length > 0) {
      try {
        this.db = firebase.firestore();
        this.db.enablePersistence().catch(()=>{});
        this.enabled = true;
      } catch(e) { console.error('Erro na persistência local Firestore.', e); }
    }
  },

  // Chamado via evento 'auth-success' do auth.js
  async onAuthSuccess(user) {
    this.user = user;
    await this.loadWorkspace();
  },

  // Chamado via evento 'auth-logout' do auth.js
  onAuthLogout() {
    this.user = null; this.role = null;
    if(this.unsubMeta) { this.unsubMeta(); this.unsubMeta = null; }
    if(this.unsubMonth) { this.unsubMonth(); this.unsubMonth = null; }
  },

  async loadWorkspace() {
    if (!this.user || !this.enabled) return;
    try {
      const snap = await this.db.collection('workspaces').where(`members.${this.user.uid}.role`, 'in', ['admin','editor','leitor']).limit(1).get();
      if (!snap.empty) {
        this.workspaceId = snap.docs[0].id; 
        this.role = snap.docs[0].data().members[this.user.uid].role;
        this.attachListeners();
      }
    } catch(e) { console.error("Erro a carregar Workspace:", e); }
  },

  attachListeners() {
    if(this.unsubMeta) this.unsubMeta();
    this.unsubMeta = this.db.collection('workspaces').doc(this.workspaceId).collection('meta').doc('main').onSnapshot(doc => {
      if(doc.metadata.hasPendingWrites) return; if(doc.exists) this.handleIncomingMeta(doc.data());
    });
    this.listenMonth(ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth));
  },

  listenMonth(mKey) {
    if(this.unsubMonth) this.unsubMonth();
    this.unsubMonth = this.db.collection('workspaces').doc(this.workspaceId).collection('months').doc(mKey).onSnapshot(doc => {
      if(doc.metadata.hasPendingWrites) return; if(doc.exists) this.handleIncomingMonth(mKey, doc.data());
    });
  },

  handleIncomingMeta(data) {
    if ((data.rev || 0) > (Store.state.rev || 0)) {
      const merged = Store.sanitizeAndMigrate({ ...Store.state, ...data });
      Object.assign(Store.state, { groups: merged.groups, employees: merged.employees, vacations: merged.vacations, config: merged.config, rev: data.rev });
      Renderer.renderAll(Store.state, 'all');
    }
  },

  handleIncomingMonth(mKey, data) {
    Store.state.manualOverrides[mKey] = data.manualOverrides || {}; Store.state.overtime[mKey] = data.overtime || {};
    Renderer.patchGrid(Store.state, null, true); Renderer.debouncedAnalytics(Store.state);
  },

  async pushState(state) {
    if (!this.enabled || !this.user || this.role === 'leitor' || this.isPendingWrite) return;
    try {
      this.isPendingWrite = true; const batch = this.db.batch(); const wsRef = this.db.collection('workspaces').doc(this.workspaceId);
      state.rev = (state.rev || 0) + 1;
      batch.set(wsRef.collection('meta').doc('main'), { groups: state.groups, employees: state.employees, vacations: state.vacations, config: state.config, rev: state.rev }, { merge: true });
      const mKey = ScheduleEngine.getMonthKey(state.selectedYear, state.selectedMonth);
      batch.set(wsRef.collection('months').doc(mKey), { manualOverrides: state.manualOverrides[mKey] || {}, overtime: state.overtime[mKey] || {} }, { merge: true });
      await batch.commit(); 
    } catch (e) {} finally { this.isPendingWrite = false; }
  }
};

// ============================================================================
// 3. MOTOR DE CÁLCULO E REGRAS (ScheduleEngine)
// ============================================================================
const ScheduleEngine = {
  dateToEpochDays(dStr) {
    const p = String(dStr||'2026-11-01').split('-').map(Number);
    return Math.floor(Date.UTC(p[0], p[1]-1, p[2]) / 86400000);
  },
  epochToISO(e) {
    const d = new Date(e * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  },
  getMonthKey(y,m) { return `${y}-${String(m).padStart(2,'0')}`; },
  getDaysInMonth(y,m) { return new Date(Date.UTC(y,m,0)).getUTCDate(); },
  getDayOfWeekUTC(y,m,d) { return new Date(Date.UTC(y,m-1,d)).getUTCDay(); },

  getEasterDate(year) {
    const a=year%19, b=Math.floor(year/100), c=year%100, d=Math.floor(b/4), e=b%4;
    const f=Math.floor((b+8)/25), g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30;
    const i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-h-k)%7;
    const m=Math.floor((a+11*h+22*l)/451), month=Math.floor((h+l-7*m+114)/31), day=((h+l-7*m+114)%31)+1;
    return { year, month, day, dateISO: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` };
  },

  getMovableHolidaysForYear(year) {
    const e = this.dateToEpochDays(this.getEasterDate(year).dateISO);
    return [
      { off: -48, name: 'Carnaval' }, { off: -47, name: 'Carnaval' },
      { off: -2, name: 'Sexta Santa' }, { off: 0, name: 'Páscoa' }, { off: 60, name: 'Corpus Christi' }
    ].map(item => {
      const d = this.epochToISO(e + item.off).split('-').map(Number);
      return { year: d[0], month: d[1], day: d[2] };
    });
  },

  getHolidaysForMonth(state, y, m) {
    const k = this.getMonthKey(y,m);
    if(Array.isArray(state.config?.holidaysByMonth?.[k])) return state.config.holidaysByMonth[k];
    const fx = FIXED_NATIONAL_HOLIDAYS[m] ? [...FIXED_NATIONAL_HOLIDAYS[m]] : [];
    const mv = this.getMovableHolidaysForYear(y).filter(h => h.month === m).map(h => h.day);
    return Array.from(new Set([...fx, ...mv])).sort((a,b)=>a-b);
  },

  getEffectiveRule(emp, isoDate) {
    if(!emp.scaleChanges || !emp.scaleChanges.length) return emp;
    const past = emp.scaleChanges.filter(c => c.from <= isoDate).sort((a,b) => a.from>b.from ? -1 : 1);
    if(past.length > 0) return { ...emp, ruleType: past[0].ruleType, cycleStartDate: past[0].cycleStartDate, workDays: past[0].workDays, offDays: past[0].offDays, scaleLabel: past[0].scaleLabel };
    return emp;
  },

  calculateRuleOnlyStatus(rule, isoDate) {
    const tE = this.dateToEpochDays(isoDate), sE = this.dateToEpochDays(rule.cycleStartDate || '2026-11-01');
    const dow = new Date(tE * 86400000).getUTCDay();

    if(rule.ruleType === 'SD1' || rule.ruleType === 'SD2') {
      if(dow >= 1 && dow <= 5) return 'T';
      const isEven = ((Math.floor((tE+3)/7) - Math.floor((sE+3)/7)) % 2 + 2) % 2 === 0;
      if(rule.ruleType === 'SD1') return isEven ? (dow===0?'F':'T') : (dow===6?'F':'T');
      return isEven ? (dow===6?'F':'T') : (dow===0?'F':'T');
    }

    let w = 6, o = 1;
    switch(rule.ruleType) {
      case '12x36': w=1; o=1; break;
      case '24x48': w=1; o=2; break;
      case '6x1': w=6; o=1; break;
      case '5x2': w=5; o=2; break;
      case '4x2': w=4; o=2; break;
      case 'CUSTOM': w=Number(rule.workDays)||6; o=Number(rule.offDays)||1; break;
    }
    const c = Math.max(1, w+o);
    return (((tE - sE) % c) + c) % c < w ? 'T' : 'F';
  },

  isEmployeeInFooterVacation(state, emp, y, m) {
    const s = this.formatDateISO(y,m,1), e = this.formatDateISO(y,m,this.getDaysInMonth(y,m));
    const hV = (state.vacations||[]).some(v => v.employeeId===emp.id && v.type==='FERIAS' && v.displayMode!=='inline_days' && v.startDate<=e && v.endDate>=s);
    return hV || (emp.status === 'ferias' && !(state.vacations||[]).some(v => v.employeeId===emp.id && v.type==='FERIAS' && v.displayMode==='inline_days' && v.startDate<=e && v.endDate>=s));
  },

  resolveCell(state, emp, y, m, d) {
    const iso = this.formatDateISO(y,m,d), mK = this.getMonthKey(y,m), cK = `${emp.id}_${d}`;
    const rObj = this.getEffectiveRule(emp, iso); let auto = this.calculateRuleOnlyStatus(rObj, iso);
    
    if(emp.status === 'afastado') auto = 'AF';
    const vac = (state.vacations||[]).find(v => v.employeeId===emp.id && iso>=v.startDate && iso<=v.endDate);
    if(vac) auto = (vac.type==='FERIAS' && vac.displayMode!=='footer_bar') ? 'FER' : (vac.type!=='FERIAS'?'AF':auto);

    const man = state.manualOverrides?.[mK]?.[cK]; const finalSt = (man && man.status!=='AUTO') ? man.status : auto;
    const dow = this.getDayOfWeekUTC(y,m,d), isHol = this.getHolidaysForMonth(state, y, m).includes(d);
    const isYel = man?.yellow==='yes' || (man?.yellow!=='no' && (isHol || (state.config.highlightAllFolgasYellow && (finalSt==='F'||finalSt==='FE'))));
    
    const sy = state.config.symbols;
    let txt = finalSt==='T' ? (state.config.showWorkSymbol?sy.work:'') : finalSt==='F'?sy.off : finalSt==='FE'?sy.holiday : finalSt==='FER'?sy.vacation : finalSt==='AF'?sy.leave:finalSt;

    const ot = state.overtime?.[mK]?.[cK]; let otMins = 0, otKind = null;
    if(state.config.overtime.enabled && ot && ot.minutes > 0) {
      otMins = ot.minutes;
      if(ot.kind === 'AUTO') otKind = (dow===0 || isHol || auto!=='T') ? '100' : '50';
      else otKind = ot.kind;
    }
    return { status: finalSt, autoStatus: auto, isManualDiff: finalSt!==auto, isWeekend: dow===0||dow===6, isHoliday: isHol, isYellow: isYel, displayText: txt, note: man?.note||'', otMins, otKind, ruleObj: rObj };
  },

  calcDailyNetHours(emp) {
    const p = (e,x) => {
      if(!e||!x) return 0;
      let [h1,m1]=e.split(':').map(Number), [h2,m2]=x.split(':').map(Number);
      if(isNaN(h1)||isNaN(h2)) return 0;
      let df = (h2*60+m2)-(h1*60+m1);
      return df<=0 ? df+1440 : df;
    };
    let g = p(emp.entryTime, emp.exitTime);
    if(emp.hasSecondShift) g += p(emp.entryTime2, emp.exitTime2);
    return Math.max(0, g - (Number(emp.breakMinutes)||0)) / 60;
  },

  getVisibleDays(state, year, month) {
    const md = this.getDaysInMonth(year, month);
    const s = Math.max(1, Math.min(md, Number(state.config.periodStartDay) || 1));
    const e = Number(state.config.periodEndDay) || 0;
    const ed = e > 0 ? Math.max(s, Math.min(md, e)) : md;
    const l = []; for (let d=s; d<=ed; d++) l.push(d); return l;
  },

  doPeriodsOverlap(startA, endA, startB, endB) { return startA <= endB && startB <= endA; },

  analyzeMonth(state, y, m) {
    const days = this.getVisibleDays(state, y, m);
    const mtx = {}, daily = {}, blk = {}, alerts = [];
    
    days.forEach(d => daily[d] = { w:0, f:0 });
    state.groups.forEach(g => { blk[g.id] = {}; days.forEach(d => blk[g.id][d] = 0); });

    let act = 0, ftVac = 0;
    const matMap = new Map();
    
    state.employees.forEach(emp => {
      const mat = (emp.matricula || '').trim();
      if (!mat || !emp.name?.trim()) alerts.push({ severity: 'critico', text: `Cadastro incompleto: "${emp.name || 'Sem Nome'}" sem matrícula ou nome.`, empId: emp.id });
      else if (matMap.has(mat)) alerts.push({ severity: 'critico', text: `Matrícula duplicada (${mat}): "${emp.name}" e "${matMap.get(mat).name}".`, empId: emp.id });
      else matMap.set(mat, emp);

      const inFt = this.isEmployeeInFooterVacation(state, emp, y, m);
      if(inFt) ftVac++; else if(emp.status==='ativo') act++;
      
      let wD=0, fD=0, o50=0, o100=0, oBan=0, baseH=0, lastX=null, manAdj=0;
      const netH = this.calcDailyNetHours(emp);

      let consWork=0, maxConsW=0, fdEx=null, consSun=0, maxConsSun=0, sdEx=null;

      days.forEach(d => {
        if(inFt) return;
        const c = this.resolveCell(state, emp, y, m, d);
        if(c.isManualDiff) manAdj++;
        const dow = this.getDayOfWeekUTC(y, m, d);

        if(c.status==='T') { 
          wD++; daily[d].w++; if(blk[emp.groupId]) blk[emp.groupId][d]++; baseH+=netH; 
          consWork++; if(consWork>maxConsW) { maxConsW=consWork; if(consWork===7) fdEx=d; }
          if(dow===0) { consSun++; if(consSun>maxConsSun) { maxConsSun=consSun; if(consSun===2) sdEx=d; } }
        }
        else if(c.status==='F'||c.status==='FE') { fD++; daily[d].f++; consWork=0; if(dow===0) consSun=0; }
        else { consWork=0; if(dow===0) consSun=0; }

        if(c.otMins>0) {
          if(c.otKind==='50') o50+=c.otMins; else if(c.otKind==='100') o100+=c.otMins; else if(c.otKind==='BANCO') oBan+=c.otMins;
          if(c.otMins > state.config.overtime.maxDailyMinutes) alerts.push({severity:'aviso', text:`${emp.name} fez ${formatMins(c.otMins)} de HE no dia ${d} (limite ${formatMins(state.config.overtime.maxDailyMinutes)}).`, day: d, empId: emp.id});
          if(c.status==='FER'||c.status==='AF') alerts.push({severity:'critico', text:`HE lançada para ${emp.name} em dia de Férias/Afastamento (Dia ${d}).`, day:d, empId: emp.id});
        }
        
        if(c.status==='T' && emp.entryTime) {
          let [hh,mm]=emp.entryTime.split(':').map(Number);
          let eAbs = d*1440 + hh*60 + mm;
          if(lastX!==null && (eAbs - lastX) < 660) alerts.push({severity:'critico', text:`Interjornada < 11h para ${emp.name} no dia ${d}.`, day:d, empId:emp.id});
          let [xh,xm]=emp.exitTime.split(':').map(Number);
          lastX = d*1440 + xh*60 + xm + (xh<hh?1440:0) + c.otMins;
        } else { lastX = null; }
      });

      if((o50+o100) > state.config.overtime.maxMonthlyMinutes) alerts.push({severity:'aviso', text:`${emp.name} excedeu limite mensal de HE (${formatMins(o50+o100)}).`, empId:emp.id});
      if(!inFt && maxConsW > 6) alerts.push({severity:'aviso', text:`${emp.name} fez ${maxConsW} dias consecutivos (a partir do dia ${fdEx}).`, empId:emp.id, day:fdEx});
      if(!inFt && maxConsSun >= 2) alerts.push({severity:'aviso', text:`${emp.name} trabalhou ${maxConsSun} domingos seguidos (dia ${sdEx}).`, empId:emp.id, day:sdEx});

      mtx[emp.id] = { emp, inFt, wD, fD, baseH, o50, o100, oBan, tH: baseH + ((o50+o100)/60), manAdj };
    });

    for (let i = 0; i < state.vacations.length; i++) {
      for (let j = i + 1; j < state.vacations.length; j++) {
        const v1 = state.vacations[i], v2 = state.vacations[j];
        if (v1.employeeId === v2.employeeId && this.doPeriodsOverlap(v1.startDate, v1.endDate, v2.startDate, v2.endDate)) {
          alerts.push({ severity: 'critico', text: `Sobreposição de férias para Matrícula ${v1.employeeId} (${v1.startDate} a ${v1.endDate}).`, empId: v1.employeeId });
        }
      }
    }

    const minG = Number(state.config.minCoverage)||0;
    let dOk = 0; const lowD = [];
    days.forEach(d => { if(daily[d].w >= minG) dOk++; else lowD.push(d); });
    if(lowD.length) alerts.push({severity:'critico', text:`Cobertura total < ${minG} em ${lowD.length} dia(s).`, day:lowD[0]});

    const bMetrics = state.groups.map(g => {
      const gAct = state.employees.filter(e => e.groupId===g.id && !this.isEmployeeInFooterVacation(state, e, y, m));
      const minB = Number(g.minCoverage) || 1;
      const vls = days.map(d => blk[g.id]?.[d]||0);
      const mObs = Math.min(...vls)||0;
      if(gAct.length && mObs < minB) alerts.push({severity:'aviso', text:`Turno ${g.name} < ${minB} no dia ${days.find(d=>blk[g.id][d]<minB)}.`});
      return { group:g, active:gAct.length, min:minB, avg:vls.reduce((a,b)=>a+b,0)/days.length||0, minObs:mObs, totalBlockHours: gAct.reduce((s,e)=>s+(mtx[e.id]?.tH||0),0), dailyMap: blk[g.id]||{} };
    });

    if(!alerts.length) alerts.push({severity:'ok', text:'Escala 100% validada sem conflitos.'});
    return { days, mtx, daily, bMetrics, alerts, act, ftVac, cov: days.length ? Math.round((dOk/days.length)*100) : 100, totalEmployees: state.employees.length };
  }
};

// ============================================================================
// 4. ESTADO (Store) COM MIGRAÇÃO E HISTÓRICO
// ============================================================================
function createReferenceModelState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION, theme: 'dark', selectedMonth: 11, selectedYear: 2026, sortOrder: 'custom', rev: 1,
    config: {
      sectorTitle: 'MONITORAMENTO DA FROTA', leftBadge: 'EFETIVO', customSubtitle: '', minCoverage: 4, periodStartDay: 1, periodEndDay: 0,
      showWorkSymbol: false, showWeekdayRow: false, highlightAllFolgasYellow: false, repeatHeaderPerBlock: true, requireLogin: false,
      symbols: { work: 'T', off: 'F', holiday: 'FE', vacation: 'FER', leave: 'AF' },
      colors: { headerBg: '#757575', yellowHighlight: '#ffff00', weekendBg: '#d9d9d9', scaleBadge: '#5b9bd5' },
      holidaysByMonth: { '2026-11': [2, 20] },
      overtime: { enabled: true, maxDailyMinutes: 120, maxMonthlyMinutes: 2400, showOnSheet: false }
    },
    groups: [
      { id: 'grp_manha', name: 'Manhã', order: 1, minCoverage: 2, repeatHeader: false, spacerBefore: false },
      { id: 'grp_dupla', name: 'Dupla Pegada', order: 2, minCoverage: 1, repeatHeader: false, spacerBefore: true },
      { id: 'grp_tarde', name: 'Tarde', order: 3, minCoverage: 2, repeatHeader: true, spacerBefore: true }
    ],
    employees: [
      { id: 'emp_1', name: 'RODNEY GUSTAVO', matricula: '33854', entryTime: '05:00', exitTime: '14:00', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_manha', scaleLabel: 'S/D-2', scaleColor: '#5b9bd5', ruleType: 'SD2', cycleStartDate: '2026-11-01', workDays: 6, offDays: 1, status: 'ativo', scaleChanges: [] },
      { id: 'emp_2', name: 'TIAGO PEDRO', matricula: '32992', entryTime: '05:00', exitTime: '14:00', breakMinutes: 60, hasSecondShift: false, entryTime2: '', exitTime2: '', groupId: 'grp_manha', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: 'SD1', cycleStartDate: '2026-11-01', workDays: 6, offDays: 1, status: 'ativo', scaleChanges: [] },
      { id: 'emp_3', name: 'MATHEUS ARRUDA', matricula: '39326', entryTime: '05:00', exitTime: '09:00', breakMinutes: 0, hasSecondShift: true, entryTime2: '15:00', exitTime2: '19:00', groupId: 'grp_dupla', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: '5x2', cycleStartDate: '2026-11-02', workDays: 5, offDays: 2, status: 'ativo', scaleChanges: [] }
    ],
    vacations: [], manualOverrides: {}, overtime: {}
  };
}

const Store = {
  state: null,
  runtime: { activeTab: 'dashboard', offlineMode: false, searchQuery: '', brushMode: 'F', selectedCells: new Set(), copiedRowPattern: null, previewZoom: 85, undoStack: [], redoStack: [] },
  listeners: new Set(),
  
  init() { 
    this.state = this.sanitizeAndMigrate(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
    CloudSyncAdapter.init();
  },

  sanitizeAndMigrate(raw) {
    const base = createReferenceModelState();
    if (!raw || typeof raw !== 'object') return base;
    const cStr = (v, f='') => typeof v === 'string' ? v.trim() : f;
    const cCol = (v, f) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : f;
    
    const validGrp = new Set();
    const grps = (Array.isArray(raw.groups)?raw.groups:base.groups).map((g, i) => {
      validGrp.add(cStr(g.id, `g_${i}`));
      return { id: cStr(g.id, `g_${i}`), name: cStr(g.name, `Bloco ${i}`), order: Number(g.order)||i, minCoverage: Math.max(0, Number(g.minCoverage)||1), repeatHeader: Boolean(g.repeatHeader), spacerBefore: g.spacerBefore!==false };
    });
    const fGrp = grps[0].id;

    const ids = new Set(), mats = new Set();
    const emps = (Array.isArray(raw.employees)?raw.employees:base.employees).filter(e => {
      if(ids.has(e.id) || mats.has(e.matricula)) return false;
      ids.add(e.id); mats.add(e.matricula); return true;
    }).map((e,i) => ({
      id: cStr(e.id, `emp_${i}`), name: cStr(e.name, 'SEM NOME').toUpperCase(), matricula: cStr(e.matricula, String(1000+i)),
      entryTime: cStr(e.entryTime), exitTime: cStr(e.exitTime), breakMinutes: Math.max(0, Number(e.breakMinutes)||0),
      hasSecondShift: Boolean(e.hasSecondShift), entryTime2: cStr(e.entryTime2), exitTime2: cStr(e.exitTime2),
      groupId: validGrp.has(e.groupId) ? e.groupId : fGrp, scaleLabel: cStr(e.scaleLabel, 'SD').toUpperCase(), scaleColor: cCol(e.scaleColor, '#5b9bd5'),
      ruleType: ['SD1','SD2','6x1','5x2','4x2','12x36','24x48','CUSTOM'].includes(e.ruleType)?e.ruleType:'SD1',
      cycleStartDate: /^\d{4}-\d{2}-\d{2}$/.test(e.cycleStartDate)?e.cycleStartDate:'2026-11-01', workDays: Math.max(1, Number(e.workDays)||6), offDays: Math.max(1, Number(e.offDays)||1),
      status: ['ativo','ferias','afastado'].includes(e.status)?e.status:'ativo', notes: cStr(e.notes), scaleChanges: Array.isArray(e.scaleChanges)?e.scaleChanges:[]
    }));

    const cleanMap = (map) => {
      const res = {};
      if(map) Object.keys(map).forEach(m => {
        res[m] = {};
        Object.keys(map[m]).forEach(c => { if(ids.has(c.split('_')[0])) res[m][c] = map[m][c]; });
      });
      return res;
    };

    const hols = {};
    Object.entries(raw.config?.holidaysByMonth || base.config.holidaysByMonth).forEach(([k,v]) => {
      if(/^\d{4}-\d{2}$/.test(k) && Array.isArray(v)) hols[k] = v.map(Number).filter(n=>n>=1&&n<=31);
    });

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION, rev: Number(raw.rev)||1,
      theme: raw.theme === 'light' ? 'light' : 'dark', selectedMonth: Number(raw.selectedMonth)||11, selectedYear: Number(raw.selectedYear)||2026,
      sortOrder: raw.sortOrder || 'custom',
      config: { ...base.config, ...(raw.config||{}), overtime: { ...base.config.overtime, ...(raw.config?.overtime||{}) }, holidaysByMonth: hols },
      groups: grps, employees: emps, vacations: (Array.isArray(raw.vacations)?raw.vacations:[]).filter(v => ids.has(v.employeeId)),
      manualOverrides: cleanMap(raw.manualOverrides), overtime: cleanMap(raw.overtime||{})
    };
  },

  commit(scope = 'all', skipDebounce = false) {
    if (!this.saveDebounced) this.saveDebounced = debounce((st) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      CloudSyncAdapter.pushState(st);
    }, 150);
    if(skipDebounce) { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); CloudSyncAdapter.pushState(this.state); }
    else this.saveDebounced(this.state);
    this.listeners.forEach(fn => fn(this.state, scope));
  },

  recordHistory(action) {
    this.runtime.undoStack.push({ label: action, snap: deepClone({ mo: this.state.manualOverrides, ot: this.state.overtime, emp: this.state.employees }) });
    if (this.runtime.undoStack.length > 50) this.runtime.undoStack.shift();
    this.runtime.redoStack = [];
    UI.updateHistoryBtns();
  },

  undo() {
    if (!this.runtime.undoStack.length) return;
    const p = this.runtime.undoStack.pop();
    this.runtime.redoStack.push({ label: p.label, snap: deepClone({ mo: this.state.manualOverrides, ot: this.state.overtime, emp: this.state.employees }) });
    this.state.manualOverrides = p.snap.mo; this.state.overtime = p.snap.ot; this.state.employees = p.snap.emp;
    this.commit('cells'); UI.updateHistoryBtns(); UI.toast(`Desfeito: ${p.label}`);
  },

  redo() {
    if (!this.runtime.redoStack.length) return;
    const n = this.runtime.redoStack.pop();
    this.runtime.undoStack.push({ label: n.label, snap: deepClone({ mo: this.state.manualOverrides, ot: this.state.overtime, emp: this.state.employees }) });
    this.state.manualOverrides = n.snap.mo; this.state.overtime = n.snap.ot; this.state.employees = n.snap.emp;
    this.commit('cells'); UI.updateHistoryBtns(); UI.toast(`Refeito: ${n.label}`);
  }
};

// ============================================================================
// 5. RENDERER E DOM PATCHING CIRÚRGICO
// ============================================================================
const Renderer = {
  debouncedAnalytics: debounce((state) => {
    const a = ScheduleEngine.analyzeMonth(state, state.selectedYear, state.selectedMonth);
    UI.renderDashboardStats(state, a);
    UI.renderReports(state, a);
  }, 120),

  buildSheetHTML(state, interactive) {
    const y = state.selectedYear, m = state.selectedMonth, dList = ScheduleEngine.getVisibleDays(state, y, m);
    const emps = state.employees.filter(e => !interactive || !Store.runtime.searchQuery || e.name.toLowerCase().includes(Store.runtime.searchQuery.toLowerCase()));
    
    const thead = `<tr><th>Peg.</th><th>Larg.</th><th>Matrícula</th><th>Assistentes:</th><th>Escala</th>${dList.map(d=>`<th>${d}</th>`).join('')}</tr>`;
    let html = `<div class="official-sheet-paper ${interactive?'interactive-sheet':''}" style="width:${384+dList.length*25+16}px"><table class="fleet-schedule-table" style="width:${384+dList.length*25}px">`;
    html += `<colgroup><col class="col-peg"><col class="col-larg"><col class="col-mat"><col class="col-name"><col class="col-scale">${dList.map(()=>`<col class="col-day">`).join('')}</colgroup>`;
    html += `<thead><tr class="row-main-title"><th colspan="${5+dList.length}">${escapeHTML(state.config.sectorTitle)}</th></tr><tr><th colspan="3">${escapeHTML(state.config.leftBadge)}</th><th colspan="${2+dList.length}">${escapeHTML(state.config.customSubtitle||`ESCALA DE ${MONTH_NAMES[m-1]}${y}`)}</th></tr>${thead}`;
    if(state.config.showWeekdayRow) html += `<tr class="row-weekdays"><th colspan="5">DIA DA SEMANA</th>${dList.map(d=>`<th>${WEEKDAY_LETTERS[ScheduleEngine.getDayOfWeekUTC(y,m,d)]}</th>`).join('')}</tr>`;
    html += `</thead><tbody>`;

    const activeEmps = [], fVacEmps = [];
    emps.forEach(e => ScheduleEngine.isEmployeeInFooterVacation(state, e, y, m) ? fVacEmps.push(e) : activeEmps.push(e));

    state.groups.sort((a,b)=>a.order-b.order).forEach((grp, idx) => {
      const gE = activeEmps.filter(e => e.groupId === grp.id);
      if(!gE.length) return;
      if(idx > 0) {
        if(grp.spacerBefore) html += `<tr><td colspan="${5+dList.length}" style="background:#f2f2f2;height:20px;"></td></tr>`;
        if(grp.repeatHeader) html += thead;
      }
      gE.forEach(emp => {
        const effRule = ScheduleEngine.getEffectiveRule(emp, ScheduleEngine.formatDateISO(y, m, dList[0]));
        html += `<tr data-row-emp="${emp.id}"><td>${emp.entryTime}</td><td>${emp.exitTime}</td><td>${emp.matricula}</td><td class="cell-name" data-select-row="${emp.id}">${escapeHTML(emp.name)}</td><td class="cell-scale-badge" style="background:${emp.scaleColor}" data-ctx-emp="${emp.id}">${escapeHTML(effRule.scaleLabel)}</td>`;
        dList.forEach(d => {
          const c = ScheduleEngine.resolveCell(state, emp, y, m, d);
          const sel = interactive && Store.runtime.selectedCells.has(`${emp.id}|${d}`);
          let cls = `cell-day ${c.isWeekend?'is-weekend':''} ${c.isYellow?'is-yellow':''} ${c.status==='FER'?'is-vacation':''} ${c.status==='AF'?'is-leave':''} ${interactive&&c.isManualDiff?'is-manual':''} ${sel?'cell-selected':''}`;
          let txt = c.displayText;
          if(c.otMins && state.config.overtime.showOnSheet) txt += `<span class="he-mini">${c.otMins/60}h</span>`;
          else if(interactive && c.otMins) txt += `<span class="he-indicator"></span>`;
          html += `<td class="${cls}" data-emp-id="${emp.id}" data-day="${d}" ${interactive?`tabindex="0"`:''}>${txt}</td>`;
        });
        html += `</tr>`;
        if(emp.hasSecondShift) html += `<tr class="row-second-shift"><td>${emp.entryTime2}</td><td>${emp.exitTime2}</td><td colspan="${dList.length+2}" style="background:#f2f2f2"></td></tr>`;
      });
    });

    if(fVacEmps.length) {
      html += `<tr><td colspan="${5+dList.length}" style="border:none;"></td></tr>`;
      fVacEmps.forEach(emp => {
        html += `<tr class="row-vacation-bar"><td></td><td></td><td>${emp.matricula}</td><td>${escapeHTML(emp.name)}</td><td class="cell-scale-badge" style="background:${emp.scaleColor}">${escapeHTML(emp.scaleLabel)}</td><td colspan="${dList.length}" class="vacation-merged-banner">FÉRIAS</td></tr>`;
      });
    }
    return html + `</tbody></table></div>`;
  },

  patchGrid(state, changedKeys = null, forceFull = false) {
    if(forceFull || !changedKeys) {
      if($('editorGridContainer')) $('editorGridContainer').innerHTML = this.buildSheetHTML(state, true);
      if($('liveOfficialPreviewMount')) $('liveOfficialPreviewMount').innerHTML = this.buildSheetHTML(state, false);
      return;
    }
    const y = state.selectedYear, m = state.selectedMonth;
    changedKeys.forEach(k => {
      const [eId, d] = k.split('|');
      const emp = state.employees.find(e => e.id === eId);
      if(!emp) return;
      const c = ScheduleEngine.resolveCell(state, emp, y, m, Number(d));
      $$(`td.cell-day[data-emp-id="${eId}"][data-day="${d}"]`).forEach(td => {
        td.className = `cell-day ${c.isWeekend?'is-weekend':''} ${c.isYellow?'is-yellow':''} ${c.status==='FER'?'is-vacation':''} ${c.status==='AF'?'is-leave':''} ${c.isManualDiff?'is-manual':''} ${Store.runtime.selectedCells.has(k)?'cell-selected':''}`;
        let txt = c.displayText;
        if(c.otMins && state.config.overtime.showOnSheet) txt += `<span class="he-mini">${c.otMins/60}h</span>`;
        else if(td.closest('.interactive-sheet') && c.otMins) txt += `<span class="he-indicator"></span>`;
        td.innerHTML = txt;
      });
    });
  },

  renderAll(state, scope) {
    document.documentElement.setAttribute('data-theme', state.theme);
    const c = state.config.colors;
    const r = document.documentElement.style;
    r.setProperty('--sheet-header-bg', c.headerBg); r.setProperty('--sheet-yellow', c.yellowHighlight);
    r.setProperty('--sheet-weekend', c.weekendBg); r.setProperty('--sheet-scale', c.scaleBadge);

    if($('topMonthSelect')) $('topMonthSelect').value = state.selectedMonth; 
    if($('topYearInput')) $('topYearInput').value = state.selectedYear;
    if($('chkShowWorkSymbol')) $('chkShowWorkSymbol').checked = state.config.showWorkSymbol; 
    if($('lblWorkSym')) $('lblWorkSym').textContent = state.config.symbols.work;
    if($('chkShowWeekdayRow')) $('chkShowWeekdayRow').checked = state.config.showWeekdayRow; 
    if($('chkShowHESheet')) $('chkShowHESheet').checked = state.config.overtime.showOnSheet;
    
    if(scope === 'all' || scope === 'cells') {
      this.patchGrid(state, null, true);
      this.debouncedAnalytics(state);
    }
  }
};

// ============================================================================
// 6. EXPORTAÇÃO COMPLETA
// ============================================================================
const ExportService = {
  getDayChunks(state, splitMode) {
    const dList = ScheduleEngine.getVisibleDays(state, state.selectedYear, state.selectedMonth);
    if(splitMode === 'fortnight' && dList.length > 15) return [dList.filter(d=>d<=15), dList.filter(d=>d>15)];
    return [dList];
  },

  async renderCanvases(state, splitMode, scaleF) {
    const chunks = this.getDayChunks(state, splitMode), canvases = [], staging = $('printStagingArea');
    for(const chunk of chunks) {
      staging.innerHTML = Renderer.buildSheetHTML(state, { interactive: false, ignoreSearch: true, customDays: chunk });
      const p = staging.querySelector('.official-sheet-paper');
      const expectedW = 384 + chunk.length * 25 + 16;
      if(window.html2canvas) {
        try {
          const c = await window.html2canvas(p, { scale: scaleF, backgroundColor: '#ffffff', width: expectedW, windowWidth: expectedW+40 });
          canvases.push(c);
        } catch(e) { canvases.push(this.fallbackCanvas(expectedW)); }
      } else canvases.push(this.fallbackCanvas(expectedW));
    }
    return canvases;
  },

  fallbackCanvas(w) {
    const c = document.createElement('canvas'); c.width = w; c.height = 100;
    const ctx = c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,100);
    ctx.fillStyle='#000'; ctx.fillText('Fallback Ativado. Use Exportar PDF.', 20, 50); return c;
  },

  async generatePNG(state) {
    UI.toast('A gerar imagem PNG...', 'warn');
    const split = $('exportSplitMode')?.value || 'full', scale = Number($('exportScaleSelect')?.value)||2;
    const canvases = await this.renderCanvases(state, split, scale);
    
    const final = document.createElement('canvas');
    final.width = Math.max(...canvases.map(c=>c.width));
    final.height = canvases.reduce((a,c)=>a+c.height, 0) + (canvases.length-1)*60;
    const ctx = final.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,final.width,final.height);
    let y = 0; canvases.forEach(c => { ctx.drawImage(c, 0, y); y += c.height + 60; });

    const url = final.toDataURL('image/png');
    if($('exportImageResultBox')) $('exportImageResultBox').innerHTML = `<img src="${url}">`;
    if($('exportRenderStatus')) $('exportRenderStatus').textContent = `Pronto (${final.width}x${final.height}px)`;
    if($('btnDownloadPng')) $('btnDownloadPng').disabled = false; 
    Store.runtime.lastGeneratedPngUrl = url;
    UI.toast('PNG gerado!'); return url;
  },

  async exportPDF(state) {
    UI.toast('Preparando documento PDF...');
    const split = $('exportSplitMode')?.value || 'full', scale = Number($('exportScaleSelect')?.value)||2;
    const canvases = await this.renderCanvases(state, split, scale);
    if(!window.jspdf || !window.jspdf.jsPDF) return window.print();

    const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const useW = pdf.internal.pageSize.getWidth() - 14, useH = pdf.internal.pageSize.getHeight() - 14;
    let first = true;

    canvases.forEach(c => {
      const hMm = useW * (c.height / c.width);
      if(hMm <= useH) {
        if(!first) pdf.addPage('a4', 'landscape');
        first = false; pdf.addImage(c.toDataURL('image/png'), 'PNG', 7, 7, useW, hMm);
      } else {
        const pxMm = c.width / useW, slicePx = Math.floor(useH * pxMm);
        let oy = 0;
        while(oy < c.height) {
          if(!first) pdf.addPage('a4', 'landscape');
          first = false;
          const cp = Math.min(slicePx, c.height - oy);
          const sc = document.createElement('canvas'); sc.width = c.width; sc.height = cp;
          sc.getContext('2d').drawImage(c, 0, oy, c.width, cp, 0, 0, c.width, cp);
          pdf.addImage(sc.toDataURL('image/png'), 'PNG', 7, 7, useW, cp/pxMm);
          oy += cp;
        }
      }
    });
    pdf.save(`ESCALA_${MONTH_NAMES[state.selectedMonth-1]}_${state.selectedYear}.pdf`);
    UI.toast('PDF guardado!');
  },

  exportCSV(state) {
    const y = state.selectedYear, m = state.selectedMonth;
    const days = ScheduleEngine.getVisibleDays(state, y, m);
    const a = ScheduleEngine.analyzeMonth(state, y, m);
    
    const hCols = ['Peg.','Larg.','2a Peg.','2a Larg.','Matricula','Assistente','Bloco','Escala', ...days.map(d=>`Dia ${d}`), 'Trabalhados','Folgas','Feriados/Ferias','Base (h)','HE 50% (h)','HE 100% (h)','Banco (h)','Total c/ HE (h)'];
    const lines = [hCols.map(escapeCSV).join(';')];

    Renderer.getProcessedEmployees(state, true).forEach(emp => {
      const g = state.groups.find(x => x.id === emp.groupId);
      const em = a.mtx[emp.id];
      const dVals = days.map(d => em.inFt ? 'FERIAS' : ScheduleEngine.resolveCell(state, emp, y, m, d).status);
      const r = [
        emp.entryTime, emp.exitTime, emp.hasSecondShift?emp.entryTime2:'', emp.hasSecondShift?emp.exitTime2:'',
        emp.matricula, emp.name, g?g.name:'', emp.scaleLabel, ...dVals,
        em.wD, em.fD, em.specialDaysCount, em.baseHours.toFixed(1), (em.o50/60).toFixed(1), (em.o100/60).toFixed(1), (em.oBan/60).toFixed(1), em.tH.toFixed(1)
      ];
      lines.push(r.map(escapeCSV).join(';'));
    });

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement('a'); aEl.href = url; aEl.download = `RELATORIO_${MONTH_NAMES[m-1]}_${y}.csv`;
    document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl); URL.revokeObjectURL(url);
    UI.toast('CSV Exportado com sucesso!');
  }
};

// ============================================================================
// 7. UI GERAL & EVENTOS (Interage com auth.js via EventListener)
// ============================================================================
const UI = {
  isDraggingFolga: false, dragStartCell: null, isSelectingMass: false,

  init() {
    this.bindSidebar(); this.bindGridEvents(); this.bindContextBar(); this.bindForms();
    this.bindPopover(); this.bindShortcuts(); this.listenAuthEvents();
    
    // Configura interface inicial local
    CloudSyncAdapter.init();
  },

  toast(msg, type='ok') {
    const t = document.createElement('div'); t.className = `toast-item ${type}`; t.textContent = msg;
    if($('toastContainer')) { $('toastContainer').appendChild(t); setTimeout(() => t.remove(), 3000); }
  },

  updateCloudBadge(text, color) {
    if($('topCloudStatus')) { $('topCloudStatus').textContent = text; $('topCloudStatus').style.color = color; $('topCloudStatus').style.borderColor = color; }
  },

  updateHistoryBtns() {
    if($('undoCountBadge')) $('undoCountBadge').textContent = Store.runtime.undoStack.length;
    if($('btnUndo')) $('btnUndo').disabled = !Store.runtime.undoStack.length;
    if($('redoCountBadge')) $('redoCountBadge').textContent = Store.runtime.redoStack.length;
    if($('btnRedo')) $('btnRedo').disabled = !Store.runtime.redoStack.length;
  },

  listenAuthEvents() {
    // Estes eventos são emitidos pelo auth.js
    window.addEventListener('auth-success', async (e) => {
      Store.runtime.offlineMode = false;
      await CloudSyncAdapter.onAuthSuccess(e.detail.user);
    });
    window.addEventListener('auth-logout', () => {
      CloudSyncAdapter.onAuthLogout();
    });
    window.addEventListener('app-offline-mode', () => {
      Store.runtime.offlineMode = true;
    });
  },

  bindSidebar() {
    $$('.nav-item').forEach(b => b.addEventListener('click', () => {
      $$('.nav-item, .tab-panel').forEach(el => el.classList.remove('active'));
      b.classList.add('active'); 
      if($(`tab-${b.dataset.tab}`)) $(`tab-${b.dataset.tab}`).classList.add('active');
      Store.runtime.activeTab = b.dataset.tab;
    }));
    $$('[data-switch-tab]').forEach(b => b.addEventListener('click', () => {
      $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === b.dataset.switchTab));
      $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${b.dataset.switchTab}`));
      Store.runtime.activeTab = b.dataset.switchTab;
    }));
    if($('btnToggleSidebar')) $('btnToggleSidebar').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
    if($('btnTogglePreviewPane')) $('btnTogglePreviewPane').addEventListener('click', () => {
      $('workspaceSplit').classList.toggle('preview-hidden'); $('workspaceSplit').classList.remove('preview-maximized');
    });
    if($('btnUndo')) $('btnUndo').addEventListener('click', () => Store.undo());
    if($('btnRedo')) $('btnRedo').addEventListener('click', () => Store.redo());
    if($('btnThemeToggle')) $('btnThemeToggle').addEventListener('click', () => { Store.state.theme = Store.state.theme==='light'?'dark':'light'; Store.commit('all'); });
    if($('btnSidebarGeneratePng')) $('btnSidebarGeneratePng').addEventListener('click', () => { $$('[data-tab="exportar"]')[0].click(); ExportService.generatePNG(Store.state); });

    if($('topMonthSelect')) {
      $('topMonthSelect').innerHTML = MONTH_NAMES.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('');
      $('topMonthSelect').addEventListener('change', e => { Store.state.selectedMonth = Number(e.target.value); Store.commit('all'); });
    }
    if($('topYearInput')) $('topYearInput').addEventListener('change', e => { Store.state.selectedYear = Number(e.target.value); Store.commit('all'); });
    if($('globalSearchInput')) $('globalSearchInput').addEventListener('input', e => { Store.runtime.searchQuery = e.target.value; Renderer.renderAll(Store.state, Store.runtime.activeTab); });
  },

  applyBrush(empId, day, mode) {
    const mK = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
    if (!Store.state.manualOverrides[mK]) Store.state.manualOverrides[mK] = {};
    const cK = `${empId}_${day}`;
    if (mode === 'A') delete Store.state.manualOverrides[mK][cK];
    else if (mode === 'Y') Store.state.manualOverrides[mK][cK] = { status: 'F', yellow: 'yes', note: '' };
    else if (mode === 'HE') {
      if(!Store.state.overtime[mK]) Store.state.overtime[mK] = {};
      Store.state.overtime[mK][cK] = { minutes: 60, kind: 'AUTO', note: 'Rápido' };
    } else Store.state.manualOverrides[mK][cK] = { status: mode, yellow: 'default', note: '' };
  },

  bindGridEvents() {
    const grid = $('editorGridContainer');
    if(!grid) return;
    let painting = false, pSet = new Set();

    grid.addEventListener('mousedown', e => {
      if (e.button === 2) return;
      const trName = e.target.closest('td.cell-name');
      if (trName && e.ctrlKey) {
         Store.runtime.selectedRowEmpId = trName.dataset.selectRow;
         const days = ScheduleEngine.getVisibleDays(Store.state, Store.state.selectedYear, Store.state.selectedMonth);
         days.forEach(d => Store.runtime.selectedCells.add(`${trName.dataset.selectRow}|${d}`));
         this.updateContextBar(); Renderer.patchGrid(Store.state, null, true); return;
      }
      const td = e.target.closest('td.cell-day');
      if(!td) return;
      const eId = td.dataset.empId, d = Number(td.dataset.day), k = `${eId}|${d}`;
      
      if(td.textContent.trim() === 'F' && e.shiftKey) {
        this.isDraggingFolga = true; this.dragStartCell = {eId, d}; return;
      }
      if(Store.runtime.brushMode === 'MODAL' || e.detail === 2) {
        this.openCellModal(eId, d); return;
      }

      this.isSelectingMass = e.shiftKey;
      if (this.isSelectingMass) {
        Store.runtime.selectedCells.add(k); this.updateContextBar(); Renderer.patchGrid(Store.state, [k]); return;
      }

      Store.recordHistory(`Pintar (${Store.runtime.brushMode})`);
      painting = true; pSet.clear(); pSet.add(k);
      this.applyBrush(eId, d, Store.runtime.brushMode);
      Renderer.patchGrid(Store.state, [k]);
    });

    grid.addEventListener('mouseover', e => {
      const td = e.target.closest('td.cell-day');
      if(!td) return;
      const eId = td.dataset.empId, d = Number(td.dataset.day), k = `${eId}|${d}`;
      
      if (this.isSelectingMass) {
        Store.runtime.selectedCells.add(k); this.updateContextBar(); Renderer.patchGrid(Store.state, [k]); return;
      }
      if(painting && !pSet.has(k)) {
        pSet.add(k); this.applyBrush(eId, d, Store.runtime.brushMode); Renderer.patchGrid(Store.state, [k]);
      }
    });

    window.addEventListener('mouseup', e => {
      if(painting) { painting = false; Store.commit('cells'); Renderer.debouncedAnalytics(Store.state); }
      if(this.isSelectingMass) this.isSelectingMass = false;
      
      if(this.isDraggingFolga) {
        const td = e.target.closest('td.cell-day');
        if(td && td.dataset.empId === this.dragStartCell.eId && Number(td.dataset.day) !== this.dragStartCell.d) {
          Store.recordHistory('Mover folga');
          this.applyBrush(this.dragStartCell.eId, this.dragStartCell.d, 'A');
          this.applyBrush(td.dataset.empId, Number(td.dataset.day), 'F');
          Store.commit('cells');
          Renderer.patchGrid(Store.state, [`${this.dragStartCell.eId}|${this.dragStartCell.d}`, `${td.dataset.empId}|${td.dataset.day}`]);
          this.toast('Folga movida!', 'ok');
        }
        this.isDraggingFolga = false;
      }
    });

    grid.addEventListener('contextmenu', e => {
      const scaleBadge = e.target.closest('.cell-scale-badge');
      if (scaleBadge) {
        e.preventDefault();
        const rect = scaleBadge.getBoundingClientRect();
        this.openPopover(scaleBadge.dataset.ctxEmp, rect.right + 5, rect.top);
      }
    });
  },

  bindContextBar() {
    $$('.brush-btn').forEach(b => {
      b.addEventListener('click', () => {
        Store.runtime.brushMode = b.dataset.brush;
        $$('.brush-btn').forEach(x => x.classList.remove('active')); b.classList.add('active');
      });
    });

    if($('btnContextApplyBrush')) $('btnContextApplyBrush').addEventListener('click', () => {
      if(!Store.runtime.selectedCells.size) return;
      Store.recordHistory(`Massa: ${Store.runtime.brushMode}`);
      Store.runtime.selectedCells.forEach(k => {
        const [eId, d] = k.split('|'); this.applyBrush(eId, Number(d), Store.runtime.brushMode);
      });
      Store.commit('cells'); Renderer.patchGrid(Store.state, Array.from(Store.runtime.selectedCells));
    });

    if($('btnContextClear')) $('btnContextClear').addEventListener('click', () => {
      Store.runtime.selectedCells.clear(); this.updateContextBar(); Renderer.patchGrid(Store.state, null, true);
    });

    if($('btnCopyRow')) $('btnCopyRow').addEventListener('click', () => {
      const empId = Store.runtime.selectedRowEmpId;
      if (!empId) return this.toast('Selecione uma linha (Ctrl+Clique no nome).', 'warn');
      const y = Store.state.selectedYear, m = Store.state.selectedMonth;
      const emp = Store.state.employees.find(e => e.id === empId);
      const pattern = {};
      ScheduleEngine.getVisibleDays(Store.state, y, m).forEach(d => {
        const r = ScheduleEngine.resolveCell(Store.state, emp, y, m, d);
        pattern[d] = { status: r.status, yellow: r.isYellow ? 'yes' : 'default' };
      });
      Store.runtime.copiedRowPattern = { sourceName: emp.name, pattern };
      if($('btnPasteRow')) $('btnPasteRow').disabled = false; this.toast(`Linha de ${emp.name} copiada!`);
    });

    if($('btnPasteRow')) $('btnPasteRow').addEventListener('click', () => {
      const empId = Store.runtime.selectedRowEmpId;
      const copied = Store.runtime.copiedRowPattern;
      if (!empId || !copied) return this.toast('Selecione o funcionário destino para colar.', 'warn');
      Store.recordHistory(`Colar linha`);
      const mK = ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth);
      if (!Store.state.manualOverrides[mK]) Store.state.manualOverrides[mK] = {};
      Object.entries(copied.pattern).forEach(([dStr, val]) => {
        Store.state.manualOverrides[mK][`${empId}_${dStr}`] = { status: val.status, yellow: val.yellow, note: `Colado` };
      });
      Store.commit('cells'); Renderer.patchGrid(Store.state, null, true);
      this.toast(`Padrão colado!`);
    });
  },

  updateContextBar() {
    if($('contextActionBar')) $('contextActionBar').hidden = Store.runtime.selectedCells.size < 2;
  },

  bindPopover() {
    if($('btnPopoverCancel')) $('btnPopoverCancel').onclick = () => { $('scalePopoverMenu').hidden = true; };
  },

  openPopover(empId, x, y) {
    const emp = Store.state.employees.find(e => e.id === empId);
    if (!emp || !$('scalePopoverMenu')) return;
    const pop = $('scalePopoverMenu');
    $('popoverEmpName').textContent = emp.name;
    $('popoverRuleSelect').value = emp.ruleType;
    $('popoverFromDate').value = ScheduleEngine.formatDateISO(Store.state.selectedYear, Store.state.selectedMonth, 1);
    
    pop.style.left = `${x}px`; pop.style.top = `${y}px`; pop.hidden = false;
    
    const applyShift = (days) => {
      Store.recordHistory(`Deslocar Ciclo (${days}d)`);
      const dt = new Date($('popoverFromDate').value); dt.setUTCDate(dt.getUTCDate() + days);
      emp.scaleChanges.push({ from: $('popoverFromDate').value, ruleType: emp.ruleType, cycleStartDate: dt.toISOString().split('T')[0], scaleLabel: emp.scaleLabel, workDays: emp.workDays, offDays: emp.offDays });
      Store.commit('all'); pop.hidden = true; this.toast('Fase deslocada!');
    };

    $('btnPopoverInvert').onclick = () => {
      Store.recordHistory('Inverter Fase S/D');
      const newR = emp.ruleType === 'SD1' ? 'SD2' : (emp.ruleType === 'SD2' ? 'SD1' : emp.ruleType);
      if(newR === emp.ruleType) return applyShift(7);
      emp.scaleChanges.push({ from: $('popoverFromDate').value, ruleType: newR, cycleStartDate: emp.cycleStartDate, scaleLabel: newR, workDays: emp.workDays, offDays: emp.offDays });
      Store.commit('all'); pop.hidden = true; this.toast('Fase S/D Invertida!');
    };
    $('btnPopoverShiftLeft').onclick = () => applyShift(-1);
    $('btnPopoverShiftRight').onclick = () => applyShift(1);
    
    $('btnPopoverApply').onclick = () => {
      Store.recordHistory('Nova Regra Adicionada');
      emp.scaleChanges.push({ from: $('popoverFromDate').value, ruleType: $('popoverRuleSelect').value, cycleStartDate: $('popoverFromDate').value, scaleLabel: $('popoverRuleSelect').value, workDays: emp.workDays, offDays: emp.offDays });
      Store.commit('all'); pop.hidden = true; this.toast('Nova regra aplicada a partir da data!');
    };
  },

  openCellModal(empId, day) {
    const emp = Store.state.employees.find(e => e.id === empId);
    if (!emp || !$('cellModal')) return;
    const y = Store.state.selectedYear, m = Store.state.selectedMonth, mK = ScheduleEngine.getMonthKey(y, m);
    const man = Store.state.manualOverrides[mK]?.[`${empId}_${day}`];
    const ot = Store.state.overtime[mK]?.[`${empId}_${day}`];
    const c = ScheduleEngine.resolveCell(Store.state, emp, y, m, day);

    $('cellModalTitle').textContent = `Dia ${day}/${m}/${y} - ${emp.name}`;
    $('cellModalInfo').textContent = `Status Auto: ${c.autoStatus} | Regra: ${c.ruleObj.ruleType}`;
    $('cellModalStatus').value = man && man.status !== 'AUTO' ? man.status : 'AUTO';
    $('cellModalYellow').value = man?.yellow || 'default';
    $('cellModalNote').value = man?.note || '';
    $('cellModalHE').value = ot && ot.minutes ? ot.minutes : '';
    $('cellModalHEType').value = ot?.kind || 'AUTO';

    $$('[data-quick-he]').forEach(b => b.onclick = () => {
      const add = Number(b.dataset.quickHe);
      if(add === 0) $('cellModalHE').value = '';
      else $('cellModalHE').value = (Number($('cellModalHE').value)||0) + add;
    });

    $('cellModal').hidden = false;
    $('formCellModal').onsubmit = (e) => {
      e.preventDefault();
      Store.recordHistory('Edição Completa (Célula/HE)');
      if(!Store.state.manualOverrides[mK]) Store.state.manualOverrides[mK] = {};
      if(!Store.state.overtime[mK]) Store.state.overtime[mK] = {};

      const st = $('cellModalStatus').value, yl = $('cellModalYellow').value, nt = $('cellModalNote').value;
      if (st==='AUTO' && yl==='default' && !nt) delete Store.state.manualOverrides[mK][`${empId}_${day}`];
      else Store.state.manualOverrides[mK][`${empId}_${day}`] = { status: st, yellow: yl, note: nt };

      const he = parseTime($('cellModalHE').value);
      if(he > 0) Store.state.overtime[mK][`${empId}_${day}`] = { minutes: he, kind: $('cellModalHEType').value, note: '' };
      else delete Store.state.overtime[mK][`${empId}_${day}`];

      Store.commit('cells'); $('cellModal').hidden = true;
    };
    if($('btnCancelCellModal')) $('btnCancelCellModal').onclick = () => $('cellModal').hidden = true;
    if($('btnCloseCellModal')) $('btnCloseCellModal').onclick = () => $('cellModal').hidden = true;
  },

  bindForms() {
    // Zoom Preview
    const slider = $('previewZoomSlider'), valBadge = $('previewZoomValue'), stage = $('previewScaleStage');
    if(slider) slider.addEventListener('input', e => {
      const z = Math.max(50, Math.min(200, Number(e.target.value) || 85));
      Store.runtime.previewZoom = z; valBadge.textContent = `${z}%`; stage.style.transform = `scale(${z / 100})`;
    });
    if($('btnZoomOut')) $('btnZoomOut').addEventListener('click', () => { slider.value = Store.runtime.previewZoom - 10; slider.dispatchEvent(new Event('input')); });
    if($('btnZoomIn')) $('btnZoomIn').addEventListener('click', () => { slider.value = Store.runtime.previewZoom + 10; slider.dispatchEvent(new Event('input')); });
    if($('btnZoomFit')) $('btnZoomFit').addEventListener('click', () => {
      const vp = $('previewViewport'), p = document.querySelector('#liveOfficialPreviewMount .official-sheet-paper');
      if (vp && p) { slider.value = Math.floor(((vp.clientWidth - 36) / p.scrollWidth) * 100); slider.dispatchEvent(new Event('input')); }
    });

    if($('btnNewEmployee')) $('btnNewEmployee').onclick = () => { if($('employeeModal')) $('employeeModal').hidden = false; };
    if($('btnCancelEmpModal')) $('btnCancelEmpModal').onclick = () => { $('employeeModal').hidden = true; };
    if($('btnCloseEmpModal')) $('btnCloseEmpModal').onclick = () => { $('employeeModal').hidden = true; };

    if($('btnGeneratePngMain')) $('btnGeneratePngMain').onclick = () => ExportService.generatePNG(Store.state);
    if($('btnDownloadPng')) $('btnDownloadPng').onclick = () => ExportService.downloadPNG(Store.state);
    if($('btnExportPdf')) $('btnExportPdf').onclick = () => ExportService.exportPDF(Store.state);
    if($('btnPrintSchedule')) $('btnPrintSchedule').onclick = () => ExportService.printSchedule(Store.state);
    if($('btnExportCsvDirect')) $('btnExportCsvDirect').onclick = () => ExportService.exportCSV(Store.state);
    if($('btnExportReportCsv')) $('btnExportReportCsv').onclick = () => ExportService.exportCSV(Store.state);

    if($('btnRestoreReference')) $('btnRestoreReference').onclick = async () => {
      const ok = await this.openDialog({ title: 'Modelo de Referência', message: 'Carregar modelo Nov/2026? Apagará os dados atuais.' });
      if(ok) { Store.recordHistory('Modelo Ref'); Store.state = createReferenceModelState(); Store.commit('all'); this.toast('Modelo carregado!'); }
    };
    if($('btnWipeAll')) $('btnWipeAll').onclick = async () => {
      const ok = await this.openDialog({ title: 'Limpar Tudo', message: 'Isto irá APAGAR TODOS os funcionários e dados locais. Tem a certeza?' });
      if(ok) { Store.recordHistory('Limpeza'); Store.state.employees=[]; Store.state.vacations=[]; Store.state.manualOverrides={}; Store.commit('all'); this.toast('Dados limpos.'); }
    };

    if($('cfgRequireLogin')) $('cfgRequireLogin').onchange = e => { 
      Store.state.config.requireLogin = e.target.checked; 
      Store.commit('all'); 
      if(e.target.checked && !CloudSyncAdapter.user && $('loginScreen')) $('loginScreen').hidden = false; 
    };
  },

  bindShortcuts() {
    window.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName;
      if (tag==='INPUT' || tag==='TEXTAREA' || tag==='SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); Store.undo(); }
      else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); Store.redo(); }
      else if (e.key === 'Escape') {
        Store.runtime.selectedCells.clear();
        this.updateContextBar();
        if($('scalePopoverMenu')) $('scalePopoverMenu').hidden = true;
        if($('cellModal')) $('cellModal').hidden = true;
        if($('employeeModal')) $('employeeModal').hidden = true;
        Renderer.patchGrid(Store.state, null, true);
      }
    });
  },

  renderDashboardStats(state, a) {
    if($('empTotalCount')) $('empTotalCount').textContent = a.totalEmployees;
    if($('alertsCountBadge')) $('alertsCountBadge').textContent = a.alerts.length;
    const dK = $('dashboardKpis');
    if(dK) dK.innerHTML = `
      <div class="kpi-box"><div class="kpi-label">Efetivo Ativo</div><div class="kpi-val">${a.act}</div><div class="kpi-sub">Total: ${a.totalEmployees}</div></div>
      <div class="kpi-box warn"><div class="kpi-label">Férias (Rodapé)</div><div class="kpi-val">${a.ftVac}</div></div>
      <div class="kpi-box"><div class="kpi-label">Horas Previstas</div><div class="kpi-val">${Math.round(Object.values(a.mtx).reduce((s,x)=>s+x.tH,0))}h</div></div>
      <div class="kpi-box ${a.cov < 100 ? 'danger' : ''}"><div class="kpi-label">Cobertura (Mín: ${state.config.minCoverage})</div><div class="kpi-val">${a.cov}%</div></div>
    `;
    const ul = $('dashboardAlertsList');
    if(ul) ul.innerHTML = a.alerts.map((al,i) => `<li class="alert-row ${escapeHTML(al.severity)}" data-aid="${i}"><strong>[${al.severity.toUpperCase()}]</strong> ${escapeHTML(al.text)}</li>`).join('');
  },

  renderReports(state, a) {
    const bb = $('reportBlocksBody');
    if(bb) bb.innerHTML = a.bMetrics.map(b => `<tr><td><strong>${escapeHTML(b.group.name)}</strong></td><td>${b.active}</td><td>${b.min}</td><td>${b.avg.toFixed(1)}</td><td>${b.minObs}</td><td>${b.totalBlockHours.toFixed(1)}h</td><td>--</td></tr>`).join('');
    
    const eb = $('reportEmployeesBody');
    if(eb) eb.innerHTML = Object.values(a.mtx).map(m => `<tr><td>${m.emp.matricula}</td><td><strong>${escapeHTML(m.emp.name)}</strong></td><td>${m.emp.entryTime}</td><td>${m.wD}</td><td>${m.baseH.toFixed(1)}h</td><td style="color:#1de9b6">${formatMins(m.o50)}</td><td style="color:#00e676">${formatMins(m.o100)}</td><td style="color:#eab308">${formatMins(m.oBan)}</td><td><strong>${m.tH.toFixed(1)}h</strong></td><td>${m.manAdj}</td></tr>`).join('');
  },

  openDialog({ title, message, showPrompt = false, promptLabel = '', defaultValue = '', confirmText = 'Confirmar', cancelText = 'Cancelar' }) {
    return new Promise((resolve) => {
      const overlay = $('dialogModal');
      $('dialogModalTitle').textContent = title || 'Confirmação';
      $('dialogModalMessage').textContent = message || '';
      $('btnDialogConfirm').textContent = confirmText;
      $('btnDialogCancel').textContent = cancelText;

      if (showPrompt) {
        $('dialogPromptWrap').hidden = false;
        $('dialogPromptLabel').textContent = promptLabel || 'Informe o valor:';
        $('dialogPromptInput').value = defaultValue || '';
      } else { $('dialogPromptWrap').hidden = true; }

      overlay.hidden = false;
      setTimeout(() => showPrompt ? $('dialogPromptInput').focus() : $('btnDialogConfirm').focus(), 20);

      const closeAndResolve = (result) => {
        overlay.hidden = true;
        $('btnDialogConfirm').removeEventListener('click', onConfirm);
        $('btnDialogCancel').removeEventListener('click', onCancel);
        $('btnCloseDialogModal').removeEventListener('click', onCancel);
        overlay.removeEventListener('keydown', onKeyDown);
        resolve(result);
      };

      const onConfirm = () => closeAndResolve(showPrompt ? $('dialogPromptInput').value.trim() : true);
      const onCancel = () => closeAndResolve(showPrompt ? null : false);
      const onKeyDown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if (e.key === 'Enter' && showPrompt) { e.preventDefault(); onConfirm(); }
      };

      $('btnDialogConfirm').addEventListener('click', onConfirm);
      $('btnDialogCancel').addEventListener('click', onCancel);
      $('btnCloseDialogModal').addEventListener('click', onCancel);
      overlay.addEventListener('keydown', onKeyDown);
    });
  }
};

// ============================================================================
// 8. AUTOTESTES DO MOTOR (22 TESTES DE QUALIDADE)
// ============================================================================
window.runSelfTests = function() {
  const r = []; const ok = (n, c) => r.push({n, p: Boolean(c)});
  ok('1. Bissexto (2024=29, 2026=28)', ScheduleEngine.getDaysInMonth(2024,2)===29 && ScheduleEngine.getDaysInMonth(2026,2)===28);
  const e61 = {ruleType:'6x1', cycleStartDate:'2026-11-01'};
  ok('2. 6x1 exato', ScheduleEngine.calculateRuleOnlyStatus(e61, '2026-11-06')==='T' && ScheduleEngine.calculateRuleOnlyStatus(e61, '2026-11-07')==='F');
  const e12 = {ruleType:'12x36', cycleStartDate:'2026-11-01'};
  ok('3. 12x36 Dia Sim/Não', ScheduleEngine.calculateRuleOnlyStatus(e12, '2026-11-01')==='T' && ScheduleEngine.calculateRuleOnlyStatus(e12, '2026-11-02')==='F');
  const e24 = {ruleType:'24x48', cycleStartDate:'2026-11-01'};
  ok('4. 24x48 (1 Trab/2 Folgas)', ScheduleEngine.calculateRuleOnlyStatus(e24, '2026-11-02')==='F' && ScheduleEngine.calculateRuleOnlyStatus(e24, '2026-11-04')==='T');
  ok('5. SD1 e SD2 Fases Opostas', ScheduleEngine.calculateRuleOnlyStatus({ruleType:'SD1', cycleStartDate:'2026-11-02'}, '2026-11-07') !== ScheduleEngine.calculateRuleOnlyStatus({ruleType:'SD2', cycleStartDate:'2026-11-02'}, '2026-11-07'));
  ok('6. SD1 ancorado', ScheduleEngine.calculateRuleOnlyStatus({ruleType:'SD1', cycleStartDate:'2026-11-09'}, '2026-11-07') !== ScheduleEngine.calculateRuleOnlyStatus({ruleType:'SD1', cycleStartDate:'2026-11-02'}, '2026-11-07'));
  ok('7. Interjornada Noturna (22h às 06h = 8h brutos)', ScheduleEngine.calcDailyNetHours({entryTime:'22:00', exitTime:'06:00', breakMinutes:0}) === 8);
  ok('8. Dupla Pegada Soma', ScheduleEngine.calcDailyNetHours({entryTime:'05:00', exitTime:'09:00', breakMinutes:0, hasSecondShift:true, entryTime2:'15:00', exitTime2:'19:00'}) === 8);
  
  const mState = createReferenceModelState();
  mState.vacations.push({ id:'v1', employeeId: mState.employees[0].id, type:'FERIAS', displayMode:'inline_days', startDate:'2026-11-10', endDate:'2026-11-12' });
  ok('9. Prioridade Férias > Auto', ScheduleEngine.resolveCell(mState, mState.employees[0], 2026, 11, 10).status === 'FER');
  mState.manualOverrides['2026-11'] = { [`${mState.employees[0].id}_10`]: { status: 'T' } };
  ok('10. Prioridade Manual > Férias', ScheduleEngine.resolveCell(mState, mState.employees[0], 2026, 11, 10).status === 'T');
  
  const mov = ScheduleEngine.getMovableHolidaysForYear(2026);
  ok('11. Páscoa 2026 é 05/04', mov.find(m=>m.name==='Páscoa').month===4 && mov.find(m=>m.name==='Páscoa').day===5);
  ok('12. XSS Protection EscapeHTML', !escapeHTML('<script>alert()</script>').includes('<script>'));
  ok('13. Previne CSV Injection', escapeCSV('=SUM(A1)').startsWith('"\'=SUM'));
  ok('14. Vigência ScaleChanges (Viagem Tempo)', ScheduleEngine.getEffectiveRule({ruleType:'SD1', scaleChanges:[{from:'2026-11-10', ruleType:'12x36'}]}, '2026-11-12').ruleType === '12x36');
  ok('15. ScaleChanges ignora futuro', ScheduleEngine.getEffectiveRule({ruleType:'SD1', scaleChanges:[{from:'2026-11-20', ruleType:'12x36'}]}, '2026-11-12').ruleType === 'SD1');
  
  mState.overtime['2026-11'] = { [`${mState.employees[0].id}_01`]: { minutes: 120, kind: 'AUTO' } }; // Dia 1 é Domingo
  const cellOt = ScheduleEngine.resolveCell(mState, mState.employees[0], 2026, 11, 1);
  ok('16. HE Auto 100% ao Domingo', cellOt.otKind === '100' && cellOt.otMins === 120);
  
  mState.overtime['2026-11'] = { [`${mState.employees[0].id}_04`]: { minutes: 60, kind: 'AUTO' } }; // Quarta
  ok('17. HE Auto 50% Dia Útil', ScheduleEngine.resolveCell(mState, mState.employees[0], 2026, 11, 4).otKind === '50');
  
  ok('18. Sobreposição Férias Deteção 1', ScheduleEngine.doPeriodsOverlap('2026-11-05','2026-11-15', '2026-11-12','2026-11-20'));
  ok('19. Sobreposição Férias Deteção 2', !ScheduleEngine.doPeriodsOverlap('2026-11-01','2026-11-04', '2026-11-05','2026-11-10'));
  
  const a = ScheduleEngine.analyzeMonth(mState, 2026, 11);
  ok('20. Horas Extras somam na Carga', a.mtx[mState.employees[0].id].tH > a.mtx[mState.employees[0].id].baseH);
  ok('21. Cobertura avaliada corretamente', a.cov <= 100);
  ok('22. Deep Clone protege Refs', deepClone({a:1}).a === 1);
  
  const p = r.filter(x=>x.p).length;
  if($('selfTestOutput')) $('selfTestOutput').textContent = r.map(x=>`${x.p?'[OK] ':'[FALHOU] '} ${x.n}`).join('\n') + `\n\nTotal: ${p}/${r.length} aprovados.`;
  return { passed: p, total: r.length };
};

// ============================================================================
// INICIALIZAÇÃO E ARRANQUE
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  Store.init();
  UI.init();
});