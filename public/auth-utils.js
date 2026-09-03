(function attachJukeboxAuthUtils(global) {
  const MAX_PASSWORD_LENGTH = 256;

  function validateRegistrationPassword(password, confirmation) {
    if (typeof password !== "string") return "Vui lòng nhập mật khẩu.";
    if (password.length > MAX_PASSWORD_LENGTH) return "Mật khẩu tối đa 256 ký tự.";
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
    else if (typeof newPassword !== "string" || newPassword.length < 6 || newPassword.length > MAX_PASSWORD_LENGTH) {
      errors.newPassword = "Mật khẩu mới phải từ 6 đến 256 ký tự.";
    }
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
