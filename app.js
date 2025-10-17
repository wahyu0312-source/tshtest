/* =========================================================
 * app.js — Tokyo Seimitsu ERP (Frontend) — CORS-proof (fixed)
 * ========================================================= */

/* ===== Config (API dinamis) ===== */
const DEFAULT_API = "https://script.google.com/macros/s/AKfycbyqIp-Y5xuWH6FXXqZCgqL4BFwuPfFQ_YW6KWvXpJo1-eA9zB3Uhs_p9hcjUryR8Q2w/exec";
function resolveApiBase(){
  const ls = (localStorage.getItem('API_BASE')||'').trim();
  return ls || DEFAULT_API;
}
Object.defineProperty(window, 'API_BASE', { get: resolveApiBase });

const API_KEY = ""; // biarkan kosong agar tidak memicu preflight

/* ===== Processes ===== */
const PROCESSES = [
  'レザー加工','曲げ加工','外枠組立','シャッター組立','シャッター溶接','コーキング',
  '外枠塗装','組立（組立中）','組立（組立済）','外注','検査工程'
];

/* ===== Station rules ===== */
const STATION_RULES = {
  'レザー加工': (o)=> ({ current_process:'レザー加工' }),
  '曲げ工程': (o)=> ({ current_process:'曲げ加工' }), // alias
  '曲げ加工': (o)=> ({ current_process:'曲げ加工' }),
  '外枠組立': (o)=> ({ current_process:'外枠組立' }),
  'シャッター組立': (o)=> ({ current_process:'シャッター組立' }),
  'シャッター溶接': (o)=> ({ current_process:'シャッター溶接' }),
  'コーキング': (o)=> ({ current_process:'コーキング' }),
  '外枠塗装': (o)=> ({ current_process:'外枠塗装' }),
  '組立工程': (o)=> (o.current_process==='組立（組立中）' ? { current_process:'組立（組立済）' } : { current_process:'組立（組立中）' }),
  '検査工程': (o)=> (o.current_process==='検査工程' && !['検査保留','不良品（要リペア）','検査済'].includes(o.status) ? { current_process:'検査工程', status:'検査済' } : { current_process:'検査工程' }),
  '出荷工程': (o)=> (o.status==='出荷準備' ? { current_process:o.current_process||'検査工程', status:'出荷済' } : { current_process:'検査工程', status:'出荷準備' })
};

/* ===== Shortcuts ===== */
const $ = (s)=> document.querySelector(s);
const fmtDT= (s)=> s? new Date(s).toLocaleString(): '';
const fmtD = (s)=> s? new Date(s).toLocaleDateString(): '';
let SESSION=null, CURRENT_PO=null, scanStream=null, scanTimer=null;
let INV_PREVIEW={info:null, lines:[]};

/* ===== Visual mapping ===== */
const STATUS_CLASS = {
  '生産開始':'st-begin',
  '検査工程':'st-inspect',
  '検査済':'st-inspect',
  '検査保留':'st-hold',
  '出荷準備':'st-ready',
  '出荷済':'st-shipped',
  '不良品（要リペア）':'st-ng'
};
const PROC_CLASS = {
  'レザー加工':'prc-laser','曲げ加工':'prc-bend','外枠組立':'prc-frame','シャッター組立':'prc-shassy',
  'シャッター溶接':'prc-shweld','コーキング':'prc-caulk','外枠塗装':'prc-tosou',
  '組立（組立中）':'prc-asm-in','組立（組立済）':'prc-asm-ok','外注':'prc-out','検査工程':'prc-inspect'
};

/* ===== Service Worker register ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.getRegistration().then(reg=>{
      if(!reg){ navigator.serviceWorker.register('./sw.js').catch(console.warn); }
    });
  });
}

/* ===== SWR Cache (localStorage) ===== */
const SWR = {
  get(key){ try{ const x=localStorage.getItem(key); return x? JSON.parse(x):null;}catch(e){return null;} },
  set(key,val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} },
};

/* ===== API helpers (CORS-safe + JSONP fallback) ===== */
function toQS(obj){ return Object.keys(obj||{}).map(k => encodeURIComponent(k)+'='+encodeURIComponent(obj[k]??'')).join('&'); }
function jsonp(action, params={}){
  return new Promise((resolve, reject)=>{
    const cb = '__jp'+Date.now()+Math.floor(Math.random()*1e6);
    const q = { action, ...params, callback:cb, jsonp:1 };
    const url = resolveApiBase() + '?' + toQS(q);
    const s = document.createElement('script');
    const timer = setTimeout(()=>{ cleanup(); reject(new Error('JSONP timeout')); }, 12000);
    function cleanup(){ clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = function(resp){ cleanup(); if(!resp || resp.ok===false) reject(new Error(resp && resp.error || 'Server error')); else resolve(resp.data); };
    s.onerror = ()=>{ cleanup(); reject(new Error('JSONP network error')); };
    s.src = url; document.head.appendChild(s);
  });
}
// ==== ganti apiPost agar selalu lempar error kalau data null/invalid ====
async function apiPost(action, body){
  const payload = { action, ...(API_KEY?{apiKey:API_KEY}:{}) , ...body };
  try{
    const res = await fetch(resolveApiBase(), {
      method:'POST',
      mode:'cors',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' },
      body: toQS(payload),
      cache:'no-store',
    });
    const txt = await res.text();
    let j; try{ j = JSON.parse(txt); }catch{ throw new Error('Invalid server response'); }
    if (!j || j.ok === false) throw new Error(j?.error || 'API error');
    if (j.data == null || (typeof j.data === 'object' && Object.keys(j.data).length === 0)) {
      throw new Error('Empty server data');
    }
    return j.data;
  }catch(err){
    // fallback JSONP
    console.warn('POST fell back to JSONP:', err);
    const data = await jsonp(action, payload);
    if (data == null) throw new Error('Empty server data');
    return data;
  }
}

// ==== ganti onLogin: validasi input + guard ketika data tidak lengkap ====
async function onLogin(){
  const u = $('#inUser') ? $('#inUser').value.trim() : '';
  const p = $('#inPass') ? $('#inPass').value.trim() : '';
  if(!u || !p){ alert('ユーザー名とパスワードを入力してください'); return; }
  try{
    const r = await apiPost('login', { username:u, password:p });
    // Guard: pastikan properti penting ada
    if (!r || !r.username) throw new Error('ログイン情報が無効です（username 不明）');
    SESSION = {
      username: r.username,
      full_name: r.full_name || r.name || r.username,
      department: r.department || '',
      role: r.role || 'member',
      token: r.token || ''
    };
    localStorage.setItem('erp_session', JSON.stringify(SESSION));
    enter();
  }catch(e){
    alert(e.message || e);
  }
}

// ==== patch kecil di enter(): jangan akses field jika null ====
function enter(){
  const ui = $('#userInfo');
  if (ui && SESSION) {
    const nm = SESSION.full_name || SESSION.username || '';
    const dp = SESSION.department || '';
    ui.textContent = dp ? `${nm}・${dp}` : nm;
  }
  ['btnToDash','btnToSales','btnToPlan','btnToShip','btnToInvPage','btnToFinPage','btnToInvoice','btnToCharts']
    .forEach(id=>{ const el=$('#'+id); if(el) el.classList.remove('hidden'); });
  const dd = $('#ddSetting'); if(dd) dd.classList.remove('hidden');

  if(!(SESSION.role==='admin' || SESSION.department==='生産技術')){
    const miAddUser=$('#miAddUser'); if(miAddUser) miAddUser.classList.add('hidden');
  }
  show('pageDash');
  loadMasters();
  requestIdleCallback(()=> { refreshAll(); populateChubanFromSales(); }, {timeout:1000});
}

async function apiGet(params, {swrKey=null, revalidate=true} = {}){
  const final = {...params, ...(API_KEY?{apiKey:API_KEY}:{})};
  const url=resolveApiBase()+'?'+new URLSearchParams(final).toString();
  const key = swrKey || ('GET:'+url);
  const cached = SWR.get(key);
  if (cached && revalidate){
    fetch(url,{cache:'no-store', mode:'cors'}).then(r=>r.text()).then(txt=>{
      try{ const j=JSON.parse(txt); if(j.ok){ SWR.set(key, j.data); document.dispatchEvent(new CustomEvent('swr:update',{detail:{key}})); } }
      catch{ /* ignore */ }
    }).catch(()=>{ /* ignore */ });
    return cached;
  }
  try{
    const res=await fetch(url,{cache:'no-store', mode:'cors'});
    const txt=await res.text(); const j=JSON.parse(txt);
    if(!j.ok) throw new Error(j.error||'API error');
    SWR.set(key, j.data); return j.data;
  }catch(err){
    console.warn('GET fell back to JSONP:', err);
    const data = await jsonp(final.action || params.action || 'unknown', final);
    SWR.set(key, data); return data;
  }
}
function showApiError(action, err){
  console.error('API FAIL:', action, err);
  let bar=document.getElementById('errbar');
  if(!bar){
    bar=document.createElement('div');
    bar.id='errbar';
    bar.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;background:#fee;border:1px solid #f99;color:#900;padding:10px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.08);z-index:9999';
    document.body.appendChild(bar);
  }
  bar.innerHTML=`<b>APIエラー</b> <code>${action||'-'}</code> — ${err.message||err}`;
}

/* ===== Skeleton helpers ===== */
function tableSkeleton(tbody, rows=7, cols=8){
  if(!tbody) return;
  const frag=document.createDocumentFragment();
  for(let i=0;i<rows;i++){
    const tr=document.createElement('tr');
    for(let c=0;c<cols;c++){
      const td=document.createElement('td');
      td.innerHTML=`<div class="shimmer" style="height:14px;border-radius:6px"></div>`;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.innerHTML=''; tbody.appendChild(frag);
}
function clearSkeleton(tbody){ if(tbody) tbody.innerHTML=''; }
// === Weather with city name (Open-Meteo, no key) ===
async function initWeather(){
  const elPlace = document.getElementById('wxPlace') || document.querySelector('[data-wx="place"]');
  const elTemp  = document.getElementById('wxTemp')  || document.querySelector('[data-wx="temp"]');
  if((!elPlace && !elTemp) || !('geolocation' in navigator)) return;

  function setUI(city, temp){
    if(elPlace) elPlace.textContent = city || '現在地';
    if(elTemp)  elTemp.textContent  = (temp!=null ? Math.round(temp)+'℃' : '--');
  }

  try{
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res, rej, {enableHighAccuracy:true, timeout:8000}));
    const { latitude, longitude } = pos.coords;

    // current temperature
    const wx = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&timezone=auto`).then(r=>r.json());
    const temp = wx && wx.current ? wx.current.temperature_2m : null;

    // reverse geocoding for city name (ja)
    const rev = await fetch(`https://geocoding-api.open-meteo.com/v1/reverse?latitude=${latitude}&longitude=${longitude}&language=ja`).then(r=>r.json());
    const city = (rev && rev.results && rev.results[0]) ? (rev.results[0].name || rev.results[0].admin1 || '現在地') : '現在地';

    setUI(city, temp);
  }catch(e){
    console.warn('weather:', e);
    setUI('現在地', null);
  }
}

/* ===== Boot ===== */
window.addEventListener('DOMContentLoaded', ()=>{
  // routing tombol — tidak meng-unhide; unhide dilakukan saat login di enter()
  const map={
    btnToDash: ()=> show('pageDash'),
    btnToSales: ()=> show('pageSales'),
    btnToPlan: ()=> show('pagePlan'),
    btnToShip: ()=> show('pageShip'),
    btnToInvPage: ()=> { show('pageInventory'); renderInventory(); },
    btnToFinPage: ()=> { show('pageFinished'); renderFinished(); },
    btnToInvoice: ()=> show('pageInvoice'),
    btnToCharts: ()=> { show('pageCharts'); ensureChartsLoaded(); }
      // 注番 source selector (plan)
  initchubanSelector();

  // --- TAMBAHKAN BARIS INI DI SINI ---
  initWeather();
});

  };
  Object.keys(map).forEach(id=>{ const el=$('#'+id); if(el) el.onclick = map[id]; });

  // Settings
  const miStationQR = $('#miStationQR');
  const miAddUser = $('#miAddUser');
  const miChangePass = $('#miChangePass');
  const btnLogoutMenu = $('#btnLogout');
  if(miStationQR) miStationQR.onclick = openStationQR;
  if(miAddUser) miAddUser.onclick = openAddUserModal;
  if(miChangePass) miChangePass.onclick = changePasswordUI;
  if(btnLogoutMenu)btnLogoutMenu.onclick= ()=>{ SESSION=null; localStorage.removeItem('erp_session'); location.reload(); };

  // Auth
  const btnLogin = $('#btnLogin');
  const btnNewUser = $('#btnNewUser');
  if(btnLogin) btnLogin.onclick = onLogin;
  if(btnNewUser) btnNewUser.onclick = addUserFromLoginUI;

  // Dashboard
  const btnRefresh = $('#btnRefresh');
  const searchQ = $('#searchQ');
  const btnExportOrders = $('#btnExportOrders');
  const btnExportShip = $('#btnExportShip');
  if(btnRefresh) btnRefresh.onclick = refreshAll;
  if(searchQ) searchQ.addEventListener('input', debounce(renderOrders, 200));
  if(btnExportOrders) btnExportOrders.onclick = exportOrdersCSV;
  if(btnExportShip) btnExportShip.onclick = exportShipCSV;

  // Sales
  const btnSalesSave = $('#btnSalesSave');
  const btnSalesDelete = $('#btnSalesDelete');
  const btnSalesExport = $('#btnSalesExport');
  const btnPromote = $('#btnPromote');
  const salesQ = $('#salesQ');
  const btnSalesImport = $('#btnSalesImport');
  const fileSales = $('#fileSales');
  if(btnSalesSave) btnSalesSave.onclick = saveSalesUI;
  if(btnSalesDelete) btnSalesDelete.onclick = deleteSalesUI;
  if(btnSalesExport) btnSalesExport.onclick = exportSalesCSV;
  if(btnPromote) btnPromote.onclick = promoteSalesUI;
  if(salesQ) salesQ.addEventListener('input', debounce(renderSales, 200));
  if(btnSalesImport) btnSalesImport.onclick = ()=> fileSales && fileSales.click();
  if(fileSales) fileSales.onchange = (e)=> handleImport(e, 'sales');

  // Plan
  const btnCreateOrder = $('#btnCreateOrder');
  const btnPlanExport = $('#btnPlanExport');
  const btnPlanEdit = $('#btnPlanEdit');
  const btnPlanDelete = $('#btnPlanDelete');
  const btnPlanImport = $('#btnPlanImport');
  const filePlan = $('#filePlan');
  if(btnCreateOrder) btnCreateOrder.onclick = createOrderUI;
  if(btnPlanExport) btnPlanExport.onclick = exportOrdersCSV;
  if(btnPlanEdit) btnPlanEdit.onclick = loadOrderForEdit;
  if(btnPlanDelete) btnPlanDelete.onclick = deleteOrderUI;
  if(btnPlanImport) btnPlanImport.onclick = ()=> filePlan && filePlan.click();
  if(filePlan) filePlan.onchange = (e)=> handleImport(e, 'orders');

  // Ship
  const btnSchedule = $('#btnSchedule');
  const btnShipExport = $('#btnShipExport');
  const btnShipEdit = $('#btnShipEdit');
  const btnShipDelete = $('#btnShipDelete');
  const btnShipByPO = $('#btnShipByPO');
  const btnShipByID = $('#btnShipByID');
  const btnShipImport = $('#btnShipImport');
  const fileShip = $('#fileShip');
  if(btnSchedule) btnSchedule.onclick = scheduleUI;
  if(btnShipExport) btnShipExport.onclick = exportShipCSV;
  if(btnShipEdit) btnShipEdit.onclick = loadShipForEdit;
  if(btnShipDelete) btnShipDelete.onclick = deleteShipUI;
  if(btnShipByPO) btnShipByPO.onclick = ()=>{ const po=$('#s_po').value.trim(); if(!po) return alert('注番入力'); openShipByPO(po); };
  if(btnShipByID) btnShipByID.onclick = ()=>{ const id=prompt('出荷ID:'); if(!id) return; openShipByID(id.trim()); };
  if(btnShipImport) btnShipImport.onclick = ()=> fileShip && fileShip.click();
  if(fileShip) fileShip.onchange = (e)=> handleImport(e, 'ship');

  // Invoice
  const btnInvPreview = $('#btnInvPreview');
  const btnInvCreate = $('#btnInvCreate');
  const btnInvPrint = $('#btnInvPrint');
  const btnInvCSV = $('#btnInvCSV');
  if(btnInvPreview) btnInvPreview.onclick = previewInvoiceUI;
  if(btnInvCreate) btnInvCreate.onclick = createInvoiceUI;
  if(btnInvPrint) btnInvPrint.onclick = ()=> openInvoiceDoc(INV_PREVIEW.inv_id||'');
  if(btnInvCSV) btnInvCSV.onclick = exportInvoiceCSV;

  // Charts
  const btnChartsRefresh = $('#btnChartsRefresh');
  fillChartYearSelector();
  if(btnChartsRefresh) btnChartsRefresh.onclick = renderCharts;

  // Inventory & Finished filters
  const invQ = $('#invQ'); if(invQ) invQ.addEventListener('input', debounce(renderInventory, 200));
  const finQ = $('#finQ'); if(finQ) finQ.addEventListener('input', debounce(renderFinished, 200));

  // Keyboard shortcuts (modal)
  document.addEventListener('keydown', onGlobalShortcut);

  // SWR update listener
  document.addEventListener('swr:update', (ev)=>{
    const key=ev.detail?.key||'';
    if(key.includes('action=listOrders')) renderOrders().catch(console.warn);
    if(key.includes('action=listSales')){ renderSales().catch(console.warn); populateChubanFromSales().catch(console.warn); }
  });

  // Restore session
  const saved=localStorage.getItem('erp_session');
  if(saved){ SESSION=JSON.parse(saved); enter(); } else { show('authView'); }

  // scanner buttons
  const btnScanStart = $('#btnScanStart'); if (btnScanStart) btnScanStart.onclick = ()=> initScan();
  const btnScanClose = $('#btnScanClose'); if(btnScanClose) btnScanClose.onclick=()=>{ stopScan(); $('#dlgScan').close(); };

  // 注番 source selector (plan)
  initChubanSelector();
});

/* ===== Small utils ===== */
/* ===== Small utils ===== */
/* ===== Small utils ===== */
function debounce(fn, ms = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms);
  };
}


function show(id){
  const ids=['authView','pageDash','pageSales','pagePlan','pageShip','pageInvoice','pageCharts','pageInventory','pageFinished'];
  ids.forEach(x=>{ const el=document.getElementById(x); if(el) el.classList.add('hidden'); });
  const target=document.getElementById(id); if(target) target.classList.remove('hidden');

  const map = {
    pageDash:'btnToDash', pageSales:'btnToSales', pagePlan:'btnToPlan', pageShip:'btnToShip',
    pageInventory:'btnToInvPage', pageFinished:'btnToFinPage', pageInvoice:'btnToInvoice', pageCharts:'btnToCharts'
  };
  Object.values(map).forEach(b=>{ const el=document.getElementById(b); if(el) el.style.boxShadow='none'; });
  const activeBtnId = map[id];
  const btn = activeBtnId && document.getElementById(activeBtnId);
  if(btn) btn.style.boxShadow='0 8px 22px rgba(16,24,40,.12)';

  if(id==='pageCharts') ensureChartsLoaded();
}

function onGlobalShortcut(e){
  const dlg=document.querySelector('dialog[open]');
  if(!dlg) return;
  if(e.key.toLowerCase()==='e'){
    const id=dlg.id;
    if(id==='dlgHistory') exportHistoryCSV();
    if(id==='dlgTicket') window.print();
    if(id==='dlgShip') window.print();
  }
  if(e.key.toLowerCase()==='r'){
    const id=dlg.id;
    if(id==='dlgHistory'){
      const inp=dlg.querySelectorAll('input[type="date"]');
      inp.forEach(x=> x.value='');
      const q=dlg.querySelector('input[type="text"]'); if(q) q.value='';
      const list=dlg.querySelector('#histBody'); if(list) list.innerHTML='';
    }
  }
}

/* ===== Enter (unhide navbar setelah login) ===== */
function enter(){
  const ui=$('#userInfo');
  if(ui && SESSION) ui.textContent = `${SESSION.full_name}・${SESSION.department}`;
  ['btnToDash','btnToSales','btnToPlan','btnToShip','btnToInvPage','btnToFinPage','btnToInvoice','btnToCharts'].forEach(id=>{
    const el=$('#'+id); if(el) el.classList.remove('hidden');
  });
  const dd=$('#ddSetting'); if(dd) dd.classList.remove('hidden');
  if(!(SESSION.role==='admin' || SESSION.department==='生産技術')){
    const miAddUser=$('#miAddUser'); if(miAddUser) miAddUser.classList.add('hidden');
  }
  show('pageDash');
  loadMasters();
  requestIdleCallback(()=> { refreshAll(); populateChubanFromSales(); }, {timeout:1000});
}

/* ===== Auth ===== */
async function onLogin(){
  const u=$('#inUser')?$('#inUser').value.trim():'';
  const p=$('#inPass')?$('#inPass').value.trim():'';
  try{
    const r=await apiPost('login',{username:u,password:p});
    SESSION=r; localStorage.setItem('erp_session',JSON.stringify(r));
    enter();
  }catch(e){ alert(e.message||e); }
}
async function addUserFromLoginUI(){
  if(!SESSION) return alert('ログインしてください');
  if(!(SESSION.role==='admin'||SESSION.department==='生産技術')) return alert('権限不足（生産技術）');
  const payload={
    username:$('#nuUser')?$('#nuUser').value.trim():'', password:$('#nuPass')?$('#nuPass').value.trim():'',
    full_name:$('#nuName')?$('#nuName').value.trim():'', department:$('#nuDept')?$('#nuDept').value:'', role:$('#nuRole')?$('#nuRole').value:'member'
  };
  if(!payload.username||!payload.password||!payload.full_name) return alert('必須項目');
  try{ await apiPost('createUser',{user:SESSION,payload}); alert('作成しました'); }
  catch(e){ alert(e.message||e); }
}
async function changePasswordUI(){
  if(!SESSION) return alert('ログインしてください');
  const oldPass=prompt('旧パスワード:'); if(oldPass===null) return;
  const newPass=prompt('新パスワード:'); if(newPass===null) return;
  try{
    await apiPost('changePassword',{user:SESSION,oldPass,newPass});
    alert('変更しました。再ログインしてください。');
    SESSION=null; localStorage.removeItem('erp_session'); location.reload();
  }catch(e){ alert(e.message||e); }
}

/* ===== Masters ===== */
async function loadMasters(){
  try{
    const m = await apiGet({action:'masters', types:'得意先,品名,品番,図番,送り先,運送会社'},{swrKey:'masters'});
    const fill = (sel, arr)=>{ const el=$(sel); if(el) el.innerHTML=(arr||[]).map(v=>`<option value="${v}"></option>`).join(''); };
    fill('#dl_tokui', m['得意先']);
    fill('#dl_hinmei', m['品名']);
    fill('#dl_hinban', m['品番']);
    fill('#dl_zuban', m['図番']);
    fill('#dl_okurisaki', m['送り先']);
    fill('#dl_unso', m['運送会社']);
  }catch(e){ console.warn(e); }
}


/* ===== Dashboard (no charts) ===== */
async function refreshAll(keep=false){
  try{
    const s=await apiGet({action:'stock'},{swrKey:'stock'});
    $('#statFinished').textContent=s.finishedStock;
    $('#statReady').textContent=s.ready;
    $('#statShipped').textContent=s.shipped;

    const listToday=$('#listToday');
    if(listToday) listToday.innerHTML='<div class="shimmer" style="height:16px;border-radius:8px"></div>';
    const today=await apiGet({action:'todayShip'},{swrKey:'todayShip'});
    if(listToday){
      listToday.innerHTML = today.length ? today.map(r=>`<div><span>${r.po_id}</span><span>${fmtD(r.scheduled_date)}・${r.qty}</span></div>`).join('') : '<div class="muted">本日予定なし</div>';
    }

    const grid=$('#gridProc');
    if(grid) grid.innerHTML = PROCESSES.map(()=>`<div class="shimmer" style="height:26px;border-radius:8px"></div>`).join('');
    const loc=await apiGet({action:'locSnapshot'},{swrKey:'locSnapshot'});
    if(grid) grid.innerHTML = PROCESSES.map(p=> `
      <div class="grid-chip" style="font-weight:700;color:#0b3b6a">
        <div class="muted s" style="font-weight:600;color:#475569">${p}</div>
        <div class="h" style="font-size:18px">${loc[p]||0}</div>
      </div>`).join('');

    // OK/NG snapshot (optional)
    try{
      const okng = await apiGet({action:'okNgSnapshot'},{swrKey:'okng'});
      if(grid){
        const html = PROCESSES.map(p=>{
          const count = loc[p]||0;
          const o = okng && okng[p] || {ok:0, ng:0};
          return `
      <div class="grid-chip" style="font-weight:700;color:#0b3b6a">
        <div>
          <div class="muted s" style="font-weight:600;color:#475569">${p}</div>
          <div class="s muted">OK: <b>${o.ok||0}</b> / NG: <b>${o.ng||0}</b></div>
        </div>
        <div class="h" style="font-size:18px">${count}</div>
      </div>`;
        }).join('');
        grid.innerHTML = html;
      }
    }catch(_){}

    if(!keep){ const q=$('#searchQ'); if(q) q.value=''; }
    await renderOrders();
    await renderSales();
  }catch(e){ console.error(e); }
}

/* ===== Orders table ===== */
async function listOrders(){
  const qEl=$('#searchQ'); const q = qEl ? qEl.value.trim() : '';
  return apiGet({action:'listOrders',q},{swrKey:'orders'+(q?':'+q:'')});
}
async function renderOrders(){
  const tbody=$('#tbOrders'); if(!tbody) return;
  tableSkeleton(tbody, 7, 9);
  const rows=await listOrders();
  const frag=document.createDocumentFragment();
  rows.forEach(r=>{
    const tr=document.createElement('tr');
    const statusName = r.status || ''; const procName = r.current_process || '';
    const stClass = STATUS_CLASS[statusName] || 'st-begin'; const prClass = PROC_CLASS[procName] || 'prc-out';

    const leftCell = `
      <div class="row-main">
        <a href="javascript:void(0)" onclick="openTicket('${r.po_id}')" class="link"><b>${r.po_id}</b></a>
        <div class="row-sub">
          <div class="kv"><span class="muted">得意先:</span> <b>${r['得意先']||'-'}</b></div>
          ${r['製番号']?`<div class="kv"><span class="muted">製番号:</span> <b>${r['製番号']}</b></div>`:''}
          ${(r['品番']||r['図番'])?`<div class="kv"><span class="muted">品番/図番:</span> <b>${r['品番']||''}/${r['図番']||''}</b></div>`:''}
        </div>
      </div>`;

    const statusBadge = `<span class="badge ${stClass}"><span class="dot"></span><span>${statusName||'-'}</span></span>`;
    const procBadge = `<span class="badge ${prClass}"><span class="dot"></span><span>${procName||'-'}</span></span>`;

    const actions = `
      <div class="actions-2col">
        <button class="btn ghost s" onclick="openTicket('${r.po_id}')"><i class="fa-regular fa-file-lines"></i> 票</button>
        <button class="btn ghost s" onclick="startScanFor('${r.po_id}')"><i class="fa-solid fa-qrcode"></i> 更新</button>
        <button class="btn ghost s" onclick="openShipByPO('${r.po_id}')"><i class="fa-solid fa-truck"></i> 出荷票</button>
        <button class="btn ghost s" onclick="openHistory('${r.po_id}')"><i class="fa-solid fa-clock-rotate-left"></i> 履歴</button>
      </div>`;

    tr.innerHTML = `
      <td>${leftCell}</td>
      <td>${r['品名']||''}</td>
      <td>${r['品番']||''}</td>
      <td>${r['図番']||''}</td>
      <td class="col-status">${statusBadge}</td>
      <td class="col-proc">${procBadge}</td>
      <td class="s muted">${fmtDT(r.updated_at)}</td>
      <td class="s muted">${r.updated_by||''}</td>
      <td class="s">${actions}</td>
    `;
    frag.appendChild(tr);
  });
  clearSkeleton(tbody); tbody.appendChild(frag);
}

/* ===== Sales (営業) ===== */
async function renderSales(){
  const tbody=$('#tbSales'); if(!tbody) return;
  tableSkeleton(tbody, 7, 10);
  const qEl=$('#salesQ'); const q=(qEl&&qEl.value)? qEl.value.trim():'';
  const rows=await apiGet({action:'listSales',q},{swrKey:'sales'+(q?':'+q:'')});
  tbody.innerHTML = rows.map(r=> `
    <tr>
      <td>${r.so_id||''}</td>
      <td class="s muted">${fmtD(r['受注日'])}</td>
      <td>${r['得意先']||''}</td>
      <td>${r['品名']||''}</td>
      <td>${(r['品番']||'')}/${(r['図番']||'')}</td>
      <td>${r['数量']||0}</td>
      <td class="s muted">${fmtD(r['希望納期'])}</td>
      <td><span class="badge">${r.status||''}</span></td>
      <td>${r['linked_po_id']||''}</td>
      <td class="s muted">${fmtDT(r['updated_at'])}</td>
    </tr>`).join('');
}

/* populate 注番 selector (from 受注) */
async function populateChubanFromSales(){
  const dl = document.getElementById('dl_po_from_so'); if(!dl) return;
  try{
    const rows = await apiGet({action:'listSales'},{swrKey:'sales'});
    dl.innerHTML = (rows||[]).map(r=> `<option value="${r.so_id||''}" label="${(r['得意先']||'') + ' / ' + (r['品名']||'')}"></option>`).join('');
  }catch(e){ console.warn('dl_po_from_so:', e); }
}
function initChubanSelector(){
  const sel = document.getElementById('poSource');
  const input = document.getElementById('c_po');
  if(!sel || !input) return;
  sel.addEventListener('change', ()=>{
    const v = sel.value;
    if(v==='so'){ input.setAttribute('list','dl_po_from_so'); input.placeholder='注番（受注から選択）'; }
    if(v==='manual'){ input.removeAttribute('list'); input.placeholder='注番（手入力）'; }
    if(v==='blank'){ input.removeAttribute('list'); input.value=''; input.placeholder='注番（空欄可）'; }
  });
  sel.dispatchEvent(new Event('change'));
}

async function saveSalesUI(){
  const p={
    '受注日':$('#so_date')?$('#so_date').value:'', '得意先':$('#so_cust')?$('#so_cust').value:'',
    '品名':$('#so_item')?$('#so_item').value:'', '品番':$('#so_part')?$('#so_part').value:'',
    '図番':$('#so_drw')?$('#so_drw').value:'', '製番号':$('#so_sei')?$('#so_sei').value:'',
    '数量':$('#so_qty')?$('#so_qty').value:'', '希望納期':$('#so_req')?$('#so_req').value:'', '備考':$('#so_note')?$('#so_note').value:''
  };
  const soEl=$('#so_id'); const so=soEl?soEl.value.trim():'';
  try{
    if(so){ await apiPost('updateSalesOrder',{so_id:so,updates:p,user:SESSION}); alert('受注を更新しました'); }
    else { const r=await apiPost('createSalesOrder',{payload:p,user:SESSION}); alert('受注登録: '+r.so_id); if(soEl) soEl.value=r.so_id; }
    renderSales();
    populateChubanFromSales();
  }catch(e){ alert(e.message||e); }
}
async function deleteSalesUI(){
  const soEl=$('#so_id'); const so=soEl?soEl.value.trim():'';
  if(!so) return alert('注番入力'); if(!confirm('削除しますか？')) return;
  try{ const r=await apiPost('deleteSalesOrder',{so_id:so,user:SESSION}); alert('削除: '+r.deleted); renderSales(); populateChubanFromSales(); }
  catch(e){ alert(e.message||e); }
}
async function promoteSalesUI(){
  const soEl=$('#so_id'); const so=soEl?soEl.value.trim():'';
  if(!so) return alert('注番入力');
  try{ const r=await apiPost('promoteSalesToPlan',{so_id:so,user:SESSION}); alert('生産計画を作成: '+r.po_id); refreshAll(); }
  catch(e){ alert(e.message||e); }
}
async function exportSalesCSV(){ const rows=await apiGet({action:'listSales'},{swrKey:'sales'}); downloadCSV('sales_orders.csv', rows); }

/* ===== Plan CRUD ===== */
// (tidak diubah — sama persis dengan punyamu)


/* ===== Plan CRUD ===== */
/* ===== Plan CRUD ===== */
async function createOrderUI(){
  if(!(SESSION && (SESSION.role==='admin'||SESSION.department==='生産技術'||SESSION.department==='生産管理部'))) {
    alert('権限不足'); return;
  }
  const p = {
    '得意先': ($('#c_tokui')?.value || '').trim(),
    '製番号': ($('#c_sei')?.value || '').trim(),
    '品名'  : ($('#c_hinmei')?.value || '').trim(),
    '品番'  : ($('#c_hinban')?.value || '').trim(),
    '図番'  : ($('#c_zuban')?.value || '').trim(),
    '数量'  : Number($('#c_qty')?.value || 0) || 0
  };
  const editingPoEl = $('#c_po');
  const editingPo = editingPoEl ? editingPoEl.value.trim() : '';
  try{
    if (editingPo){
      await apiPost('updateOrder', { po_id: editingPo, updates: p, user: SESSION });
      alert('編集保存しました');
    } else {
      const r = await apiPost('createOrder', { payload: p, user: SESSION });
      alert('作成: ' + r.po_id);
      if (editingPoEl) editingPoEl.value = r.po_id;
    }
    refreshAll();
  }catch(e){ alert(e.message || e); }
}

async function loadOrderForEdit(){
  const poEl = $('#c_po'); const po = poEl ? poEl.value.trim() : '';
  if(!po){ alert('注番入力'); return; }
  try{
    const o = await apiGet({action:'ticket', po_id:po});
    const set = (sel, v)=>{ const el=$(sel); if(el) el.value = v ?? ''; };
    set('#c_tokui', o['得意先']);
    set('#c_sei',   o['製番号']);
    set('#c_hinmei',o['品名']);
    set('#c_hinban',o['品番']);
    set('#c_zuban', o['図番']);
    set('#c_qty',   o['数量'] || 0);
    alert('読み込み完了。');
  }catch(e){ alert(e.message || e); }
}

async function deleteOrderUI(){
  if(!(SESSION && (SESSION.role==='admin'||SESSION.department==='生産技術'||SESSION.department==='生産管理部'))) {
    alert('権限不足'); return;
  }
  const poEl = $('#c_po'); const po = poEl ? poEl.value.trim() : '';
  if(!po){ alert('注番入力'); return; }
  if(!confirm('削除しますか？')) return;
  try{
    const r = await apiPost('deleteOrder', { po_id: po, user: SESSION });
    alert('削除:' + r.deleted);
    refreshAll();
  }catch(e){ alert(e.message || e); }
}

/* ===== Ship CRUD ===== */
async function scheduleUI(){
  if(!(SESSION && (SESSION.role==='admin'||SESSION.department==='生産技術'||SESSION.department==='生産管理部'))) return alert('権限不足');

  const po   = $('#s_po')?.value.trim() || '';
  const sdate= $('#s_date')?.value || '';     // 出荷日
  const ddate= $('#s_delivery')?.value || ''; // 納入日
  const qty  = Number($('#s_qty')?.value || 0) || 0;

  const cust = $('#s_cust')?.value.trim() || '';
  const item = $('#s_item')?.value.trim() || '';
  const part = $('#s_part')?.value.trim() || '';
  const drw  = $('#s_drw')?.value.trim()  || '';

  const dest = $('#s_dest')?.value.trim() || '';
  const unso = $('#s_carrier')?.value.trim() || '';

  if(!po||!sdate) return alert('注番と出荷日');

  const idEl=$('#s_shipid'); const shipId=idEl? idEl.value.trim() : '';

  try{
    if(shipId){
      await apiPost('updateShipment',{
        ship_id:shipId,
        updates:{po_id:po,scheduled_date:sdate,delivery_date:ddate,qty,
                 得意先:cust, 品名:item, 品番:part, 図番:drw, 送り先:dest, 運送会社:unso},
        user:SESSION
      });
      alert('出荷予定を編集しました');
    }else{
      const r=await apiPost('scheduleShipment',{
        po_id:po,dateIso:sdate,deliveryIso:ddate,qty,
        customer:cust,item,part,drw,dest,carrier:unso,user:SESSION
      });
      alert('登録: '+r.ship_id);
    }
    refreshAll(true);
  }catch(e){ alert(e.message||e); }
}

async function loadShipForEdit(){
  const idEl=$('#s_shipid'); const sid=idEl?idEl.value.trim():'';
  if(!sid) return alert('出荷ID入力');
  try{
    const d=await apiGet({action:'shipById',ship_id:sid});
    const set=(id,v)=>{ const el=$(id); if(el) el.value=v||''; };
    set('#s_po', d.shipment.po_id||'');
    set('#s_date', d.shipment.scheduled_date? new Date(d.shipment.scheduled_date).toISOString().slice(0,10):'');
    set('#s_qty', d.shipment.qty||0);
    alert('読み込み完了。');
  }catch(e){ alert(e.message||e); }
}
async function deleteShipUI(){
  if(!(SESSION && (SESSION.role==='admin'||SESSION.department==='生産技術'||SESSION.department==='生産管理部'))) return alert('権限不足');
  const idEl=$('#s_shipid'); const sid=idEl?idEl.value.trim():'';
  if(!sid) return alert('出荷ID入力'); if(!confirm('削除しますか？')) return;
  try{ const r=await apiPost('deleteShipment',{ship_id:sid,user:SESSION}); alert('削除:'+r.deleted); refreshAll(true); }
  catch(e){ alert(e.message||e); }
}
async function openShipByPO(po){
  try{
    const d=await apiGet({action:'shipByPo',po_id:po});
    showShipDoc(d.shipment, d.order);
  }catch(e){ alert(e.message||e); }
}
async function openShipByID(id){
  try{
    const d=await apiGet({action:'shipById',ship_id:id});
    showShipDoc(d.shipment, d.order);
  }catch(e){ alert(e.message||e); }
}
function showShipDoc(s,o){
  const dt=s.scheduled_date? new Date(s.scheduled_date):null;
  const body=`<h3>出荷確認書</h3><table>
    <tr><th>得意先</th><td>${o['得意先']||''}</td><th>出荷日</th><td>${dt?dt.toLocaleDateString():'-'}</td></tr>
    <tr><th>注番</th><td>${s.po_id}</td><th>数量</th><td>${s.qty||0}</td></tr>
    <tr><th>品名</th><td>${o['品名']||''}</td><th>品番/図番</th><td>${(o['品番']||'')+' / '+(o['図番']||'')}</td></tr>
    <tr><th>状態</th><td colspan="3">${o.status||''}</td></tr></table>`;
  showDoc('dlgShip', body);
}

/* ===== Docs ===== */
async function openTicket(po_id){
  try{
    const o=await apiGet({action:'ticket',po_id});
    const body=`<h3>生産現品票</h3><table>
      <tr><th>管理No</th><td>${o['管理No']||'-'}</td><th>通知書番号</th><td>${o['通知書番号']||'-'}</td></tr>
      <tr><th>得意先</th><td>${o['得意先']||''}</td><th>得意先品番</th><td>${o['得意先品番']||''}</td></tr>
      <tr><th>製番号</th><td>${o['製番号']||''}</td><th>投入日</th><td>${o['created_at']?new Date(o['created_at']).toLocaleDateString():'-'}</td></tr>
      <tr><th>品名</th><td>${o['品名']||''}</td><th>品番/図番</th><td>${(o['品番']||'')+' / '+(o['図番']||'')}</td></tr>
      <tr><th>工程</th><td colspan="3">${o.current_process||''}</td></tr>
      <tr><th>状態</th><td>${o.status||''}</td><th>更新</th><td>${fmtDT(o.updated_at)} / ${o.updated_by||''}</td></tr></table>`;
    showDoc('dlgTicket',body);
  }catch(e){ alert(e.message||e); }
}
function showDoc(id, html){
  const dlg=document.getElementById(id);
  if(!dlg) return;
  const body=dlg.querySelector('.body'); if(body) body.innerHTML=html;
  dlg.showModal();
}

/* ==== History ==== */
async function openHistory(po_id){
  try{
    const data=await apiGet({action:'history',po_id});
    const rows=(data||[]).map(x=>`
      <div class="row s" style="gap:.5rem;border-bottom:1px solid var(--border);padding:.25rem 0">
        <span class="muted">${fmtDT(x.timestamp)}</span>
        <span>${x.updated_by||''}</span>
        <span class="badge ${STATUS_CLASS[x.new_status]||'st-begin'}">${x.prev_status||''} → ${x.new_status||''}</span>
        <span class="badge ${PROC_CLASS[x.new_process]||'prc-out'}">${x.prev_process||''} → ${x.new_process||''}</span>
        ${x.note?`<span class="muted">「${x.note}」</span>`:''}
      </div>`).join('');
    const html=`<h3>更新履歴（注番: ${po_id}）</h3>
      <div class="row gap" style="margin:.35rem 0">
        <button class="btn ghost s" onclick="exportHistoryCSV()"><i class="fa-solid fa-file-csv"></i> CSV</button>
      </div>
      <div id="histBody">${rows||'<div class="muted s">履歴なし</div>'}</div>`;
    showDoc('dlgHistory', html);
    window._histForCSV = data||[];
  }catch(e){ alert(e.message||e); }
}
function exportHistoryCSV(){
  const data = window._histForCSV||[];
  downloadCSV('history.csv', data);
}

/* ===== QR Station & Scan ===== */
function openStationQR(){
  const dlg=$('#dlgStationQR'); const wrap=$('#qrWrap'); if(!dlg||!wrap) return;
  wrap.innerHTML = PROCESSES.map(p=>`<div id="qr-${p}" style="display:flex;flex-direction:column;align-items:center;gap:.35rem">
      <div class="muted s">${p}</div><div class="qrbox" data-text="ST:${p}"></div></div>`).join('');
  dlg.showModal();
  setTimeout(()=>{
    wrap.querySelectorAll('.qrbox').forEach(div=>{
      const t=div.dataset.text;
      new QRCode(div,{text:t,width:120,height:120});
    });
  },0);
}
function openAddUserModal(){ alert('ユーザー追加はログイン画面で対応しています。'); }
function startScanFor(po){
  CURRENT_PO=po;
  const dlg=$('#dlgScan'); if(!dlg) return;
  dlg.showModal();
  $('#scanPO').textContent=po;
  initScan();
}
async function initScan(){
  const video=$('#scanVideo'), canvas=$('#scanCanvas'), result=$('#scanResult');
  if(!video||!canvas) return;
  try{
    scanStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    video.srcObject=scanStream; await video.play();
    const ctx=canvas.getContext('2d');
    scanTimer = setInterval(async ()=>{
      if(video.readyState!==video.HAVE_ENOUGH_DATA) return;
      canvas.width=video.videoWidth; canvas.height=video.videoHeight;
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      const img=ctx.getImageData(0,0,canvas.width,canvas.height);
      const code=jsQR(img.data, img.width, img.height);
      if(code && code.data){
        result.textContent='読み取り: '+code.data;
        const token=String(code.data||'');
        const [prefix, station] = token.split(':');
        if(prefix==='ST' && station && CURRENT_PO){
          const ok = Number($('#man_ok')?$('#man_ok').value:'')||0;
          const ng = Number($('#man_ng')?$('#man_ng').value:'')||0;
          try{
            const o=await apiGet({action:'ticket',po_id:CURRENT_PO});
            const rule=STATION_RULES[station] || ((_o)=>({current_process:station}));
            const updates=Object.assign({ok_qty: ok, ng_qty: ng}, rule(o) || {});
            await apiPost('updateOrder',{po_id:CURRENT_PO,updates:updates,user:SESSION});
            alert('更新しました'); refreshAll(true);
          }catch(e){ alert(e.message||e); }
        }
        stopScan();
        $('#dlgScan').close();
      }
    }, 300);
  }catch(e){ alert('カメラ起動不可: '+(e.message||e)); }
}
function stopScan(){
  if(scanTimer){ clearInterval(scanTimer); scanTimer=null; }
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream=null; }
}

/* ===== Inventory & Finished ===== */
async function renderInventory(){
  const tbody=$('#tbInv'); if(!tbody) return;
  tableSkeleton(tbody, 8, 8);
  const qEl=$('#invQ'); const q=(qEl&&qEl.value)? qEl.value.trim():'';
  const rows=await apiGet({action:'listInventory',q},{swrKey:'inv'+(q?':'+q:'')});
  tbody.innerHTML = rows.map(r=> `
    <tr>
      <td>
        <div class="row-main">
          <b>${r.po_id}</b>
          <div class="row-sub">
            <div class="kv"><span class="muted">得意先:</span> <b>${r['得意先']||'-'}</b></div>
          </div>
        </div>
      </td>
      <td>${r['品名']||''}</td>
      <td>${r['品番']||''}</td>
      <td>${r['図番']||''}</td>
      <td><span class="badge ${STATUS_CLASS[r.status]||'st-begin'}">${r.status||''}</span></td>
      <td><span class="badge ${PROC_CLASS[r.current_process]||'prc-out'}">${r.current_process||''}</span></td>
      <td class="s muted">${fmtDT(r.updated_at)}</td>
      <td class="s muted">${r.updated_by||''}</td>
    </tr>`).join('');
}
async function renderFinished(){
  const tbody=$('#tbFin'); if(!tbody) return;
  tableSkeleton(tbody, 8, 8);
  const qEl=$('#finQ'); const q=(qEl&&qEl.value)? qEl.value.trim():'';
  const rows=await apiGet({action:'listFinished',q},{swrKey:'fin'+(q?':'+q:'')});
  tbody.innerHTML = rows.map(r=> `
    <tr>
      <td>
        <div class="row-main">
          <b>${r.po_id}</b>
          <div class="row-sub">
            <div class="kv"><span class="muted">得意先:</span> <b>${r['得意先']||'-'}</b></div>
          </div>
        </div>
      </td>
      <td>${r['品名']||''}</td>
      <td>${r['品番']||''}</td>
      <td>${r['図番']||''}</td>
      <td><span class="badge ${STATUS_CLASS[r.status]||'st-begin'}">${r.status||''}</span></td>
      <td><span class="badge ${PROC_CLASS[r.current_process]||'prc-out'}">${r.current_process||''}</span></td>
      <td class="s muted">${fmtDT(r.updated_at)}</td>
      <td class="s muted">${r.updated_by||''}</td>
    </tr>`).join('');
}

/* ===== Invoice ===== */
async function previewInvoiceUI(){
  const info={
    customer: $('#inv_customer')?$('#inv_customer').value.trim():'',
    from: $('#inv_from')?$('#inv_from').value:'',
    to: $('#inv_to')?$('#inv_to').value:'',
  };
  if(!info.from||!info.to) return alert('期間（自/至）を入力');
  try{
    const d=await apiGet({action:'previewInvoice',customer:info.customer,from:info.from,to:info.to});
    INV_PREVIEW.info = {
      得意先: d.info.得意先, 期間自: d.info.期間自, 期間至: d.info.期間至,
      請求日: $('#inv_date')?$('#inv_date').value || new Date().toISOString().slice(0,10): new Date(),
      通貨: $('#inv_currency')?$('#inv_currency').value:'JPY', メモ: $('#inv_memo')?$('#inv_memo').value:''
    };
    INV_PREVIEW.lines = d.lines.map(l=> ({...l, 単価: l.単価||0, 金額: (l.数量||0)*(l.単価||0)}));
    renderInvoiceLines();
  }catch(e){ alert(e.message||e); }
}
function renderInvoiceLines(){
  const tb=$('#invLines'); if(!tb) return;
  let sub=0;
  tb.innerHTML = INV_PREVIEW.lines.map((l,i)=>{
    const amount = Number(l.数量||0)*Number(l.単価||0); sub+=amount;
    return `<tr>
      <td>${i+1}</td>
      <td>${l.品名||''}</td><td>${l.品番||''}</td><td>${l.図番||''}</td>
      <td>${l.数量||0}</td>
      <td contenteditable oninput="onInvPriceChange(${i}, this.innerText)">${l.単価||0}</td>
      <td>${amount}</td>
      <td>${l.PO||l.POs||l.注番||''}</td>
      <td>${l.出荷ID||l.出荷IDs||''}</td>
    </tr>`;
  }).join('');
  const tax=Math.round(sub*0.1), total=sub+tax;
  $('#invSub').textContent=sub; $('#invTax').textContent=tax; $('#invTotal').textContent=total;
}
function onInvPriceChange(idx, v){
  const price=Number(String(v).replace(/[^\d.]/g,''))||0;
  if(!INV_PREVIEW.lines[idx]) return;
  INV_PREVIEW.lines[idx].単価=price;
  renderInvoiceLines();
}
async function createInvoiceUI(){
  if(!(SESSION && (SESSION.role==='admin'||SESSION.department==='生産技術'||SESSION.department==='生産管理部'))) return alert('権限不足');
  if(!INV_PREVIEW.info || !INV_PREVIEW.lines.length) return alert('先に集計してください');
  try{
    const payload={info: INV_PREVIEW.info, lines: INV_PREVIEW.lines};
    const r=await apiPost('createInvoice',{payload,user:SESSION});
    INV_PREVIEW.inv_id = r.inv_id;
    alert(`発行しました: ${r.inv_id}（合計: ${r.合計}）`);
  }catch(e){ alert(e.message||e); }
}
async function openInvoiceDoc(inv_id){
  if(!inv_id){ alert('請求書IDがありません'); return; }
  try{
    const d=await apiGet({action:'invoiceDoc',inv_id});
    const head=d.inv||{};
    const body=`<h3>請求書</h3><table>
      <tr><th>請求書</th><td>${head.inv_id}</td><th>請求日</th><td>${fmtD(head['請求日'])}</td></tr>
      <tr><th>得意先</th><td>${head['得意先']}</td><th>期間</th><td>${fmtD(head['期間自'])}〜${fmtD(head['期間至'])}</td></tr>
      <tr><th>小計</th><td>${head['小計']}</td><th>合計</th><td>${head['合計']}</td></tr>
    </table>
    <h4>明細</h4>
    <table><thead><tr><th>#</th><th>品名</th><th>数量</th><th>単価</th><th>金額</th><th>注番</th><th>出荷ID</th></tr></thead>
    <tbody>${(d.lines||[]).map(l=>`<tr><td>${l['行No']}</td><td>${l['品名']}</td><td>${l['数量']}</td><td>${l['単価']}</td><td>${l['金額']}</td><td>${l['PO']||l['注番']}</td><td>${l['出荷ID']}</td></tr>`).join('')}</tbody></table>`;
    showDoc('dlgTicket', body);
  }catch(e){ alert(e.message||e); }
}

/* ===== Charts ===== */
function ensureChartsLoaded(){ renderCharts().catch(console.warn); }
function fillChartYearSelector(){
  const sel=$('#chartYear'); if(!sel) return;
  const y=(new Date()).getFullYear();
  sel.innerHTML=[y-2,y-1,y,y+1].map(v=>`<option value="${v}" ${v===y?'selected':''}>${v}</option>`).join('');
}
async function renderCharts(){
  try{
    const ySel = document.getElementById('chartYear');
    const yearHint = ySel && ySel.value ? Number(ySel.value) : null;
    const data = await apiGet({action:'charts', year: yearHint||''}, {swrKey:'charts'+(yearHint||'')});

    const mlabels = ['1','2','3','4','5','6','7','8','9','10','11','12'];

    drawBar('chMonthly', mlabels, data.perMonth || [], '月別出荷数量');
    const custLabels = Object.keys(data.perCust||{});
    const custValues = custLabels.map(k=> data.perCust[k]);
    drawPie('chCustomer', custLabels, custValues, '得意先別出荷');

    const sbLabels = Object.keys(data.stockBuckets||{});
    const sbValues = sbLabels.map(k=> data.stockBuckets[k]);
    drawPie('chStock', sbLabels, sbValues, '在庫区分');

    const wipLabels = Object.keys(data.wipByProcess||{});
    const wipValues = wipLabels.map(k=> data.wipByProcess[k]);
    drawBar('chWipProc', wipLabels, wipValues, '工程内WIP');

    drawBar('chSales', mlabels, data.salesPerMonth || [], '営業 受注数');
    drawBar('chPlan', mlabels, data.planPerMonth || [], '生産計画 作成数');
  }catch(e){
    console.error('Charts fail:', e);
    showApiError('charts', e);
  }
}
function drawBar(canvasId, labels, values, label){
  const ctx = document.getElementById(canvasId);
  if(!ctx) return;
  if(ctx._chart){ ctx._chart.destroy(); }
  ctx._chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label, data: values }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} }, scales:{ y:{ beginAtZero:true } } }
  });
}
function drawPie(canvasId, labels, values, label){
  const ctx = document.getElementById(canvasId);
  if(!ctx) return;
  if(ctx._chart){ ctx._chart.destroy(); }
  ctx._chart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ label, data: values }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'55%', plugins:{ legend:{ position:'bottom' } } }
  });
}

/* ===== Import / Export ===== */
// (tetap sama — fungsi downloadCSV/export... milikmu)


/* ===== Import / Export ===== */
function downloadCSV(filename, rows){
  const head = rows && rows.length ? Object.keys(rows[0]) : [];
  const csv = [head.join(','), ...(rows||[]).map(r=> head.map(h=> JSON.stringify(r[h]??'')).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}), url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
async function exportOrdersCSV(){ const rows=await apiGet({action:'listOrders'},{swrKey:'orders'}); downloadCSV('orders.csv', rows); }
async function exportShipCSV(){ const rows=await apiGet({action:'todayShip'},{swrKey:'todayShip'}); downloadCSV('today_ship.csv', rows); }
function exportInvoiceCSV(){
  if (!INV_PREVIEW || !INV_PREVIEW.lines || !INV_PREVIEW.lines.length){
    alert('先に「集計（出荷済）」を実行してください。');
    return;
  }
  const head = ['#','品名','品番','図番','数量','単価','金額','注番','出荷ID'];
  const rows = INV_PREVIEW.lines.map((l,i)=>({
    '#': i+1,
    '品名': l.品名||'',
    '品番': l.品番||'',
    '図番': l.図番||'',
    '数量': l.数量||0,
    '単価': l.単価||0,
    '金額': (Number(l.数量||0)*Number(l.単価||0))||0,
    '注番': l.PO || l.注番 || l.POs || '',
    '出荷ID': l.出荷ID || l.出荷IDs || ''
  }));
  const csv = [head.join(','), ...rows.map(r=> head.map(h=> JSON.stringify(r[h]??'')).join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'invoice_lines.csv'; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

// ===== Import / Export =====
function handleImport(e, type){
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const isCSV = /\.csv$/i.test(file.name);
  const reader = new FileReader();

  reader.onload = async (ev) => {
    const data = ev.target.result;
    let rows = [];

    if (isCSV) {
      const text = String(data);
      const lines = text.split(/\r?\n/).filter(Boolean);
      const head = (lines.shift() || '').split(',').map(h => h.replace(/^"|"$/g,''));
      rows = lines.map(line=>{
        const cols = line.match(/([^",\s]+|"[^"]*")(?=\s*,|\s*$)/g)?.map(x=> x.replace(/^"|"$/g,'')) || [];
        const o = {}; head.forEach((h,i)=> o[h] = cols[i]);
        return o;
      });
    } else {
      // XLSX via ArrayBuffer (bukan binaryString)
      const wb = XLSX.read(new Uint8Array(data), { type:'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws);
    }

    try {
      if (type === 'sales')  await apiPost('importSales',     { rows, user: SESSION, mode: 'upsert' });
      if (type === 'orders') await apiPost('importOrders',    { rows, user: SESSION, mode: 'upsert' });
      if (type === 'ship')   await apiPost('importShipments', { rows, user: SESSION, mode: 'upsert' });
      alert('インポート成功'); 
      refreshAll(true); 
      populateChubanFromSales();
    } catch (err) { 
      showApiError('import-' + type, err); 
    }
  };

  if (isCSV) {
    reader.readAsText(file, 'utf-8');
  } else {
    reader.readAsArrayBuffer(file);
  }
} // ⬅️ pastikan kurung penutup ini ada; TIDAK ada "else reader.readAsBinaryString(...)";

// ===== (fungsi berikutnya mulai di sini, mis. Charts) =====
function ensureChartsLoaded(){ renderCharts().catch(console.warn); }
