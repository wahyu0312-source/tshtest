
// === app.hotfix.js ===
// Lightweight patch layer; load AFTER app.js

(function(){
  // --- Robust API fetch with clearer errors ---
  window.api = async function api(action, opts={}){
    const API_BASE = (window.API_BASE || localStorage.getItem('API_BASE') || '').trim();
    if(!API_BASE){
      throw new Error('API_BASE belum diset. Setel lewat localStorage.setItem("API_BASE","https://script.google.com/macros/s/AKfycbyqIp-Y5xuWH6FXXqZCgqL4BFwuPfFQ_YW6KWvXpJo1-eA9zB3Uhs_p9hcjUryR8Q2w/exec")');
    }
    const method = (opts.method || 'GET').toUpperCase();
    const headers = {'Content-Type':'application/json'};
    let url = API_BASE + '?action=' + encodeURIComponent(action);
    let body;
    if(method==='GET'){
      const params = {...(opts.params||{})};
      Object.keys(params).forEach(k=>{
        if(params[k]!==undefined && params[k]!==null) url += '&'+encodeURIComponent(k)+'='+encodeURIComponent(params[k]);
      });
    } else {
      body = JSON.stringify(opts.body||{});
    }
    let res;
    try {
      res = await fetch(url, {method, headers, body, mode:'cors'});
    } catch(err){
      throw new Error('Network error: '+ (err && err.message ? err.message : String(err)));
    }
    if(!res.ok){
      const txt = await res.text().catch(()=>'');
      throw new Error('HTTP '+res.status+' – '+txt);
    }
    let json;
    try {
      json = await res.json();
    } catch(err){
      const txt = await res.text().catch(()=>'');
      throw new Error('Invalid response (cek deploy/izin API_BASE). Raw: '+txt);
    }
    if(!json.ok){
      throw new Error(json.error||'Server returned ok=false');
    }
    return json.data;
  };

  // --- Current PO context so manual form tak perlu input PO ---
  const STATE = window.__STATE__ = window.__STATE__ || {};

  // Hook list renderer buttons to set currentPO
  const _openScanDialog = window.openScanDialog;
  window.openScanDialog = function openScanDialog_patched(order){
    try {
      if(order && order.po_id) STATE.currentPO = order.po_id;
      else if(Array.isArray(window.__ORDERS__) && window.__ORDERS__.length){
        STATE.currentPO = window.__ORDERS__[0].po_id;
      }
    } catch(_) {}
    return _openScanDialog ? _openScanDialog(order) : undefined;
  };

  // When Update button clicked on a row
  window.onClickUpdateRow = function onClickUpdateRow(btn){
    try {
      const po = btn && btn.dataset ? btn.dataset.po : null;
      if(po) STATE.currentPO = po;
    } catch(_) {}
    // fall back to existing handler if exists
    if(window._onClickUpdateRow) return window._onClickUpdateRow(btn);
  };

  // --- Manual update: remove PO input, use STATE.currentPO automatically ---
  async function manualUpdateProcess(){
    const po = STATE.currentPO;
    if(!po){
      alert('Pilih order terlebih dahulu (klik tombol 更新 pada baris order), lalu buka manual update.');
      return;
    }
    // read selected process (pill) & quantities
    const proc = document.querySelector('[data-proc-pill].active')?.dataset?.proc;
    const ok = Number((document.getElementById('manual-ok')||{}).value||0);
    const ng = Number((document.getElementById('manual-ng')||{}).value||0);
    if(!proc){ alert('Silakan pilih 工程.'); return; }

    await api('updateProcess',{
      method:'POST',
      body:{ po_id: po, next_process: proc, ok_qty: ok, ng_qty: ng, note: 'manual' }
    });
    // Refresh list / dashboard jika fungsi tersedia
    if(typeof window.refreshOrders==='function') window.refreshOrders();
    if(typeof window.refreshDashboard==='function') window.refreshDashboard();
    alert('工程を更新しました（PO: '+po+' / '+proc+' / OK:'+ok+' NG:'+ng+'）');
  }

  // expose for HTML button
  window.manualUpdateProcess = manualUpdateProcess;

  // --- Render helper: hide PO input if exists ---
  function hidePOInputIfExists(){
    const el = document.getElementById('manual-po');
    if(el){
      el.readOnly = true;
      el.placeholder = 'Otomatis (berdasarkan baris yang dipilih)';
      el.style.opacity = 0.6;
    }
  }
  document.addEventListener('DOMContentLoaded', hidePOInputIfExists);
})();
