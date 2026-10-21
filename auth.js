/**
 * FROTA.OS v5.0 // MÓDULO DE AUTENTICAÇÃO E SEGURANÇA
 */
'use strict';

const AuthManager = {
  auth: null,
  currentUser: null,

  init() {
    this.bindUI();
    if (typeof firebase === 'undefined' || !firebase.apps.length) {
      console.warn("⚠️ Firebase não configurado. Entrando em Modo Offline.");
      this.goOffline();
      return;
    }
    this.auth = firebase.auth();
    this.listenAuth();
  },

  toast(msg, type='ok') {
    const box = document.getElementById('toastContainer');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast-item ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  },

  bindUI() {
    const $ = id => document.getElementById(id);
    
    if($('formLoginScreen'))$('formLoginScreen').onsubmit = e => e.preventDefault();
    if($('btnOverlayLogin'))$('btnOverlayLogin').onclick = e => this.login($('loginEmail').value, $('loginPass').value, e.target);
    if($('btnOverlayRegister'))$('btnOverlayRegister').onclick = e => this.register($('loginEmail').value, $('loginPass').value, e.target);
    if($('btnOverlayOffline'))$('btnOverlayOffline').onclick = () => this.goOffline();
    if($('btnOverlayResetPass')) $('btnOverlayResetPass').onclick = () => this.resetPassword($('loginEmail').value);
    
    if($('fbAuthForm'))$('fbAuthForm').onsubmit = e => e.preventDefault();
    if($('btnFbLogin'))$('btnFbLogin').onclick = e => this.login($('fbEmail').value, $('fbPass').value, e.target);
    if($('btnFbRegister'))$('btnFbRegister').onclick = e => this.register($('fbEmail').value, $('fbPass').value, e.target);
    if($('btnFbLogout'))$('btnFbLogout').onclick = () => this.logout();
    if($('btnFbResetPass')) $('btnFbResetPass').onclick = () => this.resetPassword($('fbEmail').value);
  },

  async login(email, pass, btn) {
    if (!this.auth) return this.toast('Nuvem não detetada.', 'error');
    if(!email || !pass) return this.toast('Preencha o e-mail e a palavra-passe.', 'warn');
    const origText = btn.textContent; btn.textContent = 'A entrar...'; btn.disabled = true;
    try { 
      await this.auth.signInWithEmailAndPassword(email, pass); 
      this.toast('Sessão iniciada!', 'ok'); 
    }
    catch(e) { this.toast(this.translateError(e.code), 'error'); }
    finally { btn.textContent = origText; btn.disabled = false; }
  },

  async register(email, pass, btn) {
    if (!this.auth) return this.toast('Nuvem não detetada.', 'error');
    if(!email || !pass) return this.toast('Preencha os dados.', 'warn');
    const origText = btn.textContent; btn.textContent = 'A criar...'; btn.disabled = true;
    try { 
      await this.auth.createUserWithEmailAndPassword(email, pass); 
      this.toast('Conta criada com sucesso!', 'ok'); 
    }
    catch(e) { this.toast(this.translateError(e.code), 'error'); }
    finally { btn.textContent = origText; btn.disabled = false; }
  },

  async logout() {
    if (!this.auth) return;
    try { await this.auth.signOut(); this.toast('Sessão terminada.', 'ok'); }
    catch(e) { this.toast('Erro ao sair.', 'error'); }
  },

  async resetPassword(email) {
    if (!this.auth) return this.toast('Nuvem não detetada.', 'error');
    if(!email) return this.toast('Preencha o campo de e-mail.', 'warn');
    try {
        await this.auth.sendPasswordResetEmail(email);
        this.toast('E-mail de redefinição enviado!', 'ok');
    } catch(e) {
        this.toast(this.translateError(e.code), 'error');
    }
  },

  goOffline() {
    if (document.getElementById('loginScreen')) document.getElementById('loginScreen').hidden = true;
    if (document.getElementById('fbAuthState')) document.getElementById('fbAuthState').hidden = true;
    this.updateBadge('Offline (Local)', 'var(--text-secondary)');
    this.toast('Modo Offline Ativado.', 'warn');
    if (window.Store) { window.Store.state.isReadOnly = false; window.Renderer.renderAll(); }
  },

  listenAuth() {
    this.auth.onAuthStateChanged(user => {
      this.currentUser = user;
      if (user) {
        if(document.getElementById('loginScreen')) document.getElementById('loginScreen').hidden = true;
        if(document.getElementById('fbAuthState')) { document.getElementById('fbAuthState').hidden = true; document.getElementById('fbLoggedInState').hidden = false; }
        if(document.getElementById('fbUserEmailSpan')) document.getElementById('fbUserEmailSpan').textContent = user.email;
        this.updateBadge(`Conectado: ${user.email}`, 'var(--neon-primary)');
        if (window.Store) { window.Store.state.isReadOnly = false; window.Renderer.renderAll(); }
      } else {
        if(document.getElementById('fbAuthState')) { document.getElementById('fbAuthState').hidden = false; document.getElementById('fbLoggedInState').hidden = true; }
        this.updateBadge('Offline (Deslogado)', 'var(--text-secondary)');
      }
    });
  },

  updateBadge(text, color) {
    const b = document.getElementById('topCloudStatus');
    if(b) { b.textContent = text; b.style.color = color; b.style.borderColor = color; }
  },

  translateError(code) {
    switch(code) {
      case 'auth/invalid-email': return 'E-mail inválido.';
      case 'auth/user-not-found': return 'Nenhuma conta encontrada.';
      case 'auth/wrong-password': return 'Palavra-passe incorreta.';
      case 'auth/email-already-in-use': return 'Este e-mail já tem conta.';
      case 'auth/weak-password': return 'A palavra-passe deve ter pelo menos 6 caracteres.';
      case 'auth/invalid-credential': return 'Credenciais inválidas.';
      default: return `Erro: ${code}`;
    }
  }
};

document.addEventListener('DOMContentLoaded', () => { AuthManager.init(); });