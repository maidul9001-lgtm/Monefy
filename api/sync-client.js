/*
 * হিসাবের খাতা — Multi-device Firebase Sync
 *
 * গুরুত্বপূর্ণ নীতি:
 * 1) পুরো localStorage snapshot দিয়ে cloud overwrite করা হয় না।
 * 2) প্রতিটি key আলাদা Firestore document হিসেবে রাখা হয়।
 * 3) একই record-এর id থাকলে তিন-পক্ষীয় merge করা হয়: local / cloud / last-synced base।
 * 4) দুই ডিভাইসে নতুন expense/transaction যোগ হলে দুটোই রাখা হয়।
 * 5) কোনো record delete করলে সেই deletion-ও merge-এর মাধ্যমে অন্য ডিভাইসে যায়।
 * 6) Firestore transaction ব্যবহার করা হয়েছে, যাতে একই সময়ে দুই ডিভাইস sync করলেও
 *    একজনের সম্পূর্ণ snapshot আরেকজনকে overwrite না করে।
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
  const BASE_KEY = 'hk-sync-base-v3';
  const DEVICE_KEY = 'hk-sync-device-id-v3';
  const EXCLUDED_KEYS = new Set([
    'hk-display-name',
    'hk-last-pulled',
    'hk-sync-status',
    'hk-sync-user',
    BASE_KEY,
    DEVICE_KEY
  ]);

  let firebase = null, auth = null, db = null, currentUser = null;
  let initialized = false, initError = null, syncing = false;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  let authReadyResolve;
  const authReadyPromise = new Promise(resolve => { authReadyResolve = resolve; });

  function deviceId(){
    let id = localStorage.getItem(DEVICE_KEY);
    if(!id){
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function appKeys(){
    const out=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k && !EXCLUDED_KEYS.has(k) && !k.startsWith('firebase:')) out.push(k);
    }
    return out;
  }

  function readLocal(key){
    try{return localStorage.getItem(key);}catch(e){return null;}
  }
  function writeLocal(key,value){
    try{
      if(value===null || value===undefined) localStorage.removeItem(key);
      else localStorage.setItem(key,String(value));
    }catch(e){}
  }

  function loadBase(){
    try{return JSON.parse(readLocal(BASE_KEY)||'{}')||{};}catch(e){return {};}
  }
  function saveBase(base){
    try{localStorage.setItem(BASE_KEY,JSON.stringify(base));}catch(e){}
  }

  function clone(v){
    if(v===undefined) return undefined;
    try{return JSON.parse(JSON.stringify(v));}catch(e){return v;}
  }
  function same(a,b){
    return JSON.stringify(a)===JSON.stringify(b);
  }
  function hasOwn(o,k){return Object.prototype.hasOwnProperty.call(o,k);}

  function parseValue(raw){
    if(raw===null || raw===undefined) return null;
    try{return JSON.parse(raw);}catch(e){return raw;}
  }
  function stringifyValue(v){
    if(v===undefined) return null;
    try{return JSON.stringify(v);}catch(e){return String(v);}
  }

  /*
   * Arrays of objects with an id are treated as records.
   * This is what protects daily expenses, bank transactions, monthly ledger
   * entries, recharge records, etc. from whole-array overwrites.
   */
  function isIdArray(v){
    return Array.isArray(v) && v.length>0 && v.every(x => x && typeof x==='object' && !Array.isArray(x) && x.id!=null);
  }

  function mergeIdArray(local, remote, base){
    const L = Array.isArray(local)?local:[];
    const R = Array.isArray(remote)?remote:[];
    const B = Array.isArray(base)?base:[];
    const lm=new Map(L.map(x=>[String(x.id),x]));
    const rm=new Map(R.map(x=>[String(x.id),x]));
    const bm=new Map(B.map(x=>[String(x.id),x]));
    const ids=new Set([...lm.keys(),...rm.keys(),...bm.keys()]);
    const result=[];

    ids.forEach(id=>{
      const l=lm.get(id), r=rm.get(id), b=bm.get(id);
      const lHas=lm.has(id), rHas=rm.has(id), bHas=bm.has(id);

      // A record that existed in the last common base and disappeared on
      // either side is considered deleted. This propagates deletions.
      if(bHas && (!lHas || !rHas)) return;

      if(lHas && rHas){
        if(bHas) result.push(mergeValue(l,r,b));
        else result.push(mergeValue(l,r,undefined));
      }else if(lHas){
        result.push(clone(l));
      }else if(rHas){
        result.push(clone(r));
      }
    });

    // Keep the user's existing ordering as much as possible, then append
    // records that arrived from another device.
    const order=[];
    L.forEach(x=>{if(x&&x.id!=null) order.push(String(x.id));});
    R.forEach(x=>{if(x&&x.id!=null && !order.includes(String(x.id))) order.push(String(x.id));});
    const byId=new Map(result.map(x=>[String(x.id),x]));
    return order.map(id=>byId.get(id)).filter(Boolean);
  }

  function mergePrimitive(local,remote,base){
    if(same(local,remote)) return clone(local);
    if(base!==undefined){
      if(same(local,base)) return clone(remote);
      if(same(remote,base)) return clone(local);
    }
    // On a first login (no common base), an existing cloud scalar wins over
    // the default/stale local scalar; if cloud is empty, keep local.
    if(base===undefined){
      if(remote!==undefined && remote!==null) return clone(remote);
      return clone(local);
    }
    // Both devices changed the same scalar. Last transaction writer wins.
    return clone(local);
  }

  function mergeValue(local,remote,base){
    if(Array.isArray(local) || Array.isArray(remote) || Array.isArray(base)){
      if(isIdArray(local) || isIdArray(remote) || isIdArray(base)){
        return mergeIdArray(local,remote,base);
      }
      if(same(local,remote)) return clone(local);
      if(base!==undefined && same(local,base)) return clone(remote);
      if(base!==undefined && same(remote,base)) return clone(local);
      // Primitive/config arrays: union unique values instead of overwriting.
      const a=Array.isArray(local)?local:[];
      const b=Array.isArray(remote)?remote:[];
      const out=[];
      [...a,...b].forEach(x=>{if(!out.some(y=>same(y,x)))out.push(clone(x));});
      return out;
    }

    const lo=local && typeof local==='object';
    const ro=remote && typeof remote==='object';
    const bo=base && typeof base==='object';
    if(lo || ro || bo){
      const L=lo?local:{}; const R=ro?remote:{}; const B=bo?base:{};
      const keys=new Set([...Object.keys(L),...Object.keys(R),...Object.keys(B)]);
      const out={};
      keys.forEach(k=>{
        const lHas=hasOwn(L,k), rHas=hasOwn(R,k), bHas=hasOwn(B,k);
        if(bHas && (!lHas || !rHas)){
          // If the field was in the common base and disappeared from either
          // side, treat it as a deletion.
          return;
        }
        const v=mergeValue(lHas?L[k]:undefined,rHas?R[k]:undefined,bHas?B[k]:undefined);
        if(v!==undefined) out[k]=v;
      });
      return out;
    }
    return mergePrimitive(local,remote,base);
  }

  function setStatus(status){
    try{localStorage.setItem('hk-sync-status',status);}catch(e){}
    window.dispatchEvent(new CustomEvent('hksyncstatus',{detail:status}));
    console.log('[HKSync]', status);
  }

  async function waitReady(){
    await ready;
    if(initError) throw initError;
    return true;
  }

  async function status(){
    try{
      await waitReady(); await authReadyPromise;
      const u=auth.currentUser||currentUser;
      return {loggedIn:!!u,username:u?(u.email||''):null,uid:u?u.uid:null,online:navigator.onLine};
    }catch(e){
      return {loggedIn:false,username:null,uid:null,online:navigator.onLine,error:e};
    }
  }

  async function syncKey(key, base){
    const {collection,doc,runTransaction}=firebase.firestore;
    const ref=doc(collection(db,'users',currentUser.uid,'appdata'),encodeKey(key));
    const localRaw=readLocal(key);
    const baseRaw=hasOwn(base,key)?base[key]:undefined;
    const localValue=parseValue(localRaw);
    const baseValue=baseRaw===undefined?undefined:parseValue(baseRaw);

    let mergedRaw=null;
    await runTransaction(db, async transaction=>{
      const snap=await transaction.get(ref);
      const remoteRaw=snap.exists() && snap.data() ? snap.data().value : null;
      const remoteValue=parseValue(remoteRaw);
      const merged=mergeValue(localValue,remoteValue,baseValue);
      mergedRaw=stringifyValue(merged);
      transaction.set(ref,{
        key,
        value:mergedRaw,
        updatedAt:Date.now(),
        updatedBy:deviceId(),
        syncVersion:3
      });
    });

    writeLocal(key,mergedRaw);
    base[key]=mergedRaw;
    return mergedRaw;
  }

  function encodeKey(key){
    return 'k_'+btoa(unescape(encodeURIComponent(String(key))))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function decodeKey(id){
    try{
      let s=id.slice(2).replace(/-/g,'+').replace(/_/g,'/');
      while(s.length%4)s+='=';
      return decodeURIComponent(escape(atob(s)));
    }catch(e){return null;}
  }

  async function syncAll(full){
    await waitReady();
    await authReadyPromise;
    if(!currentUser) return {ok:false,reason:'NOT_LOGGED_IN'};
    if(syncing) return {ok:true,skipped:true};
    syncing=true; setStatus('syncing');
    try{
      const base=loadBase();
      const allKeys=new Set([...appKeys(),...Object.keys(base)]);
      // Cheap mode (default): only touch keys that changed locally since the
      // last synced base. This avoids running a Firestore read+write
      // transaction for every key on every periodic tick, which is what
      // burns through the Firestore free-tier daily quota fast.
      // Full mode: check every key, so changes made only on another device
      // (never touched locally here) still get pulled down.
      let keys;
      if(full){
        keys = allKeys;
      }else{
        keys = new Set();
        allKeys.forEach(k=>{
          const localRaw = readLocal(k);
          const baseRaw = hasOwn(base,k) ? base[k] : undefined;
          if(localRaw !== baseRaw) keys.add(k);
        });
      }
      const changed={};
      for(const key of keys){
        const before=readLocal(key);
        const after=await syncKey(key,base);
        if(before!==after) changed[key]=after;
      }
      saveBase(base);
      const now=String(Date.now());
      try{localStorage.setItem('hk-last-pulled',now);}catch(e){}
      setStatus('synced');
      return {ok:true,data:changed,updatedAt:now};
    }catch(e){
      setStatus(navigator.onLine?'error':'offline');
      console.log('[HKSync] error', e);
      return {ok:false,error:e,offline:!navigator.onLine};
    }finally{syncing=false;}
  }

  async function pull(){
    // Pull is intentionally implemented through the same merge transaction as
    // sync. A pull-only overwrite would reintroduce the multi-device data-loss bug.
    // Full check: an explicit pull should catch everything, including changes
    // made only on another device.
    return syncAll(true);
  }

  async function deleteKeys(keys){
    await waitReady();
    if(!currentUser)return {ok:false,reason:'NOT_LOGGED_IN'};
    try{
      const {collection,doc,deleteDoc,writeBatch}=firebase.firestore;
      const ref=collection(db,'users',currentUser.uid,'appdata');
      const batch=writeBatch(db);
      (keys||[]).forEach(k=>batch.delete(doc(ref,encodeKey(k))));
      await batch.commit();
      const base=loadBase();
      (keys||[]).forEach(k=>{delete base[k];try{localStorage.removeItem(k);}catch(e){}});
      saveBase(base); setStatus('synced');
      return {ok:true,updatedAt:String(Date.now())};
    }catch(e){setStatus(navigator.onLine?'error':'offline');return {ok:false,error:e};}
  }

  HKSync.ready=waitReady;
  HKSync.status=status;
  HKSync.setSyncUser=function(username){if(username)try{localStorage.setItem('hk-sync-user',username);}catch(e){}};
  HKSync.sync=function(){ return syncAll(true); };
  HKSync.pull=pull;
  HKSync.pullServer=pull;
  HKSync.deleteKeys=deleteKeys;

  HKSync.register=async function(email,password){
    await waitReady();
    const {createUserWithEmailAndPassword}=firebase.auth;
    const cred=await createUserWithEmailAndPassword(auth,String(email).trim(),password);
    currentUser=cred.user; HKSync.setSyncUser(cred.user.email||email); return cred.user;
  };
  HKSync.login=async function(email,password){
    await waitReady();
    const {signInWithEmailAndPassword}=firebase.auth;
    const cred=await signInWithEmailAndPassword(auth,String(email).trim(),password);
    currentUser=cred.user; HKSync.setSyncUser(cred.user.email||email); return cred.user;
  };
  HKSync.logout=async function(){
    await waitReady(); await firebase.auth.signOut(auth); currentUser=null;
    try{localStorage.removeItem('hk-sync-user');}catch(e){}
    setStatus('local'); return true;
  };

  window.addEventListener('online',()=>{if(currentUser)setTimeout(()=>syncAll(true),700);});

  // Periodic auto-sync: catches new/edited entries even if the app page
  // never calls HKSync.sync() itself after saving data.
  // - Every 20s: cheap "dirty-only" check — only keys changed locally get a
  //   Firestore transaction, so this costs ~0 reads/writes when nothing changed.
  // - Every 3 min: a "full" check that also pulls in changes made only on
  //   another device (needed since the cheap check can't see those).
  // This combination keeps Firestore usage far below the free-tier daily
  // quota compared to running a full per-key check on every tick.
  setInterval(()=>{ if(currentUser && !syncing) syncAll(false); }, 20000);
  setInterval(()=>{ if(currentUser && !syncing) syncAll(true); }, 180000);
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='visible' && currentUser && !syncing) syncAll(true);
  });

  function loadFirebaseModule(){
    const mod=document.createElement('script'); mod.type='module';
    mod.textContent=`
      import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
      import { getAuth,onAuthStateChanged,setPersistence,browserLocalPersistence } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
      import { initializeFirestore,getFirestore,persistentLocalCache,persistentMultipleTabManager,collection,doc,getDocs,getDocsFromServer,writeBatch,setDoc,deleteDoc,runTransaction } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
      const config=${JSON.stringify(FIREBASE_CONFIG)};
      try{
        const app=initializeApp(config);
        const authInstance=getAuth(app);
        try{await setPersistence(authInstance,browserLocalPersistence);}catch(e){}
        let dbInstance;
        try{dbInstance=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})});}
        catch(e){dbInstance=getFirestore(app);}
        window.__HK_FIREBASE__={
          auth:{getAuth:()=>authInstance,onAuthStateChanged,setPersistence,browserLocalPersistence,
                createUserWithEmailAndPassword: async (a,e,p)=>(await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js")).createUserWithEmailAndPassword(a,e,p),
                signInWithEmailAndPassword: async (a,e,p)=>(await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js")).signInWithEmailAndPassword(a,e,p),
                signOut: async a=>(await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js")).signOut(a)},
          firestore:{collection,doc,getDocs,getDocsFromServer,writeBatch,setDoc,deleteDoc,runTransaction},
          authInstance,dbInstance
        };
        window.dispatchEvent(new Event('hkfirebase-ready'));
      }catch(err){window.__HK_FIREBASE_ERROR__=err;window.dispatchEvent(new Event('hkfirebase-error'));}
    `;
    document.head.appendChild(mod);
  }

  function finishInit(){
    if(initialized)return; initialized=true;
    const fb=window.__HK_FIREBASE__;
    if(!fb){
      initError=window.__HK_FIREBASE_ERROR__||new Error('Firebase initialize failed');
      console.log('[HKSync] init-failed', initError);
      readyResolve(false); return;
    }
    firebase=fb; auth=fb.authInstance; db=fb.dbInstance;
    fb.auth.onAuthStateChanged(auth,u=>{
      currentUser=u||null; authReadyResolve(u||null);
      if(u){
        HKSync.setSyncUser(u.email||''); setStatus(navigator.onLine?'synced':'offline');
        setTimeout(()=>syncAll(true),150);
      }else setStatus('local');
      window.dispatchEvent(new CustomEvent('hkauthchange',{detail:{user:u}}));
    });
    readyResolve(true);
  }

  window.addEventListener('hkfirebase-ready',finishInit,{once:true});
  window.addEventListener('hkfirebase-error',finishInit,{once:true});
  loadFirebaseModule();
})();
