/* =====================================================================
   firebase-adapter.js — shared storage + Google sign-in
   ---------------------------------------------------------------------
   Two jobs:
     1. Everyone reads and writes the same Firestore database.
     2. People sign in with their Google account. Only the addresses
        listed against a team member may enter — a Google account on its
        own is not enough.

   TO TURN IT ON
   1. Paste your Firebase config into FIREBASE_CONFIG below.
   2. In index.html, remove the comment marks around this line:
        <script type="module" src="firebase-adapter.js"></script>
   3. Firebase console → Build → Firestore Database → Create.
   4. Firebase console → Build → Authentication → Sign-in method →
      Google → Enable. Add your domain under Settings → Authorized
      domains. Anonymous can be turned off.
   Step-by-step instructions are in README.md.
   ===================================================================== */

const SDK = "https://www.gstatic.com/firebasejs/11.0.2";

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBR4gOqGFHOiYsv3gEuws_Ojo52cPooqks",
  authDomain:        "task-management1-d1c3f.firebaseapp.com",
  projectId:         "task-management1-d1c3f",
  storageBucket:     "task-management1-d1c3f.firebasestorage.app",
  messagingSenderId: "520378911475",
  appId:             "1:520378911475:web:a7bbb130475e2c971d0586"
};

/* The first administrator. On an empty database this address is written
   against the admin account so there is somebody who can sign in and add
   everyone else. It has no effect once that account has an address. */
const BOOTSTRAP_ADMIN_EMAIL = "abdulelah.obaidi@gmail.com";

/* Change this if you ever want a second, separate department board
   in the same Firebase project (e.g. "logistics"). */
const BOARD = "procurement";

let _fb = null;   /* loaded SDK modules, shared by auth and storage */

async function loadSDK(){
  if(_fb) return _fb;
  if(FIREBASE_CONFIG.apiKey === "PASTE_HERE")
    throw new Error("firebase-adapter.js still has placeholder config.");
  const [app, auth, store] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);
  const application = app.initializeApp(FIREBASE_CONFIG);
  _fb = {
    app, auth, store, application,
    authInstance:  auth.getAuth(application),
    db:            store.getFirestore(application)
  };
  return _fb;
}

/* ---------------------------------------------------------------- AUTH */
window.RemoteAuthFactory = async () => {
  const fb = await loadSDK();
  const { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } = fb.auth;

  await setPersistence(fb.authInstance, browserLocalPersistence);

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  return {
    kind: "google",

    /* Resolves once Firebase has restored (or ruled out) a session. */
    ready(){
      return new Promise(res => {
        const stop = onAuthStateChanged(fb.authInstance, u => { stop(); res(u || null); });
      });
    },

    onChange(cb){ onAuthStateChanged(fb.authInstance, u => cb(u || null)); },

    async signIn(){
      const res = await signInWithPopup(fb.authInstance, provider);
      return res.user;
    },

    async signOut(){ await signOut(fb.authInstance); },

    current(){ return fb.authInstance.currentUser || null; }
  };
};

/* ------------------------------------------------------------- STORAGE */
window.RemoteStoreFactory = async (ctx) => {
  const fb = await loadSDK();
  const { collection, doc, setDoc, deleteDoc, onSnapshot, getDocs, getDoc, writeBatch } = fb.store;
  const db = fb.db;

  if(!fb.authInstance.currentUser)
    throw new Error("Not signed in — cannot open the database.");

  const tasksCol = collection(db, "boards", BOARD, "tasks");
  const usersCol = collection(db, "boards", BOARD, "users");
  /* Board settings live here rather than in the source file, so the
     notification endpoint never lands in a public repository. */
  const cfgDoc   = doc(db, "boards", BOARD, "meta", "settings");
  let onChangeCb = null;

  function pull(snapshot, key){
    const DB = ctx.getDB();
    DB[key] = snapshot.docs.map(d => d.data());
    DB.seq = DB.tasks.reduce((m, x) => Math.max(m, x.seq || 0), 0);
    onChangeCb && onChangeCb();
  }

  return {
    kind: "firebase",

    async init(){
      const DB = ctx.getDB();
      DB.tasks = []; DB.users = []; DB.seq = 0;

      const [uSnap, tSnap] = await Promise.all([getDocs(usersCol), getDocs(tasksCol)]);

      if(uSnap.empty){
        /* First ever run: write the default team, with the bootstrap
           address on the admin so somebody can get in. */
        const seeded = ctx.DEFAULT_USERS.map(u => ({
          ...u,
          email: (u.role === "admin" && BOOTSTRAP_ADMIN_EMAIL) ? BOOTSTRAP_ADMIN_EMAIL.toLowerCase() : ""
        }));
        const batch = writeBatch(db);
        seeded.forEach(u => batch.set(doc(usersCol, u.id), u));
        await batch.commit();
        DB.users = seeded;
      } else {
        DB.users = uSnap.docs.map(d => d.data());
        /* Upgrading an older board that has no addresses yet: give the
           admin the bootstrap one so the team is not locked out. */
        if(BOOTSTRAP_ADMIN_EMAIL && !DB.users.some(u => u.email)){
          const admin = DB.users.find(u => u.role === "admin") || DB.users[0];
          if(admin){
            admin.email = BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
            await setDoc(doc(usersCol, admin.id), admin);
          }
        }
      }

      DB.tasks = tSnap.docs.map(d => d.data());
      DB.seq   = DB.tasks.reduce((m, x) => Math.max(m, x.seq || 0), 0);
      DB.seeded = true;

      try{
        const c = await getDoc(cfgDoc);
        DB.config = c.exists() ? c.data() : { notifyUrl:"", notifyOn:true };
      }catch(e){ DB.config = { notifyUrl:"", notifyOn:true }; }

      onSnapshot(tasksCol, s => pull(s, "tasks"));
      onSnapshot(usersCol, s => pull(s, "users"));
      onSnapshot(cfgDoc, s => {
        ctx.getDB().config = s.exists() ? s.data() : { notifyUrl:"", notifyOn:true };
      });
    },

    async flush(){ /* every write is already saved individually */ },

    async putTask(task){
      const DB = ctx.getDB();
      const i = DB.tasks.findIndex(x => x.id === task.id);
      if(i < 0) DB.tasks.push(task); else DB.tasks[i] = task;
      await setDoc(doc(tasksCol, task.id), task);
    },

    async removeTask(id){
      const DB = ctx.getDB();
      DB.tasks = DB.tasks.filter(x => x.id !== id);
      await deleteDoc(doc(tasksCol, id));
    },

    async putConfig(cfg){
      const DB = ctx.getDB();
      DB.config = cfg;
      await setDoc(cfgDoc, cfg);
    },

    async putUser(u){
      const DB = ctx.getDB();
      const i = DB.users.findIndex(x => x.id === u.id);
      if(i < 0) DB.users.push(u); else DB.users[i] = u;
      await setDoc(doc(usersCol, u.id), u);
    },

    async removeUser(id){
      const DB = ctx.getDB();
      DB.users = DB.users.filter(x => x.id !== id);
      await deleteDoc(doc(usersCol, id));
    },

    async replaceAll(next){
      const cur = await Promise.all([getDocs(tasksCol), getDocs(usersCol)]);
      const wipe = writeBatch(db);
      cur.forEach(snap => snap.docs.forEach(d => wipe.delete(d.ref)));
      await wipe.commit();

      const add = writeBatch(db);
      (next.tasks || []).forEach(t => add.set(doc(tasksCol, t.id), t));
      (next.users || []).forEach(u => add.set(doc(usersCol, u.id), u));
      await add.commit();

      ctx.setDB(next);
    },

    onChange(cb){ onChangeCb = cb; }
  };
};
