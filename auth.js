/* ==========================================================================
   FROTA.OS v5.0 - auth.js
   Gerenciador de Autenticação e Controle de Sessão (Mock/Local)
   ========================================================================== */

(function () {
  'use strict';

  // Credenciais estáticas para demonstração/uso local
  const MOCK_CREDENTIALS = {
    email: 'admin@frota.os',
    password: 'admin' // Senha padrão para o ambiente de testes
  };

  const AuthManager = {
    currentUser: null,

    init() {
      this.checkSession();
      this.bindEvents();
    },

    bindEvents() {
      // Intercepta o formulário de login no Modal
      const loginForm = document.getElementById('loginForm');
      if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const email = document.getElementById('loginEmail').value.trim();
          const pass = document.getElementById('loginPassword').value.trim();
          
          this.login(email, pass);
        });
      }

      // Botão de Logout na aba Conta
      const btnLogout = document.getElementById('btnLogout');
      if (btnLogout) {
        btnLogout.addEventListener('click', () => {
          this.logout();
        });
      }
    },

    checkSession() {
      const savedSession = sessionStorage.getItem('FROTA_OS_SESSION');
      if (savedSession) {
        try {
          this.currentUser = JSON.parse(savedSession);
          this.setAppState(true);
        } catch (e) {
          console.error('Erro ao ler sessão', e);
          this.logout();
        }
      } else {
        // Se não houver sessão, define como Somente Leitura (ou Modo Local)
        // No FROTA.OS 5.0, vamos permitir o uso offline com aviso.
        this.setAppState(false);
      }
    },

    login(email, password) {
      const loginErrorMsg = document.getElementById('loginErrorMsg');
      const loginBtn = document.getElementById('btnSubmitLogin');

      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Autenticando...';
      }

      // Simula um delay de rede (500ms)
      setTimeout(() => {
        if (email === MOCK_CREDENTIALS.email && password === MOCK_CREDENTIALS.password) {
          const userObj = {
            uid: 'local_admin_001',
            email: email,
            role: 'admin',
            loginTime: new Date().toISOString()
          };

          this.currentUser = userObj;
          sessionStorage.setItem('FROTA_OS_SESSION', JSON.stringify(userObj));
          
          if (loginErrorMsg) loginErrorMsg.hidden = true;
          
          // Fecha o modal de login se estiver aberto
          const loginModal = document.getElementById('loginModal');
          if (loginModal) loginModal.setAttribute('hidden', 'true');

          this.setAppState(true);
          
          // Limpa o formulário
          document.getElementById('loginForm').reset();
        } else {
          // Falha na autenticação
          if (loginErrorMsg) {
            loginErrorMsg.textContent = 'E-mail ou senha incorretos.';
            loginErrorMsg.hidden = false;
          }
        }

        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = 'Entrar';
        }
      }, 500);
    },

    logout() {
      this.currentUser = null;
      sessionStorage.removeItem('FROTA_OS_SESSION');
      this.setAppState(false);
      
      // Opcional: Forçar a exibição do modal de login após logout
      // const loginModal = document.getElementById('loginModal');
      // if (loginModal) loginModal.removeAttribute('hidden');
    },

    setAppState(isAuthenticated) {
      if (window.Store) {
        // Se estiver autenticado, tem permissão total. Se não, fica em modo leitura.
        // *Nota: Para liberar o uso 100% offline sem login, mude a linha abaixo para `false`.
        window.Store.state.isReadOnly = !isAuthenticated; 
        
        // Dispara a re-renderização global da interface
        window.Store.notify();
        if (window.Renderer) {
          window.Renderer.renderAll();
        }
      }
    }
  };

  // Expõe o AuthManager globalmente
  window.AuthManager = AuthManager;

  // Inicializa assim que o DOM estiver pronto
  document.addEventListener('DOMContentLoaded', () => {
    AuthManager.init();
  });

})();