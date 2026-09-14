/* ================= 坐标工具（WGS-84 ↔ GCJ-02，适配高德瓦片） ================= */
const PI = Math.PI;
function outOfChina(lng, lat) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
function transformLat(lng, lat) {
  let r = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  r += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(lat * PI) + 40.0 * Math.sin(lat / 3.0 * PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(lat / 12.0 * PI) + 320.0 * Math.sin(lat * PI / 30.0)) * 2.0 / 3.0;
  return r;
}
function transformLng(lng, lat) {
  let r = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  r += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(lng * PI) + 40.0 * Math.sin(lng / 3.0 * PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(lng / 12.0 * PI) + 300.0 * Math.sin(lng / 30.0 * PI)) * 2.0 / 3.0;
  return r;
}
function wgs84togcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - 0.00669342162296594323 * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((6378245.0 * (1 - 0.00669342162296594323)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (6378245.0 / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}
function gcj02towgs84(lng, lat) {
  const [gLng, gLat] = wgs84togcj02(lng, lat);
  return [lng * 2 - gLng, lat * 2 - gLat];
}
// [lat,lng] WGS -> [lat,lng] GCJ
function toGcj(latlng) { const [lng, lat] = wgs84togcj02(latlng[1], latlng[0]); return [lat, lng]; }
// [lat,lng] GCJ -> [lat,lng] WGS
function toWgs(latlng) { const [lng, lat] = gcj02towgs84(latlng[1], latlng[0]); return [lat, lng]; }
function haversine(a, b) {
  const R = 6371000, d2r = d => d * PI / 180;
  const dLat = d2r(b[0] - a[0]), dLng = d2r(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(d2r(a[0])) * Math.cos(d2r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ================= 常量与状态 ================= */
const WALK_SPEED = 80;               // 平均步速 m/分钟
const RANGE_MIN = 10;                // 等时圈：10 分钟
const RANGE_M = WALK_SPEED * RANGE_MIN; // 800m
const DEFAULT_WGS = [31.2304, 121.4737]; // 定位失败时的示例位置（上海人民广场附近）

const STATUS = {
  ok:       { label: '充足' },
  low:      { label: '少量' },
  critical: { label: '售罄边缘' },
  soldout:  { label: '售罄' },
};
function statusOf(r) { return r <= 0 ? 'soldout' : r === 1 ? 'critical' : r <= 5 ? 'low' : 'ok'; }

let userWgs = null, userDisp = null;
let stores = [];
let markers = {};
let activeFilter = 'all';
let filterCat = 'all';
let filterDist = 0;   // 0 = 不限
let filterTime = 'all';
let picking = false;
let lastUpdate = null;
let idSeq = 1;
let map, userMarker, isoOuter, isoInner, accCircle;
const visibleLayer = L.layerGroup();

/* ================= 地图初始化 ================= */
let coordMode = 'gcj'; // 高德瓦片使用 GCJ-02 坐标；回退 OSM 底图时切回 WGS-84
function disp(latlng) { return coordMode === 'gcj' ? toGcj(latlng) : latlng; }
map = L.map('map').setView(disp(DEFAULT_WGS), 14);
let gaodeLayer = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
  subdomains: ['1', '2', '3', '4'],
  maxZoom: 18,
  attribution: '&copy; 高德地图',
});
let fallbackLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: '&copy; Esri',
});
let tileErrors = 0;
gaodeLayer.on('tileerror', () => {
  if (++tileErrors >= 5 && coordMode === 'gcj') switchToFallback();
});
function switchToFallback() {
  coordMode = 'wgs';
  map.removeLayer(gaodeLayer);
  fallbackLayer.addTo(map);
  if (userWgs) { rebuildOverlays(); renderAll(); }
  showBanner('⚠️ 高德瓦片加载失败，已自动切换到 ArcGIS 底图（坐标系已同步为 WGS-84，标记不会偏移）。');
}
gaodeLayer.addTo(map);
map.addLayer(visibleLayer);

/* ================= 店铺数据（模拟） ================= */
const POOL = [
  ['米言烘焙·现烤吐司', '烘焙', 9.9],
  ['禾麦手作面包', '烘焙', 9.9],
  ['面包与花（人民广场店）', '烘焙', 12.9],
  ['法贝滋面包坊', '烘焙', 9.9],
  ['满记甜品（汉口路店）', '饮品', 12.9],
  ['巷口糖水铺', '饮品', 9.9],
  ['芋见甜品', '饮品', 9.9],
  ['罗森（西藏中路店）', '综合', 15.9],
  ['全家（福州路店）', '综合', 15.9],
  ['便利蜂（九江路店）', '综合', 19.9],
  ['7-Eleven（南京东路店）', '综合', 15.9],
  ['瑞幸咖啡（黄河路店）', '饮品', 9.9],
  ['Manner咖啡（人民公园店）', '饮品', 12.9],
  ['库迪咖啡（北京东路店）', '饮品', 9.9],
  ['吉祥馄饨（浙江中路店）', '熟食', 12.9],
  ['永和大王（南京西路店）', '熟食', 12.9],
  ['紫燕百味鸡（福建中路店）', '熟食', 19.9],
];
const CATS = ['烘焙', '熟食', '饮品', '综合'];
const CONTENT = { '烘焙': '2–4 件现烤面包·糕点', '熟食': '1–2 份热食·小吃', '饮品': '2–3 杯饮品·轻食', '综合': '饭团·便当·零食组合' };
const STREETS = ['南京西路', '汉口路', '九江路', '福州路', '西藏中路', '黄河路', '浙江中路', '北京东路', '福建中路', '凤阳路'];

function randRemaining() {
  const r = Math.random();
  if (r < 0.32) return 6 + Math.floor(Math.random() * 10);  // 充足 6–15
  if (r < 0.62) return 2 + Math.floor(Math.random() * 4);   // 少量 2–5
  if (r < 0.85) return 1;                                    // 售罄边缘
  return 0;                                                  // 售罄
}
function randWindow() {
  const startH = 17 + Math.floor(Math.random() * 4); // 17–20 点开始自提
  const startMin = startH * 60 + (Math.random() < 0.5 ? 0 : 30);
  const endMin = startMin + (Math.random() < 0.5 ? 60 : 120);
  const fmt = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  return { text: `${fmt(startMin)}–${fmt(endMin)}`, startMin, endMin };
}
function genSlots(startMin, endMin) {
  const out = [], fmt = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  for (let m = startMin; m + 30 <= endMin; m += 30) out.push(`${fmt(m)}–${fmt(m + 30)}`);
  return out.length ? out : [`${fmt(startMin)}–${fmt(endMin)}`];
}
function genTrend(std) {
  const out = [];
  let v = std + (Math.random() * 3 - 1.5);
  for (let i = 0; i < 7; i++) {
    v += Math.random() * 1.6 - 0.8;
    v = Math.max(std - 3, Math.min(std + 3, v));
    out.push(i === 6 ? std : +v.toFixed(1));
  }
  return out;
}

function genStores() {
  const c = userWgs;
  const pool = POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  stores = pool.slice(0, 14).map(([name, cat, base]) => {
    const bearing = Math.random() * PI * 2;
    const dist = 150 + Math.random() * 610; // 均落在 800m 步行圈内
    const wgs = [
      c[0] + (dist * Math.cos(bearing)) / 111320,
      c[1] + (dist * Math.sin(bearing)) / (111320 * Math.cos(c[0] * PI / 180)),
    ];
    const win = randWindow();
    // 三档盲盒：小份 / 标准 / 豪华，各档独立实时库存；cap 为每日数量上限（FR-B02 可配置）
    const tiers = [
      { name: '小份', price: base, orig: Math.round(base * 3), stock: 2 + Math.floor(Math.random() * 7), cap: 12 },
      { name: '标准', price: +(base + 6).toFixed(1), orig: Math.round((base + 6) * 3), stock: 1 + Math.floor(Math.random() * 5), cap: 8 },
      { name: '豪华', price: +(base + 12).toFixed(1), orig: Math.round((base + 12) * 3), stock: Math.floor(Math.random() * 4), cap: 6 },
    ];
    const s = {
      id: 's' + idSeq++,
      name, cat,
      tiers,
      minPrice: base,
      origPrice: Math.round(base * 3),
      remaining: tiers.reduce((a, t) => a + t.stock, 0),
      window: win.text,
      startMin: win.startMin,
      endMin: win.endMin,
      slots: genSlots(win.startMin, win.endMin),
      trend: genTrend(+(base + 6).toFixed(1)),
      addr: STREETS[Math.floor(Math.random() * STREETS.length)] + ' ' + (1 + Math.floor(Math.random() * 999)) + ' 号',
      wgs,
      latlng: disp(wgs),
    };
    s.dist = haversine(userWgs, s.wgs);
    s.walkMin = Math.max(1, Math.round(s.dist / WALK_SPEED));
    return s;
  });
}

/* ================= 定位 ================= */
function locate(first) {
  showLoading(first ? '正在获取你的位置…' : '正在重新定位…');
  if (!navigator.geolocation) { hideLoading(); locateFail('浏览器不支持定位'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    hideLoading(); hideBanner();
    setUserLocation([pos.coords.latitude, pos.coords.longitude], pos.coords.accuracy);
    toast('定位成功');
  }, err => {
    hideLoading();
    locateFail(err.code === 1 ? '定位权限被拒绝' : err.code === 3 ? '定位超时' : '定位失败');
  }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
}
function locateFail(reason) {
  // 降级方案：优先恢复用户上次选择的城市，否则用默认位置，保证始终有「附近店铺」可浏览
  let cityName = null;
  try { cityName = localStorage.getItem('xishi_city'); } catch (e) { }
  const c = cityName && CITIES.find(x => x[0] === cityName);
  const pos = c ? [c[1], c[2]] : DEFAULT_WGS;
  showBanner(`⚠️ ${reason}。已为你展示${c ? `「${c[0]}」` : '默认位置（上海·人民广场）'}附近的店铺。
    <div class="banner-btns"><button class="btn-mini" onclick="openCityPicker()">🏙 选择城市</button></div>`);
  setUserLocation(pos);
}

/* ---- 手动选择城市（定位失败的降级方案之一） ---- */
const CITIES = [
  ['北京', 39.9042, 116.4074], ['上海', 31.2304, 121.4737], ['广州', 23.1291, 113.2644],
  ['深圳', 22.5431, 114.0579], ['杭州', 30.2741, 120.1551], ['成都', 30.5728, 104.0668],
  ['南京', 32.0603, 118.7969], ['武汉', 30.5928, 114.3055], ['重庆', 29.5630, 106.5516],
  ['西安', 34.3416, 108.9398], ['长沙', 28.2282, 112.9388], ['天津', 39.3434, 117.3616],
];
function openCityPicker() {
  modalView = 'city';
  let cur = '';
  try { cur = localStorage.getItem('xishi_city') || ''; } catch (e) { }
  modalBody.innerHTML = `
    <h2>选择城市</h2>
    <div class="d-sub">H5 定位受浏览器权限限制，定位失败或想浏览其他城市时可手动选择，查看该位置 10 分钟步行圈的店铺（演示数据，店铺随机生成）。</div>
    <div class="city-grid">${CITIES.map(([n]) => `<button class="city-chip${cur === n ? ' on' : ''}" onclick="pickCity('${n}')">${n}</button>`).join('')}</div>
    <div class="d-sub">需要精确位置时，也可以点击右上角「⌖ 手动选点」在地图上点选任意位置。</div>`;
  openModal();
}
function pickCity(n) {
  const c = CITIES.find(x => x[0] === n);
  if (!c) return;
  try { localStorage.setItem('xishi_city', n); } catch (e) { }
  closeModal();
  setUserLocation([c[1], c[2]]);
  toast(`已切换到「${n}」，展示附近店铺`);
}

function setUserLocation(wgs, accuracy) {
  userWgs = wgs;
  genStores();
  lastUpdate = new Date();
  rebuildOverlays(accuracy);
  map.setView(userDisp, 15, { animate: true });
  renderAll();
}

function rebuildOverlays(accuracy) {
  userDisp = disp(userWgs);
  stores.forEach(s => { s.latlng = disp(s.wgs); });
  [accCircle, isoInner, isoOuter, userMarker].forEach(l => l && map.removeLayer(l));
  if (accuracy && accuracy < 800) {
    accCircle = L.circle(userDisp, { radius: accuracy, color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.06 }).addTo(map);
  }
  isoOuter = L.circle(userDisp, {
    radius: RANGE_M, color: '#059669', weight: 2, dashArray: '6 8',
    fillColor: '#10b981', fillOpacity: 0.05,
  }).addTo(map).bindTooltip(`10 分钟步行圈 · 约 ${RANGE_M}m（按步速 80m/分钟估算）`);
  isoInner = L.circle(userDisp, {
    radius: RANGE_M / 2, color: '#34d399', weight: 1.5, dashArray: '4 8',
    fillColor: '#34d399', fillOpacity: 0.03,
  }).addTo(map).bindTooltip('5 分钟步行圈 · 约 400m');
  userMarker = L.marker(userDisp, {
    icon: L.divIcon({ className: 'user-marker-wrap', html: '<span class="user-pulse"></span><span class="user-dot"></span>', iconSize: [16, 16] }),
    zIndexOffset: 1000,
  }).addTo(map).bindTooltip('你的位置', { direction: 'top', offset: [0, -10] });
}

/* ================= 渲染 ================= */
const chipsEl = document.getElementById('chips');
const catChipsEl = document.getElementById('catChips');
const metaEl = document.getElementById('meta');
const listEl = document.getElementById('storeList');

function renderAll() { renderChips(); renderList(); renderMarkers(); updateMeta(); }

function renderChips() {
  const counts = { all: stores.length, ok: 0, low: 0, critical: 0, soldout: 0 };
  stores.forEach(s => counts[statusOf(s.remaining)]++);
  const defs = [['all', '全部'], ['ok', '充足'], ['low', '少量'], ['critical', '售罄边缘'], ['soldout', '售罄']];
  chipsEl.innerHTML = defs.map(([k, label]) =>
    `<button class="chip${k === 'critical' ? ' chip-red' : ''}${activeFilter === k ? ' active' : ''}" data-filter="${k}">${label}${k !== 'all' ? ` <em>${counts[k]}</em>` : ''}</button>`
  ).join('');

  const catCounts = { all: stores.length };
  CATS.forEach(c => catCounts[c] = stores.filter(s => s.cat === c).length);
  catChipsEl.innerHTML = [['all', '全部品类'], ...CATS.map(c => [c, c])].map(([k, label]) =>
    `<button class="chip${filterCat === k ? ' active' : ''}" data-cat="${k}">${label}${k !== 'all' ? ` <em>${catCounts[k]}</em>` : ''}</button>`
  ).join('');
}

function cardHtml(s) {
  const key = statusOf(s.remaining), st = STATUS[key];
  return `<article class="store-card st-${key}" data-id="${s.id}" onclick="focusStore('${s.id}')">
    <div class="card-head"><h3>${s.name}${isSubscribed(s.id) ? ' 🔔' : ''}</h3><span class="badge b-${key}">${st.label}</span></div>
    <div class="card-sub">${s.cat} · ${s.addr}</div>
    <div class="card-row">
      <span class="remain">剩余 <b>${s.remaining}</b> 盒</span>
      <span class="price">¥${s.minPrice} 起 <s>原价约¥${s.origPrice}</s></span>
    </div>
    <div class="card-sub">🥡 ${CONTENT[s.cat]}</div>
    <div class="card-sub">🕒 自提 ${s.window} · 步行约 ${s.walkMin} 分钟（${Math.round(s.dist)}m）</div>
    <div class="card-actions"><button class="btn-mini" onclick="event.stopPropagation();openDetail('${s.id}')">查看详情 · 抢盲盒</button></div>
  </article>`;
}

function matchesFilter(s) {
  if (activeFilter !== 'all' && statusOf(s.remaining) !== activeFilter) return false;
  if (filterCat !== 'all' && s.cat !== filterCat) return false;
  if (filterDist > 0 && s.dist > filterDist) return false;
  if (filterTime === 'early' && s.startMin >= 18 * 60) return false;
  if (filterTime === 'mid' && (s.startMin < 18 * 60 || s.startMin >= 20 * 60)) return false;
  if (filterTime === 'late' && s.startMin < 20 * 60) return false;
  return true;
}

function renderList() {
  const shown = stores.filter(matchesFilter)
    .sort((a, b) => a.walkMin - b.walkMin || a.dist - b.dist);
  if (!shown.length) { listEl.innerHTML = '<div class="empty">没有符合条件的店铺，试试放宽筛选或点击「刷新库存」</div>'; return; }
  listEl.innerHTML = shown.map(cardHtml).join('');
}

function badgeIcon(s, key) {
  return L.divIcon({
    className: 'badge-wrap',
    html: `<div class="store-badge ${key}">${s.remaining}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16],
  });
}

function popupHtml(s) {
  const st = STATUS[statusOf(s.remaining)];
  const tierList = s.tiers.map(t => `${t.name}¥${t.price}`).join(' / ');
  return `<div class="popup">
    <div class="popup-head"><b>${s.name}</b><span class="badge b-${statusOf(s.remaining)}">${st.label}</span></div>
    <div class="popup-row">${s.cat} · ${s.addr}</div>
    <div class="popup-row">剩余盲盒：<b>${s.remaining}</b> 盒 · 🥡 ${CONTENT[s.cat]}</div>
    <div class="popup-row">盲盒档位：<b>¥${s.minPrice} 起</b>（${tierList}）</div>
    <div class="popup-row">自提时间：${s.window}</div>
    <div class="popup-row">步行约 ${s.walkMin} 分钟（${Math.round(s.dist)}m）</div>
    <div style="margin-top:8px;text-align:right"><button class="btn-mini" onclick="openDetail('${s.id}')">查看详情 · 选档下单</button></div>
  </div>`;
}

function renderMarkers() {
  visibleLayer.clearLayers();
  markers = {};
  map.closePopup();
  stores.forEach(s => {
    const key = statusOf(s.remaining);
    if (!matchesFilter(s)) return;
    const m = L.marker(s.latlng, { icon: badgeIcon(s, key), zIndexOffset: 100 });
    m.bindPopup(popupHtml(s));
    m.on('click', () => highlightCard(s.id));
    visibleLayer.addLayer(m);
    markers[s.id] = m;
  });
}

function updateMeta() {
  const t = lastUpdate ? lastUpdate.toLocaleTimeString('zh-CN', { hour12: false }) : '--';
  metaEl.innerHTML = `共 <b>${stores.length}</b> 家店铺 · 库存更新于 ${t} · 每 60 秒自动刷新`;
}

/* ================= 交互 ================= */
window.focusStore = function (id) {
  const s = stores.find(x => x.id === id);
  if (!s) return;
  map.flyTo(s.latlng, Math.max(map.getZoom(), 16), { duration: 0.6 });
  const m = markers[id];
  if (m) m.openPopup();
  highlightCard(id);
};
function highlightCard(id) {
  document.querySelectorAll('.store-card').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  const el = document.querySelector(`.store-card[data-id="${id}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

chipsEl.addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  activeFilter = b.dataset.filter;
  renderChips(); renderList(); renderMarkers();
});

catChipsEl.addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  filterCat = b.dataset.cat;
  renderChips(); renderList(); renderMarkers();
});

document.getElementById('selDist').addEventListener('change', e => {
  filterDist = +e.target.value;
  renderList(); renderMarkers();
});
document.getElementById('selTime').addEventListener('change', e => {
  filterTime = e.target.value;
  renderList(); renderMarkers();
});

document.getElementById('btnLocate').addEventListener('click', () => locate(false));
document.getElementById('btnRefresh').addEventListener('click', () => refreshStock(true));
document.getElementById('btnCity').addEventListener('click', openCityPicker);
document.getElementById('btnPrefs').addEventListener('click', () => openSettings('allergen'));
document.getElementById('btnFeed').addEventListener('click', openFeed);
document.getElementById('btnCarbon').addEventListener('click', openCarbon);
document.getElementById('btnReport').addEventListener('click', openReport);
document.getElementById('btnTier').addEventListener('click', openTierSet);
document.getElementById('btnTpl').addEventListener('click', openTemplates);
document.getElementById('btnPrice').addEventListener('click', openPriceAuth);
document.getElementById('btnVerify').addEventListener('click', openVerify);
document.getElementById('btnOff').addEventListener('click', openOffload);
document.getElementById('btnDash').addEventListener('click', openDashboard);
document.getElementById('btnRpt').addEventListener('click', openReports);

const btnPick = document.getElementById('btnPick');
btnPick.addEventListener('click', () => {
  picking = !picking;
  map.getContainer().style.cursor = picking ? 'crosshair' : '';
  btnPick.classList.toggle('active', picking);
  if (picking) toast('请在地图上点击一个位置作为你的位置');
});
map.on('click', e => {
  if (!picking) return;
  picking = false;
  map.getContainer().style.cursor = '';
  btnPick.classList.remove('active');
  hideBanner();
  const ll = [e.latlng.lat, e.latlng.lng];
  setUserLocation(coordMode === 'gcj' ? toWgs(ll) : ll);
  toast('已设置为你的位置');
});

function refreshStock(manual) {
  if (!stores.length) return;
  const restocks = [];
  stores.forEach(s => {
    if (reportProtect[s.id] && Date.now() < reportProtect[s.id]) return; // 商家上报后 30 分钟内不模拟波动
    if (Math.random() < 0.65) {
      const before = s.remaining;
      const t = s.tiers[Math.floor(Math.random() * 3)];
      t.stock = Math.max(0, Math.min(t.cap ?? 10, t.stock + [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)]));
      s.remaining = s.tiers.reduce((a, x) => a + x.stock, 0);
      if (s.remaining > before) restocks.push({ s });
    }
  });
  lastUpdate = new Date();
  renderAll();
  if (curStore && modalView === 'detail') renderDetail(); // 详情页实时价格 / 库存
  if (manual) toast('库存已更新');
  maybePushRestock(restocks); // 订阅补货提醒（受免打扰约束）
}
setInterval(() => refreshStock(false), 60000);

/* ================= 小组件 ================= */
function showLoading(text) {
  const el = document.getElementById('loading');
  el.querySelector('p').textContent = text;
  el.classList.remove('hidden');
}
function hideLoading() { document.getElementById('loading').classList.add('hidden'); }
function showBanner(html) { const b = document.getElementById('banner'); b.innerHTML = html; b.classList.remove('hidden'); }
function hideBanner() { document.getElementById('banner').classList.add('hidden'); }
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

/* ================= 登录 / 注册（顾客 & 商家，演示） ================= */
let authRole = 'customer', authView = 'login', smsCode = null, smsTimer = null, smsLeft = 0;
function getSession() { try { return JSON.parse(localStorage.getItem('xishi_session')); } catch (e) { return null; } }
function setSession(s) { try { localStorage.setItem('xishi_session', JSON.stringify(s)); } catch (e) { } }
function maskPhone(p) { return p.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'); }
function showAuth() { document.getElementById('authMask').classList.remove('hidden'); }
function hideAuth() { document.getElementById('authMask').classList.add('hidden'); }
function initAuth() { renderAuthForm(); applyRoleUI(); if (getSession()) hideAuth(); else showAuth(); }
function applyRoleUI(forceRole) {
  const s = getSession();
  // 优先使用手动切换的预览角色（toggleRoleUI 或登录界面选角色），否则取 session 角色
  const preview = forceRole || localStorage.getItem('xishi_role_preview');
  const role = preview || (s && s.role === 'merchant' ? 'merchant' : 'customer');
  document.body.dataset.role = role;
  const tag = document.getElementById('roleTag');
  if (tag) tag.textContent = role === 'merchant' ? '🏪 商家模式' : '🧑 顾客模式';
}
function toggleRoleUI() {
  const cur = document.body.dataset.role === 'merchant' ? 'merchant' : 'customer';
  const next = cur === 'merchant' ? 'customer' : 'merchant';
  localStorage.setItem('xishi_role_preview', next);
  applyRoleUI(next);
  toast(`已切换为 ${next === 'merchant' ? '🏪 商家模式' : '🧑 顾客模式'}`);
}
function setAuthRole(r) {
  authRole = r;
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.role === r));
  // 登录界面选角色时，首页顶栏立即同步切换预览
  localStorage.setItem('xishi_role_preview', r);
  applyRoleUI(r);
  renderAuthForm();
}
function setAuthView(v) {
  authView = v;
  document.getElementById('authTabLogin').classList.toggle('active', v === 'login');
  document.getElementById('authTabReg').classList.toggle('active', v === 'register');
  renderAuthForm();
}
function renderAuthForm() {
  const isMer = authRole === 'merchant';
  const extra = authView === 'register'
    ? `<input id="authName" class="auth-input" maxlength="12" placeholder="${isMer ? '店铺名称（2-12 字）' : '你的昵称（选填）'}">`
    : '';
  document.getElementById('authForm').innerHTML = `
    ${extra}
    <input id="authPhone" class="auth-input" maxlength="11" inputmode="numeric" placeholder="手机号">
    <div class="code-row">
      <input id="authCode" class="auth-input" maxlength="6" inputmode="numeric" placeholder="短信验证码">
      <button id="btnSms" class="btn primary sms-btn" onclick="sendSms()">发送验证码</button>
    </div>
    ${authView === 'register' ? `<label class="agree"><input type="checkbox" id="authAgree"> 我已阅读并同意 <a href="javascript:void(0)" onclick="toast('演示页面：协议内容略')">《用户协议》</a> 与 <a href="javascript:void(0)" onclick="toast('演示页面：协议内容略')">《隐私政策》</a></label>` : ''}
    <button class="btn primary big auth-submit" onclick="authSubmit()">${authView === 'login' ? (isMer ? '商家登录' : '登 录') : '注册并登录'}</button>
    <div class="d-sub" style="text-align:center;margin-top:10px">${isMer ? '商家入驻后可在店铺后台管理盲盒库存与核销（演示）' : '未注册的手机号验证通过后将自动创建账号（演示）'}</div>`;
}
function validPhone() {
  const p = document.getElementById('authPhone').value.trim();
  if (!/^1\d{10}$/.test(p)) { toast('请输入正确的 11 位手机号'); return null; }
  return p;
}
function sendSms() {
  if (smsLeft > 0) return;
  const p = validPhone();
  if (!p) return;
  smsCode = String(Math.floor(100000 + Math.random() * 900000));
  toast(`📩 验证码已发送（演示）：${smsCode}`);
  smsLeft = 60;
  const btn = document.getElementById('btnSms');
  btn.disabled = true;
  btn.textContent = '60s 后重发';
  smsTimer = setInterval(() => {
    smsLeft--;
    if (smsLeft > 0) btn.textContent = `${smsLeft}s 后重发`;
    else { clearInterval(smsTimer); btn.disabled = false; btn.textContent = '发送验证码'; }
  }, 1000);
}
function checkCode() {
  const c = document.getElementById('authCode').value.trim();
  if (!smsCode || c !== smsCode) { toast('验证码错误，请先获取验证码'); return false; }
  return true;
}
function authSubmit() {
  const p = validPhone();
  if (!p || !checkCode()) return;
  const isMer = authRole === 'merchant';
  let name = '';
  if (authView === 'register') {
    name = document.getElementById('authName').value.trim();
    if (isMer && name.length < 2) { toast('请填写店铺名称（至少 2 个字）'); return; }
    if (authView === 'register' && isMer && !document.getElementById('authAgree').checked) { toast('请先勾选同意协议'); return; }
  }
  setSession({ role: authRole, phone: p, name: name || (isMer ? '商家用户' : '惜食伙伴'), at: Date.now() });
  localStorage.removeItem('xishi_role_preview');
  hideAuth();
  applyRoleUI();
  toast(authView === 'register' ? `注册成功，欢迎加入惜食！` : `欢迎回来，${isMer ? '商家' : '顾客'} ${maskPhone(p)}`);
  if (isMer) showBanner(`🏪 你已以<b>商家身份</b>登录（演示）：正式版可在商家后台管理盲盒库存与到店核销。
    <div class="banner-btns"><button class="btn-mini" onclick="hideBanner()">知道了</button></div>`);
}
function openMe() {
  const s = getSession();
  modalView = 'me';
  modalBody.innerHTML = s ? `
    <h2>我的账号</h2>
    <div class="order-card">
      <div class="order-row"><span>身份</span><b>${s.role === 'merchant' ? '🏪 商家' : '🧑 顾客'}</b></div>
      <div class="order-row"><span>${s.role === 'merchant' ? '店铺名称' : '昵称'}</span><span>${s.name}</span></div>
      <div class="order-row"><span>手机号</span><span>${maskPhone(s.phone)}</span></div>
    </div>
    <button class="btn big" onclick="logout()">退出登录</button>
    <div class="d-sub" style="text-align:center;margin-top:8px">演示环境：退出后可重新体验登录 / 注册流程</div>` : `
    <h2>我的账号</h2>
    <div class="d-sub">尚未登录，登录后可同步订单与偏好设置。</div>
    <button class="btn primary big" onclick="closeModal();showAuth()">去登录</button>`;
  openModal();
}
function logout() {
  if (!confirm('退出登录？')) return;
  try { localStorage.removeItem('xishi_session'); } catch (e) { }
  closeModal();
  applyRoleUI();
  showAuth();
  toast('已退出登录');
}

/* ================= 店铺详情 / 下单支付 ================= */
const modalMask = document.getElementById('modalMask');
const modalBody = document.getElementById('modalBody');
let modalView = null;
let curStore = null, curTierIdx = 0, curQty = 1, curSlot = null;
let activeOrder = null;

const TIER_DESC = {
  '烘焙': ['1–2 件面包·小食', '3–4 件面包+糕点', '5–6 件精品组合'],
  '熟食': ['1 份热食', '2 份热食+小吃', '3–4 份熟食拼盘'],
  '饮品': ['1 杯饮品', '2 杯饮品+小食', '3–4 杯饮品组合'],
  '综合': ['2–3 件零食便当', '4–5 件便当组合', '6 件以上豪华组合'],
};
const ALLERGENS = ['麸质', '蛋', '乳制品', '花生', '坚果', '大豆', '海鲜', '芝麻'];
const CAT_ALLERGENS = {
  '烘焙': ['麸质', '蛋', '乳制品', '坚果', '芝麻'],
  '熟食': ['麸质', '大豆'],
  '饮品': ['乳制品', '花生', '坚果'],
  '综合': ['蛋', '大豆', '麸质', '芝麻'],
};

function openModal() { modalMask.classList.remove('hidden'); }
function closeModal() { modalMask.classList.add('hidden'); }
modalMask.addEventListener('click', e => { if (e.target === modalMask) closeModal(); });

/* ---- 偏好设置中心：过敏原偏好 / 店铺品类订阅 / 推送免打扰 ---- */
function getAllergens() { try { return JSON.parse(localStorage.getItem('xishi_allergens')) || []; } catch (e) { return []; } }
function saveAllergens(list) { try { localStorage.setItem('xishi_allergens', JSON.stringify(list)); } catch (e) { } }
function getSubs() { try { return JSON.parse(localStorage.getItem('xishi_subs')) || { cats: [], stores: [] }; } catch (e) { return { cats: [], stores: [] }; } }
function saveSubs(v) { try { localStorage.setItem('xishi_subs', JSON.stringify(v)); } catch (e) { } renderAll(); }
function getDnd() { try { return JSON.parse(localStorage.getItem('xishi_dnd')) || { enabled: true, mute: true, browser: false, from: '22:00', to: '08:00' }; } catch (e) { return { enabled: true, mute: true, browser: false, from: '22:00', to: '08:00' }; } }
function saveDnd(v) { try { localStorage.setItem('xishi_dnd', JSON.stringify(v)); } catch (e) { } }

function isDndNow(dnd) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = (dnd.from || '22:00').split(':').map(Number);
  const [th, tm] = (dnd.to || '08:00').split(':').map(Number);
  const f = fh * 60 + fm, t = th * 60 + tm;
  return f <= t ? (cur >= f && cur < t) : (cur >= f || cur < t); // 支持跨夜时段
}
function pushAllowed() {
  const d = getDnd();
  return d.enabled && !(d.mute && isDndNow(d));
}

let settingsTab = 'allergen';
function openSettings(tab) {
  settingsTab = tab || 'allergen';
  renderSettings();
  openModal();
}
function openAllergenSettings() { openSettings('allergen'); } // 兼容确认订单页入口
function openSubSettings() { openSettings('subs'); }

function renderSettings() {
  modalView = 'settings';
  const tabs = [['allergen', '⚠️ 过敏原偏好'], ['subs', '🔔 订阅管理'], ['dnd', '🌙 免打扰']];
  const body = settingsTab === 'subs' ? subsTabHtml() : settingsTab === 'dnd' ? dndTabHtml() : allergenTabHtml();
  modalBody.innerHTML = `
    <h2>偏好设置</h2>
    <div class="tabbar">${tabs.map(([k, label]) => `<button class="tab${settingsTab === k ? ' active' : ''}" onclick="openSettings('${k}')">${label}</button>`).join('')}</div>
    ${body}`;
  if (settingsTab === 'allergen') {
    modalBody.querySelectorAll('.agg input').forEach(i =>
      i.addEventListener('change', () => i.closest('.agg').classList.toggle('on', i.checked)));
  }
}

/* ---- Tab 1：过敏原偏好填写（预置 + 自定义） ---- */
function allergenTabHtml() {
  const cur = getAllergens();
  const custom = cur.filter(a => !ALLERGENS.includes(a));
  return `
    <div class="d-sub">勾选你需要规避的过敏原，确认订单页会自动比对盲盒成分并提示风险。</div>
    <div class="agg-chips">${ALLERGENS.map(a => `<label class="agg${cur.includes(a) ? ' on' : ''}"><input type="checkbox" value="${a}"${cur.includes(a) ? ' checked' : ''}>${a}</label>`).join('')}</div>
    ${custom.length ? `<div class="custom-tags">${custom.map(a => `<span class="custom-tag">${a}<button onclick="removeCustomAllergen('${a}')" title="移除">✕</button></span>`).join('')}</div>` : ''}
    <div class="add-row"><input id="customAllergen" placeholder="自定义过敏原，如：芒果、韭菜…" maxlength="10" onkeydown="if(event.key==='Enter')addCustomAllergen()"><button class="btn" onclick="addCustomAllergen()">添加</button></div>
    <button class="btn primary big" onclick="saveAllergenFromModal()">保存过敏原偏好</button>`;
}
function checkedPresets() { return [...modalBody.querySelectorAll('.agg input:checked')].map(i => i.value); }
function addCustomAllergen() {
  const inp = document.getElementById('customAllergen');
  const v = (inp.value || '').trim();
  if (!v) return;
  const custom = getAllergens().filter(a => !ALLERGENS.includes(a));
  if (custom.includes(v) || ALLERGENS.includes(v)) { toast('该过敏原已存在'); return; }
  saveAllergens([...checkedPresets(), ...custom, v]);
  renderSettings();
  toast('已添加自定义过敏原');
}
function removeCustomAllergen(a) {
  saveAllergens([...checkedPresets(), ...getAllergens().filter(x => !ALLERGENS.includes(x) && x !== a)]);
  renderSettings();
}
function saveAllergenFromModal() {
  const custom = getAllergens().filter(a => !ALLERGENS.includes(a));
  saveAllergens([...checkedPresets(), ...custom]);
  toast('过敏原偏好已保存');
  closeModal();
}

/* ---- Tab 2：店铺 / 品类订阅管理 ---- */
function subsTabHtml() {
  const subs = getSubs();
  return `
    <h3>品类订阅</h3>
    <div class="d-sub">订阅后该品类店铺补货时推送提醒（受免打扰设置约束）。</div>
    ${CATS.map(c => `
      <div class="sub-row"><span><b>${c}</b><div class="d-sub">${stores.filter(s => s.cat === c).length} 家店铺在售</div></span>
      <input type="checkbox" class="switch" ${subs.cats.includes(c) ? 'checked' : ''} onchange="toggleSubCat('${c}', this.checked)"></div>`).join('')}
    <h3 style="margin-top:14px">店铺订阅</h3>
    <div class="d-sub">已订阅 ${subs.stores.length} / ${stores.length} 家，列表中带 🔔 标记。</div>
    ${stores.map(s => `
      <div class="sub-row">
        <div><b>${s.name}</b><div class="d-sub">${s.cat} · 剩 ${s.remaining} 盒</div></div>
        <input type="checkbox" class="switch" ${subs.stores.includes(s.id) ? 'checked' : ''} onchange="toggleSubStore('${s.id}', this.checked)">
      </div>`).join('')}`;
}
function toggleSubCat(c, on) {
  const subs = getSubs();
  subs.cats = on ? [...new Set([...subs.cats, c])] : subs.cats.filter(x => x !== c);
  saveSubs(subs);
  toast(on ? `已订阅「${c}」品类补货提醒` : `已取消「${c}」品类订阅`);
}
function toggleSubStore(id, on) {
  const subs = getSubs();
  subs.stores = on ? [...new Set([...subs.stores, id])] : subs.stores.filter(x => x !== id);
  saveSubs(subs);
  const s = stores.find(x => x.id === id);
  toast(on ? `已订阅 ${s ? s.name : '店铺'} 补货提醒` : '已取消店铺订阅');
}
function isSubscribed(id) { return getSubs().stores.includes(id); }

/* ---- Tab 3：推送免打扰设置（浏览器通知 + 降级） ---- */
function notifSupported() { return typeof window.Notification !== 'undefined'; }
function pushChannelLabel(d) {
  if (!notifSupported()) return '应用内提醒（当前环境不支持通知，已降级）';
  if (Notification.permission !== 'granted' || !d.browser) return '应用内提醒（降级）';
  return '浏览器通知';
}
function browserNotifRow(d) {
  if (!notifSupported()) return `
    <div class="sub-row"><span><b>浏览器通知</b><div class="d-sub">当前浏览器/环境不支持 Notification（如部分 iOS 浏览器），已自动降级为应用内提醒</div></span>
      <span class="d-sub">已降级</span></div>`;
  if (Notification.permission === 'granted') return `
    <div class="sub-row"><span><b>浏览器通知</b><div class="d-sub">已授权：通过系统通知送达；关闭开关后降级为应用内提醒</div></span>
      <input type="checkbox" class="switch" ${d.browser ? 'checked' : ''} onchange="toggleDnd('browser', this.checked)"></div>`;
  if (Notification.permission === 'denied') return `
    <div class="sub-row"><span><b>浏览器通知</b><div class="d-sub">通知权限已被拒绝，已降级为应用内提醒（可在浏览器地址栏的权限设置中恢复）</div></span>
      <span class="d-sub">已降级</span></div>`;
  return `
    <div class="sub-row"><span><b>浏览器通知</b><div class="d-sub">H5 无法使用小程序订阅消息，改用浏览器通知送达（需授权一次）</div></span>
      <button class="btn-mini" onclick="enableBrowserNotif()">开启授权</button></div>`;
}
function enableBrowserNotif() {
  if (!notifSupported()) return;
  Notification.requestPermission().then(p => {
    const d = getDnd();
    d.browser = p === 'granted';
    saveDnd(d);
    renderSettings();
    toast(p === 'granted' ? '浏览器通知已开启' : '未授权通知，已降级为应用内提醒');
  });
}
function notify(title, body) {
  const d = getDnd();
  if (d.browser && notifSupported() && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: 'xishi-push' });
      n.onclick = () => { window.focus(); n.close(); };
      return true;
    } catch (e) { /* 个别环境构造失败则降级 */ }
  }
  toast('🔔 ' + body); // 降级：应用内提醒
  return false;
}
function dndTabHtml() {
  const d = getDnd();
  let status, cls;
  if (!d.enabled) { status = '🔕 推送已关闭'; cls = 'dnd-on'; }
  else if (d.mute && isDndNow(d)) { status = `🔕 当前处于免打扰时段（${d.from}–${d.to}），推送已静音`; cls = 'dnd-on'; }
  else { status = '🔔 推送正常 · ' + pushChannelLabel(d) + (d.mute ? `，免打扰时段 ${d.from}–${d.to}` : ''); cls = 'dnd-off'; }
  return `
    <div class="sub-row"><span><b>推送提醒</b><div class="d-sub">补货、订单状态变更等消息（演示）</div></span>
      <input type="checkbox" class="switch" ${d.enabled ? 'checked' : ''} onchange="toggleDnd('enabled', this.checked)"></div>
    ${browserNotifRow(d)}
    <div class="sub-row"><span><b>免打扰时段</b><div class="d-sub">时段内的推送将被静音，支持跨夜（如 22:00–08:00）</div></span>
      <input type="checkbox" class="switch" ${d.mute ? 'checked' : ''} onchange="toggleDnd('mute', this.checked)"></div>
    <div class="time-row">⏰ <input type="time" value="${d.from}" onchange="toggleDnd('from', this.value)"> 至 <input type="time" value="${d.to}" onchange="toggleDnd('to', this.value)"></div>
    <div class="dnd-status ${cls}">${status}</div>
    <button class="btn big" onclick="testPush()">发送测试推送</button>`;
}
function toggleDnd(key, val) {
  const d = getDnd();
  d[key] = val;
  saveDnd(d);
  renderSettings();
}
function testPush() {
  const d = getDnd();
  if (!d.enabled) { toast('🔕 推送已关闭，消息不会送达'); return; }
  if (d.mute && isDndNow(d)) { toast(`🔕 免打扰时段（${d.from}–${d.to}），消息已静音`); return; }
  notify('惜食盲盒 · 测试推送', '你订阅的店铺有新盲盒上架啦！' + (pushChannelLabel(d) === '浏览器通知' ? '' : '（应用内提醒）'));
}
/* 补货推送：订阅店铺/品类在自动刷新中出现补货时提醒 */
function maybePushRestock(changes) {
  if (!changes.length || !pushAllowed()) return;
  const subs = getSubs();
  const hit = changes.find(ch => subs.stores.includes(ch.s.id) || subs.cats.includes(ch.s.cat));
  if (hit) notify('惜食盲盒 · 补货提醒', `${hit.s.name}（${hit.s.cat}）补货，剩余 ${hit.s.remaining} 盒`);
}

/* ---- 店铺详情：档位 / 取货时段 / 价格趋势 ---- */
function openDetail(id) {
  curStore = stores.find(x => x.id === id);
  if (!curStore) return;
  curTierIdx = Math.max(0, curStore.tiers.findIndex(t => t.stock > 0));
  curQty = 1;
  curSlot = null;
  renderDetail();
  openModal();
}
function renderDetail() {
  modalView = 'detail';
  const s = curStore, t = s.tiers[curTierIdx];
  const total = (t.price * curQty).toFixed(1);
  modalBody.innerHTML = `
    <h2>${s.name} <span class="badge b-${statusOf(s.remaining)}">${STATUS[statusOf(s.remaining)].label}</span></h2>
    <div class="d-sub">${s.cat} · ${s.addr}</div>
    <div class="d-sub">🕒 今日自提 ${s.window} · 剩余 <b>${s.remaining}</b> 盒</div>
    <h3>选择盲盒档位（实时价格）</h3>
    ${s.tiers.map((t2, i) => `
      <div class="tier${i === curTierIdx ? ' sel' : ''}${t2.stock <= 0 ? ' off' : ''}" onclick="pickTier(${i})">
        <div><b>${t2.name}</b><span class="t-desc">${TIER_DESC[s.cat][i]}</span></div>
        <div><span class="t-price">¥${t2.price}</span><s>¥${t2.orig}</s><span class="t-stock">${t2.stock > 0 ? '剩 ' + t2.stock + ' 份' : '已售罄'}</span></div>
      </div>`).join('')}
    <div class="qty-row">数量
      <button onclick="chQty(-1)">−</button><b>${curQty}</b><button onclick="chQty(1)">＋</button>
      <span class="d-sub" style="margin-left:auto">合计 <b style="color:#ef4444">¥${total}</b></span>
    </div>
    <h3>选择取货时段</h3>
    <div class="slots">${s.slots.map((sl, i) => `<button class="slot${curSlot === i ? ' sel' : ''}" onclick="pickSlot(${i})">${sl}</button>`).join('')}</div>
    <h3>价格趋势 · 标准档近 7 日</h3>
    ${sparkline(s.trend)}
    <div class="btn-row">
      <button class="btn" onclick="openSubSettings()">🔔 ${isSubscribed(s.id) ? '已订阅补货提醒' : '订阅补货提醒'}</button>
    </div>
    <button class="btn primary big" onclick="gotoConfirm()">${t.stock > 0 ? `去下单 · ¥${total}` : '该店已售罄'}</button>`;
}
function pickTier(i) {
  const t = curStore.tiers[i];
  if (t.stock <= 0) { toast('该档位已售罄'); return; }
  curTierIdx = i;
  curQty = Math.min(curQty, t.stock);
  renderDetail();
}
function chQty(d) {
  const t = curStore.tiers[curTierIdx];
  curQty = Math.min(Math.max(1, curQty + d), Math.max(1, t.stock));
  renderDetail();
}
function pickSlot(i) { curSlot = i; renderDetail(); }
function sparkline(t) {
  const w = 260, h = 64, p = 10;
  const min = Math.min(...t), max = Math.max(...t), span = (max - min) || 1;
  const pts = t.map((v, i) => [p + i * (w - 2 * p) / (t.length - 1), h - p - (v - min) / span * (h - 2 * p)]);
  const path = pts.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="spark" width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${path}" fill="none" stroke="#059669" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="#059669"/>
    </svg>
    <div class="spark-meta">¥${min} – ¥${max} · 当前标准档 ¥${t[t.length - 1]}（演示数据）</div>`;
}

/* ---- 确认订单（读取用户过敏原配置） ---- */
function gotoConfirm() {
  const t = curStore.tiers[curTierIdx];
  if (curSlot == null) { toast('请先选择取货时段'); return; }
  if (t.stock <= 0) { toast('该档位已售罄'); return; }
  if (t.stock < curQty) { curQty = Math.max(1, t.stock); renderDetail(); toast('库存变化，数量已调整'); return; }
  renderConfirm();
}
function renderConfirm() {
  modalView = 'confirm';
  const t = curStore.tiers[curTierIdx];
  const ua = getAllergens();
  const risks = ua.filter(a => (CAT_ALLERGENS[curStore.cat] || []).includes(a));
  modalBody.innerHTML = `
    <h2>确认订单</h2>
    <div class="order-card">
      <div class="order-row"><span>${curStore.name}</span><span class="d-sub">${curStore.cat}</span></div>
      <div class="order-row"><span>${t.name}盲盒 × ${curQty}</span><span>¥${t.price} / 份</span></div>
      <div class="order-row"><span>取货时段</span><span>${curStore.slots[curSlot]}</span></div>
      <div class="order-row order-total"><span>合计</span><span>¥${(t.price * curQty).toFixed(1)}</span></div>
    </div>
    <h3>过敏原提示</h3>
    ${ua.length
      ? (risks.length
        ? `<div class="allergen-warn">⚠️ 你配置的过敏原「${risks.join('、')}」可能存在于该盲盒中，请谨慎下单。</div>`
        : `<div class="allergen-ok">✓ 与你配置的过敏原（${ua.join('、')}）无明显冲突。</div>`)
      : `<div class="allergen-none">尚未配置过敏原，为保障安全建议先设置。<div style="margin-top:6px"><button class="btn-mini" onclick="openAllergenSettings()">去设置过敏原</button></div></div>`}
    <div class="d-sub" style="margin-top:10px">⏱ 提交后需在 15 分钟内完成支付，超时订单将自动取消并释放库存。</div>
    <button class="btn primary big" onclick="submitOrder()">提交订单</button>`;
}

/* ---- 收银台：微信支付（模拟）+ 15 分钟超时自动取消 ---- */
function submitOrder() {
  const t = curStore.tiers[curTierIdx];
  t.stock -= curQty;
  curStore.remaining = curStore.tiers.reduce((a, x) => a + x.stock, 0);
  renderAll();
  const slotStartMin = curStore.startMin + curSlot * 30;
  activeOrder = {
    id: 'XH' + Date.now().toString().slice(-8),
    storeId: curStore.id,
    storeName: curStore.name,
    addr: curStore.addr,
    tierName: t.name,
    qty: curQty,
    slot: curStore.slots[curSlot],
    slotStartMin: slotStartMin,
    slotEndMin: slotStartMin + 30,
    gcj: toGcj(curStore.wgs), // [gcjLat, gcjLng]，用于导航
    total: (t.price * curQty).toFixed(1),
    createdAt: Date.now(),
    expireAt: Date.now() + 15 * 60 * 1000,
    status: 'unpaid',
    code: String(Math.floor(1000 + Math.random() * 9000)),
  };
  orders.unshift(activeOrder);
  saveOrders();
  renderPay();
}
function renderPay() {
  modalView = 'pay';
  const o = activeOrder;
  if (o.status === 'canceled') {
    modalBody.innerHTML = `
      <div class="pay-success">
        <div class="success-icon">❌</div>
        <h2>订单已取消</h2>
        <div class="d-sub">订单 ${o.id} 超过支付时限，已自动取消并释放库存。</div>
        <button class="btn primary big" onclick="closeModal()">知道了</button>
      </div>`;
    return;
  }
  if (o.status === 'paid') { renderSuccess(); return; }
  modalBody.innerHTML = `
    <h2>收银台 · 微信支付</h2>
    <div class="pay-amount">¥${o.total}</div>
    <div class="countdown">支付剩余 <b id="cdText">${fmtCd(o.expireAt - Date.now())}</b></div>
    <div class="order-card">
      <div class="order-row"><span>${o.storeName} · ${o.tierName}盲盒 × ${o.qty}</span><span>¥${o.total}</span></div>
      <div class="order-row"><span>取货时段</span><span>${o.slot}</span></div>
      <div class="order-row"><span>订单号</span><span>${o.id}</span></div>
    </div>
    <div class="pay-note">演示环境为模拟支付。正式接入：后端调用微信统一下单获取 prepay_id，前端在微信内置浏览器中通过 WeixinJSBridge.invoke('getBrandWCPayRequest', {...}) 唤起支付。</div>
    <button id="btnWechatPay" class="btn wechat big" onclick="payNow()">💬 微信支付</button>
    <div style="text-align:center"><button class="linklike" onclick="demoExpire()">（演示）把倒计时加速到 5 秒，观察自动取消</button></div>`;
}
function payNow() {
  const btn = document.getElementById('btnWechatPay');
  if (btn) { btn.disabled = true; btn.textContent = '正在唤起微信支付…'; }
  setTimeout(() => {
    if (!activeOrder || activeOrder.status !== 'unpaid') return;
    activeOrder.status = 'paid';
    activeOrder.paidAt = Date.now();
    saveOrders();
    renderSuccess();
    toast('支付成功');
  }, 1200);
}
function renderSuccess() {
  modalView = 'success';
  modalBody.innerHTML = `
    <div class="pay-success">
      <div class="success-icon">✅</div>
      <h2>支付成功</h2>
      <div class="pick-code">${activeOrder.code}</div>
      <div class="d-sub">凭取货码到店取货：${activeOrder.storeName} · ${activeOrder.tierName}盲盒 × ${activeOrder.qty}<br>取货时段：${activeOrder.slot}</div>
      <div class="btn-row">
        <button class="btn" onclick="closeModal()">完成</button>
        <button class="btn primary" onclick="openOrderDetail('${activeOrder.id}')">查看订单</button>
      </div>
    </div>`;
}
function demoExpire() {
  activeOrder.expireAt = Date.now() + 5000;
  renderPay();
  toast('演示：5 秒后将触发超时取消');
}
function restoreStock(o) {
  const st = stores.find(x => x.id === o.storeId);
  if (st) {
    const t = st.tiers.find(x => x.name === o.tierName);
    if (t) t.stock += o.qty;
    st.remaining = st.tiers.reduce((a, x) => a + x.stock, 0);
  }
}
function fmtCd(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ================= 订单管理（FR-C10） ================= */
const ORDER_STATUS = {
  unpaid: { label: '待支付' },
  paid: { label: '待取货' },
  verified: { label: '已核销' },
  canceled: { label: '已取消' },
  refunded: { label: '已退款' },
};
let orders = loadOrders();
let orderFilter = 'all';
let currentDetailOrder = null;

function loadOrders() { try { return JSON.parse(localStorage.getItem('xishi_orders')) || []; } catch (e) { return []; } }
function saveOrders() {
  try { localStorage.setItem('xishi_orders', JSON.stringify(orders)); } catch (e) { }
  updateOrderBadge();
}
function updateOrderBadge() {
  const n = orders.filter(o => o.status === 'unpaid' || o.status === 'paid').length;
  const b = document.getElementById('orderBadge');
  if (!b) return;
  b.textContent = n;
  b.style.display = n > 0 ? '' : 'none';
}
document.getElementById('btnOrders').addEventListener('click', () => openOrders('all'));
document.getElementById('btnMe').addEventListener('click', openMe);

function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---- 订单列表 ---- */
function openOrders(f) { renderOrders(f); openModal(); }
function renderOrders(f) {
  modalView = 'orders';
  orderFilter = f;
  const counts = { all: orders.length, unpaid: 0, paid: 0, verified: 0, canceled: 0, refunded: 0 };
  orders.forEach(o => counts[o.status]++);
  const defs = [['all', '全部'], ['unpaid', '待支付'], ['paid', '待取货'], ['verified', '已核销'], ['canceled', '已取消'], ['refunded', '已退款']];
  const list = orders.filter(o => f === 'all' || o.status === f).sort((a, b) => b.createdAt - a.createdAt);
  modalBody.innerHTML = `
    <h2>我的订单</h2>
    <div class="tabbar">${defs.map(([k, label]) =>
      `<button class="tab${f === k ? ' active' : ''}" onclick="renderOrders('${k}')">${label}${k !== 'all' ? ` ${counts[k]}` : ''}</button>`).join('')}</div>
    ${list.length ? list.map(o => `
      <div class="order-item" onclick="openOrderDetail('${o.id}')">
        <div class="oi-head"><b>${o.storeName}</b><span class="o-status os-${o.status}">${ORDER_STATUS[o.status].label}</span></div>
        <div class="oi-sub">${o.tierName}盲盒 × ${o.qty} · ${o.slot} 取货</div>
        <div class="oi-row2">
          <span class="d-sub">${fmtDateTime(o.createdAt)}</span>
          <span class="oi-total">¥${o.total}</span>
        </div>
        ${o.status === 'unpaid' ? `
        <div class="oi-row2">
          <span class="d-sub">⏱ ${fmtCd(Math.max(0, o.expireAt - Date.now()))} 后自动取消</span>
          <button class="btn-mini" onclick="event.stopPropagation();openOrderDetail('${o.id}')">去支付</button>
        </div>` : ''}
      </div>`).join('')
    : '<div class="empty">暂无相关订单</div>'}
    <div class="d-sub" style="margin-top:8px">订单保存在浏览器本地（localStorage），仅用于演示。</div>`;
}

/* ---- 订单详情：二维码 / 地址 / 导航 / 取货倒计时（FR-C06） ---- */
function openOrderDetail(id) {
  const o = orders.find(x => x.id === id);
  if (!o) { toast('订单不存在'); return; }
  if (o.status === 'unpaid') activeOrder = o; // 便于继续支付
  renderOrderDetail(o);
  openModal();
}
function renderOrderDetail(o) {
  modalView = 'orderDetail';
  currentDetailOrder = o;
  const st = ORDER_STATUS[o.status];
  let cdHtml = '';
  if (o.status === 'unpaid') {
    cdHtml = `<div class="pick-cd">支付剩余 <b>${fmtCd(Math.max(0, o.expireAt - Date.now()))}</b>，超时自动取消</div>`;
  } else if (o.status === 'paid') {
    const remain = pickupRemainMs(o);
    cdHtml = remain > 0
      ? `<div class="pick-cd">距取货时段结束还有 <b id="pickCd">${fmtCd(remain)}</b>，请按时到店</div>`
      : `<div class="pick-cd">取货时段已结束，如未取货请联系商家</div>`;
  }
  const needQr = o.status === 'paid' || o.status === 'verified';
  const actions =
    o.status === 'unpaid'
      ? `<button class="btn wechat big" onclick="resumePay()">💬 继续支付</button>
         <div class="btn-row"><button class="btn" onclick="cancelMyOrder('${o.id}')">取消订单</button></div>`
      : o.status === 'paid'
        ? `<div class="btn-row">
             <button class="btn" onclick="navToStore('${o.id}')">🧭 导航到店</button>
             <button class="btn" onclick="refundOrder('${o.id}')">申请退款</button>
           </div>
           <button class="btn primary big" onclick="verifyOrder('${o.id}')">✅ 模拟到店核销</button>`
        : o.status === 'verified'
          ? `<button class="btn primary big" onclick="openShareEditor('${o.id}')">📸 ${getPosts().some(p => p.orderId === o.id) ? '编辑晒单' : '晒单评价'}</button>`
        : '';
  modalBody.innerHTML = `
    <h2>订单详情 <span class="o-status os-${o.status}">${st.label}</span></h2>
    <div class="order-card">
      <div class="order-row"><span>${o.storeName}</span><span class="d-sub">${fmtDateTime(o.createdAt)}</span></div>
      <div class="order-row"><span>${o.tierName}盲盒 × ${o.qty}</span><span>¥${o.total}</span></div>
      <div class="order-row"><span>取货时段</span><span>${o.slot}</span></div>
      <div class="order-row"><span>订单号</span><span>${o.id}</span></div>
    </div>
    ${cdHtml}
    ${needQr ? `
    <div class="qr-wrap">
      <div id="qrbox">二维码生成中…</div>
      <div class="big-code">${o.code}</div>
      <div class="d-sub">到店出示二维码或口报取货码核销</div>
    </div>` : ''}
    <div class="d-sub">📍 ${o.addr}</div>
    ${actions}`;
  if (needQr) {
    const box = document.getElementById('qrbox');
    if (typeof QRCode !== 'undefined') {
      box.textContent = '';
      new QRCode(box, { text: `XISHI|${o.id}|${o.code}`, width: 190, height: 190, correctLevel: QRCode.CorrectLevel.M });
    } else {
      box.textContent = '二维码库加载失败，请出示取货码';
    }
  }
}
function pickupRemainMs(o) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(o.slotEndMin / 60), o.slotEndMin % 60);
  return end - now;
}
function resumePay() { renderPay(); }
function navToStore(id) {
  const o = orders.find(x => x.id === id);
  if (!o || !o.gcj) { toast('演示数据：缺少店铺坐标'); return; }
  // 高德导航 URI：to=经度,纬度（GCJ-02）
  window.open(`https://uri.amap.com/navigation?to=${o.gcj[1]},${o.gcj[0]},${encodeURIComponent(o.storeName)}&mode=walk&policy=0&src=xishi-demo&coordinate=gaode&callnative=0`, '_blank');
}
function verifyOrder(id) {
  const o = orders.find(x => x.id === id);
  if (!o || o.status !== 'paid') return;
  o.status = 'verified';
  o.verifiedAt = Date.now();
  if (activeOrder && activeOrder.id === id) activeOrder.status = 'verified';
  saveOrders();
  renderOrderDetail(o);
  toast('已核销，取餐愉快！');
}
function refundOrder(id) {
  const o = orders.find(x => x.id === id);
  if (!o || o.status !== 'paid') return;
  if (!confirm('确认申请退款？款项将原路退回（演示）。')) return;
  o.status = 'refunded';
  o.refundedAt = Date.now();
  restoreStock(o);
  renderAll();
  saveOrders();
  renderOrderDetail(o);
  toast('退款成功（演示）');
}
function cancelMyOrder(id) {
  const o = orders.find(x => x.id === id);
  if (!o || o.status !== 'unpaid') return;
  o.status = 'canceled';
  o.canceledAt = Date.now();
  if (activeOrder && activeOrder.id === id) activeOrder.status = 'canceled';
  restoreStock(o);
  renderAll();
  saveOrders();
  renderOrderDetail(o);
  toast('订单已取消，库存已释放');
}

/* ================= 晒单模块 & 碳账户 ================= */
const TIER_FOOD_KG = { '小份': 0.4, '标准': 0.6, '豪华': 0.9 };
const CO2_PER_KG = 2.5; // 每挽救 1kg 食物 ≈ 减少 2.5kg CO₂e（演示系数）

function getPosts() {
  try {
    const p = JSON.parse(localStorage.getItem('xishi_posts'));
    if (p) return p;
  } catch (e) { }
  const seeded = seedPosts();
  try { localStorage.setItem('xishi_posts', JSON.stringify(seeded)); } catch (e) { }
  return seeded;
}
function savePosts(list) {
  try { localStorage.setItem('xishi_posts', JSON.stringify(list)); }
  catch (e) { toast('本地存储空间不足，请减少图片数量'); }
}
function seedPosts() {
  const names = stores.slice(0, 3).map(s => s.name);
  const nick = ['爱吃的小鹿', '打工人干饭魂', '深夜食堂常客'];
  const texts = [
    '下班顺路取的，面包还是很软！三件只要 9 块 9，性价比无敌，明天还来～',
    '豪华盲盒开出来两个热菜一个汤，分量超预期，减少浪费从自己做起 👍',
    '第一次买惜食盲盒，扫码核销很方便，店里小姐姐还多送了个蛋挞',
  ];
  return names.map((name, i) => ({
    id: 'seed' + i, orderId: null, mine: false, nick: nick[i],
    storeName: name || '示例店铺', tierName: ['标准', '豪华', '小份'][i], qty: 1,
    text: texts[i], images: [], likes: [12, 25, 8][i], likedByMe: false,
    createdAt: Date.now() - [3, 26, 50][i] * 3600e3,
  }));
}

/* ---- 晒单编辑器：最多 9 张图 + 500 字评价 ---- */
let shareDraft = null; // { orderId, images:[], text, editId? }
function openShareEditor(orderId) {
  const o = orders.find(x => x.id === orderId);
  if (!o) return;
  const exist = getPosts().find(p => p.orderId === orderId);
  shareDraft = exist
    ? { orderId, images: [...exist.images], text: exist.text, editId: exist.id }
    : { orderId, images: [], text: '' };
  renderShareEditor();
  openModal();
}
function renderShareEditor() {
  modalView = 'shareEditor';
  const o = orders.find(x => x.id === shareDraft.orderId);
  modalBody.innerHTML = `
    <h2>晒单评价</h2>
    <div class="d-sub">${o.storeName} · ${o.tierName}盲盒 × ${o.qty}</div>
    <div class="img-grid">
      ${shareDraft.images.map((src, i) => `<div class="img-cell"><img src="${src}" alt="晒单图${i + 1}"><button class="rm" onclick="rmShareImg(${i})" title="删除图片">✕</button></div>`).join('')}
      ${shareDraft.images.length < 9 ? `<button class="img-add" onclick="document.getElementById('shareFile').click()" title="添加图片（最多 9 张）">＋</button>` : ''}
    </div>
    <input type="file" id="shareFile" accept="image/*" multiple class="hidden" onchange="addShareImgs(this)">
    <textarea id="shareText" class="share-text" maxlength="500" placeholder="写下你的取餐体验：口味、分量、新鲜度…（500 字以内）" oninput="document.getElementById('charCnt').textContent = this.value.length + ' / 500'">${shareDraft.text}</textarea>
    <div class="char-count" id="charCnt">${shareDraft.text.length} / 500</div>
    <button class="btn primary big" onclick="submitShare()">${shareDraft.editId ? '保存修改' : '发布晒单'}</button>`;
}
function addShareImgs(input) {
  const files = [...input.files].slice(0, 9 - shareDraft.images.length);
  input.value = '';
  if (!files.length) { toast('最多上传 9 张图片'); return; }
  let done = 0;
  files.forEach(f => compressImg(f, dataUrl => {
    shareDraft.images.push(dataUrl);
    if (++done === files.length) renderShareEditor();
  }));
}
function compressImg(file, cb) { // 压缩到最长边 800px，控制 localStorage 占用
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 800 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cb(cv.toDataURL('image/jpeg', 0.7));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
function rmShareImg(i) { shareDraft.images.splice(i, 1); renderShareEditor(); }
function submitShare() {
  const text = document.getElementById('shareText').value.trim();
  if (!text && !shareDraft.images.length) { toast('写点评价或上传图片再发布吧'); return; }
  const o = orders.find(x => x.id === shareDraft.orderId);
  const posts = getPosts();
  if (shareDraft.editId) {
    const p = posts.find(x => x.id === shareDraft.editId);
    if (p) { p.images = [...shareDraft.images]; p.text = text; p.createdAt = Date.now(); }
  } else {
    posts.unshift({
      id: 'p' + Date.now(), orderId: shareDraft.orderId, mine: true, nick: '我',
      storeName: o.storeName, tierName: o.tierName, qty: o.qty,
      text, images: [...shareDraft.images], likes: 0, likedByMe: false, createdAt: Date.now(),
    });
  }
  savePosts(posts);
  toast(shareDraft.editId ? '晒单已更新' : '发布成功，感谢分享！');
  shareDraft = null;
  openFeed();
}

/* ---- 晒单流浏览 ---- */
function fmtAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  return Math.floor(d / 86400e3) + ' 天前';
}
function openFeed() { renderFeed(); openModal(); }
function renderFeed() {
  modalView = 'feed';
  const posts = getPosts();
  modalBody.innerHTML = `
    <h2>📸 晒单广场</h2>
    <div class="d-sub">看看大家开出了什么好物，核销订单后也可以晒出自己的盲盒。</div>
    ${posts.map(p => `
      <div class="feed-item">
        <div class="feed-head">
          <span class="avatar">${p.mine ? '🙂' : '🧑'}</span>
          <span style="flex:1;min-width:0"><b>${p.nick}</b><div class="d-sub">${fmtAgo(p.createdAt)} · ${p.storeName} ${p.tierName}盲盒</div></span>
          ${p.mine ? `<button class="btn-mini" onclick="delPost('${p.id}')">删除</button>` : ''}
        </div>
        ${p.text ? `<div class="feed-text">${p.text}</div>` : ''}
        ${p.images.length ? `<div class="img-grid">${p.images.map(src => `<div class="img-cell"><img src="${src}" alt="晒单图"></div>`).join('')}</div>` : ''}
        <div style="text-align:right"><button class="like-btn${p.likedByMe ? ' liked' : ''}" onclick="toggleLike('${p.id}')">${p.likedByMe ? '❤' : '🤍'} ${p.likes}</button></div>
      </div>`).join('')}`;
}
function toggleLike(id) {
  const posts = getPosts();
  const p = posts.find(x => x.id === id);
  if (!p) return;
  p.likedByMe = !p.likedByMe;
  p.likes += p.likedByMe ? 1 : -1;
  savePosts(posts);
  renderFeed();
}
function delPost(id) {
  if (!confirm('删除这条晒单？')) return;
  savePosts(getPosts().filter(x => x.id !== id));
  renderFeed();
  toast('已删除');
}

/* ---- 碳账户：挽救食物 / 碳减排 / 成就徽章 ---- */
function carbonStats() {
  const verified = orders.filter(o => o.status === 'verified');
  const food = verified.reduce((a, o) => a + (TIER_FOOD_KG[o.tierName] || 0.6) * o.qty, 0);
  return {
    count: verified.length,
    food,
    co2: food * CO2_PER_KG,
    posts: getPosts().filter(p => p.mine).length,
  };
}
const BADGES = [
  { icon: '🥇', name: '首单打卡', desc: '完成 1 次核销', test: k => k.count >= 1 },
  { icon: '🥈', name: '惜食新秀', desc: '完成 3 次核销', test: k => k.count >= 3 },
  { icon: '🥉', name: '惜食达人', desc: '完成 5 次核销', test: k => k.count >= 5 },
  { icon: '🍞', name: '省粮先锋', desc: '挽救 ≥ 2.5kg 食物', test: k => k.food >= 2.5 },
  { icon: '🌍', name: '减碳卫士', desc: '减碳 ≥ 10kg CO₂e', test: k => k.co2 >= 10 },
  { icon: '📸', name: '晒单达人', desc: '发布 1 篇晒单', test: k => k.posts >= 1 },
];
function openCarbon() { renderCarbon(); openModal(); }
function renderCarbon() {
  modalView = 'carbon';
  const k = carbonStats();
  const trees = k.co2 / 18.3, km = k.co2 / 0.2; // 一棵树年吸碳约 18.3kg；汽车约 0.2kg CO₂/km
  modalBody.innerHTML = `
    <h2>🌱 我的碳账户</h2>
    <div class="stat-cards">
      <div class="stat-card"><b>${k.food.toFixed(1)}</b><span>挽救食物（kg）</span></div>
      <div class="stat-card alt"><b>${k.co2.toFixed(1)}</b><span>碳减排（kg CO₂e）</span></div>
    </div>
    <div class="d-sub" style="text-align:center">🌍 相当于 ${trees.toFixed(1)} 棵树一年的吸碳量 · 🚗 少开车约 ${Math.round(km)} 公里</div>
    <h3 style="margin-top:14px">成就徽章 ${BADGES.filter(b => b.test(k)).length} / ${BADGES.length}</h3>
    <div class="badge-grid">
      ${BADGES.map(b => `<div class="badge-cell ${b.test(k) ? 'on' : 'off'}"><span class="bi">${b.icon}</span><b>${b.name}</b>${b.desc}</div>`).join('')}
    </div>
    <div class="d-sub">已核销 ${k.count} 单，按 每盒 小份 0.4kg / 标准 0.6kg / 豪华 0.9kg 食物、每 1kg 食物 ≈ 2.5kg CO₂e 估算（演示数据）。灰色徽章完成条件后自动点亮。</div>`;
}

/* ---- 余量上报（FR-B01）：3 步向导 + 复制昨日余量 ---- */
function getReports() { try { return JSON.parse(localStorage.getItem('xishi_reports')) || []; } catch (e) { return []; } }
function saveReports(list) { try { localStorage.setItem('xishi_reports', JSON.stringify(list)); } catch (e) { } }
function fmtMin(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function parseMin(v) { const [h, m] = v.split(':').map(Number); return h * 60 + (m || 0); }
let reportState = null;
const reportProtect = {}; // storeId → 保护截止时间，上报后不被库存模拟覆盖

function openReport() {
  const s = getSession();
  if (!s || s.role !== 'merchant') {
    if (!confirm('余量上报是商家功能（FR-B01）。\n是否以演示商家身份继续？')) return;
  }
  reportState = { step: 1, storeId: null, qty: { '小份': 0, '标准': 0, '豪华': 0 }, startMin: 17 * 60, endMin: 21 * 60 };
  renderReport();
  openModal();
}
function renderReport() {
  modalView = 'report';
  const stepNames = ['选择店铺', '填写余量数量', '设置上架时段'];
  const dots = `<div class="rep-steps">${[1, 2, 3].map(i =>
    `<span class="rep-dot${reportState.step >= i ? ' on' : ''}">${i}</span>${i < 3 ? '<span class="rep-line"></span>' : ''}`).join('')}</div>
    <div class="d-sub" style="text-align:center">第 ${reportState.step} / 3 步 · ${stepNames[reportState.step - 1]}</div>`;
  let body = '';
  if (reportState.step === 1) body = reportStep1();
  else if (reportState.step === 2) body = reportStep2();
  else body = reportStep3();
  modalBody.innerHTML = `<h2>📋 余量上报</h2>${dots}${body}`;
}
function reportStep1() {
  const reports = getReports();
  return `
    <div class="d-sub">选择你的店铺，3 步完成今日余量上报，顾客端将实时可见。</div>
    ${stores.map(s => {
      const last = reports.filter(r => r.storeId === s.id).sort((a, b) => b.at - a.at)[0];
      return `<div class="rep-store" onclick="pickReportStore('${s.id}')">
        <div><b>${s.name}</b><div class="d-sub">${s.cat} · 当前余量 ${s.remaining} 盒${last ? ` · 上次上报 ${fmtAgo(last.at)}` : ' · 无历史记录'}</div></div>
        <span style="color:#059669">选择 ›</span>
      </div>`;
    }).join('')}`;
}
function pickReportStore(id) {
  const st = stores.find(x => x.id === id);
  if (!st) return;
  reportState.storeId = id;
  reportState.startMin = st.startMin || 17 * 60;
  reportState.endMin = (st.startMin || 17 * 60) + 240;
  reportState.step = 2;
  renderReport();
}
function reportStep2() {
  const st = stores.find(x => x.id === reportState.storeId);
  const last = getReports().filter(r => r.storeId === st.id).sort((a, b) => b.at - a.at)[0];
  return `
    <div class="d-sub"><b>${st.name}</b> · 填写各档位今晚可售数量（0 表示不上架）。</div>
    ${st.tiers.map(t => `
      <div class="rep-qty">
        <div><b>${t.name}</b><div class="d-sub">¥${t.price} 起 · 当前库存 ${t.stock} · 上限 ${t.cap ?? 99}</div></div>
        <div class="stepper">
          <button onclick="rqChange('${t.name}',-1)">−</button><b>${reportState.qty[t.name]}</b><button onclick="rqChange('${t.name}',1)">＋</button>
        </div>
      </div>`).join('')}
    ${last ? `<button class="btn" style="width:100%;margin-bottom:8px" onclick="copyYesterday()">📋 复制昨日余量（${fmtAgo(last.at)}上报：小份${last.tiers['小份'] || 0} / 标准${last.tiers['标准'] || 0} / 豪华${last.tiers['豪华'] || 0}）</button>` : '<div class="d-sub" style="text-align:center">该店暂无历史上报，手动填写即可</div>'}
    <div class="btn-row">
      <button class="btn" onclick="reportState.step=1;renderReport()">上一步</button>
      <button class="btn primary" onclick="reportState.step=3;renderReport()">下一步</button>
    </div>`;
}
function rqChange(name, d) {
  const st = stores.find(x => x.id === reportState.storeId);
  const cap = st ? (st.tiers.find(t => t.name === name)?.cap ?? 99) : 99; // 上报数量受档位上限约束（FR-B02）
  reportState.qty[name] = Math.max(0, Math.min(cap, (reportState.qty[name] || 0) + d));
  renderReport();
}
function copyYesterday() {
  const last = getReports().filter(r => r.storeId === reportState.storeId).sort((a, b) => b.at - a.at)[0];
  if (!last) return;
  reportState.qty = { '小份': last.tiers['小份'] || 0, '标准': last.tiers['标准'] || 0, '豪华': last.tiers['豪华'] || 0 };
  const st = stores.find(x => x.id === reportState.storeId);
  if (st) st.tiers.forEach(t => { reportState.qty[t.name] = Math.min(reportState.qty[t.name] || 0, t.cap ?? 99); });
  reportState.startMin = last.startMin;
  reportState.endMin = last.endMin;
  renderReport();
  toast('已复制昨日余量（超上限档位已自动裁剪）');
}
function reportStep3() {
  const st = stores.find(x => x.id === reportState.storeId);
  const total = reportState.qty['小份'] + reportState.qty['标准'] + reportState.qty['豪华'];
  return `
    <div class="d-sub"><b>${st.name}</b> · 设置今晚盲盒上架自提时段。</div>
    <div class="rep-time">⏰ <input type="time" value="${fmtMin(reportState.startMin)}" onchange="reportState.startMin=parseMin(this.value)"> 至 <input type="time" value="${fmtMin(reportState.endMin)}" onchange="reportState.endMin=parseMin(this.value)"></div>
    <div class="order-card">
      <div class="order-row"><span>小份盲盒</span><b>${reportState.qty['小份']} 份</b></div>
      <div class="order-row"><span>标准盲盒</span><b>${reportState.qty['标准']} 份</b></div>
      <div class="order-row"><span>豪华盲盒</span><b>${reportState.qty['豪华']} 份</b></div>
      <div class="order-row"><span>上架时段</span><span>${fmtMin(reportState.startMin)} – ${fmtMin(reportState.endMin)}</span></div>
      <div class="order-row"><span>合计</span><b class="order-total">${total} 盒</b></div>
    </div>
    ${total <= 0 ? '<div class="d-sub" style="text-align:center;color:#ef4444">数量均为 0，提交后该店今晚将显示「已售罄」</div>' : ''}
    <div class="btn-row">
      <button class="btn" onclick="reportState.step=2;renderReport()">上一步</button>
      <button class="btn primary" onclick="submitReport()">✅ 提交上报</button>
    </div>`;
}
function submitReport() {
  const st = stores.find(x => x.id === reportState.storeId);
  if (!st) return;
  if (reportState.endMin <= reportState.startMin) { toast('上架结束时间需晚于开始时间'); return; }
  st.tiers.forEach(t => { t.stock = reportState.qty[t.name] || 0; }); // 上报数量直接生效到店铺库存
  st.remaining = st.tiers.reduce((a, t) => a + t.stock, 0);
  reportProtect[st.id] = Date.now() + 30 * 60e3;
  const list = getReports();
  list.unshift({
    id: 'r' + Date.now(), storeId: st.id, storeName: st.name,
    tiers: { ...reportState.qty }, startMin: reportState.startMin, endMin: reportState.endMin, at: Date.now(),
  });
  saveReports(list);
  renderAll();
  reportState = null;
  closeModal();
  toast(`✅ 上报成功：${st.name} 余量 ${st.remaining} 盒已同步到顾客端`);
}

/* ---- 商品模板维护：品类 / 成本价 / 过敏原标签 / 保质期规则 ---- */
const SHELF_RULES = ['当日出清（打烊前售完）', '24 小时内（冷藏隔夜）', '48 小时内', '3 天内', '仅限当日自提'];
function getTplStore() { try { return JSON.parse(localStorage.getItem('xishi_templates')); } catch (e) { return null; } }
function saveTemplates(list) { try { localStorage.setItem('xishi_templates', JSON.stringify(list)); } catch (e) { } }
function allTemplates() {
  let t = getTplStore();
  if (!t) {
    t = [
      { id: 'tpl1', name: '软欧面包混合装', cat: '烘焙', cost: 9.9, allergens: ['麸质', '蛋', '乳制品'], shelfLife: '当日出清（打烊前售完）', at: Date.now() - 3 * 86400e3 },
      { id: 'tpl2', name: '熟食便当拼盘', cat: '熟食', cost: 12, allergens: ['麸质', '大豆'], shelfLife: '24 小时内（冷藏隔夜）', at: Date.now() - 2 * 86400e3 },
      { id: 'tpl3', name: '鲜奶茶饮双杯', cat: '饮品', cost: 8, allergens: ['乳制品'], shelfLife: '仅限当日自提', at: Date.now() - 86400e3 },
    ];
    saveTemplates(t);
  }
  return t;
}
let tplDraft = null; // 编辑中的模板草稿
function openTemplates() {
  const s = getSession();
  if (!s || s.role !== 'merchant') {
    if (!confirm('商品模板维护是商家功能。\n是否以演示商家身份继续？')) return;
  }
  tplDraft = null;
  renderTemplates();
  openModal();
}
function renderTemplates() {
  modalView = 'templates';
  const list = allTemplates();
  modalBody.innerHTML = `
    <h2>📦 商品模板</h2>
    <div class="d-sub">维护商品模板：品类、成本价、过敏原标签与保质期规则，供上架与下单风险比对复用。</div>
    ${list.map(t => `
      <div class="tpl-item">
        <div class="tpl-head"><b>${t.name}</b>
          <span><button class="btn-mini" onclick="editTpl('${t.id}')">编辑</button><button class="btn-mini" style="border-color:#fca5a5;color:#dc2626" onclick="delTpl('${t.id}')">删除</button></span>
        </div>
        <div class="d-sub" style="margin-top:4px">${t.cat} · 成本价 ¥${t.cost.toFixed(1)} · 建议盲盒价约 ¥${t.cost.toFixed(1)}（原价约 ¥${Math.round(t.cost * 3)}）</div>
        <div class="tpl-tags">
          ${t.allergens.map(a => `<span class="tpl-tag">⚠️ ${a}</span>`).join('') || '<span class="d-sub">未标注过敏原</span>'}
          <span class="tpl-tag life">🕒 ${t.shelfLife}</span>
        </div>
      </div>`).join('')}
    <button class="btn primary big" onclick="newTpl()">＋ 新建商品模板</button>`;
}
function newTpl() {
  tplDraft = { id: null, name: '', cat: '烘焙', cost: '', allergens: [], shelfLife: SHELF_RULES[0] };
  renderTplForm();
}
function editTpl(id) {
  const t = allTemplates().find(x => x.id === id);
  if (!t) return;
  tplDraft = { ...t, allergens: [...t.allergens] };
  renderTplForm();
}
function renderTplForm() {
  modalView = 'tplForm';
  const d = tplDraft;
  modalBody.innerHTML = `
    <h2>${d.id ? '编辑商品模板' : '新建商品模板'}</h2>
    <div class="form-label">模板名称</div>
    <input id="tplName" class="form-input" maxlength="20" placeholder="如：软欧面包混合装" value="${d.name}">
    <div class="form-label">品类（单选）</div>
    <div class="agg-chips">${CATS.map(c => `<label class="agg${d.cat === c ? ' on' : ''}"><input type="radio" name="tplCat" value="${c}"${d.cat === c ? ' checked' : ''}>${c}</label>`).join('')}</div>
    <div class="form-label">成本价（元）· 按盲盒价 ≈ 成本价、原价 ≈ 成本价 × 3 估算</div>
    <input id="tplCost" class="form-input" type="number" min="0" step="0.1" placeholder="如 9.9" value="${d.cost}">
    <div class="form-label">过敏原标签（多选，供确认订单页风险比对）</div>
    <div class="agg-chips">${ALLERGENS.map(a => `<label class="agg${d.allergens.includes(a) ? ' on' : ''}"><input type="checkbox" value="${a}"${d.allergens.includes(a) ? ' checked' : ''}>${a}</label>`).join('')}</div>
    <div class="form-label">保质期规则（单选）</div>
    <div class="agg-chips">${SHELF_RULES.map(r => `<label class="agg${d.shelfLife === r ? ' on' : ''}"><input type="radio" name="tplLife" value="${r}"${d.shelfLife === r ? ' checked' : ''}>${r}</label>`).join('')}</div>
    <div class="btn-row">
      <button class="btn" onclick="tplDraft=null;renderTemplates()">取消</button>
      <button class="btn primary" onclick="saveTpl()">保存模板</button>
    </div>`;
  modalBody.querySelectorAll('.agg input').forEach(i =>
    i.addEventListener('change', () => {
      if (i.type === 'checkbox') { i.closest('.agg').classList.toggle('on', i.checked); return; }
      modalBody.querySelectorAll(`input[name="${i.name}"]`).forEach(x => x.closest('.agg').classList.remove('on'));
      i.closest('.agg').classList.add('on');
    }));
}
function saveTpl() {
  const d = tplDraft;
  d.name = document.getElementById('tplName').value.trim();
  if (!d.name) { toast('请填写模板名称'); return; }
  const cost = parseFloat(document.getElementById('tplCost').value);
  if (isNaN(cost) || cost < 0) { toast('请填写有效的成本价'); return; }
  d.cost = +cost.toFixed(1);
  d.allergens = [...modalBody.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
  d.shelfLife = modalBody.querySelector('input[name="tplLife"]:checked')?.value || d.shelfLife;
  const list = allTemplates();
  if (d.id) {
    const i = list.findIndex(x => x.id === d.id);
    if (i > -1) list[i] = { ...d, at: Date.now() };
  } else {
    list.unshift({ ...d, id: 'tpl' + Date.now(), at: Date.now() });
  }
  saveTemplates(list);
  tplDraft = null;
  renderTemplates();
  toast('商品模板已保存');
}
function delTpl(id) {
  if (!confirm('删除该商品模板？')) return;
  saveTemplates(allTemplates().filter(x => x.id !== id));
  renderTemplates();
  toast('已删除');
}

/* ---- 盲盒档位设置（FR-B02）：三档数量上限 + 取货时间窗口 ---- */
let tierSetState = null; // { step, storeId, caps: {小份,标准,豪华}, startMin, endMin }
function openTierSet() {
  const s = getSession();
  if (!s || s.role !== 'merchant') {
    if (!confirm('盲盒档位设置是商家功能（FR-B02）。\n是否以演示商家身份继续？')) return;
  }
  tierSetState = { step: 1, storeId: null, caps: null, startMin: null, endMin: null };
  renderTierSet();
  openModal();
}
function renderTierSet() {
  modalView = 'tierSet';
  const dots = `<div class="rep-steps">${[1, 2].map(i => `<span class="rep-dot${tierSetState.step >= i ? ' on' : ''}">${i}</span>${i < 2 ? '<span class="rep-line"></span>' : ''}`).join('')}</div>
    <div class="d-sub" style="text-align:center">第 ${tierSetState.step} / 2 步 · ${tierSetState.step === 1 ? '选择店铺' : '设置档位上限与取货窗口'}</div>`;
  const body = tierSetState.step === 1 ? tierSetStep1() : tierSetStep2();
  modalBody.innerHTML = `<h2>🎚 盲盒档位设置</h2>${dots}${body}`;
}
function tierSetStep1() {
  return `
    <div class="d-sub">选择要配置的店铺：设置小份 / 标准 / 豪华三档每日数量上限，以及取货时间窗口（将按 30 分钟粒度生成自提时段）。</div>
    ${stores.map(s => `<div class="rep-store" onclick="pickTierStore('${s.id}')">
      <div><b>${s.name}</b><div class="d-sub">${s.cat} · 取货窗口 ${s.window} · 上限合计 ${s.tiers.reduce((a, t) => a + (t.cap ?? 10), 0)} 盒</div></div>
      <span style="color:#059669">设置 ›</span>
    </div>`).join('')}`;
}
function pickTierStore(id) {
  const st = stores.find(x => x.id === id);
  if (!st) return;
  tierSetState.storeId = id;
  tierSetState.caps = {};
  st.tiers.forEach(t => { tierSetState.caps[t.name] = t.cap ?? 10; });
  tierSetState.startMin = st.startMin ?? 17 * 60;
  tierSetState.endMin = st.endMin ?? (st.startMin ?? 17 * 60) + 120;
  tierSetState.step = 2;
  renderTierSet();
}
function tierSetStep2() {
  const st = stores.find(x => x.id === tierSetState.storeId);
  return `
    <div class="d-sub"><b>${st.name}</b> · 数量上限约束该档位每日可售量（0 表示暂停该档位）；取货窗口决定顾客可选的自提时段。</div>
    ${st.tiers.map(t => `
      <div class="rep-qty">
        <div><b>${t.name} ¥${t.price}</b><div class="d-sub">当前库存 ${t.stock} · 当前上限 ${t.cap ?? 10}</div></div>
        <div class="stepper">
          <button onclick="tcChange('${t.name}',-1)">−</button><b>${tierSetState.caps[t.name]}</b><button onclick="tcChange('${t.name}',1)">＋</button>
        </div>
      </div>`).join('')}
    <div class="form-label">取货时间窗口</div>
    <div class="rep-time">⏰ <input type="time" value="${fmtMin(tierSetState.startMin)}" onchange="tierSetState.startMin=parseMin(this.value)"> 至 <input type="time" value="${fmtMin(tierSetState.endMin)}" onchange="tierSetState.endMin=parseMin(this.value)"></div>
    <div class="d-sub" style="text-align:center">调整前：${st.window} · ${st.slots.length} 个自提时段 → 调整后：${fmtMin(tierSetState.startMin)}–${fmtMin(tierSetState.endMin)} · ${genSlots(tierSetState.startMin, tierSetState.endMin).length} 个自提时段</div>
    <div class="btn-row">
      <button class="btn" onclick="tierSetState.step=1;renderTierSet()">上一步</button>
      <button class="btn primary" onclick="saveTierSet()">保存设置</button>
    </div>`;
}
function tcChange(name, d) {
  tierSetState.caps[name] = Math.max(0, Math.min(99, (tierSetState.caps[name] || 0) + d));
  renderTierSet();
}
function saveTierSet() {
  const st = stores.find(x => x.id === tierSetState.storeId);
  if (!st) return;
  if (tierSetState.endMin <= tierSetState.startMin) { toast('取货结束时间需晚于开始时间'); return; }
  st.tiers.forEach(t => { t.cap = tierSetState.caps[t.name]; t.stock = Math.min(t.stock, t.cap); }); // 上限即刻生效：超额库存同步裁剪
  st.startMin = tierSetState.startMin;
  st.endMin = tierSetState.endMin;
  st.window = `${fmtMin(st.startMin)}–${fmtMin(st.endMin)}`;
  st.slots = genSlots(st.startMin, st.endMin);
  renderAll();
  tierSetState = null;
  closeModal();
  toast(`✅ 已保存：${st.name} 三档上限与取货窗口 ${st.window}（${st.slots.length} 个自提时段）`);
}

/* ---- 动态定价授权（FR-B03）：价格底线 / 算法建议价 / 定价时间轴 ---- */
let priceAuthState = null; // { storeId, tierName, floor, history:[{ts,price,type,note}], at }
function getPriceAuthStore() { try { return JSON.parse(localStorage.getItem('xishi_price_auth')); } catch (e) { return null; } }
function savePriceAuth(data) { try { localStorage.setItem('xishi_price_auth', JSON.stringify(data)); } catch (e) { } }
// 算法建议价：基于成本底线 + 库存稀缺度 + 剩余时间 + 历史销量
function suggestPrice(storeId, tierName, floor) {
  const s = stores.find(x => x.id === storeId);
  if (!s) return floor;
  const t = s.tiers.find(x => x.name === tierName);
  if (!t) return floor;
  // 1) 库存稀缺度：库存越低加成越高（0–30%）
  const cap = t.cap ?? 10;
  const scarcity = cap <= 1 ? 0.3 : Math.max(0, 0.3 - (t.stock / cap) * 0.25);
  // 2) 时间压力：距取货窗口结束越近，折扣越大（最多−35%）
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const end = s.endMin ?? (nowMin + 240);
  const remain = Math.max(0, end - nowMin);
  const timeDiscount = remain > 240 ? 0 : remain <= 30 ? 0.35 : 0.35 * (1 - remain / 240);
  // 3) 基础加成：成本底价的合理加成 10%
  const base = floor * 1.10;
  // 4) 参考价格锚点：不超过当前实时价（避免算法建议导致涨价引起客户投诉）
  let p = base * (1 + scarcity - timeDiscount);
  p = Math.min(p, t.price * 1.05);
  p = Math.max(p, floor);
  // 5) 整数定价：0.5 或 0.9 结尾（典型线下定价）
  const whole = Math.floor(p);
  const frac = p - whole;
  const f = frac < 0.5 ? 0.5 : 0.9;
  return +(whole + f).toFixed(1);
}
// 定价时间轴：按取货窗口阶段生成建议节点 + 实际历史价
function buildTimeline(s, tierName, floor, history) {
  const t = s.tiers.find(x => x.name === tierName);
  if (!t) return [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = s.startMin ?? 17 * 60, end = s.endMin ?? 21 * 60;
  const nodes = [
    { stage: '取货前 · 发布期',  deltaMin: start - 60, scarce: 1.0, type: '建议', note: '发布基准价 · 库存充足，按底价+10%定价' },
    { stage: '取货初期 · 早鸟价', deltaMin: start + 10, scarce: 1.0, type: '建议', note: '下单量较少，适度吸引首购' },
    { stage: '取货高峰 · 黄金档', deltaMin: start + 80, scarce: 1.25, type: '建议', note: '客流高峰，可按稀缺度提价' },
    { stage: '取货末段 · 清仓价', deltaMin: end - 40, scarce: 0.7, type: '建议', note: '临近收档，推荐打折清仓' },
  ];
  const items = [];
  // 算法建议节点
  nodes.forEach((n, i) => {
    const tmin = Math.max(0, n.deltaMin);
    const timeKey = new Date(today.getTime() + tmin * 60000);
    const cap = t.cap ?? 10;
    const scarcity = cap <= 1 ? 0.3 : Math.max(0, 0.3 - (t.stock / cap) * 0.25);
    const base = floor * 1.10;
    let remain = Math.max(0, end - tmin);
    const td = remain > 240 ? 0 : remain <= 30 ? 0.35 : 0.35 * (1 - remain / 240);
    let p = base * (1 + scarcity * (n.scarce - 1) - td);
    p = Math.max(floor, Math.min(p, t.price * 1.05));
    p = +(Math.floor(p) + (p - Math.floor(p) < 0.5 ? 0.5 : 0.9)).toFixed(1);
    items.push({ ts: timeKey.getTime(), stage: n.stage, price: p, type: '建议', note: n.note, cls: i >= 3 ? 'late' : i >= 2 ? 'mid' : '' });
  });
  // 实际历史价（若有）
  (history || []).forEach(h => items.push({ ts: h.ts, stage: h.note || '已执行', price: h.price, type: h.type, note: h.note, actual: true, cls: 'mid' }));
  return items.sort((a, b) => a.ts - b.ts);
}
function openPriceAuth() {
  const ss = getSession();
  if (!ss || ss.role !== 'merchant') {
    if (!confirm('动态定价授权是商家功能（FR-B03）。\n是否以演示商家身份继续？')) return;
  }
  priceAuthState = { step: 1, storeId: null, tierName: '标准', floor: null };
  renderPriceAuth();
  openModal();
}
function renderPriceAuth() {
  modalView = 'priceAuth';
  const stepNames = ['选择店铺与档位', '填写价格底线', '算法建议价 · 定价时间轴 · 授权确认'];
  const dots = `<div class="rep-steps">${[1,2,3].map(i => `<span class="rep-dot${priceAuthState.step >= i ? ' on' : ''}">${i}</span>${i < 3 ? '<span class="rep-line"></span>' : ''}`).join('')}</div>
    <div class="d-sub" style="text-align:center">第 ${priceAuthState.step} / 3 步 · ${stepNames[priceAuthState.step - 1]}</div>`;
  let body = '';
  if (priceAuthState.step === 1) body = priceStep1();
  else if (priceAuthState.step === 2) body = priceStep2();
  else body = priceStep3();
  modalBody.innerHTML = `<h2>💰 动态定价授权</h2>${dots}${body}`;
}
function priceStep1() {
  return `
    <div class="d-sub">选择店铺和档位：定价授权只作用于所选档位，避免误伤其他商品。</div>
    ${stores.map(s => `<div class="rep-store" onclick="pickPriceStore('${s.id}')">
      <div><b>${s.name}</b><div class="d-sub">${s.cat} · 取货窗口 ${s.window} · 当前价格 小份¥${s.tiers[0].price} / 标准¥${s.tiers[1].price} / 豪华¥${s.tiers[2].price}</div></div>
      <span style="color:#059669">选择 ›</span>
    </div>`).join('')}`;
}
function pickPriceStore(id) {
  priceAuthState.storeId = id;
  priceAuthState.step = 2;
  renderPriceAuth();
}
function priceStep2() {
  const s = stores.find(x => x.id === priceAuthState.storeId);
  const defaultFloors = { '小份': s.minPrice * 0.75, '标准': (s.tiers[1].price) * 0.7, '豪华': (s.tiers[2].price) * 0.65 };
  const cur = s.tiers.find(t => t.name === priceAuthState.tierName);
  // 已保存过的底价优先
  const saved = getPriceAuthStore();
  let savedFloor = null;
  if (saved && saved[priceAuthState.storeId] && saved[priceAuthState.storeId][priceAuthState.tierName]) {
    savedFloor = saved[priceAuthState.storeId][priceAuthState.tierName].floor;
  }
  if (priceAuthState.floor == null) priceAuthState.floor = savedFloor ?? Math.round(defaultFloors[priceAuthState.tierName] * 10) / 10;
  return `
    <div class="d-sub"><b>${s.name}</b> · 选择档位并填写价格底线（算法建议价不会低于此值）。</div>
    <div class="tier-chip-select">${s.tiers.map(t => `<span class="chip${t.name === priceAuthState.tierName ? ' active' : ''}" onclick="pickPriceTier('${t.name}')">${t.name} ¥${t.price}</span>`).join('')}</div>
    <div class="price-card-row">
      <div class="price-card">成本参考<div class="d-sub">模板/物料估算</div><b>¥${cur.orig ? (cur.orig / 3).toFixed(1) : '?'}</b></div>
      <div class="price-card current">当前售价<div class="d-sub">顾客端可见</div><b>¥${cur.price}</b></div>
    </div>
    <div class="form-label">价格底线（¥）· 算法不会低于此值</div>
    <input id="floorInput" class="form-input" type="number" min="0" step="0.5" value="${priceAuthState.floor}" oninput="priceAuthState.floor=parseFloat(this.value)||0">
    <div class="d-sub" style="text-align:center">建议底线：成本的 1.0–1.2 倍 · 当前当前价 ¥${cur.price} 的 7 折左右为 ¥${(cur.price * 0.7).toFixed(1)}</div>
    <div class="btn-row">
      <button class="btn" onclick="priceAuthState.step=1;renderPriceAuth()">上一步</button>
      <button class="btn primary" onclick="priceAuthState.step=3;renderPriceAuth()">查看建议价 ›</button>
    </div>`;
}
function pickPriceTier(n) {
  priceAuthState.tierName = n;
  priceAuthState.floor = null;
  renderPriceAuth();
}
function priceStep3() {
  const s = stores.find(x => x.id === priceAuthState.storeId);
  const t = s.tiers.find(x => x.name === priceAuthState.tierName);
  const floor = priceAuthState.floor ?? t.price * 0.7;
  const suggest = suggestPrice(priceAuthState.storeId, priceAuthState.tierName, floor);
  const saved = getPriceAuthStore();
  const savedFor = saved && saved[priceAuthState.storeId] && saved[priceAuthState.storeId][priceAuthState.tierName];
  const history = savedFor?.history || [];
  const tl = buildTimeline(s, priceAuthState.tierName, floor, history);
  return `
    <div class="d-sub"><b>${s.name}</b> · <b>${priceAuthState.tierName}</b> · 算法根据库存稀缺度、取货剩余时间动态给出建议。</div>
    <div class="price-card-row">
      <div class="price-card">底线价<div class="d-sub">商家授权底价</div><b>¥${floor.toFixed(1)}</b></div>
      <div class="price-card current">当前售价<div class="d-sub">实际售价</div><b>¥${t.price}</b></div>
      <div class="price-card suggest">建议价<div class="d-sub">算法推荐</div><b>¥${suggest.toFixed(1)}</b></div>
    </div>
    <div class="form-label">定价时间轴（按取货阶段给出建议 · 实际调价记录也会显示）</div>
    <div class="price-timeline">${tl.map(it => {
      const d = new Date(it.ts); const HH = String(d.getHours()).padStart(2,'0'); const MM = String(d.getMinutes()).padStart(2,'0');
      const priceClass = it.price < (t.price * 0.95) ? '' : it.price > t.price ? 'raise' : '';
      const badge = it.actual ? `<span class="badge b-ok" style="font-size:10px;padding:1px 6px">已执行</span>` : `<span class="badge b-low" style="font-size:10px;padding:1px 6px">建议</span>`;
      return `<div class="ptl-item${it.cls ? ' ' + it.cls : ''}">
        <div class="ptl-time">${HH}:${MM} · ${it.stage} ${badge}</div>
        <div>${it.note}</div><div class="ptl-price${priceClass ? ' ' + priceClass : ''}">¥${it.price.toFixed(1)}${it.price !== t.price ? `（${it.price > t.price ? '+' : ''}¥${(it.price - t.price).toFixed(1)}）` : ''}</div>
      </div>`;
    }).join('')}</div>
    <div class="btn-row">
      <button class="btn" onclick="priceAuthState.step=2;renderPriceAuth()">上一步</button>
      <button class="btn primary" onclick="applySuggest()">✅ 采纳 ¥${suggest.toFixed(1)} 为实时价</button>
    </div>
    <div class="d-sub" style="text-align:center;margin-top:4px">采纳后立即同步到顾客端的详情页与下单确认页。</div>`;
}
function applySuggest() {
  const s = stores.find(x => x.id === priceAuthState.storeId);
  if (!s) return;
  const t = s.tiers.find(x => x.name === priceAuthState.tierName);
  if (!t) return;
  const floor = priceAuthState.floor ?? t.price * 0.7;
  const suggest = suggestPrice(priceAuthState.storeId, priceAuthState.tierName, floor);
  const before = t.price;
  t.price = suggest;
  if (priceAuthState.tierName === '小份') s.minPrice = suggest;
  // 存档：底价 + 调价历史
  const data = getPriceAuthStore() || {};
  data[priceAuthState.storeId] = data[priceAuthState.storeId] || {};
  const prev = data[priceAuthState.storeId][priceAuthState.tierName] || { history: [] };
  const rec = { ts: Date.now(), price: suggest, type: '执行', note: `采纳建议价 ¥${before} → ¥${suggest}` };
  data[priceAuthState.storeId][priceAuthState.tierName] = { floor: floor, history: [...prev.history.slice(-19), rec] };
  savePriceAuth(data);
  renderAll();
  if (modalView === 'detail' && curStore && curStore.id === s.id) renderDetail();
  const tierName = priceAuthState.tierName;
  priceAuthState = null;
  closeModal();
  toast(`✅ 已采纳 ¥${suggest}：${s.name} ${tierName}档由 ¥${before} 调整为 ¥${suggest}`);
}

/* ---- 订单核销页面（FR-B05）：扫码/手动输入 → 校验 → 核销 ---- */
let html5QrCode = null; // 扫码实例
let verifyScanning = false;
function openVerify() {
  const ss = getSession();
  if (!ss || ss.role !== 'merchant') {
    if (!confirm('订单核销是商家功能（FR-B05）。\n是否以演示商家身份继续？')) return;
  }
  modalView = 'verify';
  renderVerify();
  openModal();
  // 弹层动画结束后再启动扫码（确保容器尺寸稳定）
  setTimeout(() => {
    if (modalView === 'verify') startScanner();
  }, 320);
}
function renderVerify(statusBox) {
  modalBody.innerHTML = `
    <h2>📷 订单核销</h2>
    <div class="d-sub">扫描顾客出示的取货二维码，或手动输入 6 位取货码完成核销。浏览器调用摄像头失败时会自动给出降级方案。</div>
    <div class="scan-wrap"><div id="qrReader">点击下方「启动摄像头扫码」开始</div></div>
    <div class="scan-tip" id="scanTip">就绪</div>
    ${statusBox || ''}
    <div class="scan-btns">
      <button class="btn" id="btnScanStart">📷 启动摄像头扫码</button>
      <button class="btn" id="btnScanStop" disabled>■ 停止</button>
    </div>
    <div class="form-label">或者手动输入 6 位取货码（演示环境推荐用此方式）</div>
    <div style="display:flex;gap:8px">
      <input id="vcodeInput" class="form-input" maxlength="6" inputmode="numeric" placeholder="如 391415" style="margin-bottom:0">
      <button class="btn primary" onclick="manualVerify()">核销</button>
    </div>`;
  document.getElementById('btnScanStart').addEventListener('click', startScanner);
  document.getElementById('btnScanStop').addEventListener('click', stopScanner);
  document.getElementById('vcodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') manualVerify(); });
}
function setScanTip(msg) { const el = document.getElementById('scanTip'); if (el) el.textContent = msg; }
function startScanner() {
  if (verifyScanning) return;
  const tips = [
    ['NotAllowedError', '摄像头权限被拒绝：请在浏览器设置里允许「相机」权限，或改用下方手动输入取货码。'],
    ['NotFoundError', '未检测到可用摄像头：请确认设备有摄像头且未被占用，或改用手动输入。'],
    ['NotReadableError', '摄像头被其他应用占用：请关闭占用程序，或改用手动输入。'],
    ['NotSecureError', '当前环境非 HTTPS 安全上下文：浏览器已禁止访问摄像头。请用 https 打开页面，或使用手动输入。'],
    ['OverconstrainedError', '摄像头配置不匹配：请尝试其他浏览器/设备，或改用手动输入。'],
    ['SecurityError', '浏览器安全策略阻止了摄像头访问：请检查页面权限设置，或使用手动输入。'],
    ['Unknown', '摄像头启动失败：请改用下方手动输入 6 位取货码核销。'],
  ];
  const fallback = msg => {
    verifyScanning = false;
    if (document.getElementById('btnScanStop')) document.getElementById('btnScanStop').disabled = true;
    if (document.getElementById('btnScanStart')) document.getElementById('btnScanStart').disabled = false;
    const errLine = tips.find(([k]) => msg && msg.indexOf(k) >= 0) || tips[0];
    const fallbackTip = tips.find(([k]) => (typeof msg === 'string') && msg.indexOf(k) >= 0)
      || (!window.isSecureContext ? tips[3] : tips[7]);
    if (modalView !== 'verify') return;
    renderVerify(`<div class="verify-status fail">⚠️ ${fallbackTip[1]}</div>`);
    setScanTip('已降级：请使用手动输入');
  };
  try {
    if (typeof Html5Qrcode === 'undefined') { fallback('LibLoadFail'); setScanTip('扫码库加载失败：使用手动输入'); return; }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') { fallback('NotSecureError'); return; }
    if (!window.isSecureContext) { fallback('NotSecureError'); return; }
    document.getElementById('btnScanStart').disabled = true;
    document.getElementById('btnScanStop').disabled = false;
    setScanTip('启动摄像头中…请允许相机权限');
    html5QrCode = html5QrCode || new Html5Qrcode('qrReader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE] });
    verifyScanning = true;
    html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 260, height: 260 } },
      decodedText => { onQrDecoded(decodedText); },
      () => { /* 每帧解析失败无需回调 */ }
    ).catch(err => {
      const n = (err && err.name) || 'Unknown';
      const m = (err && err.message) || '';
      console.error('[qr]', n, m);
      fallback(n + ' ' + m);
    });
    setScanTip('扫描中 · 请将二维码对准取景框');
  } catch (e) {
    console.error('[qr-catch]', e);
    fallback(((e && e.name) || 'Unknown') + ' ' + ((e && e.message) || ''));
  }
}
function stopScanner() {
  if (!html5QrCode) return;
  const wasScanning = verifyScanning;
  verifyScanning = false;
  const stop = () => {
    if (document.getElementById('btnScanStop')) document.getElementById('btnScanStop').disabled = true;
    if (document.getElementById('btnScanStart')) document.getElementById('btnScanStart').disabled = false;
    setScanTip('扫码已停止');
  };
  if (!wasScanning) { stop(); return; }
  try {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {}).finally(stop);
  } catch (e) { stop(); }
}
function onQrDecoded(text) {
  // 扫码成功：先停止摄像头，避免持续占用
  stopScanner();
  if (!text || typeof text !== 'string') { renderVerify(`<div class="verify-status fail">扫码失败：二维码内容为空或格式错误</div>`); return; }
  let orderId = null, code = null;
  if (text.indexOf('XISHI|') === 0) {
    const parts = text.split('|'); orderId = parts[1]; code = parts[2];
  } else if (/^o\d{9,}$/.test(text.trim())) {
    orderId = text.trim();
  } else if (/^\d{6}$/.test(text.trim())) {
    code = text.trim();
  }
  if (!orderId && !code) { renderVerify(`<div class="verify-status fail">二维码内容不匹配：<br>${escapeHtml(text)}</div>`); return; }
  const o = orderId ? orders.find(x => x.id === orderId) : orders.find(x => x.code === code);
  verifyOrder(o, code);
}
function manualVerify() {
  const code = document.getElementById('vcodeInput').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('请输入 6 位取货码'); return; }
  orders = loadOrders(); // 保证读取到最新持久化数据（如被 evaluate 或外部修改）
  const o = orders.find(x => x.code === code);
  verifyOrder(o, code);
}
function verifyOrder(o, code) {
  orders = loadOrders();
  if (!o) o = orders.find(x => x.code === code); // 若传入 o 已过时则重新查找
  if (!o) {
    renderVerify(`<div class="verify-status fail">❌ 未找到对应订单（取货码 ${code || '—'}）<br>请核对订单是否存在，或让顾客出示最新二维码。</div>`);
    return;
  }
  // 异常拦截链
  const s = getSession();
  if (s && s.role === 'merchant') {
    const sid = (o.storeId);
    // 模拟身份校验：正式版按当前商家登录的商户 ID 范围过滤
    // 演示模式下允许任意商户核销
  }
  if (o.status === 'unpaid') {
    const cd = fmtCd(Math.max(0, o.expireAt - Date.now()));
    renderVerify(`<div class="verify-status warn">⏳ 订单尚未支付<br>${o.storeName} · ${o.tierName} × ${o.qty}<br>剩余支付时间：${cd}，请提醒顾客完成支付。</div>`);
    return;
  }
  if (o.status === 'verified') {
    renderVerify(`<div class="verify-status warn">⚠️ 该订单已核销（${fmtAgo(o.verifiedAt)}）<br>订单号：${o.id} · ${o.storeName} · ${o.tierName} × ${o.qty}</div>`);
    return;
  }
  if (o.status === 'canceled') {
    renderVerify(`<div class="verify-status fail">🚫 订单已取消（${fmtAgo(o.canceledAt)}）<br>订单号：${o.id} · 金额 ¥${o.total}</div>`);
    return;
  }
  if (o.status === 'refunded') {
    renderVerify(`<div class="verify-status fail">🚫 订单已退款（${fmtAgo(o.refundedAt)}）<br>订单号：${o.id} · 金额 ¥${o.total}</div>`);
    return;
  }
  if (o.status !== 'paid') {
    renderVerify(`<div class="verify-status fail">❌ 当前订单状态不支持核销（${ORDER_STATUS[o.status].label}）<br>订单号：${o.id}</div>`);
    return;
  }
  // 取货时段校验：允许取货时段前 10 分钟开始核销
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  if (o.slotStartMin != null && o.slotEndMin != null) {
    if (nowMin < o.slotStartMin - 10) {
      const t = `${Math.floor((o.slotStartMin)/60)}:${String(o.slotStartMin%60).padStart(2,'0')}`;
      renderVerify(`<div class="verify-status warn">📌 未到取货时段<br>最早可核销时间：${t}（提前 10 分钟）。当前时段还不能取货。</div>`);
      return;
    }
    if (nowMin > o.slotEndMin + 30) {
      renderVerify(`<div class="verify-status warn">🕒 取货时段已结束超过 30 分钟<br>如为特殊情况可先联系顾客确认是否仍提供食物。当前未拦截，但建议核对订单详情。</div>`);
    }
  }
  // 通过：完成核销
  o.status = 'verified';
  o.verifiedAt = Date.now();
  saveOrders();
  renderVerify(`<div class="verify-status ok">✅ 核销成功！<br>
    <div style="margin-top:6px;text-align:left">
      <div>店铺：${o.storeName}</div>
      <div>商品：${o.tierName}盲盒 × ${o.qty}</div>
      <div>取货码：${o.code}</div>
      <div>订单号：${o.id}</div>
      <div>实付：¥${o.total}</div>
      <div>核销时间：${fmtDateTime(o.verifiedAt)}</div>
    </div></div>`);
  toast('核销成功');
}
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---- 盲盒紧急下架（FR-B06）：一键下架 + 退款进度 ---- */
let offState = null; // { view:'list'|'progress', storeId, taskId, target:{total,succeeded,failed,running,items:[{id,status,msg,amount}]} }
function openOffload() {
  const ss = getSession();
  if (!ss || ss.role !== 'merchant') {
    if (!confirm('盲盒紧急下架是商家功能（FR-B06）。\n是否以演示商家身份继续？')) return;
  }
  offState = { view: 'list' };
  renderOffload();
  openModal();
}
function renderOffload() {
  modalView = 'offload';
  if (offState.view === 'progress') return renderOffProgress();
  // 默认视图：P1 在售店铺+档位概览，可按店一键下架
  const activeStores = stores.filter(s => s.remaining > 0);
  const paidCount = loadOrders().filter(o => o.status === 'paid').length;
  modalBody.innerHTML = `
    <h2>🛑 盲盒紧急下架</h2>
    <div class="d-sub">紧急情况（如突发食安 / 停电 / 闭店）可一键下架某店所有在售盲盒，并自动对「待取货」订单发起批量退款，实时展示退款进度（P1：在售档位与受影响订单；P2：退款结果明细）。</div>
    <div class="refund-grid">
      <div class="refund-box p"><b>${activeStores.length}</b><span>在售店铺</span></div>
      <div class="refund-box r"><b>${paidCount}</b><span>待取货订单</span></div>
      <div class="refund-box f"><b>¥${paidCount > 0 ? loadOrders().filter(o => o.status === 'paid').reduce((a, o) => a + parseFloat(o.total || 0), 0).toFixed(1) : '0.0'}</b><span>涉及金额</span></div>
    </div>
    <div class="form-label">P1 · 选择下架对象（按店铺粒度，可影响其全部档位和所有待取货订单）</div>
    ${activeStores.length === 0 ? '<div class="empty">当前没有在售盲盒</div>' :
      activeStores.map(s => {
        const paid = loadOrders().filter(o => o.storeId === s.id && o.status === 'paid').length;
        return `<div class="off-card">
          <div class="off-head"><b>${s.name}</b>
            <button class="btn-mini" style="border-color:#fca5a5;color:#dc2626" onclick="offAllTiers('${s.id}')">🛑 一键下架 + 退款</button>
          </div>
          <div class="off-meta">${s.cat} · ${s.addr.substring(0, 16)} · 剩余盲盒 <b>${s.remaining}</b> 盒 · 待取货订单 <b>${paid}</b> 单</div>
          <div class="off-tiers">${s.tiers.map(t =>
            `<span class="off-tier${t.stock > 0 ? ' danger' : ''}">${t.name}¥${t.price} × ${t.stock}</span>`).join('')}</div>
        </div>`;
      }).join('')
    }
    <button class="btn" style="width:100%" onclick="offAllTiers('all')">⚠️ 一键下架所有店铺（极端场景）</button>
    <div class="d-sub" style="text-align:center;margin-top:6px">P2：执行后会进入退款进度页，展示「处理中/已退款/失败」明细。</div>`;
}
function renderOffProgress() {
  const t = offState.target;
  const done = t.succeeded + t.failed;
  const pct = t.total === 0 ? 100 : Math.round(done / t.total * 100);
  const storeName = offState.storeId === 'all' ? '全部店铺' : (stores.find(s => s.id === offState.storeId)?.name || '—');
  modalBody.innerHTML = `
    <h2>🛑 退款进度 · ${storeName}</h2>
    <div class="d-sub">下架执行：该店铺剩余库存已清零（置为已售罄），并对待取货订单批量发起退款。</div>
    <div class="refund-grid">
      <div class="refund-box p"><b>${t.succeeded}</b><span>已退款</span></div>
      <div class="refund-box r"><b>${t.running + t.total - done}</b><span>处理中</span></div>
      <div class="refund-box f"><b>${t.failed}</b><span>失败</span></div>
    </div>
    <div class="form-label">退款进度（共 ${t.total} 单）</div>
    <div class="progress-bar${t.failed > 0 ? ' warn' : ''}"><i style="width:${pct}%"></i></div>
    <div class="d-sub" style="text-align:center;margin-bottom:8px">${pct}% · ${done} / ${t.total} 单</div>
    <div class="form-label">P2 · 退款结果明细（已退款为绿色、失败为红色、处理中为灰色）</div>
    <div style="border:1px solid #e2e8f0;border-radius:12px;padding:6px 10px;max-height:260px;overflow:auto;background:#fff">
      ${t.items.length === 0 ? '<div class="empty">没有受影响的待取货订单（仅对店铺库存进行了清零）</div>' :
        t.items.map(it => {
          const cls = it.status === 'success' ? '#059669' : it.status === 'fail' ? '#dc2626' : '#94a3b8';
          const tag = it.status === 'success' ? '✅ 已退款' : it.status === 'fail' ? '❌ 失败' : '⏳ 处理中';
          const detail = it.status === 'success'
            ? `¥${it.amount}（${fmtTime(it.at)}）`
            : it.status === 'fail' ? it.msg : '即将处理…';
          return `<div class="refund-item"><span style="color:${cls};font-weight:600">${tag} ${it.id}</span><span style="color:#64748b">${detail}</span></div>`;
        }).join('')
      }
    </div>
    ${done >= t.total ? `
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" onclick="offState.view='list';renderOffload()">返回店铺列表</button>
        <button class="btn primary" onclick="${t.failed > 0 ? 'retryFailedOff()' : 'closeModal()'}">${t.failed > 0 ? '🔁 重试失败订单' : '完成'}</button>
      </div>` : ''}
    `;
}
function fmtTime(ts) { const d = new Date(ts); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function offAllTiers(storeId) {
  const targets = storeId === 'all' ? stores.slice() : [stores.find(s => s.id === storeId)].filter(Boolean);
  if (!targets.length) return;
  orders = loadOrders(); // 保证使用并修改全局 orders，避免与 saveOrders 脱节
  // 1) 先对店铺全部档位做库存清零（一键下架）
  const affectedOrderIds = [];
  targets.forEach(s => {
    s.tiers.forEach(t => { t.stock = 0; });
    s.remaining = 0;
    reportProtect[s.id] = Date.now() + 60 * 60e3; // 1 小时内不允许库存模拟回填，保持下架状态
  });
  // 2) 收集受影响订单：目标店铺且 status='paid'（待取货）
  targets.forEach(s => {
    orders.filter(o => o.storeId === s.id && o.status === 'paid').forEach(o => affectedOrderIds.push(o.id));
  });
  if (targets.length === 1 && affectedOrderIds.length === 0) {
    if (!confirm(`确认下架「${targets[0].name}」的所有盲盒？\n（当前无待取货订单，仅清零库存与售罄）`)) { renderAll(); return; }
  } else if (storeId === 'all') {
    if (!confirm(`⚠️ 确认下架全部 ${targets.length} 家店铺的盲盒？\n涉及 ${affectedOrderIds.length} 笔待取货订单，将批量发起退款。此操作不可撤销。`)) { renderAll(); return; }
  } else {
    if (!confirm(`确认下架「${targets[0].name}」所有盲盒？\n将对 ${affectedOrderIds.length} 笔待取货订单发起退款。此操作不可撤销。`)) { renderAll(); return; }
  }
  // 3) 初始化进度任务
  const items = affectedOrderIds.length === 0 ? [] :
    orders.filter(o => affectedOrderIds.includes(o.id))
      .map(o => ({ id: o.id, status: 'pending', msg: '', amount: o.total }));
  offState = {
    view: 'progress',
    storeId: storeId,
    target: {
      total: items.length,
      succeeded: 0,
      failed: 0,
      running: items.length,
      items: items,
    }
  };
  renderAll();
  renderOffProgress();
  if (items.length === 0) return; // 没有待取货订单就结束
  // 4) 渐进式执行退款（每 100ms 处理 1 单，便于观察进度条）
  let idx = 0;
  const step = () => {
    if (idx >= items.length) return;
    const it = items[idx++];
    const o = orders.find(x => x.id === it.id);
    try {
      if (!o) throw new Error('订单不存在');
      if (o.status !== 'paid') throw new Error(`当前状态不可退款：${ORDER_STATUS[o.status].label}`);
      o.status = 'refunded';
      o.refundedAt = Date.now();
      o.offloadedAt = Date.now();
      restoreStockSafe(o);
      it.status = 'success';
      it.at = Date.now();
      offState.target.succeeded++;
      offState.target.running = Math.max(0, offState.target.running - 1);
    } catch (e) {
      it.status = 'fail';
      it.msg = e.message || '退款失败';
      it.at = Date.now();
      offState.target.failed++;
      offState.target.running = Math.max(0, offState.target.running - 1);
    }
    saveOrders();
    renderOffProgress();
    if (idx < items.length) setTimeout(step, 100);
  };
  setTimeout(step, 200);
}
// 安全版 restoreStock：避免与现有 restoreStock 冲突但保证名称与逻辑一致
function restoreStockSafe(o) {
  const st = stores.find(x => x.id === o.storeId);
  if (st) {
    const t = st.tiers.find(x => x.name === o.tierName);
    if (t) {
      t.stock += o.qty; // 注意：紧急下架的退款是因为商家不能履约，一般不放回上架库存，演示为记录一致性略加
    }
  }
}
function retryFailedOff() {
  const t = offState.target;
  const failItems = t.items.filter(i => i.status === 'fail');
  if (failItems.length === 0) return;
  orders = loadOrders(); // 同步内存与持久化，防止重试读旧状态
  failItems.forEach(it => {
    const o = orders.find(x => x.id === it.id);
    try {
      if (!o) throw new Error('订单不存在');
      if (o.status !== 'paid') throw new Error(`当前状态：${ORDER_STATUS[o.status].label}`);
      o.status = 'refunded'; o.refundedAt = Date.now(); o.offloadedAt = Date.now();
      restoreStockSafe(o);
      it.status = 'success'; it.at = Date.now(); it.msg = '';
      t.succeeded++; t.failed--;
    } catch (e) {
      it.msg = e.message || '退款失败'; it.at = Date.now();
    }
  });
  saveOrders();
  renderOffProgress();
  toast(`重试 ${failItems.length} 单 · 剩余失败 ${t.failed}`);
}

/* ---- 实时看板（FR-B04）：当日已售 / 剩余库存 / 收入 / 订单提醒 ---- */
let dashTimer = null;
function startOfDay(ts = Date.now()) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function todayOrders() {
  const sod = startOfDay();
  return loadOrders().filter(o => o.createdAt >= sod);
}
function dashStats() {
  const today = todayOrders();
  // 当日已售 = 当日创建且 (已核销 或 已支付待取货 或 退款但已创建即视为售出占比，已核销代表实际达成)
  const paid = today.filter(o => o.status === 'paid');
  const verified = today.filter(o => o.status === 'verified');
  const canceled = today.filter(o => o.status === 'canceled');
  const refunded = today.filter(o => o.status === 'refunded');
  const soldBoxes = today.reduce((a, o) => a + (o.status !== 'canceled' && !o.unpaidBox ? o.qty : 0), 0) + verified.reduce((a, o) => a + o.qty, 0);
  // 更简洁口径：已核销盒数 + 当前待取货盒数（视为已售尚未取货）
  const soldToday = verified.reduce((s, o) => s + o.qty, 0) + paid.reduce((s, o) => s + o.qty, 0);
  // 收入：已核销实收 + 已支付待取货实收
  const income = [...paid, ...verified].reduce((s, o) => s + parseFloat(o.total || 0), 0);
  // 剩余库存：全部店铺档位之和
  const remaining = stores.reduce((s, st) => s + st.tiers.reduce((a, t) => a + t.stock, 0), 0);
  // 异常订单：超过当前支付窗口仍 unpaid 或 取货时段已结束仍 paid
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const alerts = today.filter(o =>
    (o.status === 'unpaid' && Date.now() > o.expireAt - 60000) ||
    (o.status === 'paid' && o.slotEndMin != null && nowMin > o.slotEndMin + 30)
  ).length;
  // 店铺销量排行（按今天已核销+待取货盒数）
  const rankMap = {};
  [...paid, ...verified].forEach(o => { rankMap[o.storeId] = (rankMap[o.storeId] || 0) + o.qty; });
  const ranking = stores
    .map(s => ({ id: s.id, name: s.name, qty: rankMap[s.id] || 0, remain: s.remaining }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);
  const maxQty = Math.max(1, ranking[0]?.qty || 1);
  return { soldToday, income, remaining, alerts, verified: verified.length, paid: paid.length, canceled: canceled.length, refunded: refunded.length, ranking, maxQty };
}
function feedItems() {
  const today = todayOrders().sort((a, b) => (b.verifiedAt || b.createdAt) - (a.verifiedAt || a.createdAt)).slice(0, 20);
  const list = [];
  today.forEach(o => {
    if (o.status === 'verified') list.push({ cls: 'ok', time: fmtAgo(o.verifiedAt), text: `✅ ${o.storeName} · ${o.tierName}×${o.qty} 核销 ¥${o.total}` });
    else if (o.status === 'paid') list.push({ cls: 'info', time: fmtAgo(o.createdAt), text: `💰 ${o.storeName} · ${o.tierName}×${o.qty} 新待取货 ¥${o.total}` });
    else if (o.status === 'refunded') list.push({ cls: 'fail', time: fmtAgo(o.refundedAt || o.createdAt), text: `↩️ 退款 ${o.id.slice(-5)} ${o.tierName}×${o.qty} ¥${o.total}` });
    else if (o.status === 'canceled') list.push({ cls: 'fail', time: fmtAgo(o.canceledAt || o.createdAt), text: `✖ 取消 ${o.id.slice(-5)} 未支付` });
  });
  return list;
}
let lastFeedCount = 0;
function openDashboard() {
  const ss = getSession();
  if (!ss || ss.role !== 'merchant') {
    if (!confirm('实时看板是商家功能（FR-B04）。\n是否以演示商家身份继续？')) return;
  }
  modalView = 'dashboard';
  renderDashboard();
  openModal();
  if (dashTimer) clearInterval(dashTimer);
  lastFeedCount = feedItems().length;
  dashTimer = setInterval(() => {
    if (modalView !== 'dashboard') { clearInterval(dashTimer); dashTimer = null; return; }
    // 每 10 秒刷新数据；如果 feed 条数增加就推送订单提醒
    renderDashboard();
    const newN = feedItems().length;
    if (newN > lastFeedCount) {
      notify('🔔 有新的订单动态', '看板中有新的核销/支付状态更新，点击查看');
    }
    lastFeedCount = newN;
  }, 10000);
}
function renderDashboard() {
  if (modalView !== 'dashboard') return;
  const st = dashStats();
  const feed = feedItems();
  modalBody.innerHTML = `
    <h2>📊 实时看板</h2>
    <div class="d-sub" style="text-align:center;margin-bottom:6px">数据每 10 秒自动刷新 · ${new Date().toLocaleString('zh-CN')}</div>
    <div class="dash-grid-4">
      <div class="dash-card sales">当日已售<span class="d-sub">盒（已核销+待取货）</span><b>${st.soldToday}</b><span class="d-sub">核销 ${st.verified} · 待取 ${st.paid}</span></div>
      <div class="dash-card stock">剩余库存<span class="d-sub">全平台累计</span><b>${st.remaining}</b><span class="d-sub">店铺 ${stores.filter(s => s.remaining > 0).length} 家在售</span></div>
      <div class="dash-card income">今日收入<span class="d-sub">已核销+待取货实收</span><b>¥${st.income.toFixed(1)}</b><span class="d-sub">客单 ¥${st.soldToday > 0 ? (st.income / st.soldToday).toFixed(1) : '0.0'}</span></div>
      <div class="dash-card alert">异常待处理<span class="d-sub">超时未支付/超时未取货</span><b>${st.alerts}</b><span class="d-sub">取消 ${st.canceled} · 退款 ${st.refunded}</span></div>
    </div>
    <div class="form-label">📈 店铺销量 TOP（按今日盒数）</div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:6px 10px">
      ${st.ranking.length === 0 ? '<div class="empty">今日暂无销量</div>' :
        st.ranking.map((r, i) => `
          <div class="rank-row">
            <span style="width:18px;color:${i < 3 ? '#d97706' : '#64748b'};font-weight:700">${i + 1}</span>
            <span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${r.name}</span>
            <span class="bar"><i style="width:${Math.round(r.qty / st.maxQty * 100)}%"></i></span>
            <span style="width:76px;text-align:right;color:#059669;font-weight:600">${r.qty} 盒</span>
          </div>`).join('')}
    </div>
    <div class="form-label">🔔 订单动态 · 实时提醒</div>
    <div class="feed-list">
      ${feed.length === 0 ? '<div class="empty">暂无今日动态</div>' :
        feed.map(f => `<div class="feed-item ${f.cls}"><span class="fd">${f.time}</span><span>${f.text}</span></div>`).join('')}
    </div>`;
}

/* ---- 损耗报表（FR-B07）：周/月切换 · 挽回损失 · 损耗率 · 碳减排 · 分享海报 ---- */
let rptRange = 'week'; // 'week' | 'month'
function rangeWindow() {
  const now = new Date();
  const end = now.getTime();
  const start = rptRange === 'week'
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime()
    : new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { start, end, label: rptRange === 'week' ? '近 7 日' : '本月' };
}
function reportStats() {
  const { start } = rangeWindow();
  const list = loadOrders().filter(o => o.createdAt >= start);
  const verified = list.filter(o => o.status === 'verified');
  const refunded = list.filter(o => o.status === 'refunded');
  const canceled = list.filter(o => o.status === 'canceled');
  // 盒数
  const vBoxes = verified.reduce((s, o) => s + o.qty, 0);
  const rBoxes = refunded.reduce((s, o) => s + o.qty, 0);
  const cBoxes = canceled.reduce((s, o) => s + o.qty, 0);
  const totalBoxes = vBoxes + rBoxes + cBoxes;
  // 挽回损失金额：核销的原价×盒数 - 实收
  let origSaved = 0, paid = 0;
  verified.forEach(o => {
    const s = stores.find(x => x.id === o.storeId);
    const t = s?.tiers.find(x => x.name === o.tierName);
    const orig = t?.orig ?? (parseFloat(o.total) * 3);
    origSaved += orig * o.qty;
    paid += parseFloat(o.total);
  });
  const saved = Math.max(0, origSaved - paid);
  // 损耗率：(退款盒数 + 取消盒数 × 0.3) / 总盒数 ；取消未支付按 30% 权重计入浪费
  const lossBase = rBoxes + cBoxes * 0.3;
  const lossRate = totalBoxes > 0 ? (lossBase / totalBoxes) : 0;
  // 碳减排：核销盒数挽救重量（0.4/0.6/0.9 kg 对应档位）× 2.5 kg CO₂e
  let kg = 0;
  verified.forEach(o => {
    const w = o.tierName === '小份' ? 0.4 : o.tierName === '标准' ? 0.6 : 0.9;
    kg += w * o.qty;
  });
  const co2 = kg * 2.5;
  const trees = co2 / 21.77; // 一棵树每年约吸收 21.77 kg
  const km = co2 / 0.192; // 乘用车每公里约 0.192 kg CO2
  // 挽回金额再换算：按「原本倒掉的食物价值」= saved（原价-实付）
  return {
    verified: verified.length, refunded: refunded.length, canceled: canceled.length,
    vBoxes, rBoxes, cBoxes, totalBoxes,
    saved, lossRate, kg, co2, trees, km, income: paid,
  };
}
function openReports() {
  const ss = getSession();
  if (!ss || ss.role !== 'merchant') {
    if (!confirm('损耗报表是商家功能（FR-B07）。\n是否以演示商家身份继续？')) return;
  }
  rptRange = 'week';
  renderReports();
  openModal();
}
function renderReports() {
  modalView = 'reports';
  const { start, end, label } = rangeWindow();
  const r = reportStats();
  const startDate = new Date(start).toLocaleDateString('zh-CN');
  const endDate = new Date(end).toLocaleDateString('zh-CN');
  modalBody.innerHTML = `
    <h2>📈 损耗报表</h2>
    <div class="tier-chip-select" style="justify-content:center">
      <span class="chip${rptRange === 'week' ? ' active' : ''}" onclick="rptRange='week';renderReports()">📅 周报（近 7 日）</span>
      <span class="chip${rptRange === 'month' ? ' active' : ''}" onclick="rptRange='month';renderReports()">🗓 月报（本月）</span>
    </div>
    <div class="d-sub" style="text-align:center">${label}：${startDate} ~ ${endDate}</div>
    <div class="dash-grid-4">
      <div class="dash-card sales">核销订单<span class="d-sub">笔</span><b>${r.verified}</b><span class="d-sub">共 ${r.vBoxes} 盒</span></div>
      <div class="dash-card alert">退款+取消<span class="d-sub">笔</span><b>${r.refunded + r.canceled}</b><span class="d-sub">退款盒 ${r.rBoxes} · 取消盒 ${r.cBoxes}</span></div>
      <div class="dash-card income">挽回损失<span class="d-sub">原价差额</span><b>¥${r.saved.toFixed(0)}</b><span class="d-sub">实收 ¥${r.income.toFixed(0)}</span></div>
      <div class="dash-card stock">损耗率<span class="d-sub">退款+0.3×取消</span><b>${(r.lossRate * 100).toFixed(1)}%</b><span class="d-sub">总盒 ${r.totalBoxes}</span></div>
    </div>
    <div class="form-label">🌱 碳减排贡献（${label}）</div>
    <div class="dash-grid-3">
      <div class="dash-card">挽救食物<span class="d-sub">约</span><b>${r.kg.toFixed(1)} kg</b></div>
      <div class="dash-card">CO₂e 减排<span class="d-sub">约</span><b>${r.co2.toFixed(1)} kg</b></div>
      <div class="dash-card">相当于<span class="d-sub">直观类比</span><b>${r.trees.toFixed(2)} 棵树</b><span class="d-sub">或少开车 ${r.km.toFixed(0)} km</span></div>
    </div>
    <button class="btn primary big" style="width:100%" onclick="generatePoster()">🎨 生成分享海报</button>
    <div id="posterArea" style="margin-top:6px"></div>`;
}
function generatePoster() {
  const { label } = rangeWindow();
  const r = reportStats();
  if (r.totalBoxes === 0) { toast('当前周期暂无数据，无法生成海报'); return; }
  const svg = `
  <svg width="100%" height="100%" viewBox="0 0 320 440" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#059669"/>
        <stop offset="60%" stop-color="#065f46"/>
        <stop offset="100%" stop-color="#022c22"/>
      </linearGradient>
    </defs>
    <rect width="320" height="440" rx="20" fill="url(#g)"/>
    <g transform="translate(24,28)" fill="#fff">
      <g transform="translate(0,0)">
        <circle cx="20" cy="20" r="18" fill="rgba(255,255,255,.15)"/>
        <text x="20" y="26" text-anchor="middle" font-size="20">🥡</text>
      </g>
      <text x="52" y="22" font-size="18" font-weight="700">惜食盲盒 · ${label}成绩单</text>
      <text x="52" y="42" font-size="12" opacity=".85">让每一份食物都被温柔对待</text>
    </g>
    <g transform="translate(24,90)" fill="#fff">
      <rect x="0" y="0" width="128" height="64" rx="10" fill="rgba(255,255,255,.12)"/>
      <rect x="140" y="0" width="128" height="64" rx="10" fill="rgba(255,255,255,.12)"/>
      <text x="18" y="22" font-size="11" opacity=".85">挽回损失</text>
      <text x="18" y="48" font-size="22" font-weight="700">¥${r.saved.toFixed(0)}</text>
      <text x="18" y="58" font-size="10" opacity=".85">原价−实收</text>
      <text x="158" y="22" font-size="11" opacity=".85">损耗率</text>
      <text x="158" y="48" font-size="22" font-weight="700">${(r.lossRate * 100).toFixed(1)}%</text>
      <text x="158" y="58" font-size="10" opacity=".85">退款+取消·总盒 ${r.totalBoxes}</text>
    </g>
    <g transform="translate(24,174)">
      <rect x="0" y="0" width="268" height="74" rx="12" fill="rgba(255,255,255,.18)"/>
      <text x="134" y="24" text-anchor="middle" font-size="12" fill="#fff" opacity=".9">🌱 碳减排贡献</text>
      <text x="134" y="54" text-anchor="middle" font-size="26" font-weight="700" fill="#fff">${r.co2.toFixed(1)} kg CO₂e</text>
      <text x="134" y="68" text-anchor="middle" font-size="11" fill="#fff" opacity=".9">挽救食物 ${r.kg.toFixed(1)}kg · 相当于 ${r.trees.toFixed(1)} 棵树一年吸碳</text>
    </g>
    <g transform="translate(24,272)" fill="#fff">
      <rect x="0" y="0" width="128" height="56" rx="10" fill="rgba(255,255,255,.12)"/>
      <rect x="140" y="0" width="128" height="56" rx="10" fill="rgba(255,255,255,.12)"/>
      <text x="18" y="20" font-size="11" opacity=".85">已核销</text>
      <text x="18" y="44" font-size="20" font-weight="700">${r.vBoxes} 盒</text>
      <text x="158" y="20" font-size="11" opacity=".85">或少开车</text>
      <text x="158" y="44" font-size="20" font-weight="700">${r.km.toFixed(0)} km</text>
    </g>
    <g transform="translate(160,400)" text-anchor="middle" fill="#fff" opacity=".75">
      <text x="0" y="0" font-size="10">惜食盲盒 · 绿色公益账单 · 扫码一起拯救临期食物</text>
      <text x="0" y="14" font-size="9">Powered by XISHI · ${new Date().toLocaleDateString('zh-CN')}</text>
    </g>
    <g transform="translate(24,352)">
      <rect x="0" y="0" width="58" height="58" rx="6" fill="#fff"/>
      <!-- 简易二维码装饰：黑白像素图案 -->
      <rect x="4" y="4" width="50" height="50" fill="#022c22"/>
      <g fill="#fff">
        <rect x="8" y="8" width="6" height="6"/><rect x="20" y="8" width="4" height="4"/><rect x="30" y="8" width="6" height="6"/><rect x="42" y="8" width="4" height="4"/>
        <rect x="10" y="18" width="4" height="4"/><rect x="24" y="18" width="8" height="4"/><rect x="40" y="18" width="6" height="4"/>
        <rect x="6" y="28" width="8" height="4"/><rect x="18" y="28" width="4" height="4"/><rect x="32" y="28" width="8" height="4"/><rect x="44" y="28" width="4" height="4"/>
        <rect x="12" y="38" width="4" height="4"/><rect x="22" y="38" width="8" height="4"/><rect x="38" y="38" width="4" height="4"/>
        <rect x="8" y="46" width="6" height="4"/><rect x="20" y="46" width="4" height="4"/><rect x="30" y="46" width="6" height="4"/><rect x="42" y="46" width="4" height="4"/>
      </g>
    </g>
  </svg>`;
  const session = getSession();
  const who = session?.role === 'merchant' ? (session.name || '商家伙伴') : '惜食达人';
  document.getElementById('posterArea').innerHTML = `
    <div class="poster">
      <div class="p-head">
        <svg width="40" height="40" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="rgba(255,255,255,.15)"/><text x="24" y="30" text-anchor="middle" font-size="22">🥡</text></svg>
        <div><div class="p-title">惜食盲盒 · ${label}成绩单</div><div class="p-sub">${who} · ${new Date().toLocaleDateString('zh-CN')}</div></div>
      </div>
      <div class="p-stats">
        <div class="p-stat"><span>挽回损失</span><b>¥${r.saved.toFixed(0)}</b><span>原价−实收</span></div>
        <div class="p-stat"><span>损耗率</span><b>${(r.lossRate * 100).toFixed(1)}%</b><span>总盒 ${r.totalBoxes}</span></div>
      </div>
      <div class="p-big"><span>🌱 CO₂e 减排</span><b>${r.co2.toFixed(1)} kg</b><span>挽救食物 ${r.kg.toFixed(1)}kg · 相当于 ${r.trees.toFixed(1)} 棵树一年</span></div>
      <div class="p-stats">
        <div class="p-stat"><span>已核销</span><b>${r.vBoxes} 盒</b><span>共 ${r.verified} 笔订单</span></div>
        <div class="p-stat"><span>或少开车</span><b>${r.km.toFixed(0)} km</b><span>同款碳足迹</span></div>
      </div>
      <div class="p-foot">惜食盲盒 · 让每一份食物都被温柔对待<br>扫码加入我们，一起拯救临期食物 · Powered by XISHI</div>
    </div>
    <details style="margin-top:8px">
      <summary style="font-size:12px;color:#64748b;cursor:pointer;user-select:none">💾 导出 SVG 矢量海报（可发朋友圈/打印）</summary>
      <textarea readonly rows="8" style="width:100%;font-size:10px;border:1px solid #cbd5e1;border-radius:8px;padding:6px;margin-top:6px;background:#f8fafc">${svg.replace(/\n\s+/g, '\n').trim()}</textarea>
      <div class="d-sub" style="margin-top:4px">复制上方 SVG 代码保存为 .svg 或直接用浏览器打开即可获得高清海报（支持任意分辨率）。</div>
    </details>`;
}

// 每秒检查：所有待支付订单超时自动取消；刷新收银台与取货倒计时
setInterval(() => {
  let changed = false;
  orders.forEach(o => {
    if (o.status === 'unpaid' && Date.now() > o.expireAt) {
      o.status = 'canceled';
      o.canceledAt = Date.now();
      if (activeOrder && activeOrder.id === o.id) activeOrder.status = 'canceled';
      restoreStock(o);
      changed = true;
      if (modalView === 'pay' && activeOrder && activeOrder.id === o.id) renderPay();
      if (currentDetailOrder && currentDetailOrder.id === o.id) renderOrderDetail(currentDetailOrder);
      if (modalView === 'orders') renderOrders(orderFilter);
      toast(`订单 ${o.id} 超时未支付，已自动取消`);
    }
  });
  if (changed) { renderAll(); saveOrders(); }
  const cd = document.getElementById('cdText');
  if (cd && activeOrder && activeOrder.status === 'unpaid') cd.textContent = fmtCd(Math.max(0, activeOrder.expireAt - Date.now()));
  const pc = document.getElementById('pickCd');
  if (pc && currentDetailOrder && currentDetailOrder.status === 'paid') {
    const r = pickupRemainMs(currentDetailOrder);
    if (r > 0) pc.textContent = fmtCd(r);
    else pc.parentElement.textContent = '取货时段已结束，如未取货请联系商家';
  }
}, 1000);
updateOrderBadge();

/* ================= 管理后台 M3 ================= */
let adminCurPage = 'dashboard';
const ADMIN_SESSION_KEY = 'xishi_admin_session';
const MENU_LABELS = {
  dashboard: '平台数据看板',
  merchants: '商家入驻审核',
  stores: '食品安全 & 店铺管理',
  pricing: '定价监控 & 异常告警',
  billing: '结算账单 & 导出',
  syslog: '系统日志 & 参数配置',
};
// ---- 种子数据 ----
function seedMerchants() {
  let list; try { list = JSON.parse(localStorage.getItem('xishi_m3_merchants')); } catch (e) { list = null; }
  if (list) return list;
  const cats = ['烘焙','熟食','饮品','综合'];
  const rows = [];
  const names = ['麦香里食品', '绿源生鲜（集团）', '茶语时光连锁', '味道小馆', '晨光烘焙工坊', '优鲜美便利', '五谷三餐'];
  for (let i = 0; i < names.length; i++) {
    rows.push({
      id: 'M' + String(1001 + i),
      name: names[i],
      contact: ['张先生','李女士','王总','陈经理','刘主管','赵女士','孙先生'][i],
      phone: '138' + String(Math.floor(10000000 + Math.random() * 90000000)),
      email: `m${1001+i}@xishi.ops`,
      cat: cats[i % cats.length],
      region: ['上海 · 黄浦区','上海 · 徐汇区','上海 · 静安区','上海 · 浦东新区','上海 · 长宁区','北京 · 朝阳区','杭州 · 西湖区'][i],
      license: `91310${String(1000+i).padStart(6,'0')}${['A','B','C','D','E','F','G'][i]}`,
      business: `${names[i]} × 惜食盲盒：门店临期食品上架方案`,
      idPhoto: i % 2 === 0 ? '已上传' : '待补充',
      createdAt: Date.now() - (i + 1) * 30 * 3600000 - Math.floor(Math.random() * 86400000),
      status: ['pending','pending','approved','pending','rejected','approved','pending'][i],
      rejectReason: i === 4 ? '营业执照副本不清晰，请重新扫描上传' : '',
      approvedAt: (i === 2 || i === 5) ? Date.now() - (i + 1) * 80 * 3600000 : null,
      manager: (i === 2 || i === 5) ? '管理员 · 运营组' : '',
    });
  }
  localStorage.setItem('xishi_m3_merchants', JSON.stringify(rows));
  return rows;
}
function seedSafetyTickets() {
  let list; try { list = JSON.parse(localStorage.getItem('xishi_m3_safety')); } catch (e) { list = null; }
  if (list) return list;
  const rows = [];
  const s0 = stores[0]?.name || '法贝滋面包坊';
  const s1 = stores[1]?.name || '瑞幸咖啡';
  const s2 = stores[2]?.name || '紫燕百味鸡';
  const rowsSeed = [
    { level: 'h', store: s0, title: '顾客投诉：吃出疑似异物（塑料薄膜碎片）', at: Date.now() - 82 * 60000, status: 'open', reporter: '消费者 138****8000', assignee: '' },
    { level: 'm', store: s2, title: '冷链温度记录异常：冷藏柜 6.8℃（阈值≤4℃）', at: Date.now() - 3 * 3600000, status: 'process', reporter: 'IoT 监控', assignee: '区域督察A' },
    { level: 'm', store: s1, title: '员工健康证即将到期（剩 6 天）', at: Date.now() - 8 * 3600000, status: 'process', reporter: '系统巡检', assignee: '人事组' },
    { level: 'l', store: s0, title: '店铺操作记录显示 1 次未按 SOP 消毒', at: Date.now() - 20 * 3600000, status: 'close', reporter: '督导抽查', assignee: '店长' },
    { level: 'ok', store: s2, title: '每日晨检：食品安全检查项全部通过', at: Date.now() - 42 * 3600000, status: 'close', reporter: '系统', assignee: '' },
    { level: 'h', store: stores[3]?.name || '满记甜品', title: '营业执照到期提醒（剩 12 天）', at: Date.now() - 26 * 3600000, status: 'open', reporter: '风控', assignee: '' },
  ];
  rowsSeed.forEach((r, i) => rows.push({ id: 'T' + (5001 + i), ...r, note: '' }));
  localStorage.setItem('xishi_m3_safety', JSON.stringify(rows));
  return rows;
}
function seedSysParams() {
  let p; try { p = JSON.parse(localStorage.getItem('xishi_m3_params')); } catch (e) { p = null; }
  if (p) return p;
  const def = {
    payTimeoutMin: 15,
    offProtectMin: 30,
    notifySubscribe: true,
    notifyStock: true,
    notifyRefund: true,
    offloadRatio: 0.30,
    autoOfflateMin: 45,
    refundAutoAudit: true,
    commissionPct: 6.0,
    penaltyLateHr: 3,
    maxPhotosPerShare: 9,
    shareMaxWords: 500,
    priceLowPct: 0.30,
    priceHighPct: 2.50,
    ticketSlaHr: 2,
    freezeIfH: 2,
    dndStart: '22:00',
    dndEnd: '08:00',
    dndEnabled: true,
  };
  localStorage.setItem('xishi_m3_params', JSON.stringify(def));
  return def;
}
function seedSysLogs() {
  let list; try { list = JSON.parse(localStorage.getItem('xishi_m3_logs')); } catch (e) { list = null; }
  if (list) return list;
  const rows = [];
  const types = [
    ['inf', '用户登录成功'],
    ['inf', '保存系统参数'],
    ['wrn', '异常价格波动：法贝滋 豪华档下跌 31%'],
    ['wrn', '待取货订单超时超过 30 分钟：oTEST007'],
    ['err', '微信支付回调签名校验失败：oTEST331'],
    ['inf', '商家申请通过：M1003 茶语时光连锁'],
    ['inf', '食品安全工单关闭：T5003'],
    ['err', '导出账单异常：第三方支付网关 504'],
    ['inf', '创建月结账单 B202609'],
    ['wrn', '店铺库存不足告警：瑞幸咖啡（黄河路店）'],
    ['inf', '管理员 admin 修改参数 priceLowPct=0.30'],
    ['inf', '商家入驻被拒绝：M1005（营业执照不清晰）'],
  ];
  let now = Date.now();
  types.forEach((t, i) => {
    rows.push({ ts: now - i * 42 * 60000, lvl: t[0], actor: i % 3 === 0 ? 'admin' : (i % 3 === 1 ? 'SYSTEM' : 'OP-' + (100 + i)), msg: t[1] });
  });
  localStorage.setItem('xishi_m3_logs', JSON.stringify(rows));
  return rows;
}
function addSysLog(lvl, msg, actor) {
  const list = seedSysLogs();
  list.unshift({ ts: Date.now(), lvl: lvl || 'inf', actor: actor || (getAdminSession()?.user || 'SYSTEM'), msg: msg || '' });
  localStorage.setItem('xishi_m3_logs', JSON.stringify(list.slice(0, 500)));
}
// ---- 管理员登录 ----
function getAdminSession() { try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY)); } catch (e) { return null; } }
function setAdminSession(s) { try { localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(s)); } catch (e) { } }
function clearAdminSession() { try { localStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) { } }
function showAdminLogin() { document.getElementById('adminLogin').classList.add('show'); document.getElementById('adminApp').classList.remove('show'); }
function enterAdminApp() {
  const s = getAdminSession(); if (!s) { showAdminLogin(); return; }
  document.getElementById('adminLogin').classList.remove('show');
  document.getElementById('adminApp').classList.add('show');
  document.getElementById('adminName').textContent = s.user;
  document.getElementById('adminTopRight').textContent = `${s.role || '超级管理员'} · ${s.user} · ${new Date().toLocaleDateString('zh-CN')}`;
  switchAdminPage(adminCurPage, true);
}
function adminLogout() { if (!confirm('确定退出管理后台？')) return; clearAdminSession(); document.getElementById('adminApp').classList.remove('show'); showAdminLogin(); toast('已退出'); }
function switchAdminPage(name, skipNav) {
  adminCurPage = name;
  document.getElementById('adminTitle').textContent = MENU_LABELS[name] || '管理中心';
  document.querySelectorAll('#adminNav a').forEach(a => a.classList.toggle('active', a.dataset.page === name));
  const body = document.getElementById('adminBody');
  if (name === 'dashboard') body.innerHTML = renderAdminDashboard();
  else if (name === 'merchants') body.innerHTML = renderAdminMerchants();
  else if (name === 'stores') body.innerHTML = renderAdminStores();
  else if (name === 'pricing') body.innerHTML = renderAdminPricing();
  else if (name === 'billing') body.innerHTML = renderAdminBilling();
  else if (name === 'syslog') body.innerHTML = renderAdminSyslog();
}
// ---- 1. 平台数据看板 ----
function renderAdminDashboard() {
  const orders = loadOrders();
  const sod = startOfDay();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const today = orders.filter(o => o.createdAt >= sod);
  const month = orders.filter(o => o.createdAt >= monthStart);
  const paidAndVer = o => o.status === 'paid' || o.status === 'verified';
  const todayIncome = today.filter(paidAndVer).reduce((s, o) => s + parseFloat(o.total || 0), 0);
  const monthIncome = month.filter(paidAndVer).reduce((s, o) => s + parseFloat(o.total || 0), 0);
  const todayVerified = today.filter(o => o.status === 'verified').length;
  const todayRefunded = today.filter(o => o.status === 'refunded').length;
  const ms = seedMerchants(); const pen = ms.filter(m => m.status === 'pending').length;
  const storesActive = stores.filter(s => s.remaining > 0).length;
  const merchants = seedMerchants().filter(m => m.status === 'approved').length;
  // 平台转化率
  const dayOrders = today.length;
  const todayUsers = new Set(today.map(o => (o.phone || ''))).size || Math.max(1, Math.floor(dayOrders * 1.4));
  const conv = ((dayOrders / todayUsers) * 100).toFixed(1);
  // 销量top 5
  const rank = {};
  today.forEach(o => { if (paidAndVer(o)) rank[o.storeName] = (rank[o.storeName] || 0) + (o.qty || 1); });
  const top = Object.entries(rank).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMax = Math.max(1, top[0]?.[1] || 1);
  // 周订单趋势：近 7 日按天聚合
  const byDay = {};
  for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); const k = `${d.getMonth()+1}/${d.getDate()}`; byDay[k] = 0; }
  orders.forEach(o => { const d = new Date(o.createdAt); const k = `${d.getMonth()+1}/${d.getDate()}`; if (byDay[k] != null) byDay[k]++; });
  const dayKeys = Object.keys(byDay); const dayMax = Math.max(1, ...Object.values(byDay));
  return `
    <div class="admin-stats">
      <div class="admin-stat"><span>今日 GMV</span><b>¥${todayIncome.toFixed(1)}</b><div class="icon" style="background:#f0fdf4;color:#059669">💸</div></div>
      <div class="admin-stat"><span>本月 GMV</span><b>¥${monthIncome.toFixed(0)}</b><div class="icon" style="background:#eff6ff;color:#2563eb">📈</div></div>
      <div class="admin-stat"><span>今日核销</span><b>${todayVerified}</b><div class="icon" style="background:#ecfeff;color:#0891b2">✅</div></div>
      <div class="admin-stat"><span>今日退款</span><b>${todayRefunded}</b><div class="icon" style="background:#fef2f2;color:#dc2626">↩️</div></div>
    </div>
    <div class="admin-stats">
      <div class="admin-stat"><span>在售店铺</span><b>${storesActive}</b><span>商家 ${merchants} 家</span><div class="icon" style="background:#f5f3ff;color:#7c3aed">🏪</div></div>
      <div class="admin-stat"><span>入驻待审核</span><b>${pen}</b><span>共 ${ms.length} 份申请</span><div class="icon" style="background:#fffbeb;color:#d97706">📋</div></div>
      <div class="admin-stat"><span>今日订单</span><b>${dayOrders}</b><span>转化 ${conv}%</span><div class="icon" style="background:#ecfdf5;color:#047857">🧾</div></div>
      <div class="admin-stat"><span>异常告警待处理</span><b id="m3AlertCount">${seedSafetyTickets().filter(t => t.status !== 'close').length}</b><span>含高危 ${seedSafetyTickets().filter(t=>t.status!=='close'&&t.level==='h').length}</span><div class="icon" style="background:#fef2f2;color:#b91c1c">🔔</div></div>
    </div>
    <div class="admin-card">
      <h3>📅 近 7 日订单趋势</h3>
      <div style="display:flex;gap:8px;align-items:flex-end;height:130px;padding:6px 4px 18px">
        ${dayKeys.map(k => {
          const h = Math.round((byDay[k] / dayMax) * 100);
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px">
            <b style="font-size:11px;color:#059669">${byDay[k]}</b>
            <div style="width:100%;height:${h}%;background:linear-gradient(180deg,#10b981,#059669);border-radius:8px 8px 0 0;min-height:6px"></div>
            <span style="font-size:11px;color:#64748b">${k}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="admin-card">
      <h3>🏆 今日店铺销量 TOP 5${top.length===0?'（暂无数据）':''}</h3>
      ${top.length === 0 ? '<div class="empty">今日暂无可统计销量</div>' :
        top.map((r, i) => `
          <div class="rank-row">
            <span style="width:18px;color:${i<3?'#d97706':'#64748b'};font-weight:700">${i+1}</span>
            <span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${r[0]}</span>
            <span class="bar"><i style="width:${Math.round(r[1]/topMax*100)}%"></i></span>
            <span style="width:76px;text-align:right;color:#059669;font-weight:600">${r[1]} 盒</span>
          </div>`).join('')}
    </div>
    <div class="admin-card">
      <h3>🚨 最新告警（按优先级） <button class="btn-mini" onclick="switchAdminPage('pricing')">去定价监控 ›</button></h3>
      <div class="alerts-list">
        ${getRecentAlerts(6).map(a => `
          <div class="alert-row ${a.level}">
            <div class="lv">${a.level==='h'?'高危':a.level==='m'?'中危':a.level==='l'?'低危':'信息'}</div>
            <div class="msg">${a.store ? `<b>${a.store}</b> · ` : ''}${a.title}</div>
            <div class="tm">${fmtAgo(a.at)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}
function getRecentAlerts(n) {
  const alerts = [];
  seedSafetyTickets().filter(t => t.status !== 'close').forEach(t => alerts.push({ level: t.level, store: t.store, title: t.title, at: t.at }));
  // 价格异常：低于底线 30% 或高于 2.5x
  const p = seedSysParams();
  stores.forEach(s => s.tiers.forEach(t => {
    const floor = (s.minPrice * 0.75) || 9999;
    if (t.price > 0 && (t.price < floor * (1 - p.priceLowPct) || t.price > floor * p.priceHighPct)) {
      alerts.push({ level: 'm', store: s.name, title: `${t.name}档价格偏离基准（¥${t.price}，基准约 ¥${floor.toFixed(1)}）`, at: Date.now() - 7200000 });
    }
  }));
  // 超时未取货
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  loadOrders().filter(o => o.status === 'paid' && o.slotEndMin != null && nowMin > o.slotEndMin + 30)
    .forEach(o => alerts.push({ level: 'm', store: o.storeName, title: `取货超时订单 ${o.id}（${o.tierName}×${o.qty}）`, at: Date.now() - (nowMin - o.slotEndMin) * 60000 }));
  return alerts.sort((a, b) => b.at - a.at).slice(0, n || 10);
}
// ---- 2. 商家入驻审核 ----
let m3State = { merchantFilter: 'all', merchantDetail: null, ticketFilter: 'all', billFilter: 'thisMonth', billDetail: null };
function renderAdminMerchants() {
  const list = seedMerchants();
  const f = m3State.merchantFilter;
  const filtered = list.filter(m => f === 'all' ? true : m.status === f);
  if (m3State.merchantDetail) {
    const m = list.find(x => x.id === m3State.merchantDetail);
    if (!m) { m3State.merchantDetail = null; return renderAdminMerchants(); }
    return `
      <div class="admin-filters"><button class="btn" onclick="m3State.merchantDetail=null;renderAdminMerchants()">← 返回列表</button></div>
      <div class="admin-card">
        <h3>入驻申请详情 · ${m.id} <span class="st st-${m.status==='approved'?'a':m.status==='rejected'?'r':'p'}">${{approved:'已通过',rejected:'已拒绝',pending:'待审核'}[m.status]}</span></h3>
        <div class="detail-grid">
          <div class="kv"><b>商家名称</b><div>${m.name}</div></div>
          <div class="kv"><b>申请时间</b><div>${fmtDateTime(m.createdAt)}</div></div>
          <div class="kv"><b>联系人</b><div>${m.contact}</div></div>
          <div class="kv"><b>手机号</b><div>${m.phone}</div></div>
          <div class="kv"><b>邮箱</b><div>${m.email}</div></div>
          <div class="kv"><b>主营品类</b><div>${m.cat}</div></div>
          <div class="kv"><b>所属区域</b><div>${m.region}</div></div>
          <div class="kv"><b>营业执照号</b><div>${m.license}</div></div>
          <div class="kv"><b>证件照片</b><div>${m.idPhoto}</div></div>
          <div class="kv"><b>审核专员</b><div>${m.manager || '—'}</div></div>
          <div class="kv"><b>审批时间</b><div>${m.approvedAt ? fmtDateTime(m.approvedAt) : '—'}</div></div>
          <div class="kv full"><b>经营概述</b><div>${m.business}</div></div>
          ${m.status === 'rejected' ? `<div class="kv full"><b>拒绝原因</b><div style="color:#b91c1c">${m.rejectReason || '—'}</div></div>` : ''}
        </div>
        ${m.status === 'pending' ? `
          <div class="btn-row" style="margin-top:14px">
            <button class="btn" onclick="adminMerchantAction('${m.id}','reject')">❌ 拒绝申请</button>
            <button class="btn primary" onclick="adminMerchantAction('${m.id}','approve')">✅ 通过入驻</button>
          </div>` : ''}
      </div>`;
  }
  return `
    <div class="admin-filters">
      <select onchange="m3State.merchantFilter=this.value;renderAdminMerchants()">
        ${[['all','全部状态'],['pending','待审核'],['approved','已通过'],['rejected','已拒绝']].map(([k,v])=>`<option value="${k}"${k===f?' selected':''}>${v}</option>`).join('')}
      </select>
      <input placeholder="搜索商家名 / 联系人 / 手机号" oninput="window._mSearch=this.value;renderAdminMerchants()">
      <span class="d-sub" style="align-self:center">${filtered.length} 条 · 待审核 ${list.filter(m=>m.status==='pending').length}</span>
    </div>
    <div class="admin-card" style="padding:6px 0 0">
      <table class="admin-table">
        <thead><tr><th>申请号</th><th>商家名称</th><th>品类</th><th>联系人</th><th>区域</th><th>证件</th><th>申请时间</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>
          ${filtered.filter(m => !window._mSearch || [m.name,m.contact,m.phone].join(' ').includes(window._mSearch)).map(m => `
            <tr>
              <td>${m.id}</td>
              <td><b>${m.name}</b></td>
              <td>${m.cat}</td>
              <td>${m.contact}</td>
              <td>${m.region}</td>
              <td>${m.idPhoto==='已上传'?'<span style="color:#059669">✅ 已上传</span>':'<span style="color:#dc2626">待补充</span>'}</td>
              <td style="white-space:nowrap">${fmtDateTime(m.createdAt)}</td>
              <td><span class="st st-${m.status==='approved'?'a':m.status==='rejected'?'r':'p'}">${{approved:'已通过',rejected:'已拒绝',pending:'待审核'}[m.status]}</span></td>
              <td style="text-align:right">
                <button class="btn-mini" onclick="m3State.merchantDetail='${m.id}';renderAdminMerchants()">查看</button>
                ${m.status==='pending'?`<button class="btn-mini" style="border-color:#10b981;color:#059669" onclick="adminMerchantAction('${m.id}','approve')">通过</button>
                <button class="btn-mini" style="border-color:#fca5a5;color:#dc2626" onclick="adminMerchantAction('${m.id}','reject')">拒绝</button>`:''}
              </td>
            </tr>`).join('') || '<tr><td colspan="9"><div class="empty">暂无数据</div></td></tr>'}
        </tbody>
      </table>
    </div>`;
}
function adminMerchantAction(id, action) {
  const list = seedMerchants();
  const m = list.find(x => x.id === id); if (!m) return;
  if (action === 'approve') {
    m.status = 'approved'; m.approvedAt = Date.now(); m.manager = (getAdminSession()?.user || 'admin') + ' · 运营组';
    localStorage.setItem('xishi_m3_merchants', JSON.stringify(list));
    addSysLog('inf', `商家入驻通过：${id} ${m.name}`, getAdminSession()?.user);
    toast(`✅ 已通过：${m.name}`);
  } else {
    const r = prompt('请输入拒绝原因（必填）：', '营业执照信息与申请表不一致');
    if (!r) return;
    m.status = 'rejected'; m.rejectReason = r; m.manager = getAdminSession()?.user || 'admin';
    localStorage.setItem('xishi_m3_merchants', JSON.stringify(list));
    addSysLog('wrn', `商家入驻拒绝：${id} ${m.name}（${r}）`, getAdminSession()?.user);
    toast(`❌ 已拒绝：${m.name}`);
  }
  renderAdminMerchants();
}
// ---- 3. 食品安全工单 & 店铺管理 ----
function renderAdminStores() {
  const tickets = seedSafetyTickets();
  const tf = m3State.ticketFilter || 'all';
  const showTickets = tickets.filter(t => tf === 'all' ? true : t.status === tf);
  return `
    <div class="admin-card">
      <h3>🏪 店铺管理（${stores.length} 家）</h3>
      <div class="admin-filters">
        <select onchange="window._stCat=this.value;renderAdminStores()">
          <option value="">全部品类</option>
          ${CATS.map(c=>`<option>${c}</option>`).join('')}
        </select>
        <input placeholder="搜索店铺名 / 地址" oninput="window._stKw=this.value;renderAdminStores()">
      </div>
      <table class="admin-table">
        <thead><tr><th>ID</th><th>店铺名</th><th>品类</th><th>地址</th><th>库存</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>
          ${stores.filter(s => (!window._stCat||s.cat===window._stCat) && (!window._stKw||[s.name,s.addr].join(' ').includes(window._stKw))).map(s => `
            <tr>
              <td>${s.id}</td>
              <td><b>${s.name}</b></td>
              <td>${s.cat}</td>
              <td style="color:#64748b">${s.addr.slice(0,16)}${s.addr.length>16?'…':''}</td>
              <td>${s.remaining} / ${s.tiers.reduce((a,t)=>a+(t.cap??10),0)}</td>
              <td><span class="st ${s.remaining<=0?'st-d':s.remaining<=3?'st-i':'st-s'}">${s.remaining<=0?'已售罄':s.remaining<=3?'临临界':'营业中'}</span></td>
              <td style="text-align:right">
                <button class="btn-mini" onclick="alert('店铺详情：${s.name}\\n窗口：${s.window}\\n地址：${s.addr}')">详情</button>
                <button class="btn-mini" style="border-color:#fca5a5;color:#dc2626" onclick="if(confirm('确认冻结 ${s.name}？（店铺展示置灰、不再推送补货）')){s.tiers.forEach(t=>t.stock=0);s.remaining=0;reportProtect[s.id]=Date.now()+86400000;addSysLog('wrn','店铺紧急冻结：${s.id} ${s.name}');renderAll();renderAdminStores();toast('已冻结');}">冻结</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="admin-card">
      <h3>🧪 食品安全工单 & 合规巡检</h3>
      <div class="admin-filters">
        <select onchange="m3State.ticketFilter=this.value;renderAdminStores()">
          ${[['all','全部状态'],['open','待处理'],['process','处理中'],['close','已关闭']].map(([k,v])=>`<option value="${k}"${k===tf?' selected':''}>${v}</option>`).join('')}
        </select>
        <span class="d-sub" style="align-self:center">待处理 ${tickets.filter(t=>t.status==='open').length} · 处理中 ${tickets.filter(t=>t.status==='process').length} · 高危未关 ${tickets.filter(t=>t.level==='h'&&t.status!=='close').length}</span>
      </div>
      <div class="alerts-list">
        ${showTickets.length === 0 ? '<div class="empty">暂无工单</div>' : showTickets.map(t => {
          const tag = t.level==='h'?'高危':t.level==='m'?'中危':t.level==='l'?'低危':'合格';
          const stat = t.status === 'open' ? 'st-d' : t.status === 'process' ? 'st-i' : 'st-s';
          return `<div class="alert-row ${t.level==='ok'?'ok':t.level==='h'?'h':t.level==='m'?'m':'l'}">
            <div class="lv">${tag}</div>
            <div class="msg">
              <span class="st ${stat}" style="margin-right:6px">${t.status==='open'?'待处理':t.status==='process'?'处理中':'已关闭'}</span>
              <b>[${t.id}]</b> ${t.store ? `<b>${t.store}</b> · ` : ''}${t.title}
              <div style="font-size:11.5px;color:#64748b;margin-top:2px">来源：${t.reporter}${t.assignee?` · 责任人：${t.assignee}`:' · 待分配'}</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
              <div class="tm">${fmtAgo(t.at)}</div>
              <div>
                ${t.status !== 'close' ? `
                  <button class="btn-mini" onclick="ticketAssign('${t.id}')">分配</button>
                  ${t.status === 'open' ? `<button class="btn-mini" style="border-color:#2563eb;color:#1d4ed8" onclick="ticketNext('${t.id}')">开始处理</button>` : ''}
                  ${t.status === 'process' ? `<button class="btn-mini" style="border-color:#10b981;color:#059669" onclick="ticketNext('${t.id}')">办结</button>` : ''}
                ` : ''}
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}
function ticketAssign(id) {
  const list = seedSafetyTickets();
  const t = list.find(x => x.id === id); if (!t) return;
  const r = prompt('指派责任人（姓名或岗位）：', t.assignee || '区域督察A');
  if (r == null) return;
  t.assignee = r; t.status = t.status === 'open' ? 'process' : t.status;
  localStorage.setItem('xishi_m3_safety', JSON.stringify(list));
  addSysLog('inf', `工单分配：${id} → ${r}`, getAdminSession()?.user);
  renderAdminStores(); toast(`已指派给 ${r}`);
}
function ticketNext(id) {
  const list = seedSafetyTickets();
  const t = list.find(x => x.id === id); if (!t) return;
  if (t.status === 'open') { t.status = 'process'; addSysLog('inf', `工单开始处理：${id}`, getAdminSession()?.user); }
  else if (t.status === 'process') {
    const note = prompt('处理完成备注（如检测结果/整改措施）：', '已完成合规复查，整改项均已闭环');
    if (note == null) return;
    t.status = 'close'; t.note = note;
    addSysLog('inf', `工单办结：${id}（${note}）`, getAdminSession()?.user);
  }
  localStorage.setItem('xishi_m3_safety', JSON.stringify(list));
  renderAdminStores(); toast('工单已更新');
}
// ---- 4. 定价监控 & 异常告警 ----
function renderAdminPricing() {
  const p = seedSysParams();
  const rows = [];
  stores.forEach(s => s.tiers.forEach(t => {
    const floor = (s.minPrice * 0.75);
    const low = floor * (1 - p.priceLowPct), high = floor * p.priceHighPct;
    let anomaly = '';
    if (t.price < low) anomaly = '偏低';
    else if (t.price > high) anomaly = '偏高';
    rows.push({ s, t, floor, low, high, anomaly });
  }));
  const alerts = getRecentAlerts(12);
  return `
    <div class="admin-stats">
      <div class="admin-stat"><span>定价异常</span><b>${rows.filter(r=>r.anomaly).length}</b><span>共 ${rows.length} 个档位</span><div class="icon" style="background:#fef2f2;color:#dc2626">💹</div></div>
      <div class="admin-stat"><span>高危告警</span><b>${seedSafetyTickets().filter(t=>t.level==='h'&&t.status!=='close').length}</b><span>含合规 / 风控</span><div class="icon" style="background:#fef2f2;color:#b91c1c">🚨</div></div>
      <div class="admin-stat"><span>取货超时订单</span><b>${loadOrders().filter(o=>o.status==='paid'&&o.slotEndMin!=null&&(new Date().getHours()*60+new Date().getMinutes())>o.slotEndMin+30).length}</b><span>超过结束+30min</span><div class="icon" style="background:#fffbeb;color:#d97706">⏰</div></div>
      <div class="admin-stat"><span>今日价格波动</span><b>${Math.round(p.priceLowPct*100)}% / ${p.priceHighPct}x</b><span>低于底线或高于上限</span><div class="icon" style="background:#eff6ff;color:#1d4ed8">📐</div></div>
    </div>
    <div class="admin-card">
      <h3>💰 定价监控（按档位扫描）</h3>
      <div class="admin-filters">
        <select onchange="window._prAnom=this.value;renderAdminPricing()">
          ${[['all','全部档位'],['anomaly','仅异常'],['偏低','偏低'],['偏高','偏高']].map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
        </select>
        <input placeholder="搜索店铺名" oninput="window._prKw=this.value;renderAdminPricing()">
      </div>
      <table class="admin-table">
        <thead><tr><th>店铺</th><th>档位</th><th>现价</th><th>参考价</th><th>下限/上限</th><th>偏离</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>
          ${rows.filter(r => (!window._prAnom || window._prAnom==='all' ? true : window._prAnom==='anomaly' ? r.anomaly : r.anomaly===window._prAnom)
            && (!window._prKw || r.s.name.includes(window._prKw))).map(r => `
            <tr>
              <td>${r.s.name}</td>
              <td>${r.t.name}</td>
              <td><b style="color:${r.anomaly==='偏低'?'#b91c1c':r.anomaly==='偏高'?'#dc2626':'#059669'}">¥${r.t.price}</b></td>
              <td>¥${r.floor.toFixed(1)}</td>
              <td style="color:#64748b">¥${r.low.toFixed(1)} / ¥${r.high.toFixed(1)}</td>
              <td>${r.anomaly ? `<span class="st st-${r.anomaly==='偏低'?'d':'i'}">${r.anomaly}</span>` : '<span style="color:#059669">正常</span>'}</td>
              <td style="text-align:right">
                <button class="btn-mini" onclick="alert('已跳转商家端定价：${r.s.name} ${r.t.name}档\\n（演示：此处仅展示，真实环境将打开 FR-B03）')">去调价</button>
                ${r.anomaly ? `<button class="btn-mini" style="border-color:#dc2626;color:#991b1b" onclick="if(confirm('确认对「${r.s.name}」发起价格核查工单？')){alert('已创建价格核查工单，将指派给区域督察');addSysLog('wrn','价格异常核查：${r.s.name} ${r.t.name}档 ¥${r.t.price}');renderAdminPricing();toast('已创建核查工单');}">核查</button>` : ''}
              </td>
            </tr>`).join('') || '<tr><td colspan="7"><div class="empty">暂无匹配数据</div></td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="admin-card">
      <h3>🔔 异常告警流（最新）</h3>
      <div class="alerts-list">
        ${alerts.map(a => {
          const lvl = a.level === 'h' ? '高危' : a.level === 'm' ? '中危' : a.level === 'l' ? '低危' : '信息';
          return `<div class="alert-row ${a.level==='h'?'h':a.level==='m'?'m':a.level==='l'?'l':'ok'}">
            <div class="lv">${lvl}</div>
            <div class="msg">${a.store?`<b>${a.store}</b> · `:''}${a.title}</div>
            <div class="tm">${fmtAgo(a.at)}</div>
            <button class="btn-mini" onclick="toast('已标记已读（演示）')">已读</button>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}
// ---- 5. 结算账单 & 导出 ----
function seedBills() {
  let list; try { list = JSON.parse(localStorage.getItem('xishi_m3_bills')); } catch (e) { list = null; }
  if (list) return list;
  const rows = [];
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const merchants = seedMerchants().filter(m => m.status === 'approved');
  const now2 = new Date();
  const ms = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate()).getTime();
  // 生成最近 6 个周期（3 周 + 3 月）
  for (let i = 0; i < 3; i++) {
    const d0 = new Date(ms - i * 7 * 86400000);
    const d1 = new Date(d0.getTime() - 6 * 86400000);
    merchants.slice(0, 3).forEach((m, j) => {
      const gmv = Math.round((3500 + Math.random() * 9000) * 100) / 100;
      rows.push({
        id: 'BW' + (20260000 + 100 * i + j + 1),
        merchantId: m.id, merchantName: m.name,
        period: `${d1.getMonth()+1}/${d1.getDate()}–${d0.getMonth()+1}/${d0.getDate()}（周结）`,
        type: '周结', from: d1.getTime(), to: d0.getTime(),
        orders: 30 + j * 7 + i * 3,
        gmv: gmv, commission: +(gmv * 0.06).toFixed(2),
        penalty: i === 0 && j === 0 ? 50 : 0, refund: Math.round(gmv * 0.04 * 100) / 100,
        status: i === 0 ? (j === 2 ? 'settled' : 'pending') : 'settled',
        settledAt: i === 0 ? (j === 2 ? now - 2 * 3600000 : null) : now - (i + 1) * 86400000,
      });
    });
  }
  for (let i = 0; i < 3; i++) {
    const d0 = new Date(monthStart - i * 86400000);
    const d1 = new Date(d0.getFullYear(), d0.getMonth(), 1);
    merchants.forEach((m, j) => {
      const gmv = Math.round((12000 + Math.random() * 35000) * 100) / 100;
      rows.push({
        id: 'BM' + (20260000 + (3-i) * 10 + j + 1),
        merchantId: m.id, merchantName: m.name,
        period: `${d1.getFullYear()}/${d1.getMonth()+1}（月结）`,
        type: '月结', from: d1.getTime(), to: d0.getTime(),
        orders: 180 + j * 25 + i * 10,
        gmv: gmv, commission: +(gmv * 0.06).toFixed(2),
        penalty: i === 0 && j === 1 ? 200 : 0, refund: Math.round(gmv * 0.05 * 100) / 100,
        status: i === 0 ? (j === 1 ? 'checking' : 'pending') : 'settled',
        settledAt: i === 0 ? null : now - (i + 2) * 86400000,
      });
    });
  }
  localStorage.setItem('xishi_m3_bills', JSON.stringify(rows));
  return rows;
}
function billNet(b) { return +(b.gmv - b.commission - b.penalty - b.refund).toFixed(2); }
function billStatusLabel(b) {
  return { pending: '待结算', checking: '对账中', settled: '已结算', rejected: '有异议' }[b.status] || b.status;
}
function renderAdminBilling() {
  const list = seedBills();
  const bf = m3State.billFilter || 'thisMonth';
  const now = Date.now();
  const ms = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const filter = l => {
    if (bf === 'all') return true;
    if (bf === 'thisMonth') return l.to >= ms;
    if (bf === 'weekly') return l.type === '周结';
    if (bf === 'monthly') return l.type === '月结';
    if (bf === 'pending') return l.status !== 'settled';
    return true;
  };
  const filtered = list.filter(filter);
  if (m3State.billDetail) {
    const b = list.find(x => x.id === m3State.billDetail);
    if (!b) { m3State.billDetail = null; return renderAdminBilling(); }
    const orders = loadOrders().filter(o => o.storeId && o.createdAt >= b.from && o.createdAt <= b.to);
    const lines = orders.filter(o => (seedMerchants().find(m=>m.id===b.merchantId)?.name ? stores.find(s=>s.id===o.storeId)?.name : '') === b.merchantName
      || (b.merchantName && o.storeName === b.merchantName));
    return `
      <div class="admin-filters"><button class="btn" onclick="m3State.billDetail=null;renderAdminBilling()">← 返回账单列表</button></div>
      <div class="admin-card">
        <h3>账单详情 · ${b.id} <span class="st st-${b.status==='settled'?'a':b.status==='checking'?'st-i':'st-p'}">${billStatusLabel(b)}</span></h3>
        <div class="detail-grid">
          <div class="kv"><b>结算对象</b><div>${b.merchantName}（${b.merchantId}）</div></div>
          <div class="kv"><b>账期</b><div>${b.period}</div></div>
          <div class="kv"><b>起止日期</b><div>${fmtDateTime(b.from)} ~ ${fmtDateTime(b.to)}</div></div>
          <div class="kv"><b>结算类型</b><div>${b.type}</div></div>
          <div class="kv"><b>订单笔数</b><div>${b.orders}</div></div>
          <div class="kv"><b>结算状态</b><div>${billStatusLabel(b)}${b.settledAt?`（${fmtDateTime(b.settledAt)}）`:''}</div></div>
        </div>
        <h3 style="margin-top:16px">💰 金额明细</h3>
        <div class="kv-row"><b>GMV 总流水</b><span>¥${b.gmv.toFixed(2)}</span></div>
        <div class="kv-row"><b>平台佣金（6.0%）</b><span style="color:#dc2626">- ¥${b.commission.toFixed(2)}</span></div>
        <div class="kv-row"><b>违约金/罚款</b><span style="color:${b.penalty>0?'#dc2626':'#059669'}">${b.penalty>0?'- ¥'+b.penalty.toFixed(2):'¥0.00'}</span></div>
        <div class="kv-row"><b>用户退款</b><span style="color:#dc2626">- ¥${b.refund.toFixed(2)}</span></div>
        <div class="kv-row" style="font-size:14px;font-weight:700;border-top:2px solid #e2e8f0;padding-top:8px"><b style="color:#0f172a">实际结算金额（打给商家）</b><span style="color:#059669;font-size:18px">¥${billNet(b).toFixed(2)}</span></div>
        <h3 style="margin-top:16px">🧾 相关订单明细（最多 50 条，演示：按账期与店铺过滤）</h3>
        <table class="admin-table">
          <thead><tr><th>订单号</th><th>时间</th><th>商品</th><th>状态</th><th style="text-align:right">金额</th></tr></thead>
          <tbody>
            ${(lines.length?lines:orders.slice(0,50)).map(o => `
              <tr>
                <td>${o.id}</td><td>${fmtDateTime(o.createdAt)}</td>
                <td>${o.tierName||''} × ${o.qty||1}</td>
                <td><span class="st ${o.status==='verified'?'st-a':o.status==='refunded'?'os-refunded':o.status==='paid'?'st-s':'st-r'}">${ORDER_STATUS[o.status]?.label || o.status}</span></td>
                <td style="text-align:right">¥${o.total}</td>
              </tr>`).join('') || '<tr><td colspan="5"><div class="empty">账期内暂无匹配订单</div></td></tr>'}
          </tbody>
        </table>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn" onclick="exportBillCsv('${b.id}')">📤 导出账单 CSV</button>
          ${b.status === 'pending' ? `<button class="btn" onclick="billReject('${b.id}')">🚩 标记有异议</button><button class="btn primary" onclick="billSettle('${b.id}')">✅ 确认出账</button>` : ''}
          ${b.status === 'rejected' ? `<button class="btn primary" onclick="billSettle('${b.id}')">✅ 重新出账</button>` : ''}
          ${b.status === 'checking' ? `<button class="btn primary" onclick="billSettle('${b.id}')">✅ 对账通过</button>` : ''}
        </div>
      </div>`;
  }
  const totalGMV = filtered.reduce((a, b) => a + b.gmv, 0);
  const totalNet = filtered.reduce((a, b) => a + billNet(b), 0);
  const totalPen = filtered.reduce((a, b) => a + b.penalty, 0);
  return `
    <div class="admin-stats">
      <div class="admin-stat"><span>账单数</span><b>${filtered.length}</b><span>共 ${list.length} 张</span><div class="icon" style="background:#ecfeff;color:#0891b2">🧾</div></div>
      <div class="admin-stat"><span>GMV 合计</span><b>¥${totalGMV.toFixed(0)}</b><span>本筛选</span><div class="icon" style="background:#f0fdf4;color:#059669">💸</div></div>
      <div class="admin-stat"><span>结算净额</span><b>¥${totalNet.toFixed(0)}</b><span>打款给商家</span><div class="icon" style="background:#eff6ff;color:#1d4ed8">💼</div></div>
      <div class="admin-stat"><span>违约/罚金</span><b>¥${totalPen.toFixed(0)}</b><span>扣罚合计</span><div class="icon" style="background:#fef2f2;color:#dc2626">⚠️</div></div>
    </div>
    <div class="admin-card">
      <h3>🧾 账单列表 <button class="btn-mini" onclick="exportBillCsv('ALL','${bf}')">📤 导出筛选结果</button></h3>
      <div class="admin-filters">
        <select onchange="m3State.billFilter=this.value;renderAdminBilling()">
          ${[['all','全部'],['thisMonth','本月'],['weekly','周结单'],['monthly','月结单'],['pending','待结算']].map(([k,v])=>`<option value="${k}"${bf===k?' selected':''}>${v}</option>`).join('')}
        </select>
        <input placeholder="搜索账单号/商家名" oninput="window._bfKw=this.value;renderAdminBilling()">
      </div>
      <table class="admin-table">
        <thead><tr><th>账单号</th><th>商家</th><th>账期</th><th>类型</th><th>GMV</th><th>实际结算</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>
          ${filtered.filter(b=>!window._bfKw||[b.id,b.merchantName].join(' ').includes(window._bfKw)).sort((a,b)=>b.to-a.to).map(b => `
            <tr>
              <td><b>${b.id}</b></td>
              <td>${b.merchantName}</td>
              <td>${b.period}</td>
              <td>${b.type}</td>
              <td>¥${b.gmv.toFixed(2)}</td>
              <td style="font-weight:700;color:#059669">¥${billNet(b).toFixed(2)}</td>
              <td><span class="st ${b.status==='settled'?'st-a':b.status==='checking'?'st-i':b.status==='rejected'?'st-d':'st-p'}">${billStatusLabel(b)}</span></td>
              <td style="text-align:right">
                <button class="btn-mini" onclick="m3State.billDetail='${b.id}';renderAdminBilling()">详情</button>
                <button class="btn-mini" onclick="exportBillCsv('${b.id}')">导出</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="8"><div class="empty">暂无数据</div></td></tr>'}
        </tbody>
      </table>
    </div>`;
}
function billSettle(id) {
  const list = seedBills();
  const b = list.find(x => x.id === id); if (!b) return;
  b.status = 'settled'; b.settledAt = Date.now();
  localStorage.setItem('xishi_m3_bills', JSON.stringify(list));
  addSysLog('inf', `账单出账成功：${id}（¥${billNet(b).toFixed(2)}）`, getAdminSession()?.user);
  renderAdminBilling(); toast(`✅ ${id} 已出账`);
}
function billReject(id) {
  const list = seedBills();
  const b = list.find(x => x.id === id); if (!b) return;
  const r = prompt('请填写异议原因：', '账单订单明细与商家系统不符');
  if (!r) return;
  b.status = 'rejected'; b.rejectReason = r;
  localStorage.setItem('xishi_m3_bills', JSON.stringify(list));
  addSysLog('wrn', `账单标记有异议：${id}（${r}）`, getAdminSession()?.user);
  renderAdminBilling(); toast('已标记有异议');
}
function exportBillCsv(id, filter) {
  const list = seedBills();
  const rows = [];
  const data = id === 'ALL' ? list.filter(b => {
    if (!filter || filter === 'all') return true;
    const now = Date.now(); const ms = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    if (filter === 'thisMonth') return b.to >= ms;
    if (filter === 'weekly') return b.type === '周结';
    if (filter === 'monthly') return b.type === '月结';
    if (filter === 'pending') return b.status !== 'settled';
    return true;
  }) : [list.find(x => x.id === id)].filter(Boolean);
  rows.push(['账单号','商家ID','商家名称','账期','类型','订单数','GMV','佣金','扣罚','退款','实际结算','状态','出账时间'].join(','));
  data.forEach(b => rows.push([b.id, b.merchantId, `"${b.merchantName}"`, `"${b.period}"`, b.type, b.orders, b.gmv.toFixed(2), b.commission.toFixed(2), b.penalty.toFixed(2), b.refund.toFixed(2), billNet(b).toFixed(2), billStatusLabel(b), b.settledAt ? fmtDateTime(b.settledAt) : ''].join(',')));
  const csv = '\uFEFF' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `xishi_bill_${id}_${Date.now()}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  addSysLog('inf', `导出账单：${id}`, getAdminSession()?.user);
  toast(`已导出 ${data.length} 张账单为 CSV`);
}
// ---- 6. 系统日志 & 参数配置 ----
function renderAdminSyslog() {
  const logs = seedSysLogs().slice(0, 200);
  const p = seedSysParams();
  return `
    <div class="admin-card">
      <h3>⚙️ 系统参数配置 <button class="btn-mini" onclick="saveM3Params()">💾 保存修改</button></h3>
      <div class="param-group">
        <h4>⏱ 订单 & 时效参数</h4>
        <div class="param-row"><label>未支付超时（分钟）<em>超出自动取消</em></label><input id="p-payTimeoutMin" type="number" min="1" max="180" value="${p.payTimeoutMin}"></div>
        <div class="param-row"><label>取货超时宽限（分钟）<em>超过开始产生告警</em></label><input id="p-offProtectMin" type="number" min="0" max="240" value="${p.offProtectMin}"></div>
        <div class="param-row"><label>紧急下架保护（分钟）<em>库存禁止模拟回补</em></label><input id="p-autoOfflateMin" type="number" min="0" max="1440" value="${p.autoOfflateMin}"></div>
        <div class="param-row"><label>工单 SLA（小时）<em>超出自动升级</em></label><input id="p-ticketSlaHr" type="number" min="1" max="240" value="${p.ticketSlaHr}"></div>
        <div class="param-row"><label>高危工单自动冻结（次）<em>超次数冻结店铺</em></label><input id="p-freezeIfH" type="number" min="1" max="10" value="${p.freezeIfH}"></div>
      </div>
      <div class="param-group">
        <h4>💰 定价 & 结算参数</h4>
        <div class="param-row"><label>价格波动下限（%）<em>低于底线的偏离阈值</em></label><input id="p-priceLowPct" type="number" step="0.01" min="0" max="0.9" value="${p.priceLowPct}"></div>
        <div class="param-row"><label>价格波动上限（倍）<em>高于底线的偏离阈值</em></label><input id="p-priceHighPct" type="number" step="0.1" min="1.2" max="8" value="${p.priceHighPct}"></div>
        <div class="param-row"><label>平台佣金比例（%）<em>账单默认比例</em></label><input id="p-commissionPct" type="number" step="0.1" min="0" max="30" value="${p.commissionPct}"></div>
        <div class="param-row"><label>损耗取消权重<em>未支付订单×系数计入损耗</em></label><input id="p-offloadRatio" type="number" step="0.01" min="0" max="1" value="${p.offloadRatio}"></div>
        <div class="param-row"><label>超时未取扣罚（元/小时）<em>商家履约处罚</em></label><input id="p-penaltyLateHr" type="number" step="0.5" min="0" max="200" value="${p.penaltyLateHr}"></div>
        <div class="param-row"><label>退款自动审核<em>金额 ≤ 底价 1.2 倍自动通过</em></label><span class="sw"><input id="p-refundAutoAudit" type="checkbox" class="switch" style="width:42px;height:24px"${p.refundAutoAudit?' checked':''}></span></div>
      </div>
      <div class="param-group">
        <h4>📢 通知 & 内容参数</h4>
        <div class="param-row"><label>晒单最大图片数</label><input id="p-maxPhotosPerShare" type="number" min="1" max="20" value="${p.maxPhotosPerShare}"></div>
        <div class="param-row"><label>晒单最大字数</label><input id="p-shareMaxWords" type="number" min="50" max="5000" value="${p.shareMaxWords}"></div>
        <div class="param-row"><label>订阅补货通知</label><span class="sw"><input id="p-notifySubscribe" type="checkbox" class="switch" style="width:42px;height:24px"${p.notifySubscribe?' checked':''}></span></div>
        <div class="param-row"><label>库存波动通知</label><span class="sw"><input id="p-notifyStock" type="checkbox" class="switch" style="width:42px;height:24px"${p.notifyStock?' checked':''}></span></div>
        <div class="param-row"><label>退款通知</label><span class="sw"><input id="p-notifyRefund" type="checkbox" class="switch" style="width:42px;height:24px"${p.notifyRefund?' checked':''}></span></div>
        <div class="param-row"><label>免打扰时段<em>推送静音</em></label>
          <span class="sw"><input id="p-dndEnabled" type="checkbox" class="switch" style="width:42px;height:24px"${p.dndEnabled?' checked':''}> 启用</span>
        </div>
        <div class="param-row"><label>免打扰开始</label><input id="p-dndStart" type="time" value="${p.dndStart}"></div>
        <div class="param-row"><label>免打扰结束</label><input id="p-dndEnd" type="time" value="${p.dndEnd}"></div>
      </div>
    </div>
    <div class="admin-card">
      <h3>📋 系统操作日志（最近 ${logs.length} 条）
        <span style="display:flex;gap:4px">
          <button class="btn-mini" onclick="renderAdminSyslog()">🔄 刷新</button>
          <button class="btn-mini" style="border-color:#dc2626;color:#991b1b" onclick="if(confirm('确认清空系统日志？')){localStorage.removeItem('xishi_m3_logs');renderAdminSyslog();toast('已清空');}">清空</button>
        </span>
      </h3>
      <div style="max-height:420px;overflow:auto;background:#f8fafc;border-radius:10px;padding:4px 8px;border:1px solid #e2e8f0">
        ${logs.map(l => `<div class="log-line"><span class="lvl ${l.lvl==='err'?'err':l.lvl==='wrn'?'wrn':'inf'}">[${{err:'ERROR',wrn:'WARN',inf:'INFO'}[l.lvl] || 'INFO'}]</span><span class="tm">${fmtDateTime(l.ts)}</span> <b style="color:#0f766e">[${l.actor}]</b> ${l.msg||''}</div>`).join('') || '<div class="empty">暂无日志</div>'}
      </div>
    </div>`;
}
function saveM3Params() {
  const cur = seedSysParams();
  const p = { ...cur };
  const map = {
    'p-payTimeoutMin': 'number', 'p-offProtectMin': 'number', 'p-autoOfflateMin': 'number', 'p-ticketSlaHr': 'number', 'p-freezeIfH': 'number',
    'p-priceLowPct': 'number', 'p-priceHighPct': 'number', 'p-commissionPct': 'number', 'p-offloadRatio': 'number', 'p-penaltyLateHr': 'number',
    'p-maxPhotosPerShare': 'number', 'p-shareMaxWords': 'number',
  };
  for (const [id, type] of Object.entries(map)) {
    const el = document.getElementById(id); if (!el) continue;
    const key = id.replace('p-', '');
    p[key] = type === 'number' ? parseFloat(el.value) : el.value;
  }
  p.refundAutoAudit = document.getElementById('p-refundAutoAudit').checked;
  p.notifySubscribe = document.getElementById('p-notifySubscribe').checked;
  p.notifyStock = document.getElementById('p-notifyStock').checked;
  p.notifyRefund = document.getElementById('p-notifyRefund').checked;
  p.dndEnabled = document.getElementById('p-dndEnabled').checked;
  p.dndStart = document.getElementById('p-dndStart').value;
  p.dndEnd = document.getElementById('p-dndEnd').value;
  localStorage.setItem('xishi_m3_params', JSON.stringify(p));
  addSysLog('inf', '保存系统参数（多值修改）', getAdminSession()?.user);
  toast('✅ 参数已保存');
}
// ---- 管理后台入口 & 登录绑定 ----
function openM3() {
  if (getAdminSession()) { enterAdminApp(); } else { showAdminLogin(); }
}
function initAdminLogin() {
  const send = document.getElementById('adSendCode');
  if (!send) return;
  let cd = 0;
  send.addEventListener('click', () => {
    if (cd > 0) return;
    cd = 60;
    toast('演示环境：验证码已发送（请使用 123456）');
    const t = setInterval(() => { cd--; send.textContent = cd > 0 ? `${cd}s 后重发` : '发送验证码'; if (cd <= 0) clearInterval(t); }, 1000);
  });
  document.getElementById('adLoginBtn').addEventListener('click', () => {
    const u = document.getElementById('adUser').value.trim();
    const pwd = document.getElementById('adPass').value;
    const code = document.getElementById('adCode').value.trim();
    if (!u || !pwd) { toast('请填写账号与密码'); return; }
    if (code !== '123456') { toast('验证码错误（演示：123456）'); return; }
    if (!(u === 'admin' && pwd === 'admin123')) { toast('账号或密码错误（演示：admin / admin123）'); return; }
    setAdminSession({ user: u, role: '超级管理员', at: Date.now() });
    addSysLog('inf', '管理员登录成功', u);
    enterAdminApp();
    toast('欢迎回来，' + u);
  });
  // 回车直接登录
  ['adUser','adPass','adCode'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('adLoginBtn').click(); });
  });
}

// 管理后台入口按钮
document.getElementById('btnAdmin').addEventListener('click', openM3);
// DOMContentLoaded 后绑定登录
setTimeout(initAdminLogin, 200);

/* ================= 启动 ================= */
initAuth();
locate(true);
