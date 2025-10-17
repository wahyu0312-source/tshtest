// === app.hotfix.js ===
// Patch ringan; load AFTER app.js. Tidak mengubah UI/markup asli.

(function(){
  // ---------- Util umum ----------
  function q(sel, root){ return (root||document).querySelector(sel); }
  function qa(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
  function text(el){ return (el && (el.textContent||'').trim()) || ''; }

  // Cari PO dari baris (dataset, link PO, atau teks "PO-...")
  function extractPOFromRow(row){
    if(!row) return null;
    // 1) data-po pada tombol/baris
    if(row.dataset && row.dataset.po) return row.dataset.po;
    const poByAttr = row.getAttribute && row.getAttribute('data-po');
    if(poByAttr) return poByAttr;

    // 2) tautan PO di kolom pertama
    const link = q('a[href*="PO-"], a[href*="po-"]', row);
    if(link && /PO-\d+/i.test(link.textContent)) return link.textContent.trim();

    // 3) fallback: teks dalam baris
    const m = row.textContent && row.textContent.match(/PO-\d+/i);
    return m ? m[0] : null;
  }

  function closestRow(el){
    return el.closest?.('[data-row="order"], tr, .order-row, .card, li') || el.closest('*');
  }

  // ---------- API wrapper (pesan error jelas) ----------
  async function apiCall(action, opts={}){
    const API_BASE = (window.API_BASE || localStorage.getItem('API_BASE') || '').trim();
    if(!API_BASE){
      throw new Error('API_BASE belum diset. Set lewat localStorage.setItem("API_BASE","https://script.google.com/macros/s/AKfycbyqIp-Y5xuWH6FXXqZCgqL4BFwuPfFQ_YW6KWvXpJo1-eA9zB3Uhs_p9hcjUryR8Q2w/exec")');
    }
    const method = (opts.method||'GET').toUpperCase();
    const headers = {'Content-Type':'application/json'};
    let url = API_BASE + '?action=' + encodeURIComponent(action);
    let body;

    if(method==='GET'){
      const params = {...(opts.params||{})};
      Object.keys(params).forEach(k=>{
        if(params[k]!==undefined && params[k]!==null){
          url += '&'+encodeURIComponent(k)+'='+encodeURIComponent(params[k]);
        }
      });
    } else {
      body = JSON.stringify(opts.body||{});
    }

    let res;
    try{
      res = await fetch(url, {method, headers, body, mode:'cors'});
    }catch(err){
      throw new Error('Network error: '+(err?.message||String(err)));
    }
    if(!res.ok){
      const txt = await res.text().catch(()=> '');
      throw new Error('HTTP '+res.status+' – '+txt);
    }
    let json;
    try{
      json = await res.json();
    }catch(e){
      const raw = await res.text().catch(()=> '');
      throw new Error('Invalid response (cek deploy/izin API_BASE). Raw: '+raw);
    }
    if(!json.ok) throw new Error(json.error||'Server returned ok=false');
    return json.data;
  }

  // ---------- State PO aktif ----------
  const STATE = window.__STATE__ = window.__STATE__ || { currentPO:null };

  // Saat tombol 更新 diklik → simpan PO aktif
  document.addEventListener('click', (ev)=>{
    const t = ev.target;
    const btn = t.closest?.('button, a');
    if(!btn) return;

    // Tombol "更新" (kelas/ikon bisa berbeda-beda, jadi deteksi teks)
    if(/更新/.test(text(btn))){
      const row = closestRow(btn);
      const po = extractPOFromRow(row);
      if(po) STATE.currentPO = po;
    }

    // Tombol "票" (現品票)
    if(/票/.test(text(btn)) && !/出荷票/.test(text(btn))){
      ev.preventDefault();
      const row = closestRow(btn);
      const po = extractPOFromRow(row);
      if(po) STATE.currentPO = po;
      openTicketForCurrentPO().catch(err=> alert('票エラー: '+err.message));
    }

    // Tombol "閉じる"
    if(/閉じる/.test(text(btn))){
      ev.preventDefault();
      closeNearestDialog(btn);
    }
  });

  // ---------- Ticket handler ----------
  async function openTicketForCurrentPO(){
    const po = STATE.currentPO;
    if(!po) throw new Error('PO tidak ditemukan dari baris order.');
    // panggil backend 'ticket'
    await apiCall('ticket', { method:'GET', params:{ po_id: po } });
    // Jika aplikasi kamu punya fungsi resmi untuk menampilkan dialog ticket, panggil:
    if(typeof window.openTicketDialog === 'function'){
      return window.openTicketDialog(po);
    }
    // else: tampilkan info minimal
    alert('現品票を取得しました: '+po);
  }

  // ---------- Manual update (tanpa isi PO) ----------
  window.manualUpdateProcess = async function(){
    const po = STATE.currentPO;
    if(!po){
      alert('Pilih order dulu: klik tombol 更新 pada baris item, lalu buka manual update.');
      return;
    }
    const pill = q('[data-proc-pill].active');
    const proc = pill?.dataset?.proc || pill?.textContent?.trim();
    if(!proc){ alert('Silakan pilih 工程 terlebih dahulu.'); return; }

    const ok = Number((q('#manual-ok')?.value||0));
    const ng = Number((q('#manual-ng')?.value||0));

    await apiCall('updateProcess', { method:'POST',
      body:{ po_id: po, next_process: proc, ok_qty: ok, ng_qty: ng, note:'manual' }
    });

    if(typeof window.refreshOrders==='function') window.refreshOrders();
    if(typeof window.refreshDashboard==='function') window.refreshDashboard();
    alert('工程を更新しました（PO: '+po+' / '+proc+' / OK:'+ok+' NG:'+ng+'）');
  };

  // ---------- Scan dialog: perbarui judul agar PO terlihat ----------
  // Jika ada judul "QRスキャン更新 (...)" kita update saat dialog dibuka
  const openScanDialogOrig = window.openScanDialog;
  window.openScanDialog = function(order){
    if(order && order.po_id) STATE.currentPO = order.po_id;
    setTimeout(()=>{
      const title = qa('h3, h4, .modal-title').find(el=> /QRスキャン更新/.test(text(el)));
      if(title && STATE.currentPO){
        title.textContent = 'QRスキャン更新（PO: '+STATE.currentPO+'）';
      }
      // Buat input PO (bila ada) jadi readonly + placeholder otomatis
      const poInput = q('#manual-po');
      if(poInput){
        poInput.readOnly = true;
        poInput.placeholder = 'Otomatis pakai PO: '+(STATE.currentPO||'-');
        poInput.style.opacity = 0.6;
      }
    }, 0);
    return openScanDialogOrig ? openScanDialogOrig(order) : undefined;
  };

  // ---------- Tutup dialog generik ----------
  function closeNearestDialog(el){
    // HTML <dialog>
    const dlg = el.closest?.('dialog');
    if(dlg && typeof dlg.close==='function'){ dlg.close(); return; }

    // Modal custom: cari container yang terlihat
    const modal = el.closest?.('.modal, .dialog, [role="dialog"]');
    if(modal){
      modal.classList.remove('open','show','is-active');
      modal.style.display = 'none';
      // klik backdrop kalau ada
      const back = q('.modal-backdrop, .backdrop, .overlay');
      if(back) back.remove();
      return;
    }

    // Fallback: coba trigger tombol/ikon X
    const xbtn = qa('button, a').find(b=> /×|✕|close/i.test(text(b)));
    if(xbtn){ xbtn.click(); }
  }

  // ---------- Atur placeholder PO manual saat halaman siap ----------
  document.addEventListener('DOMContentLoaded', ()=>{
    const el = q('#manual-po');
    if(el){
      el.readOnly = true;
      el.placeholder = 'Otomatis (berdasarkan baris yang dipilih)';
      el.style.opacity = 0.6;
    }
  });
})();
