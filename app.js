/* Inventário de Estoque - app.js
   - Lê CSV (PapaParse) via upload ou fetch local (estoque.csv)
   - Salva contagens no localStorage
   - Mostra progresso, divergências e gráficos (Chart.js)
*/

const STORAGE_KEY = "inventario_counts_v1";
const STORAGE_META_KEY = "inventario_meta_v1";
const STORAGE_UI_META_KEY = "inventario_ui_meta_v1";
const STORAGE_USER_KEY = "inventario_user_v1";
const STORAGE_COLLECTOR_KEY = "inventario_collector_v1";

let produtos = [];         // base (CSV)
let counts = {};           // { codigoKey: { counted:number } }
let selectedKey = null;
let statusChart = null;
let topDivChart = null;

let progressFilter = 'all';
let divFilter = 'all';

let currentUser = null;
let collectorMode = false;
let remoteTsByKey = {};


function $(id){ return document.getElementById(id); }

function toast(msg){
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> el.classList.remove("show"), 2400);
}

function norm(s){
  return (s ?? "").toString().trim();
}

function normalizeSearch(s){
  return norm(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\s+/g," ");
}

// parse number that may be "1.929,00" or "449,5" or "8"
function parsePtNumber(v){
  const s = norm(v);
  if(!s) return 0;
  // keep digits, comma, dot, minus
  const cleaned = s.replace(/[^0-9,\.\-]/g,"");
  // if has comma, treat comma as decimal and remove dots as thousand
  if(cleaned.includes(",")){
    const noThousands = cleaned.replace(/\./g,"");
    const dotDec = noThousands.replace(",", ".");
    const n = Number(dotDec);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function formatInt(n){
  if(n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toString();
}

function formatMoney(n){
  if(n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("pt-BR", { style:"currency", currency:"BRL" });
}

function codeKey(row){
  // Prefer Código Produto; fallback to Código Acesso; else use Produto
  const cod = norm(row.codigoProduto);
  if(cod) return "P:" + cod;
  const acc = norm(row.codigoAcesso);
  if(acc) return "A:" + acc;
  return "D:" + normalizeSearch(row.produto).slice(0,60);
}

function getCounted(key){
  const c = counts[key];
  if(!c || c.counted === null || c.counted === undefined) return null;
  return c.counted;
}

function computeRowMetrics(row){
  const key = row._key;
  const sys = row.qtdSistema;
  const counted = getCounted(key);
  const hasCount = counted !== null && counted !== undefined && counted !== "";
  const diff = hasCount ? (counted - sys) : null;
  const impacto = hasCount ? (diff * row.custo) : null;

  let status = "FALTANDO";
  if(hasCount){
    status = (diff === 0) ? "OK" : "DIVERGÊNCIA";
  }
  return { hasCount, counted, diff, impacto, status };
}


function classifyRow(p){
  const m = computeRowMetrics(p);
  if(!m.hasCount) return "missing";
  if(m.diff === 0) return "ok";
  if(m.diff > 0) return "over";   // físico > sistema (sobra)
  return "under";                // sistema > físico (falta)
}

function matchFilter(category, filter){
  if(filter === "all") return true;
  if(filter === "div") return category === "over" || category === "under";
  return category === filter;
}


function loadStorage(){
  try{
    counts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  }catch(e){
    counts = {};
  }
}

function saveStorage(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
}

function setMeta(meta){
  localStorage.setItem(STORAGE_META_KEY, JSON.stringify(meta));
}

function getMeta(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_META_KEY) || "null"); }
  catch(e){ return null; }
}


function loadUiMeta(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_UI_META_KEY) || "{}") || {}; }
  catch(e){ return {}; }
}
function saveUiMeta(meta){
  localStorage.setItem(STORAGE_UI_META_KEY, JSON.stringify(meta || {}));
}

function getCurrentUser(){ return currentUser || localStorage.getItem(STORAGE_USER_KEY) || null; }
function setCurrentUser(u){
  currentUser = (u||'').trim();
  if(currentUser) localStorage.setItem(STORAGE_USER_KEY, currentUser);
  const pill = $('currentUserPill');
  if(pill) pill.textContent = '👤 ' + (currentUser||'—');
  try{ if(window.FB && FB.fbSetUser) FB.fbSetUser(currentUser); }catch(e){}
}
function getCollectorMode(){ return localStorage.getItem(STORAGE_COLLECTOR_KEY)==='1'; }
function setCollectorMode(v){ collectorMode=!!v; localStorage.setItem(STORAGE_COLLECTOR_KEY, collectorMode?'1':'0'); const t=$('toggleCollector'); if(t) t.checked=collectorMode; }


function fbSaveForKey(key){
  try{
    if(!window.FB || !FB.fbSaveCount) return;
    const c = countsByKey[key];
    if(!c) return;
    FB.fbSaveCount(key, { counted: c.counted });
  }catch(e){ console.warn(e); }
}

function applyRemoteCounts(remote){
  if(!remote || typeof remote !== "object") return;
  let changed = false;
  for(const [k,v] of Object.entries(remote)){
    if(!v) continue;
    const ts = v.ts || 0;
    const prev = remoteTsByKey[k] || 0;
    if(ts && ts < prev) continue;
    remoteTsByKey[k] = ts || prev;

    const remoteCount = (typeof v.counted === "number") ? v.counted : parseFloat(v.counted);
    if(!Number.isFinite(remoteCount)) continue;

    const local = countsByKey[k];
    if(!local || local.counted !== remoteCount){
      countsByKey[k] = { counted: remoteCount, user: v.user || local?.user || null, updatedAt: Date.now() };
      changed = true;
    }
  }
  if(changed){
    saveCounts();
    renderAll();
  }
}



function clearAll(){
  counts = {};
  saveStorage();
  toast("Contagens zeradas.");
  renderAll();
}

function clearOne(key){
  if(!key) return;
  delete counts[key];
  saveStorage();
  toast("Contagem removida deste item.");
  renderAll();
  if(selectedKey === key) renderDetail(findByKey(key));
}

function findByKey(key){
  return produtos.find(p => p._key === key) || null;
}

function filteredProdutos(){
  const q = normalizeSearch($("searchInput").value);
  if(!q) return produtos;
  return produtos.filter(p=>{
    const hay = normalizeSearch([p.codigoProduto, p.codigoAcesso, p.produto].join(" "));
    return hay.includes(q);
  });
}

function renderTable(){
  const tbody = $("productsTbody");
  const rows = filteredProdutos();
  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Nenhum item encontrado.</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for(const p of rows){
    const m = computeRowMetrics(p);
    const tr = document.createElement("tr");
    tr.dataset.key = p._key;
    if(p._key === selectedKey) tr.classList.add("selected");

    tr.innerHTML = `
      <td class="mono">${escapeHtml(p.codigoProduto || "")}</td>
      <td>${escapeHtml(p.produto || "")}</td>
      <td class="num">${formatInt(p.qtdSistema)}</td>
      <td class="num">${m.hasCount ? formatInt(m.counted) : "—"}</td>
      <td class="num">${m.hasCount ? formatInt(m.diff) : "—"}</td>
    `;
    tr.addEventListener("click", ()=>{
      selectedKey = p._key;
      renderTable();
      renderDetail(p);
    });
    frag.appendChild(tr);
  }
  tbody.innerHTML = "";
  tbody.appendChild(frag);
}

function statusBadgeClass(status){
  if(status === "OK") return "ok";
  if(status === "DIVERGÊNCIA") return "div";
  return "miss";
}

function renderDetail(p){
  if(!p){
    $("detailTitle").textContent = "Selecione um produto";
    $("detailSub").textContent = "Use a busca para localizar rapidamente.";
    $("detailBadge").textContent = "—";
    $("detailBadge").className = "badge";
    $("detailCodigo").textContent = "—";
    $("detailAcesso").textContent = "—";
    $("detailSistema").textContent = "—";
    $("detailDias").textContent = "—";
    $("detailCusto").textContent = "—";
    $("detailImpacto").textContent = "—";
    $("countInput").value = "";
    return;
  }

  const m = computeRowMetrics(p);

  $("detailTitle").textContent = p.produto || "—";
  $("detailSub").textContent = "Atualize a quantidade física e salve.";
  $("detailCodigo").textContent = p.codigoProduto || "—";
  $("detailAcesso").textContent = p.codigoAcesso || "—";
  $("detailSistema").textContent = formatInt(p.qtdSistema);
  $("detailDias").textContent = (p.diasUltEntrada ?? "—").toString();
  $("detailCusto").textContent = formatMoney(p.custo);
  $("detailImpacto").textContent = m.hasCount ? formatMoney(m.impacto) : "—";

  $("detailBadge").textContent = m.status;
  $("detailBadge").className = "badge " + statusBadgeClass(m.status);

  $("countInput").value = m.hasCount ? String(m.counted) : "";
}

function computeTotals(){
  let total = produtos.length;
  let counted = 0, missing = 0, ok = 0, div = 0;
  let net = 0, abs = 0;

  for(const p of produtos){
    const m = computeRowMetrics(p);
    if(!m.hasCount){ missing++; continue; }
    counted++;
    if(m.diff === 0) ok++;
    else div++;
    net += (m.impacto || 0);
    abs += Math.abs(m.impacto || 0);
  }
  return { total, counted, missing, ok, div, net, abs };
}

function renderChips(){
  const t = computeTotals();
  $("chipTotal").textContent = `Total: ${t.total}`;
  $("chipCounted").textContent = `Contados: ${t.counted}`;
  $("chipMissing").textContent = `Faltando: ${t.missing}`;
}

function renderProgressTable(){
  const tbody = $("progressTbody");
  if(produtos.length === 0){
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Sem dados.</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for(const p of produtos){
    const cat = classifyRow(p);
    if(!matchFilter(cat, progressFilter)) continue;
    const m = computeRowMetrics(p);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(p.codigoProduto || "")}</td>
      <td>${escapeHtml(p.produto || "")}</td>
      <td class="num">${formatInt(p.qtdSistema)}</td>
      <td class="num">${m.hasCount ? formatInt(m.counted) : "—"}</td>
      <td class="num">${m.hasCount ? formatInt(m.diff) : "—"}</td>
      <td class="num">${m.hasCount ? formatMoney(m.impacto) : "—"}</td>
      <td>${m.status}</td>
    `;
    tr.addEventListener("click", ()=>{
      selectedKey = p._key;
      switchTab("contagem");
      renderTable();
      renderDetail(p);
      window.scrollTo({top:0, behavior:"smooth"});
    });
    frag.appendChild(tr);
  }
  tbody.innerHTML = "";
  tbody.appendChild(frag);

  const totals = computeTotals();
  $("kpiTotal").textContent = totals.total;
  $("kpiCounted").textContent = totals.counted;
  $("kpiOk").textContent = totals.ok;
  $("kpiDiv").textContent = totals.div;

  $("moneyNet").textContent = formatMoney(totals.net);
  $("moneyAbs").textContent = formatMoney(totals.abs);
}

function renderDivTableAndChart(){
  const tbody = $("divTbody");

  const diverg = [];
  for(const p of produtos){
    const m = computeRowMetrics(p);
    const cat = classifyRow(p);
    if(!matchFilter(cat, divFilter)) continue;

    if(!m.hasCount) continue;

    if(divFilter === "ok"){
      if(m.diff === 0){
        diverg.push({ p, diff:m.diff, impacto:m.impacto, abs:0 });
      }
    }else if(divFilter === "all" || divFilter === "div" || divFilter === "over" || divFilter === "under"){
      if(m.diff !== 0){
        diverg.push({ p, diff:m.diff, impacto:m.impacto, abs:Math.abs(m.impacto||0) });
      }
    }
  }
  diverg.sort((a,b)=> b.abs - a.abs);

  if(diverg.length === 0){
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Sem divergências.</td></tr>`;
  }else{
    const frag = document.createDocumentFragment();
    for(const d of diverg){
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${escapeHtml(d.p.codigoProduto || "")}</td>
        <td>${escapeHtml(d.p.produto || "")}</td>
        <td class="num">${formatInt(d.diff)}</td>
        <td class="num">${formatMoney(d.impacto)}</td>
      `;
      tr.addEventListener("click", ()=>{
        selectedKey = d.p._key;
        switchTab("contagem");
        renderTable();
        renderDetail(d.p);
        window.scrollTo({top:0, behavior:"smooth"});
      });
      frag.appendChild(tr);
    }
    tbody.innerHTML = "";
    tbody.appendChild(frag);
  }

  // Top 10 chart
  const top = diverg.slice(0,10);
  const labels = top.map(x => (x.p.codigoProduto || "—") + " • " + (x.p.produto || "").slice(0,22));
  const values = top.map(x => x.abs);

  const ctx = $("chartTopDiv").getContext("2d");
  if(topDivChart) topDivChart.destroy();
  topDivChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: "Valor absoluto (R$)", data: values }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c)=> formatMoney(c.parsed.y)
          }
        }
      },
      scales: {
        y: {
          ticks: {
            callback: (v)=> Number(v).toLocaleString("pt-BR")
          }
        }
      }
    }
  });
}

function renderStatusChart(){
  const totals = computeTotals();
  const ok = totals.ok;
  const div = totals.div;
  const miss = totals.missing;

  const ctx = $("chartStatus").getContext("2d");
  if(statusChart) statusChart.destroy();
  statusChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["OK", "Divergência", "Faltando"],
      datasets: [{ data: [ok, div, miss] }]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } }
    }
  });
}


let breakTypeChart = null;
let topImpactChart = null;

function renderDashboard(){
  if(!$("kpiAccuracy")) return;
  const totals = computeTotals();
  const accuracy = totals.counted ? Math.round((totals.ok / totals.counted) * 100) : 0;

  $("kpiAccuracy").textContent = (totals.counted ? `${accuracy}%` : "—");
  $("kpiNetBreak").textContent = formatMoney(totals.net);
  $("kpiAbsBreak").textContent = formatMoney(totals.abs);
  $("kpiProd").textContent = (totals.counted ? `${totals.counted} itens contados` : "—");

  let sobraAbs = 0, faltaAbs = 0;
  const impacts = [];
  const userStats = {};

  for(const p of produtos){
    const m = computeRowMetrics(p);
    if(!m.hasCount) continue;

    const u = countsByKey[p._key]?.user || "—";
    userStats[u] = userStats[u] || { items:0, div:0, abs:0 };
    userStats[u].items += 1;

    if(m.diff !== 0){
      userStats[u].div += 1;
      userStats[u].abs += Math.abs(m.impacto || 0);
      if(m.diff > 0) sobraAbs += Math.abs(m.impacto || 0);
      else faltaAbs += Math.abs(m.impacto || 0);
      impacts.push({ label: p.produto || p.codigoProduto || p._key, value: Math.abs(m.impacto || 0) });
    }
  }

  impacts.sort((a,b)=> b.value - a.value);
  const top = impacts.slice(0,20);

  const ctx1 = document.getElementById("breakTypeChart");
  if(ctx1){
    const data = { labels:["Sobra (R$)","Falta (R$)"], datasets:[{ data:[sobraAbs, faltaAbs] }] };
    if(breakTypeChart) breakTypeChart.destroy();
    breakTypeChart = new Chart(ctx1, { type:"doughnut", data, options:{ responsive:true, plugins:{ legend:{ position:"bottom" } } } });
  }

  const ctx2 = document.getElementById("topImpactChart");
  if(ctx2){
    const data = { labels: top.map(x=> x.label.length>22 ? x.label.slice(0,22)+"…" : x.label), datasets:[{ data: top.map(x=> x.value) }] };
    if(topImpactChart) topImpactChart.destroy();
    topImpactChart = new Chart(ctx2, { type:"bar", data, options:{ responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } } });
  }

  const tbody = $("userStatsBody");
  if(tbody){
    tbody.innerHTML = "";
    const entries = Object.entries(userStats).sort((a,b)=> b[1].items - a[1].items);
    for(const [u,s] of entries){
      const tr=document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(u)}</td><td class="num">${s.items}</td><td class="num">${s.div}</td><td class="num">${formatMoney(s.abs)}</td>`;
      tbody.appendChild(tr);
    }
    if(!entries.length){
      const tr=document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="muted">Sem dados ainda.</td>`;
      tbody.appendChild(tr);
    }
  }
}


function renderAll(){
  renderChips();
  renderTable();
  renderProgressTable();
  renderStatusChart();
  renderDivTableAndChart();
  renderDashboard();
}

function escapeHtml(str){
  return (str ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function switchTab(name){
  document.querySelectorAll(".tab").forEach(b=>{
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tabpanel").forEach(p=>{
    p.classList.toggle("active", p.id === "tab-" + name);
  });
}

function wireTabs(){
  document.querySelectorAll(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=> switchTab(btn.dataset.tab));
  });
}

function wireActions(){
  $("searchInput").addEventListener("input", ()=>{
    renderTable();
  });


  const pf = $("progressFilter");
  if(pf){
    pf.addEventListener("change", ()=>{
      progressFilter = pf.value;
      renderProgressTable();
    });
  }

  document.querySelectorAll("[data-divfilter]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll("[data-divfilter]").forEach(b=> b.classList.toggle("active", b === btn));
      divFilter = btn.dataset.divfilter;
      renderDivTableAndChart();
    });
  });

  $("btnSave").addEventListener("click", ()=>{
    if(!selectedKey) return toast("Selecione um produto.");
    const p = findByKey(selectedKey);
    if(!p) return toast("Produto não encontrado.");

    const val = $("countInput").value;
    if(norm(val) === ""){
      return toast("Digite a quantidade contada.");
    }
    const n = parsePtNumber(val);
    if(!Number.isFinite(n)){
      return toast("Quantidade inválida.");
    }
    counts[selectedKey] = { counted: Math.round(n) };
    saveStorage();
    toast("Contagem salva.");
    renderAll();
    renderDetail(p);
  });

  $("btnClearOne").addEventListener("click", ()=>{
    if(!selectedKey) return toast("Selecione um produto.");
    clearOne(selectedKey);
  });

  $("btnReset").addEventListener("click", ()=>{
    const ok = confirm("Tem certeza que deseja zerar todas as contagens deste dispositivo?");
    if(ok) clearAll();
  });

  $("btnExport").addEventListener("click", exportCounts);


  // Campos de cabeçalho do relatório (salvos no dispositivo)
  const unidadeEl = $("metaUnidade");
  const respEl = $("metaResponsavel");
  const uiMeta = loadUiMeta();
  if(unidadeEl) unidadeEl.value = uiMeta.unidade || "";
  if(respEl) respEl.value = uiMeta.responsavel || "";
  const persistUiMeta = ()=>{
    saveUiMeta({
      unidade: unidadeEl ? unidadeEl.value : "",
      responsavel: respEl ? respEl.value : ""
    });
  };
  if(unidadeEl) unidadeEl.addEventListener("input", persistUiMeta);
  if(respEl) respEl.addEventListener("input", persistUiMeta);

  const btnPdf = $("btnPdf");
  if(btnPdf) btnPdf.addEventListener("click", ()=>{
    const opt = prompt(
`Relatório PDF — escolha um modo:

1 = Resumo (curto)
2 = Divergências (todas)
3 = Sobra (Físico > Sistema)
4 = Falta (Sistema > Físico)
5 = Completo (Resumo + Divergências + Sobra + Falta + Analítico)

Digite 1,2,3,4 ou 5:`
    );
    if(opt === null) return;
    gerarRelatorioPdf(String(opt).trim());
  });

  $("csvFile").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if(!file) return;
    const text = await file.text();
    parseAndLoadCsv(text, { sourceName: file.name });
  });
}

function exportCounts(){
  if(produtos.length === 0){
    toast("Nada para exportar.");
    return;
  }
  const header = ["Código Produto","Código Acesso","Produto","Qtd Sistema","Qtd Contada","Dif (Contado-Sistema)","Custo Liq. Unitário","Impacto (R$)","Status"];
  const lines = [header.join(";")];

  for(const p of produtos){
    const m = computeRowMetrics(p);
    const row = [
      (p.codigoProduto||""),
      (p.codigoAcesso||""),
      (p.produto||""),
      p.qtdSistema,
      (m.hasCount ? m.counted : ""),
      (m.hasCount ? m.diff : ""),
      p.custo.toString().replace(".", ","),
      (m.hasCount ? (m.impacto ?? 0).toString().replace(".", ",") : ""),
      m.status
    ];
    lines.push(row.map(v => (v ?? "").toString().includes(";") ? `"${(v ?? "").toString().replaceAll('"','""')}"` : (v ?? "")).join(";"));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "inventario_contagens_export.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Exportação gerada.");
}

function maybeWarnMetaMismatch(meta){
  const prev = getMeta();
  if(!prev) return;
  if(prev.signature && meta.signature && prev.signature !== meta.signature){
    toast("Atenção: CSV diferente do anterior. As contagens salvas podem não bater.");
  }
}

function signatureForText(text){
  // simple lightweight signature
  let h = 0;
  for(let i=0; i<Math.min(text.length, 200000); i++){
    h = ((h<<5)-h) + text.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

function parseAndLoadCsv(csvText, { sourceName } = {}){
  const sig = signatureForText(csvText);
  maybeWarnMetaMismatch({ signature: sig });

  Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    delimiter: ";",
    complete: (res)=>{
      const rows = res.data || [];
      const parsed = [];

      for(const r of rows){
        const codigoProduto = norm(r["Código Produto"]);
        const produto = norm(r["Produto"]);
        // ignore totals / invalid lines
        if(!produto) continue;
        if(produto.toUpperCase().startsWith("TOTAL")) continue;

        const qtdSistema = parsePtNumber(r["Quantidade em Estoque"]);
        const codigoAcesso = norm(r["Código Acesso"]);
        const diasUltEntrada = norm(r["Dias Ult. Entrada"]);
        const custo = parsePtNumber((r["Custo Liq. Unitário"] ?? r["Valor Custo Bruto"]));

        const item = {
          codigoProduto,
          produto,
          qtdSistema: Math.round(qtdSistema),
          codigoAcesso,
          diasUltEntrada,
          custo: custo || 0
        };
        item._key = codeKey(item);
        parsed.push(item);
      }

      produtos = parsed;
      // If current selection key doesn't exist, clear
      if(selectedKey && !findByKey(selectedKey)) selectedKey = null;

      setMeta({ sourceName: sourceName || "CSV", signature: sig, loadedAt: new Date().toISOString(), total: produtos.length });
      toast(`CSV carregado: ${produtos.length} itens.`);
      renderAll();
      renderDetail(selectedKey ? findByKey(selectedKey) : null);
    },
    error: (err)=>{
      console.error(err);
      toast("Falha ao ler CSV.");
    }
  });
}

async function tryAutoLoad(){
  // If hosted with estoque.csv in same folder, load automatically
  try{
    const resp = await fetch("estoque.csv", { cache: "no-store" });
    if(!resp.ok) throw new Error("no csv");
    const text = await resp.text();
    parseAndLoadCsv(text, { sourceName: "estoque.csv" });
  }catch(e){
    $("productsTbody").innerHTML = `<tr><td colspan="5" class="muted">Carregue o CSV pelo botão “Carregar CSV”.</td></tr>`;
  }
}


/* ========== Leitor de Código (Câmera) ========== */
let scanStream = null;
let scanActive = false;

function openScanModal(){
  const modal = $("scanModal");
  if(!modal) return toast("Scanner indisponível.");
  modal.classList.add("show");
  modal.setAttribute("aria-hidden","false");
  startScanner();
}

function closeScanModal(){
  const modal = $("scanModal");
  if(!modal) return;
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden","true");
  stopScanner();
}

function setScanHint(msg){
  const el = $("scanHint");
  if(el) el.textContent = msg;
}

function stopScanner(){
  scanActive = false;
  try{
    if(window.Quagga && Quagga.initialized){
      Quagga.stop();
      Quagga.initialized = false;
    }
  }catch(e){}
  if(scanStream){
    for(const t of scanStream.getTracks()) t.stop();
  }
  scanStream = null;
  const v = $("scanVideo");
  if(v) v.srcObject = null;
}

function applyScannedCode(code){
  const s = norm(code);
  if(!s) return;

  $("searchInput").value = s;
  renderTable();

  const found = produtos.find(p => norm(p.codigoAcesso) === s || norm(p.codigoProduto) === s) ||
                filteredProdutos()[0] || null;

  if(found){
    selectedKey = found._key;
    renderTable();
    renderDetail(found);
    toast("Código detectado: " + s);

    if(collectorMode){
      const prev = countsByKey[selectedKey]?.counted;
      const next = (Number.isFinite(prev) ? prev : 0) + 1;
      countsByKey[selectedKey] = { counted: next, user: getCurrentUser(), updatedAt: Date.now() };
      saveCounts();
      fbSaveForKey(selectedKey);
      renderDetail(found);
      renderAll();
    }
  }else{
    toast("Código detectado, mas nenhum item encontrado.");
  }
  closeScanModal();
}

async function startScanner(){
  if(scanActive) return;
  scanActive = true;

  const video = $("scanVideo");
  if(!video){
    setScanHint("Elemento de vídeo não encontrado.");
    return;
  }

  const hasBarcodeDetector = ("BarcodeDetector" in window);
  if(hasBarcodeDetector){
    try{
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });
      video.srcObject = scanStream;
      await video.play();
      setScanHint("Procurando código…");

      const detector = new BarcodeDetector({ formats: ["ean_13","ean_8","code_128","upc_a","upc_e"] });

      const loop = async ()=>{
        if(!scanActive) return;
        try{
          const barcodes = await detector.detect(video);
          if(barcodes && barcodes.length){
            const raw = barcodes[0].rawValue;
            if(raw) applyScannedCode(raw);
            return;
          }
        }catch(e){}
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      return;
    }catch(e){
      console.warn(e);
      // fallback abaixo
    }
  }

  // Fallback Quagga
  try{
    setScanHint("Inicializando leitor…");
    let host = document.getElementById("quaggaHost");
    if(!host){
      host = document.createElement("div");
      host.id = "quaggaHost";
      host.style.width = "100%";
      host.style.borderRadius = "14px";
      host.style.overflow = "hidden";
      host.style.border = "1px solid rgba(255,255,255,.08)";
      host.style.background = "rgba(0,0,0,.25)";
      video.replaceWith(host);

      const newVideo = document.createElement("video");
      newVideo.id = "scanVideo";
      newVideo.playsInline = true;
      newVideo.style.display = "none";
      host.parentElement.insertBefore(newVideo, host.nextSibling);
    }

    Quagga.init({
      inputStream: {
        type: "LiveStream",
        target: host,
        constraints: { facingMode: "environment" }
      },
      locator: { patchSize: "medium", halfSample: true },
      numOfWorkers: navigator.hardwareConcurrency ? Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1)) : 2,
      decoder: { readers: ["ean_reader","ean_8_reader","code_128_reader","upc_reader","upc_e_reader"] },
      locate: true
    }, function(err){
      if(err){
        console.error(err);
        setScanHint("Não foi possível iniciar a câmera.");
        return;
      }
      Quagga.start();
      Quagga.initialized = true;
      setScanHint("Aponte para o código…");
    });

    Quagga.onDetected((data)=>{
      const code = data?.codeResult?.code;
      if(code) applyScannedCode(code);
    });
  }catch(e){
    console.error(e);
    setScanHint("Scanner indisponível neste navegador.");
  }
}

/* ========== Relatório PDF (jsPDF) ========== */

function gerarRelatorioPdf(mode="1"){
  mode = String(mode ?? "1").trim();
  if(!produtos.length){
    toast("Carregue o CSV antes de gerar o PDF.");
    return;
  }
  if(!window.jspdf || !window.jspdf.jsPDF){
    toast("Biblioteca de PDF não carregou.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4" });

  const now = new Date();
  const meta = getMeta() || {};
  const uiMeta = (typeof loadUiMeta === "function") ? (loadUiMeta() || {}) : {};
  const totals = computeTotals();

  const unidade = (uiMeta.unidade || "").trim();
  const responsavel = (uiMeta.responsavel || "").trim();

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const headerTextLeft = unidade ? `Unidade: ${unidade}` : "Unidade: —";
  const headerTextRight = responsavel ? `Responsável: ${responsavel}` : "Responsável: —";

  const drawHeaderFooter = ()=>{
    const pageNumber = doc.internal.getNumberOfPages();

    doc.setFont("helvetica","normal");
    doc.setFontSize(9);
    doc.text(headerTextLeft, 40, 24);
    const rightWidth = doc.getTextWidth(headerTextRight);
    doc.text(headerTextRight, pageW - 40 - rightWidth, 24);

    const dt = now.toLocaleString("pt-BR");
    doc.setFontSize(8);
    doc.text(`Gerado em: ${dt}`, 40, 36);

    doc.setFontSize(8);
    const footer = `Página ${pageNumber}`;
    const fw = doc.getTextWidth(footer);
    doc.text(footer, pageW - 40 - fw, pageH - 20);
    doc.text("Inventário de Estoque", 40, pageH - 20);
  };

  const autoTableBase = {
    margin: { top: 50, left: 40, right: 40 },
    didDrawPage: drawHeaderFooter,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 40, 60] }
  };

  const makeDivergData = ()=>{
    const rows = [];
    for(const p of produtos){
      const m = computeRowMetrics(p);
      if(!m.hasCount) continue;
      if(m.diff === 0) continue;
      rows.push({
        codigo: p.codigoProduto || "",
        acesso: p.codigoAcesso || "",
        produto: p.produto || "",
        sistema: p.qtdSistema,
        contado: m.counted,
        diff: m.diff,
        custo: p.custo,
        impacto: m.impacto,
        abs: Math.abs(m.impacto || 0)
      });
    }
    rows.sort((a,b)=> b.abs - a.abs);
    return rows;
  };

  const diverg = makeDivergData();
  const sobra = diverg.filter(d=> d.diff > 0);
  const falta = diverg.filter(d=> d.diff < 0);

  // --- Capa / Título ---
  drawHeaderFooter();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Relatório de Inventário", 40, 64);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Arquivo: ${meta.sourceName || "CSV"} • Gerado em: ${now.toLocaleString("pt-BR")}`, 40, 82);

  // --- Resumo (sempre) ---
  doc.setFont("helvetica","bold");
  doc.setFontSize(11);
  doc.text("Resumo", 40, 108);

  const kpiRows = [
    ["Total de itens", String(totals.total)],
    ["Contados", String(totals.counted)],
    ["Faltando", String(totals.missing)],
    ["OK (sem divergência)", String(totals.ok)],
    ["Com divergência", String(totals.div)],
    ["Impacto líquido (R$)", formatMoney(totals.net)],
    ["Impacto absoluto (R$)", formatMoney(totals.abs)],
  ];

  doc.autoTable({
    ...autoTableBase,
    startY: 118,
    head: [["Indicador", "Valor"]],
    body: kpiRows,
    styles: { fontSize: 9 }
  });

  let y = doc.lastAutoTable.finalY + 18;

  const addDivergTable = (title, data)=>{
    doc.setFont("helvetica","bold");
    doc.setFontSize(11);
    doc.text(title, 40, y);
    y += 10;

    const body = data.map(d => [
      d.codigo,
      d.acesso,
      (d.produto.length>46 ? d.produto.slice(0,46)+"…" : d.produto),
      String(d.diff),
      formatMoney(d.impacto || 0)
    ]);

    doc.autoTable({
      ...autoTableBase,
      startY: y,
      head: [["Código", "EAN/Acesso", "Produto", "Dif.", "Impacto (R$)"]],
      body: body.length ? body : [["—","—","Sem dados","—","—"]],
      columnStyles: { 3: { halign:"right" }, 4: { halign:"right" } }
    });

    y = doc.lastAutoTable.finalY + 18;
  };

  // --- Modo 1: só resumo ---
  if(mode === "1"){
    // segue para assinaturas
  }

  // --- Modo 2: divergências (todas) ---
  if(mode === "2"){
    addDivergTable("Divergências — todas (por valor absoluto)", diverg);
  }

  // --- Modo 3: sobra (todas) ---
  if(mode === "3"){
    addDivergTable("Sobra (Físico > Sistema) — todas", sobra);
  }

  // --- Modo 4: falta (todas) ---
  if(mode === "4"){
    addDivergTable("Falta (Sistema > Físico) — todas", falta);
  }

  // --- Modo 5: completo ---
  if(mode === "5"){
    addDivergTable("Divergências — todas (por valor absoluto)", diverg);
    addDivergTable("Sobra (Físico > Sistema) — todas", sobra);
    addDivergTable("Falta (Sistema > Físico) — todas", falta);

    doc.addPage();
    y = 60;

    doc.setFont("helvetica","bold");
    doc.setFontSize(12);
    doc.text("Listagem analítica (itens contados)", 40, 48);

    const allCounted = [];
    for(const p of produtos){
      const m = computeRowMetrics(p);
      if(!m.hasCount) continue;
      allCounted.push({
        codigo: p.codigoProduto || "",
        acesso: p.codigoAcesso || "",
        produto: p.produto || "",
        sistema: p.qtdSistema,
        contado: m.counted,
        diff: m.diff,
        impacto: m.impacto
      });
    }
    allCounted.sort((a,b)=> Math.abs(b.impacto||0) - Math.abs(a.impacto||0));

    const body = allCounted.map(d => [
      d.codigo,
      d.acesso,
      (d.produto.length>40 ? d.produto.slice(0,40)+"…" : d.produto),
      String(d.sistema),
      String(d.contado),
      String(d.diff),
      formatMoney(d.impacto || 0)
    ]);

    doc.autoTable({
      ...autoTableBase,
      startY: 60,
      head: [["Código","EAN/Acesso","Produto","Sistema","Contado","Dif.","Impacto (R$)"]],
      body: body.length ? body : [["—","—","Sem dados","—","—","—","—"]],
      columnStyles: { 3:{halign:"right"},4:{halign:"right"},5:{halign:"right"},6:{halign:"right"} },
      styles: { fontSize: 7 }
    });

    doc.setFont("helvetica","normal");
    doc.setFontSize(9);
    doc.text("Obs.: listagem completa de itens contados (ordenada pelo impacto absoluto).", 40, 800);
  }

  // --- Assinaturas (última página) ---
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const ySig = ph - 90;

  doc.setFont("helvetica","normal");
  doc.setFontSize(10);
  doc.text("Assinaturas", 40, ySig);

  doc.setDrawColor(200);
  doc.line(40, ySig + 22, pw/2 - 20, ySig + 22);
  doc.line(pw/2 + 20, ySig + 22, pw - 40, ySig + 22);

  doc.setFontSize(9);
  doc.text("Responsável pela contagem", 40, ySig + 38);
  doc.text("Conferência / Auditoria", pw/2 + 20, ySig + 38);

  doc.text("Data: ____/____/____", 40, ySig + 56);
  doc.text("Data: ____/____/____", pw/2 + 20, ySig + 56);

  const fname = `relatorio_inventario_${now.toISOString().slice(0,10)}.pdf`;
  doc.save(fname);
  toast("PDF gerado.");
}



function init(){

  document.body.classList.add("locked");

  wireTabs();
  wireActions();
  loadStorage();
  tryAutoLoad();
  renderDetail(null);
  renderChips();

  // Modo coletor (persistido)
  setCollectorMode(getCollectorMode());
  const tgl = $("toggleCollector");
  if(tgl){
    tgl.checked = collectorMode;
    tgl.addEventListener("change", ()=> setCollectorMode(tgl.checked));
  }

  // Login simples (usuário) — bloqueia o app até entrar
  const overlay = $("loginOverlay");
  const loginInput = $("loginUser");
  const btnLogin = $("btnLogin");
  if(loginInput){
    loginInput.value = localStorage.getItem(STORAGE_USER_KEY) || "";
    loginInput.focus();
  }

  const doLogin = ()=>{
    const u = (loginInput ? loginInput.value : "").trim();
    if(!u){ toast("Digite um usuário."); return; }
    setCurrentUser(u);

    // inicializa sessão no Firebase (por data + unidade)
    try{
      const uiMeta = loadUiMeta();
      const meta = getMeta() || {};
      const merged = { unidade: uiMeta.unidade || "", responsavel: uiMeta.responsavel || "", sourceName: meta.sourceName || "" };
      if(window.FB && FB.fbInit) FB.fbInit(merged);
      if(window.FB && FB.fbListenCounts) FB.fbListenCounts(applyRemoteCounts);
      if(window.FB && FB.fbLogEvent) FB.fbLogEvent("login", { user: u });
    }catch(e){ console.warn(e); }

    if(overlay) overlay.classList.add("hidden");
    document.body.classList.remove("locked");
    renderAll();
  };

  if(btnLogin) btnLogin.addEventListener("click", doLogin);
  if(loginInput) loginInput.addEventListener("keydown", (e)=>{ if(e.key === "Enter") doLogin(); });

}

document.addEventListener("DOMContentLoaded", init);
