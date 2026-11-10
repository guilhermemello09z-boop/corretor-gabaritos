(() => {
const LETRAS = 'ABCDE';
const KEY = 'corretor-gabaritos.v1';
const S = { provas: [], atual: null, res: {}, aba: 'gabarito' };
const sessao = new Map(); // id do resultado -> { base, H } (só nesta sessão)
const erros = [];
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = v => (Math.round(v * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Estado ---------- */
function novaProva(nome, n = 20, k = 5, valor = 10) {
  // Toda prova nova começa no bloco "GABARITO" que o professor cola na prova (modelo usado pela escola)
  return { id: uid(), nome, n, k, valor, modelo: 'bloco', gab: Array(n).fill(-1), anul: Array(n).fill(false), versao: 1 };
}
// Turmas, provas e resultados ficam na escola (Firebase). Neste aparelho ficam só as preferências
// de quem usa: aba aberta, prova e turma escolhidas. KEY guarda dados de versões antigas, que o
// coordenador pode levar para a escola.
// O filtro de turma dos Resultados não fica salvo: toda vez começa em "Todas as turmas"
const PREFS = ['atual', 'aba', 'turmaAtual', 'turmaEdit'];
const prefsKey = () => `corretor-gabaritos.prefs.${nuvem.eid || 'sem-escola'}`;
const nuvem = { eid: null, escolaNome: '', papel: null, conhecido: { provas: new Map(), turmas: new Map(), resultados: new Map() }, parar: [], timer: 0, carregou: new Set() };
const ehCoord = () => nuvem.papel === 'coordenador';
S.turmas = [];

function dadosAntigos() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    return { provas: Array.isArray(d?.provas) ? d.provas : [], turmas: Array.isArray(d?.turmas) ? d.turmas.filter(t => t.alunos?.length) : [] };
  } catch (e) { return { provas: [], turmas: [] }; }
}
function lerPrefs() {
  try { Object.assign(S, JSON.parse(localStorage.getItem(prefsKey()) || '{}')); } catch (e) {}
}
// Garante uma prova escolhida; sem provas na escola, usa uma prova vazia que nunca é gravada
function ajustarEscolhas() {
  if (!S.provas.length) S.provas = [Object.assign(novaProva('Nenhuma prova cadastrada', 10, 5, 10), { local: true })];
  if (!prova()) S.atual = S.provas[0].id;
  if (S.turmaAtual && !turmaPorId(S.turmaAtual)) S.turmaAtual = S.turmas[0]?.id || null;
  if (!S.turmaAtual) S.turmaAtual = S.turmas[0]?.id || null;
  if (!turmaPorId(S.turmaEdit)) S.turmaEdit = S.turmas[0]?.id || null;
}
function save() {
  try { localStorage.setItem(prefsKey(), JSON.stringify(Object.fromEntries(PREFS.map(k => [k, S[k]])))); } catch (e) {}
  clearTimeout(nuvem.timer);
  nuvem.timer = setTimeout(sincronizar, 400);
}

/* ---------- Sincronização com a escola ----------
   Cada gravação compara os dados da tela com a última versão vinda da escola e envia só o que mudou. */
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(c => [c, x[c]])) : x));
const limpo = o => JSON.parse(JSON.stringify(o));
// Folhas de exemplo ficam só neste aparelho e nunca entram nos resultados da escola
const todosResultados = () => Object.entries(S.res).flatMap(([provaId, lista]) => lista.filter(r => !r.exemplo).map(r => ({ ...r, provaId })));
const vistas = { provas: () => S.provas.filter(p => !p.local), turmas: () => S.turmas, resultados: todosResultados };
const podeGravar = { provas: ehCoord, turmas: ehCoord, resultados: r => ehCoord() || r.corretor === Nuvem.email() };

function sincronizar() {
  if (!nuvem.eid) return;
  for (const col of Object.keys(vistas)) {
    if (!nuvem.carregou.has(col)) continue; // só depois de receber a primeira versão da escola
    const conhecido = nuvem.conhecido[col], vistos = new Set();
    for (const item of vistas[col]()) {
      vistos.add(item.id);
      const j = canon(limpo(item));
      if (conhecido.get(item.id) === j || !podeGravar[col](item)) continue;
      conhecido.set(item.id, j);
      const { id, ...dados } = limpo(item);
      Nuvem.colecao(nuvem.eid, col).doc(id).set(dados).catch(falhaGravar);
    }
    for (const [id, j] of [...conhecido]) {
      if (vistos.has(id)) continue;
      conhecido.delete(id);
      if (podeGravar[col](JSON.parse(j))) Nuvem.colecao(nuvem.eid, col).doc(id).delete().catch(falhaGravar);
    }
  }
}
// Ao fechar, recarregar ou trocar de aba/app, envia na hora o que ainda estava esperando para ser salvo
const salvarJa = () => { clearTimeout(nuvem.timer); sincronizar(); };
window.addEventListener('pagehide', salvarJa);
document.addEventListener('visibilitychange', () => { if (document.hidden) salvarJa(); });
function falhaGravar(e) {
  toast(e?.code === 'permission-denied' ? 'Você não tem permissão para alterar isso.' : 'Não consegui salvar na escola. Confira a internet.');
}
function ouvirEscola() {
  nuvem.parar.forEach(f => f()); nuvem.parar = []; nuvem.carregou.clear();
  const ouvir = (col, consulta, aplicar) => nuvem.parar.push(consulta.onSnapshot(snap => {
    let itens = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    const primeira = !nuvem.carregou.has(col);
    let pendente = false;
    if (!primeira) {
      // Edições feitas aqui e ainda não enviadas valem mais que a versão que acabou de chegar
      const antes = nuvem.conhecido[col], locais = vistas[col]();
      const sujos = locais.filter(it => podeGravar[col](it) && antes.get(it.id) !== canon(limpo(it)));
      const apagados = new Set([...antes.keys()].filter(id => !locais.some(x => x.id === id)));
      if (sujos.length || apagados.size) {
        pendente = true;
        const porIdSujo = new Map(sujos.map(it => [it.id, it]));
        itens = itens.filter(it => !apagados.has(it.id)).map(it => porIdSujo.get(it.id) || it);
        sujos.forEach(it => { if (!itens.some(x => x.id === it.id)) itens.push(it); });
      }
    }
    nuvem.conhecido[col] = new Map(snap.docs.map(d => [d.id, canon(limpo({ ...d.data(), id: d.id }))]));
    nuvem.carregou.add(col);
    if (pendente) save();
    const porId = l => canon(limpo(l).sort((a, b) => (a.id < b.id ? -1 : 1)));
    if (!primeira && porId(itens) === porId(vistas[col]())) return; // nada mudou na tela
    aplicar(itens);
    ajustarEscolhas();
    if (col === 'provas' && primeira && ehCoord() && S.provas[0]?.local) {
      // Escola nova: o coordenador começa com uma prova em branco para preencher
      S.provas = [novaProva('Prova 1')]; S.atual = S.provas[0].id; save();
    }
    renderTudo();
  }, e => toast(e?.code === 'permission-denied' ? 'Sem permissão para ver os dados desta escola.' : 'Sem conexão com a escola.')));
  const eid = nuvem.eid;
  ouvir('provas', Nuvem.colecao(eid, 'provas'), itens => { S.provas = itens.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR', { numeric: true })); });
  ouvir('turmas', Nuvem.colecao(eid, 'turmas'), itens => { S.turmas = itens.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true })); });
  const qRes = ehCoord() ? Nuvem.colecao(eid, 'resultados') : Nuvem.colecao(eid, 'resultados').where('corretor', '==', Nuvem.email());
  ouvir('resultados', qRes, itens => {
    const exemplos = Object.entries(S.res).flatMap(([provaId, l]) => l.filter(r => r.exemplo).map(r => ({ ...r, provaId })));
    S.res = {};
    itens.concat(exemplos).sort((a, b) => (b.quando || 0) - (a.quando || 0)).forEach(({ provaId, ...r }) => (S.res[provaId] ||= []).push(r));
  });
  if (ehCoord()) {
    nuvem.parar.push(Nuvem.membros(eid).onSnapshot(snap => { nuvem.membros = snap.docs.map(d => d.data()); if (S.aba === 'escola') renderEscola(); }, () => {}));
  }
}
function renderTudo() {
  renderProvas(); renderSeletoresTurma();
  if (S.aba === 'gabarito') renderGabarito();
  irPara(S.aba);
}
const turmaPorId = id => S.turmas.find(t => t.id === id);
// Nome digitado na folha corrigida; se vazio, o da turma da folha pelo Nº na chamada
const nomeDe = r => r.nome || (r.num != null && turmaPorId(r.turmaId)?.alunos[r.num - 1]) || '';
const prova = () => S.provas.find(p => p.id === S.atual);
const resultados = () => (S.res[S.atual] ||= []);

function corrigir(p, resp) {
  let ac = 0, br = 0, mu = 0, er = 0;
  const det = [];
  for (let q = 0; q < p.n; q++) {
    const r = resp[q] ?? -1, g = p.gab[q];
    let st;
    if (p.anul[q]) st = 'anulada';
    else if (r === -1) st = 'branco';
    else if (r === -2) st = 'multipla';
    else if (g < 0) st = 'semgab';
    else st = r === g ? 'certo' : 'errado';
    if (st === 'certo' || st === 'anulada') ac++;
    if (st === 'branco') br++;
    if (st === 'multipla') mu++;
    if (st === 'errado') er++;
    det.push(st);
  }
  return { ac, br, mu, er, det, nota: p.n ? ac / p.n * p.valor : 0 };
}

/* ---------- Geometria da folha (unidades da folha: A4 a 150 dpi) ---------- */
const SW = 1240, SH = 1754, FS = 80;
const FID = [[70, 70], [1170, 70], [1170, 1684], [70, 1684]];
const ORI = { x: 160, y: 70, s: 34 };
// Modelos de folha: 'padrao' (listrado, até 3 colunas), 'coluna' (coluna única) e 'colunas3' (três colunas com divisórias)
// ocupam uma folha A4 inteira; 'bloco', 'bloco3' e 'bloco4' são só o quadro do gabarito, para colar dentro da prova.
const MODELOS = { padrao: 'Padrão', coluna: 'Coluna única', colunas3: 'Três colunas', bloco: 'Bloco na prova (1 coluna)', bloco3: 'Bloco na prova (3 colunas)', bloco4: 'Bloco na prova (4 colunas)' };
const ehBloco = p => p.modelo === 'bloco' || p.modelo === 'bloco3' || p.modelo === 'bloco4';
function layoutBloco(p) {
  const { n, k } = p, R = 17, dy = 56, top = 290;
  const cols = p.modelo === 'bloco4' ? Math.min(4, n) : p.modelo === 'bloco3' ? Math.min(3, n) : Math.ceil(n / 20);
  // Com 4 colunas o quadro fica mais compacto na largura para caber em meia folha A4
  const dx = cols >= 4 ? 50 : 56, labelW = cols >= 4 ? 76 : 84, gap = cols >= 4 ? 28 : 36;
  const rows = Math.ceil(n / cols), colW = labelW + k * dx;
  const gradeW = cols * colW + (cols - 1) * gap;
  const W = Math.max(580, Math.round(gradeW + 80)), H = top + rows * dy + 80;
  const m = 32, fs = 50;
  const fid = [[m, m], [W - m, m], [W - m, H - m], [m, H - m]];
  const ori = { x: m + 58, y: m, s: 22 };
  const x0a = (W - gradeW) / 2;
  const qs = [];
  for (let q = 0; q < n; q++) {
    const c = Math.floor(q / rows), r = q % rows;
    const x0 = x0a + c * (colW + gap), y = top + r * dy + dy / 2;
    qs.push({ x0, y, colW, b: Array.from({ length: k }, (_, i) => ({ x: x0 + labelW + i * dx + dx / 2, y })) });
  }
  const divisorias = Array.from({ length: cols - 1 }, (_, c) => x0a + (c + 1) * (colW + gap) - gap / 2);
  const xs = (W - 490) / 2;
  const num = [0, 1].map(row => ({ y: 202 + row * 46, b: Array.from({ length: 10 }, (_, d) => ({ x: xs + 50 + d * 44 + 22, y: 202 + row * 46 })) }));
  return { R, qs, num, dy, top, rows, divisorias, modelo: p.modelo, W, H, fid, fs, ori, xs };
}
function layout(p) {
  if (ehBloco(p)) return layoutBloco(p);
  const { n, k } = p, modelo = p.modelo || 'padrao';
  const R = 19;
  let cols, dx, labelW, x0a, x1a, top, maxDy;
  if (modelo === 'coluna') {
    cols = Math.max(1, Math.ceil(n / 24)); dx = 58; labelW = 80; x0a = 70; x1a = 1170; top = 540; maxDy = 62;
  } else if (modelo === 'colunas3') {
    cols = Math.min(3, n); dx = 52; labelW = 74; x0a = 70; x1a = 1170; top = 540; maxDy = 64;
  } else {
    cols = Math.min(Math.max(Math.ceil(n / 25), n > 12 ? 2 : 1), 3); dx = 52; labelW = 64; x0a = 110; x1a = 1130; top = 475; maxDy = 46;
  }
  const rows = Math.ceil(n / cols);
  const colW = labelW + k * dx;
  const gap = (x1a - x0a - cols * colW) / cols;
  const dy = Math.min(maxDy, (1610 - top) / rows);
  const divisorias = modelo === 'colunas3' ? Array.from({ length: cols - 1 }, (_, c) => x0a + (c + 1) * (colW + gap)) : [];
  const qs = [];
  for (let q = 0; q < n; q++) {
    const c = Math.floor(q / rows), r = q % rows;
    const x0 = x0a + gap / 2 + c * (colW + gap), y = top + r * dy + dy / 2;
    qs.push({ x0, y, colW, b: Array.from({ length: k }, (_, i) => ({ x: x0 + labelW + i * dx + dx / 2, y })) });
  }
  const num = [0, 1].map(row => ({ y: 330 + row * 50, b: Array.from({ length: 10 }, (_, d) => ({ x: 720 + d * 42 + 21, y: 330 + row * 50 })) }));
  return { R, qs, num, dy, top, rows, divisorias, modelo, W: SW, H: SH, fid: FID, fs: FS, ori: ORI };
}

function drawBloco(ctx, p, L, opt) {
  const R = L.R;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, L.W, L.H);
  ctx.fillStyle = '#000';
  for (const [x, y] of L.fid) ctx.fillRect(x - L.fs / 2, y - L.fs / 2, L.fs, L.fs);
  ctx.fillRect(L.ori.x - L.ori.s / 2, L.ori.y - L.ori.s / 2, L.ori.s, L.ori.s);
  ctx.font = '700 32px "Times New Roman", Times, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('GABARITO', L.W / 2, L.fid[0][1] + 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = '400 24px "Segoe UI", Arial, Helvetica, sans-serif';
  ctx.fillText('Nome:', 40, 128);
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#000';
  ctx.beginPath(); ctx.moveTo(116, 130); ctx.lineTo(L.W - 40, 130); ctx.stroke();
  ctx.font = '700 17px Arial, Helvetica, sans-serif';
  ctx.fillText('Nº NA CHAMADA', L.xs, 172);
  ctx.font = '400 17px Arial, Helvetica, sans-serif';
  ctx.fillText('Dez.', L.xs, L.num[0].y + 6); ctx.fillText('Uni.', L.xs, L.num[1].y + 6);
  L.num.forEach((row, ri) => row.b.forEach((b, d) => bolinha(ctx, b.x, b.y, R, String(d), opt.num != null && (ri === 0 ? Math.floor(opt.num / 10) : opt.num % 10) === d, true)));
  ctx.lineWidth = 2;
  L.divisorias.forEach(x => { ctx.beginPath(); ctx.moveTo(x, L.top); ctx.lineTo(x, L.top + L.rows * L.dy); ctx.stroke(); });
  L.qs.forEach((q, i) => {
    ctx.fillStyle = '#000'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.font = '400 26px "Segoe UI", Arial, Helvetica, sans-serif';
    ctx.fillText(String(i + 1).padStart(2, '0') + '.', q.x0 + 66, q.y + 1);
    const m = opt.marks ? opt.marks[i] : -1;
    q.b.forEach((b, j) => bolinha(ctx, b.x, b.y, R, LETRAS[j], Array.isArray(m) ? m.includes(j) : m === j, true));
  });
  ctx.restore();
}

function drawSheet(ctx, p, opt = {}) {
  const L = layout(p), R = L.R, classico = L.modelo !== 'padrao';
  if (ehBloco(p)) return drawBloco(ctx, p, L, opt);
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SW, SH);
  ctx.fillStyle = '#000';
  for (const [x, y] of FID) ctx.fillRect(x - FS / 2, y - FS / 2, FS, FS);
  ctx.fillRect(ORI.x - ORI.s / 2, ORI.y - ORI.s / 2, ORI.s, ORI.s);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = '700 38px Arial, Helvetica, sans-serif';
  let nome = p.nome || 'Prova';
  while (ctx.measureText(nome).width > 1000 && nome.length > 4) nome = nome.slice(0, -2) + '…';
  ctx.fillText(nome, 110, 178);
  ctx.font = '400 22px Arial, Helvetica, sans-serif'; ctx.fillStyle = '#444';
  ctx.fillText(`${p.n} questões · alternativas A–${LETRAS[p.k - 1]} · vale ${fmt(p.valor)} pontos`, 110, 214);
  ctx.fillStyle = '#000'; ctx.font = '400 26px Arial, Helvetica, sans-serif';
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#000';
  const linha = (x0, x1, y) => { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); };
  ctx.fillText('Nome', 110, 300); linha(185, 600, 302);
  ctx.fillText('Turma', 110, 380); linha(192, 350, 382);
  ctx.fillText('Data', 372, 380); linha(434, 600, 382);
  ctx.font = '700 19px Arial, Helvetica, sans-serif';
  ctx.fillText('Nº NA CHAMADA', 640, 290);
  ctx.font = '400 19px Arial, Helvetica, sans-serif';
  ctx.fillText('Dez.', 640, 337); ctx.fillText('Uni.', 640, 387);
  L.num.forEach((row, ri) => row.b.forEach((b, d) => bolinha(ctx, b.x, b.y, R, String(d), opt.num != null && (ri === 0 ? Math.floor(opt.num / 10) : opt.num % 10) === d)));
  ctx.font = '400 20px Arial, Helvetica, sans-serif'; ctx.fillStyle = '#444'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Pinte a bolinha inteira com caneta preta ou azul. Uma resposta por questão. Não rasure.', 110, 445);
  if (classico) {
    ctx.fillStyle = '#000'; ctx.font = '700 36px "Times New Roman", Times, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('GABARITO', SW / 2, L.top - 22);
    ctx.lineWidth = 2; ctx.strokeStyle = '#000';
    L.divisorias.forEach(x => { ctx.beginPath(); ctx.moveTo(x, L.top); ctx.lineTo(x, L.top + L.rows * L.dy); ctx.stroke(); });
  }
  L.qs.forEach((q, i) => {
    if (!classico && i % 2 === 0) { ctx.fillStyle = '#f1f1f1'; ctx.fillRect(q.x0 - 6, q.y - L.dy / 2, q.colW + 12, L.dy); }
    ctx.fillStyle = '#000'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.font = classico ? '400 26px "Segoe UI", Arial, Helvetica, sans-serif' : '700 22px Arial, Helvetica, sans-serif';
    ctx.fillText(String(i + 1).padStart(2, '0') + (classico ? '.' : ''), q.x0 + (classico ? 62 : 50), q.y + 1);
    const m = opt.marks ? opt.marks[i] : -1;
    q.b.forEach((b, j) => bolinha(ctx, b.x, b.y, R, LETRAS[j], Array.isArray(m) ? m.includes(j) : m === j, classico));
  });
  ctx.fillStyle = '#666'; ctx.font = '400 16px Arial, Helvetica, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Não dobre nem amasse esta folha · Corretor de Gabaritos', SW / 2, 1694);
  ctx.restore();
}
function bolinha(ctx, x, y, R, label, cheia, letraEscura) {
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.lineWidth = 2.2; ctx.strokeStyle = '#222'; ctx.stroke();
  if (cheia) {
    ctx.fillStyle = '#16215c';
    ctx.beginPath();
    ctx.ellipse(x + (Math.random() - 0.5) * 3, y + (Math.random() - 0.5) * 3, R * (0.8 + Math.random() * 0.12), R * (0.78 + Math.random() * 0.12), Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = letraEscura ? '#333' : '#bdbdbd';
    ctx.font = letraEscura ? '400 18px "Segoe UI", Arial, Helvetica, sans-serif' : '700 17px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 1);
  }
}

/* ---------- Leitura da foto ---------- */
function homografia(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  h.push(1);
  return h;
}
function mapa(h, x, y) {
  const w = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

function lerFolha(src, p) {
  const sc = Math.min(1, 1400 / Math.max(src.width, src.height));
  const w = Math.round(src.width * sc), h = Math.round(src.height * sc), N = w * h;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(src, 0, 0, w, h);
  const px = cx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) g[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];

  // Limiar adaptativo: escuro = bem abaixo da média da vizinhança (tolera sombra e luz desigual)
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s; }
  }
  const rad = Math.round(Math.max(w, h) / 14);
  const dark = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h - 1, y + rad);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w - 1, x + rad);
      const sum = I[(y1 + 1) * W1 + x1 + 1] - I[y0 * W1 + x1 + 1] - I[(y1 + 1) * W1 + x0] + I[y0 * W1 + x0];
      const mean = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      dark[y * w + x] = g[y * w + x] < mean * 0.65 ? 1 : 0;
    }
  }

  // Componentes conexos -> candidatos a quadrados de canto
  const lab = new Int32Array(N), stack = new Int32Array(N);
  const cands = [];
  let id = 0;
  for (let i = 0; i < N; i++) {
    if (!dark[i] || lab[i]) continue;
    id++;
    let sp = 0; stack[sp++] = i; lab[i] = id;
    let cnt = 0, sx = 0, sy = 0, mnx = w, mxx = 0, mny = h, mxy = 0, borda = false;
    while (sp) {
      const k = stack[--sp], x = k % w, y = (k - x) / w;
      cnt++; sx += x; sy += y;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) borda = true;
      if (x > 0 && dark[k - 1] && !lab[k - 1]) { lab[k - 1] = id; stack[sp++] = k - 1; }
      if (x < w - 1 && dark[k + 1] && !lab[k + 1]) { lab[k + 1] = id; stack[sp++] = k + 1; }
      if (y > 0 && dark[k - w] && !lab[k - w]) { lab[k - w] = id; stack[sp++] = k - w; }
      if (y < h - 1 && dark[k + w] && !lab[k + w]) { lab[k + w] = id; stack[sp++] = k + w; }
    }
    if (borda || cnt < N * 0.00012 || cnt > N * 0.02) continue;
    const bw = mxx - mnx + 1, bh = mxy - mny + 1, asp = bw / bh, fill = cnt / (bw * bh);
    if (asp < 0.55 || asp > 1.8 || fill < 0.72) continue;
    cands.push({ x: sx / cnt, y: sy / cnt, cnt });
  }
  const falha = msg => ({ ok: false, erro: msg, cv });
  if (cands.length < 4) return falha('Não encontrei os 4 quadrados pretos dos cantos. Fotografe a folha inteira, de cima e com boa luz.');
  const maior = Math.max(...cands.map(c => c.cnt));
  const fortes = cands.filter(c => c.cnt >= maior * 0.45);
  const pick = f => fortes.reduce((a, c) => (f(c) > f(a) ? c : a));
  const cantos = [pick(c => -(c.x + c.y)), pick(c => c.x - c.y), pick(c => c.x + c.y), pick(c => c.y - c.x)];
  if (new Set(cantos).size < 4) return falha('Encontrei menos de 4 cantos da folha. Confira se os quatro quadrados pretos aparecem na foto.');

  const amostra = (H, x, y, r) => {
    let tot = 0, esc = 0;
    const st = r / 6;
    for (let yy = -r; yy <= r; yy += st) for (let xx = -r; xx <= r; xx += st) {
      if (xx * xx + yy * yy > r * r) continue;
      const [u, v] = mapa(H, x + xx, y + yy);
      const ix = Math.round(u), iy = Math.round(v);
      tot++;
      if (ix >= 0 && iy >= 0 && ix < w && iy < h && dark[iy * w + ix]) esc++;
    }
    return tot ? esc / tot : 0;
  };
  // Testa as 4 rotações possíveis e fica com a que encontra a marca de orientação
  const G = layout(p);
  let melhor = null;
  for (let s = 0; s < 4; s++) {
    const H = homografia(G.fid, [0, 1, 2, 3].map(i => [cantos[(i + s) % 4].x, cantos[(i + s) % 4].y]));
    if (!H) continue;
    const v = amostra(H, G.ori.x, G.ori.y, G.ori.s * 0.3);
    if (!melhor || v > melhor.v) melhor = { H, v };
  }
  if (!melhor || melhor.v < 0.5) return falha('Não reconheci esta folha. Use a folha gerada na etapa 3, com os quatro cantos visíveis.');
  const H = melhor.H;

  const L = layout(p), rr = L.R * 0.68;
  // A folha precisa ser do mesmo modelo da prova escolhida: confere o formato do quadro e se as
  // bolinhas impressas estão onde a prova espera. Sem isso, uma folha de outra prova vira "tudo em branco".
  const cantoImg = G.fid.map(([x, y]) => mapa(H, x, y));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const largura = (dist(cantoImg[0], cantoImg[1]) + dist(cantoImg[3], cantoImg[2])) / 2;
  const altura = (dist(cantoImg[0], cantoImg[3]) + dist(cantoImg[1], cantoImg[2])) / 2;
  const formatoEsperado = (G.fid[1][0] - G.fid[0][0]) / (G.fid[3][1] - G.fid[0][1]);
  const contorno = (x, y) => {
    let esc = 0;
    for (let a = 0; a < 16; a++) {
      const ang = a * Math.PI / 8;
      const tocou = [0.88, 1, 1.12].some(f => {
        const [u, v] = mapa(H, x + Math.cos(ang) * L.R * f, y + Math.sin(ang) * L.R * f);
        const ix = Math.round(u), iy = Math.round(v);
        return ix >= 0 && iy >= 0 && ix < w && iy < h && dark[iy * w + ix];
      });
      if (tocou) esc++;
    }
    return esc / 16;
  };
  const bolinhas = L.qs.flatMap(q => q.b);
  const contornoMedio = bolinhas.reduce((s, b) => s + contorno(b.x, b.y), 0) / bolinhas.length;
  if (Math.abs(largura / altura / formatoEsperado - 1) > 0.2 || contornoMedio < 0.45) {
    return falha(`Esta folha não é da prova "${p.nome}". Confira se escolheu a prova certa no topo da página.`);
  }
  const decidir = f => {
    const mx = Math.max(...f);
    if (mx < 0.3) return { r: -1, duvida: mx > 0.2 };
    const lim = Math.max(0.3, mx * 0.6);
    const m = f.map((v, i) => (v >= lim ? i : -1)).filter(i => i >= 0);
    const seg = [...f].sort((a, b) => b - a)[1] || 0;
    return { r: m.length > 1 ? -2 : m[0], duvida: mx < 0.45 || (m.length === 1 && seg > 0.22) };
  };
  const resp = [], duvidas = [];
  L.qs.forEach((q, i) => {
    const d = decidir(q.b.map(b => amostra(H, b.x, b.y, rr)));
    resp.push(d.r);
    if (d.duvida) duvidas.push(i);
  });
  const dig = L.num.map(row => decidir(row.b.map(b => amostra(H, b.x, b.y, rr))).r);
  const num = dig[0] >= 0 && dig[1] >= 0 ? dig[0] * 10 + dig[1] : (dig[0] === -1 && dig[1] >= 0 ? dig[1] : null);
  return { ok: true, cv, H, resp, duvidas, num };
}

function desenharLeitura(canvas, entrada, r, p) {
  const { base, H } = entrada;
  canvas.width = base.width; canvas.height = base.height;
  const cx = canvas.getContext('2d');
  cx.drawImage(base, 0, 0);
  const L = layout(p);
  const raio = (x, y) => { const a = mapa(H, x, y), b = mapa(H, x + L.R, y); return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const css = getComputedStyle(document.documentElement);
  const cor = { certo: '#1b9a55', errado: '#d12f2f', multipla: '#d12f2f', anulada: '#888', semgab: '#2443c4' };
  const { det } = corrigir(p, r.resp);
  cx.lineWidth = Math.max(2, base.width / 400);
  L.qs.forEach((q, i) => {
    const st = det[i], marcada = r.resp[i];
    q.b.forEach((b, j) => {
      const [u, v] = mapa(H, b.x, b.y), rd = raio(b.x, b.y) * 1.15;
      const marc = marcada === j || (marcada === -2 && r.multi && r.multi[i] && r.multi[i].includes(j));
      if (marcada >= 0 && marcada === j) {
        cx.strokeStyle = cor[st] || '#2443c4'; cx.setLineDash([]);
        cx.beginPath(); cx.arc(u, v, rd, 0, Math.PI * 2); cx.stroke();
      } else if (j === p.gab[i] && st !== 'certo' && st !== 'anulada') {
        cx.strokeStyle = '#1b9a55'; cx.setLineDash([4, 3]);
        cx.beginPath(); cx.arc(u, v, rd, 0, Math.PI * 2); cx.stroke();
      }
    });
    if (st === 'multipla' || st === 'branco') {
      const [u, v] = mapa(H, q.x0 + 20, q.y);
      cx.fillStyle = st === 'multipla' ? '#d12f2f' : '#b07400';
      cx.beginPath(); cx.arc(u, v, raio(q.x0, q.y) * 0.4, 0, Math.PI * 2); cx.fill();
    }
  });
  cx.setLineDash([]);
  cx.strokeStyle = '#2443c4';
  cx.beginPath();
  L.fid.forEach(([x, y], i) => { const [u, v] = mapa(H, x, y); i ? cx.lineTo(u, v) : cx.moveTo(u, v); });
  cx.closePath(); cx.stroke();
}

/* ---------- Folha de exemplo (simula uma foto) ---------- */
function fotoExemplo(p) {
  const marks = p.gab.map((g, i) => {
    const r = Math.random();
    const certa = g >= 0 ? g : 0;
    if (r < 0.72) return certa;
    if (r < 0.88) return (certa + 1 + Math.floor(Math.random() * (p.k - 1))) % p.k;
    if (r < 0.95) return -1;
    return [certa, (certa + 1) % p.k];
  });
  const num = 1 + Math.floor(Math.random() * 38);
  const L = layout(p);
  const bloco = document.createElement('canvas'); bloco.width = L.W; bloco.height = L.H;
  drawSheet(bloco.getContext('2d'), p, { marks, num });
  let sheet = bloco;
  if (ehBloco(p)) {
    // Simula a última página da prova: questões à esquerda e o bloco do gabarito colado à direita
    sheet = document.createElement('canvas'); sheet.width = SW; sheet.height = SH;
    const sx = sheet.getContext('2d');
    sx.fillStyle = '#fff'; sx.fillRect(0, 0, SW, SH);
    sx.fillStyle = '#222'; sx.textAlign = 'left'; sx.textBaseline = 'alphabetic';
    const tres = p.modelo === 'bloco3' || p.modelo === 'bloco4'; // quadros largos vão na metade de baixo da página
    const area = tres ? { x: 90, y: 900, w: 1060 } : { x: 650, y: 110, w: 500 };
    const esc = Math.min(area.w / L.W, (SH - area.y - 160) / L.H);
    const texto = ['QUESTÃO 14. LM – D34', '(ENEM) Uma escola realizou um teste com 100 alunos,', 'com notas de 0 a 10. A maioria dos alunos tirou nota 5.', 'Se adicionarmos um aluno que tirou nota 10, o que', 'acontece com a média e a mediana?', 'Ⓐ A média e a mediana aumentam.', 'Ⓑ A média aumenta, mas a mediana permanece', 'Ⓒ A mediana aumenta, mas a média permanece', 'Ⓓ A média diminui.', 'Ⓔ Não há alteração significativa.', '', 'QUESTÃO 15. LM – D34', '(ENEM) Em um bairro, as rendas mensais das famílias', 'são: R$ 1.000, R$ 1.000, R$ 1.500, R$ 2.000,', 'R$ 10.000. Qual é a diferença entre a média e a', 'mediana dessas rendas?', 'Ⓐ R$ 500', 'Ⓑ R$ 1.500', 'Ⓒ R$ 2.000', 'Ⓓ R$ 2.500'];
    texto.forEach((t, i) => {
      sx.font = (t.startsWith('QUESTÃO') ? '700 ' : '400 ') + '22px "Times New Roman", serif';
      if (tres) { if (i < 10) sx.fillText(t, 90 + (i % 2) * 560, 130 + Math.floor(i / 2) * 34 * 1.4); }
      else sx.fillText(t, 90, 130 + i * 36);
    });
    sx.lineWidth = 2; sx.strokeStyle = '#000';
    if (!tres) { sx.beginPath(); sx.moveTo(620, 110); sx.lineTo(620, 1300); sx.stroke(); }
    sx.font = '400 20px "Times New Roman", serif'; sx.textAlign = 'center';
    sx.fillText('Barra do Corda – Ma', SW / 2, 1640); sx.fillText('2026', SW / 2, 1668);
    sx.drawImage(bloco, area.x + (area.w - L.W * esc) / 2, area.y, L.W * esc, L.H * esc);
  }
  const out = document.createElement('canvas'); out.width = 1500; out.height = 2000;
  const cx = out.getContext('2d');
  const mesa = cx.createLinearGradient(0, 0, 1500, 2000);
  mesa.addColorStop(0, '#7a6450'); mesa.addColorStop(1, '#3e3229');
  cx.fillStyle = mesa; cx.fillRect(0, 0, 1500, 2000);
  cx.save();
  cx.translate(750, 1000); cx.rotate((Math.random() - 0.5) * 0.12); cx.scale(1.05, 1.03);
  cx.shadowColor = 'rgba(0,0,0,0.45)'; cx.shadowBlur = 30;
  cx.drawImage(sheet, -SW / 2, -SH / 2);
  cx.restore();
  cx.globalCompositeOperation = 'multiply';
  const luz = cx.createLinearGradient(0, 0, 1500, 600);
  luz.addColorStop(0, 'rgb(255,252,245)'); luz.addColorStop(1, 'rgb(175,172,180)');
  cx.fillStyle = luz; cx.fillRect(0, 0, 1500, 2000);
  cx.globalCompositeOperation = 'source-over';
  out.gabaritoSimulado = { marks, num };
  return out;
}

/* ---------- Processar imagens ---------- */
async function carregarImagem(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function registrar(leitura, p, extra = {}) {
  if (!leitura.ok) { erros.unshift({ id: uid(), nome: extra.arquivo || 'Foto', erro: leitura.erro }); return null; }
  const turmaId = S.turmaAtual || null;
  // Mesmo aluno (Nº na chamada) da mesma turma nesta prova: a leitura nova substitui a anterior em vez de duplicar
  const anterior = leitura.num != null && !extra.exemplo
    ? resultados().find(x => !x.exemplo && x.num === leitura.num && (x.turmaId || null) === turmaId && x.corretor === Nuvem.email())
    : null;
  const r = anterior || { id: uid(), corretor: Nuvem.email(), corretorNome: Nuvem.nome(), turmaId, num: leitura.num, nome: extra.nome || '', exemplo: !!extra.exemplo };
  Object.assign(r, { resp: leitura.resp, duvidas: leitura.duvidas, quando: Date.now(), versao: p.versao });
  const base = document.createElement('canvas'); base.width = leitura.cv.width; base.height = leitura.cv.height;
  base.getContext('2d').drawImage(leitura.cv, 0, 0);
  sessao.set(r.id, { base, H: leitura.H });
  if (anterior) { r.substituiu = true; S.res[S.atual] = [r, ...resultados().filter(x => x !== r)]; }
  else resultados().unshift(r);
  save();
  return r;
}
async function processar(files) {
  if (semProva()) return;
  const p = prova();
  const lista = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  if (!lista.length) { toast('Escolha arquivos de imagem (JPG ou PNG).'); return; }
  toast(`Lendo ${lista.length} ${lista.length > 1 ? 'folhas' : 'folha'}…`);
  for (const f of lista) {
    try {
      const img = await carregarImagem(f);
      registrar(lerFolha(img, p), p, { arquivo: f.name });
    } catch (e) {
      erros.unshift({ id: uid(), nome: f.name, erro: 'Não consegui abrir esta imagem. Tente uma foto em JPG ou PNG.' });
    }
    renderCorrigir();
    await new Promise(r => setTimeout(r, 0));
  }
  const ok = lista.length;
  toast(`${ok} ${ok > 1 ? 'folhas lidas' : 'folha lida'}. Confira as marcadas em amarelo.`);
  renderResultados();
}
// Sem prova cadastrada pelo coordenador não há gabarito para comparar
function semProva() {
  if (!prova().local) return false;
  toast(ehCoord() ? 'Cadastre uma prova na aba Gabarito antes de corrigir.' : 'O coordenador ainda não cadastrou nenhuma prova.');
  return true;
}
function exemplo() {
  if (semProva()) return;
  const p = prova();
  registrar(lerFolha(fotoExemplo(p), p), p, { exemplo: true, nome: turmaPorId(S.turmaAtual)?.alunos.length ? '' : 'Aluno de exemplo' });
  renderCorrigir(); renderResultados();
}

/* ---------- Leitura pela câmera ----------
   Lê quadros do vídeo sem parar. Uma folha só é aceita quando 3 quadros seguidos dão a mesma leitura,
   e a mesma folha não é registrada duas vezes enquanto continua na frente da câmera. */
const CAM_QUADROS_IGUAIS = 3;
const cam = { ativo: false, stream: null, timer: 0, chave: null, iguais: 0, aceita: null, lidas: 0, ultimoId: null, som: null, wake: null };
const quadro = document.createElement('canvas');
const camStatus = t => { $('#cam-status').textContent = t; };
const camContar = () => { $('#cam-cont').textContent = `${cam.lidas} ${cam.lidas === 1 ? 'folha lida' : 'folhas lidas'}`; };

async function abrirCamera() {
  if (semProva()) return;
  const t = turmaPorId(S.turmaAtual);
  $('#cam').hidden = false; $('#cam-res').hidden = true;
  $('#cam-prova').textContent = prova().nome + (t ? ' · ' + t.nome : '');
  if (!navigator.mediaDevices?.getUserMedia) {
    camStatus('Este navegador não abre a câmera ao vivo. Feche e use “Tirar foto”.');
    return;
  }
  camStatus('Abrindo a câmera…');
  try { cam.som = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { cam.som = null; }
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    camStatus(e && e.name === 'NotAllowedError'
      ? 'O navegador bloqueou a câmera. Libere a câmera para este site nas permissões e tente de novo.'
      : 'Não consegui abrir a câmera. Feche e use “Tirar foto”.');
    return;
  }
  const v = $('#cam-video');
  v.srcObject = cam.stream;
  try { await v.play(); } catch (e) {}
  Object.assign(cam, { ativo: true, chave: null, iguais: 0, aceita: null, aceitaNum: null, lidas: 0, ultimoId: null });
  camContar();
  try { cam.wake = await navigator.wakeLock?.request('screen'); } catch (e) { cam.wake = null; }
  camStatus('Aponte para o gabarito, com os 4 quadrados pretos na tela');
  camLaco();
}
function fecharCamera() {
  cam.ativo = false; clearTimeout(cam.timer);
  cam.stream?.getTracks().forEach(tr => tr.stop()); cam.stream = null;
  try { cam.wake?.release(); } catch (e) {}
  try { cam.som?.close(); } catch (e) {}
  $('#cam-video').srcObject = null;
  $('#cam').hidden = true;
  renderCorrigir(); renderResultados();
}
function camLaco() {
  if (!cam.ativo) return;
  const v = $('#cam-video');
  if (v.videoWidth) {
    const sc = Math.min(1, 1400 / Math.max(v.videoWidth, v.videoHeight));
    quadro.width = Math.round(v.videoWidth * sc); quadro.height = Math.round(v.videoHeight * sc);
    quadro.getContext('2d').drawImage(v, 0, 0, quadro.width, quadro.height);
    const p = prova(), l = lerFolha(quadro, p);
    camGuia(l, p);
    if (l.ok) camAvaliar(l, p);
    else {
      cam.chave = null; cam.iguais = 0; cam.aceita = null; cam.aceitaNum = null;
      camStatus('Aponte para o gabarito, com os 4 quadrados pretos na tela');
    }
  }
  cam.timer = setTimeout(camLaco, 120);
}
function camGuia(l, p) {
  const g = $('#cam-guia');
  g.width = quadro.width; g.height = quadro.height;
  const cx = g.getContext('2d');
  cx.clearRect(0, 0, g.width, g.height);
  if (!l.ok) return;
  const L = layout(p), pronto = cam.iguais >= CAM_QUADROS_IGUAIS - 1;
  cx.lineWidth = Math.max(4, g.width / 200);
  cx.strokeStyle = pronto ? '#3ddc84' : '#ffd24d';
  cx.fillStyle = pronto ? 'rgba(61,220,132,.12)' : 'rgba(255,210,77,.08)';
  cx.beginPath();
  L.fid.forEach(([x, y], i) => { const [u, w] = mapa(l.H, x, y); i ? cx.lineTo(u, w) : cx.moveTo(u, w); });
  cx.closePath(); cx.fill(); cx.stroke();
}
function camAvaliar(l, p) {
  const chave = JSON.stringify([l.num, l.resp]);
  if (chave === cam.chave) cam.iguais++; else { cam.chave = chave; cam.iguais = 1; }
  if (cam.iguais < CAM_QUADROS_IGUAIS) { camStatus('Gabarito encontrado. Segure firme…'); return; }
  // A mesma folha continua na frente da câmera (mesma leitura ou mesmo Nº): não registra de novo
  if (chave === cam.aceita || (l.num != null && l.num === cam.aceitaNum)) { camStatus('Folha lida. Passe para a próxima.'); return; }
  const r = registrar(l, p);
  if (!r) return;
  cam.aceita = chave; cam.aceitaNum = l.num; cam.ultimoId = r.id;
  if (!r.substituiu) cam.lidas++;
  camContar(); camBip();
  try { navigator.vibrate?.(120); } catch (e) {}
  camStatus('Folha lida. Passe para a próxima.');
  camMostrar(r, p);
}
function camBip() {
  const a = cam.som; if (!a) return;
  try {
    const o = a.createOscillator(), gn = a.createGain();
    o.frequency.value = 880; gn.gain.value = 0.15;
    o.connect(gn); gn.connect(a.destination);
    o.start(); o.stop(a.currentTime + 0.12);
  } catch (e) {}
}
function camMostrar(r, p) {
  const c = corrigir(p, r.resp), nome = nomeDe(r);
  const avisos = [];
  if (r.num == null) avisos.push('Nº não lido');
  if (c.br) avisos.push(`${c.br} em branco`);
  if (c.mu) avisos.push(`${c.mu} com 2 marcas`);
  if (r.duvidas?.length) avisos.push('Confira: ' + r.duvidas.map(q => 'Q' + (q + 1)).join(', '));
  const box = $('#cam-res');
  box.innerHTML = `
    <div class="linha">
      <div class="nota">${fmt(c.nota)}</div>
      <div class="quem"><strong>${r.num != null ? String(r.num).padStart(2, '0') + ' · ' : ''}${esc(nome || 'Aluno sem nome')}</strong>
      <span class="muted">${c.ac} de ${p.n} acertos</span></div>
    </div>
    ${avisos.length ? `<div class="chips">${avisos.map(a => `<span class="chip warn">${esc(a)}</span>`).join('')}</div>` : ''}
    <div class="acoes"><button class="btn small danger" id="cam-desfazer">Desfazer esta leitura</button></div>`;
  box.hidden = false;
}
$('#cam-abrir').addEventListener('click', abrirCamera);
$('#cam-fechar').addEventListener('click', fecharCamera);
$('#cam').addEventListener('click', e => {
  if (e.target.id !== 'cam-desfazer' || !cam.ultimoId) return;
  S.res[S.atual] = resultados().filter(x => x.id !== cam.ultimoId);
  sessao.delete(cam.ultimoId); save();
  cam.ultimoId = null; cam.aceita = null; cam.aceitaNum = null; cam.lidas = Math.max(0, cam.lidas - 1); camContar();
  $('#cam-res').hidden = true; camStatus('Leitura desfeita. Aponte de novo para a folha.');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && cam.ativo) fecharCamera(); });

/* ---------- Interface ---------- */
let toastT;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
}
function armar(btn, rotulo, acao) {
  if (btn.classList.contains('armed')) { btn.classList.remove('armed'); btn.textContent = btn.dataset.txt; acao(); return; }
  btn.dataset.txt = btn.textContent; btn.textContent = rotulo; btn.classList.add('armed');
  setTimeout(() => { if (btn.classList.contains('armed')) { btn.classList.remove('armed'); btn.textContent = btn.dataset.txt; } }, 3500);
}

const ABAS_COORD = ['escola', 'turmas', 'gabarito'];
function irPara(aba) {
  if (!ehCoord() && ABAS_COORD.includes(aba)) aba = 'corrigir';
  S.aba = aba; save();
  if (aba === 'escola') renderEscola();
  document.querySelectorAll('nav.steps button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  document.querySelectorAll('section.aba').forEach(s => (s.hidden = s.dataset.aba !== aba));
  if (aba === 'folha') renderFolha();
  if (aba === 'resultados') renderResultados();
  if (aba === 'corrigir') { renderSeletoresTurma(); renderCorrigir(); }
  if (aba === 'turmas') renderTurmas();
}

function renderProvas() {
  $('#prova-sel').innerHTML = S.provas.map(p => `<option value="${p.id}" ${p.id === S.atual ? 'selected' : ''}>${esc(p.nome || 'Sem nome')}</option>`).join('');
}

function renderGabarito() {
  const p = prova();
  $('#f-nome').value = p.nome; $('#f-n').value = p.n; $('#f-k').value = p.k; $('#f-valor').value = p.valor; $('#f-modelo').value = p.modelo || 'padrao';
  $('#gab-grid').innerHTML = p.gab.map((g, q) => `
    <div class="gq ${p.anul[q] ? 'is-anul' : ''}">
      <span class="qn">${String(q + 1).padStart(2, '0')}</span>
      <div class="opts">${Array.from({ length: p.k }, (_, j) => `<button class="bub" data-q="${q}" data-j="${j}" aria-pressed="${g === j}" aria-label="Questão ${q + 1}, alternativa ${LETRAS[j]}">${LETRAS[j]}</button>`).join('')}</div>
      <button class="anular" data-anular="${q}" aria-pressed="${p.anul[q]}">${p.anul[q] ? 'Anulada' : 'Anular'}</button>
    </div>`).join('');
  renderGabStatus();
}
function renderGabStatus() {
  const p = prova();
  const faltam = p.gab.filter((g, i) => g < 0 && !p.anul[i]).length;
  $('#gab-status').innerHTML = faltam
    ? `<p class="notice">${faltam === 1 ? 'Falta 1 questão' : `Faltam ${faltam} questões`} sem resposta no gabarito.</p>`
    : `<p class="notice ok">Gabarito completo. Próximo passo: imprimir a folha de respostas.</p>`;
}
function mudarEstrutura(n, k) {
  const p = prova();
  n = Math.max(1, Math.min(75, n | 0)); k = Math.max(2, Math.min(5, k | 0));
  if (n === p.n && k === p.k) return;
  p.gab = Array.from({ length: n }, (_, i) => (p.gab[i] != null && p.gab[i] < k ? p.gab[i] : -1));
  p.anul = Array.from({ length: n }, (_, i) => !!p.anul[i]);
  p.n = n; p.k = k; p.versao = (p.versao || 1) + 1;
  save(); renderGabarito();
}

function renderFolha() {
  const p = prova();
  const L = layout(p);
  const c = document.createElement('canvas'); c.width = L.W; c.height = L.H;
  drawSheet(c.getContext('2d'), p);
  $('#sheet-img').src = c.toDataURL('image/png');
  $('#sheet-img').alt = `Folha de respostas: ${p.nome}`;
  $('#sheet-img').style.maxWidth = p.modelo === 'bloco' ? '340px' : '';
  const passos = ehBloco(p) ? [
    ['Salve a imagem do gabarito.', 'No computador, clique com o botão direito no quadro e escolha “Salvar imagem como”. No celular, toque e segure.'],
    ['Cole na prova.', `No Word, vá em Inserir → Imagens e coloque o quadro ${p.modelo === 'bloco' ? 'na coluna da direita da última página' : 'no fim da última página'}. Pode diminuir ou aumentar, mas não corte nem estique só para um lado.`],
    ['Deixe os 4 quadrados pretos visíveis', 'e com um pouco de espaço em branco em volta. Não coloque nenhuma imagem preta perto deles.'],
    ['Alunos escrevem o nome, pintam o Nº na chamada', 'e pintam a bolinha inteira de cada resposta, com caneta preta ou azul.'],
    ['Fotografe a página', 'de cima, com o quadro inteiro na foto, e envie na etapa 3.'],
  ] : [
    ['Salve a imagem.', 'No computador, clique com o botão direito na folha e escolha “Salvar imagem como”. No celular, toque e segure.'],
    ['Imprima em A4', ', uma cópia por aluno. Pode usar “ajustar à página”; o tamanho não importa, desde que os quatro cantos apareçam.'],
    ['Alunos escrevem o nome, pintam o Nº na chamada', 'e pintam a bolinha inteira de cada resposta, com caneta preta ou azul.'],
    ['Fotografe cada folha', 'de cima, inteira, sobre uma mesa, e envie na etapa 3.'],
  ];
  $('#folha-passos').innerHTML = passos.map(([a, b]) => `<li><span><strong>${a}</strong> ${b}</span></li>`).join('');
  $('#folha-aviso').hidden = !resultados().some(r => (r.versao || 1) !== (p.versao || 1));
}

function cardHTML(r, p) {
  const c = corrigir(p, r.resp);
  const dv = new Set(r.duvidas || []);
  const chips = [];
  if (c.br) chips.push(`<span class="chip warn">${c.br} em branco</span>`);
  if (c.mu) chips.push(`<span class="chip bad">${c.mu} com 2 marcas</span>`);
  if (dv.size) chips.push(`<span class="chip warn">Confira: ${[...dv].map(q => 'Q' + (q + 1)).join(', ')}</span>`);
  if (r.num == null) chips.push(`<span class="chip warn">Nº não lido</span>`);
  if (!chips.length) chips.push(`<span class="chip ok">Leitura sem dúvidas</span>`);
  const nomeSt = { certo: 'certa', errado: 'errada', branco: 'branco', multipla: '2 marcas', anulada: 'anulada', semgab: 'sem gabarito' };
  return `
    <canvas data-ov="${r.id}" aria-label="Foto lida com as marcações destacadas"></canvas>
    <div class="card-body">
      <div class="card-head">
        <div class="who">
          <label class="sr-only" for="n-${r.id}">Número na chamada</label>
          <input type="number" id="n-${r.id}" data-num="${r.id}" value="${r.num ?? ''}" placeholder="Nº" min="0" max="99">
          <label class="sr-only" for="a-${r.id}">Nome do aluno</label>
          <input type="text" id="a-${r.id}" data-nome="${r.id}" value="${esc(nomeDe(r))}" placeholder="Nome do aluno">
        </div>
        ${turmaPorId(r.turmaId) ? `<span class="chip turma">${esc(turmaPorId(r.turmaId).nome)}</span>` : ''}
        ${r.exemplo ? '<span class="tag-ex">Exemplo</span>' : ''}
      </div>
      <div class="grade">
        <div class="nota" aria-label="Nota">${fmt(c.nota)}</div>
        <div class="sum"><strong>${c.ac} de ${p.n}</strong> acertos<br>${c.er} erradas · vale ${fmt(p.valor)}</div>
      </div>
      <div class="chips">${chips.join('')}</div>
      <details class="review" ${dv.size || c.mu ? 'open' : ''}>
        <summary>Revisar respostas lidas</summary>
        <div class="rev-grid">${Array.from({ length: p.n }, (_, q) => {
          const st = c.det[q];
          return `<div class="rq ${st} ${dv.has(q) ? 'duvida' : ''}"><span class="qn">${q + 1}</span>${Array.from({ length: p.k }, (_, j) =>
            `<button class="bub ${p.gab[q] === j && st !== 'certo' && !p.anul[q] ? 'key' : ''}" data-r="${r.id}" data-q="${q}" data-j="${j}" aria-pressed="${r.resp[q] === j || (r.resp[q] === -2)}" aria-label="Questão ${q + 1}: marcar ${LETRAS[j]}">${LETRAS[j]}</button>`).join('')}<span class="st">${nomeSt[st]}</span></div>`;
        }).join('')}</div>
        <p class="muted" style="font-size:.85rem;margin-top:8px">Toque numa letra para corrigir a leitura. Toque de novo para deixar em branco. O contorno verde mostra a resposta certa.</p>
      </details>
      <div><button class="btn small danger" data-del="${r.id}">Remover esta folha</button></div>
    </div>`;
}
function renderCorrigir() {
  const p = prova();
  const box = $('#cards');
  const lidas = resultados().filter(r => sessao.has(r.id));
  let html = erros.map(e => `<div class="card err"><div class="card-body"><h3>${esc(e.nome)}</h3><p>${esc(e.erro)}</p></div></div>`).join('');
  html += lidas.map(r => `<article class="card" data-card="${r.id}">${cardHTML(r, p)}</article>`).join('');
  box.innerHTML = html || '';
  lidas.forEach(r => desenharLeitura(box.querySelector(`[data-ov="${r.id}"]`), sessao.get(r.id), r, p));
}
function atualizarCard(id) {
  const p = prova(), r = resultados().find(x => x.id === id), el = document.querySelector(`[data-card="${id}"]`);
  if (!r || !el) return;
  const aberto = el.querySelector('details')?.open;
  el.innerHTML = cardHTML(r, p);
  if (aberto) el.querySelector('details').open = true;
  desenharLeitura(el.querySelector('canvas'), sessao.get(id), r, p);
}

// Resultados da prova atual, filtrados pela turma escolhida na etapa 5 ('*' = todas, '' = sem turma)
function filtrados() {
  const f = S.turmaFiltro ?? '*';
  return resultados().filter(r => f === '*' || (r.turmaId || '') === f);
}
function renderResultados() {
  renderSeletoresTurma();
  const p = prova(), rs = filtrados(), t = turmaPorId(S.turmaFiltro);
  $('#res-lead').textContent = `${p.nome}${t ? ' · ' + t.nome : ''} · ${rs.length} ${rs.length === 1 ? 'folha corrigida' : 'folhas corrigidas'}${ehCoord() ? '' : ' por você'}.`;
  const corrigidos = new Set(rs.map(r => r.num));
  const faltam = t ? t.alunos.map((nome, i) => ({ nome, num: i + 1 })).filter(a => a.nome && !corrigidos.has(a.num)) : [];
  const faltamHTML = t && t.alunos.length ? `<div style="display:grid;gap:8px"><h3>${faltam.length ? `Faltam corrigir (${faltam.length})` : 'Todos os alunos da turma foram corrigidos'}</h3>${faltam.length ? `<div class="chips">${faltam.map(a => `<span class="chip">${String(a.num).padStart(2, '0')} · ${esc(a.nome)}</span>`).join('')}</div>` : ''}</div>` : '';
  if (!rs.length) { $('#res-body').innerHTML = `<div class="empty">Nenhuma folha corrigida ${t ? 'desta turma' : ''} ainda. Envie fotos na etapa 4.</div>${faltamHTML}`; return; }
  const cs = rs.map(r => corrigir(p, r.resp));
  const notas = cs.map(c => c.nota);
  const media = notas.reduce((a, b) => a + b, 0) / notas.length;
  const aprov = notas.filter(n => n >= p.valor * 0.6).length;
  const ordem = rs.map((r, i) => ({ r, c: cs[i] })).sort((a, b) => (a.r.num ?? 999) - (b.r.num ?? 999));
  const porQ = Array.from({ length: p.n }, (_, q) => cs.filter(c => c.det[q] === 'certo' || c.det[q] === 'anulada').length / cs.length);
  const nums = rs.map(r => r.num).filter(n => n != null);
  const rep = new Set(nums.filter((n, i) => nums.indexOf(n) !== i));
  $('#res-body').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="v">${fmt(media)}</div><div class="l">Média da turma</div></div>
      <div class="stat"><div class="v">${fmt(Math.max(...notas))}</div><div class="l">Maior nota</div></div>
      <div class="stat"><div class="v">${fmt(Math.min(...notas))}</div><div class="l">Menor nota</div></div>
      <div class="stat"><div class="v">${aprov}/${rs.length}</div><div class="l">Com 60% ou mais</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Nº</th><th>Aluno</th><th>Acertos</th><th>Nota</th><th>Situação</th></tr></thead>
      <tbody>${ordem.map(({ r, c }) => `<tr>
        <td class="num">${r.num ?? '–'}${rep.has(r.num) ? ' <span class="chip warn">repetido</span>' : ''}</td>
        <td><label class="sr-only" for="t-${r.id}">Nome</label><input type="text" id="t-${r.id}" data-nome="${r.id}" value="${esc(nomeDe(r))}" placeholder="Nome do aluno"> ${r.exemplo ? '<span class="tag-ex">Exemplo</span>' : ''}</td>
        <td class="num">${c.ac}/${p.n}</td>
        <td class="num"><strong>${fmt(c.nota)}</strong></td>
        <td>${c.br || c.mu ? `<span class="chip warn">${[c.br ? c.br + ' em branco' : '', c.mu ? c.mu + ' c/ 2 marcas' : ''].filter(Boolean).join(' · ')}</span>` : '<span class="chip">ok</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div style="display:grid;gap:12px">
      <h3>Acertos por questão</h3>
      <div class="bar-list">${porQ.map((v, q) => `<div class="bar ${v < 0.5 ? 'low' : ''}"><span class="mono">Q${q + 1}</span><span class="track"><span class="fill" style="display:block;width:${Math.round(v * 100)}%"></span></span><span class="pct">${Math.round(v * 100)}%</span></div>`).join('')}</div>
    </div>
    ${faltamHTML}`;
}

function tsv() {
  const p = prova();
  const linhas = [['Turma', 'Nº', 'Aluno', 'Acertos', 'Nota', ...Array.from({ length: p.n }, (_, i) => 'Q' + (i + 1))].join('\t')];
  [...filtrados()].sort((a, b) => (turmaPorId(a.turmaId)?.nome || '').localeCompare(turmaPorId(b.turmaId)?.nome || '') || (a.num ?? 999) - (b.num ?? 999)).forEach(r => {
    const c = corrigir(p, r.resp);
    linhas.push([turmaPorId(r.turmaId)?.nome || '', r.num ?? '', nomeDe(r), c.ac, fmt(c.nota), ...r.resp.map(x => (x >= 0 ? LETRAS[x] : x === -2 ? '*' : ''))].join('\t'));
  });
  return linhas.join('\n');
}

/* ---------- Eventos ---------- */
document.querySelectorAll('nav.steps button').forEach(b => b.addEventListener('click', () => irPara(b.dataset.aba)));
$('#prova-sel').addEventListener('change', e => { S.atual = e.target.value; erros.length = 0; save(); renderGabarito(); irPara(S.aba); });
$('#nova').addEventListener('click', () => {
  const p = novaProva(`Nova prova ${S.provas.length + 1}`, 20, 5, 10);
  S.provas.push(p); S.atual = p.id; save(); renderProvas(); renderGabarito(); irPara('gabarito');
  $('#f-nome').select();
});
$('#excluir').addEventListener('click', e => armar(e.currentTarget, 'Confirmar exclusão', () => {
  delete S.res[S.atual];
  S.provas = S.provas.filter(p => p.id !== S.atual && !p.local);
  if (!S.provas.length) S.provas.push(novaProva('Prova 1'));
  S.atual = S.provas[0].id; save(); renderProvas(); renderGabarito(); irPara(S.aba); toast('Prova excluída');
}));
$('#f-nome').addEventListener('input', e => { prova().nome = e.target.value; save(); renderProvas(); });
$('#f-n').addEventListener('change', e => mudarEstrutura(+e.target.value, prova().k));
$('#f-k').addEventListener('change', e => mudarEstrutura(prova().n, +e.target.value));
$('#f-modelo').addEventListener('change', e => { const p = prova(); p.modelo = e.target.value; p.versao = (p.versao || 1) + 1; save(); toast(`Modelo da folha: ${MODELOS[p.modelo]}. Imprima a folha nova na etapa 3.`); });
$('#f-valor').addEventListener('change', e => { const v = parseFloat(e.target.value); if (v > 0) { prova().valor = v; save(); } else e.target.value = prova().valor; });
$('#aplicar-cola').addEventListener('click', () => {
  const p = prova();
  const seq = $('#f-cola').value.toUpperCase().replace(/[^A-E-]/g, '');
  if (!seq) { toast('Digite as letras do gabarito, por exemplo: BDACE'); return; }
  [...seq].slice(0, p.n).forEach((c, i) => { if (c !== '-') { const j = LETRAS.indexOf(c); if (j < p.k) p.gab[i] = j; } });
  save(); renderGabarito(); toast(`Gabarito aplicado em ${Math.min(seq.length, p.n)} questões`);
});
$('#gab-grid').addEventListener('click', e => {
  const p = prova();
  const b = e.target.closest('.bub'), a = e.target.closest('[data-anular]');
  if (b) { const q = +b.dataset.q, j = +b.dataset.j; p.gab[q] = p.gab[q] === j ? -1 : j; }
  else if (a) { const q = +a.dataset.anular; p.anul[q] = !p.anul[q]; }
  else return;
  save(); renderGabarito();
});

$('#foto').addEventListener('change', e => { processar(e.target.files); e.target.value = ''; });
$('#foto-cam').addEventListener('change', e => { processar(e.target.files); e.target.value = ''; });
$('#demo').addEventListener('click', exemplo);
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => processar(e.dataTransfer.files));

$('#cards').addEventListener('click', e => {
  const b = e.target.closest('.bub[data-r]'), d = e.target.closest('[data-del]');
  if (b) {
    const r = resultados().find(x => x.id === b.dataset.r); if (!r) return;
    const q = +b.dataset.q, j = +b.dataset.j;
    r.resp[q] = r.resp[q] === j ? -1 : j;
    r.duvidas = (r.duvidas || []).filter(x => x !== q);
    save(); atualizarCard(r.id);
  } else if (d) {
    armar(d, 'Confirmar', () => { S.res[S.atual] = resultados().filter(x => x.id !== d.dataset.del); sessao.delete(d.dataset.del); save(); renderCorrigir(); });
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  const r = t.dataset.nome ? resultados().find(x => x.id === t.dataset.nome) : t.dataset.num ? resultados().find(x => x.id === t.dataset.num) : null;
  if (!r) return;
  if (t.dataset.nome) r.nome = t.value;
  else r.num = t.value === '' ? null : Math.max(0, Math.min(99, parseInt(t.value, 10) || 0));
  save();
});

/* ---------- Turmas ---------- */
function renderSeletoresTurma() {
  const opts = S.turmas.map(t => `<option value="${t.id}">${esc(t.nome)} (${t.alunos.length})</option>`).join('');
  $('#c-turma').innerHTML = opts + '<option value="">Sem turma</option>';
  $('#c-turma').value = S.turmaAtual || '';
  $('#r-turma').innerHTML = '<option value="*">Todas as turmas</option>' + opts + '<option value="">Sem turma</option>';
  $('#r-turma').value = S.turmaFiltro ?? '*';
}
function renderTurmas() {
  const t = turmaPorId(S.turmaEdit);
  $('#turma-lista').innerHTML = S.turmas.map(x => `<button data-turma="${x.id}" aria-current="${x.id === S.turmaEdit}"><span>${esc(x.nome)}</span><span class="qt">${x.alunos.length}</span></button>`).join('')
    || '<p class="muted">Nenhuma turma ainda.</p>';
  if (!t) { $('#turma-edit').innerHTML = '<div class="empty">Crie uma turma para cadastrar os alunos.</div>'; return; }
  $('#turma-edit').innerHTML = `
    <div class="row-between">
      <div class="field" style="flex:1 1 260px"><label for="t-nome">Nome da turma</label><input type="text" id="t-nome" value="${esc(t.nome)}" maxlength="40"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small" id="t-ordenar">Ordenar A–Z</button>
        <button class="btn small danger" id="t-excluir">Excluir turma</button>
      </div>
    </div>
    <div class="turma-cols">
      <div class="field"><label for="t-alunos">Alunos, um por linha</label>
        <textarea id="t-alunos" spellcheck="false" placeholder="Cole aqui os nomes na ordem da chamada">${esc(t.alunos.join('\n'))}</textarea></div>
      <div class="field"><label>Nº na chamada</label><ol class="chamada" id="t-chamada"></ol></div>
    </div>`;
  renderChamada(t);
}
function renderChamada(t) {
  $('#t-chamada').innerHTML = t.alunos.length
    ? t.alunos.map((n, i) => `<li><span class="nn">${String(i + 1).padStart(2, '0')}</span><span>${esc(n)}</span></li>`).join('')
    : '<li><span></span><span class="muted">A lista numerada aparece aqui.</span></li>';
  const b = document.querySelector(`[data-turma="${t.id}"] .qt`); if (b) b.textContent = t.alunos.length;
}
$('#turma-lista').addEventListener('click', e => {
  const b = e.target.closest('[data-turma]'); if (!b) return;
  S.turmaEdit = b.dataset.turma; save(); renderTurmas();
});
$('#nova-turma').addEventListener('click', () => {
  const t = { id: uid(), nome: `Nova turma ${S.turmas.length + 1}`, alunos: [] };
  S.turmas.push(t); S.turmaEdit = t.id; if (!S.turmaAtual) S.turmaAtual = t.id;
  save(); renderTurmas(); $('#t-nome').select();
});
$('#turma-edit').addEventListener('input', e => {
  const t = turmaPorId(S.turmaEdit); if (!t) return;
  if (e.target.id === 't-nome') { t.nome = e.target.value; const b = document.querySelector(`[data-turma="${t.id}"] span`); if (b) b.textContent = t.nome; }
  if (e.target.id === 't-alunos') { t.alunos = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); renderChamada(t); }
  save();
});
$('#turma-edit').addEventListener('click', e => {
  const t = turmaPorId(S.turmaEdit); if (!t) return;
  if (e.target.id === 't-ordenar') {
    t.alunos.sort((a, b) => a.localeCompare(b, 'pt-BR')); save(); renderTurmas();
    toast('Lista em ordem alfabética. Confira se bate com o Nº do diário.');
  }
  if (e.target.id === 't-excluir') armar(e.target, 'Confirmar exclusão', () => {
    S.turmas = S.turmas.filter(x => x.id !== t.id);
    if (S.turmaAtual === t.id) S.turmaAtual = S.turmas[0]?.id || null;
    if (S.turmaFiltro === t.id) S.turmaFiltro = '*';
    S.turmaEdit = S.turmas[0]?.id || null; save(); renderTurmas(); toast('Turma excluída');
  });
});
// Lê linhas coladas de uma planilha (tab, ponto e vírgula ou vírgula) e agrupa os nomes por turma, na ordem das linhas
function lerPlanilha(texto) {
  const linhas = texto.split(/\r?\n/).map(l => l.split(/\t|;|,/).map(c => c.trim())).filter(c => c.some(Boolean));
  if (!linhas.length) return null;
  const cab = linhas[0].map(c => c.toLowerCase());
  let iNome = cab.findIndex(c => c === 'nome' || c === 'aluno' || c.startsWith('nome do') || c.startsWith('nome '));
  let iTurma = cab.findIndex(c => c.startsWith('turma'));
  let corpo = linhas;
  if (iNome >= 0 && iTurma >= 0) corpo = linhas.slice(1);
  else {
    // Sem cabeçalho: o nome é a coluna de texto mais longo e a turma é a coluna que mais se repete
    const cols = Math.max(...linhas.map(l => l.length));
    if (cols < 2) return null;
    const tam = j => linhas.reduce((s, l) => s + (l[j] || '').length, 0);
    const dist = j => new Set(linhas.map(l => l[j] || '')).size;
    iNome = [...Array(cols).keys()].reduce((a, j) => (tam(j) > tam(a) ? j : a), 0);
    iTurma = [...Array(cols).keys()].filter(j => j !== iNome).reduce((a, j) => (dist(j) < dist(a) ? j : a));
  }
  const grupos = new Map();
  corpo.forEach(l => {
    const nome = (l[iNome] || '').replace(/\s+/g, ' ').trim(), turma = (l[iTurma] || '').trim();
    if (!nome || !turma) return;
    if (!grupos.has(turma)) grupos.set(turma, []);
    grupos.get(turma).push(nome);
  });
  return grupos.size ? grupos : null;
}
$('#imp-texto').addEventListener('input', e => {
  const g = lerPlanilha(e.target.value);
  const total = g ? [...g.values()].reduce((s, l) => s + l.length, 0) : 0;
  $('#imp-previa').textContent = g ? `Encontrei ${g.size} ${g.size === 1 ? 'turma' : 'turmas'} e ${total} alunos.` : e.target.value.trim() ? 'Não encontrei as colunas de nome e turma.' : '';
});
$('#imp-aplicar').addEventListener('click', () => {
  const g = lerPlanilha($('#imp-texto').value);
  if (!g) { toast('Cole as colunas de nome e turma copiadas da planilha.'); return; }
  let novas = 0, atualizadas = 0;
  g.forEach((alunos, nome) => {
    const t = S.turmas.find(x => x.nome === nome);
    if (t) { t.alunos = alunos; atualizadas++; }
    else { S.turmas.push({ id: uid(), nome, alunos }); novas++; }
  });
  S.turmas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
  if (!turmaPorId(S.turmaAtual)) S.turmaAtual = S.turmas[0].id;
  S.turmaEdit = S.turmas.find(x => g.has(x.nome)).id;
  save(); $('#imp-texto').value = ''; $('#imp-previa').textContent = ''; $('#importar').open = false;
  renderTurmas(); renderSeletoresTurma();
  toast([novas && `${novas} ${novas === 1 ? 'turma criada' : 'turmas criadas'}`, atualizadas && `${atualizadas} ${atualizadas === 1 ? 'atualizada' : 'atualizadas'}`].filter(Boolean).join(', '));
});
$('#c-turma').addEventListener('change', e => { S.turmaAtual = e.target.value || null; save(); });
$('#r-turma').addEventListener('change', e => { S.turmaFiltro = e.target.value; save(); renderResultados(); });

$('#copiar').addEventListener('click', async () => {
  const texto = tsv();
  try { await navigator.clipboard.writeText(texto); toast('Copiado. Cole no Excel ou no Google Planilhas.'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = texto; ta.style.cssText = 'width:100%;height:160px;font-family:monospace';
    ta.setAttribute('aria-label', 'Resultados para copiar');
    $('#res-body').prepend(ta); ta.select(); toast('Selecionei o texto: use Ctrl+C para copiar.');
  }
});
$('#limpar').addEventListener('click', e => armar(e.currentTarget, 'Confirmar: apagar tudo', () => {
  const apagar = new Set(filtrados().map(r => r.id));
  S.res[S.atual] = resultados().filter(r => !apagar.has(r.id));
  apagar.forEach(id => sessao.delete(id)); erros.length = 0; save(); renderResultados(); renderCorrigir(); toast('Resultados apagados');
}));

/* ---------- Escola: pessoas e permissões (só coordenadores) ---------- */
const PAPEIS = { coordenador: 'Coordenador de área', professor: 'Professor' };
function renderEscola() {
  if (!ehCoord()) return;
  if (document.activeElement?.id !== 'esc-nome') $('#esc-nome').value = nuvem.escolaNome;
  const lista = (nuvem.membros || []).slice().sort((a, b) => (a.papel === b.papel ? a.email.localeCompare(b.email) : a.papel === 'coordenador' ? -1 : 1));
  $('#membros-lista').innerHTML = lista.map(m => `<tr>
      <td>${esc(m.email)}${m.email === Nuvem.email() ? ' <span class="muted">(você)</span>' : ''}</td>
      <td>${m.email === Nuvem.email() ? `<span class="pill coord">${PAPEIS[m.papel]}</span>`
        : `<label class="sr-only" for="pp-${esc(m.email)}">Acesso de ${esc(m.email)}</label><select id="pp-${esc(m.email)}" data-papel-de="${esc(m.email)}">${Object.entries(PAPEIS).map(([v, t]) => `<option value="${v}" ${m.papel === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`}</td>
      <td>${m.email === Nuvem.email() ? '' : `<button class="btn small danger" data-remover="${esc(m.email)}">Remover</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="muted">Carregando…</td></tr>';
  const antigos = dadosAntigos();
  $('#levar-locais').hidden = !(antigos.turmas.length || antigos.provas.length);
  $('#levar-resumo').textContent = `Neste aparelho há ${antigos.turmas.length} ${antigos.turmas.length === 1 ? 'turma' : 'turmas'} e ${antigos.provas.length} ${antigos.provas.length === 1 ? 'prova' : 'provas'} de antes do login. Turmas e provas com o mesmo nome de uma que já existe na escola não são enviadas.`;
}
$('#esc-nome').addEventListener('change', e => {
  const nome = e.target.value.trim(); if (!nome) { e.target.value = nuvem.escolaNome; return; }
  Nuvem.escola(nuvem.eid).update({ nome }).then(() => { nuvem.escolaNome = nome; mostrarQuemSou(); toast('Nome da escola salvo'); }).catch(falhaGravar);
});
$('#membro-novo').addEventListener('submit', e => {
  e.preventDefault();
  const email = $('#m-email').value.trim().toLowerCase(), papel = $('#m-papel').value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Digite um e-mail válido.'); return; }
  if ((nuvem.membros || []).some(m => m.email === email)) { toast('Este e-mail já está cadastrado. Mude o acesso na lista.'); return; }
  Nuvem.membro(nuvem.eid, email).set({ escolaId: nuvem.eid, email, papel, nome: '' })
    .then(() => { $('#m-email').value = ''; toast(`${email} cadastrado como ${PAPEIS[papel].toLowerCase()}`); })
    .catch(falhaGravar);
});
$('#membros-lista').addEventListener('change', e => {
  const email = e.target.dataset.papelDe; if (!email) return;
  Nuvem.membro(nuvem.eid, email).update({ papel: e.target.value }).then(() => toast('Acesso alterado')).catch(falhaGravar);
});
$('#membros-lista').addEventListener('click', e => {
  const b = e.target.closest('[data-remover]'); if (!b) return;
  armar(b, 'Confirmar', () => Nuvem.membro(nuvem.eid, b.dataset.remover).delete().then(() => toast('Pessoa removida da escola')).catch(falhaGravar));
});
$('#levar-aplicar').addEventListener('click', () => {
  const antigos = dadosAntigos();
  const turmasNovas = antigos.turmas.filter(t => !S.turmas.some(x => x.nome === t.nome));
  const provasNovas = antigos.provas.filter(p => !S.provas.some(x => x.nome === p.nome));
  S.turmas.push(...turmasNovas.map(t => ({ id: uid(), nome: t.nome, alunos: t.alunos })));
  S.provas = S.provas.filter(p => !p.local).concat(provasNovas.map(p => ({ ...p, id: uid() })));
  ajustarEscolhas(); save(); renderTudo();
  try { localStorage.removeItem(KEY); } catch (e) {}
  $('#levar-locais').hidden = true;
  toast(`Enviadas ${turmasNovas.length} turmas e ${provasNovas.length} provas para a escola`);
});

/* ---------- Entrada: login com Google e escolha da escola ---------- */
const GOOGLE_ICONE = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
const entrada = html => { $('#entrada').hidden = false; $('#entrada-corpo').innerHTML = html; };

function telaLogin(msg) {
  entrada(`<div><h2>Entrar</h2><p class="muted">Use a conta Google que o coordenador da sua escola cadastrou.</p></div>
    <button class="btn google" id="entrar-google">${GOOGLE_ICONE}Entrar com Google</button>
    ${msg ? `<p class="notice">${esc(msg)}</p>` : ''}`);
  $('#entrar-google').addEventListener('click', () => {
    Nuvem.entrar().catch(e => {
      if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') return;
      telaLogin(e?.code === 'auth/unauthorized-domain' ? 'Este endereço ainda não foi liberado no Firebase. Veja o guia de configuração.' : 'Não consegui entrar. Tente de novo.');
    });
  });
}
async function telaEscolas() {
  entrada('<p class="muted">Procurando suas escolas…</p>');
  let escolas = [];
  try { escolas = await Nuvem.minhasEscolas(); }
  catch (e) { entrada(`<p class="notice">Não consegui buscar suas escolas. Confira a internet e recarregue a página.</p>`); return; }
  const ultima = (() => { try { return localStorage.getItem('corretor-gabaritos.escola'); } catch (e) { return null; } })();
  const auto = escolas.find(x => x.id === ultima) || (escolas.length === 1 ? escolas[0] : null);
  if (auto && !nuvem.trocando) { entrarNaEscola(auto); return; }
  nuvem.trocando = false;
  entrada(`
    <div><h2>${escolas.length ? 'Escolha a escola' : 'Você ainda não está em nenhuma escola'}</h2>
    <p class="muted">Conectado como <strong>${esc(Nuvem.email())}</strong>.${escolas.length ? '' : ' Peça ao coordenador para cadastrar este e-mail na escola, ou cadastre uma escola nova.'}</p></div>
    ${escolas.length ? `<div class="escolas">${escolas.map(x => `<button data-escola="${x.id}"><span>${esc(x.nome)}</span><span class="pill ${x.papel === 'coordenador' ? 'coord' : ''}">${PAPEIS[x.papel]}</span></button>`).join('')}</div>` : ''}
    <details class="importar"${escolas.length ? '' : ' open'}>
      <summary>Cadastrar uma escola nova</summary>
      <form class="importar-body" id="nova-escola">
        <p class="muted">Você será o primeiro coordenador e poderá cadastrar os professores e outros coordenadores.</p>
        <div class="field"><label for="ne-nome">Nome da escola</label><input type="text" id="ne-nome" maxlength="80" required placeholder="Digite aqui. Ex.: Centro Educa Mais…"></div>
        <div><button class="btn primary" type="submit">Cadastrar escola</button></div>
      </form>
    </details>
    <button class="btn small" id="entrada-sair">Entrar com outra conta</button>`);
  $('#entrada-corpo').querySelectorAll('[data-escola]').forEach(b => b.addEventListener('click', () => entrarNaEscola(escolas.find(x => x.id === b.dataset.escola))));
  $('#entrada-sair').addEventListener('click', () => Nuvem.sair());
  $('#nova-escola').addEventListener('submit', async e => {
    e.preventDefault();
    const nome = $('#ne-nome').value.trim(); if (!nome) return;
    e.submitter && (e.submitter.disabled = true);
    try {
      const id = await Nuvem.criarEscola(nome);
      entrarNaEscola({ id, nome, papel: 'coordenador' }, 'escola');
    } catch (err) { toast('Não consegui cadastrar a escola. Tente de novo.'); e.submitter && (e.submitter.disabled = false); }
  });
}
function mostrarQuemSou() {
  $('#eu-escola').textContent = nuvem.escolaNome;
  $('#eu-info').textContent = `${Nuvem.email()} · ${PAPEIS[nuvem.papel]}`;
}
function entrarNaEscola(escola, abaInicial) {
  Object.assign(nuvem, { eid: escola.id, escolaNome: escola.nome, papel: escola.papel, membros: [] });
  try { localStorage.setItem('corretor-gabaritos.escola', escola.id); } catch (e) {}
  Object.assign(S, { provas: [], turmas: [], res: {}, atual: null, turmaAtual: null, turmaEdit: null, turmaFiltro: '*', aba: ehCoord() ? 'turmas' : 'corrigir' });
  sessao.clear(); erros.length = 0;
  lerPrefs();
  if (abaInicial) S.aba = abaInicial;
  document.body.dataset.papel = nuvem.papel;
  mostrarQuemSou();
  ajustarEscolhas();
  renderTudo();
  ouvirEscola();
  $('#entrada').hidden = true;
}
function sairDaEscola() {
  nuvem.parar.forEach(f => f()); nuvem.parar = [];
  if (cam.ativo) fecharCamera();
  Object.assign(nuvem, { eid: null, papel: null, escolaNome: '' });
}
$('#trocar').addEventListener('click', () => { sairDaEscola(); nuvem.trocando = true; telaEscolas(); });
$('#sair').addEventListener('click', () => { sairDaEscola(); Nuvem.sair(); });

/* ---------- Início ---------- */
if (!Nuvem.configurado) {
  entrada(`<div><h2>Falta configurar o Firebase</h2><p class="muted">Preencha o arquivo <strong>js/firebase-config.js</strong> com os dados do projeto Firebase da escola, como explica o README.</p></div>`);
} else {
  Nuvem.aoMudarUsuario(u => {
    if (!u) { sairDaEscola(); telaLogin(); }
    else if (!nuvem.eid) telaEscolas();
  });
}
window.__corretor = { lerFolha, fotoExemplo, prova, layout };
})();
