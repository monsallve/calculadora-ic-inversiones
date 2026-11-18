# Conectar Firebase — Monsallve Financiero

## 1. Edita js/firebase-config.js

Firebase Console → ⚙️ Project settings → Your apps → SDK setup and configuration → Config

Pega tus valores reales (reemplaza todo lo que diga PEGAR_...).

## 2. Dominio autorizado

Authentication → Settings → Authorized domains → Add domain:

    monsallve.github.io

## 3. Authentication

Sign-in method → Email/Password → Enable

## 4. Firestore rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## 5. Sube a GitHub

Sube todos los archivos del zip a la raíz del repo calculadora-ic-inversiones.

## Uso

- Icono 👤 → Cuenta
- Registrarse o Entrar
- Los cambios se guardan en local y en la nube (users/{uid})
