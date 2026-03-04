// ── Config ────────────────────────────────────────────────────
const GCS_KEY = 'AIzaSyAdsm31FX6Mp5x5IoHDWn1UkUpVUqRBEdk';
const AI_KEY  = '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';

// ── State ─────────────────────────────────────────────────────
let allCalls    = [];
let filtered    = [];
let activeTeam  = 'all';
let selectedArea = null;

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
      problemSummary:         det.problem_description_summary  || '',
      troubleshootingSummary: det.troubleshooting_steps_summary || '',
      painPoints:   Array.isArray(det.pain_points) ? det.pain_points : [],
      saleCompleted:    false,
      brandPerception:  '', futureNeeds: '', topStrength: '', areaImprovement: '',
      competitive:      '', objections:  '', homeType: '',
      customerPhone:    meta.customer_phone_number || '',
      agentId:          meta.agent_id || '',
      reasonForCalling: det.reason_for_calling || '',
      holdTime:         meta.total_call_time_seconds ? Math.round(meta.total_call_time_seconds / 60) + ' min' : null,
    };
  }
}

// ── Bucket Loader ─────────────────────────────────────────────
async function loadAll() {
  await Promise.all([
    loadBucket('zito-json-summaries', 'zito'),
    loadBucket('csr-json-summaries',  'csr'),
  ]);
}

async function loadBucket(bucket, key) {
  setPillState(key, 'loading', 'Loading...');
  try {
    const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=1000&key=${GCS_KEY}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    const files = (data.items || []).filter(f => f.name.endsWith('.json'));
    if (!files.length) throw new Error('No JSON files found');

    allCalls = allCalls.filter(c => c._source !== key);
    let loaded = 0;
    for (const file of files) {
      try {
        const fr = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(file.name)}?alt=media&key=${GCS_KEY}`);
        if (fr.ok) { allCalls.push(normalize(await fr.json(), key)); loaded++; }
      } catch(e) { /* skip bad files */ }
    }
    allCalls.sort((a, b) => (b._date || 0) - (a._date || 0));
    setPillState(key, 'loaded', loaded + ' calls');
    updateTeamCounts();
    applyFilters();
  } catch(e) {
    setPillState(key, 'error', e.message.slice(0, 30));
  }
}

function setPillState(key, state, msg) {
  document.getElementById(`pill-${key}`).className  = 'bucket-pill ' + (state === 'loaded' ? 'loaded' : state === 'error' ? 'error-state' : 'loading');
  document.getElementById(`pcount-${key}`).textContent = msg;
}

// ── Team ──────────────────────────────────────────────────────
function setTeam(team) {
  activeTeam = team;
  ['all', 'zito', 'csr'].forEach(t => {
    document.getElementById(`tbtn-${t}`).className = 'team-btn' + (t === team ? ` active-${t}` : '');
  });
  applyFilters();
}

function updateTeamCounts() {
  document.getElementById('tc-all').textContent  = allCalls.length;
  document.getElementById('tc-zito').textContent = allCalls.filter(c => c._source === 'zito').length;
  document.getElementById('tc-csr').textContent  = allCalls.filter(c => c._source === 'csr').length;
}

// ── Filters ───────────────────────────────────────────────────
function applyFilters() {
  const search   = document.getElementById('searchAgent').value.toLowerCase();
  const from     = document.getElementById('dateFrom').value;
  const to       = document.getElementById('dateTo').value;
  const outcome  = document.getElementById('filterOutcome').value;
  const callType = document.getElementById('filterCallType').value.toLowerCase();

  filtered = allCalls.filter(c => {
    if (activeTeam !== 'all' && c._source !== activeTeam) return false;
    if (selectedArea && normalizeArea(c.serviceArea) !== normalizeArea(selectedArea)) return false;
    if (search && !(c.agentName || '').toLowerCase().includes(search)) return false;
    const d = c._date;
    if (from && (!d || d < new Date(from))) return false;
    if (to   && (!d || d > new Date(to + 'T23:59:59'))) return false;
    const co = (c.callOutcome || '').toLowerCase();
    if (outcome === 'sale'    && !(co.includes('sale')   || c.saleCompleted)) return false;
    if (outcome === 'retain'  && !co.includes('retain'))  return false;
    if (outcome === 'support' && !['support','dispatch','technical'].some(k => co.includes(k))) return false;
    if (outcome === 'lost'    && !['lost','cancel'].some(k => co.includes(k))) return false;
    if (callType && !(c.callType || '').toLowerCase().includes(callType)) return false;
    return true;
  });

  updateStats(filtered);
  renderCards(filtered);
  buildAreaList();
  document.getElementById('resultsLabel').innerHTML = `Showing <strong>${filtered.length}</strong> of ${allCalls.length} calls`;
}

function clearFilters() {
  ['searchAgent', 'dateFrom', 'dateTo'].forEach(id => document.getElementById(id).value = '');
  ['filterOutcome', 'filterCallType'].forEach(id => document.getElementById(id).value = '');
  selectedArea = null;
  closeAiPanel();
  applyFilters();
}

function normalizeArea(a) { return (a || '').toLowerCase().trim(); }

// ── Area List ─────────────────────────────────────────────────
function buildAreaList() {
  const pool = activeTeam === 'all' ? allCalls : allCalls.filter(c => c._source === activeTeam);
  if (!pool.length) { document.getElementById('areaSection').style.display = 'none'; return; }

  const counts = {};
  pool.forEach(c => { const a = c.serviceArea || 'Unknown'; counts[a] = (counts[a] || 0) + 1; });
  const areas = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20);

  document.getElementById('areaSection').style.display = 'block';
  document.getElementById('areaList').innerHTML = areas.map(([area, count]) => `
    <div class="area-item ${selectedArea === area ? 'selected' : ''}" onclick="selectArea('${area.replace(/'/g, "\\'")}')">
      <span class="area-name">${area}</span>
      <span class="area-count">${count}</span>
    </div>`).join('');
}

function selectArea(area) {
  selectedArea = selectedArea === area ? null : area;
  selectedArea ? openAiPanel(selectedArea) : closeAiPanel();
  applyFilters();
}

// ── Stats ─────────────────────────────────────────────────────
function updateStats(calls) {
  const sales    = calls.filter(c => c.saleCompleted || (c.callOutcome||'').toLowerCase().includes('sale')).length;
  const retained = calls.filter(c => (c.callOutcome||'').toLowerCase().includes('retain')).length;
  const support  = calls.filter(c => ['support','dispatch','technical'].some(k => (c.callOutcome||'').toLowerCase().includes(k))).length;
  const lost     = calls.filter(c => ['lost','cancel'].some(k => (c.callOutcome||'').toLowerCase().includes(k))).length;
  const scores   = calls.map(c => c.qaScore).filter(n => n !== null && !isNaN(n));
  const avgQA    = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) + '%' : '—';

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '—'; };
  set('stat-total',    calls.length); set('ss-total',    calls.length);
  set('stat-sales',    sales);        set('ss-sales',    sales);
  set('stat-retained', retained);     set('ss-retained', retained);
  set('stat-support',  support);      set('ss-support',  support);
  set('stat-lost',     lost);         set('ss-lost',     lost);
  set('stat-qa',       avgQA);        set('ss-qa',       avgQA);
}

// ── Render Cards ──────────────────────────────────────────────
function renderCards(calls) {
  const grid = document.getElementById('callGrid');
  if (!calls.length) {
    grid.innerHTML = `<div class="state-box"><span class="icon">🔍</span><p><strong>No calls match your filters.</strong><br>Try adjusting the filters or date range.</p></div>`;
    return;
  }
  grid.innerHTML = calls.map((c, i) => buildCard(c, i)).join('');
}

function buildCard(c, i) {
  const isCsr    = c._source === 'csr';
  const initials = c.agentName.split(' ').map(w => w[0]||'').join('').toUpperCase().slice(0, 2);
  const dateStr  = c._date ? c._date.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : 'Unknown';
  const co       = (c.callOutcome || '').toLowerCase();
  const outCls   = co.includes('sale') || c.saleCompleted ? 'ob-sale'
    : co.includes('retain') ? 'ob-retain'
    : co.includes('lost') || co.includes('cancel') ? 'ob-lost'
    : ['support','dispatch','technical'].some(k => co.includes(k)) ? 'ob-support'
    : 'ob-other';

  const qa      = c.qaScore;
  const qaColor = qa !== null ? (qa >= 80 ? 'var(--green)' : qa >= 60 ? 'var(--amber)' : 'var(--red)') : 'var(--text3)';
  const qaWidth = qa !== null ? qa + '%' : '0%';
  const qaLabel = qa !== null ? qa + '%' : '—';

  const sentHtml = c.sentiment
    ? c.sentiment.includes('->')
      ? c.sentiment.split('->').map(s => `<span>${s.trim()}</span>`).join('<span class="arr">→</span>')
      : `<span>${c.sentiment}</span>`
    : '';

  const painHtml = c.painPoints?.length
    ? `<div class="pain-chips">${c.painPoints.map(p => `<span class="pain-chip">${p}</span>`).join('')}</div>`
    : '';

  const expandHtml = isCsr
    ? `${c.problemSummary         ? `<div class="exp-section"><div class="exp-title">Problem</div><div class="exp-text">${c.problemSummary}</div></div>` : ''}
       ${c.troubleshootingSummary ? `<div class="exp-section"><div class="exp-title">Troubleshooting</div><div class="exp-text">${c.troubleshootingSummary}</div></div>` : ''}
       <div class="exp-grid">
         ${c.reasonForCalling ? `<div class="exp-item"><div class="cf-label">Reason</div><div class="cf-val" style="font-size:11px;line-height:1.5;white-space:normal">${c.reasonForCalling}</div></div>` : ''}
         ${c.holdTime         ? `<div class="exp-item"><div class="cf-label">Duration</div><div class="cf-val">${c.holdTime}</div></div>` : ''}
         <div class="exp-item"><div class="cf-label">Agent ID</div><div class="cf-val">${c.agentId||'—'}</div></div>
         <div class="exp-item"><div class="cf-label">Customer</div><div class="cf-val">${c.customerPhone||'—'}</div></div>
       </div>`
    : `${c.competitive ? `<div class="exp-section"><div class="exp-title">Competitive Intel</div><div class="exp-text">${c.competitive}</div></div>` : ''}
       ${c.objections  ? `<div class="exp-section"><div class="exp-title">Objections</div><div class="exp-text">${c.objections}</div></div>` : ''}
       <div class="exp-grid">
         ${c.topStrength      ? `<div class="exp-item"><div class="cf-label">Top Strength</div><div class="cf-val" style="font-size:11px;line-height:1.5;white-space:normal">${c.topStrength}</div></div>` : ''}
         ${c.areaImprovement  ? `<div class="exp-item"><div class="cf-label">Improve</div><div class="cf-val" style="font-size:11px;line-height:1.5;white-space:normal">${c.areaImprovement}</div></div>` : ''}
         ${c.brandPerception  ? `<div class="exp-item"><div class="cf-label">Brand Perception</div><div class="cf-val" style="font-size:11px;line-height:1.5;white-space:normal">${c.brandPerception}</div></div>` : ''}
         ${c.futureNeeds      ? `<div class="exp-item"><div class="cf-label">Future Needs</div><div class="cf-val" style="font-size:11px;line-height:1.5;white-space:normal">${c.futureNeeds}</div></div>` : ''}
         <div class="exp-item"><div class="cf-label">Agent ID</div><div class="cf-val">${c.agentId||'—'}</div></div>
         ${c.homeType ? `<div class="exp-item"><div class="cf-label">Home Type</div><div class="cf-val">${c.homeType}</div></div>` : ''}
       </div>`;

  return `
  <div class="call-card" style="animation-delay:${Math.min(i * 30, 400)}ms" onclick="toggleCard(this)">
    <div class="card-top">
      <div class="avatar ${isCsr ? 'csr' : ''}">${initials}</div>
      <div class="card-agent">
        <div class="agent-name">${c.agentName}</div>
        <div class="agent-meta">${dateStr} · ${c.callType}</div>
      </div>
      <div class="badges">
        <span class="src-badge ${isCsr ? 'src-csr' : 'src-zito'}">${isCsr ? 'CSR' : 'Sales'}</span>
        <span class="out-badge ${outCls}">${c.callOutcome}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="card-row">
        <div class="card-field"><span class="cf-label">Area</span><span class="cf-val">${c.serviceArea}</span></div>
        <div class="card-field"><span class="cf-label">Duration</span><span class="cf-val">${c.duration}</span></div>
        <div class="card-field"><span class="cf-label">Score</span><span class="cf-val">${c.overallScore || qaLabel}</span></div>
      </div>
      <div class="qa-row">
        <span class="qa-lbl">QA</span>
        <div class="qa-track"><div class="qa-fill" style="width:${qaWidth};background:${qaColor}"></div></div>
        <span class="qa-pct" style="color:${qaColor}">${qaLabel}</span>
      </div>
      ${c.summary   ? `<div class="card-summary">${c.summary}</div>` : ''}
      ${painHtml}
      ${sentHtml    ? `<div class="sentiment">${sentHtml}</div>` : ''}
    </div>
    <div class="card-expand">${expandHtml}</div>
    <div class="card-foot">
      <span class="foot-file">${c._fileName}</span>
      <span class="foot-toggle">Details <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4l4 4 4-4"/></svg></span>
    </div>
  </div>`;
}

function toggleCard(el) { el.classList.toggle('expanded'); }

// ── View Toggle ───────────────────────────────────────────────
function setView(mode) {
  document.getElementById('callGrid').classList.toggle('list-view', mode === 'list');
  document.getElementById('vbtn-grid').classList.toggle('active', mode === 'grid');
  document.getElementById('vbtn-list').classList.toggle('active', mode === 'list');
}

// ── AI Panel ──────────────────────────────────────────────────
function openAiPanel(area) {
  document.getElementById('aiPanel').classList.add('open');
  document.getElementById('aiAreaBadge').textContent = area;
  document.getElementById('btnAnalyze').disabled = false;

  const areaCalls = allCalls.filter(c => normalizeArea(c.serviceArea) === normalizeArea(area));
  const scores    = areaCalls.map(c => c.qaScore).filter(n => n !== null && !isNaN(n));
  const avgQA     = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) + '%' : 'N/A';
  const sales     = areaCalls.filter(c => c.saleCompleted || (c.callOutcome||'').toLowerCase().includes('sale')).length;
  const support   = areaCalls.filter(c => ['support','dispatch','technical'].some(k => (c.callOutcome||'').toLowerCase().includes(k))).length;

  document.getElementById('aiBody').innerHTML = `
    <div class="ai-context">
      <div class="ai-ctx-row"><span class="ai-ctx-label">Calls in area</span><span class="ai-ctx-val sc">${areaCalls.length}</span></div>
      <div class="ai-ctx-row"><span class="ai-ctx-label">Avg QA Score</span><span class="ai-ctx-val sa">${avgQA}</span></div>
      <div class="ai-ctx-row"><span class="ai-ctx-label">Sales</span><span class="ai-ctx-val sg">${sales}</span></div>
      <div class="ai-ctx-row"><span class="ai-ctx-label">Support calls</span><span class="ai-ctx-val sp">${support}</span></div>
    </div>
    <div class="ai-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a10 10 0 110 20A10 10 0 0112 2z"/><path d="M8 12h8M12 8l4 4-4 4"/></svg>
      <p>Click <strong>Generate AI Analysis</strong><br>for next steps on<br><strong>${area}</strong>.</p>
    </div>`;
}

function closeAiPanel() {
  document.getElementById('aiPanel').classList.remove('open');
  document.getElementById('aiAreaBadge').textContent = '—';
  document.getElementById('btnAnalyze').disabled = true;
  selectedArea = null;
  buildAreaList();
}

async function runAnalysis() {
  if (!selectedArea) return;
  const btn = document.getElementById('btnAnalyze');
  btn.disabled = true;
  btn.textContent = 'Analyzing...';

  const areaCalls = allCalls.filter(c => normalizeArea(c.serviceArea) === normalizeArea(selectedArea));
  const scores    = areaCalls.map(c => c.qaScore).filter(n => n !== null && !isNaN(n));
  const avgQA     = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : 'N/A';
  const sales     = areaCalls.filter(c => c.saleCompleted || (c.callOutcome||'').toLowerCase().includes('sale')).length;
  const lost      = areaCalls.filter(c => ['lost','cancel'].some(k => (c.callOutcome||'').toLowerCase().includes(k))).length;
  const support   = areaCalls.filter(c => ['support','dispatch','technical'].some(k => (c.callOutcome||'').toLowerCase().includes(k))).length;

  const painPoints   = [...new Set(areaCalls.flatMap(c => c.painPoints || []))];
  const objections   = areaCalls.map(c => c.objections).filter(Boolean).slice(0, 5).join(' | ');
  const competitive  = areaCalls.map(c => c.competitive).filter(Boolean).slice(0, 3).join(' | ');
  const sentiments   = [...new Set(areaCalls.map(c => c.sentiment).filter(Boolean))].slice(0, 5);
  const agents       = [...new Set(areaCalls.map(c => c.agentName))];
  const agentScores  = agents.map(a => {
    const s = areaCalls.filter(c => c.agentName === a).map(c => c.qaScore).filter(n => n !== null && !isNaN(n));
    return s.length ? `${a}: ${(s.reduce((x,y) => x+y, 0) / s.length).toFixed(1)}%` : null;
  }).filter(Boolean);

  const prompt = `You are a telecom sales and customer service operations analyst. Analyze this call data for the service area "${selectedArea}" and provide specific, actionable next steps.

SERVICE AREA: ${selectedArea}
TOTAL CALLS: ${areaCalls.length}
AVERAGE QA SCORE: ${avgQA}%
SALES: ${sales} | LOST/CANCELED: ${lost} | SUPPORT/TECHNICAL: ${support}
AGENT QA SCORES: ${agentScores.join(', ') || 'N/A'}
COMMON PAIN POINTS: ${painPoints.join(', ') || 'None identified'}
CUSTOMER OBJECTIONS: ${objections || 'None noted'}
COMPETITIVE INTEL: ${competitive || 'None noted'}
CUSTOMER SENTIMENTS: ${sentiments.join(', ') || 'N/A'}

Respond in this exact format with specific, data-driven recommendations:

### Sales Performance
[2-3 bullet points about what's working and what needs improvement based on the data]

### Key Coaching Actions
[3-4 specific coaching actions for agents in this area based on objections/scores]

### Competitive Strategy
[2-3 bullet points on how to handle the competitive threats seen in this area]

### Customer Experience
[2-3 bullet points on addressing pain points and improving sentiment]

### Immediate Next Steps
[3 concrete, prioritized action items numbered 1-3]

Be specific, data-driven, and concise. Reference actual numbers from the data.`;

  const body = document.getElementById('aiBody');
  const ctx  = body.querySelector('.ai-context')?.outerHTML || '';
  body.innerHTML = ctx + `<div class="ai-loading"><div class="spinner"></div> Analyzing ${areaCalls.length} calls in ${selectedArea}...</div>`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-key':     AI_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || 'No analysis returned.';
    body.innerHTML = ctx + `<div class="ai-output">${markdownToHtml(text)}</div>`;
  } catch(e) {
    body.innerHTML = ctx + `<div class="ai-output"><p style="color:var(--red)">Analysis failed: ${e.message}</p></div>`;
  }

  btn.disabled    = false;
  btn.textContent = '↺ Re-analyze';
}

function markdownToHtml(md) {
  return md
    .replace(/### (.+)/g,        '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g,   '<strong>$1</strong>')
    .replace(/^[-•] (.+)$/gm,    '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<div class="ai-action-item"><strong>$1.</strong> $2</div>')
    .replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hup])(.+)$/gm, '<p>$1</p>')
    .replace(/<p><\/p>/g, '');
}

// ── Helpers ───────────────────────────────────────────────────
function parseDateFromFileName(name) {
  const match = (name || '').match(/(\d{10,16})/);
  if (!match) return null;
  let ts = parseInt(match[1]);
  if (ts > 1e15) ts = Math.floor(ts / 1000);
  if (ts > 1e12) return new Date(ts);
  if (ts > 1e9)  return new Date(ts * 1000);
  return null;
}
