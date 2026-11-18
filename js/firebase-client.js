import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  reload,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import {
  initializeFirestore,
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  enableNetwork,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
});

let app = null;
let auth = null;
let db = null;
let configData = null;

export function handleFirestoreError(error, operationType, path) {
  const user = auth ? auth.currentUser : null;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? String(error.code) : '',
    authInfo: {
      userId: user ? user.uid : null,
      email: user ? user.email : null,
      emailVerified: user ? user.emailVerified : null,
      isAnonymous: user ? user.isAnonymous : null,
      tenantId: user ? user.tenantId : null,
      providerInfo: user && Array.isArray(user.providerData)
        ? user.providerData.map((p) => ({
            providerId: p.providerId,
            email: p.email,
          }))
        : [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  const wrapped = new Error(JSON.stringify(errInfo));
  wrapped.code = errInfo.code;
  wrapped.firestoreInfo = errInfo;
  wrapped.originalError = error;
  throw wrapped;
}

async function testConnection() {
  if (!db) return { ok: false, reason: 'no-db' };
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (msg.includes('the client is offline')) {
      console.error('Please check your Firebase configuration. Firestore reports the client is offline.');
      return { ok: false, reason: 'offline', code, message: msg };
    }
    return { ok: true, code };
  }
}

async function initFirebaseClient() {
  const res = await fetch('./firebase-applet-config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`No se pudo cargar firebase-applet-config.json (${res.status})`);
  }
  configData = await res.json();
  if (!configData || !configData.apiKey || !configData.projectId || !configData.appId) {
    throw new Error('Configuración de Firebase incompleta.');
  }

  app = getApps().length ? getApps()[0] : initializeApp(configData);
  auth = getAuth(app);
  try {
    db = configData.firestoreDatabaseId
      ? initializeFirestore(app, { experimentalAutoDetectLongPolling: true }, configData.firestoreDatabaseId)
      : initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  } catch (_e) {
    db = configData.firestoreDatabaseId
      ? getFirestore(app, configData.firestoreDatabaseId)
      : getFirestore(app);
  }

  const connectionPromise = testConnection();

  const client = {
    app,
    auth,
    db,
    config: configData,
    OperationType,
    handleFirestoreError,
    testConnection,
    connectionPromise,
    // Auth helpers
    onAuthStateChanged: (cb) => onAuthStateChanged(auth, cb),
    signInWithEmail: (email, password) => signInWithEmailAndPassword(auth, email, password),
    registerWithEmail: (email, password) => createUserWithEmailAndPassword(auth, email, password),
    signInWithGooglePopup: () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return signInWithPopup(auth, provider);
    },
    signInWithGoogleRedirect: () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return signInWithRedirect(auth, provider);
    },
    getRedirectResult: () => getRedirectResult(auth),
    signOut: () => signOut(auth),
    sendPasswordResetEmail: (email) => sendPasswordResetEmail(auth, email),
    sendVerificationEmail: (user) => sendEmailVerification(user),
    reloadUser: (user) => reload(user),
    // Firestore helpers
    enableNetwork: () => enableNetwork(db),
    serverTimestamp: () => serverTimestamp(),
    docRef: (col, id) => doc(db, col, id),
    getDoc: (ref) => getDoc(ref),
    getDocFromServer: (ref) => getDocFromServer(ref),
    setDoc: (ref, data, opts) => setDoc(ref, data, opts),
    deleteDoc: (ref) => deleteDoc(ref),
    writeBatch: () => writeBatch(db),
  };

  window.fbClient = client;
  return client;
}

window.__firebaseClientPromise = initFirebaseClient();
