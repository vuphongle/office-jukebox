(() => {
  const content = document.getElementById("rules-content");
  const status = document.getElementById("rules-status");
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  const points = (value) => `+${Number(value || 0)} điểm`;

  function render(rules) {
    const streak = rules.streak || {};
    const ranks = rules.ranks || {};
    const tierItems = (streak.tiers || []).map((tier) => `
      <div class="rule-item"><strong>${tier.minStreak}+ ngày</strong><span>${tier.bonusPoints ? `${points(tier.bonusPoints)} mỗi lần điểm danh` : "Chưa có bonus tier"}</span></div>
    `).join("");
    const legacyRows = (streak.legacyMilestones || []).map((item) => `<tr><td>${item.day} ngày</td><td>Mốc streak lặp theo chu kỳ 30 ngày</td><td>${points(item.points)}</td></tr>`).join("");
    const personalRows = (streak.personalRewards || []).map((item) => `<tr><td>Streak ${item.day} ngày</td><td>Mỗi tài khoản một lần</td><td>${points(item.points)}</td></tr>`).join("");
    const rankRows = (ranks.personalRewards || []).map((item) => `<tr><td>Hạng ${item.level} · ${escapeHtml(item.name)}</td><td>Mỗi tài khoản một lần</td><td>${points(item.points)}</td></tr>`).join("");
    const podiumRows = [...(streak.podiumRewards || []).map((item) => ({ ...item, label: `Streak ${item.day} ngày` })), ...(ranks.podiumRewards || []).map((item) => ({ ...item, label: `Hạng ${item.level} · ${escapeHtml(item.name)}` }))]
      .map((item) => `<tr><td>${item.label}</td><td>${(item.places || []).map((place) => `Top ${place.place}: ${points(place.points)}`).join(" · ")}</td><td>Theo sự kiện</td></tr>`).join("");

    content.innerHTML = `
      <section class="rules-card"><h2>Điểm danh hằng ngày</h2><p>Điểm cơ bản phụ thuộc hạng hiện tại. Bonus tier chỉ lấy tier cao nhất, không cộng dồn; mốc 3/7/14/30 vẫn cộng thêm.</p><div class="rules-grid">${tierItems}</div></section>
      <section class="rules-card"><h2>Mốc streak lặp</h2><table><thead><tr><th>Mốc</th><th>Quy tắc</th><th>Thưởng</th></tr></thead><tbody>${legacyRows}</tbody></table></section>
      <section class="rules-card"><h2>Thưởng cá nhân</h2><table><thead><tr><th>Mốc</th><th>Phạm vi</th><th>Thưởng</th></tr></thead><tbody>${personalRows}${rankRows}</tbody></table></section>
      <section class="rules-card"><h2>Thưởng top 1 / top 2</h2><p>Thứ tự được ghi nhận tại thời điểm thành viên đầu tiên chạm mốc trong sự kiện hiện tại.</p><table><thead><tr><th>Mốc</th><th>Chi tiết</th><th>Phạm vi</th></tr></thead><tbody>${podiumRows}</tbody></table></section>
      <section class="rules-card"><h2>Quà tặng Claimable Drop</h2><p>Admin có thể tạo thời hạn 1, 4, 8 hoặc 24 giờ; mặc định là ${rules.claimableDrop?.defaultDurationHours || 8} giờ. Đợt cũ bị thay thế hoặc admin hủy sẽ không nhận thêm được.</p></section>
      <section class="rules-card"><h2>Thông báo</h2><p>Hệ thống gửi inbox ở các sự kiện quan trọng như mốc streak, lên hạng, thưởng top, airdrop trực tiếp và hoàn điểm vote. Thông báo group chúc mừng có thể được admin bật/tắt; việc tắt thông báo không làm mất điểm.</p></section>
    `;
  }

  fetch("/api/engagement/rules")
    .then((response) => response.json().then((data) => ({ response, data })))
    .then(({ response, data }) => {
      if (!response.ok || !data.ok) throw new Error(data.reason || "Không thể tải quy định.");
      render(data.rules);
      status.textContent = "Quy định hiện hành";
    })
    .catch((error) => {
      status.textContent = error.message || "Không thể tải quy định.";
      status.classList.add("error");
      content.innerHTML = "<section class=\"rules-card\"><p>Vui lòng tải lại trang sau ít phút.</p></section>";
    });
})();
