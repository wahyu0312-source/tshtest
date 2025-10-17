/* =========================================================
 * app.js — Tokyo Seimitsu ERP (Frontend) — CORS-proof
 * ========================================================= */

/* ===== Config ===== */
const API_BASE = "https://script.google.com/macros/s/AKfycbyqIp-Y5xuWH6FXXqZCgqL4BFwuPfFQ_YW6KWvXpJo1-eA9zB3Uhs_p9hcjUryR8Q2w/exec";
const API_KEY = "";

/* ===== Processes (tidak diubah) ===== */
const PROCESSES = [
  'レザー加工','曲げ加工','外枠組立','シャッター組立','シャッター溶接','コーキング',
  '外枠塗装','組立（組立中）','組立（組立済）','外注','検査工程'
];

/* ===== Station rules (tidak diubah) ===== */
const STATION_RULES = {
  'レザー加工': (o)=> ({ current_process:'レザー加工' }),
  '曲げ工程': (o)=> ({ current_process:'曲げ加工' }),
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

/* ===== SW register ===== */
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
    const url = API_BASE + '?' + toQS(q);
    const s = document.createElement('script');
    const timer = setTimeout(()=>{ cleanup(); reject(new Error('JSONP timeout')); }, 12000);
    function cleanup(){ clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = function(resp){ cleanup(); if(!resp || resp.ok===false) reject(new Error(resp && resp.error || 'Server error')); else resolve(resp.data); };
    s.onerror = ()=>{ cleanup(); reject(new Error('JSONP network error')); };
    s.src = url; document.head.appendChild(s);
  });
}
async function apiPost(action, body){
  const payload = {action, ...(API_KEY?{apiKey:API_KEY}:{}) , ...body};
  try{
    const res = await fetch(API_BASE, {
      method:'POST',
      mode:'cors',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' },
      body: toQS(payload),
      cache:'no-store',
    });
    const txt=await res.text(); const j=JSON.parse(txt);
    if(!j.ok) throw new Error(j.error||'API error'); return j.data;
  }catch(err){
    // Fallback: JSONP via GET
    console.warn('POST fell back to JSONP:', err);
    return jsonp(action, payload);
  }
}
async function apiGet(params, {swrKey=null, revalidate=true} = {}){
  const final = {...params, ...(API_KEY?{apiKey:API_KEY}:{})};
  const url=API_BASE+'?'+new URLSearchParams(final).toString();
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

  // scanner
  const btnScanStart = $('#btnScanStart'); if (btnScanStart) btnScanStart.onclick = ()=> initScan();

  // 注番 source selector (plan)
  initChubanSelector();
});

/* ===== Small utils ===== */
function debounce(fn, ms=150){ let t=null; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn.apply(null,args), ms); }; }
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

/* ===== Masters / Dashboard / Tables / (…semua fungsi kamu tetap sama) ===== */
/* ---- POTONGAN PANJANG TETAP SAMA DENGAN VERSI TERAKHIRMU ----
   Aku tidak mengubah logika selain pada helper API dan tombol Charts.
   Untuk ringkasnya, seluruh bagian renderOrders(), renderSales(), populateChubanFromSales(),
   initChubanSelector(), createOrderUI(), scheduleUI(), openTicket(), openHistory(),
   invoice helpers, charts helpers (ensureChartsLoaded, renderCharts, drawBar, drawPie),
   importer, dsb — semuanya MASIH SAMA seperti sebelumnya.
   Jika kamu butuh aku re-paste full bagian ini lagi, bilang ya — akan kukirim utuh.
*/
