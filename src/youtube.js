// Truy cập YouTube không cần API key:
//  - searchYouTube(): gọi API tìm kiếm nội bộ của YouTube Music (InnerTube,
//    cùng endpoint JSON mà web app music.youtube.com sử dụng), lọc theo danh mục
//    "Songs". Kết quả chỉ gồm nhạc với metadata nghệ sĩ/album thực; videoId trả
//    về vẫn phát trong iframe YouTube thông thường như trước.
//  - checkPlayable(): dùng endpoint oEmbed để từ chối video đã xóa/riêng tư
//    trước khi đưa vào hàng đợi. (Video tắt nhúng vẫn trả về 200 ở đây, nên
//    trình phát host CŨNG tự bỏ qua các mã lỗi iframe 101/150.)

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Cookie SOCS/CONSENT tránh màn hình chấp thuận "before you continue" của EU,
// vốn sẽ thay ytInitialData bằng trang xen kẽ.
const COMMON_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "SOCS=CAI;CONSENT=YES+1",
};

function pickThumbnail(thumbs) {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
  // YT Music trả ảnh album nhỏ (60/120px), nhưng kích thước nằm ở hậu tố URL
  // — yêu cầu ảnh hình vuông lớn hơn.
  return thumbs[thumbs.length - 1].url.replace(/=w\d+-h\d+/, "=w320-h320");
}

// Bộ lọc tìm kiếm InnerTube cho danh mục "Songs" (cùng giá trị ytmusicapi dùng).
const SONGS_FILTER = "EgWKAQIIAWoMEA4QChADEAQQCRAF";

export async function searchYouTube(query, { limit = 12, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data;
  try {
    const res = await fetch("https://music.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "application/json",
        Origin: "https://music.youtube.com",
        Referer: "https://music.youtube.com/",
      },
      body: JSON.stringify({
        context: {
          client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: "en" },
        },
        query,
        params: SONGS_FILTER,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube Music phản hồi ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const sections =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents || [];

  const results = [];
  for (const section of sections) {
    for (const item of section?.musicShelfRenderer?.contents || []) {
      const r = item.musicResponsiveListItemRenderer;
      const videoId =
        r?.playlistItemData?.videoId ||
        r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
          ?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId) continue;
      // flexColumns: [0] = tiêu đề, [1] = "nghệ sĩ • album • thời lượng" dưới dạng runs.
      const cols = (r.flexColumns || []).map(
        (c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
      );
      const byline = cols[1] || [];
      const duration = byline.map((run) => run.text).filter((t) => /^\d+:\d\d/.test(t)).pop();
      results.push({
        videoId,
        title: cols[0]?.map((run) => run.text).join("") || "(không có tiêu đề)",
        channel: byline[0]?.text || "Không rõ",
        duration: duration || "",
        thumbnail: pickThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// Playlist bảng xếp hạng riêng của YouTube "Daily Top Music Videos - Hong Kong"
// — gần nhất với danh sách hit HK chính thức (YT Music không có bảng xếp hạng
// bài hát cho HK).
const HK_CHART_PLAYLIST = "VLPL4fGSI1pDJn6mlLn-G3Wy5IkOy0c6vAWp";

// Các hit hiện tại trên bảng xếp hạng Hồng Kông, cùng cấu trúc với kết quả
// searchYouTube(). Các mục là video âm nhạc (bảng xếp hạng theo dõi chúng);
// cách phát cũng giống nhau.
export async function fetchChartHits({ limit = 40, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data;
  try {
    const res = await fetch("https://music.youtube.com/youtubei/v1/browse?prettyPrint=false", {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        "Content-Type": "application/json",
        Origin: "https://music.youtube.com",
        Referer: "https://music.youtube.com/",
      },
      body: JSON.stringify({
        context: {
          client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: "en", gl: "HK" },
        },
        browseId: HK_CHART_PLAYLIST,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube Music phản hồi ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const sections =
    data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ||
    data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer
      ?.contents ||
    [];

  const results = [];
  for (const section of sections) {
    for (const item of section?.musicPlaylistShelfRenderer?.contents || []) {
      const r = item.musicResponsiveListItemRenderer;
      const videoId = r?.playlistItemData?.videoId;
      if (!videoId) continue;
      const cols = (r.flexColumns || []).map(
        (c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
      );
      results.push({
        videoId,
        title: cols[0]?.map((run) => run.text).join("") || "(không có tiêu đề)",
        channel: cols[1]?.[0]?.text || "Không rõ",
        duration:
          r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]
            ?.text || "",
        thumbnail: pickThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// Trả về { ok: true } nếu video tồn tại và công khai, hoặc
// { ok: false, reason } với ID đã xóa/riêng tư/không tồn tại.
export async function checkPlayable(videoId, { timeoutMs = 5000 } = {}) {
  const url =
    "https://www.youtube.com/oembed?url=" +
    encodeURIComponent("https://youtu.be/" + videoId) +
    "&format=json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, reason: "Video này đã tắt tính năng nhúng." };
    if (res.status === 404 || res.status === 400)
      return { ok: false, reason: "Video này ở chế độ riêng tư, đã bị xóa hoặc không tồn tại." };
    return { ok: false, reason: `Không thể phát video này (trạng thái ${res.status}).` };
  } catch (err) {
    // Lỗi mạng tạm thời — không chặn request; để trình phát host làm lớp dự phòng.
    return { ok: true, soft: true, note: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Lấy metadata phong phú hơn từ trang watch để cung cấp bối cảnh cho kiểm duyệt:
// category (Music hay không), cờ isFamilySafe của YouTube và mô tả.
// Trả về null khi có lỗi — bên gọi phải coi đây là dữ liệu cố gắng tối đa.
export async function fetchVideoDetails(videoId, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://www.youtube.com/watch?v=" + videoId, {
      headers: COMMON_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});(?:var|<\/script>)/s);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const vd = data.videoDetails || {};
    const mf = data.microformat?.playerMicroformatRenderer || {};
    return {
      author: vd.author || "",
      category: mf.category || "",
      isFamilySafe: mf.isFamilySafe,
      description: (vd.shortDescription || "").slice(0, 500),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
