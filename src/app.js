/* ============================================================
   前端逻辑：通过 Tauri 全局桥（withGlobalTauri: true）调用 Rust 命令
   - window.__TAURI__.core.invoke('command', args)  → 调后端
   - window.__TAURI__.event.listen('event', cb)      → 收后端事件
   环境守卫：非 Tauri（普通浏览器）下优雅降级，仅保留响应式布局演示
   ============================================================ */
(function () {
  const TAURI = window.__TAURI__ || null;
  const invoke = TAURI ? TAURI.core.invoke
                       : () => Promise.reject(new Error('非 Tauri 环境'));
  const listen = TAURI ? TAURI.event.listen : () => Promise.resolve({ unlisten() {} });

  let monitorPath = '';
  let outputPath = '';
  let watching = false;

  const $ = (id) => document.getElementById(id);
  const monitorPathEl = $('monitorPath');
  const monitorStatusEl = $('monitorStatus');
  const connPill = $('connPill');
  const outPathEl = $('outPath');
  const watchStatEl = $('watchStat');
  const layoutEl = $('layout');
  const fileListEl = $('fileList');
  const fileCountEl = $('fileCount');
  const urlArea = $('urlArea');
  const progressBar = $('progressBar');
  const progressEl = $('progress');
  const pctText = $('pctText');
  const doneNumEl = $('doneNum');
  const failNumEl = $('failNum');
  const totalNumEl = $('totalNum');
  const sizeLabelEl = $('sizeLabel');
  const statusText = $('statusText');
  const logBox = $('logBox');
  const btnDownload = $('btnDownload');
  const btnStop = $('btnStop');

  // 打包后隐藏响应式调试条（浏览器预览才需要）
  document.body.classList.add(TAURI ? 'env-tauri' : 'env-browser');

  // ---------- 空态：列表与日志在任何时候都有占位文案，不留空白盒 ----------
  const EMPTY_FILE = '选择输出目录后显示其中文件';
  const EMPTY_LOG = '暂无日志';
  function setEmpty(box, text) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = text;
    box.appendChild(d);
  }
  setEmpty(logBox, EMPTY_LOG);

  function log(msg, kind) {
    // 智能跟随：仅当用户本就停留在底部附近才自动滚到底，翻看旧日志时不会被拽走
    const nearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
    if (logBox.querySelector('.empty')) logBox.innerHTML = '';
    const t = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.textContent = `[${t}] ${msg}`;
    if (kind === 'ok') div.className = 'lg-ok';
    if (kind === 'err') div.className = 'lg-err';
    if (kind === 'warn') div.className = 'lg-warn';
    logBox.appendChild(div);
    while (logBox.children.length > 200) logBox.removeChild(logBox.firstChild);
    if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function guard() {
    if (!TAURI) { log('当前为普通浏览器预览，原生功能不可用（请用 cargo tauri dev 运行）'); return false; }
    return true;
  }
  function busy(btn, on, label) {
    btn.classList.toggle('is-busy', on);
    if (on) btn.dataset.idleText = btn.dataset.idleText || btn.textContent;
    btn.textContent = on ? label : (btn.dataset.idleText || btn.textContent);
  }
  const baseName = (p) => (p.split(/[\\/]/).pop() || p);

  async function renderList(p) {
    try {
      const files = await invoke('list_directory', { path: p });
      if (!files.length) {
        setEmpty(fileListEl, '该目录暂无文件');
      } else {
        fileListEl.innerHTML = files.map(f => `<div class="fi">${escapeHtml(f)}</div>`).join('');
      }
      fileCountEl.textContent = String(files.length);
    } catch (e) {
      setEmpty(fileListEl, '读取目录失败');
      log('列出目录失败: ' + e, 'err');
    }
  }

  // ---------- 连接状态胶囊 ----------
  if (TAURI) { connPill.textContent = '已连接'; }
  else { connPill.textContent = '预览模式'; connPill.classList.add('preview'); }

  // ---------- 模式切换：批量下载 / 实时监控（互斥） ----------
  const MODE_NAME = { download: '批量下载', watch: '实时监控' };
  let mode = 'download';
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    layoutEl.dataset.mode = m;
    document.querySelectorAll('#modebar .mode-btn').forEach(b => {
      const on = b.dataset.mode === m;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    log(`已切换到「${MODE_NAME[m]}」模式`);
  }
  document.querySelectorAll('#modebar .mode-btn').forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  // ---------- 选择监控目录 ----------
  $('btnMonitorPick').addEventListener('click', async () => {
    if (!guard()) return;
    const p = await invoke('pick_directory');
    if (p) { monitorPath = p; monitorPathEl.textContent = p; log('监控目录: ' + p); }
  });
  $('btnMonitorStart').addEventListener('click', async () => {
    if (!guard()) return;
    if (!monitorPath) { log('请先选择监控目录', 'err'); return; }
    if (watching) { log('监控已在进行中'); return; }
    await invoke('start_watch', { path: monitorPath });
    watching = true;
    monitorStatusEl.textContent = '监控中';
    monitorStatusEl.className = 'pill live';
    log('已开始监控: ' + monitorPath + '（新增 TXT 会自动加入任务列表）', 'ok');
  });

  // ---------- 选择输出目录 ----------
  async function pickOutput() {
    if (!guard()) return;
    const p = await invoke('pick_directory');
    if (p) { outputPath = p; outPathEl.textContent = p; outPathEl.classList.add('filled'); log('输出目录: ' + p); renderList(p); }
  }
  $('btnOutputPick').addEventListener('click', pickOutput);
  $('btnOpenOut').addEventListener('click', async () => {
    if (!guard()) return;
    if (!outputPath) { log('请先选择输出目录', 'err'); return; }
    try { await invoke('open_path', { path: outputPath }); }
    catch (e) { log('打开目录失败: ' + e, 'err'); }
  });

  // ---------- 示例 URL ----------
  $('btnSample').addEventListener('click', () => {
    urlArea.value = [
      'https://picsum.photos/id/1015/600/400',
      'https://picsum.photos/id/1025/600/400',
      'https://picsum.photos/id/1035/600/400'
    ].join('\n');
    log('已填入 3 个示例 URL');
  });

  // ---------- 快捷键：Ctrl+Enter 直接开始下载 ----------
  urlArea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); btnDownload.click(); }
  });

  // ---------- 点击输出路径复制 ----------
  outPathEl.addEventListener('click', () => {
    if (!outputPath) return;
    navigator.clipboard.writeText(outputPath)
      .then(() => log('输出目录路径已复制'))
      .catch(() => log('复制失败', 'err'));
  });

  // ============================================================
  // 高级选项：配置持久化（localStorage）
  //   dedup / subfolder / sheet / autostart / concurrency /
  //   maxCount / conflict / retry / tolerance 全部真实生效
  // ============================================================
  const ADV_KEY = 'imgdl.adv.v2';
  const ADV_DEFAULT = {
    dedup: true, subfolder: false, sheet: false, autostart: false,
    concurrency: 4, maxCount: 5, conflict: 'rename', retry: 1, tolerance: 2
  };
  let adv = { ...ADV_DEFAULT };
  try { adv = { ...ADV_DEFAULT, ...JSON.parse(localStorage.getItem(ADV_KEY) || '{}') }; } catch (_) {}
  const saveAdv = () => { try { localStorage.setItem(ADV_KEY, JSON.stringify(adv)); } catch (_) {} };

  // 「启用计数」= 与默认值不同的项数（dedup 默认开，计 1）
  function advEnabledCount() {
    return (adv.dedup ? 1 : 0) + (adv.subfolder ? 1 : 0) + (adv.sheet ? 1 : 0) + (adv.autostart ? 1 : 0)
      + (adv.concurrency !== 4 ? 1 : 0) + (adv.maxCount !== 5 ? 1 : 0)
      + (adv.conflict !== 'rename' ? 1 : 0) + (adv.retry !== 1 ? 1 : 0) + (adv.tolerance !== 2 ? 1 : 0);
  }
  function renderAdvOn() {
    $('advOn').textContent = `启用 ${advEnabledCount()}/9`;
  }

  // 开关类（autostart 单独走后端）
  for (const [id, key] of [['optDedup', 'dedup'], ['optSubfolder', 'subfolder'], ['optSheet', 'sheet']]) {
    const el = $(id);
    el.checked = !!adv[key];
    el.addEventListener('change', () => {
      adv[key] = el.checked; saveAdv(); renderAdvOn();
      const name = el.closest('.adv-row').querySelector('b').textContent;
      log(`高级选项「${name}」${el.checked ? '开启' : '关闭'}`);
    });
  }
  // 开机启动：以后端状态为准
  const optAutostart = $('optAutostart');
  optAutostart.addEventListener('change', async () => {
    if (!guard()) { optAutostart.checked = adv.autostart; return; }
    try {
      const on = await invoke('autostart_toggle');
      adv.autostart = on; optAutostart.checked = on; saveAdv(); renderAdvOn();
      log(`开机自动启动已${on ? '开启' : '关闭'}`, 'ok');
    } catch (e) {
      optAutostart.checked = adv.autostart;
      log('设置开机启动失败: ' + e, 'err');
    }
  });
  if (TAURI) {
    invoke('autostart_status').then(on => {
      adv.autostart = !!on; optAutostart.checked = !!on; renderAdvOn();
    }).catch(() => {});
  } else {
    optAutostart.checked = !!adv.autostart;
  }
  // 步进器（含表格匹配容差）
  document.querySelectorAll('.stepper').forEach(st => {
    const key = st.dataset.cfg, min = +st.dataset.min, max = +st.dataset.max;
    const out = st.querySelector('output');
    out.textContent = String(adv[key]);
    st.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      adv[key] = Math.min(max, Math.max(min, adv[key] + +b.dataset.step));
      out.textContent = String(adv[key]); saveAdv(); renderAdvOn();
    }));
  });
  // 分段控件（重名冲突）
  document.querySelectorAll('.seg').forEach(seg => {
    const key = seg.dataset.cfg;
    seg.querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.val === adv[key]);
      b.addEventListener('click', () => {
        adv[key] = b.dataset.val; saveAdv(); renderAdvOn();
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      });
    });
  });
  renderAdvOn();

  // ============================================================
  // TXT 任务列表：添加 / 删除 / 清空 / 按名去重
  // ============================================================
  let txtFiles = [];
  const txtListEl = $('txtList');
  const txtCountEl = $('txtCount');
  // 归一化：去掉「名字 (1).txt」里的副本序号，对齐原脚本去重规则
  const normTxtName = (p) => baseName(p).replace(/\s*\(\d+\)(?=\.[^.]+$)/, '');

  function renderTxt() {
    if (!txtFiles.length) {
      setEmpty(txtListEl, '添加包含 URL 的 TXT 文件；留空则按左侧粘贴的 URL 下载');
    } else {
      txtListEl.innerHTML = txtFiles.map((p, i) =>
        `<div class="fi"><span class="fi-name" title="${escapeHtml(p)}">${escapeHtml(baseName(p))}</span>` +
        `<button class="fi-x" data-i="${i}" aria-label="删除">×\u003C/button></div>`
      ).join('');
    }
    txtCountEl.textContent = String(txtFiles.length);
  }
  txtListEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fi-x');
    if (!b) return;
    const i = +b.dataset.i;
    log(`已移除 ${baseName(txtFiles[i])}`);
    txtFiles.splice(i, 1);
    renderTxt();
  });
  $('btnAddTxt').addEventListener('click', async () => {
    if (!guard()) return;
    const files = await invoke('pick_txt_files');
    if (!files || !files.length) return;
    const merged = [...txtFiles, ...files];
    const seenPath = new Set();
    const seenName = new Set();
    let removed = 0;
    txtFiles = [];
    for (const f of merged) {
      if (seenPath.has(f)) { removed++; continue; }
      seenPath.add(f);
      if (adv.dedup) {
        const n = normTxtName(f);
        if (seenName.has(n)) { removed++; continue; }
        seenName.add(n);
      }
      txtFiles.push(f);
    }
    renderTxt();
    log(`添加了 ${files.length} 个文件` + (removed ? `，过滤了 ${removed} 个重复` : ''), 'ok');
  });
  $('btnClearTxt').addEventListener('click', () => {
    if (!txtFiles.length) return;
    txtFiles = [];
    renderTxt();
    log('已清空 TXT 任务列表');
  });
  renderTxt();

  // ============================================================
  // 表格匹配：选表 / 选列 / 容差 / 预览
  // ============================================================
  let tableLoaded = false;
  const matchColEl = $('matchCol');
  const renameColEl = $('renameCol');
  $('btnPickTable').addEventListener('click', async () => {
    if (!guard()) return;
    const p = await invoke('pick_table_file');
    if (!p) return;
    try {
      const info = await invoke('load_table', { path: p });
      const opts = info.columns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      matchColEl.innerHTML = opts;
      renameColEl.innerHTML = opts;
      $('tableName').textContent = baseName(p);
      $('tableTag').textContent = `${info.rows} 行`;
      tableLoaded = true;
      log(`加载表格: ${baseName(p)}（${info.rows} 行）`, 'ok');
    } catch (e) {
      tableLoaded = false;
      $('tableTag').textContent = '未加载';
      log('加载表格失败: ' + e, 'err');
    }
  });
  $('btnPreview').addEventListener('click', async () => {
    if (!guard()) return;
    if (!txtFiles.length) { log('请先添加 TXT 文件', 'err'); return; }
    if (!tableLoaded || !matchColEl.value || !renameColEl.value) { log('请先选择表格文件和列', 'err'); return; }
    try {
      const res = await invoke('preview_match', {
        names: txtFiles.map(baseName),
        matchCol: matchColEl.value,
        renameCol: renameColEl.value,
        tolerance: adv.tolerance
      });
      let hit = 0;
      for (const m of res) {
        if (m.matched) { hit++; log(`${m.name} → ${m.matched}（${(m.ratio * 100).toFixed(1)}%）`); }
        else { log(`${m.name} → 未匹配`, 'err'); }
      }
      log(`共 ${hit}/${res.length} 个文件匹配成功`, hit ? 'ok' : 'err');
    } catch (e) {
      log('匹配预览失败: ' + e, 'err');
    }
  });

  // ============================================================
  // 下载流程：TXT 任务优先，留空走粘贴 URL
  // ============================================================
  async function collectJobs() {
    if (txtFiles.length) {
      let matches = null;
      if (adv.sheet && tableLoaded && matchColEl.value && renameColEl.value) {
        try {
          matches = await invoke('preview_match', {
            names: txtFiles.map(baseName),
            matchCol: matchColEl.value,
            renameCol: renameColEl.value,
            tolerance: adv.tolerance
          });
        } catch (e) {
          log('表格匹配失败，按原文件名处理: ' + e, 'err');
        }
      } else if (adv.sheet) {
        log('表格匹配已开启但表格未加载，按原文件名处理', 'err');
      }
      const jobs = [];
      for (let i = 0; i < txtFiles.length; i++) {
        const p = txtFiles[i];
        const base = baseName(p).replace(/\.[^.]+$/, '');
        const name = (matches && matches[i] && matches[i].matched) || base;
        if (matches && (!matches[i] || !matches[i].matched)) log(`表格未匹配: ${baseName(p)}，按原文件名处理`, 'err');
        let urls;
        try {
          const content = await invoke('read_text', { path: p });
          urls = content.split('\n').map(s => s.trim()).filter(Boolean);
        } catch (e) {
          log(`文件读取失败: ${baseName(p)}`, 'err');
          continue;
        }
        if (adv.maxCount > 0) urls = urls.slice(0, adv.maxCount);
        if (!urls.length) { log(`空文件跳过: ${baseName(p)}`, 'err'); continue; }
        jobs.push({ urls, name, subfolder: adv.subfolder ? name : '' });
      }
      return jobs;
    }
    // 粘贴模式
    let urls = urlArea.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!urls.length) return [];
    const uniq = [...new Set(urls)];
    if (uniq.length !== urls.length) log(`已剔除 ${urls.length - uniq.length} 个重复 URL（剩 ${uniq.length} 个）`);
    return [{ urls: uniq, name: '', subfolder: '' }];
  }

  btnDownload.addEventListener('click', async () => {
    if (!guard()) return;
    if (!outputPath) { log('请先选择输出目录', 'err'); return; }
    let jobs;
    try { jobs = await collectJobs(); }
    catch (e) { log('准备任务失败: ' + e, 'err'); return; }
    const total = jobs.reduce((s, j) => s + j.urls.length, 0);
    if (!total) { log('没有可下载的 URL（添加 TXT 或粘贴 URL）', 'err'); return; }

    log(`开始下载 ${total} 个文件 → ${outputPath}`);
    statusText.textContent = '下载中';
    sizeLabelEl.textContent = '下载中';
    progressBar.classList.remove('done');
    totalNumEl.textContent = String(total);
    doneNumEl.textContent = '0';
    failNumEl.textContent = '0';
    busy(btnDownload, true, `下载中 0/${total}`);
    btnStop.classList.remove('hide');

    try {
      await invoke('download_batch', {
        jobs,
        destDir: outputPath,
        options: { concurrency: adv.concurrency, conflict: adv.conflict, retry: adv.retry }
      });
    } catch (e) {
      statusText.textContent = '下载失败';
      sizeLabelEl.textContent = '已中止';
      log('下载失败: ' + e, 'err');
      busy(btnDownload, false);
      btnStop.classList.add('hide');
    }
  });

  btnStop.addEventListener('click', async () => {
    if (!guard()) return;
    try { await invoke('stop_download'); } catch (_) {}
    statusText.textContent = '正在停止…';
    sizeLabelEl.textContent = '停止中';
    log('正在停止下载…');
  });

  $('btnClearLog').addEventListener('click', () => setEmpty(logBox, EMPTY_LOG));

  // ---------- 监听后端事件：下载进度 ----------
  listen('progress', (e) => {
    const p = e.payload;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    progressBar.style.width = pct + '%';
    progressEl.setAttribute('aria-valuenow', String(pct));
    progressBar.classList.toggle('done', p.status === 'done');
    pctText.textContent = pct + '%';
    doneNumEl.textContent = String(p.ok);
    failNumEl.textContent = String(p.fail);
    totalNumEl.textContent = String(p.total);
    const finished = p.status === 'done' || p.status === 'stopped';
    busy(btnDownload, !finished, `下载中 ${p.done}/${p.total}`);
    btnStop.classList.toggle('hide', finished);
    if (p.status === 'done') {
      statusText.textContent = '下载完成';
      sizeLabelEl.textContent = '已完成';
      log(`下载完成！成功 ${p.ok}，失败 ${p.fail}`, 'ok');
      if (outputPath) renderList(outputPath);
    } else if (p.status === 'stopped') {
      statusText.textContent = '已停止';
      sizeLabelEl.textContent = `成功 ${p.ok} · 失败 ${p.fail}`;
      log(`下载已停止（成功 ${p.ok}，失败 ${p.fail}）`, 'err');
      if (outputPath) renderList(outputPath);
    } else if (p.url) {
      log(`下载 ${p.done}/${p.total}: ${p.url}`);
    }
  });

  // ---------- 监听后端事件：单实例（重复启动时聚焦原窗口） ----------
  listen('second-instance', () => {
    log('程序已在运行，已切换到原窗口（本窗口为原实例）', 'warn');
  });

  // ---------- 监听后端事件：文件系统监控 ----------
  let watchEvents = 0;
  listen('fs-event', (e) => {
    const f = e.payload;
    watchEvents++;
    watchStatEl.textContent = `已捕获 ${watchEvents} 个变更事件，最近：${f.kind}`;
    log(`[监控] ${f.kind} ${f.path}`);
    // 新增 .txt 自动入列（对齐原脚本 process_new_txt_file）
    if (watching && /\.txt$/i.test(f.path) && f.kind.includes('Create')) {
      if (!txtFiles.includes(f.path)) {
        if (adv.dedup && txtFiles.some(p => normTxtName(p) === normTxtName(f.path))) {
          log(`[监控] 重复文件跳过: ${baseName(f.path)}`);
        } else {
          txtFiles.push(f.path);
          renderTxt();
          log(`[监控] 新 TXT 已加入任务列表: ${baseName(f.path)}`, 'ok');
        }
      }
    }
    if (outputPath && f.path.startsWith(outputPath)) renderList(outputPath);
  });

  log(TAURI ? '前端就绪，等待操作…' : '普通浏览器预览模式（仅响应式布局，原生功能已禁用）');

  // ============================================================
  // 响应式自适应：ResizeObserver 监听容器宽度（与 Tauri 无关，浏览器直接生效）
  // ============================================================
  const app = $('app');
  const vwEl = $('vw'), bpEl = $('bp');
  const classify = (w) => (w >= 1200 ? 'lg' : w >= 768 ? 'md' : 'sm');
  const bpName = { lg: '大屏 (≥1200)', md: '中屏 (768-1199)', sm: '小屏 (<768)' };
  function apply(w) {
    const mode = classify(w);
    bpEl.textContent = bpName[mode];
    vwEl.textContent = Math.round(w) + 'px';
    const scale = Math.max(0.94, Math.min(1.08, 0.94 + (w - 420) / (1440 - 420) * 0.14));
    app.style.setProperty('--font-scale', scale.toFixed(3));
    app.dataset.mode = mode;
  }
  if (window.ResizeObserver) {
    new ResizeObserver(es => es.forEach(e => apply(e.contentRect.width))).observe(app);
  } else {
    window.addEventListener('resize', () => apply(app.clientWidth));
  }
  apply(app.clientWidth);

  // 断点预览按钮（仅演示）：限制 .app 宽度模拟不同视口
  document.querySelectorAll('.preview-bar button[data-mode]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.preview-bar button[data-mode]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      app.classList.remove('preview-md', 'preview-sm');
      if (b.dataset.mode === 'md') app.classList.add('preview-md');
      if (b.dataset.mode === 'sm') app.classList.add('preview-sm');
    });
  });
})();
