var origin = window.location.origin;
document.getElementById('openai-url').textContent = origin + '/v1';
document.getElementById('anthropic-url').textContent = origin;

// Toast notification
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function () { t.classList.remove('show'); }, 2000);
}

function copyText(targetId) {
  navigator.clipboard.writeText(document.getElementById(targetId).textContent)
    .then(function () { showToast('Copied to clipboard!'); });
}
document.querySelectorAll('.btn-copy[data-target]').forEach(function (btn) {
  btn.addEventListener('click', function () { copyText(btn.getAttribute('data-target')); });
});

// ── Instance state (cached) ───────────────────────────────────────────────
var _instances = [];

async function loadInstances() {
  try {
    var res = await fetch('/webmodel/instances');
    var data = await res.json();
    _instances = data.instances || [];
    window._instances = _instances; // expose for inline HTML handlers
    renderInstanceSelect();
  } catch (e) {
    _instances = [];
  }
}

function renderInstanceSelect() {
  var sel = document.getElementById('instance-select');
  if (!sel) return;
  var prev = sel.value;
  sel.textContent = '';
  _instances.forEach(function (inst) {
    var opt = document.createElement('option');
    opt.value = inst.id;
    opt.textContent = inst.label + (inst.providers.length ? ' (' + inst.providers.join(', ') + ')' : '');
    sel.appendChild(opt);
  });
  if (prev && _instances.some(function(i) { return i.id === prev; })) sel.value = prev;
}

function getSelectedInstanceId() {
  var sel = document.getElementById('instance-select');
  return sel ? sel.value : (_instances[0] && _instances[0].id);
}

// Instance CRUD
async function createInstance() {
  var label = window.prompt('Name for the new browser instance (e.g. "Personal", "Work"):');
  if (!label || !label.trim()) return;
  await fetch('/webmodel/instances/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: label.trim() }),
  });
  await loadInstances();
  await loadProviders();
}

async function renameInstance(instanceId, currentLabel) {
  var label = window.prompt('New name:', currentLabel);
  if (!label || !label.trim()) return;
  await fetch('/webmodel/instances/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId, label: label.trim() }),
  });
  await loadInstances();
  await loadProviders();
}

async function removeInstance(instanceId) {
  if (!window.confirm('Remove this browser instance and ALL its saved cookies?')) return;
  await fetch('/webmodel/instances/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId }),
  });
  await loadInstances();
  await loadProviders();
  showToast('Instance removed');
}

// ── Provider list ─────────────────────────────────────────────────────────
async function loadProviders() {
  try {
    var res = await fetch('/webmodel/providers');
    var data = await res.json();
    var list = document.getElementById('provider-list');
    var countEl = document.getElementById('provider-count');

    if (!data.providers || data.providers.length === 0) {
      list.innerHTML = '<div class="empty">No providers configured.</div>';
      countEl.textContent = '0 / 0';
      return;
    }

    var authCount = data.providers.filter(function (p) { return p.authenticated; }).length;
    countEl.textContent = authCount + ' / ' + data.providers.length + ' active';
    list.textContent = '';

    data.providers.forEach(function (p) {
      var accounts = p.accounts || [];

      // Provider header row
      var row = document.createElement('div');
      row.className = 'provider-row';

      var left = document.createElement('div');
      left.className = 'provider-left';

      var dot = document.createElement('div');
      dot.className = 'status-indicator ' + (p.authenticated ? 'active' : 'inactive');
      left.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.className = 'provider-name';
      nameEl.textContent = p.name;
      left.appendChild(nameEl);

      var idEl = document.createElement('span');
      idEl.className = 'provider-id';
      idEl.textContent = p.id;
      left.appendChild(idEl);

      row.appendChild(left);

      var right = document.createElement('div');
      right.className = 'provider-right';

      if (accounts.length > 0) {
        var badge = document.createElement('span');
        badge.className = 'model-badge';
        badge.textContent = accounts.length + ' account' + (accounts.length > 1 ? 's' : '') +
          (p.modelCount ? ' · ' + p.modelCount + ' models' : '');
        right.appendChild(badge);
      }

      // "Login / + Add Account" button
      var addBtn = document.createElement('button');
      addBtn.className = 'btn-login';
      addBtn.textContent = accounts.length > 0 ? '+ Add Account' : 'Login';
      (function (pid) {
        addBtn.addEventListener('click', function () {
          var instanceId = getSelectedInstanceId();
          if (!instanceId) {
            showToast('Create a browser instance first');
            return;
          }
          var instLabel = (_instances.find(function(i) { return i.id === instanceId; }) || {}).label || '';
          var accountLabel = window.prompt(
            'Label for this account in "' + instLabel + '":\n(e.g. "Personal", "Work" — or leave blank to use instance name)',
            instLabel
          );
          if (accountLabel === null) return; // cancelled
          loginProvider(pid, instanceId, accountLabel.trim() || instLabel);
        });
      })(p.id);
      right.appendChild(addBtn);

      row.appendChild(right);
      list.appendChild(row);

      // Account sub-rows
      accounts.forEach(function (acc) {
        var instLabel = (_instances.find(function(i) { return i.id === acc.instanceId; }) || {}).label || acc.instanceId;
        var accRow = document.createElement('div');
        accRow.className = 'account-row' + (acc.id === p.activeAccountId ? ' account-active' : '');

        var accLeft = document.createElement('div');
        accLeft.className = 'account-left';

        var accDot = document.createElement('div');
        accDot.className = 'status-indicator ' + (acc.status === 'active' ? 'active' : 'inactive');
        accLeft.appendChild(accDot);

        var accLabel = document.createElement('span');
        accLabel.className = 'account-label';
        accLabel.textContent = acc.label;
        accLeft.appendChild(accLabel);

        // Show which instance this account's cookies live in
        var instBadge = document.createElement('span');
        instBadge.className = 'instance-badge';
        instBadge.textContent = instLabel;
        accLeft.appendChild(instBadge);

        if (acc.id === p.activeAccountId) {
          var activePill = document.createElement('span');
          activePill.className = 'active-pill';
          activePill.textContent = 'active';
          accLeft.appendChild(activePill);
        }

        accRow.appendChild(accLeft);

        var accRight = document.createElement('div');
        accRight.className = 'account-right';

        if (acc.id !== p.activeAccountId && accounts.length > 1) {
          var setActiveBtn = document.createElement('button');
          setActiveBtn.className = 'btn-sm';
          setActiveBtn.textContent = 'Set Active';
          (function (pid, aid) {
            setActiveBtn.addEventListener('click', function () { setActiveAccount(pid, aid); });
          })(p.id, acc.id);
          accRight.appendChild(setActiveBtn);
        }

        var renameBtn = document.createElement('button');
        renameBtn.className = 'btn-sm';
        renameBtn.textContent = 'Rename';
        (function (pid, aid, lbl) {
          renameBtn.addEventListener('click', function () {
            var nl = window.prompt('New label:', lbl);
            if (nl && nl.trim()) renameAccount(pid, aid, nl.trim());
          });
        })(p.id, acc.id, acc.label);
        accRight.appendChild(renameBtn);

        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn-sm btn-danger';
        removeBtn.textContent = 'Remove';
        (function (pid, aid) {
          removeBtn.addEventListener('click', function () {
            if (window.confirm('Remove this account?')) removeAccount(pid, aid);
          });
        })(p.id, acc.id);
        accRight.appendChild(removeBtn);

        accRow.appendChild(accRight);
        list.appendChild(accRow);
      });
    });
  } catch (err) {
    document.getElementById('provider-list').innerHTML = '<div class="error">Failed to load: ' + err.message + '</div>';
  }
}

// ── Login ─────────────────────────────────────────────────────────────────
async function loginProvider(providerId, instanceId, accountLabel) {
  try {
    showToast('Opening browser for ' + providerId + '...');
    var res = await fetch('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, instanceId, accountLabel }),
    });
    var data = await res.json();
    if (data.status === 'login_started') {
      showToast(data.message || 'Browser opened. Please log in.');
      pollLoginStatus(providerId);
    } else {
      showToast(data.message || data.error || 'Login failed');
    }
  } catch (err) {
    showToast('Login failed: ' + err.message);
  }
}

// ── Account management ────────────────────────────────────────────────────
async function setActiveAccount(providerId, accountId) {
  await fetch('/webmodel/auth/accounts/activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, accountId }),
  });
  showToast('Active account updated');
  loadProviders();
}

async function renameAccount(providerId, accountId, label) {
  await fetch('/webmodel/auth/accounts/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, accountId, label }),
  });
  showToast('Account renamed');
  loadProviders();
}

async function removeAccount(providerId, accountId) {
  await fetch('/webmodel/auth/accounts/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, accountId }),
  });
  showToast('Account removed');
  loadProviders();
  loadHealth();
}

// ── Poll login status ─────────────────────────────────────────────────────
function pollLoginStatus(providerId) {
  var interval = setInterval(async function () {
    try {
      var statusRes = await fetch('/webmodel/auth/login-status');
      var statusData = await statusRes.json();
      if (statusData.status === 'waiting_for_user') {
        showToast('Waiting for login in browser window...');
      } else if (statusData.status === 'success') {
        clearInterval(interval);
        showToast(providerId + ' login completed!');
        loadInstances(); loadProviders(); loadHealth();
        return;
      } else if (statusData.status === 'failed') {
        clearInterval(interval);
        showToast('Login failed: ' + statusData.message);
        return;
      }
      var res = await fetch('/webmodel/providers');
      var data = await res.json();
      var provider = data.providers.find(function (p) { return p.id === providerId; });
      if (provider && provider.authenticated) {
        clearInterval(interval);
        showToast(providerId + ' authenticated!');
        loadInstances(); loadProviders(); loadHealth();
      }
    } catch (e) { /* retry */ }
  }, 2000);
  setTimeout(function () { clearInterval(interval); }, 120000);
}

// ── Health ────────────────────────────────────────────────────────────────
async function loadHealth() {
  try {
    var res = await fetch('/webmodel/health');
    var data = await res.json();
    var el = document.getElementById('health-info');
    var seconds = data.uptime || 0;
    var uptime = seconds < 60 ? seconds + 's'
      : seconds < 3600 ? Math.floor(seconds / 60) + 'm'
      : Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    var browserStatus = data.browser ? data.browser.status : 'unknown';
    el.textContent = '';
    [
      { label: 'Status', value: data.status || 'unknown', cls: data.status === 'healthy' ? 'green' : '' },
      { label: 'Uptime', value: uptime, cls: '' },
      { label: 'Browser', value: browserStatus, cls: browserStatus === 'running' ? 'green' : '' },
      { label: 'Instances', value: String(data.instances || 0), cls: '' },
    ].forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'stat-item';
      var label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.label;
      div.appendChild(label);
      var val = document.createElement('span');
      val.className = 'stat-value' + (item.cls ? ' ' + item.cls : '');
      val.textContent = item.value;
      div.appendChild(val);
      el.appendChild(div);
    });
  } catch (e) {
    document.getElementById('health-info').innerHTML = '<div class="error">Unable to reach server</div>';
  }
}

// ── Initial load ──────────────────────────────────────────────────────────
loadInstances().then(loadProviders);
loadHealth();
setInterval(function () { loadInstances().then(loadProviders); loadHealth(); }, 10000);

document.getElementById('openai-url').textContent = origin + '/v1';
document.getElementById('anthropic-url').textContent = origin;

// Toast notification
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function () {
    t.classList.remove('show');
  }, 2000);
}

// Copy URL — uses data-target attribute instead of inline onclick
function copyText(targetId) {
  var text = document.getElementById(targetId).textContent;
  navigator.clipboard.writeText(text).then(function () {
    showToast('Copied to clipboard!');
  });
}

// Bind copy buttons via data-target (no inline handlers)
document.querySelectorAll('.btn-copy[data-target]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    copyText(btn.getAttribute('data-target'));
  });
});

// ── Account label prompt ──────────────────────────────────────────────────
function promptAccountLabel(providerId) {
  var label = window.prompt(
    'Label for this account (e.g. "Personal", "Work"):\n\nProvider: ' + providerId,
    'Account'
  );
  return label === null ? null : (label.trim() || 'Account');
}

// ── Load providers list ───────────────────────────────────────────────────
async function loadProviders() {
  try {
    var res = await fetch('/webmodel/providers');
    var data = await res.json();
    var list = document.getElementById('provider-list');
    var countEl = document.getElementById('provider-count');

    if (!data.providers || data.providers.length === 0) {
      list.textContent = '';
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty';
      emptyDiv.textContent = 'No providers configured.';
      list.appendChild(emptyDiv);
      countEl.textContent = '0 / 0';
      return;
    }

    var authCount = data.providers.filter(function (p) {
      return p.authenticated;
    }).length;
    countEl.textContent = authCount + ' / ' + data.providers.length + ' active';

    list.textContent = '';

    data.providers.forEach(function (p) {
      var accounts = p.accounts || [];
      var hasAccounts = accounts.length > 0;

      // ── Provider header row ──
      var row = document.createElement('div');
      row.className = 'provider-row';

      var left = document.createElement('div');
      left.className = 'provider-left';

      var dot = document.createElement('div');
      dot.className = 'status-indicator ' + (p.authenticated ? 'active' : 'inactive');
      left.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.className = 'provider-name';
      nameEl.textContent = p.name;
      left.appendChild(nameEl);

      var idEl = document.createElement('span');
      idEl.className = 'provider-id';
      idEl.textContent = p.id;
      left.appendChild(idEl);

      row.appendChild(left);

      var right = document.createElement('div');
      right.className = 'provider-right';

      if (hasAccounts) {
        var badge = document.createElement('span');
        badge.className = 'model-badge';
        badge.textContent = accounts.length + ' account' + (accounts.length > 1 ? 's' : '') +
          (p.modelCount ? ' · ' + p.modelCount + ' models' : '');
        right.appendChild(badge);
      }

      // "Add Account" button — always visible
      var addBtn = document.createElement('button');
      addBtn.className = 'btn-login';
      addBtn.textContent = hasAccounts ? '+ Add Account' : 'Login';
      addBtn.addEventListener('click', function () {
        var label = promptAccountLabel(p.id);
        if (label !== null) loginProvider(p.id, label);
      });
      right.appendChild(addBtn);

      row.appendChild(right);
      list.appendChild(row);

      // ── Account sub-rows ──
      accounts.forEach(function (acc) {
        var accRow = document.createElement('div');
        accRow.className = 'account-row' + (acc.id === p.activeAccountId ? ' account-active' : '');

        var accLeft = document.createElement('div');
        accLeft.className = 'account-left';

        var accDot = document.createElement('div');
        accDot.className = 'status-indicator ' + (acc.status === 'active' ? 'active' : 'inactive');
        accLeft.appendChild(accDot);

        var accLabel = document.createElement('span');
        accLabel.className = 'account-label';
        accLabel.textContent = acc.label;
        accLeft.appendChild(accLabel);

        if (acc.id === p.activeAccountId) {
          var activePill = document.createElement('span');
          activePill.className = 'active-pill';
          activePill.textContent = 'active';
          accLeft.appendChild(activePill);
        }

        accRow.appendChild(accLeft);

        var accRight = document.createElement('div');
        accRight.className = 'account-right';

        // Set active button (only if not already active)
        if (acc.id !== p.activeAccountId && accounts.length > 1) {
          var setActiveBtn = document.createElement('button');
          setActiveBtn.className = 'btn-sm';
          setActiveBtn.textContent = 'Set Active';
          (function (pid, aid) {
            setActiveBtn.addEventListener('click', function () {
              setActiveAccount(pid, aid);
            });
          })(p.id, acc.id);
          accRight.appendChild(setActiveBtn);
        }

        // Rename button
        var renameBtn = document.createElement('button');
        renameBtn.className = 'btn-sm';
        renameBtn.textContent = 'Rename';
        (function (pid, aid, currentLabel) {
          renameBtn.addEventListener('click', function () {
            var newLabel = window.prompt('New label:', currentLabel);
            if (newLabel && newLabel.trim()) renameAccount(pid, aid, newLabel.trim());
          });
        })(p.id, acc.id, acc.label);
        accRight.appendChild(renameBtn);

        // Remove button
        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn-sm btn-danger';
        removeBtn.textContent = 'Remove';
        (function (pid, aid) {
          removeBtn.addEventListener('click', function () {
            if (window.confirm('Remove this account?')) removeAccount(pid, aid);
          });
        })(p.id, acc.id);
        accRight.appendChild(removeBtn);

        accRow.appendChild(accRight);
        list.appendChild(accRow);
      });
    });
  } catch (err) {
    var list = document.getElementById('provider-list');
    list.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Failed to load: ' + err.message;
    list.appendChild(errDiv);
  }
}

// ── Login / add account ───────────────────────────────────────────────────
async function loginProvider(providerId, accountLabel) {
  try {
    showToast('Opening browser for ' + providerId + '...');
    var res = await fetch('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: providerId, accountLabel: accountLabel }),
    });
    var data = await res.json();
    if (data.status === 'login_started') {
      showToast(data.message || 'Browser window opened. Please log in.');
      pollLoginStatus(providerId);
    } else if (data.status === 'error' || data.error) {
      showToast(data.message || data.error || 'Login failed');
    }
  } catch (err) {
    showToast('Login failed: ' + err.message);
  }
}

// ── Account management actions ────────────────────────────────────────────
async function setActiveAccount(providerId, accountId) {
  try {
    await fetch('/webmodel/auth/accounts/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, accountId }),
    });
    showToast('Active account updated');
    loadProviders();
  } catch (err) {
    showToast('Failed: ' + err.message);
  }
}

async function renameAccount(providerId, accountId, label) {
  try {
    await fetch('/webmodel/auth/accounts/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, accountId, label }),
    });
    showToast('Account renamed');
    loadProviders();
  } catch (err) {
    showToast('Failed: ' + err.message);
  }
}

async function removeAccount(providerId, accountId) {
  try {
    await fetch('/webmodel/auth/accounts/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, accountId }),
    });
    showToast('Account removed');
    loadProviders();
    loadHealth();
  } catch (err) {
    showToast('Failed: ' + err.message);
  }
}

// ── Poll login status ─────────────────────────────────────────────────────
function pollLoginStatus(providerId) {
  var interval = setInterval(async function () {
    try {
      var statusRes = await fetch('/webmodel/auth/login-status');
      var statusData = await statusRes.json();
      if (statusData.status === 'waiting_for_user') {
        showToast('Waiting for you to log in at the browser window...');
      } else if (statusData.status === 'success') {
        clearInterval(interval);
        showToast(providerId + ' login completed!');
        loadProviders();
        loadHealth();
        return;
      } else if (statusData.status === 'failed') {
        clearInterval(interval);
        showToast('Login failed: ' + statusData.message);
        return;
      }

      // Backup: check provider status
      var res = await fetch('/webmodel/providers');
      var data = await res.json();
      var provider = data.providers.find(function (p) {
        return p.id === providerId;
      });
      if (provider && provider.authenticated) {
        clearInterval(interval);
        showToast(providerId + ' authenticated!');
        loadProviders();
        loadHealth();
      }
    } catch (e) {
      /* retry */
    }
  }, 2000);
  setTimeout(function () {
    clearInterval(interval);
  }, 120000);
}

// ── Health stats ──────────────────────────────────────────────────────────
async function loadHealth() {
  try {
    var res = await fetch('/webmodel/health');
    var data = await res.json();
    var el = document.getElementById('health-info');

    var seconds = data.uptime || 0;
    var uptime =
      seconds < 60
        ? seconds + 's'
        : seconds < 3600
          ? Math.floor(seconds / 60) + 'm'
          : Math.floor(seconds / 3600) +
            'h ' +
            Math.floor((seconds % 3600) / 60) +
            'm';

    var browserStatus = data.browser ? data.browser.status : 'unknown';

    el.textContent = '';

    var items = [
      {
        label: 'Status',
        value: data.status || 'unknown',
        cls: data.status === 'healthy' ? 'green' : '',
      },
      { label: 'Uptime', value: uptime, cls: '' },
      {
        label: 'Browser',
        value: browserStatus,
        cls: browserStatus === 'running' ? 'green' : '',
      },
    ];

    items.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'stat-item';

      var label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.label;
      div.appendChild(label);

      var val = document.createElement('span');
      val.className = 'stat-value' + (item.cls ? ' ' + item.cls : '');
      val.textContent = item.value;
      div.appendChild(val);

      el.appendChild(div);
    });
  } catch (e) {
    var el = document.getElementById('health-info');
    el.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Unable to reach server';
    el.appendChild(errDiv);
  }
}

// Initial load + auto-refresh every 10s
loadProviders();
loadHealth();
setInterval(function () {
  loadProviders();
  loadHealth();
}, 10000);


// Toast notification
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function () {
    t.classList.remove('show');
  }, 2000);
}

// Copy URL — uses data-target attribute instead of inline onclick
function copyText(targetId) {
  var text = document.getElementById(targetId).textContent;
  navigator.clipboard.writeText(text).then(function () {
    showToast('Copied to clipboard!');
  });
}

// Bind copy buttons via data-target (no inline handlers)
document.querySelectorAll('.btn-copy[data-target]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    copyText(btn.getAttribute('data-target'));
  });
});

// Load providers list
async function loadProviders() {
  try {
    var res = await fetch('/webmodel/providers');
    var data = await res.json();
    var list = document.getElementById('provider-list');
    var countEl = document.getElementById('provider-count');

    if (!data.providers || data.providers.length === 0) {
      list.textContent = '';
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty';
      emptyDiv.textContent = 'No providers configured.';
      list.appendChild(emptyDiv);
      countEl.textContent = '0 / 0';
      return;
    }

    var authCount = data.providers.filter(function (p) {
      return p.authenticated;
    }).length;
    countEl.textContent = authCount + ' / ' + data.providers.length + ' active';

    list.textContent = '';

    data.providers.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'provider-row';

      var left = document.createElement('div');
      left.className = 'provider-left';

      var dot = document.createElement('div');
      dot.className =
        'status-indicator ' + (p.authenticated ? 'active' : 'inactive');
      left.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.className = 'provider-name';
      nameEl.textContent = p.name;
      left.appendChild(nameEl);

      var idEl = document.createElement('span');
      idEl.className = 'provider-id';
      idEl.textContent = p.id;
      left.appendChild(idEl);

      row.appendChild(left);

      var right = document.createElement('div');
      right.className = 'provider-right';

      if (p.authenticated) {
        var badge = document.createElement('span');
        badge.className = 'model-badge';
        badge.textContent = p.modelCount + ' models';
        right.appendChild(badge);
      } else {
        var btn = document.createElement('button');
        btn.className = 'btn-login';
        btn.textContent = 'Login';
        btn.addEventListener('click', function () {
          loginProvider(p.id);
        });
        right.appendChild(btn);
      }

      row.appendChild(right);
      list.appendChild(row);
    });
  } catch (err) {
    var list = document.getElementById('provider-list');
    list.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Failed to load: ' + err.message;
    list.appendChild(errDiv);
  }
}

// Login flow
async function loginProvider(providerId) {
  try {
    showToast('Launching Chrome for ' + providerId + '...');
    var res = await fetch('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: providerId }),
    });
    var data = await res.json();
    if (data.status === 'login_started') {
      showToast(data.message || 'Chrome window opened. Please log in.');
      pollLoginStatus(providerId);
    } else if (data.status === 'error' || data.error) {
      showToast(data.message || data.error || 'Login failed');
    }
  } catch (err) {
    showToast('Login failed: ' + err.message);
  }
}

// Poll login status endpoint for real-time feedback
function pollLoginStatus(providerId) {
  var interval = setInterval(async function () {
    try {
      // Check login-status for detailed progress
      var statusRes = await fetch('/webmodel/auth/login-status');
      var statusData = await statusRes.json();
      if (statusData.status === 'waiting_for_user') {
        showToast('Waiting for you to log in at the Chrome window...');
      } else if (statusData.status === 'success') {
        clearInterval(interval);
        showToast(providerId + ' login completed!');
        loadProviders();
        loadHealth();
        return;
      } else if (statusData.status === 'failed') {
        clearInterval(interval);
        showToast('Login failed: ' + statusData.message);
        return;
      }

      // Also check provider status as backup
      var res = await fetch('/webmodel/providers');
      var data = await res.json();
      var provider = data.providers.find(function (p) {
        return p.id === providerId;
      });
      if (provider && provider.authenticated) {
        clearInterval(interval);
        showToast(providerId + ' authenticated!');
        loadProviders();
        loadHealth();
      }
    } catch (e) {
      /* retry */
    }
  }, 2000);
  setTimeout(function () {
    clearInterval(interval);
  }, 120000);
}

// Load system health stats
async function loadHealth() {
  try {
    var res = await fetch('/webmodel/health');
    var data = await res.json();
    var el = document.getElementById('health-info');

    var seconds = data.uptime || 0;
    var uptime =
      seconds < 60
        ? seconds + 's'
        : seconds < 3600
          ? Math.floor(seconds / 60) + 'm'
          : Math.floor(seconds / 3600) +
            'h ' +
            Math.floor((seconds % 3600) / 60) +
            'm';

    var browserStatus = data.browser ? data.browser.status : 'unknown';

    el.textContent = '';

    var items = [
      {
        label: 'Status',
        value: data.status || 'unknown',
        cls: data.status === 'healthy' ? 'green' : '',
      },
      { label: 'Uptime', value: uptime, cls: '' },
      {
        label: 'Browser',
        value: browserStatus,
        cls: browserStatus === 'running' ? 'green' : '',
      },
    ];

    items.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'stat-item';

      var label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.label;
      div.appendChild(label);

      var val = document.createElement('span');
      val.className = 'stat-value' + (item.cls ? ' ' + item.cls : '');
      val.textContent = item.value;
      div.appendChild(val);

      el.appendChild(div);
    });
  } catch (e) {
    var el = document.getElementById('health-info');
    el.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Unable to reach server';
    el.appendChild(errDiv);
  }
}

// Initial load + auto-refresh every 10s
loadProviders();
loadHealth();
setInterval(function () {
  loadProviders();
  loadHealth();
}, 10000);
