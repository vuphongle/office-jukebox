(function attachJukeboxAuthUtils(global) {
  function validateRegistrationPassword(password, confirmation) {
    if (!confirmation) return "Vui lòng nhập lại mật khẩu.";
    if (password !== confirmation) return "Mật khẩu xác nhận chưa khớp.";
    return "";
  }

  function validateDisplayName(displayName) {
    const cleanDisplayName = typeof displayName === "string" ? displayName.trim() : "";
    if (!cleanDisplayName) return "Vui lòng nhập tên hiển thị.";
    if (cleanDisplayName.length > 40) return "Tên hiển thị tối đa 40 ký tự.";
    return "";
  }

  function validatePasswordChange(currentPassword, newPassword, confirmation) {
    const errors = {};
    if (!currentPassword) errors.currentPassword = "Vui lòng nhập mật khẩu hiện tại.";
    if (!newPassword) errors.newPassword = "Vui lòng nhập mật khẩu mới.";
    else if (newPassword.length < 6) errors.newPassword = "Mật khẩu mới phải có tối thiểu 6 ký tự.";
    else if (newPassword === currentPassword) errors.newPassword = "Mật khẩu mới phải khác mật khẩu hiện tại.";
    if (!confirmation) errors.confirmation = "Vui lòng nhập lại mật khẩu mới.";
    else if (newPassword !== confirmation) errors.confirmation = "Mật khẩu xác nhận chưa khớp.";
    return errors;
  }

  global.JukeboxAuth = Object.freeze({
    validateRegistrationPassword,
    validateDisplayName,
    validatePasswordChange,
  });
})(globalThis);
