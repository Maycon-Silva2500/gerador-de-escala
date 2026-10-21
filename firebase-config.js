// firebase-config.js
const firebaseConfig = {
  apiKey: "AIzaSyDuTH740TZq-uKKjmZUL12XVH5nJkt370Y",
  authDomain: "frota-os.firebaseapp.com",
  projectId: "frota-os",
  storageBucket: "frota-os.firebasestorage.app",
  messagingSenderId: "434114876026",
  appId: "1:434114876026:web:96e0b61f0145cd5962a1c3",
  measurementId: "G-CN7FC83HS8"
};

if (typeof firebase !== 'undefined') {
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
    console.log("🔥 Firebase conectado com sucesso!");
  }
} else {
  console.error("SDK do Firebase não foi carregado.");
}