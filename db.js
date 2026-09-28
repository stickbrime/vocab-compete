/**
 * db.js — Unified data layer
 * Uses real backend API when available, falls back to localStorage on static hosts (Netlify).
 * All pages should load this BEFORE their own <script>.
 */
const DB = (() => {
  let _online = null; // null = unknown, true/false after probe

  async function probe() {
    if (_online !== null) return _online;
    try {
      const r = await fetch('/api/user', { credentials: 'same-origin' });
      // Check content-type to distinguish real API from static host returning index.html
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        _online = true; // Real backend responding with JSON
      } else {
        _online = false; // Static host returned HTML (SPA redirect)
      }
    } catch(e) {
      _online = false;
    }
    return _online;
  }

  // --- localStorage helpers ---
  function lsKey(k) { return 'vocab_' + k; }
  function lsGet(k, def) { try { return JSON.parse(localStorage.getItem(lsKey(k))) ?? def; } catch { return def; } }
  function lsSet(k, v) { localStorage.setItem(lsKey(k), JSON.stringify(v)); }

  function lsCurrentUser() {
    return lsGet('session', null); // { id, email }
  }
  function lsSetUser(u) { lsSet('session', u); }
  function lsClearUser() { localStorage.removeItem(lsKey('session')); }

  function lsGetUsers() { return lsGet('users', {}); } // { email: { id, email, password } }
  function lsSetUsers(u) { lsSet('users', u); }

  function lsUserSetsKey(userId) { return 'sets_' + userId; }
  function lsGetSets(userId) { return lsGet(lsUserSetsKey(userId), {}); } // { id: setObj }
  function lsSetSets(userId, sets) { lsSet(lsUserSetsKey(userId), sets); }

  // Simple hash for localStorage mode (not crypto-secure, but fine for a study app)
  function simpleHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return 'h' + Math.abs(h).toString(36);
  }

  // --- Public API ---
  return {
    probe,
    isOnline: () => _online,

    async getUser() {
      if (await probe()) {
        const r = await fetch('/api/user');
        if (!r.ok) throw new Error('not logged in');
        return await r.json();
      }
      const s = lsCurrentUser();
      if (!s) throw new Error('not logged in');
      return s;
    },

    async login(email, password) {
      if (await probe()) {
        const r = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '登录失败');
        return d;
      }
      // localStorage mode
      const users = lsGetUsers();
      const u = users[email];
      if (!u || u.password !== simpleHash(password)) throw new Error('邮箱或密码不正确');
      const sess = { id: u.id, email: u.email };
      lsSetUser(sess);
      return sess;
    },

    async register(email, password) {
      if (await probe()) {
        const r = await fetch('/api/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '注册失败');
        return d;
      }
      // localStorage mode
      if (password.length < 6) throw new Error('密码至少 6 位');
      const users = lsGetUsers();
      if (users[email]) throw new Error('该邮箱已注册');
      const u = { id: 'u_' + Date.now().toString(36), email, password: simpleHash(password) };
      users[email] = u;
      lsSetUsers(users);
      const sess = { id: u.id, email: u.email };
      lsSetUser(sess);
      return sess;
    },

    async logout() {
      if (await probe()) {
        try { await fetch('/api/logout', { method: 'POST' }); } catch(e) {}
        return;
      }
      lsClearUser();
    },

    async getSets() {
      if (await probe()) {
        const r = await fetch('/api/sets');
        if (!r.ok) throw new Error('not logged in');
        return await r.json();
      }
      const s = lsCurrentUser();
      if (!s) throw new Error('not logged in');
      return lsGetSets(s.id);
    },

    async saveSet(set) {
      if (await probe()) {
        const r = await fetch('/api/sets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(set)
        });
        if (!r.ok) throw new Error('save failed');
        return await r.json();
      }
      const s = lsCurrentUser();
      const sets = lsGetSets(s.id);
      sets[set.id] = set;
      lsSetSets(s.id, sets);
      return set;
    },

    async deleteSet(id) {
      if (await probe()) {
        await fetch('/api/sets/' + encodeURIComponent(id), { method: 'DELETE' });
        return;
      }
      const s = lsCurrentUser();
      const sets = lsGetSets(s.id);
      delete sets[id];
      lsSetSets(s.id, sets);
    },

    async saveProgress(id, data) {
      if (await probe()) {
        await fetch('/api/sets/' + encodeURIComponent(id) + '/progress', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data), keepalive: true
        });
        return;
      }
      const s = lsCurrentUser();
      const sets = lsGetSets(s.id);
      if (sets[id]) {
        Object.assign(sets[id], data);
        lsSetSets(s.id, sets);
      }
    },

    async removeWrong(setId, idx) {
      if (await probe()) {
        await fetch('/api/sets/' + encodeURIComponent(setId) + '/wrong/' + idx, { method: 'DELETE' });
        return;
      }
      const s = lsCurrentUser();
      const sets = lsGetSets(s.id);
      if (sets[setId] && Array.isArray(sets[setId].wrong)) {
        sets[setId].wrong = sets[setId].wrong.filter(i => i !== idx);
        lsSetSets(s.id, sets);
      }
    },

    async getWrongWords() {
      if (await probe()) {
        const r = await fetch('/api/wrong-words');
        if (!r.ok) throw new Error('not logged in');
        return await r.json();
      }
      const s = lsCurrentUser();
      const sets = lsGetSets(s.id);
      const result = [];
      Object.entries(sets).forEach(([id, set]) => {
        (set.wrong || []).forEach(idx => {
          const item = set.items && set.items[idx];
          if (item) result.push({ setId: id, setName: set.name, idx, item });
        });
      });
      return result;
    },

    async getStats() {
      if (await probe()) {
        const r = await fetch('/api/user/stats');
        if (!r.ok) throw new Error('not logged in');
        return await r.json();
      }
      const s = lsCurrentUser();
      const sets = lsGetSets(s.id);
      let totalWords = 0, totalMastered = 0, totalWrong = 0;
      Object.values(sets).forEach(set => {
        totalWords += (set.items || []).length;
        totalMastered += (set.mastered || []).length;
        totalWrong += (set.wrong || []).length;
      });
      return { setCount: Object.keys(sets).length, totalWords, totalMastered, totalWrong };
    },

    async changePassword(currentPassword, newPassword) {
      if (await probe()) {
        const r = await fetch('/api/user/password', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '更新失败');
        return d;
      }
      if (newPassword.length < 6) throw new Error('新密码至少 6 位');
      const s = lsCurrentUser();
      const users = lsGetUsers();
      const u = users[s.email];
      if (!u || u.password !== simpleHash(currentPassword)) throw new Error('当前密码不正确');
      u.password = simpleHash(newPassword);
      users[s.email] = u;
      lsSetUsers(users);
      return { ok: true };
    }
  };
})();
