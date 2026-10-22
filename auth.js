/**
 * ============================================================================
 * FROTA.OS v5.0 // MÓDULO DE BOOT E AUTENTICAÇÃO (auth.js)
 * Firebase Compat, Watchdog 4s, Modo Offline e CustomEvents
 * ============================================================================
 */
'use strict';

window.AuthManager = {
  auth: null,
  currentUser: null,
  mode: 'none', // 'none' | 'local' | 'cloud'
  resolved: false,
  watchdogTimer: null,

  init() {
    this.bindUI();
    
    const fbExists = typeof firebase !== 'undefined' && firebase.apps.length > 0;
    if (!fbExists) {
      console.warn('[FROTA.OS] SDK do Firebase não detetado. Trabalhando 100% offline.');
      this.settle(null);
      return;
    }

    try {
      this.auth = firebase.auth();
    } catch (e) {
      console.error('[FROTA.OS] Falha ao iniciar Firebase Auth.', e);
      this.settle(null);
      return;
    }

    // REGRA DE OURO: Watchdog de 4 segundos. O splash NUNCA fica preso.
    this.watchdogTimer = setTimeout(() => {
      if (!this.resolved) {
        console.warn('[FROTA.OS] Watchdog: O Firebase demorou a responder. Forçando abertura.');
        this.toast('Conexão lenta. O modo offline foi ativado preventivamente.', 'warn');
        this.settle(null);
      }
    }, 4000);

    // Ouve a primeira resposta da nuvem (Logado ou Deslogado)
    this.auth.onAuthStateChanged(
      user => { this.settle(user); },
      err => { console.error('[FROTA.OS] Auth State Error:', err); this.settle(null); }
    );
  },

  settle(user) {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    const isFirstBoot = !this.resolved;
    this.resolved = true;
    
    this.currentUser = user ? { uid: user.uid, email: user.email } : null;

    // Remove o ecrã de Splash sem falta
    const splash = document.getElementById('splashScreen');
    if (splash) splash.hidden = true;

    if (user) {
      this.enterApp('cloud');
    } else {
      // Se for o arranque inicial, decide se vai para Login ou entra Localmente
      if (isFirstBoot) {
        const wantsLocal = localStorage.getItem('FROTA_OS_LOCAL_MODE') === '1';
        // Se houver configuração futura para forçar login (Fase 2)
        const requireLogin = window.Store && window.Store.state.config.requireLogin;
        
        if (wantsLocal && !requireLogin) {
          this.enterApp('local');
        } else {
          this.showLogin();
        }
      } else {
        // Se o utilizador terminou a sessão de propósito, volta ao login
        if (this.mode === 'cloud') this.showLogin();
      }
    }
  },

  showLogin() {
    this.mode = 'none';
    const app = document.getElementById('appShell');
    const login = document.getElementById('loginScreen');
    if (app) app.hidden = true;
    if (login) login.hidden = false;
    
    if (window.Store && window.Store.state.config.requireLogin) {
      const btnOff = document.getElementById('btnOverlayOffline');
      if (btnOff) btnOff.hidden = true;
    }
    
    this.broadcast();
  },

  enterApp(targetMode) {
    this.mode = targetMode;
    const app = document.getElementById('appShell');
    const login = document.getElementById('loginScreen');
    if (login) login.hidden = true;
    if (app) app.hidden = false;
    
    // Liberta a interface e desenha os Canvas com as larguras finais reais
    if (window.Store) {
      window.Store.state.isReadOnly = false;
      if (window.Renderer) window.Renderer.renderAll();
    }

    const badge = document.getElementById('topCloudStatus');
    if (badge) {
      badge.textContent = targetMode === 'cloud' ? `Conectado: ${this.currentUser.email}` : 'Modo Local (Offline)';
      badge.style.color = targetMode === 'cloud' ? 'var(--neon-primary)' : 'var(--text-secondary)';
      badge.style.borderColor = targetMode === 'cloud' ? 'var(--neon-primary)' : 'var(--border-subtle)';
    }

    this.broadcast();
  },

  broadcast() {
    // Emite o CustomEvent exigido no contrato, com replay de estado
    const payload = { mode: this.mode, user: this.currentUser };
    const event = new CustomEvent('frota:auth_changed', { detail: payload });
    document.dispatchEvent(event);
  },

  async login(email, pass, btn) {
    if (!this.auth) return this.toast('Nuvem não configurada. Use o modo offline.', 'error');
    if (!email || !pass) return this.toast('Preencha o e-mail e a palavra-passe.', 'warn');
    
    const orig = btn.textContent; btn.textContent = 'A processar...'; btn.disabled = true;
    try {
      await this.auth.signInWithEmailAndPassword(email, pass);
      this.toast('Bem-vindo de volta!', 'ok');
      localStorage.removeItem('FROTA_OS_LOCAL_MODE');
    } catch (e) {
      this.toast(this.translateError(e.code), 'error');
    } finally {
      btn.textContent = orig; btn.disabled = false;
    }
  },

  async register(email, pass, btn) {
    if (!this.auth) return this.toast('Nuvem não configurada.', 'error');
    if (!email || !pass) return this.toast('Preencha o e-mail e a palavra-passe.', 'warn');
    
    const orig = btn.textContent; btn.textContent = 'A criar...'; btn.disabled = true;
    try {
      await this.auth.createUserWithEmailAndPassword(email, pass);
      this.toast('Conta criada e autenticada!', 'ok');
      localStorage.removeItem('FROTA_OS_LOCAL_MODE');
    } catch (e) {
      this.toast(this.translateError(e.code), 'error');
    } finally {
      btn.textContent = orig; btn.disabled = false;
    }
  },

  async resetPass(email) {
    if (!this.auth) return this.toast('Nuvem não configurada.', 'error');
    if (!email) return this.toast('Preencha o e-mail antes de recuperar a palavra-passe.', 'warn');
    try {
      await this.auth.sendPasswordResetEmail(email);
      this.toast('Link de recuperação enviado para o seu e-mail!', 'ok');
    } catch (e) {
      this.toast(this.translateError(e.code), 'error');
    }
  },

  async logout() {
    if (!this.auth) return;
    try {
      await this.auth.signOut();
      this.toast('Sessão terminada.', 'ok');
    } catch (e) {
      this.toast('Erro ao encerrar sessão.', 'error');
    }
  },

  goOffline() {
    localStorage.setItem('FROTA_OS_LOCAL_MODE', '1');
    this.enterApp('local');
    this.toast('Modo Offline: Dados guardados apenas neste dispositivo.', 'warn');
  },

  bindUI() {
    const $ = id => document.getElementById(id);
    
    // Eventos da Tela de Login Principal
    if ($('formLoginScreen'))$('formLoginScreen').onsubmit = e => e.preventDefault();
    if ($('btnOverlayLogin'))$('btnOverlayLogin').onclick = e => this.login($('loginEmail').value, $('loginPass').value, e.target);
    if ($('btnOverlayRegister'))$('btnOverlayRegister').onclick = e => this.register($('loginEmail').value, $('loginPass').value, e.target);
    if ($('btnOverlayResetPass')) $('btnOverlayResetPass').onclick = () => this.resetPass($('loginEmail').value);
    if ($('btnOverlayOffline'))$('btnOverlayOffline').onclick = () => this.goOffline();

    // Comportamento das Abas de Login/Registo
    if ($('tabBtnLogin') &&$('tabBtnRegister')) {
      const tL = $('tabBtnLogin'), tR =$('tabBtnRegister'), bL = $('btnOverlayLogin'), bR =$('btnOverlayRegister');
      tL.onclick = () => { tL.setAttribute('aria-selected', 'true'); tR.setAttribute('aria-selected', 'false'); bL.hidden = false; bR.hidden = true; };
      tR.onclick = () => { tR.setAttribute('aria-selected', 'true'); tL.setAttribute('aria-selected', 'false'); bR.hidden = false; bL.hidden = true; };
    }

    // Eventos da Aba "Conta & Nuvem"
    if ($('fbAuthForm'))$('fbAuthForm').onsubmit = e => e.preventDefault();
    if ($('btnFbLogin'))$('btnFbLogin').onclick = e => this.login($('fbEmail').value, $('fbPass').value, e.target);
    if ($('btnFbRegister'))$('btnFbRegister').onclick = e => this.register($('fbEmail').value, $('fbPass').value, e.target);
    if ($('btnFbResetPass')) $('btnFbResetPass').onclick = () => this.resetPass($('fbEmail').value);
    if ($('btnFbLogout'))$('btnFbLogout').onclick = () => this.logout();
  },

  toast(msg, type='ok') {
    // Delega para a UI principal se já estiver carregada
    if (window.UI && window.UI.toast) return window.UI.toast(msg, type);
    
    // Failsafe se o App Core não carregar
    const c = document.getElementById('toastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast-item ${type}`; t.textContent = msg;
    c.appendChild(t); setTimeout(() => t.remove(), 4000);
  },

  translateError(code) {
    const dict = {
      'auth/invalid-email': 'O e-mail inserido é inválido.',
      'auth/missing-password': 'A palavra-passe é obrigatória.',
      'auth/user-disabled': 'Esta conta foi desativada.',
      'auth/user-not-found': 'Conta não encontrada com este e-mail.',
      'auth/wrong-password': 'Palavra-passe incorreta.',
      'auth/email-already-in-use': 'Este e-mail já está a ser utilizado.',
      'auth/weak-password': 'A palavra-passe deve ter pelo menos 6 caracteres.',
      'auth/invalid-credential': 'Credenciais inválidas.',
      'auth/invalid-login-credentials': 'E-mail ou palavra-passe incorretos.',
      'auth/too-many-requests': 'Demasiadas tentativas. Tente novamente mais tarde.',
      'auth/network-request-failed': 'Falha na conexão de rede.'
    };
    return dict[code] || `Erro desconhecido: ${code}`;
  }
};

// Arranca o gestor de autenticação quando o DOM carrega
document.addEventListener('DOMContentLoaded', () => {
  window.AuthManager.init();
});