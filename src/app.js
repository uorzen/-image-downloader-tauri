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

  const $ = (id) => document.getElementById(id);
  const monitorPathEl = $('monitorPath');
  const monitorStatusEl = $('monitorStatus');
  const outPathEl = $('outPath');
  const fileListEl = $('fileList');
  const fileCountEl = $('fileCount');
  const urlArea = $('urlArea');
  const progressBar = $('progressBar');
  const doneLabel = $('doneLabel');
  const totalLabel = $('totalLabel');
  const sizeLabel = $('sizeLabel');
  const statusText = $('statusText');
  const logBox = $('logBox');

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.textContent = `[${t}] ${msg}`;
    logBox.appendChild(div);
    logBox.scrollTop = logBox.scrollHeight;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function guard() {
    if (!TAURI) { log('当前为普通浏览器预览，原生功能不可用（请用 cargo tauri dev 运行）'); return false; }
    return true;
  }

  async function renderList(p) {
    try {
      const files = await invoke('list_directory', { path: p });
      fileListEl.innerHTML = files.map(f => `<div class="fi">${escapeHtml(f)}</div>`).join('');
      fileCountEl.textContent = `${files.length} 个文件`;
    } catch (e) {
      log('列出目录失败: ' + e);
    }
  }

  // ---------- 选择监控目录 ----------
  $('btnMonitorPick').addEventListener('click', async () => {
    if (!guard()) return;
    const p = await invoke('pick_directory');
    if (p) { monitorPath = p; monitorPathEl.textContent = p; log('监控目录: ' + p); }
  });
  $('btnMonitorStart').addEventListener('click', async () => {
    if (!guard()) return;
    if (!monitorPath) { log('请先选择监控目录'); return; }
    await invoke('start_watch', { path: monitorPath });
    monitorStatusEl.textContent = '● 监控中';
    log('已开始监控: ' + monitorPath);
  });

  // ---------- 选择输出目录 ----------
  async function pickOutput() {
    if (!guard()) return;
    const p = await invoke('pick_directory');
    if (p) { outputPath = p; outPathEl.textContent = p; renderList(p); log('输出目录: ' + p); }
  }
  $('btnOutputPick').addEventListener('click', pickOutput);
  $('btnPick2').addEventListener('click', pickOutput);

  // ---------- 开始下载 ----------
  $('btnDownload').addEventListener('click', async () => {
    const urls = urlArea.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!urls.length) { log('请先填入图片 URL'); return; }
    if (!guard()) return;
    if (!outputPath) { log('请先选择输出目录'); return; }
    log(`开始下载 ${urls.length} 个文件 → ${outputPath}`);
    statusText.textContent = '下载中…';
    invoke('download_many', { urls: urls, destDir: outputPath }).catch(e => log('下载失败: ' + e));
  });

  $('btnClearLog').addEventListener('click', () => { logBox.innerHTML = ''; });
  $('btnOpenLog').addEventListener('click', () => { logBox.innerHTML = ''; });

  // ---------- 监听后端事件 ----------
  listen('progress', (e) => {
    const p = e.payload;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    progressBar.style.width = pct + '%';
    doneLabel.textContent = '成功 ' + p.done;
    totalLabel.textContent = '/ ' + p.total;
    sizeLabel.textContent = '批次 1 · ' + pct + '%';
    if (p.status === 'done') statusText.textContent = '下载完成';
    else log(`下载 ${p.done}/${p.total}: ${p.url}`);
  });

  listen('fs-event', (e) => {
    const f = e.payload;
    log(`[监控] ${f.kind} ${f.path}`);
    if (outputPath && f.path.startsWith(outputPath)) renderList(outputPath);
  });

  log(TAURI ? '前端就绪，等待操作…' : '普通浏览器预览模式（仅响应式布局，原生功能已禁用）');

  // ============================================================
  // 响应式自适应：ResizeObserver 监听容器宽度（与 Tauri 无关，浏览器直接生效）
  //  - 判定断点 lg/md/sm 并更新读数
  //  - 计算字号缩放因子 --font-scale
  // ============================================================
  const app = $('app');
  const vwEl = $('vw'), bpEl = $('bp');
  const classify = (w) => (w >= 1200 ? 'lg' : w >= 768 ? 'md' : 'sm');
  const bpName = { lg: '大屏 (≥1200)', md: '中屏 (768–1199)', sm: '小屏 (<768)' };
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
