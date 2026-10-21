/**
 * ============================================================================
 * FROTA.OS // MÓDULO DE AUTENTICAÇÃO E SEGURANÇA (auth.js)
 * ============================================================================
 * Este ficheiro gere exclusivamente o Login, Registo e o ecrã de bloqueio,
 * garantindo máxima segurança e separação de responsabilidades do motor de escalas.
 */
'use strict';

const AuthManager = {
  auth: null,
  
  init() {
    // Se o ficheiro firebase-config.js não tiver as chaves, não arranca a nuvem.
    if (typeof firebase === 'undefined' || !firebase.apps.length) {
      console.warn("ℹ️ Firebase não configurado. Modo de Auth inativo (100% Local).");
      return;
    }
    this.auth = firebase.auth();
    this.bindUI();
    this.listenAuth();
  },

  toast(msg, type='ok') {
    const t = document.createElement('div'); t.className = `toast-item ${type}`; t.textContent = msg;
    const container = document.getElementById('toastContainer');
    if(container) { container.appendChild(t); setTimeout(() => t.remove(), 3000); }
  },

  bindUI() {
    const $ = id => document.getElementById(id);
    
    // Botões da Tela Cheia (Overlay Bloqueador)
    if($('btnOverlayLogin'))$('btnOverlayLogin').onclick = (e) => this.login($('loginEmail').value, $('loginPass').value, e.target);
    if($('btnOverlayRegister'))$('btnOverlayRegister').onclick = (e) => this.register($('loginEmail').value, $('loginPass').value, e.target);
    if($('btnOverlayOffline'))$('btnOverlayOffline').onclick = () => this.goOffline();

    // Botões da Aba Interna "Conta & Nuvem"
    if($('btnFbLogin'))$('btnFbLogin').onclick = (e) => this.login($('fbEmail').value, $('fbPass').value, e.target);
    if($('btnFbRegister'))$('btnFbRegister').onclick = (e) => this.register($('fbEmail').value, $('fbPass').value, e.target);
    if($('btnFbLogout'))$('btnFbLogout').onclick = () => this.logout();
  },

  async login(email, pass, btn) {
    if(!email || !pass) return this.toast('Preencha o E-mail e a Palavra-passe.', 'warn');
    const origText = btn.textContent; btn.textContent = 'A verificar...'; btn.disabled = true;
    try { 
      await this.auth.signInWithEmailAndPassword(email, pass); 
      this.toast('Sessão iniciada com sucesso!', 'ok'); 
    }
    catch(e) { this.toast(this.translateError(e.code), 'error'); }
    finally { btn.textContent = origText; btn.disabled = false; }
  },

  async register(email, pass, btn) {
    if(!email || !pass) return this.toast('Preencha os dados para criar conta.', 'warn');
    const origText = btn.textContent; btn.textContent = 'A criar conta...'; btn.disabled = true;
    try { 
      await this.auth.createUserWithEmailAndPassword(email, pass); 
      this.toast('Conta de Administrador criada com sucesso!', 'ok'); 
    }
    catch(e) { this.toast(this.translateError(e.code), 'error'); }
    finally { btn.textContent = origText; btn.disabled = false; }
  },

  async logout() {
    try { await this.auth.signOut(); this.toast('Sessão terminada em segurança.', 'ok'); }
    catch(e) { this.toast('Erro ao sair.', 'error'); }
  },

  goOffline() {
    const scr = document.getElementById('loginScreen');
    if(scr) scr.hidden = true;
    this.toast('Modo Offline Ativado. Os dados ficarão apenas neste dispositivo.', 'warn');
    // Avisa o motor de escalas que o utilizador escolheu trabalhar offline
    window.dispatchEvent(new CustomEvent('app-offline-mode'));
  },

  listenAuth() {
    this.auth.onAuthStateChanged(user => {
      const $ = id => document.getElementById(id);
      if (user) {
        // Logado com sucesso: Esconder a tela preta de login
        if($('loginScreen'))$('loginScreen').hidden = true;
        if($('fbAuthState')) { $('fbAuthState').hidden = true; $('fbLoggedInState').hidden = false; }
        if($('fbUserEmailSpan'))$('fbUserEmailSpan').textContent = user.email;
        
        this.updateBadge(`Conectado: ${user.email}`, 'var(--neon-primary)');
        
        // Emite um alerta invisível para o script.js arrancar com a Sincronização
        window.dispatchEvent(new CustomEvent('auth-success', { detail: { user } }));
      } else {
        // Saiu da conta ou abriu o site agora: Mostrar o Login
        if($('fbAuthState')) { $('fbAuthState').hidden = false; $('fbLoggedInState').hidden = true; }
        this.updateBadge('Offline (Deslogado)', 'var(--text-secondary)');
        
        // Emite alerta para o script.js trancar o acesso
        window.dispatchEvent(new CustomEvent('auth-logout'));
      }
    });
  },

  updateBadge(text, color) {
    const b = document.getElementById('topCloudStatus');
    if(b) { b.textContent = text; b.style.color = color; b.style.borderColor = color; }
  },

  translateError(code) {
    switch(code) {
      case 'auth/invalid-email': return 'O e-mail inserido é inválido.';
      case 'auth/user-not-found': return 'Nenhuma conta encontrada com este e-mail.';
      case 'auth/wrong-password': return 'A palavra-passe está incorreta.';
      case 'auth/email-already-in-use': return 'Este e-mail já tem conta registada.';
      case 'auth/weak-password': return 'A palavra-passe deve ter pelo menos 6 caracteres.';
      case 'auth/invalid-credential': return 'Credenciais inválidas. Verifique o e-mail e senha.';
      default: return `Erro de segurança: ${code}`;
    }
  }
};

// Iniciar o módulo de segurança assim que a página carregar
document.addEventListener('DOMContentLoaded', () => { AuthManager.init(); });