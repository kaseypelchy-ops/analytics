// ── Config ────────────────────────────────────────────────────
const GCS_KEY    = 'AIzaSyAdsm31FX6Mp5x5IoHDWn1UkUpVUqRBEdk';
const CACHE_KEY  = 'zito_calls_cache';
const CACHE_META = 'zito_calls_meta';
const PAGE_SIZE   = 50;   // cards per render page
const FETCH_BATCH = 20;   // concurrent GCS fetches

// ── State ─────────────────────────────────────────────────────
let allCalls      = [];
let filtered      = [];
let activeTeam    = 'all';
let selectedArea  = null;
let renderPage    = 0;
let filterTimer   = null;
let scrollObs     = null;

// ── Init ──────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const k = sessionStorage.getItem('zito_api_key');
  if (k) document.getElementById('aiApiKey').value = k;
});

// ── Schema Normalizer ─────────────────────────────────────────
function normalize(raw, source) {
  if (source === 'zito') {
    return {
      _source:      'zito',
      _fileName:    raw.File_Name || '',
      _date:        parseDateFromFileName(raw.File_Name || ''),
      agentName:    raw.Agent_Name || raw.Initial_Agent || 'Unknown',
      serviceArea:  (raw.Service_Area || '').replace(/\?.*/, '').trim() || 'Unknown',
      callOutcome:  raw.Call_Outcome || raw.Call_Type || 'Unknown',
      callType:     raw.Call_Source || 'Unknown',
      qaScore:      parseFloat(raw.QA_Performance_Percent) || null,
      overallScore: raw.Overall_Score || null,
      duration:     raw.Call_Duration_Minutes ? raw.Call_Duration_Minutes + ' min' : '—',
      sentiment:    raw.Customer_Sentiment_Journey || '',
      summary:      raw.Common_Objections_Encountered || raw.Competitive_Intelligence_Gathered || '',
      problemSummary:         null,
      troubleshootingSummary: null,
      painPoints:   [],
      saleCompleted:    raw.Sale_Completed === true || (raw.Call_Type||'').toLowerCase() === 'sale',
      brandPerception:  raw.Brand_Perception || '',
      futureNeeds:      raw.Future_Needs || '',
      topStrength:      raw.Top_Strength || '',
      areaImprovement:  raw.Area_For_Improvement || '',
      competitive:      raw.Competitive_Intelligence_Gathered || '',
      objections:       raw.Common_Objections_Encountered || '',
      homeType:         raw.Home_Type || '',
      customerPhone:    raw.Customer_Contact_Number || '',
      agentId:          raw.Agent_ID || raw.Agent_ID_from_YAML || '',
      reasonForCalling: '',
      holdTime:         null,
    };
  } else {
    const meta = raw.call_metadata_from_yaml || {};
    const det  = raw.extracted_call_details   || {};
    const isoDate = meta.call_start_time_iso
      ? new Date(meta.call_start_time_iso)
      : parseDateFromFileName(raw.file_id || raw.base_name || '');
    return {
      _source:      'csr',
      _fileName:    raw.file_id || raw.base_name || '',
      _date:        isoDate,
      agentName:    raw.agent_name || det.agent_spoken_to_during_call || 'Unknown',
      serviceArea:  det.service_area || 'Unknown',
      callOutcome:  det.call_outcome_standardized || 'Unknown',
      callType:     det.call_type_standardized    || 'Unknown',
      qaScore:      parseFloat(raw.qa_performance_percent || det.qa_performance_percent) || null,
      overallScore: null,
      duration:     meta.call_duration_minutes ? parseFloat(meta.call_duration_minutes).toFixed(1) + ' min' : '—',
      sentiment:    det.customer_sentiment_standardized || '',
      summary:      det.problem_description_summary     || '',
      problemSummary:         det.problem_description_summary   || '',
      troubleshootingSummary: det.troubleshooting_steps_summary || '',
      painPoints:   Array.isArray(det.pain_points) ? det.pain_points : [],
      saleCompleted:    false,
      brandPerception:  '', futureNeeds: '', topStrength: '', areaImprovement: '',
      competitive:      '', objections: '', homeType: '',
      customerPhone:    meta.customer_phone_number || '',
      agentId:          meta.agent_id || '',
      reasonForCalling: det.reason_for_calling || '',
      holdTime:         meta.total_call_time_seconds ? Math.round(meta.total_call_time_seconds / 60) + ' min' : null,
    };
  }
}

// ── Classify call into ONE exclusive outcome bucket ───────────
// Priority: sale > lost > retain > support > other
function classifyOutcome(c) {
  const co = (c.callOutcome || '').toLowerCase();
  if (c.saleCompleted || co.includes('sale'))                                          return 'sale';
  if (['lost','cancel'].some(k => co.includes(k)))                                     return 'lost';
  if (co.includes('retain'))                                                            return 'retain';
  if (['support','dispatch','technical','repair','outage'].some(k => co.includes(k)))  return 'support';
  return 'other';
}

// ── Meaningfulness gate — drop files that are truly empty ─────
// Only 1 real field required; this catches blank {} JSON files
function isMeaningful(c) {
  const blank = v => !v || ['n/a','na','unknown','none','null','—','-',''].includes(String(v).toLowerCase().trim());
  return [c.agentName, c.serviceArea, c.callOutcome, c.callType, c.qaScore, c.summary, c.sentiment]
    .some(v => !blank(v));
}

// ── Cache ─────────────────────────────────────────────────────
function saveCache(source, calls) {
  try {
    const meta = JSON.parse(localStorage.getItem(CACHE_META) || '{}');
    meta[source] = { lastLoaded: new Date().toISOString(), count: calls.length };
    localStorage.setItem(CACHE_META, JSON.stringify(meta));
    const others     = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]').filter(c => c._source !== source);
    const serialized = calls.map(c => ({ ...c, _date: c._date ? c._date.toISOString() : null }));
    localStorage.setItem(CACHE_KEY, JSON.stringify([...others, ...serialized]));
  } catch(e) { console.warn('Cache save failed:', e); }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    return JSON.parse(raw).map(c => ({ ...c, _date: c._date ? new Date(c._date) : null }));
  } catch(e) { return []; }
}

function clearCache() {
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(CACHE_META);
}

// ── Loader ────────────────────────────────────────────────────
async function loadAll(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached.length > 0) {
      allCalls = cached;
      allCalls.sort((a, b) => (b._date||0) - (a._date||0));
      updateTeamCounts(); applyFilters();
      // background refresh
      loadBucket('zito-json-summaries', 'zito');
      loadBucket('csr-json-summaries',  'csr');
      return;
    }
  } else {
    clearCache();
  }
  await Promise.all([
    loadBucket('zito-json-summaries', 'zito'),
    loadBucket('csr-json-summaries',  'csr'),
  ]);
}

async function loadBucket(bucket, key) {
  setPillState(key, 'loading', 'Fetching list…');
  try {
    // ── Paginate the file listing (GCS caps at 1000/page) ──
    let files = [], pageToken = null;
    do {
      const url = 'https://storage.googleapis.com/storage/v1/b/' + bucket +
        '/o?maxResults=1000' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '') +
        '&key=' + GCS_KEY;
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      files = files.concat((data.items || []).filter(f => f.name.endsWith('.json')));
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    if (!files.length) throw new Error('No JSON files found');

    // ── Fetch contents in parallel batches ──────────────────
    allCalls = allCalls.filter(c => c._source !== key);
    const newCalls = [];
    let loaded = 0, skipped = 0;

    for (let i = 0; i < files.length; i += FETCH_BATCH) {
      const batch   = files.slice(i, i + FETCH_BATCH);
      const results = await Promise.allSettled(
        batch.map(f =>
          fetch('https://storage.googleapis.com/storage/v1/b/' + bucket +
            '/o/' + encodeURIComponent(f.name) + '?alt=media&key=' + GCS_KEY)
            .then(r => r.ok ? r.json() : null).catch(() => null)
        )
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          const call = normalize(r.value, key);
          if (isMeaningful(call)) { newCalls.push(call); loaded++; }
          else skipped++;
        }
      }

      // Progressive update — cards appear while still loading
      setPillState(key, 'loading', loaded + ' / ' + files.length);
      allCalls = allCalls.filter(c => c._source !== key).concat(newCalls);
      allCalls.sort((a, b) => (b._date||0) - (a._date||0));
      updateTeamCounts(); applyFilters();
    }

    saveCache(key, newCalls);
    setPillState(key, 'loaded', loaded + ' calls' + (skipped ? ' (' + skipped + ' blank)' : ''));

  } catch(e) {
    setPillState(key, 'error', e.message.slice(0, 30));
  }
}

function setPillState(key, state, msg) {
  document.getElementById('pill-' + key).className = 'bucket-pill ' +
    (state === 'loaded' ? 'loaded' : state === 'error' ? 'error-state' : 'loading');
  document.getElementById('pcount-' + key).textContent = msg;
}

// ── Team ──────────────────────────────────────────────────────
function setTeam(team) {
  activeTeam = team;
  ['all','zito','csr'].forEach(t =>
    document.getElementById('tbtn-' + t).className = 'team-btn' + (t === team ? ' active-' + t : ''));
  applyFilters();
}

function updateTeamCounts() {
  document.getElementById('tc-all').textContent  = allCalls.length;
  document.getElementById('tc-zito').textContent = allCalls.filter(c => c._source === 'zito').length;
  document.getElementById('tc-csr').textContent  = allCalls.filter(c => c._source === 'csr').length;
}

// ── Filters ───────────────────────────────────────────────────
function scheduleFilter() { clearTimeout(filterTimer); filterTimer = setTimeout(applyFilters, 200); }

function applyFilters() {
  const search   = document.getElementById('searchAgent').value.toLowerCase();
  const from     = document.getElementById('dateFrom').value;
  const to       = document.getElementById('dateTo').value;
  const outcome  = document.getElementById('filterOutcome').value;
  const callType = document.getElementById('filterCallType').value.toLowerCase();

  filtered = allCalls.filter(c => {
    if (activeTeam !== 'all' && c._source !== activeTeam) return false;
    if (selectedArea && normalizeArea(c.serviceArea) !== normalizeArea(selectedArea)) return false;
    if (search && !(c.agentName||'').toLowerCase().includes(search)) return false;
    const d = c._date;
    if (from && (!d || d < new Date(from))) return false;
    if (to   && (!d || d > new Date(to + 'T23:59:59'))) return false;
    if (outcome) {
      const cls = classifyOutcome(c);
      if (outcome === 'sale'    && cls !== 'sale')    return false;
      if (outcome === 'retain'  && cls !== 'retain')  return false;
      if (outcome === 'support' && cls !== 'support') return false;
      if (outcome === 'lost'    && cls !== 'lost')    return false;
    }
    if (callType && !(c.callType||'').toLowerCase().includes(callType)) return false;
    return true;
  });

  updateStats(filtered);
  renderPage = 0;
  renderCards(filtered);
  buildAreaList();
  buildIssuesPanel(filtered);
  document.getElementById('resultsLabel').innerHTML =
    'Showing <strong>' + Math.min(filtered.length, PAGE_SIZE) + '</strong> of ' +
    filtered.length + ' &nbsp;·&nbsp; ' + allCalls.length + ' total';
}

function clearFilters() {
  ['searchAgent','dateFrom','dateTo'].forEach(id => document.getElementById(id).value = '');
  ['filterOutcome','filterCallType'].forEach(id => document.getElementById(id).value = '');
  selectedArea = null; closeAiPanel(); applyFilters();
}

function normalizeArea(a) { return (a||'').toLowerCase().trim(); }

// ── Area List ─────────────────────────────────────────────────
function buildAreaList() {
  const pool = activeTeam === 'all' ? allCalls : allCalls.filter(c => c._source === activeTeam);
  if (!pool.length) { document.getElementById('areaSection').style.display = 'none'; return; }

  const counts = {};
  pool.forEach(c => { const a = c.serviceArea || 'Unknown'; counts[a] = (counts[a]||0) + 1; });
  const areas = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 20);

  document.getElementById('areaSection').style.display = 'block';
  document.getElementById('areaList').innerHTML = areas.map(([area, count]) =>
    '<div class="area-item ' + (selectedArea === area ? 'selected' : '') +
    '" onclick="selectArea(\'' + area.replace(/'/g,"\\'") + '\')">' +
    '<span class="area-name">' + area + '</span><span class="area-count">' + count + '</span></div>'
  ).join('');
}

function selectArea(area) {
  selectedArea = selectedArea === area ? null : area;
  selectedArea ? openAiPanel(selectedArea) : closeAiPanel();
  applyFilters();
}

// ── Issues Panel ──────────────────────────────────────────────
function buildIssuesPanel(calls) {
  const section = document.getElementById('issuesSection');
  if (!calls.length) { section.style.display = 'none'; return; }

  // Reasons for calling (CSR)
  const reasonCounts = {};
  calls.forEach(c => {
    if (c.reasonForCalling && c.reasonForCalling.toLowerCase() !== 'n/a') {
      // Normalize and bucket similar reasons
      const r = c.reasonForCalling.trim();
      if (r) reasonCounts[r] = (reasonCounts[r]||0) + 1;
    }
  });

  // Pain points (CSR)
  const painCounts = {};
  calls.forEach(c => (c.painPoints||[]).forEach(p => {
    const k = p.trim(); if (k) painCounts[k] = (painCounts[k]||0) + 1;
  }));

  // Objections (Zito)
  const objCounts = {};
  calls.forEach(c => {
    if (c.objections) {
      c.objections.split(/[,;|]/).forEach(o => {
        const k = o.trim(); if (k && k.toLowerCase() !== 'n/a') objCounts[k] = (objCounts[k]||0) + 1;
      });
    }
  });

  // Sentiment distribution
  const sentCounts = {};
  calls.forEach(c => {
    if (c.sentiment) {
      // Take first segment for distribution
      const s = c.sentiment.split('->')[0].trim();
      if (s) sentCounts[s] = (sentCounts[s]||0) + 1;
    }
  });

  const topReasons = Object.entries(reasonCounts).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const topPain    = Object.entries(painCounts).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const topObj     = Object.entries(objCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const sentList   = Object.entries(sentCounts).sort((a,b)=>b[1]-a[1]);

  const maxReason = topReasons.length ? topReasons[0][1] : 1;
  const maxPain   = topPain.length    ? topPain[0][1]    : 1;

  function barRow(label, count, max, colorClass) {
    const pct = Math.round((count / max) * 100);
    return '<div class="issue-row">' +
      '<div class="issue-label">' + label + '</div>' +
      '<div class="issue-bar-wrap">' +
        '<div class="issue-bar ' + colorClass + '" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<div class="issue-count">' + count + '</div>' +
    '</div>';
  }

  let html = '';

  if (topReasons.length) {
    html += '<div class="issues-group"><div class="issues-group-title sp">📋 Reasons for Calling</div>';
    html += topReasons.map(([l,c]) => barRow(l, c, maxReason, 'ib-purple')).join('');
    html += '</div>';
  }

  if (topPain.length) {
    html += '<div class="issues-group"><div class="issues-group-title sr">⚠️ Pain Points</div>';
    html += topPain.map(([l,c]) => barRow(l, c, maxPain, 'ib-red')).join('');
    html += '</div>';
  }

  if (topObj.length) {
    html += '<div class="issues-group"><div class="issues-group-title sa">💬 Objections</div>';
    html += '<div class="obj-chips">' + topObj.map(([l,c]) =>
      '<span class="obj-chip"><span class="obj-text">' + l + '</span><span class="obj-num">' + c + '</span></span>'
    ).join('') + '</div></div>';
  }

  if (sentList.length) {
    const total = sentList.reduce((s,[,c])=>s+c, 0);
    html += '<div class="issues-group"><div class="issues-group-title sc">😐 Sentiment</div>';
    html += '<div class="sent-bars">' + sentList.slice(0,6).map(([s,c]) => {
      const pct = Math.round(c/total*100);
      const cls = s.toLowerCase().includes('pos') ? 'sb-green'
        : s.toLowerCase().includes('neg') || s.toLowerCase().includes('frust') ? 'sb-red'
        : 'sb-amber';
      return '<div class="sent-row"><span class="sent-label">' + s + '</span>' +
        '<div class="sent-track"><div class="sent-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
        '<span class="sent-pct">' + pct + '%</span></div>';
    }).join('') + '</div></div>';
  }

  if (!html) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  document.getElementById('issuesList').innerHTML = html;
}

// ── Stats (exclusive categories, always add up) ───────────────
function updateStats(calls) {
  let sales = 0, retain = 0, support = 0, lost = 0, other = 0;
  const scores = [];

  calls.forEach(c => {
    const cls = classifyOutcome(c);
    if (cls === 'sale')    sales++;
    else if (cls === 'lost')    lost++;
    else if (cls === 'retain')  retain++;
    else if (cls === 'support') support++;
    else                        other++;
    if (c.qaScore !== null && !isNaN(c.qaScore)) scores.push(c.qaScore);
  });

  const avgQA = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1)+'%' : '—';

  const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent = (v===0?'0':v)||'—'; };
  set('stat-total',    calls.length); set('ss-total',    calls.length);
  set('stat-sales',    sales);        set('ss-sales',    sales);
  set('stat-retained', retain);       set('ss-retained', retain);
  set('stat-support',  support);      set('ss-support',  support);
  set('stat-lost',     lost);         set('ss-lost',     lost);
  set('stat-qa',       avgQA);        set('ss-qa',       avgQA);

  // Update "other" if element exists
  const otherEl = document.getElementById('stat-other');
  if (otherEl) otherEl.textContent = other;
  const ssOther = document.getElementById('ss-other');
  if (ssOther) ssOther.textContent = other;
}

// ── Paginated Renderer ────────────────────────────────────────
function renderCards(calls) {
  const grid = document.getElementById('callGrid');
  if (scrollObs) { scrollObs.disconnect(); scrollObs = null; }

  if (!calls.length) {
    grid.innerHTML = '<div class="state-box"><span class="icon">🔍</span>' +
      '<p><strong>No calls match your filters.</strong><br>Try adjusting the filters or date range.</p></div>';
    return;
  }

  const frag = document.createDocumentFragment();
  calls.slice(0, PAGE_SIZE).forEach((c, i) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = buildCard(c, i);
    frag.appendChild(tmp.firstElementChild);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
  renderPage = 1;

  if (calls.length > PAGE_SIZE) attachSentinel(grid, calls);
}

function attachSentinel(grid, calls) {
  const sentinel = document.createElement('div');
  sentinel.className = 'load-sentinel';
  const left = calls.length - renderPage * PAGE_SIZE;
  sentinel.innerHTML = '<span class="load-more-hint">↓ ' + left + ' more</span>';
  grid.appendChild(sentinel);

  scrollObs = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;
    const start = renderPage * PAGE_SIZE;
    const slice = calls.slice(start, start + PAGE_SIZE);
    if (!slice.length) { scrollObs.disconnect(); sentinel.remove(); return; }
    sentinel.remove();
    const frag = document.createDocumentFragment();
    slice.forEach((c, i) => {
      const tmp = document.createElement('div');
      tmp.innerHTML = buildCard(c, start + i);
      frag.appendChild(tmp.firstElementChild);
    });
    grid.appendChild(frag);
    renderPage++;
    const remaining = calls.length - renderPage * PAGE_SIZE;
    if (remaining > 0) attachSentinel(grid, calls);
    else scrollObs.disconnect();
    document.getElementById('resultsLabel').innerHTML =
      'Showing <strong>' + Math.min(renderPage * PAGE_SIZE, calls.length) + '</strong> of ' +
      calls.length + ' &nbsp;·&nbsp; ' + allCalls.length + ' total';
  }, { rootMargin: '300px' });

  scrollObs.observe(sentinel);
}

// ── Card Builder ──────────────────────────────────────────────
function buildCard(c, i) {
  const isCsr    = c._source === 'csr';
  const initials = c.agentName.split(' ').map(w => w[0]||'').join('').toUpperCase().slice(0,2);
  const dateStr  = c._date ? c._date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'Unknown';
  const cls      = classifyOutcome(c);
  const outCls   = cls==='sale' ? 'ob-sale' : cls==='retain' ? 'ob-retain' : cls==='lost' ? 'ob-lost' : cls==='support' ? 'ob-support' : 'ob-other';
  const cardCls  = 'oc-'+cls;
  const qa       = c.qaScore;
  const qaColor  = qa!==null ? (qa>=80?'var(--green)':qa>=60?'var(--amber)':'var(--red)') : 'var(--text3)';
  const qaWidth  = qa!==null ? qa+'%' : '0%';
  const qaLabel  = qa!==null ? qa+'%' : '—';
  const delay    = i < PAGE_SIZE ? 'animation-delay:'+Math.min(i*20,300)+'ms' : '';

  // Sentiment chips
  const sentHtml = c.sentiment
    ? (c.sentiment.includes('->')
        ? c.sentiment.split('->').map(s=>'<span>'+s.trim()+'</span>').join('<span class="arr"> → </span>')
        : '<span>'+c.sentiment+'</span>')
    : '';

  // Pain point chips
  const painHtml = c.painPoints&&c.painPoints.length
    ? '<div class="pain-chips">'+c.painPoints.slice(0,4).map(p=>'<span class="pain-chip">'+p+'</span>').join('')+'</div>'
    : '';

  // ── Meta pills row (Area · Duration · Call Type) ──
  const metaHtml =
    '<div class="card-meta-row">'
    +(c.serviceArea && c.serviceArea!=='Unknown'
      ? '<span class="meta-pill"><span class="meta-pill-label">Area</span><span class="meta-pill-sep"> · </span><span class="meta-pill-val">'+c.serviceArea+'</span></span>'
      : '')
    +(c.duration && c.duration!=='—'
      ? '<span class="meta-pill"><span class="meta-pill-label">Duration</span><span class="meta-pill-sep"> · </span><span class="meta-pill-val">'+c.duration+'</span></span>'
      : '')
    +(c.callType && c.callType!=='Unknown'
      ? '<span class="meta-pill"><span class="meta-pill-label">Type</span><span class="meta-pill-sep"> · </span><span class="meta-pill-val">'+c.callType+'</span></span>'
      : '')
    +(c.homeType
      ? '<span class="meta-pill"><span class="meta-pill-label">Home</span><span class="meta-pill-sep"> · </span><span class="meta-pill-val">'+c.homeType+'</span></span>'
      : '')
    +'</div>';

  // ── Expand section ──
  const expItem = (label, val) =>
    val ? '<div class="exp-item"><div class="cf-label">'+label+'</div><div class="cf-val">'+val+'</div></div>' : '';

  const expSection = (title, text) =>
    text ? '<div class="exp-section"><div class="exp-title">'+title+'</div><div class="exp-text">'+text+'</div></div>' : '';

  const expandHtml = '<div class="exp-inner">'
    + (isCsr
        ? expSection('Problem Description', c.problemSummary)
          + expSection('Troubleshooting Steps', c.troubleshootingSummary)
          + (c.reasonForCalling||c.holdTime||c.agentId||c.customerPhone
              ? '<div class="exp-grid">'
                + expItem('Reason for Calling', c.reasonForCalling)
                + expItem('Hold / Total Time', c.holdTime)
                + expItem('Agent ID', c.agentId||'—')
                + expItem('Customer Phone', c.customerPhone||'—')
                +'</div>'
              : '')
        : expSection('Competitive Intel', c.competitive)
          + expSection('Customer Objections', c.objections)
          + (c.topStrength||c.areaImprovement||c.brandPerception||c.futureNeeds||c.agentId
              ? '<div class="exp-grid">'
                + expItem('Top Strength', c.topStrength)
                + expItem('Area to Improve', c.areaImprovement)
                + expItem('Brand Perception', c.brandPerception)
                + expItem('Future Needs', c.futureNeeds)
                + expItem('Agent ID', c.agentId||'—')
                + expItem('Customer Phone', c.customerPhone||'—')
                +'</div>'
              : '')
      )
    +'</div>';

  return '<div class="call-card '+cardCls+'" style="'+delay+'" onclick="toggleCard(this)">'

    // ── Header ──
    +'<div class="card-top">'
      +'<div class="avatar '+(isCsr?'csr':'')+'">'+initials+'</div>'
      +'<div class="card-agent">'
        +'<div class="agent-name">'+c.agentName+'</div>'
        +'<div class="agent-meta">'+dateStr+(c.agentId?' · ID: '+c.agentId:'')+'</div>'
      +'</div>'
      +'<div class="badges">'
        +'<span class="src-badge '+(isCsr?'src-csr':'src-zito')+'">'+(isCsr?'CSR':'Sales')+'</span>'
        +'<span class="out-badge '+outCls+'">'+c.callOutcome+'</span>'
      +'</div>'
    +'</div>'

    // ── Meta pills ──
    + metaHtml

    // ── Body ──
    +'<div class="card-body">'

      // QA score bar
      +(qa!==null
        ? '<div class="qa-row">'
            +'<span class="qa-lbl">QA Score</span>'
            +'<div class="qa-track"><div class="qa-fill" style="width:'+qaWidth+';background:'+qaColor+'"></div></div>'
            +'<span class="qa-pct" style="color:'+qaColor+'">'+qaLabel+'</span>'
          +'</div>'
        : '')

      // Summary text
      +(c.summary ? '<div class="card-summary">'+c.summary+'</div>' : '')

      // Pain chips
      + painHtml

      // Sentiment journey
      +(sentHtml ? '<div class="sentiment">'+sentHtml+'</div>' : '')

    +'</div>'

    // ── Expanded details ──
    +'<div class="card-expand">'+expandHtml+'</div>'

    // ── Footer ──
    +'<div class="card-foot">'
      +'<span class="foot-file">'+c._fileName+'</span>'
      +'<span class="foot-toggle">Details <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4l4 4 4-4"/></svg></span>'
    +'</div>'

  +'</div>';
}

function toggleCard(el) { el.classList.toggle('expanded'); }

// ── View Toggle ───────────────────────────────────────────────
function setView(mode) {
  document.getElementById('callGrid').classList.toggle('list-view', mode==='list');
  document.getElementById('vbtn-grid').classList.toggle('active', mode==='grid');
  document.getElementById('vbtn-list').classList.toggle('active', mode==='list');
}

// ── AI Panel ──────────────────────────────────────────────────
function getApiKey() { return (document.getElementById('aiApiKey')?.value||'').trim(); }

function onApiKeyInput() {
  const k = getApiKey();
  if (k) sessionStorage.setItem('zito_api_key', k);
  document.getElementById('btnAnalyze').disabled = !(selectedArea && k);
}

function openAiPanel(area) {
  document.getElementById('aiPanel').classList.add('open');
  document.getElementById('aiAreaBadge').textContent = area;
  document.getElementById('btnAnalyze').disabled = !getApiKey();

  const ac     = allCalls.filter(c => normalizeArea(c.serviceArea)===normalizeArea(area));
  const scores = ac.map(c=>c.qaScore).filter(n=>n!==null&&!isNaN(n));
  const avgQA  = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1)+'%' : 'N/A';
  const sales  = ac.filter(c=>classifyOutcome(c)==='sale').length;
  const supp   = ac.filter(c=>classifyOutcome(c)==='support').length;

  document.getElementById('aiBody').innerHTML =
    '<div class="ai-context">'
    +'<div class="ai-ctx-row"><span class="ai-ctx-label">Calls in area</span><span class="ai-ctx-val sc">'+ac.length+'</span></div>'
    +'<div class="ai-ctx-row"><span class="ai-ctx-label">Avg QA Score</span><span class="ai-ctx-val sa">'+avgQA+'</span></div>'
    +'<div class="ai-ctx-row"><span class="ai-ctx-label">Sales</span><span class="ai-ctx-val sg">'+sales+'</span></div>'
    +'<div class="ai-ctx-row"><span class="ai-ctx-label">Support calls</span><span class="ai-ctx-val sp">'+supp+'</span></div>'
    +'</div>'
    +'<div class="ai-placeholder">'
    +'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a10 10 0 110 20A10 10 0 0112 2z"/><path d="M8 12h8M12 8l4 4-4 4"/></svg>'
    +'<p>Click <strong>Generate AI Analysis</strong><br>for next steps on<br><strong>'+area+'</strong>.</p>'
    +'</div>';
}

function closeAiPanel() {
  document.getElementById('aiPanel').classList.remove('open');
  document.getElementById('aiAreaBadge').textContent = '—';
  document.getElementById('btnAnalyze').disabled = true;
  selectedArea = null; buildAreaList();
}

async function runAnalysis() {
  const apiKey = getApiKey();
  if (!apiKey) {
    document.getElementById('aiBody').innerHTML = '<div class="ai-output"><p style="color:var(--red)">Please enter your Anthropic API key above.</p></div>';
    return;
  }
  const btn = document.getElementById('btnAnalyze');
  btn.disabled = true; btn.textContent = 'Analyzing…';

  const ac          = allCalls.filter(c=>normalizeArea(c.serviceArea)===normalizeArea(selectedArea));
  const scores      = ac.map(c=>c.qaScore).filter(n=>n!==null&&!isNaN(n));
  const avgQA       = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) : 'N/A';
  const sales       = ac.filter(c=>classifyOutcome(c)==='sale').length;
  const lost        = ac.filter(c=>classifyOutcome(c)==='lost').length;
  const support     = ac.filter(c=>classifyOutcome(c)==='support').length;
  const painPoints  = [...new Set(ac.flatMap(c=>c.painPoints||[]))];
  const objections  = ac.map(c=>c.objections).filter(Boolean).slice(0,5).join(' | ');
  const competitive = ac.map(c=>c.competitive).filter(Boolean).slice(0,3).join(' | ');
  const sentiments  = [...new Set(ac.map(c=>c.sentiment).filter(Boolean))].slice(0,5);
  const agents      = [...new Set(ac.map(c=>c.agentName))];
  const agentScores = agents.map(a=>{
    const s=ac.filter(c=>c.agentName===a).map(c=>c.qaScore).filter(n=>n!==null&&!isNaN(n));
    return s.length ? a+': '+(s.reduce((x,y)=>x+y,0)/s.length).toFixed(1)+'%' : null;
  }).filter(Boolean);
  const topReasons  = ac.map(c=>c.reasonForCalling).filter(r=>r&&r.toLowerCase()!=='n/a').slice(0,5).join(' | ');

  const prompt =
    'You are a telecom sales and customer service operations analyst.\n\n'+
    'SERVICE AREA: '+selectedArea+'\nTOTAL CALLS: '+ac.length+
    '\nAVERAGE QA SCORE: '+avgQA+'%'+
    '\nSALES: '+sales+' | LOST/CANCELED: '+lost+' | SUPPORT/TECHNICAL: '+support+
    '\nAGENT QA SCORES: '+(agentScores.join(', ')||'N/A')+
    '\nCOMMON PAIN POINTS: '+(painPoints.join(', ')||'None')+
    '\nREASONS FOR CALLING: '+(topReasons||'None noted')+
    '\nCUSTOMER OBJECTIONS: '+(objections||'None noted')+
    '\nCOMPETITIVE INTEL: '+(competitive||'None noted')+
    '\nCUSTOMER SENTIMENTS: '+(sentiments.join(', ')||'N/A')+
    '\n\nRespond in this exact format:\n\n'+
    '### Sales Performance\n[2-3 bullet points]\n\n'+
    '### Key Coaching Actions\n[3-4 specific coaching actions]\n\n'+
    '### Competitive Strategy\n[2-3 bullet points]\n\n'+
    '### Customer Experience\n[2-3 bullet points]\n\n'+
    '### Immediate Next Steps\n[3 prioritized items numbered 1-3]\n\n'+
    'Be specific, data-driven. Reference actual numbers.';

  const body = document.getElementById('aiBody');
  const ctx  = (body.querySelector('.ai-context')||{outerHTML:''}).outerHTML;
  body.innerHTML = ctx+'<div class="ai-loading"><div class="spinner"></div> Analyzing '+ac.length+' calls in '+selectedArea+'…</div>';

  try {
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1000,
        messages:[{role:'user',content:prompt}] }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || 'No analysis returned.';
    body.innerHTML = ctx+'<div class="ai-output">'+markdownToHtml(text)+'</div>';
  } catch(e) {
    body.innerHTML = ctx+'<div class="ai-output"><p style="color:var(--red)">Analysis failed: '+e.message+'</p></div>';
  }
  btn.disabled = false; btn.textContent = '↺ Re-analyze';
}

function markdownToHtml(md) {
  return md
    .replace(/### (.+)/g,        '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g,   '<strong>$1</strong>')
    .replace(/^[-•] (.+)$/gm,    '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<div class="ai-action-item"><strong>$1.</strong> $2</div>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>'+m+'</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hup])(.+)$/gm, '<p>$1</p>')
    .replace(/<p><\/p>/g, '');
}

// ── Helpers ───────────────────────────────────────────────────
function parseDateFromFileName(name) {
  const m = (name||'').match(/(\d{10,16})/);
  if (!m) return null;
  let ts = parseInt(m[1]);
  if (ts > 1e15) ts = Math.floor(ts/1000);
  if (ts > 1e12) return new Date(ts);
  if (ts > 1e9)  return new Date(ts*1000);
  return null;
}
