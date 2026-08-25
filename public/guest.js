// Trang dành cho khách trên điện thoại: tìm kiếm YouTube, chọn bài hát và theo dõi hàng đợi trực tiếp.

const resultsEl = document.getElementById("results");
const resultsSkeletonEl = document.getElementById("results-skeleton");
const statusEl = document.getElementById("status");
const toastsEl = document.getElementById("toasts");
const qEl = document.getElementById("q");
const nameEl = document.getElementById("name");
const sugSection = document.getElementById("suggestions-section");
const backToExploreBtn = document.getElementById("back-to-explore");
const youtubeLinkPanel = document.getElementById("youtube-link-panel");
const youtubeLinkForm = document.getElementById("youtube-link-form");
const youtubeLinkInput = document.getElementById("youtube-link-input");
const youtubeLinkSubmit = document.getElementById("youtube-link-submit");
const youtubeLinkStatus = document.getElementById("youtube-link-status");
const youtubeLinkPreview = document.getElementById("youtube-link-preview");
const youtubeLinkThumb = document.getElementById("youtube-link-thumb");
const youtubeLinkTitle = document.getElementById("youtube-link-title");
const youtubeLinkSub = document.getElementById("youtube-link-sub");
const youtubeLinkAdd = document.getElementById("youtube-link-add");
const feedbackSection = document.getElementById("feedback-section");
const feedbackForm = document.getElementById("feedback-form");
const feedbackName = document.getElementById("feedback-name");
const feedbackContent = document.getElementById("feedback-content");
const feedbackSubmit = document.getElementById("feedback-submit");
const feedbackStatus = document.getElementById("feedback-status");
let resolvedYouTubeSong = null;
let queueLimitOn = false;
let queueLimit = 10;
let requireName = false;
let feedbackOn = true;
let queueWs = null;
const pendingRemovals = new Set();

// ---- Khám phá (duyệt kiểu KTV) ------------------------------------------
// Các tab thể loại và chip ca sĩ dùng các truy vấn YouTube có sẵn qua /api/browse
// (được máy chủ lưu bộ nhớ đệm), nên bài hát hiển thị là dữ liệu thực và mới — không phải
// danh sách viết cố định. Nút "Thêm bài hát" lần lượt duyệt qua các biến thể truy vấn.
// Truy vấn chỉ gồm cụm từ thể loại hoặc nghệ sĩ: nguồn là tìm kiếm "Songs" của YouTube Music
// (chỉ lấy đĩa đơn nhạc), nên không cần thêm hậu tố "Official MV" để tránh video tổng hợp —
// bộ lọc tối đa 10 phút ở máy chủ là lớp bảo vệ cuối cùng.
const THIS_YEAR = new Date().getFullYear();
const GENRE_QUERIES = {
  // "__vn_hits" is a server sentinel, not a search query: it loads the current
  // Vietnam YouTube music chart before the broader discovery queries.
  All: ["__vn_hits", `V-pop ${THIS_YEAR}`, `nhạc Việt ${THIS_YEAR}`, `K-pop ${THIS_YEAR}`, "party anthems"],
  // Tab này cố ý không có chip ca sĩ — nhạc tốt nghiệp là một chủ đề,
  // không phải danh sách nghệ sĩ (không có mục GENRE_SLUG nên hàng ca sĩ để trống).
  Graduation: ["nhạc tốt nghiệp", "nhạc chia tay tuổi học trò", "nhạc về tình bạn", "graduation songs"],
  "K-pop": [`K-pop ${THIS_YEAR}`, "K-pop dance hits", "K-pop girl group hits"],
  VPop: [`V-pop ${THIS_YEAR}`, `nhạc Việt mới ${THIS_YEAR}`, "V-pop thịnh hành", "nhạc trẻ Việt Nam"],
  Bolero: ["nhạc trữ tình Việt Nam", "bolero Việt Nam", "nhạc vàng hay nhất", "nhạc quê hương trữ tình"],
  Western: ["top pop hits", `pop hits ${THIS_YEAR}`, "classic pop anthems"],
  Party: ["party dance hits", "EDM anthems", "dancefloor classics"],
  Classics: ["nhạc Việt xưa", "nhạc vàng Việt Nam", "nhạc trữ tình thập niên 90", "bolero kinh điển"],
};
// User-facing genre labels. Internal keys index the query and singer collections.
const GENRE_LABEL = { All: "Tất cả", Graduation: "Tốt nghiệp", "K-pop": "K-pop", VPop: "V-pop", Bolero: "Nhạc trữ tình / bolero", Western: "Nhạc Âu Mỹ", Party: "Nhạc tiệc", Classics: "Nhạc kinh điển" };
const GENRE_ICON = {
  All: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="7" cy="7" r="2.6"/><circle cx="17" cy="7" r="2.6"/><circle cx="7" cy="17" r="2.6"/><circle cx="17" cy="17" r="2.6"/></svg>',
  Graduation: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.8v4.2c0 1.1 2.5 2.5 5.5 2.5s5.5-1.4 5.5-2.5v-4.2"/><path d="M21.5 9.5v5"/></svg>',
  "K-pop": '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7.2-4.4-9.7-9.1A5 5 0 0112 5.6a5 5 0 019.7 5.3C19.2 15.6 12 20 12 20z"/></svg>',
  VPop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9.3" y="2.8" width="5.4" height="10.5" rx="2.7"/><path d="M6.3 11a5.7 5.7 0 0011.4 0"/><path d="M12 16.7v3.3M9.3 20h5.4"/></svg>',
  Bolero: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4v9.6a3.4 3.4 0 101.6 2.9V8.6l5.9-1.4V4l-7.5 2z"/></svg>',
  Western: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4"/><path d="M12 3.8c2.6 2.2 2.6 14.2 0 16.4c-2.6-2.2-2.6-14.2 0-16.4z"/></svg>',
  Party: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2 6.2h6.4l-5.2 3.9 2 6.4-5.2-4-5.2 4 2-6.4-5.2-3.9h6.4z"/></svg>',
  Classics: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
};
const GENRE_SLUG = { "K-pop": "kpop", VPop: "vpop", Bolero: "bolero", Western: "western", Party: "party", Classics: "classics" };

const SINGERS = [
  { n: "Sơn Tùng M-TP", q: "Sơn Tùng M-TP", g: "vpop" },
  { n: "HIEUTHUHAI", q: "HIEUTHUHAI", g: "vpop" },
  { n: "MONO", q: "MONO Việt Nam", g: "vpop" },
  { n: "Wren Evans", q: "Wren Evans", g: "vpop" },
  { n: "RPT MCK", q: "RPT MCK", g: "vpop" },
  { n: "Tăng Duy Tân", q: "Tăng Duy Tân", g: "vpop" },
  { n: "Bích Phương", q: "Bích Phương", g: "vpop" },
  { n: "MIN", q: "MIN Việt Nam", g: "vpop" },
  { n: "AMEE", q: "AMEE", g: "vpop" },
  { n: "Đức Phúc", q: "Đức Phúc", g: "vpop" },
  { n: "Hòa Minzy", q: "Hòa Minzy", g: "vpop" },
  { n: "SOOBIN", q: "SOOBIN", g: "vpop" },
  { n: "Isaac", q: "Isaac Việt Nam", g: "vpop" },
  { n: "Vũ.", q: "Vũ. ca sĩ", g: "vpop" },
  { n: "tlinh", q: "tlinh", g: "vpop" },
  { n: "Phương Ly", q: "Phương Ly", g: "vpop" },
  { n: "Grey D", q: "Grey D", g: "vpop" },
  { n: "Quang Hùng MasterD", q: "Quang Hùng MasterD", g: "vpop" },
  { n: "Lệ Quyên", q: "Lệ Quyên", g: "bolero" },
  { n: "Đàm Vĩnh Hưng", q: "Đàm Vĩnh Hưng", g: "bolero" },
  { n: "Quang Lê", q: "Quang Lê", g: "bolero" },
  { n: "Như Quỳnh", q: "Như Quỳnh", g: "bolero" },
  { n: "Phi Nhung", q: "Phi Nhung", g: "bolero" },
  { n: "Cẩm Ly", q: "Cẩm Ly", g: "bolero" },
  { n: "Đan Trường", q: "Đan Trường", g: "bolero" },
  { n: "Chế Linh", q: "Chế Linh", g: "bolero" },
  { n: "Mạnh Quỳnh", q: "Mạnh Quỳnh", g: "bolero" },
  { n: "Ngọc Sơn", q: "Ngọc Sơn", g: "bolero" },
  { n: "Duy Khánh", q: "Duy Khánh nhạc vàng", g: "bolero" },
  { n: "Tuấn Vũ", q: "Tuấn Vũ", g: "bolero" },
  { n: "Giao Linh", q: "Giao Linh", g: "bolero" },
  { n: "Khánh Ly", q: "Khánh Ly", g: "bolero" },
  { n: "Bằng Kiều", q: "Bằng Kiều", g: "bolero" },
  { n: "NewJeans", q: "NewJeans", g: "kpop" },
  { n: "BTS", q: "BTS", g: "kpop" },
  { n: "BLACKPINK", q: "BLACKPINK", g: "kpop" },
  { n: "aespa", q: "aespa", g: "kpop" },
  { n: "TWICE", q: "TWICE", g: "kpop" },
  { n: "SEVENTEEN", q: "SEVENTEEN 세븐틴", g: "kpop" },
  { n: "Stray Kids", q: "Stray Kids", g: "kpop" },
  { n: "IVE", q: "IVE 아이브", g: "kpop" },
  { n: "LE SSERAFIM", q: "LE SSERAFIM", g: "kpop" },
  { n: "IU", q: "IU 아이유", g: "kpop" },
  { n: "(G)I-DLE", q: "(G)I-DLE", g: "kpop" },
  { n: "ITZY", q: "ITZY", g: "kpop" },
  { n: "ENHYPEN", q: "ENHYPEN", g: "kpop" },
  { n: "TXT", q: "TOMORROW X TOGETHER", g: "kpop" },
  { n: "BABYMONSTER", q: "BABYMONSTER", g: "kpop" },
  { n: "ILLIT", q: "ILLIT", g: "kpop" },
  { n: "Taylor Swift", q: "Taylor Swift", g: "western" },
  { n: "Bruno Mars", q: "Bruno Mars", g: "western" },
  { n: "Ed Sheeran", q: "Ed Sheeran", g: "western" },
  { n: "The Weeknd", q: "The Weeknd", g: "western" },
  { n: "Billie Eilish", q: "Billie Eilish", g: "western" },
  { n: "Dua Lipa", q: "Dua Lipa", g: "western" },
  { n: "Adele", q: "Adele", g: "western" },
  { n: "Olivia Rodrigo", q: "Olivia Rodrigo", g: "western" },
  { n: "Ariana Grande", q: "Ariana Grande", g: "western" },
  { n: "Justin Bieber", q: "Justin Bieber", g: "western" },
  { n: "Coldplay", q: "Coldplay", g: "western" },
  { n: "Maroon 5", q: "Maroon 5", g: "western" },
  { n: "Sabrina Carpenter", q: "Sabrina Carpenter", g: "western" },
  { n: "Charlie Puth", q: "Charlie Puth", g: "western" },
  { n: "Calvin Harris", q: "Calvin Harris", g: "party" },
  { n: "David Guetta", q: "David Guetta", g: "party" },
  { n: "Avicii", q: "Avicii", g: "party" },
  { n: "Black Eyed Peas", q: "Black Eyed Peas", g: "party" },
  { n: "The Chainsmokers", q: "The Chainsmokers", g: "party" },
  { n: "Marshmello", q: "Marshmello", g: "party" },
  { n: "Alan Walker", q: "Alan Walker", g: "party" },
  { n: "Kygo", q: "Kygo", g: "party" },
  { n: "Pitbull", q: "Pitbull", g: "party" },
  { n: "Zedd", q: "Zedd", g: "party" },
  { n: "Mỹ Tâm", q: "Mỹ Tâm", g: "classics" },
  { n: "Lam Trường", q: "Lam Trường", g: "classics" },
  { n: "Phương Thanh", q: "Phương Thanh", g: "classics" },
  { n: "Hồng Nhung", q: "Hồng Nhung", g: "classics" },
  { n: "Quang Dũng", q: "Quang Dũng", g: "classics" },
  { n: "Thanh Lam", q: "Thanh Lam", g: "classics" },
  { n: "Lê Hiếu", q: "Lê Hiếu", g: "classics" },
  { n: "Ưng Hoàng Phúc", q: "Ưng Hoàng Phúc", g: "classics" },
  { n: "Đan Trường", q: "Đan Trường", g: "classics" },
  { n: "Cẩm Ly", q: "Cẩm Ly", g: "classics" },
  { n: "Khánh Ly", q: "Khánh Ly", g: "classics" },
];

const moreBtn = document.getElementById("more");
let activeGenre = "All"; // tab đang chọn — đồng thời lọc hàng ca sĩ
let activeKey = "genre:All"; // "genre:<name>" hoặc "singer:<name>" (đánh dấu)
const browse = { queries: [], idx: 0, seen: new Set(), gen: 0 };

// Fisher-Yates — dùng để sắp xếp lại các biến thể truy vấn (nút ngẫu nhiên) và
// trộn kết quả ở phía máy khách, vì bộ nhớ đệm máy chủ trả về cùng một mảng
// mỗi lần với cùng một truy vấn.
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderGenreTabs() {
  const bar = document.getElementById("genre-tabs");
  bar.innerHTML = "";
  for (const g of Object.keys(GENRE_QUERIES)) {
    const btn = document.createElement("button");
    btn.className = "genre-tab" + (activeKey === `genre:${g}` ? " active" : "");
    btn.innerHTML = `${GENRE_ICON[g]}<span></span>`;
    btn.querySelector("span").textContent = GENRE_LABEL[g];
    btn.onclick = () => selectGenre(g);
    bar.appendChild(btn);
  }
}

function renderSingers() {
  const row = document.getElementById("singers");
  row.innerHTML = "";
  const list =
    activeGenre === "All" ? SINGERS : SINGERS.filter((s) => s.g === GENRE_SLUG[activeGenre]);
  // Các thể loại không có mục GENRE_SLUG (ví dụ Graduation) không có danh sách ca sĩ —
  // ẩn cả hàng thay vì để lại một dải trống.
  row.classList.toggle("hidden", list.length === 0);
  for (const s of list) {
    const btn = document.createElement("button");
    btn.className = `singer-chip${activeKey === `singer:${s.n}` ? " active" : ""}`;
    btn.innerHTML = `<span class="singer-avatar g-${s.g}"></span><span class="singer-name"></span>`;
    btn.querySelector(".singer-avatar").textContent = [...s.n][0];
    btn.querySelector(".singer-name").textContent = s.n;
    btn.onclick = () => selectSinger(s);
    row.appendChild(btn);
  }
}

function selectGenre(g) {
  activeGenre = g;
  activeKey = `genre:${g}`;
  renderGenreTabs();
  renderSingers();
  startBrowse(GENRE_QUERIES[g]);
}

function selectSinger(s) {
  activeKey = `singer:${s.n}`;
  renderGenreTabs();
  renderSingers();
  startBrowse([s.q, `${s.q} bài hát nổi bật`, `${s.q} hits`]);
}

async function startBrowse(queries) {
  browse.queries = queries;
  browse.idx = 0;
  browse.seen = new Set();
  browse.gen++; // vô hiệu hóa mọi lần loadMoreSongs đang chạy của tab/tìm kiếm trước đó
  resultsEl.innerHTML = "";
  moreBtn.classList.add("hidden");
  await loadMoreSongs();
}

// Duyệt qua các biến thể truy vấn (mỗi biến thể gọi /api/browse một lần) cho đến khi
// tìm được ít nhất một bài hát chưa hiển thị hoặc hết biến thể — để biến thể có toàn
// kết quả trùng không âm thầm không thêm gì (D3).
async function loadMoreSongs() {
  const gen = browse.gen;
  moreBtn.disabled = true;
  setLoading(true, "Đang tải bài hát…");
  try {
    while (browse.idx < browse.queries.length) {
      const q = browse.queries[browse.idx++];
      const res = await fetch("/api/browse?q=" + encodeURIComponent(q));
      if (browse.gen !== gen) return; // đã cũ — tab/tìm kiếm/ngẫu nhiên mới hơn đã thay thế
      const data = await res.json();
      if (browse.gen !== gen) return;
      if (!res.ok) throw new Error(data.error || "Không thể tải bài hát.");
      let fresh = (data.results || []).filter((r) => r.videoId && !browse.seen.has(r.videoId));
      if (fresh.length === 0) continue; // biến thể này toàn kết quả trùng — thử biến thể tiếp theo
      for (const r of fresh) browse.seen.add(r.videoId);
      fresh = shuffleArray(fresh); // không hiển thị cùng một thứ tự mỗi lần (A4)
      setLoading(false);
      setStatus("");
      appendResults(fresh);
      break;
    }
    if (browse.gen === gen) {
      setLoading(false);
      if (browse.seen.size === 0) setStatus("Không tìm thấy bài hát — hãy thử danh mục khác.");
    }
  } catch (err) {
    if (browse.gen === gen) {
      setLoading(false);
      setStatus("😕 " + err.message);
    }
  } finally {
    if (browse.gen === gen) {
      moreBtn.disabled = false;
      moreBtn.classList.toggle("hidden", browse.idx >= browse.queries.length);
    }
  }
}

moreBtn.onclick = loadMoreSongs;

document.getElementById("shuffle").onclick = () => {
  // Chạy lại lựa chọn hiện tại với các biến thể truy vấn theo thứ tự mới.
  startBrowse(shuffleArray(browse.queries));
};

// ---- Tìm kiếm ----------------------------------------------------------
document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doSearch(qEl.value.trim());
});

async function doSearch(q) {
  if (!q) return backToExplore(); // gửi biểu mẫu trống sẽ khôi phục mục khám phá

  const gen = ++browse.gen; // không cho yêu cầu cũ ghi đè kết quả tìm kiếm mới nhất
  qEl.blur();
  resultsEl.innerHTML = "";
  sugSection.classList.add("hidden"); // ẩn mục khám phá khi bắt đầu tìm kiếm
  moreBtn.classList.add("hidden");
  backToExploreBtn.classList.remove("hidden");
  setLoading(true, "Đang tìm kiếm…");
  try {
    const res = await fetch("/api/search?q=" + encodeURIComponent(q));
    if (browse.gen !== gen) return;
    const data = await res.json();
    if (browse.gen !== gen) return;
    if (!res.ok) throw new Error(data.error || "Tìm kiếm thất bại.");
    setLoading(false);
    renderResults(data.results || []);
  } catch (err) {
    if (browse.gen === gen) {
      setLoading(false);
      setStatus("😕 " + err.message);
    }
  }
}

// Khôi phục mục khám phá sau khi tìm kiếm — chạy lại lựa chọn duyệt
// (thể loại/ca sĩ) đã được chọn trước khi khách tìm kiếm.
function backToExplore() {
  qEl.value = "";
  resultsEl.innerHTML = "";
  setStatus("");
  backToExploreBtn.classList.add("hidden");
  sugSection.classList.remove("hidden");
  startBrowse(browse.queries);
}

backToExploreBtn.onclick = backToExplore;

function setStatus(text) {
  statusEl.classList.remove("loading-status");
  if (!text) {
    statusEl.textContent = "";
    return statusEl.classList.add("hidden");
  }
  statusEl.textContent = text;
  statusEl.classList.remove("hidden");
}

function setLoading(isLoading, label = "Đang tải…") {
  resultsSkeletonEl.classList.toggle("hidden", !isLoading);
  resultsEl.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (!isLoading) {
    statusEl.classList.remove("loading-status");
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.textContent = label;
  statusEl.classList.remove("hidden");
  statusEl.classList.add("loading-status");
}

// Ảnh thay thế cho hình thu nhỏ bị thiếu — thẻ <img src=""> trống sẽ gửi yêu cầu
// đến URL của trang hiện tại. Dùng cùng mẫu với cách host.js hiển thị hàng đợi.
const NO_THUMB = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';

function resultCard(r) {
  const li = document.createElement("li");
  li.innerHTML = `
    <img src="${r.thumbnail || NO_THUMB}" alt="" loading="lazy" />
    <div class="r-meta">
      <div class="r-title"></div>
      <div class="r-sub"></div>
    </div>
    <button class="add-btn" title="Thêm bài hát" aria-label="Thêm bài hát">+</button>`;
  li.querySelector(".r-title").textContent = r.title;
  li.querySelector(".r-sub").textContent = r.channel + (r.duration ? ` · ${r.duration}` : "");
  const btn = li.querySelector(".add-btn");
  btn.onclick = () => requestSong(r, btn);
  return li;
}

function appendResults(results) {
  for (const r of results) resultsEl.appendChild(resultCard(r));
}

function renderResults(results) {
  if (results.length === 0) return setStatus("Không có kết quả, hãy thử từ khóa khác.");
  setStatus("");
  resultsEl.innerHTML = "";
  appendResults(results);
}

// ---- Thêm bằng link YouTube --------------------------------------------
document.getElementById("show-youtube-link").onclick = () => {
  const open = youtubeLinkPanel.classList.toggle("hidden") === false;
  document.getElementById("show-youtube-link").textContent = open ? "Thu gọn" : "Dán link";
  if (open) youtubeLinkInput.focus();
};

function setYouTubeLinkStatus(text, kind = "") {
  youtubeLinkStatus.textContent = text;
  youtubeLinkStatus.className = `youtube-link-status${kind ? ` ${kind}` : ""}`;
}

function showYouTubePreview(song) {
  resolvedYouTubeSong = song;
  youtubeLinkThumb.src = song.thumbnail || NO_THUMB;
  youtubeLinkTitle.textContent = song.title;
  youtubeLinkSub.textContent = song.channel;
  youtubeLinkAdd.disabled = false;
  youtubeLinkAdd.textContent = "+";
  youtubeLinkPreview.classList.remove("hidden");
}

youtubeLinkForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = youtubeLinkInput.value.trim();
  if (!url) return setYouTubeLinkStatus("Vui lòng dán link YouTube.", "bad");
  youtubeLinkSubmit.disabled = true;
  youtubeLinkSubmit.textContent = "Đang kiểm tra…";
  youtubeLinkPreview.classList.add("hidden");
  resolvedYouTubeSong = null;
  setYouTubeLinkStatus("");
  try {
    const res = await fetch("/api/youtube/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Link YouTube không đúng định dạng.");
    showYouTubePreview(data.song);
    setYouTubeLinkStatus("Đã tìm thấy video. Bạn có thể thêm vào hàng đợi.", "ok");
  } catch (err) {
    setYouTubeLinkStatus(err.message || "Không thể kiểm tra link YouTube.", "bad");
  } finally {
    youtubeLinkSubmit.disabled = false;
    youtubeLinkSubmit.textContent = "Kiểm tra";
  }
});

youtubeLinkAdd.onclick = () => {
  if (resolvedYouTubeSong) requestSong(resolvedYouTubeSong, youtubeLinkAdd);
};

// ---- Nhận diện khách ----------------------------------------------------
// Gửi ID ngẫu nhiên được lưu lại cùng mỗi yêu cầu để thời gian chờ của máy chủ
// tính theo điện thoại thay vì theo IP (khách dùng Wi-Fi địa điểm thường chung một IP công khai).
const clientId =
  localStorage.getItem("clientId") ||
  (() => {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    localStorage.setItem("clientId", id);
    return id;
  })();

// ---- Tên khách (lưu lại, không bắt buộc) -------------------------------
nameEl.value = localStorage.getItem("guestName") || "";
feedbackName.value = nameEl.value;
nameEl.addEventListener("change", () => {
  localStorage.setItem("guestName", nameEl.value.trim());
  if (!feedbackName.value.trim()) feedbackName.value = nameEl.value.trim();
});

function renderRequestSettings() {
  nameEl.required = requireName;
  nameEl.placeholder = requireName ? "Tên order (bắt buộc)" : "Tên order (không bắt buộc)";
  document.getElementById("name-hint").textContent = requireName
    ? "Bắt buộc · hiển thị bên cạnh bài hát bạn chọn"
    : "Không bắt buộc · hiển thị bên cạnh bài hát bạn chọn";
}

function renderFeedback() {
  feedbackSection.classList.toggle("hidden", !feedbackOn);
}

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!feedbackName.value.trim() || !feedbackContent.value.trim()) return;
  feedbackSubmit.disabled = true;
  feedbackStatus.className = "feedback-status";
  feedbackStatus.textContent = "Đang gửi…";
  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: feedbackName.value.trim(), content: feedbackContent.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.reason || "Không thể gửi góp ý.");
    feedbackContent.value = "";
    feedbackStatus.className = "feedback-status ok";
    feedbackStatus.textContent = "Cảm ơn bạn! Góp ý đã được gửi.";
  } catch (error) {
    feedbackStatus.className = "feedback-status bad";
    feedbackStatus.textContent = error.message || "Không thể gửi góp ý.";
  } finally {
    feedbackSubmit.disabled = false;
  }
});

// ---- Yêu cầu của mình (cho nhãn "Bạn" trong hàng đợi) -------------------
function loadMyRequestIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("myRequestIds") || "[]"));
  } catch {
    return new Set();
  }
}
function rememberMyRequest(id) {
  const ids = [...loadMyRequestIds(), id].slice(-50); // giới hạn để danh sách không tăng vô hạn
  localStorage.setItem("myRequestIds", JSON.stringify(ids));
}

// ---- Chọn một bài hát --------------------------------------------------
async function requestSong(song, btn) {
  if (requireName && !nameEl.value.trim()) {
    toast("bad", "!", "Vui lòng nhập tên order trước.", { sub: "Host đang yêu cầu tên người chọn bài." });
    nameEl.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = "…";
  // Thẻ "đang kiểm tra" được giữ lại và có hoạt ảnh — bộ lọc tìm kiếm trên web
  // có thể mất 5–20 giây, nên thẻ phải thể hiện hoạt động thay vì trông như bị treo.
  // Dòng phụ ghi tên bài hát vì có thể kiểm tra nhiều bài cùng lúc.
  const t = toast("info", "🔎", "Đang kiểm tra bài hát…", { persist: true, sub: song.title, checking: true });
  try {
    const res = await fetch("/api/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...song, name: nameEl.value.trim(), clientId }),
    });
    const data = await res.json();
    if (data.ok) {
      const main = data.position === 0 ? "Đã thêm · đang phát" : `Đã thêm · vị trí ${data.position}`;
      const sub = data.position === 0 ? "Bài hát đang phát ngay." : `Đang ở vị trí ${data.position} trong hàng đợi.`;
      t.set("ok", "✓", main, { sub });
      btn.textContent = "✓";
      if (data.id) {
        rememberMyRequest(data.id);
        // Thông báo hàng đợi thường đến trước phản hồi này, nên dòng đã được
        // hiển thị khi chưa biết đó là yêu cầu của mình — hiển thị lại để có nhãn.
        if (lastQueueState) renderQueue(lastQueueState);
      }
    } else {
      if (data.retryIn) {
        t.dismiss();
        cooldownToast(data.retryIn);
      } else t.set("bad", "🚫", data.reason || "Không thể thêm bài hát này.");
      btn.disabled = false;
      btn.textContent = "+";
    }
  } catch (err) {
    t.set("bad", "⚠️", "Lỗi mạng, vui lòng thử lại.", { sub: "Không thể kết nối mạng. Hãy thử lại." });
    btn.disabled = false;
    btn.textContent = "+";
  }
}

// Xếp chồng thông báo: mỗi thẻ là một phần tử riêng (vòng biểu tượng, dòng chính
// và dòng phụ nhỏ hơn). toast() trả về một đối tượng điều khiển có set() để biến đổi
// thẻ ngay tại chỗ — thẻ "đang kiểm tra" trở thành kết quả tương ứng — nhờ đó các
// yêu cầu song song không ghi đè phản hồi của nhau.
const MAX_TOASTS = 3;

function toast(kind, icon, main, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  toastsEl.appendChild(el);
  while (toastsEl.children.length > MAX_TOASTS) toastsEl.firstElementChild.remove();
  void el.offsetHeight; // buộc trình duyệt cập nhật kiểu để thêm .show có thể tạo hoạt ảnh
  let timer;
  const h = {
    el,
    set(kind2, icon2, main2, { persist = false, sub = "", checking = false } = {}) {
      el.className = `toast show ${kind2}${checking ? " checking" : ""}`;
      el.innerHTML = `
        <span class="toast-ico"></span>
        <div><div class="toast-main"></div><div class="toast-sub"></div></div>`;
      el.querySelector(".toast-ico").textContent = icon2;
      el.querySelector(".toast-main").textContent = main2;
      const subEl = el.querySelector(".toast-sub");
      if (sub) subEl.textContent = sub;
      else subEl.remove();
      clearTimeout(timer);
      if (!persist) timer = setTimeout(h.dismiss, 3800);
    },
    dismiss() {
      clearTimeout(timer);
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300); // chờ chuyển tiếp ẩn hoàn tất
    },
  };
  h.set(kind, icon, main, opts);
  return h;
}

// Hiển thị đếm ngược trực tiếp khi máy chủ từ chối yêu cầu vì gửi quá sớm
// (retryIn = số giây còn lại). Dùng một thẻ duy nhất: nếu thử lại khi đang chờ,
// đếm ngược sẽ khởi động lại trên cùng thẻ thay vì xếp thêm bản sao.
function cooldownToast(seconds) {
  clearInterval(cooldownToast._i);
  if (!cooldownToast._h?.el.isConnected) {
    cooldownToast._h = toast("bad", "⏳", "", { persist: true });
  }
  const t = cooldownToast._h;
  let left = seconds;
  const draw = () =>
    t.set("bad", "⏳", `Vui lòng đợi thêm ${left} giây`, { persist: true, sub: `Bài tiếp theo sau ${left} giây…` });
  draw();
  cooldownToast._i = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(cooldownToast._i);
      t.dismiss();
    } else draw();
  }, 1000);
}

// ---- Hàng đợi trực tiếp (WebSocket) -----------------------------------
let lastQueueState = null; // giữ lại để có thể hiển thị lại nhãn Bạn sau khi thêm bài

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  queueWs = ws;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") {
      lastQueueState = msg.state;
      if (typeof msg.queueLimitOn === "boolean") queueLimitOn = msg.queueLimitOn;
      if (typeof msg.queueLimit === "number") queueLimit = msg.queueLimit;
      if (typeof msg.requireName === "boolean") requireName = msg.requireName;
      if (typeof msg.feedbackOn === "boolean") feedbackOn = msg.feedbackOn;
      renderRequestSettings();
      renderFeedback();
      renderQueue(msg.state);
    } else if (msg.type === "removeOwnResult") {
      pendingRemovals.delete(msg.id);
      if (msg.ok) toast("ok", "✓", "Đã xóa khỏi hàng đợi.");
      else toast("bad", "!", msg.reason || "Không thể xóa bài hát này.");
      if (lastQueueState) renderQueue(lastQueueState);
    }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

function renderQueue(state) {
  const np = state.nowPlaying;
  const npEl = document.getElementById("now-playing");
  if (np) {
    npEl.classList.remove("hidden");
    npEl.innerHTML = `
      <img src="${np.thumbnail || NO_THUMB}" alt="" />
      <div class="np-body">
        <div class="np-label">
          <span class="eq"><span></span><span></span><span></span></span>
          ĐANG PHÁT
        </div>
        <div class="np-title"></div>
        <div class="np-sub"></div>
      </div>`;
    npEl.querySelector(".np-title").textContent = np.title;
    npEl.querySelector(".np-sub").textContent =
      (np.channel || "") + (np.addedBy ? ` · Người chọn: ${np.addedBy}` : "");
  } else {
    npEl.classList.add("hidden");
  }

  const queue = state.queue || [];
  document.getElementById("queue-count").textContent = queue.length;
  const limitNotice = document.getElementById("queue-limit-notice");
  const limitReached = queueLimitOn && queue.length >= queueLimit;
  limitNotice.classList.toggle("hidden", !limitReached);
  if (limitReached) limitNotice.textContent = `Hàng đợi đã đạt giới hạn ${queueLimit} bài — hãy chờ phát bớt trước khi thêm bài mới.`;
  const ul = document.getElementById("queue");
  ul.innerHTML = "";
  if (queue.length === 0) {
    ul.innerHTML = '<li class="q-empty">Chưa có bài hát nào — hãy là người đầu tiên chọn bài!</li>';
    return;
  }
  const myIds = loadMyRequestIds();
  queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="q-num">${i + 1}</span>
      <img src="${item.thumbnail || NO_THUMB}" alt="" loading="lazy" />
      <div class="q-text"><div class="t-row"><span class="t"></span></div><div class="s"></div><div class="q-eta"></div></div>
      <button class="q-remove-own hidden" type="button" title="Xóa bài của bạn" aria-label="Xóa bài của bạn">×</button>`;
    li.querySelector(".t").textContent = item.title;
    li.querySelector(".s").textContent = item.channel;
    li.querySelector(".q-eta").textContent = formatEstimatedStart(item.estimatedStartAt);
    if (myIds.has(item.id)) {
      const chip = document.createElement("span");
      chip.className = "q-you";
      chip.textContent = "Bạn";
      li.querySelector(".t-row").appendChild(chip);
      const remove = li.querySelector(".q-remove-own");
      remove.classList.remove("hidden");
      remove.disabled = pendingRemovals.has(item.id);
      remove.onclick = () => {
        if (!queueWs || queueWs.readyState !== WebSocket.OPEN || pendingRemovals.has(item.id)) return;
        pendingRemovals.add(item.id);
        remove.disabled = true;
        queueWs.send(JSON.stringify({ type: "removeOwn", id: item.id, clientId }));
      };
    }
    ul.appendChild(li);
  });
}

function formatEstimatedStart(timestamp) {
  if (!Number.isFinite(timestamp)) return "Chưa rõ thời gian phát";
  const minutes = Math.max(0, Math.round((timestamp - Date.now()) / 60000));
  if (minutes < 1) return "Dự kiến phát sắp tới";
  if (minutes < 60) return `Dự kiến phát sau khoảng ${minutes} phút`;
  return `Dự kiến phát lúc ${new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

renderSingers();
selectGenre("All"); // hiển thị tab và tải bài hát thật khi mở trang
renderRequestSettings();
renderFeedback();
connectWs();
setInterval(() => {
  if (lastQueueState) renderQueue(lastQueueState);
}, 30000);
