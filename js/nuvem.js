// Conexão com o Firebase: login com conta Google e os dados compartilhados de cada escola.
// Estrutura no Firestore:
//   escolas/{escola}                      nome, criadoPor
//   escolas/{escola}/turmas/{turma}       nome, alunos[]            (só coordenadores alteram)
//   escolas/{escola}/provas/{prova}       gabarito e modelo da folha (só coordenadores alteram)
//   escolas/{escola}/resultados/{folha}   respostas lidas, corretor  (cada professor vê as próprias)
//   membros/{escola}_{email}              escolaId, email, papel ('coordenador' | 'professor')
(() => {
  const cfg = window.FIREBASE_CONFIG;
  const configurado = !!(window.firebase && cfg && cfg.apiKey && cfg.apiKey !== 'COLE_AQUI' && cfg.projectId);
  let auth = null, db = null;
  if (configurado) {
    firebase.initializeApp(cfg);
    auth = firebase.auth();
    db = firebase.firestore();
    // Guarda os dados no aparelho: a correção continua funcionando sem internet e sincroniza depois
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  }

  const N = {
    configurado,
    usuario: null,
    email: () => (N.usuario?.email || '').toLowerCase(),
    nome: () => N.usuario?.displayName || N.email(),

    aoMudarUsuario(fn) {
      if (!configurado) { fn(null); return; }
      auth.onAuthStateChanged(u => { N.usuario = u; fn(u); });
    },
    entrar() {
      const p = new firebase.auth.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      return auth.signInWithPopup(p).catch(e => {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return auth.signInWithRedirect(p);
        throw e;
      });
    },
    sair: () => auth.signOut(),

    async minhasEscolas() {
      const q = await db.collection('membros').where('email', '==', N.email()).get();
      const lista = [];
      for (const d of q.docs) {
        const m = d.data();
        try {
          const e = await db.doc('escolas/' + m.escolaId).get();
          if (e.exists) lista.push({ id: m.escolaId, nome: e.data().nome, papel: m.papel });
        } catch (err) {}
      }
      return lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    },
    // Cria a escola e cadastra quem criou como coordenador, numa única gravação
    async criarEscola(nome) {
      const ref = db.collection('escolas').doc(), em = N.email();
      const lote = db.batch();
      lote.set(ref, { nome, criadoPor: em, criadoEm: firebase.firestore.FieldValue.serverTimestamp() });
      lote.set(db.doc(`membros/${ref.id}_${em}`), { escolaId: ref.id, email: em, papel: 'coordenador', nome: N.nome() });
      await lote.commit();
      return ref.id;
    },
    escola: eid => db.doc('escolas/' + eid),
    colecao: (eid, nome) => db.collection(`escolas/${eid}/${nome}`),
    membros: eid => db.collection('membros').where('escolaId', '==', eid),
    membro: (eid, email) => db.doc(`membros/${eid}_${email.toLowerCase()}`),
  };
  window.Nuvem = N;
})();
