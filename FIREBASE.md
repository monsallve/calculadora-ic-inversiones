# Firebase — Monsallve Financiero

## Authorized domains
Authentication → Settings → Authorized domains:
- monsallve.github.io
- localhost (para pruebas)

## Sign-in methods
- Email/Password: ON
- Google: ON (añade email de soporte del proyecto)

## Firestore rules (publicar estas)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /usernames/{uname} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.uid == request.auth.uid;
      allow delete: if request.auth != null
        && resource.data.uid == request.auth.uid;
      allow update: if false;
    }
  }
}
```

## Colecciones
- users/{uid} → username, email, estado, updatedAt
- usernames/{username} → uid (unicidad)
