// === app.hotfix.js ===
(function(){
  const q  = (s,r)=> (r||document).querySelector(s);
  const qa = (s,r)=> Array.from((r||document).querySelectorAll(s));
  const text = el => (el && (el.textContent||'').trim()) || '';
  const isVisible = el => !!el && !el.classList.contains('hidden');

  // ---------- API ----------
  function toQS(obj){
    return Object.keys(obj||{}).map(k => encodeURIComponent(k)+'='+encodeURIComponent(obj[k]??'')).join('&');
  }
  async function apiCall(action, opts={}){
    const API_BASE = (window.API_BASE || localStorage.getItem('API_BASE') || '').trim();
    if(!API_BASE) throw new Error('API_BASE belum diset.');

    let url = API_BASE + '?action=' + encodeURIComponent(action);
    const method = (opts.method||'GET').toUpperCase();

    let fetchOpts = { method };
    if(method === 'GET'){
      const p = opts.params || {};
      const extra = toQS(p);
      if(extra) url += '&' + extra;
      // penting: JANGAN set header Content-Type pada GET (hindari preflight)
    }else{
      // kirim sebagai x-www-form-urlencoded -> tidak preflight
      const body = toQS(opts.body||{});
      fetchOpts.headers = {'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'};
      fetchOpts.body = body;
    }

    let res;
    try{ res = await fetch(url, fetchOpts); }
    catch(err){ throw new Error('Network error: '+(err?.message||String(err))); }

    if(!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error('HTTP '+res.status+' – '+t);
    }
    // Gas kirim JSON
    let json;
    try{ json = await res.json(); }
    catch(e){ const raw=await res.text().catch(()=> ''); throw new Error('Invalid response. Raw: '+raw); }
    if(!json.ok) throw new Error(json.error||'Server returned ok=false');
    return json.data;
  }

  // ---------- Helpers ----------
  const STATE = window.__STATE__ = window.__STATE__ || { currentPO:null };

  function closestRow(el){ return el.closest?.('[data-row="order"], tr, .order-row, .card, li') || el.closest('*'); }
  function extractPOFromRow(row){
    if(!row) return null;
    if(row.dataset?.po) return row.dataset.po;
    const a = q('a[href*="PO-"], a[href*="po-"]', row);
    if(a && /PO-\d+/i.test(a.textContent)) return a.textContent.trim();
    const m = row.textContent?.match(/PO-\d+/i);
    return m? m[0] : null;
  }

  // ---------- Click hooks (更新 / 票 / 閉じる) ----------
  document.addEventListener('click',(ev)=>{
    const btn = ev.target.closest?.('button, a'); if(!btn) return;

    if(/更新/.test(text(btn))){
      const row = closestRow(btn);
      const po  = extractPOFromRow(row);
      if(po) STATE.currentPO = po;
    }

    if(/票/.test(text(btn)) && !/出荷票/.test(text(btn))){
      ev.preventDefault();
      const row = closestRow(btn);
      const po  = extractPOFromRow(row);
      if(po) STATE.currentPO = po;
      openTicketForCurrentPO().catch(err=> alert('票エラー: '+err.message));
    }

    if(/閉じる/.test(text(btn))){
      ev.preventDefault();
      closeNearestDialog(btn);
    }
  });

  async function openTicketForCurrentPO(){
    const po = STATE.currentPO;
    if(!po) throw new Error('PO tidak ditemukan dari baris order.');
    await apiCall('ticket',{method:'GET',params:{po_id:po}});
    if(typeof window.openTicketDialog==='function') return window.openTicketDialog(po);
    alert('現品票を取得しました: '+po);
  }

  function closeNearestDialog(el){
    const dlg = el.closest?.('dialog'); if(dlg?.close){ dlg.close(); return; }
    const modal = el.closest?.('.modal, .dialog, [role="dialog"]');
    if(modal){
      modal.classList.remove('open','show','is-active');
      modal.style.display='none';
      const back = q('.modal-backdrop,.backdrop,.overlay'); if(back) back.remove();
    }
  }

  // ---------- Manual 工程更新 (PO otomatis + OK/NG) ----------
  window.manualUpdateProcess = async function(){
    const po = STATE.currentPO;
    if(!po){ alert('Pilih order dulu: klik tombol 更新 pada baris item, lalu buka manual更新.'); return; }
    const pill = q('[data-proc-pill].active');
    const proc = pill?.dataset?.proc || pill?.textContent?.trim();
    if(!proc){ alert('Silakan pilih 工程 terlebih dahulu.'); return; }
    const ok = Number((q('#manual-ok')?.value||0));
    const ng = Number((q('#manual-ng')?.value||0));
    await apiCall('updateProcess',{method:'POST',body:{po_id:po,next_process:proc,ok_qty:ok,ng_qty:ng,note:'manual'}});
    if(typeof window.refreshOrders==='function') window.refreshOrders();
    if(typeof window.refreshDashboard==='function') window.refreshDashboard();
    // refresh OK/NG (dashboard + tabel)
    renderOkNgSoon();
    renderOkNgTableSoon();
    alert(`工程を更新しました（PO: ${po} / ${proc} / OK:${ok} NG:${ng}）`);
  };

  // ---------- Dashboard: OK/NG per 工程 ----------
  async function renderOkNg(){
    const dash = q('#pageDash'); if(!isVisible(dash)) return; // jangan panggil saat login
    const host = q('#process-okng'); if(!host) return;
    let map;
    try{ map = await apiCall('okNgSnapshot',{method:'GET'}); }
    catch(e){ host.innerHTML = `<div class="muted s">OK/NG 取得失敗: ${e.message}</div>`; return; }
    const procs = Object.keys(map||{});
    host.innerHTML = procs.map(p=>{
      const v = map[p]||{ok:0,ng:0};
      return `<div class="okng-item">
                <div class="ttl">${p||'-'}</div>
                <div class="row"><span class="tag-ok">OK: ${v.ok}</span><span class="tag-ng">NG: ${v.ng}</span></div>
              </div>`;
    }).join('');
  }
  const renderOkNgSoon = debounce(renderOkNg, 150);

  // ---------- Tabel Order: OK/NG per PO (inline di kolom 工程) ----------
  async function getOkNgMap(){ return await apiCall('okNgByPO',{method:'GET'}); }

  async function renderOkNgTable(){
    const dash = q('#pageDash'); if(!isVisible(dash)) return; // jangan panggil saat login
    const tbody = q('#tbOrders'); if(!tbody) return;

    let map;
    try{ map = await getOkNgMap(); }
    catch(e){ console.warn('OK/NG map gagal:', e); return; }

    qa('tr', tbody).forEach(tr=>{
      const po = extractPOFromRow(tr); if(!po) return;
      const data = map[po] || {ok_qty:0, ng_qty:0};
      // kolom 工程 = ke-6
      const cell = tr.querySelector('td:nth-child(6)') || tr.querySelector('td:nth-child(5)') || tr.lastElementChild;
      if(!cell) return;
      const old = tr.querySelector('.okng-inline'); if(old) old.remove();
      const div = document.createElement('div');
      div.className = 'okng-inline';
      div.innerHTML = `<span class="tag-ok">OK: ${Number(data.ok_qty||0)}</span>
                       <span class="tag-ng">NG: ${Number(data.ng_qty||0)}</span>`;
      cell.appendChild(div);
    });
  }
  const renderOkNgTableSoon = debounce(renderOkNgTable, 150);

  // Panggil hanya saat Dashboard terlihat
  document.addEventListener('DOMContentLoaded', ()=>{
    const dash = q('#pageDash');
    if(isVisible(dash)){ renderOkNgSoon(); renderOkNgTableSoon(); }
    // deteksi perubahan visibility (#pageDash hidden -> tampil)
    const mo = new MutationObserver(()=>{ if(isVisible(dash)){ renderOkNgSoon(); renderOkNgTableSoon(); } });
    mo.observe(dash, {attributes:true, attributeFilter:['class']});
  });

  // Refresh otomatis saat tabel order di-render ulang oleh app.js
  const tb = q('#tbOrders');
  if(tb && 'MutationObserver' in window){
    const mo = new MutationObserver(()=>{ renderOkNgTableSoon(); });
    mo.observe(tb, {childList:true, subtree:false});
  }

  // ---- util
  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn.apply(null,a), ms); }; }
})();
