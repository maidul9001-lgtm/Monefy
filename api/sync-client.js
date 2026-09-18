/*
 * হিসাবের খাতা — Firebase/Firestore Sync Client
 * পুরোনো HTML ফাইলগুলোর HKSync API অপরিবর্তিত রাখে।
 * Firebase Firestore ব্যবহার করে offline-first cloud sync করে।
 */
(function(){
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBEzDeNjuksnmh_BErw659Xei1PWWbzF4E",
    authDomain: "hishaber-5d889.firebaseapp.com",
    projectId: "hishaber-5d889",
    storageBucket: "hishaber-5d889.firebasestorage.app",
    messagingSenderId: "531628905925",
    appId: "1:531628905925:web:58db35ded48deeefcae7ac"
  };

  const HK = window.HKSync = window.HKSync || {};
  const readyResolvers = [];
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  let firebase = null;
  let auth = null;
  let db = null;
  let currentUser = null;
  let initialized = false;
  let initError = null;
  let lastSyncTime = 0;
  let syncing = false;
  let authReadyResolve;
  let authReadyPromise = new Promise(resolve => { authReadyResolve = resolve; });

  // Firebase/internal keys are not part of the app backup.
  const EXCLUDED_KEYS = new Set([
    'hk-display-name',
    'hk-last-pulled',
    'hk-sync-status'
  ]);

  function appKeys(){
    const out = [];
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(k && !EXCLUDED_KEYS.has(k) && !k.startsWith('firebase:')) out.push(k);
    }
    return out;
  }

  function encodeKey(key){
    return 'k_' + btoa(unescape(encodeURIComponent(String(key))))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  function decodeKey(id){
    try{
      let s = id.slice(2).replace(/-/g,'+').replace(/_/g,'/');
      while(s.length % 4) s += '=';
      return decodeURIComponent(escape(atob(s)));
    }catch(e){ return null; }
  }

  function getLocalSnapshot(){
    const data = {};
    appKeys().forEach(k => {
      try { data[k] = localStorage.getItem(k); } catch(e) {}
    });
    return data;
  }

  function applySnapshot(data){
    if(!data || typeof data !== 'object') return;
    Object.keys(data).forEach(k=>{
      if(EXCLUDED_KEYS.has(k)) return;
      try{
        if(data[k] === null || data[k] === undefined) localStorage.removeItem(k);
        else localStorage.setItem(k, String(data[k]));
      }catch(e){}
    });
  }

  async function waitReady(){
    await ready;
    if(initError) throw initError;
    return true;
  }

  function setStatus(status){
    try { localStorage.setItem('hk-sync-status', status); } catch(e) {}
    window.dispatchEvent(new CustomEvent('hksyncstatus', {detail: status}));
  }

  async function getCloudEntries(fromServer){
    await waitReady();
    if(!currentUser) return {};
    const {collection, getDocs, getDocsFromServer} = firebase.firestore;
    const ref = collection(db, 'users', currentUser.uid, 'appdata');
    const snap = fromServer ? await getDocsFromServer(ref) : await getDocs(ref);
    const result = {};
    snap.forEach(docSnap=>{
      const key = decodeKey(docSnap.id);
      const d = docSnap.data() || {};
      if(key !== null) result[key] = d.value == null ? '' : String(d.value);
    });
    return result;
  }

  async function pushAll(){
    await waitReady();
    if(!currentUser) return {ok:false, reason:'NOT_LOGGED_IN'};
    if(syncing) return {ok:true, skipped:true};
    syncing = true;
    setStatus('syncing');
    try{
      const {collection, doc, setDoc, writeBatch} = firebase.firestore;
      const ref = collection(db, 'users', currentUser.uid, 'appdata');
      const snap = getLocalSnapshot();
      const batch = writeBatch(db);
      Object.keys(snap).forEach(k=>{
        batch.set(doc(ref, encodeKey(k)), {
          key: k,
          value: snap[k],
          updatedAt: Date.now()
        });
      });
      await batch.commit();
      lastSyncTime = Date.now();
      setStatus('synced');
      return {ok:true, data:snap, updatedAt:String(lastSyncTime)};
    }finally{
      syncing = false;
    }
  }

  async function pullInternal(fromServer){
    await waitReady();
    if(!currentUser) return {ok:false, data:null};
    setStatus('syncing');
    try{
      const remote = await getCloudEntries(!!fromServer);
      const hasRemote = Object.keys(remote).length > 0;
      if(hasRemote) applySnapshot(remote);
      setStatus('synced');
      const updatedAt = String(Date.now());
      try{ localStorage.setItem('hk-last-pulled', updatedAt); }catch(e){}
      return {ok:true, data:hasRemote ? remote : null, updatedAt};
    }catch(e){
      // Offline: keep local data. Firestore's persistent cache handles queued writes.
      setStatus(navigator.onLine ? 'error' : 'offline');
      throw e;
    }
  }

  HKSync.ready = waitReady;

  HKSync.status = async function(){
    try{
      await waitReady();
      await authReadyPromise;
      const u = auth.currentUser || currentUser;
      return {
        loggedIn: !!u,
        username: u ? (u.email || '') : null,
        uid: u ? u.uid : null,
        online: navigator.onLine
      };
    }catch(e){
      return {loggedIn:false, username:null, uid:null, online:navigator.onLine, error:e};
    }
  };

  HKSync.setSyncUser = function(username){
    if(username) try{ localStorage.setItem('hk-sync-user', username); }catch(e){}
  };

  HKSync.sync = async function(){ return pushAll(); };
  HKSync.pull = async function(){ return pullInternal(false); };
  HKSync.pullServer = async function(){
    try { return await pullInternal(true); }
    catch(e){
      // If temporarily offline, do not destroy existing local data.
      return {ok:false, data:null, offline:!navigator.onLine, error:e};
    }
  };

  HKSync.register = async function(email, password){
    await waitReady();
    const {createUserWithEmailAndPassword} = firebase.auth;
    const cred = await createUserWithEmailAndPassword(auth, String(email).trim(), password);
    currentUser = cred.user;
    HKSync.setSyncUser(cred.user.email || email);
    return cred.user;
  };

  HKSync.login = async function(email, password){
    await waitReady();
    const {signInWithEmailAndPassword} = firebase.auth;
    const cred = await signInWithEmailAndPassword(auth, String(email).trim(), password);
    currentUser = cred.user;
    HKSync.setSyncUser(cred.user.email || email);
    return cred.user;
  };

  HKSync.logout = async function(){
    await waitReady();
    await firebase.auth.signOut(auth);
    currentUser = null;
    try{ localStorage.removeItem('hk-sync-user'); }catch(e){}
    setStatus('local');
    return true;
  };

  // If internet comes back, Firestore itself uploads queued writes. We also
  // refresh the current local snapshot so changes made while offline are sent.
  window.addEventListener('online', ()=>{
    if(currentUser){
      setTimeout(()=>pushAll().catch(()=>{}), 500);
    }
  });

  function loadFirebaseModule(){
    const mod = document.createElement('script');
    mod.type = 'module';
    mod.textContent = `
      import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
      import { getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
      import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDocs, getDocsFromServer, writeBatch, setDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

      const config = ${JSON.stringify(FIREBASE_CONFIG)};
      try {
        const app = initializeApp(config);
        const authInstance = getAuth(app);
        try { await setPersistence(authInstance, browserLocalPersistence); } catch(e) {}
        let dbInstance;
        try {
          dbInstance = initializeFirestore(app, {
            localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
          });
        } catch(e) {
          dbInstance = getFirestore(app);
        }
        window.__HK_FIREBASE__ = {
          auth: { getAuth: ()=>authInstance, onAuthStateChanged, setPersistence, browserLocalPersistence,
                  createUserWithEmailAndPassword: async (a,e,p)=>(await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js")).createUserWithEmailAndPassword(a,e,p),
                  signInWithEmailAndPassword: async (a,e,p)=>(await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js")).signInWithEmailAndPassword(a,e,p),
                  signOut: async a=>(await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js")).signOut(a) },
          firestore: { collection, doc, getDocs, getDocsFromServer, writeBatch, setDoc },
          authInstance,
          dbInstance
        };
        window.dispatchEvent(new Event('hkfirebase-ready'));
      } catch(err) {
        window.__HK_FIREBASE_ERROR__ = err;
        window.dispatchEvent(new Event('hkfirebase-error'));
      }
    `;
    document.head.appendChild(mod);
  }

  function finishInit(){
    if(initialized) return;
    initialized = true;
    const fb = window.__HK_FIREBASE__;
    if(!fb){
      initError = window.__HK_FIREBASE_ERROR__ || new Error('Firebase initialize failed');
      readyResolve(false);
      return;
    }
    firebase = fb;
    auth = fb.authInstance;
    db = fb.dbInstance;
    fb.auth.onAuthStateChanged(auth, u=>{
      currentUser = u || null;
      authReadyResolve(u || null);
      if(u){
        HKSync.setSyncUser(u.email || '');
        setStatus(navigator.onLine ? 'synced' : 'offline');
      }else{
        setStatus('local');
      }
      window.dispatchEvent(new CustomEvent('hkauthchange', {detail:{user:u}}));
    });
    readyResolve(true);
  }

  window.addEventListener('hkfirebase-ready', finishInit, {once:true});
  window.addEventListener('hkfirebase-error', finishInit, {once:true});
  loadFirebaseModule();
})();
