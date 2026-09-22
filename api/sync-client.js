/*
 * হিসাবের খাতা — Firebase/Firestore Sync Client (v3 — entry-level merge)
 *
 * HKSync-এর পুরোনো API (status, login, register, logout, sync, pull, deleteKeys,
 * conflicts, restoreConflicts, discardConflicts ...) হুবহু একই আছে — অ্যাপের কোড না বদলেও চলবে।
 *
 * মূল বদল (v2 থেকে v3):
 *  - আগে প্রতিটি sync-key (যেমন 'daily-expense-data') পুরোটাই এক টুকরা হিসেবে জিততো বা হারতো —
 *    দুই ডিভাইসে আলাদা এন্ট্রি যোগ হলে একটা ডিভাইসের এন্ট্রি সম্পূর্ণ চাপা পড়ে যেত।
 *  - এখন প্রতিটি key-র ভেতরের array-গুলো (entries, transactions, incomeEntries, accounts,
 *    categories, ইত্যাদি) তাদের নিজস্ব id (বা primitive হলে নিজের মান) দিয়ে চেনা হয়, এবং
 *    ৩-দিক merge করা হয়: base (শেষ successfully sync হওয়া মান, hk-sync-base-এ রাখা), local, remote।
 *      • base-এ ছিল না এমন নতুন item দুই পাশেই রাখা হয় (union) — যেমন Device A "আম" আর
 *        Device B "জাম" যোগ করলে sync-এর পর দুটোই থাকবে, টাকার হিসাব ঠিকভাবে যোগ হবে।
 *      • base-এ ছিল কিন্তু এক পাশ থেকে বাদ গেছে এমন item ডিলিট হয়েছে ধরে বাদ দেওয়া হয়
 *        (অন্য পাশে অক্ষত থাকলেও)।
 *      • একই id-র item-এর ভেতরের মান দুই পাশেই আলাদাভাবে বদলেছে (আসল সংঘর্ষ) — তখনই শুধু
 *        পুরোনো পদ্ধতির মতো newer পাশ জেতে, আর আগের local ভার্সন কপি হয়ে থাকে (HKSync.conflicts())।
 *      • একই কারণে: এক পাশে item এডিট হয়েছে আর অন্য পাশে সেটাই ডিলিট হয়েছে — এটাও সংঘর্ষ ধরা হয়
 *        (base-এর সাথে তুলনা করে বোঝা হয় সত্যিই এডিট হয়েছিল কিনা), newer পাশ জেতে; শুধু "অপরিবর্তিত
 *        item অন্য পাশে ডিলিট হয়েছে" হলেই নিঃশব্দে ডিলিট মেনে নেওয়া হয়, নয়তো conflict নোটিফাই হয়।
 *  - প্রথমবার (কোনো base না থাকলে) merge হয় pure union হিসেবে — কিছু হারায় না, ডিলিট বোঝা যায় না;
 *    এরপর থেকে base তৈরি হয়ে গেলে ডিলিট ঠিকমতো সব ডিভাইসে ছড়ায়।
 *  - key parse করা না গেলে (অচেনা ফরম্যাট) নিরাপদে পুরোনো v2 binary (পুরো-key জেতা/হারা) লজিকে
 *    fallback করে — কোনো নতুন ধরনের ডাটার জন্যও অ্যাপ ভেঙে পড়বে না।
 *  - মোছা (পুরো key reset) এখনও tombstone দিয়ে হয়, তাই অন্য ডিভাইস থেকে পুরো ডাটাসেট ফিরে আসে না।
 *  - Firebase SDK লোড না হলে নিজে থেকে আবার চেষ্টা করে; sync-এর ফলাফল সবসময় স্পষ্ট।
 *
 * v3.1 — নিরাপদ logout:
 *  - লগ আউট করলে এই ডিভাইস থেকে account-এর ডাটা (SYNC_KEYS + meta/base/conflict) মুছে ফেলা হয়,
 *    যাতে একই ডিভাইসে পরে অন্য অ্যাকাউন্টে লগইন করলে আগের অ্যাকাউন্টের তথ্য নতুন অ্যাকাউন্টে
 *    merge হয়ে না যায় (entry-level merge আসার পর এই leak সম্ভব ছিল)।
 *  - মোছার আগে: unsynced (dirty) তথ্য থাকলে আগে online-এ থাকলে চুপচাপ sync করার চেষ্টা করা হয়;
 *    তাও sync না হলে (অফলাইন/ব্যর্থ) logout আটকে যায় এবং { reason:'UNSYNCED_PENDING', dirtyKeys }
 *    ফেরত দেয় — অ্যাপের UI-কে ইউজারকে জানিয়ে জিজ্ঞেস করতে হয়, তারপর HK.logout({force:true})
 *    দিয়ে আবার কল করলে সত্যিই মুছে/logout হবে।
 *  - পরে একই অ্যাকাউন্টে আবার লগইন করলে HK.login()-এর auto-sync cloud থেকে সব ফিরিয়ে আনবে।
 */
(function(){
  'use strict';

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyBEzDeNjuksnmh_BErw659Xei1PWWbzF4E",
    authDomain: "hishaber-5d889.firebaseapp.com",
    projectId: "hishaber-5d889",
    storageBucket: "hishaber-5d889.firebasestorage.app",
    messagingSenderId: "531628905925",
    appId: "1:531628905925:web:58db35ded48deeefcae7ac"
  };
  var FB_VERSION = '12.19.0';
  var FB_BASE = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';

  // শুধু এই key-গুলো ক্লাউডে যায়। থিম/ডিসপ্লে সেটিং ডিভাইস-নির্ভর, তাই বাদ।
  var SYNC_KEYS = [
    'daily-expense-data',
    'daily-expense-subcategories',
    'daily-expense-categories',
    'daily-expense-category-order',
    'daily-expense-category-order-v2',
    'ledger-months',
    'ledger-data',
    'bank-account-data',
    'primary-expense-limit',
    'primary-expense-settings'
  ];
  var META_KEY = 'hk-meta';              // key-ভিত্তিক সময়-চিহ্ন (sync হয় না)
  var ACCOUNT_KEY = 'hk-meta-uid';       // meta কোন অ্যাকাউন্টের
  var CONFLICT_PREFIX = 'hk-conflict-';  // হেরে যাওয়া কপি
  var BASE_KEY = 'hk-sync-base';         // প্রতিটি key-র শেষ sync হওয়া মান (৩-দিক merge-এর ভিত্তি)
  var MAX_DOC_BYTES = 900000;            // Firestore ডকুমেন্ট সীমা ~1 MiB
  var COMMIT_TIMEOUT_MS = 20000;
  var POLL_MS = 2500;

  var HK = window.HKSync = window.HKSync || {};
  HK.version = '3.1';

  // ---------- ছোট সহায়ক ----------
  function now(){ return Date.now(); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function hkError(code, msg){ var e = new Error(msg || code); e.code = code; return e; }
  function isOnline(){ try{ return navigator.onLine !== false; }catch(e){ return true; } }
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k, v){ try{ localStorage.setItem(k, v); return true; }catch(e){ return false; } }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
  function fire(name, detail){
    try{ window.dispatchEvent(new CustomEvent(name, { detail: detail })); }catch(e){}
  }
  function hashStr(s){
    var h1 = 0x811c9dc5, h2 = 5381;
    for(var i = 0; i < s.length; i++){
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619);
      h2 = (Math.imul(h2, 33) ^ c) | 0;
    }
    return s.length.toString(36) + '.' + (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36);
  }
  function byteLen(s){
    try{ return new TextEncoder().encode(s).length; }catch(e){ return s.length * 3; }
  }
  function encodeKey(key){
    return 'k_' + btoa(unescape(encodeURIComponent(key))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function decodeKey(id){
    var b = String(id).replace(/^k_/,'').replace(/-/g,'+').replace(/_/g,'/');
    while(b.length % 4) b += '=';
    return decodeURIComponent(escape(atob(b)));
  }

  // ---------- meta: প্রতি key-র সময়-চিহ্ন ----------
  // m = { h: বর্তমান hash (null = নেই), t: শেষ বদলের সময়, sh: শেষ sync-এর hash,
  //       sr: শেষ sync-এর cloud সময়, del: মোছার স্পষ্ট নির্দেশ, amb: পেজ-লোডের স্বয়ংক্রিয় বদল }
  function loadMeta(){
    try{
      var m = JSON.parse(lsGet(META_KEY) || '{}');
      return (m && typeof m === 'object') ? m : {};
    }catch(e){ return {}; }
  }
  function saveMeta(m){ lsSet(META_KEY, JSON.stringify(m)); }

  // ---------- base: প্রতিটি key-র শেষ সফল sync-এর পুরো মান (৩-দিক merge করতে লাগে) ----------
  function loadBase(){
    try{
      var b = JSON.parse(lsGet(BASE_KEY) || '{}');
      return (b && typeof b === 'object') ? b : {};
    }catch(e){ return {}; }
  }
  function saveBase(b){ lsSet(BASE_KEY, JSON.stringify(b)); }

  function refreshMeta(initial){
    var meta = loadMeta(), changed = false, t = now();
    SYNC_KEYS.forEach(function(k){
      var v = lsGet(k);
      var h = v === null ? null : hashStr(v);
      var m = meta[k];
      if(!m){
        // পেজ লোডের সময় আগে থেকে থাকা key → সময় অজানা (t:0, সবচেয়ে পুরোনো)।
        // পেজ চলাকালীন প্রথমবার লেখা key → ইউজারের সত্যিকারের এডিট, তাই এখনকার সময়।
        if(v !== null){ meta[k] = { h: h, t: initial ? 0 : t }; changed = true; }
        return;
      }
      if(m.h !== h){
        m.h = h;
        // পেজ লোডের সময়কার বদল সম্ভবত অ্যাপের নিজের normalization — এটাকে "নতুন এডিট" ধরা হয় না
        if(initial){ m.amb = true; } else { m.t = t; delete m.amb; }
        if(h !== null) delete m.del;
        changed = true;
      }
    });
    if(changed) saveMeta(meta);
    return meta;
  }
  function isDirty(meta){
    return SYNC_KEYS.some(function(k){
      var m = meta[k];
      if(!m) return false;
      if(m.del) return true;
      if(m.sh === undefined) return m.h !== null;
      return m.h !== m.sh;
    });
  }
  function adoptAccount(meta, uid){
    var oldUid = lsGet(ACCOUNT_KEY);
    if(oldUid === uid) return meta;

    Object.keys(meta).forEach(function(k){
      delete meta[k].sh;
      delete meta[k].sr;
      delete meta[k].del;
      // Account isolation: অন্য অ্যাকাউন্টের ডাটা এই অ্যাকাউন্টের cloud-কে overwrite করতে পারবে না।
      // (এই ডিভাইসে আগে কোনো অ্যাকাউন্টই ছিল না — oldUid ফাঁকা — তখন লোকাল এডিটের সময় অক্ষুণ্ণ থাকে।)
      if(oldUid){ delete meta[k].amb; meta[k].t = 0; }
    });

    saveMeta(meta);
    lsSet(ACCOUNT_KEY, uid);
    // পুরোনো অ্যাকাউন্টের conflict কপি মোছা হয় না; কিন্তু নতুন অ্যাকাউন্টে দেখানো/ফেরানোও হয় না।
    return meta;
  }

  // ---------- conflict কপি ----------
  function saveBackup(k, rec){
    rec.savedAt = now();
    rec.uid = lsGet(ACCOUNT_KEY) || null;
    return lsSet(CONFLICT_PREFIX + k, JSON.stringify(rec));
  }
  function listConflicts(){
    var out = [];
    try{
      for(var i = 0; i < localStorage.length; i++){
        var name = localStorage.key(i);
        if(name && name.indexOf(CONFLICT_PREFIX) === 0){
          try{
            var rec = JSON.parse(localStorage.getItem(name));
            if(rec.uid && rec.uid !== lsGet(ACCOUNT_KEY)) continue;   // অন্য অ্যাকাউন্টের কপি
            out.push({ key: name.slice(CONFLICT_PREFIX.length), side: rec.side, t: rec.t, savedAt: rec.savedAt, notify: !!rec.notify });
          }catch(e){}
        }
      }
    }catch(e){}
    return out;
  }

  // ---------- সিদ্ধান্ত: একটি key-র জন্য কী করতে হবে ----------
  // localVal: string|null, m: meta, rem: {value, deleted, r} | undefined
  function planKey(localVal, m, rem){
    var lh = localVal === null ? null : hashStr(localVal);
    var lt = m ? (m.t || 0) : 0;

    if(m && m.del && localVal === null){                 // স্পষ্ট মোছার নির্দেশ (reset)
      if(!rem || rem.deleted) return { action: 'none' };
      return { action: 'push', t: Math.max(lt || now(), rem.r + 1) };
    }
    if(!rem){
      return localVal !== null ? { action: 'push', t: lt || now() } : { action: 'none' };
    }
    var rv = rem.deleted ? null : rem.value;
    if(rv === localVal) return { action: 'synced' };

    var everSynced = !!m && m.sh !== undefined;
    var localChanged = !everSynced || m.sh !== lh;
    var remoteChanged = !everSynced || m.sr !== rem.r;

    if(!localChanged) return { action: 'apply' };        // লোকাল অপরিবর্তিত → cloud-এর নতুনটা নাও
    if(!remoteChanged) return { action: 'push', t: Math.max(lt || now(), rem.r + 1) };

    // দুই দিকেই বদল হয়েছে → নতুনটা জেতে, হেরেটা কপি করে রাখা হয়
    if(lt > rem.r){
      return { action: 'push', t: Math.max(lt, rem.r + 1),
               conflict: { side: 'remote', value: rv, t: rem.r } };
    }
    return { action: 'apply', conflict: { side: 'local', value: localVal, t: lt } };
  }

  // ---------- entry-level merge engine (৩-দিক: base = শেষ sync, local, remote) ----------
  // প্রতিটা array-কে item-এর নিজস্ব id (বা primitive হলে তার মান) দিয়ে চেনা হয়, তারপর:
  //   - শুধু এক পাশে নতুন item থাকলে (base-এ ছিল না) → রাখা হয় (union)
  //   - base-এ ছিল কিন্তু এক পাশ থেকে বাদ গেছে → সেই পাশ থেকে ডিলিট করা হয়েছে ধরা হয় → বাদ থাকে
  //   - দুই পাশেই আছে কিন্তু ভেতরের মান আলাদা → recursively merge (object) অথবা newer পাশ জেতে (leaf conflict)
  function isPlainObj(v){ return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function stableStringify(v){ try{ return JSON.stringify(v); }catch(e){ return String(v); } }
  function identityOf(item){
    if(isPlainObj(item) && item.id !== undefined && item.id !== null) return 'id:' + String(item.id);
    return 'v:' + stableStringify(item);
  }

  // ctx.conflict সত্যি হয় যদি কোনো leaf/item-এ সত্যিকারের দ্বিমুখী সংঘর্ষ resolve করতে হয়
  function mergeArray(baseArr, localArr, remoteArr, sideWinner, ctx){
    baseArr = Array.isArray(baseArr) ? baseArr : [];
    localArr = Array.isArray(localArr) ? localArr : [];
    remoteArr = Array.isArray(remoteArr) ? remoteArr : [];

    function toMap(arr){
      var m = {}; arr.forEach(function(it){ m[identityOf(it)] = it; }); return m;
    }
    var baseMap = toMap(baseArr), localMap = toMap(localArr), remoteMap = toMap(remoteArr);
    var order = [], seen = {};
    localArr.forEach(function(it){ var id = identityOf(it); if(!seen[id]){ order.push(id); seen[id] = true; } });
    remoteArr.forEach(function(it){ var id = identityOf(it); if(!seen[id]){ order.push(id); seen[id] = true; } });

    var out = [];
    order.forEach(function(id){
      var inBase = Object.prototype.hasOwnProperty.call(baseMap, id);
      var inLocal = Object.prototype.hasOwnProperty.call(localMap, id);
      var inRemote = Object.prototype.hasOwnProperty.call(remoteMap, id);
      if(inLocal && inRemote){
        var lv = localMap[id], rv = remoteMap[id];
        if(stableStringify(lv) === stableStringify(rv)){ out.push(lv); return; }
        out.push(mergeValue(inBase ? baseMap[id] : undefined, lv, rv, sideWinner, ctx));
        return;
      }
      if(inLocal && !inRemote){
        if(inBase){
          var baseItemL = baseMap[id], localItemL = localMap[id];
          if(stableStringify(baseItemL) === stableStringify(localItemL)) return; // local অপরিবর্তিত, remote-এ সত্যিই ডিলিট হয়েছে → বাদ
          // local এই item এডিট করেছে base-এর পর, কিন্তু remote পুরোটাই ডিলিট করে দিয়েছে — আসল edit-vs-delete সংঘর্ষ
          if(ctx) ctx.conflict = true;
          if(sideWinner === 'local') out.push(localItemL);   // local-এর এডিট নতুন হলে টিকে থাকে (undelete)
          return;                                             // remote নতুন হলে ডিলিটই জেতে
        }
        out.push(localMap[id]);          // নতুন local addition
        return;
      }
      if(inRemote && !inLocal){
        if(inBase){
          var baseItemR = baseMap[id], remoteItemR = remoteMap[id];
          if(stableStringify(baseItemR) === stableStringify(remoteItemR)) return; // remote অপরিবর্তিত, local-এ সত্যিই ডিলিট হয়েছে → বাদ
          // remote এই item এডিট করেছে base-এর পর, কিন্তু local পুরোটাই ডিলিট করে দিয়েছে — আসল edit-vs-delete সংঘর্ষ
          if(ctx) ctx.conflict = true;
          if(sideWinner === 'remote') out.push(remoteItemR); // remote-এর এডিট নতুন হলে টিকে থাকে (undelete)
          return;                                             // local নতুন হলে ডিলিটই জেতে
        }
        out.push(remoteMap[id]);         // নতুন remote addition
        return;
      }
      // দুই পাশেই নেই (base-এই শুধু ছিল, দুই পাশ থেকেই মোছা) → বাদ
    });
    return out;
  }

  // base/local/remote যেকোনো JSON মান (object, array, বা primitive) নিয়ে recursively merge করে
  function mergeValue(base, local, remote, sideWinner, ctx){
    if(stableStringify(local) === stableStringify(remote)) return local;

    if(Array.isArray(local) || Array.isArray(remote)){
      var merged = mergeArray(base, local || [], remote || [], sideWinner, ctx);
      return merged;
    }
    if(isPlainObj(local) && isPlainObj(remote)){
      var baseObj = isPlainObj(base) ? base : {};
      var keys = {};
      Object.keys(baseObj).forEach(function(k){ keys[k] = true; });
      Object.keys(local).forEach(function(k){ keys[k] = true; });
      Object.keys(remote).forEach(function(k){ keys[k] = true; });
      var out = {};
      Object.keys(keys).forEach(function(k){
        var hasB = Object.prototype.hasOwnProperty.call(baseObj, k);
        var bV = hasB ? baseObj[k] : undefined;
        var hasL = Object.prototype.hasOwnProperty.call(local, k);
        var hasR = Object.prototype.hasOwnProperty.call(remote, k);
        if(!hasL && !hasR) return;
        if(!hasL){ if(hasB) return; out[k] = remote[k]; return; }   // base-এ ছিল, local-এ নেই → local-এ মোছা হয়েছে
        if(!hasR){ if(hasB) return; out[k] = local[k]; return; }    // base-এ ছিল, remote-এ নেই → remote-এ মোছা হয়েছে
        var lV = local[k], rV = remote[k];
        if(stableStringify(lV) === stableStringify(rV)){ out[k] = lV; return; }
        if(hasB && stableStringify(bV) === stableStringify(lV)){ out[k] = rV; return; }  // শুধু remote বদলেছে
        if(hasB && stableStringify(bV) === stableStringify(rV)){ out[k] = lV; return; }  // শুধু local বদলেছে
        out[k] = mergeValue(bV, lV, rV, sideWinner, ctx);
      });
      return out;
    }
    // leaf-এ সত্যিকারের সংঘর্ষ (দুই পাশই আলাদা মানে বদলে গেছে) → newer পাশ জেতে
    if(ctx) ctx.conflict = true;
    return sideWinner === 'local' ? local : remote;
  }

  // ---------- Firebase লোড (retry সহ) ----------
  var fb = null, fbReady = false, initInFlight = false, initAttempts = 0, initTimer = null;
  var readyResolve, authResolve;
  var readyPromise = new Promise(function(r){ readyResolve = r; });
  var authReadyPromise = new Promise(function(r){ authResolve = r; });
  var currentUser = null;

  async function loadFirebase(){
    if(typeof window.__HK_TEST_FIREBASE__ === 'function') return window.__HK_TEST_FIREBASE__();
    var mods = await Promise.all([
      import(FB_BASE + 'firebase-app.js'),
      import(FB_BASE + 'firebase-auth.js'),
      import(FB_BASE + 'firebase-firestore.js')
    ]);
    var appM = mods[0], authM = mods[1], fsM = mods[2];
    var app = appM.getApps().length ? appM.getApp() : appM.initializeApp(FIREBASE_CONFIG);
    var authInstance = authM.getAuth(app);
    try{ await authM.setPersistence(authInstance, authM.browserLocalPersistence); }catch(e){}
    var dbInstance;
    try{
      dbInstance = fsM.initializeFirestore(app, {
        localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() })
      });
    }catch(e){ dbInstance = fsM.getFirestore(app); }
    return {
      authInstance: authInstance,
      onAuthStateChanged: function(cb){ return authM.onAuthStateChanged(authInstance, cb); },
      signIn: function(e, p){ return authM.signInWithEmailAndPassword(authInstance, e, p); },
      createUser: function(e, p){ return authM.createUserWithEmailAndPassword(authInstance, e, p); },
      signOut: function(){ return authM.signOut(authInstance); },
      colRef: function(uid){ return fsM.collection(dbInstance, 'users', uid, 'appdata'); },
      docRef: function(col, id){ return fsM.doc(col, id); },
      getDocsFromServer: function(col){ return fsM.getDocsFromServer(col); },
      batch: function(){ return fsM.writeBatch(dbInstance); }
    };
  }

  async function initFirebase(){
    if(fbReady || initInFlight) return;
    initInFlight = true;
    try{
      var inst = await loadFirebase();
      fb = inst;
      fbReady = true;
      fb.onAuthStateChanged(function(u){
        currentUser = u || null;
        authResolve(currentUser);
        if(u){ HK.setSyncUser(u.email || ''); setStatus(isOnline() ? 'syncing' : 'offline'); }
        else setStatus('local');
        fire('hkauthchange', { user: u || null });
        if(u) setTimeout(function(){ autoSync(true, 0); }, 300);
      });
      readyResolve(true);
    }catch(e){
      initAttempts++;
      var delay = Math.min(60000, 3000 * Math.pow(2, initAttempts - 1));
      initTimer = setTimeout(initFirebase, delay);
    }finally{
      initInFlight = false;
    }
  }
  function retryInit(){
    if(fbReady) return;
    if(initTimer){ clearTimeout(initTimer); initTimer = null; }
    initFirebase();
  }
  function waitReady(ms){
    if(fbReady) return Promise.resolve(true);
    return Promise.race([
      readyPromise,
      sleep(ms || 8000).then(function(){ throw hkError('hk/not-ready', 'Firebase লোড হয়নি'); })
    ]);
  }
  function waitAuth(ms){
    return Promise.race([authReadyPromise, sleep(ms || 5000)]);
  }

  // ---------- status ----------
  var lastStatus = 'local';
  function setStatus(status){
    lastStatus = status;
    fire('hksyncstatus', { status: status, at: now() });
  }
  HK.getStatus = function(){ return lastStatus; };

  // App code can call this immediately after changing a sync key.
  HK.notifyDataChanged = function(){
    refreshMeta(false);
    if(currentUser) autoSync(true, 0);
    return true;
  };

  HK.setSyncUser = function(name){
    if(name) lsSet('hk-sync-user', name); else lsDel('hk-sync-user');
  };

  // ---------- মূল sync (pull-before-push merge) ----------
  async function fetchRemote(uid){
    var snap = await fb.getDocsFromServer(fb.colRef(uid));
    var out = {};
    snap.forEach(function(d){
      var key;
      try{ key = decodeKey(d.id); }catch(e){ return; }
      if(SYNC_KEYS.indexOf(key) === -1) return;          // অন্য key উপেক্ষা
      var data = d.data() || {};
      var r = Number(data.updatedAt) || 0;
      if(data.deleted === true){ out[key] = { value: null, deleted: true, r: r }; }
      else if(typeof data.value === 'string'){ out[key] = { value: data.value, deleted: false, r: r }; }
    });
    return out;
  }

  async function doSync(){
    var meta = refreshMeta(false);
    try{ await waitReady(6000); await waitAuth(5000); }
    catch(e){ return { ok: false, reason: 'FIREBASE_NOT_READY', offline: !isOnline() }; }
    var user = currentUser;
    if(!user) return { ok: false, reason: 'NOT_LOGGED_IN' };
    if(!isOnline()){ setStatus('offline'); return { ok: false, offline: true }; }
    var uid = user.uid;
    setStatus('syncing');

    var remote;
    try{ remote = await fetchRemote(uid); }
    catch(e){ var off = !isOnline(); setStatus(off ? 'offline' : 'error'); return { ok: false, error: e, offline: off }; }
    if(!currentUser || currentUser.uid !== uid) return { ok: false, reason: 'USER_CHANGED' };

    // নেটওয়ার্কে অপেক্ষার সময় ইউজার কিছু বদলালে সেটাও ধরা হয়
    meta = refreshMeta(false);
    adoptAccount(meta, uid);

    var baseAll = loadBase();
    var applied = {}, appliedKeys = [], pushes = [], skipped = [], oversize = [], notifyConflicts = [];

    // দুই পাশেই আসল (non-null, non-tombstoned) মান আছে হলে → entry-level merge চেষ্টা করা হয়।
    // অন্য সব ক্ষেত্রে (প্রথমবার, explicit reset, তোমার/অন্যের পুরো key মুছে ফেলা, JSON parse ব্যর্থ)
    // পুরনো নিরাপদ binary (পুরো-key জেতা/হারা) লজিকে ফিরে যাওয়া হয়।
    function tryMerge(k, localVal, m, rem){
      if(!rem || rem.deleted || localVal === null || (m && m.del)) return false;
      var rv = rem.value;
      if(rv === localVal){
        var hs = hashStr(localVal);
        meta[k] = { h: hs, t: rem.r, sh: hs, sr: rem.r };
        baseAll[k] = localVal;
        return true;
      }
      var lObj, rObj;
      try{ lObj = JSON.parse(localVal); rObj = JSON.parse(rv); }catch(e){ return false; }
      var baseRaw = baseAll[k], baseObj;
      if(baseRaw !== undefined){ try{ baseObj = JSON.parse(baseRaw); }catch(e){ baseObj = undefined; } }
      var lt = m ? (m.t || 0) : 0;
      var sideWinner = lt > rem.r ? 'local' : 'remote';
      var ctx = { conflict: false };
      var mergedObj = mergeValue(baseObj, lObj, rObj, sideWinner, ctx);
      var mergedStr = stableStringify(mergedObj);
      var size = byteLen(mergedStr);
      if(size > MAX_DOC_BYTES){ skipped.push(k); oversize.push(k); return true; }

      if(ctx.conflict){
        // পুরো conflict-এ হারায়নি কিছুই — merge-এর আগের local ভার্সনটা শুধু তথ্যের জন্য backup রাখা হলো
        if(!saveBackup(k, { side: 'local', value: localVal, t: lt, notify: true })){ skipped.push(k); return true; }
        notifyConflicts.push(k);
      }
      var changedLocally = mergedStr !== localVal;
      var changedRemotely = mergedStr !== rv;
      if(changedLocally){
        if(!lsSet(k, mergedStr)){ skipped.push(k); return true; }
        applied[k] = mergedStr; appliedKeys.push(k);
      }
      if(changedRemotely){
        // cloud-এ এখনো merged মান নেই — push সফল হওয়ার আগ পর্যন্ত base আপডেট করা হয় না
        var t2 = Math.max(lt || now(), rem.r + 1, now());
        pushes.push({ k: k, value: mergedStr, t: t2, h: hashStr(mergedStr) });
      }else{
        // merged মান remote-এর সাথে already মিলে গেছে — push দরকার নেই, base এখনই নিশ্চিত
        baseAll[k] = mergedStr;
        var hs2 = hashStr(mergedStr);
        meta[k] = { h: hs2, t: rem.r, sh: hs2, sr: rem.r };
      }
      return true;
    }

    SYNC_KEYS.forEach(function(k){
      var localVal = lsGet(k);
      var m = meta[k];
      var rem = remote[k];

      if(tryMerge(k, localVal, m, rem)) return;

      var p = planKey(localVal, m, rem);

      if(p.action === 'synced'){
        var hs = localVal === null ? null : hashStr(localVal);
        meta[k] = { h: hs, t: rem.r, sh: hs, sr: rem.r };
        if(localVal !== null) baseAll[k] = localVal; else delete baseAll[k];
        return;
      }
      if(p.action === 'none'){
        if(m && m.del){ delete m.del; }
        return;
      }
      if(p.action === 'apply'){
        if(p.conflict && p.conflict.value !== null){
          var notifyL = p.conflict.t > 0 && !(m && m.amb);
          if(!saveBackup(k, { side: 'local', value: p.conflict.value, t: p.conflict.t, notify: notifyL })){ skipped.push(k); return; }
          if(notifyL) notifyConflicts.push(k);
        }
        var rv = rem.deleted ? null : rem.value;
        if(rv === null) lsDel(k);
        else if(!lsSet(k, rv)){ skipped.push(k); return; }
        var ha = rv === null ? null : hashStr(rv);
        meta[k] = { h: ha, t: rem.r, sh: ha, sr: rem.r };
        applied[k] = rv; appliedKeys.push(k);
        if(rv !== null) baseAll[k] = rv; else delete baseAll[k];
        return;
      }
      // push
      var size = localVal === null ? 0 : byteLen(localVal);
      if(size > MAX_DOC_BYTES){ skipped.push(k); oversize.push(k); return; }
      if(p.conflict && p.conflict.value !== null){
        if(!saveBackup(k, { side: 'remote', value: p.conflict.value, t: p.conflict.t, notify: true })){ skipped.push(k); return; }
        notifyConflicts.push(k);
      }
      pushes.push({ k: k, value: localVal, t: p.t, h: localVal === null ? null : hashStr(localVal) });
      // এই key-র base পরিবর্তন push সফল হওয়ার আগে করা হয় না (নিচে commit-এর পর করা হয়) —
      // নাহলে push ব্যর্থ হলে পরের sync ভুলভাবে merge-কে উল্টে দিতে পারে।
    });
    saveMeta(meta);
    saveBase(baseAll);

    var pushedOk = true, pushError = null;
    if(pushes.length){
      try{
        var col = fb.colRef(uid), batch = fb.batch();
        pushes.forEach(function(p){
          batch.set(fb.docRef(col, encodeKey(p.k)), { key: p.k, value: p.value, deleted: p.value === null, updatedAt: p.t });
        });
        await Promise.race([
          batch.commit(),
          sleep(COMMIT_TIMEOUT_MS).then(function(){ throw hkError('hk/commit-timeout', 'সার্ভারে লিখতে দেরি হচ্ছে'); })
        ]);
        var m2 = loadMeta();
        pushes.forEach(function(p){
          var cur = m2[p.k] || (m2[p.k] = { h: p.h, t: p.t });
          cur.sh = p.h; cur.sr = p.t;
          if(cur.h === p.h){ cur.t = p.t; delete cur.del; delete cur.amb; }
        });
        saveMeta(m2);
        var b2 = loadBase();
        pushes.forEach(function(p){ if(p.value !== null) b2[p.k] = p.value; else delete b2[p.k]; });
        saveBase(b2);
      }catch(e){ pushedOk = false; pushError = e; }
    }

    var ok = pushedOk && skipped.length === 0;
    setStatus(ok ? 'synced' : (isOnline() ? 'error' : 'offline'));
    if(oversize.length) fire('hkoversize', { keys: oversize });
    if(notifyConflicts.length) fire('hkconflict', { keys: notifyConflicts });
    if(appliedKeys.length) fire('hkdatachanged', { keys: appliedKeys });
    return {
      ok: ok,
      data: appliedKeys.length ? applied : null,
      applied: appliedKeys,
      pushed: pushedOk ? pushes.map(function(p){ return p.k; }) : [],
      skipped: skipped,
      oversize: oversize,
      error: pushError || undefined,
      updatedAt: String(now())
    };
  }

  // একসাথে অনেক কল এলে সিরিয়ালি চলে, অপেক্ষমাণগুলো একটাতে মিশে যায়
  var chain = Promise.resolve(), queued = null;
  function requestSync(){
    if(queued) return queued;
    queued = chain.catch(function(){}).then(function(){ queued = null; return doSync(); });
    chain = queued;
    return queued;
  }

  // ---------- স্বয়ংক্রিয় sync ----------
  var lastAttempt = 0, failCount = 0;
  function autoSync(force, minGap){
    if(!currentUser) return;
    var t = now();
    if(minGap && t - lastAttempt < minGap) return;
    if(!force && failCount > 0 && t - lastAttempt < Math.min(60000, 5000 * Math.pow(2, failCount))) return;
    lastAttempt = t;
    requestSync().then(function(r){ failCount = (r && r.ok) ? 0 : failCount + 1; },
                       function(){ failCount++; });
  }

  // ---------- reload (অন্য ডিভাইসের নতুন ডাটা এলে পেজ রিফ্রেশ) ----------
  var reloadScheduled = false;
  function scheduleReload(){
    if(reloadScheduled || HK.autoReload === false) return;
    try{
      var t = now();
      var log = JSON.parse(sessionStorage.getItem('hk-reload-log') || '[]').filter(function(x){ return t - x < 20000; });
      if(log.length >= 3) return;                          // reload-loop প্রতিরোধ
      log.push(t); sessionStorage.setItem('hk-reload-log', JSON.stringify(log));
    }catch(e){}
    reloadScheduled = true;
    var waited = 0;
    function go(){
      var a = document.activeElement;
      if(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && waited < 30000){ waited += 1000; setTimeout(go, 1000); return; }
      location.reload();
    }
    setTimeout(go, 400);
  }
  window.addEventListener('hkdatachanged', scheduleReload);

  // ---------- পাবলিক API ----------
  HK.ready = function(){ return waitReady(8000); };

  HK.status = async function(){
    var ok = true;
    try{ await waitReady(4000); await waitAuth(4000); }catch(e){ ok = false; }
    var u = currentUser || (fbReady && fb.authInstance && fb.authInstance.currentUser) || null;
    var hint = lsGet('hk-sync-user');
    return {
      loggedIn: !!u,
      username: u ? (u.email || '') : (hint || null),
      uid: u ? u.uid : null,
      online: isOnline(),
      ready: fbReady && ok,
      sdkPending: !fbReady && !!hint      // আগে লগইন ছিল, কিন্তু SDK এখনো লোড হয়নি
    };
  };

  function needReady(){
    return waitReady(15000).catch(function(){
      throw hkError('hk/not-ready', 'ইন্টারনেট নেই বা Firebase লোড হয়নি। সংযোগ দেখে আবার চেষ্টা করুন।');
    });
  }

  HK.login = async function(email, password){
    await needReady();
    var cred = await fb.signIn(String(email || '').trim(), password);
    currentUser = cred.user;
    HK.setSyncUser(cred.user.email || '');
    try{ await requestSync(); }catch(e){}
    return cred.user;
  };
  HK.register = async function(email, password){
    await needReady();
    var cred = await fb.createUser(String(email || '').trim(), password);
    currentUser = cred.user;
    HK.setSyncUser(cred.user.email || '');
    try{ await requestSync(); }catch(e){}
    return cred.user;
  };
  // লগ আউটের সময় ডিভাইস থেকে account-এর ডাটা মুছে ফেলা হয় — যাতে এই ডিভাইসে অন্য
  // অ্যাকাউন্টে লগইন করলে আগের অ্যাকাউন্টের তথ্য নতুন অ্যাকাউন্টে মিশে/leak না যায়।
  // পরে একই অ্যাকাউন্টে আবার লগইন করলে HK.login()-এর auto-sync cloud থেকে সব ফিরিয়ে আনবে।
  function currentDirtyKeys(){
    var meta = refreshMeta(false);
    return SYNC_KEYS.filter(function(k){
      var m = meta[k];
      if(!m) return false;
      if(m.del) return true;
      if(m.sh === undefined) return m.h !== null;
      return m.h !== m.sh;
    });
  }
  function wipeLocalData(){
    SYNC_KEYS.forEach(function(k){ lsDel(k); });
    lsDel(META_KEY);
    lsDel(BASE_KEY);
    lsDel(ACCOUNT_KEY);
    lsDel('hk-display-name');   // রেজিস্ট্রেশনের সময় সেভ করা নাম — account-identifying, তাই এটাও মোছা হয়
    try{
      var toDel = [];
      for(var i = 0; i < localStorage.length; i++){
        var name = localStorage.key(i);
        if(name && name.indexOf(CONFLICT_PREFIX) === 0) toDel.push(name);
      }
      toDel.forEach(lsDel);
    }catch(e){}
    fire('hkdatachanged', { keys: SYNC_KEYS, wiped: true });
  }

  HK.logout = async function(opts){
    opts = opts || {};
    await needReady();

    var dirty = currentDirtyKeys();
    if(dirty.length && !opts.force){
      if(isOnline()){
        try{ await requestSync(); }catch(e){}
        dirty = currentDirtyKeys();
      }
      if(dirty.length){
        // এখনো unsynced তথ্য আছে (অফলাইন অথবা sync ব্যর্থ) — না জানিয়ে মুছে ফেলা হয় না।
        // এই অবস্থায় logout হয়নি; ইউজার নিশ্চিত করলে { force: true } দিয়ে আবার কল করতে হবে।
        return { ok: false, reason: 'UNSYNCED_PENDING', dirtyKeys: dirty };
      }
    }

    await fb.signOut();
    currentUser = null;
    HK.setSyncUser('');
    wipeLocalData();
    setStatus('local');
    return { ok: true, wiped: true };
  };

  // sync / pull / pullServer — সবই এখন নিরাপদ দ্বিমুখী merge (আগে cloud পড়ে, তারপর দরকার হলে লেখে)
  HK.sync = function(){ return requestSync(); };
  HK.pull = function(){ return requestSync(); };
  HK.pullServer = function(){ return requestSync(); };
  HK.push = function(){ return requestSync(); };
  HK.pushAll = function(){ return requestSync(); };

  // রিসেট: লোকাল মুছে ক্লাউডে tombstone লেখা হয় (অফলাইনে হলে অনলাইনে ফিরে নিজে থেকেই হবে)
  HK.deleteKeys = async function(keys){
    var list = (keys || []).filter(function(k){ return SYNC_KEYS.indexOf(k) !== -1; });
    refreshMeta(false);
    var meta = loadMeta();
    list.forEach(function(k){
      lsDel(k);
      var m = meta[k] || (meta[k] = { t: 0 });
      m.h = null; m.t = now(); m.del = true; delete m.amb;
    });
    saveMeta(meta);
    var r = await requestSync();
    if(r && r.ok) return { ok: true };
    return { ok: false, offline: !!(r && r.offline) || !isOnline(), reason: r && r.reason, pending: true };
  };

  // conflict কপি
  HK.conflicts = listConflicts;
  HK.restoreConflict = async function(key){
    var raw = lsGet(CONFLICT_PREFIX + key);
    if(!raw) return { ok: false };
    var rec;
    try{ rec = JSON.parse(raw); }catch(e){ lsDel(CONFLICT_PREFIX + key); return { ok: false }; }
    if(rec.uid && rec.uid !== lsGet(ACCOUNT_KEY)) return { ok: false };   // অন্য অ্যাকাউন্টের কপি ফেরানো যাবে না
    if(rec.value === null || rec.value === undefined) lsDel(key); else lsSet(key, String(rec.value));
    lsDel(CONFLICT_PREFIX + key);
    refreshMeta(false);                                   // এখন এটাই সর্বশেষ এডিট
    var r = await requestSync().catch(function(){ return { ok: false }; });
    scheduleReload();
    return { ok: true, sync: r };
  };
  HK.restoreConflicts = async function(){
    var list = listConflicts().filter(function(c){ return c.notify; });
    for(var i = 0; i < list.length; i++){ await HK.restoreConflict(list[i].key); }
    return { ok: true, count: list.length };
  };
  HK.discardConflict = function(key){ lsDel(CONFLICT_PREFIX + key); };
  HK.discardConflicts = function(){ listConflicts().forEach(function(c){ lsDel(CONFLICT_PREFIX + c.key); }); };

  // ---------- চালু ----------
  refreshMeta(true);                                      // পেজ লোডের মুহূর্তের অবস্থা রেকর্ড
  setInterval(function(){
    var meta = refreshMeta(false);
    if(currentUser && isDirty(meta)) autoSync(false, 0);
  }, POLL_MS);
  window.addEventListener('online', function(){
    retryInit();
    setTimeout(function(){ autoSync(true, 0); }, 800);
  });
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible') autoSync(true, 10000);
    else { refreshMeta(false); autoSync(true, 0); }
  });
  window.addEventListener('pagehide', function(){
    // pagehide-এ নতুন async network request-এর উপর নির্ভর করি না।
    refreshMeta(false);
  });

  initFirebase();
})();
