/* =====================================================================
   firebase-adapter.js — shared storage for the Task Management System
   ---------------------------------------------------------------------
   Without this file the app stores data in each person's own browser.
   With it, everyone reads and writes the same Firestore database and
   changes appear on every open screen within a second.

   TO TURN IT ON
   1. Paste your Firebase config into FIREBASE_CONFIG below.
   2. In index.html, remove the comment marks around this line:
        <script type="module" src="firebase-adapter.js"></script>
   3. In the Firebase console: Build > Firestore Database > Create,
      and Build > Authentication > Sign-in method > Anonymous > Enable.
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

/* Change this if you ever want a second, separate department board
   in the same Firebase project (e.g. "logistics"). */
const BOARD = "procurement";

window.RemoteStoreFactory = async (ctx) => {
  if (FIREBASE_CONFIG.apiKey === "PASTE_HERE")
    throw new Error("firebase-adapter.js still has placeholder config.");

  const [fbApp, fbAuth, fbStore] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);
  const { initializeApp } = fbApp;
  const { getAuth, signInAnonymously, onAuthStateChanged } = fbAuth;
  const { getFirestore, collection, doc, setDoc, deleteDoc,
          onSnapshot, getDocs, writeBatch } = fbStore;

  const app  = initializeApp(FIREBASE_CONFIG);
  const auth = getAuth(app);
  const db   = getFirestore(app);

  await signInAnonymously(auth);
  await new Promise(res => {
    const stop = onAuthStateChanged(auth, u => { if (u) { stop(); res(); } });
  });

  const tasksCol = collection(db, "boards", BOARD, "tasks");
  const usersCol = collection(db, "boards", BOARD, "users");
  let onChangeCb = null;

  function pull(snapshot, key) {
    const DB = ctx.getDB();
    DB[key] = snapshot.docs.map(d => d.data());
    DB.seq = DB.tasks.reduce((m, x) => Math.max(m, x.seq || 0), 0);
    onChangeCb && onChangeCb();
  }

  return {
    kind: "firebase",

    async init() {
      const DB = ctx.getDB();
      DB.tasks = []; DB.users = []; DB.seq = 0;

      const [uSnap, tSnap] = await Promise.all([getDocs(usersCol), getDocs(tasksCol)]);

      /* First ever run: write the default team into Firestore. */
      if (uSnap.empty) {
        const batch = writeBatch(db);
        ctx.DEFAULT_USERS.forEach(u => {
          const rec = { ...u, pw: ctx.hash(ctx.DEFAULT_PW) };
          batch.set(doc(usersCol, u.id), rec);
        });
        await batch.commit();
        DB.users = ctx.DEFAULT_USERS.map(u => ({ ...u, pw: ctx.hash(ctx.DEFAULT_PW) }));
      } else {
        DB.users = uSnap.docs.map(d => d.data());
      }

      DB.tasks = tSnap.docs.map(d => d.data());
      DB.seq   = DB.tasks.reduce((m, x) => Math.max(m, x.seq || 0), 0);
      DB.seeded = true;

      /* Live updates for everyone who has the page open. */
      onSnapshot(tasksCol, s => pull(s, "tasks"));
      onSnapshot(usersCol, s => pull(s, "users"));
    },

    async flush() { /* every write is already saved individually */ },

    async putTask(task) {
      const DB = ctx.getDB();
      const i = DB.tasks.findIndex(x => x.id === task.id);
      if (i < 0) DB.tasks.push(task); else DB.tasks[i] = task;
      await setDoc(doc(tasksCol, task.id), task);
    },

    async removeTask(id) {
      const DB = ctx.getDB();
      DB.tasks = DB.tasks.filter(x => x.id !== id);
      await deleteDoc(doc(tasksCol, id));
    },

    async putUser(u) {
      const DB = ctx.getDB();
      const i = DB.users.findIndex(x => x.id === u.id);
      if (i < 0) DB.users.push(u); else DB.users[i] = u;
      await setDoc(doc(usersCol, u.id), u);
    },

    async removeUser(id) {
      const DB = ctx.getDB();
      DB.users = DB.users.filter(x => x.id !== id);
      await deleteDoc(doc(usersCol, id));
    },

    /* Restore from a JSON backup: replaces everything in Firestore. */
    async replaceAll(next) {
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

    onChange(cb) { onChangeCb = cb; }
  };
};
