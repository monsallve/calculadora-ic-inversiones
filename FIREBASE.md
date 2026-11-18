# Firebase — Monsallve Financiero

## Authorized domains
- monsallve.github.io
- localhost

## Sign-in methods
- Email/Password: ON
- Google: ON

## Firestore rules (PUBLICAR)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /usernames/{uname} {
      // Lectura pública para comprobar disponibilidad al registrarse
      allow get: if true;
      allow list: if false;
      allow create: if request.auth != null
        && request.resource.data.uid == request.auth.uid;
      allow delete: if request.auth != null
        && resource.data.uid == request.auth.uid;
      allow update: if false;
    }
  }
}
```
