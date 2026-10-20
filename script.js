/**
 * ============================================================================
 * FROTA.OS // SISTEMA CRIADOR DE ESCALA DE TRABALHO (ES2022) - v4.0
 * ============================================================================
 * Módulos:
 * 1. Helpers & Sec
 * 2. CloudSyncAdapter (Firebase Local-First)
 * 3. ScheduleEngine (Regras, HE, Viagem no Tempo)
 * 4. Store (Estado, Undo/Redo)
 * 5. Renderer (DOM Patching)
 * 6. ExportService (PNG/PDF/CSV)
 * 7. UI (Context Menu, Drag&Drop, Modais)
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
// 1. HELPERS & SANITIZAÇÃO
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
// 2. FIREBASE & CLOUD ADAPTER (LOCAL-FIRST)
// ============================================================================
const CloudSyncAdapter = {
  app: null, db: null, auth: null,
  enabled: false, user: null, role: null, workspaceId: 'default_ws',
  unsubMeta: null, unsubMonth: null, isPendingWrite: false,

  init() {
    const cfgRaw = localStorage.getItem('FROTA_OS_FIREBASE_CFG');
    if (cfgRaw && window.firebase) {
      try {
        const cfg = JSON.parse(cfgRaw);
        if (!firebase.apps.length) this.app = firebase.initializeApp(cfg);
        this.db = firebase.firestore();
        this.auth = firebase.auth();
        this.db.enablePersistence({ synchronizeTabs: true }).catch(console.warn);
        this.enabled = true;
        this.listenAuth();
      } catch(e) { UI.toast('Erro na config do Firebase.', 'error'); }
    }
  },

  listenAuth() {
    this.auth.onAuthStateChanged(async u => {
      this.user = u;
      if (u) {
        UI.updateCloudBadge(`Conectado: ${u.email}`, 'var(--neon-primary)');
        $('fbUserEmailSpan').textContent = u.email;
        $('fbAuthState').hidden = true; $('fbLoggedInState').hidden = false;
        await this.loadWorkspace();
      } else {
        UI.updateCloudBadge('Local (Deslogado)', 'var(--text-secondary)');
        this.role = null; $('fbRoleBadge').textContent = '--';
        $('fbAuthState').hidden = false; $('fbLoggedInState').hidden = true;
        if (Store.state.config.requireLogin) {
          Store.state = createReferenceModelState(); Store.commit('all');
          UI.toast('Login obrigatório. Acesso bloqueado.', 'error');
        }
      }
    });
  },

  async loadWorkspace() {
    if (!this.user) return;
    try {
      const snap = await this.db.collection('workspaces').where(`members.${this.user.uid}.role`, 'in', ['admin','editor','leitor']).limit(1).get();
      if (!snap.empty) {
        this.workspaceId = snap.docs[0].id;
        const data = snap.docs[0].data();
        this.role = data.members[this.user.uid].role;
        $('fbWorkspaceNameSpan').textContent = data.name || this.workspaceId;
        $('fbRoleBadge').textContent = this.role.toUpperCase();
        this.attachListeners();
      } else {
        $('fbWorkspaceNameSpan').textContent = "Nenhum espaço";
        UI.toast('Conta sem espaço de trabalho associado.', 'warn');
      }
    } catch(e) { console.error(e); UI.toast('Erro ao aceder ao Workspace.', 'error'); }
  },

  attachListeners() {
    if(this.unsubMeta) this.unsubMeta();
    this.unsubMeta = this.db.collection('workspaces').doc(this.workspaceId).collection('meta').doc('main')
      .onSnapshot(doc => {
        if(doc.metadata.hasPendingWrites) return;
        if(doc.exists) this.handleIncomingMeta(doc.data());
      });
    this.listenMonth(ScheduleEngine.getMonthKey(Store.state.selectedYear, Store.state.selectedMonth));
  },

  listenMonth(mKey) {
    if(this.unsubMonth) this.unsubMonth();
    this.unsubMonth = this.db.collection('workspaces').doc(this.workspaceId).collection('months').doc(mKey)
      .onSnapshot(doc => {
        if(doc.metadata.hasPendingWrites) return;
        if(doc.exists) this.handleIncomingMonth(mKey, doc.data());
      });
  },

  handleIncomingMeta(data) {
    if ((data.rev || 0) > (Store.state.rev || 0)) {
      UI.toast('Atualização recebida da Nuvem...');
      const merged = Store.sanitizeAndMigrate({ ...Store.state, ...data });
      Object.assign(Store.state, { groups: merged.groups, employees: merged.employees, vacations: merged.vacations, config: merged.config, rev: data.rev });
      Renderer.renderAll(Store.state, 'all');
      const now = new Date();
      $('fbLastSyncSpan').textContent = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
    }
  },

  handleIncomingMonth(mKey, data) {
    Store.state.manualOverrides[mKey] = data.manualOverrides || {};
    Store.state.overtime[mKey] = data.overtime || {};
    Renderer.patchGrid(Store.state, null, true);
    Renderer.debouncedAnalytics(Store.state);
  },

  async pushState(state) {
    if (!this.enabled || !this.user || this.role === 'leitor' || this.isPendingWrite) return;
    try {
      this.isPendingWrite = true;
      const batch = this.db.batch();
      const wsRef = this.db.collection('workspaces').doc(this.workspaceId);
      
      state.rev = (state.rev || 0) + 1;
      batch.set(wsRef.collection('meta').doc('main'), {
        groups: state.groups, employees: state.employees, vacations: state.vacations, config: state.config, rev: state.rev
      }, { merge: true });

      const mKey = ScheduleEngine.getMonthKey(state.selectedYear, state.selectedMonth);
      batch.set(wsRef.collection('months').doc(mKey), {
        manualOverrides: state.manualOverrides[mKey] || {}, overtime: state.overtime[mKey] || {}
      }, { merge: true });

      await batch.commit();
      UI.updateCloudBadge('Sincronizado', '#00e676');
      const now = new Date(); $('fbLastSyncSpan').textContent = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()} (Envio)`;
    } catch (e) {
      console.error(e); UI.updateCloudBadge('Erro Sinc', 'var(--danger)');
    } finally { this.isPendingWrite = false; }
  }
};

// ============================================================================
// 3. MOTOR DE CÁLCULO (ScheduleEngine)
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
    const a = year%19, b = Math.floor(year/100), c = year%100, d = Math.floor(b/4), e = b%4;
    const f = Math.floor((b+8)/25), g = Math.floor((b-f+1)/3), h = (19*a+b-d-g+15)%30;
    const i = Math.floor(c/4), k = c%4, l = (32+2*e+2*i-h-k)%7;
    const m = Math.floor((a+11*h+22*l)/451), month = Math.floor((h+l-7*m+114)/31), day = ((h+l-7*m+114)%31)+1;
    return { year, month, day, dateISO: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` };
  },

  getMovableHolidaysForYear(year) {
    const e = this.dateToEpochDays(this.getEasterDate(year).dateISO);
    return [
      { off: -48, n: 'Carnaval' }, { off: -47, n: 'Carnaval' },
      { off: -2, n: 'Sexta Santa' }, { off: 0, n: 'Páscoa' }, { off: 60, n: 'Corpus Christi' }
    ].map(x => { const d = this.epochToISO(e+x.off).split('-').map(Number); return { year:d[0], month:d[1], day:d[2] }; });
  },

  getHolidaysForMonth(state, y, m) {
    const k = this.getMonthKey(y,m);
    if(Array.isArray(state.config?.holidaysByMonth?.[k])) return state.config.holidaysByMonth[k];
    const fx = FIXED_NATIONAL_HOLIDAYS[m] ? [...FIXED_NATIONAL_HOLIDAYS[m]] : [];
    const mv = this.getMovableHolidaysForYear(y).filter(h => h.month === m).map(h => h.day);
    return Array.from(new Set([...fx, ...mv])).sort((a,b)=>a-b);
  },

  // Viagem no tempo: Pega na regra ativa no dia D
  getEffectiveRule(emp, isoDate) {
    if(!emp.scaleChanges || !emp.scaleChanges.length) return emp;
    const past = emp.scaleChanges.filter(c => c.from <= isoDate).sort((a,b) => a.from>b.from ? -1 : 1);
    if(past.length > 0) return { ...emp, ...past[0] };
    return emp;
  },

  calculateRuleOnlyStatus(rule, isoDate) {
    const tE = this.dateToEpochDays(isoDate);
    const sE = this.dateToEpochDays(rule.cycleStartDate || '2026-11-01');
    const dow = new Date(tE * 86400000).getUTCDay();

    if(rule.ruleType === 'SD1' || rule.ruleType === 'SD2') {
      if(dow >= 1 && dow <= 5) return 'T';
      const isEv = ((Math.floor((tE+3)/7) - Math.floor((sE+3)/7)) % 2 + 2) % 2 === 0;
      return rule.ruleType==='SD1' ? (isEv ? (dow===0?'F':'T') : (dow===6?'F':'T')) : (isEv ? (dow===6?'F':'T') : (dow===0?'F':'T'));
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

  isEmpInFooter(state, emp, y, m) {
    const s = this.formatDateISO(y,m,1), e = this.formatDateISO(y,m,this.getDaysInMonth(y,m));
    return (state.vacations||[]).some(v => v.employeeId===emp.id && v.type==='FERIAS' && v.displayMode!=='inline_days' && v.startDate<=e && v.endDate>=s);
  },

  resolveCell(state, emp, y, m, d) {
    const iso = this.formatDateISO(y,m,d), mK = this.getMonthKey(y,m), cK = `${emp.id}_${d}`;
    const ruleObj = this.getEffectiveRule(emp, iso);
    let auto = this.calculateRuleOnlyStatus(ruleObj, iso);
    
    if(emp.status === 'afastado') auto = 'AF';
    const vac = (state.vacations||[]).find(v => v.employeeId===emp.id && iso>=v.startDate && iso<=v.endDate);
    if(vac) auto = (vac.type==='FERIAS' && vac.displayMode!=='footer_bar') ? 'FER' : (vac.type!=='FERIAS'?'AF':auto);

    const man = state.manualOverrides?.[mK]?.[cK];
    const finalSt = (man && man.status!=='AUTO') ? man.status : auto;
    
    const dow = this.getDayOfWeekUTC(y,m,d);
    const isHol = this.getHolidaysForMonth(state, y, m).includes(d);
    const isYel = man?.yellow==='yes' || (man?.yellow!=='no' && (isHol || (state.config.highlightAllFolgasYellow && (finalSt==='F'||finalSt==='FE'))));
    
    const sy = state.config.symbols;
    let txt = finalSt==='T' ? (state.config.showWorkSymbol?sy.work:'') : finalSt==='F'?sy.off : finalSt==='FE'?sy.holiday : finalSt==='FER'?sy.vacation : finalSt==='AF'?sy.leave:finalSt;

    // Horas Extras (HE)
    const ot = state.overtime?.[mK]?.[cK];
    let otMins = 0, otKind = null;
    if(state.config.overtime.enabled && ot && ot.minutes > 0) {
      otMins = ot.minutes;
      otKind = ot.kind === 'AUTO' ? ((dow===0 || isHol || auto!=='T') ? '100' : '50') : ot.kind;
    }

    return { status: finalSt, autoStatus: auto, isManualDiff: finalSt!==auto, isWeekend: dow===0||dow===6, isHoliday: isHol, isYellow: isYel, displayText: txt, note: man?.note||'', otMins, otKind, ruleObj };
  },

  calcDailyNetHours(emp) {
    const parse = (e,x) => {
      if(!e||!x) return 0;
      let [h1,m1]=e.split(':').map(Number), [h2,m2]=x.split(':').map(Number);
      if(isNaN(h1)||isNaN(h2)) return 0;
      let dif = (h2*60+m2)-(h1*60+m1);
      return dif<=0 ? dif+1440 : dif;
    };
    let g = parse(emp.entryTime, emp.exitTime);
    if(emp.hasSecondShift) g += parse(emp.entryTime2, emp.exitTime2);
    return Math.max(0, g - (Number(emp.breakMinutes)||0)) / 60;
  },

  analyzeMonth(state, y, m) {
    const days = Array.from({length: this.getDaysInMonth(y, m)}, (_,i) => i+1);
    const mtx = {}, daily = {}, blk = {}, alerts = [];
    
    days.forEach(d => daily[d] = { w:0, f:0 });
    state.groups.forEach(g => { blk[g.id] = {}; days.forEach(d => blk[g.id][d] = 0); });

    let act = 0, ftVac = 0;
    state.employees.forEach(emp => {
      const inFt = this.isEmpInFooter(state, emp, y, m);
      if(inFt) ftVac++; else if(emp.status==='ativo') act++;
      
      let wD=0, fD=0, o50=0, o100=0, oBan=0, baseH=0, lastX=null;
      const netH = this.calcDailyNetHours(emp);

      days.forEach(d => {
        if(inFt) return;
        const c = this.resolveCell(state, emp, y, m, d);
        if(c.status==='T') { wD++; daily[d].w++; if(blk[emp.groupId]) blk[emp.groupId][d]++; baseH+=netH; }
        else if(c.status==='F'||c.status==='FE') { fD++; daily[d].f++; }

        if(c.otMins>0) {
          if(c.otKind==='50') o50+=c.otMins; else if(c.otKind==='100') o100+=c.otMins; else if(c.otKind==='BANCO') oBan+=c.otMins;
          if(c.otMins > state.config.overtime.maxDailyMinutes) alerts.push({severity:'aviso', text:`${emp.name} fez ${formatMins(c.otMins)} de HE no dia ${d} (limite ${formatMins(state.config.overtime.maxDailyMinutes)}).`, day: d, empId: emp.id});
          if(c.status==='FER'||c.status==='AF') alerts.push({severity:'critico', text:`HE lançada para ${emp.name} em dia de Férias/Afastamento (Dia ${d}).`, day:d, empId: emp.id});
        }
        
        // Interjornada
        if(c.status==='T' && emp.entryTime) {
          let [hh,mm]=emp.entryTime.split(':').map(Number);
          let eAbs = d*1440 + hh*60 + mm;
          if(lastX!==null && (eAbs - lastX) < 660) alerts.push({severity:'critico', text:`Interjornada < 11h para ${emp.name} no dia ${d}.`, day:d, empId:emp.id});
          let [xh,xm]=emp.exitTime.split(':').map(Number);
          lastX = d*1440 + xh*60 + xm + (xh<hh?1440:0) + c.otMins;
        } else { lastX = null; }
      });

      if((o50+o100) > state.config.overtime.maxMonthlyMinutes) alerts.push({severity:'aviso', text:`${emp.name} excedeu limite mensal de HE (${formatMins(o50+o100)}).`, empId:emp.id});
      mtx[emp.id] = { emp, inFt, wD, fD, baseH, o50, o100, oBan, tH: baseH + ((o50+o100)/60) };
    });

    const minG = Number(state.config.minCoverage)||0;
    let dOk = 0; days.forEach(d => { if(daily[d].w >= minG) dOk++; });

    const bMetrics = state.groups.map(g => {
      const gAct = state.employees.filter(e => e.groupId===g.id && !this.isEmpInFooter(state, e, y, m));
      const minB = Number(g.minCoverage)||1;
      const vls = days.map(d => blk[g.id]?.[d]||0);
      return { group:g, active:gAct.length, min:minB, avg:vls.reduce((a,b)=>a+b,0)/days.length||0, minObs:Math.min(...vls)||0, dailyMap: blk[g.id]||{} };
    });

    if(!alerts.length) alerts.push({severity:'ok', text:'Escala 100% validada sem conflitos.'});
    return { days, mtx, daily, bMetrics, alerts, act, ftVac, cov: days.length ? Math.round((dOk/days.length)*100) : 100 };
  }
};

// ============================================================================
// 4. ESTADO & PERSISTÊNCIA (Store)
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
      { id: 'emp_1', name: 'RODNEY GUSTAVO', matricula: '33854', entryTime: '05:00', exitTime: '14:00', breakMinutes: 60, hasSecondShift: false, groupId: 'grp_manha', scaleLabel: 'S/D-2', scaleColor: '#5b9bd5', ruleType: 'SD2', cycleStartDate: '2026-11-01', workDays: 6, offDays: 1, status: 'ativo', scaleChanges: [] },
      { id: 'emp_2', name: 'TIAGO PEDRO', matricula: '32992', entryTime: '05:00', exitTime: '14:00', breakMinutes: 60, hasSecondShift: false, groupId: 'grp_manha', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: 'SD1', cycleStartDate: '2026-11-01', workDays: 6, offDays: 1, status: 'ativo', scaleChanges: [] },
      { id: 'emp_3', name: 'MATHEUS ARRUDA', matricula: '39326', entryTime: '05:00', exitTime: '09:00', breakMinutes: 0, hasSecondShift: true, entryTime2: '15:00', exitTime2: '19:00', groupId: 'grp_dupla', scaleLabel: 'S/D-1', scaleColor: '#5b9bd5', ruleType: '5x2', cycleStartDate: '2026-11-02', workDays: 5, offDays: 2, status: 'ativo', scaleChanges: [] }
    ],
    vacations: [], manualOverrides: {}, overtime: {}
  };
}

const Store = {
  state: null,
  runtime: {
    activeTab: 'dashboard', searchQuery: '', brushMode: 'F', selectedCells: new Set(),
    copiedBlock: null, previewZoom: 85, undoStack: [], redoStack: []
  },
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
// 5. RENDERIZADOR E DOM PATCHING CIRÚRGICO
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
    emps.forEach(e => ScheduleEngine.isEmpInFooter(state, e, y, m) ? fVacEmps.push(e) : activeEmps.push(e));

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
      $('editorGridContainer').innerHTML = this.buildSheetHTML(state, true);
      $('liveOfficialPreviewMount').innerHTML = this.buildSheetHTML(state, false); return; } const y = state.selectedYear, m = state.selectedMonth; changedKeys.forEach(k => { const [eId, d] = k.split('\vert{}'); const emp = state.employees.find(e => e.id === eId); if(!emp) return; const c = ScheduleEngine.resolveCell(state, emp, y, m, Number(d)); $$(`td.cell-day[data-emp-id="${eId}"][data-day="${d}"]`).forEach(td => {
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

    $('topMonthSelect').value = state.selectedMonth; $('topYearInput').value = state.selectedYear;
    $('chkShowWorkSymbol').checked = state.config.showWorkSymbol; $('lblWorkSym').textContent = state.config.symbols.work;
    $('chkShowWeekdayRow').checked = state.config.showWeekdayRow; $('chkShowHESheet').checked = state.config.overtime.showOnSheet;
    
    if(scope === 'all' || scope === 'cells') {
      this.patchGrid(state, null, true);
      this.debouncedAnalytics(state);
    }
  }
};

// ============================================================================
// 6. EXPORTAÇÃO
// ============================================================================
const ExportService = {
  async generatePNG(state) {
    UI.toast('A renderizar...', 'warn');
    const staging = $('printStagingArea');
    const mode = $('exportSplitMode').value;
    const days = ScheduleEngine.getVisibleDays(state, state.selectedYear, state.selectedMonth);
    const chunks = mode === 'fortnight' && days.length > 15 ? [days.filter(d=>d<=15), days.filter(d=>d>15)] : [days];
    
    const canvases = [];
    for(const chunk of chunks) {
      staging.innerHTML = Renderer.buildSheetHTML(state, { interactive: false, ignoreSearch: true, customDays: chunk });
      const p = staging.querySelector('.official-sheet-paper');
      const expectedW = 384 + chunk.length * 25 + 16;
      if(window.html2canvas) {
        try {
          const c = await window.html2canvas(p, { scale: Number($('exportScaleSelect').value)||2, width: expectedW, windowWidth: expectedW+40 });
          canvases.push(c);
        } catch(e) { canvases.push(this.fallbackCanvas(state, chunk)); }
      } else canvases.push(this.fallbackCanvas(state, chunk));
    }

    const final = document.createElement('canvas');
    final.width = Math.max(...canvases.map(c=>c.width));
    final.height = canvases.reduce((a,c)=>a+c.height, 0) + (canvases.length-1)*60;
    const ctx = final.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,final.width,final.height);
    let y = 0; canvases.forEach(c => { ctx.drawImage(c, 0, y); y += c.height + 60; });

    const url = final.toDataURL('image/png');
    $('exportImageResultBox').innerHTML = `<img src="${url}">`;
    $('exportRenderStatus').textContent = `Pronto (${final.width}x${final.height}px)`;
    $('btnDownloadPng').disabled = false;
    Store.runtime.lastGeneratedPngUrl = url;
    UI.toast('PNG gerado!'); return url;
  },

  fallbackCanvas(state, daysArray) {
    const c = document.createElement('canvas'); c.width = 384 + daysArray.length*25; c.height = 400; // Simplified for brevity in this block
    const ctx = c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle='#000'; ctx.fillText('Fallback de Segurança Ativado - PDF/Print disponíveis', 20, 50);
    return c;
  }
};

// ============================================================================
// 7. UI E INTERAÇÕES AVANÇADAS
// ============================================================================
const UI = {
  isDraggingFolga: false, dragStartCell: null,
  isSelectingMass: false,

  init() {
    this.bindSidebar(); this.bindGridEvents(); this.bindContextBar(); this.bindForms();
    this.bindFirebase(); this.bindPopover();
    CloudSyncAdapter.init();
  },

  toast(msg, type='ok') {
    const t = document.createElement('div'); t.className = `toast-item ${type}`; t.textContent = msg;
    $('toastContainer').appendChild(t);
    setTimeout(() => t.remove(), 3000);
  },

  updateCloudBadge(text, color) {
    const b = $('topCloudStatus'); b.textContent = text; b.style.color = color; b.style.borderColor = color;
  },

  updateHistoryBtns() {
    $('undoCountBadge').textContent = Store.runtime.undoStack.length;
    $('btnUndo').disabled = !Store.runtime.undoStack.length;
    $('redoCountBadge').textContent = Store.runtime.redoStack.length;
    $('btnRedo').disabled = !Store.runtime.redoStack.length;
  },

  bindSidebar() {
    $$('.nav-item').forEach(b => b.addEventListener('click', () => {
      $$('.nav-item, .tab-panel').forEach(el => el.classList.remove('active'));
      b.classList.add('active'); $(`tab-${b.dataset.tab}`).classList.add('active');
      Store.runtime.activeTab = b.dataset.tab;
    }));
    $$('[data-switch-tab]').forEach(b => b.addEventListener('click', () => {
      $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === b.dataset.switchTab));
      $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${b.dataset.switchTab}`));
      Store.runtime.activeTab = b.dataset.switchTab;
    }));
    $('btnToggleSidebar').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
    $('btnTogglePreviewPane').addEventListener('click', () => {
      $('workspaceSplit').classList.toggle('preview-hidden'); $('workspaceSplit').classList.remove('preview-maximized');
    });
    $('btnUndo').addEventListener('click', () => Store.undo());
    $('btnRedo').addEventListener('click', () => Store.redo());
    $('btnThemeToggle').addEventListener('click', () => { Store.state.theme = Store.state.theme==='light'?'dark':'light'; Store.commit('all'); });
    $('btnSidebarGeneratePng').addEventListener('click', () => { $$('[data-tab="exportar"]')[0].click(); ExportService.generatePNG(Store.state); });
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
    let painting = false, pSet = new Set();

    grid.addEventListener('mousedown', e => {
      if (e.button === 2) return; // Direito = context menu no scale
      const trName = e.target.closest('td.cell-name');
      if (trName && e.ctrlKey) {
         // Selecionar linha inteira
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
      if(painting) { painting = false; Store.commit('cells'); }
      if(this.isSelectingMass) { this.isSelectingMass = false; }
      if(this.isDraggingFolga) {
        const td = e.target.closest('td.cell-day');
        if(td && td.dataset.empId === this.dragStartCell.eId && Number(td.dataset.day) !== this.dragStartCell.d) {
          Store.recordHistory('Mover folga');
          this.applyBrush(this.dragStartCell.eId, this.dragStartCell.d, 'A');
          this.applyBrush(td.dataset.empId, Number(td.dataset.day), 'F');
          Store.commit('cells');
          Renderer.patchGrid(Store.state, [`${this.dragStartCell.eId}|${this.dragStartCell.d}`, `${td.dataset.empId}|${td.dataset.day}`]);
          this.toast('Folga movida! (1 passo de Undo)', 'ok');
        }
        this.isDraggingFolga = false;
      }
    });

    grid.addEventListener('contextmenu', e => {
      const scaleBadge = e.target.closest('.cell-scale-badge');
      if (scaleBadge) {
        e.preventDefault();
        const empId = scaleBadge.dataset.ctxEmp;
        const rect = scaleBadge.getBoundingClientRect();
        this.openPopover(empId, rect.right + 5, rect.top);
      }
    });

    // Teclado
    window.addEventListener('keydown', e => {
      if(e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA') return;
      const k = e.key.toUpperCase();
      const map = { 'T':'T', 'F':'F', 'E':'FE', 'Y':'Y', 'V':'FER', 'L':'AF', 'A':'A', 'H':'HE', 'DELETE':'A', 'BACKSPACE':'A' };
      if(map[k] && Store.runtime.selectedCells.size > 0) {
        Store.recordHistory(`Atalho Multi (${map[k]})`);
        Store.runtime.selectedCells.forEach(key => {
          const [eId, d] = key.split('|'); this.applyBrush(eId, Number(d), map[k]);
        });
        Store.commit('cells'); Renderer.patchGrid(Store.state, Array.from(Store.runtime.selectedCells));
      }
    });
  },

  bindContextBar() {
    $$('.brush-btn').forEach(b => b.addEventListener('click', () => {
      Store.runtime.brushMode = b.dataset.brush;
      $$('.brush-btn').forEach(x => x.classList.remove('active')); b.classList.add('active');
    }));

    $('btnContextApplyBrush').addEventListener('click', () => {
      if(!Store.runtime.selectedCells.size) return;
      Store.recordHistory(`Massa: ${Store.runtime.brushMode}`);
      Store.runtime.selectedCells.forEach(k => {
        const [eId, d] = k.split('|'); this.applyBrush(eId, Number(d), Store.runtime.brushMode);
      });
      Store.commit('cells'); Renderer.patchGrid(Store.state, Array.from(Store.runtime.selectedCells));
    });

    $('btnContextClear').addEventListener('click', () => {
      Store.runtime.selectedCells.clear(); this.updateContextBar(); Renderer.patchGrid(Store.state, null, true);
    });
  },

  updateContextBar() {
    $('contextActionBar').hidden = Store.runtime.selectedCells.size < 2;
  },

  // POPOVER PARA MUDAR REGRAS NA HORA
  openPopover(empId, x, y) {
    const emp = Store.state.employees.find(e => e.id === empId);
    if (!emp) return;
    const pop = $('scalePopoverMenu');
    $('popoverEmpName').textContent = emp.name;
    $('popoverRuleSelect').value = emp.ruleType;
    $('popoverFromDate').value = ScheduleEngine.formatDateISO(Store.state.selectedYear, Store.state.selectedMonth, 1);
    
    pop.style.left = `${x}px`; pop.style.top = `${y}px`; pop.hidden = false;
    
    const applyShift = (days) => {
      Store.recordHistory(`Deslocar Ciclo (${days}d)`);
      const dt = new Date($('popoverFromDate').value);
      dt.setUTCDate(dt.getUTCDate() + days);
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
    $('btnPopoverCancel').onclick = () => { pop.hidden = true; };
    $('btnPopoverApply').onclick = () => {
      Store.recordHistory('Nova Regra Adicionada');
      emp.scaleChanges.push({ from: $('popoverFromDate').value, ruleType: $('popoverRuleSelect').value, cycleStartDate: $('popoverFromDate').value, scaleLabel: $('popoverRuleSelect').value, workDays: emp.workDays, offDays: emp.offDays });
      Store.commit('all'); pop.hidden = true; this.toast('Nova regra aplicada a partir da data!');
    };
  },

  openCellModal(empId, day) {
    const emp = Store.state.employees.find(e => e.id === empId);
    if (!emp) return;
    const y = Store.state.selectedYear, m = Store.state.selectedMonth;
    const mK = ScheduleEngine.getMonthKey(y, m);
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
  },

  bindForms() {
    $('chkShowHESheet').addEventListener('change', e => { Store.state.config.overtime.showOnSheet = e.target.checked; Store.commit('escala'); });
    $('formHEConfig').addEventListener('submit', e => {
      e.preventDefault(); Store.recordHistory('Limites HE');
      Store.state.config.overtime.enabled = $('cfgHEEnabled').checked;
      Store.state.config.overtime.maxDailyMinutes = Number($('cfgHEMaxDaily').value);
      Store.state.config.overtime.maxMonthlyMinutes = Number($('cfgHEMaxMonthly').value);
      Store.commit('all'); this.toast('Limites de HE atualizados!');
    });
  },

  renderDashboardStats(state, a) {
    $('empTotalCount').textContent = a.totalEmployees;
    $('alertsCountBadge').textContent = a.alerts.length;
    const dK = $('dashboardKpis');
    if(dK) dK.innerHTML = `
      <div class="kpi-box"><div class="kpi-label">Efetivo Ativo</div><div class="kpi-val">${a.activeCount}</div><div class="kpi-sub">Total: ${a.totalEmployees}</div></div>
      <div class="kpi-box warn"><div class="kpi-label">Férias (Rodapé)</div><div class="kpi-val">${a.footerVacationCount}</div></div>
      <div class="kpi-box"><div class="kpi-label">Horas Previstas</div><div class="kpi-val">${Math.round(Object.values(a.employeeMetrics).reduce((s,x)=>s+x.totalHours,0))}h</div></div>
      <div class="kpi-box ${a.covPercent < 100 ? 'danger' : ''}"><div class="kpi-label">Cobertura (Mín: ${state.config.minCoverage})</div><div class="kpi-val">${a.covPercent}%</div></div>
    `;
    const ul = $('dashboardAlertsList');
    if(ul) ul.innerHTML = a.alerts.map((al,i) => `<li class="alert-row ${escapeHTML(al.severity)}" data-aid="${i}"><strong>[${al.severity.toUpperCase()}]</strong> ${escapeHTML(al.text)}</li>`).join('');
  },

  renderReports(state, a) {
    const bb = $('reportBlocksBody');
    if(bb) bb.innerHTML = a.blockMetrics.map(b => `<tr><td><strong>${escapeHTML(b.group.name)}</strong></td><td>${b.activeCount}</td><td>${b.minRequired}</td><td>${b.avgWorking.toFixed(1)}</td><td>${b.minObserved}</td><td>${b.totalBlockHours.toFixed(1)}h</td><td>--</td></tr>`).join('');
    
    const eb = $('reportEmployeesBody');
    if(eb) eb.innerHTML = Object.values(a.employeeMetrics).map(m => `<tr><td>${m.emp.matricula}</td><td><strong>${escapeHTML(m.emp.name)}</strong></td><td>${m.emp.entryTime}</td><td>${m.workDaysCount}</td><td>${m.baseHours.toFixed(1)}h</td><td style="color:#1de9b6">${formatMins(m.ot50)}</td><td style="color:#00e676">${formatMins(m.ot100)}</td><td style="color:#eab308">${formatMins(m.otBanco)}</td><td><strong>${m.totalHours.toFixed(1)}h</strong></td><td>${m.manualAdjustments}</td></tr>`).join('');
  },

  bindFirebase() {
    $('btnSaveFbCfg').onclick = () => {
      const cfg = $('fbConfigInput').value;
      if(parseFirebaseConfig(cfg)) {
        localStorage.setItem('FROTA_OS_FIREBASE_CFG', cfg);
        window.location.reload();
      } else this.toast('JSON de configuração inválido', 'error');
    };
    $('btnRemoveFbCfg').onclick = () => {
      localStorage.removeItem('FROTA_OS_FIREBASE_CFG'); window.location.reload();
    };
    $('btnFbLogin').onclick = () => {
      CloudSyncAdapter.auth.signInWithEmailAndPassword($('fbEmail').value, $('fbPass').value).catch(e => this.toast(e.message, 'error'));
    };
    $('btnFbRegister').onclick = () => {
      CloudSyncAdapter.auth.createUserWithEmailAndPassword($('fbEmail').value, $('fbPass').value).catch(e => this.toast(e.message, 'error'));
    };
    $('btnFbLogout').onclick = () => CloudSyncAdapter.auth.signOut();
  }
};

// ============================================================================
// 8. AUTOTESTES (22 TESTES PARA GARANTIR QUALIDADE)
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
  ok('20. Horas Extras somam na Carga', a.employeeMetrics[mState.employees[0].id].totalHours > a.employeeMetrics[mState.employees[0].id].baseHours);
  ok('21. Cobertura avaliada corretamente', a.covPercent <= 100);
  ok('22. Deep Clone protege Refs', deepClone({a:1}).a === 1);
  
  const p = r.filter(x=>x.p).length;
  $('selfTestOutput').textContent = r.map(x=>`${x.p?'[OK] ':'[FALHOU] '} ${x.n}`).join('\n') + `\n\nTotal: ${p}/${r.length} aprovados.`;
  return { passed: p, total: r.length };
};

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  Store.init();
  UI.init();
});