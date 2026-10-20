// firebase-config.js

const firebaseConfig = {
  apiKey: "AIzaSyDJQkUm6vJkPNBTkFkFm76kZAph3noFYb8",
  authDomain: "amtechfrotas.firebaseapp.com",
  projectId: "amtechfrotas",
  storageBucket: "amtechfrotas.firebasestorage.app",
  messagingSenderId: "449086212142",
  appId: "1:449086212142:web:b4303a7fadd43ab61b77bf",
  measurementId: "G-MZ27FXX327"
};

// Inicializa o Firebase automaticamente quando este ficheiro carrega
if (typeof firebase !== 'undefined') {
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
    console.log("🔥 Firebase ligado via firebase-config.js");
  }
} else {
  console.error("SDK do Firebase não foi carregado.");
}