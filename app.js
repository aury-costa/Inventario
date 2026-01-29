/* Inventário de Estoque - app.js
   - Lê CSV (PapaParse) via upload ou fetch local (estoque.csv)
   - Salva contagens no localStorage
   - Mostra progresso, divergências e gráficos (Chart.js)
*/

const STORAGE_KEY = "inventario_counts_v1";
const STORAGE_META_KEY = "inventario_meta_v1";

let produtos = [];         // base (CSV)
let counts = {};           // { codigoKey: { counted:number } }
let selectedKey = null;
let statusChart = null;
let topDivChart = null;

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
    if(m.hasCount && m.diff !== 0){
      diverg.push({ p, diff:m.diff, impacto:m.impacto, abs:Math.abs(m.impacto||0) });
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

function renderAll(){
  renderChips();
  renderTable();
  renderProgressTable();
  renderStatusChart();
  renderDivTableAndChart();
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
  const header = ["Código Produto","Código Acesso","Produto","Qtd Sistema","Qtd Contada","Dif (Contado-Sistema)","Custo Bruto","Impacto (R$)","Status"];
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
        const custo = parsePtNumber(
  r["Custo Liq. Unitário"] ?? r["Valor Custo Bruto"]
);

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

function init(){
  wireTabs();
  wireActions();
  loadStorage();
  tryAutoLoad();
  renderDetail(null);
  renderChips();
}

document.addEventListener("DOMContentLoaded", init);
