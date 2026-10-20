/**
 * shared.js — Site-wide header, footer, avatar dropdown
 * Load FIRST on every page (before db.js and page scripts).
 */
(function(){
  const CSS = `
  :root{
    --sh-bg:#101013;--sh-panel:#17171B;--sh-panel2:#1D1D22;--sh-line:#2B2B31;
    --sh-ink:#F4F4F1;--sh-dim:#8E8E96;--sh-accent:#D8F43C;--sh-accent-ink:#111100;
    --sh-bad:#FF5449;--sh-good:#6FDD8B;
  }
  /* Kill focus glow everywhere */
  *:focus{outline:none;border-color:inherit!important;box-shadow:none!important;}

  .sh-header{
    position:sticky;top:0;z-index:50;
    background:var(--sh-bg);border-bottom:1px solid var(--sh-line);
  }
  .sh-header-inner{
    max-width:1000px;margin:0 auto;padding:12px 20px;
    display:flex;align-items:center;gap:18px;
  }
  .sh-logo{
    text-decoration:none;color:var(--sh-accent);
    font-weight:800;font-size:14px;letter-spacing:.18em;text-transform:uppercase;
    font-family:"SF Mono",ui-monospace,Menlo,monospace;
  }
  .sh-logo:hover{opacity:.8;}
  .sh-nav{display:flex;gap:2px;align-items:center;margin-left:6px;}
  .sh-nav a{
    color:var(--sh-dim);text-decoration:none;font-size:13px;
    padding:6px 10px;letter-spacing:.02em;transition:color .12s;
  }
  .sh-nav a:hover{color:var(--sh-accent);}
  .sh-nav a.sh-active{color:var(--sh-accent);font-weight:600;}
  .sh-spacer{flex:1;}
  .sh-avatar-wrap{position:relative;}
  .sh-avatar{
    width:34px;height:34px;border:1px solid var(--sh-line);
    background:var(--sh-panel2);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    font-size:13px;font-weight:700;color:var(--sh-accent);
    font-family:"SF Mono",ui-monospace,Menlo,monospace;
    overflow:hidden;transition:border-color .12s;user-select:none;
  }
  .sh-avatar:hover{border-color:var(--sh-accent);}
  .sh-avatar img{width:100%;height:100%;object-fit:cover;display:block;}
  .sh-dropdown{
    position:absolute;right:0;top:calc(100% + 6px);
    min-width:180px;background:var(--sh-panel);border:1px solid var(--sh-line);
    display:none;z-index:100;
  }
  .sh-dropdown.open{display:block;}
  .sh-dd-item{
    display:flex;align-items:center;gap:10px;
    padding:10px 14px;font-size:13px;color:var(--sh-ink);
    cursor:pointer;border-bottom:1px solid var(--sh-line);
    background:transparent;border:none;width:100%;text-align:left;
    font-family:inherit;text-decoration:none;transition:background .1s;
  }
  .sh-dd-item:last-child{border-bottom:none;}
  .sh-dd-item:hover{background:#1B1E24;color:var(--sh-accent);}
  .sh-dd-item.danger{color:var(--sh-bad);}
  .sh-dd-item.danger:hover{background:#1F1113;}
  .sh-dd-email{
    padding:10px 14px;font-size:12px;color:var(--sh-dim);
    border-bottom:1px solid var(--sh-line);
    font-family:"SF Mono",ui-monospace,Menlo,monospace;word-break:break-all;
  }
  .sh-footer{
    border-top:1px solid var(--sh-line);
    background:var(--sh-bg);color:var(--sh-dim);
    font-size:12px;padding:18px 20px;
    text-align:center;letter-spacing:.02em;line-height:1.7;
  }
  .sh-footer a{color:var(--sh-dim);text-decoration:none;transition:color .1s;}
  .sh-footer a:hover{color:var(--sh-accent);}

  /* Hide old page-level topnav/footer when shared.js takes over */
  .topnav{display:none!important;}
  footer{display:none!important;}

  @media(max-width:560px){
    .sh-nav a{padding:6px 7px;font-size:12px;}
    .sh-header-inner{gap:10px;padding:10px 12px;}
    .sh-logo{font-size:12px;letter-spacing:.14em;}
  }
  `;

  // Inject style
  const styleTag = document.createElement('style');
  styleTag.textContent = CSS;
  document.head.appendChild(styleTag);

  // Detect current page for active nav highlight
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // Build nav links
  const NAV = [
    { href:'index.html',    label:'首页',       match:['index.html',''] },
    { href:'workshop.html', label:'创意工坊',   match:['workshop.html'] },
    { href:'wrong.html',    label:'错题集',     match:['wrong.html'] },
  ];
  function isActive(matches){ return matches.includes(page); }

  // Build header HTML
  const headerHTML = `
  <header class="sh-header">
    <div class="sh-header-inner">
      <a class="sh-logo" href="index.html">Vocab Compete</a>
      <nav class="sh-nav">
        ${NAV.map(n => `<a href="${n.href}" class="${isActive(n.match)?'sh-active':''}">${n.label}</a>`).join('')}
      </nav>
      <div class="sh-spacer"></div>
      <div class="sh-avatar-wrap" id="shAvatarWrap">
        <div class="sh-avatar" id="shAvatar" title="账户">?</div>
        <div class="sh-dropdown" id="shDropdown"></div>
      </div>
    </div>
  </header>`;

  const footerHTML = `
  <footer class="sh-footer">
    Vocab Compete · 例句来自真实出版物 / 新闻媒体 / 词典语料库<br>
    队列闯关：答错 → 原地重做 + 插入队尾 · 只有首次答对才算通过
  </footer>`;

  // Insert header at top of body (or after existing header if any)
  function inject(){
    // Remove any existing sh-header/sh-footer
    document.querySelectorAll('.sh-header,.sh-footer').forEach(n=>n.remove());

    const body = document.body;
    if(!body) return;

    const headerEl = document.createElement('div');
    headerEl.innerHTML = headerHTML;
    body.insertBefore(headerEl.firstElementChild, body.firstChild);

    const footerEl = document.createElement('div');
    footerEl.innerHTML = footerHTML;
    body.appendChild(footerEl.firstElementChild);

    initAvatar();
  }

  function initialFromEmail(email){
    if(!email) return '?';
    const c = email.charAt(0).toUpperCase();
    return /[A-Z0-9]/.test(c) ? c : '?';
  }

  async function initAvatar(){
    const avatarEl = document.getElementById('shAvatar');
    const dropdownEl = document.getElementById('shDropdown');
    if(!avatarEl || !dropdownEl) return;

    let user = null;
    try {
      // Try /api/user first
      const r = await fetch('/api/user', { credentials:'same-origin' });
      if(r.ok){
        user = await r.json();
      } else if(r.status === 401){
        // Not logged in — show "登录" dropdown
        avatarEl.textContent = 'G';
        dropdownEl.innerHTML = `
          <a class="sh-dd-item" href="login.html">登录</a>
          <a class="sh-dd-item" href="register.html">注册</a>`;
        setupDropdownToggle(avatarEl, dropdownEl);
        return;
      }
    } catch(e) { /* offline */ }

    // Offline mode: check localStorage
    if(!user){
      try {
        const raw = localStorage.getItem('vocab_session');
        if(raw) user = JSON.parse(raw);
      } catch(e){}
    }

    if(user){
      if(user.avatar){
        avatarEl.innerHTML = `<img src="${user.avatar}" alt="头像">`;
      } else {
        avatarEl.textContent = initialFromEmail(user.email);
      }
      const email = user.email || '';
      dropdownEl.innerHTML = `
        <div class="sh-dd-email">${email}</div>
        <a class="sh-dd-item" href="account.html">账户设置</a>
        <button class="sh-dd-item danger" id="shLogout">退出登录</button>`;
      setupDropdownToggle(avatarEl, dropdownEl);
      wireDropdownActions(user);
    } else {
      avatarEl.textContent = 'G';
      dropdownEl.innerHTML = `
        <a class="sh-dd-item" href="login.html">登录</a>
        <a class="sh-dd-item" href="register.html">注册</a>`;
      setupDropdownToggle(avatarEl, dropdownEl);
    }
  }

  function setupDropdownToggle(trigger, menu){
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if(!menu.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)){
        menu.classList.remove('open');
      }
    });
  }

  function wireDropdownActions(user){
    const logoutBtn = document.getElementById('shLogout');
    const dropdownEl = document.getElementById('shDropdown');

    if(logoutBtn){
      logoutBtn.addEventListener('click', async () => {
        dropdownEl.classList.remove('open');
        try { await fetch('/api/logout', { method:'POST', credentials:'same-origin' }); } catch(e){}
        try { localStorage.removeItem('vocab_session'); } catch(e){}
        toast('已退出','ok');
        setTimeout(() => { location.href = 'login.html'; }, 400);
      });
    }
  }

  // Resize image via canvas → JPEG data URL (max w×h)
  function resizeImage(file, maxW, maxH, quality){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if(w > maxW || h > maxH){
            const ratio = Math.min(maxW/w, maxH/h);
            w = Math.round(w*ratio);
            h = Math.round(h*ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#101013';
          ctx.fillRect(0,0,w,h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function toast(msg, kind){
    let t = document.getElementById('shToast');
    if(!t){
      t = document.createElement('div');
      t.id = 'shToast';
      t.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#17171B;border:1px solid #2B2B31;color:#F4F4F1;padding:10px 18px;font-size:13px;z-index:9999;opacity:0;transition:opacity .2s;pointer-events:none;';
      document.body.appendChild(t);
    }
    t.style.opacity = '0';
    t.textContent = msg;
    if(kind==='ok'){ t.style.borderColor='#33502B'; t.style.color='#6FDD8B'; }
    else if(kind==='err'){ t.style.borderColor='#5C2A28'; t.style.color='#FF5449'; }
    setTimeout(()=>t.style.opacity='1',10);
    setTimeout(()=>t.style.opacity='0',2200);
  }

  // Expose helpers for pages (e.g. account.html avatar management)
  window.SH = {
    resizeImage,
    toast,
    setAvatar(u){
      const el = document.getElementById('shAvatar');
      if(!el) return;
      if(u && u.avatar){ el.innerHTML = '<img src="' + u.avatar + '" alt="头像">'; }
      else { el.textContent = initialFromEmail(u && u.email); }
    }
  };

  // Inject when DOM ready
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
