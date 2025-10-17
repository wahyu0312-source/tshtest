// === app.hotfix.js ===
// Patch ringan; load AFTER app.js. Tidak mengubah UI/markup asli.

(function(){
  // ---------- Util ----------
  const q  = (sel,root) => (root||document).querySelector(sel);
  const qa = (sel,root) => Array.from((root||document).querySelectorAll(sel));
  const txt = el => (el && (el.textContent||'').trim()) || '';

  function closestRow(el){
    return el.closest?.('[data-row="order"], tr, .order-row, .card, li') || el.closest('*');
  }
  function extractPOFromRow(row){
    if(!row) return null;
    if(row.dataset?.po) return row.dataset.po;
    const a = q('a[href*="PO-"], a[href*="po-"]', row);
    if(a && /PO-\d+/i.test(a.textContent)) return a.textContent.trim();
    const m = row.textContent?.match(/PO-\d+/i);
    return m? m[0] : null;
  }

  // ---------- API wrapper ----------
  async function apiCall(action, opts={}){
    const API_BASE = (window.API_BASE || localStorage.getItem('API_BASE') || '').trim();
    if(!API_BASE) throw new Error('API_BASE belum diset.');
    const method = (opts.method||'GET').toUpperCase();
    const headers = {'Content-Type':'application/json'};
    let url = API_BASE + '?action=' + encodeURIComponent(action);
    let body;
    if(method==='GET'){
      const p = {...(opts.params||{})};
      Object.keys(p).forEach(k=>{
        if(p[k]!==undefined && p[k]!==null) url += '&'+encodeURIComponent(k)+'='+encodeURIComponent(p[k]);
      });
    } else {
      body = JSON.stringify(opts.body||{});
    }
    let res;
    try{ res = await fetch(url,{method,headers,body,mode:'cors'}); }
    catch(err){ throw new Error('Network error: '+(err?.message||String(err))); }
    if(!res.ok){ const t=await res.text().catch(()=> ''); throw new Error('HTTP '+res.status+' – '+t); }
    let json;
    try{ json = await res.json(); }
    catch(e){ const raw=await res.text().catch(()=> ''); throw new Error('Invalid response (cek deploy/izin API_BASE). Raw: '+raw); }
    if(!json.ok) throw new Error(json.error||'Server returned ok=false');
    return json.data;
  }

  // ---------- State PO aktif ----------
  const STATE = window.__STATE__ = window.__STATE__ || { currentPO:null };

  // Hook klik → set current PO, handle 票 & 閉じる
  document.addEventListener('click', (ev)=>{
    const btn = ev.target.closest?.('button, a'); if(!btn) return;

    // 「更新」
    if(/更新/.test(txt(btn))){
      const row = closestRow(btn); const po = extractPOFromRow(row);
      if(po) STATE.currentPO = po;
    }

    // 「票」（現品票）
    if(/票/.test(txt(btn)) && !/出荷票/.test(txt(btn))){
      ev.preventDefault();
      const row = closestRow(btn); const po = extractPOFromRow(row);
      if(po) STATE.currentPO = po;
      openTicketForCurrentPO().catch(err=> alert('票エラー: '+err.message));
    }

    // 「閉じる」
    if(/閉じる/.test(txt(btn))){
      ev.preventDefault(); closeNearestDialog(btn);
    }
  });

  async function openTicketForCurrentPO(){
    const po = STATE.currentPO;
    if(!po) throw new Error('PO tidak ditemukan dari baris order.');
    await apiCall('ticket', { method:'GET', params:{ po_id: po } });
    if(typeof window.openTicketDialog==='function') return window.openTicketDialog(po);
    alert('現品票を取得しました: '+po);
  }

  // Manual update (tanpa isi PO)
  window.manualUpdateProcess = async function(){
    const po = STATE.currentPO;
    if(!po){ alert('Pilih order dulu: klik tombol 更新 pada baris item, lalu buka manual更新.'); return; }
    const pill = q('[data-proc-pill].active');
    const proc = pill?.dataset?.proc || pill?.textContent?.trim();
    if(!proc){ alert('Silakan pilih 工程 terlebih dahulu.'); return; }
    const ok = Number((q('#manual-ok')?.value||0));
    const ng = Number((q('#manual-ng')?.value||0));
    await apiCall('updateProcess',{ method:'POST', body:{ po_id:po, next_process:proc, ok_qty:ok, ng_qty:ng, note:'manual' } });
    if(typeof window.refreshOrders==='function') window.refreshOrders();
    if(typeof window.refreshDashboard==='function') window.refreshDashboard();
    alert(`工程を更新しました（PO: ${po} / ${proc} / OK:${ok} NG:${ng}）`);
  };

  // Perbarui judul scan dialog agar terlihat PO aktif
  const openScanDialogOrig = window.openScanDialog;
  window.openScanDialog = function(order){
    if(order?.po_id) STATE.currentPO = order.po_id;
    setTimeout(()=>{
      const title = qa('h3, h4, .modal-title').find(el=> /QRスキャン更新/.test(txt(el)));
      if(title && STATE.currentPO) title.textContent = 'QRスキャン更新（PO: '+STATE.currentPO+'）';
      const poInput = q('#manual-po');
      if(poInput){ poInput.readOnly = true; poInput.placeholder = 'Otomatis pakai PO: '+(STATE.currentPO||'-'); poInput.style.opacity = 0.6; }
    }, 0);
    return openScanDialogOrig ? openScanDialogOrig(order) : undefined;
  };

  function closeNearestDialog(el){
    const dlg = el.closest?.('dialog'); if(dlg?.close) { dlg.close(); return; }
    const modal = el.closest?.('.modal, .dialog, [role="dialog"]');
    if(modal){ modal.classList.remove('open','show','is-active'); modal.style.display='none'; const back = q('.modal-backdrop, .backdrop, .overlay'); if(back) back.remove(); }
  }
})();
