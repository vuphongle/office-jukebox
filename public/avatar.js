(function avatarUtilities(global) {
  const avatarPattern = /^\/avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;

  function safeUrl(value) {
    return typeof value === "string" && avatarPattern.test(value) ? value : "";
  }

  function initial(name) {
    return String(name || "U").trim().charAt(0).toUpperCase() || "U";
  }

  function apply(element, { avatarUrl = "", name = "", fallback = true, alt = "" } = {}) {
    if (!element) return;
    const requestId = (element.__jukeboxAvatarRequestId || 0) + 1;
    element.__jukeboxAvatarRequestId = requestId;
    element.replaceChildren();
    element.hidden = false;
    const fallbackText = initial(name);
    const url = safeUrl(avatarUrl);
    if (!url) {
      if (fallback) element.textContent = fallbackText;
      else element.hidden = true;
      return;
    }
    const image = element.ownerDocument.createElement("img");
    image.src = url;
    image.alt = alt;
    image.loading = "lazy";
    image.onerror = () => {
      if (element.__jukeboxAvatarRequestId !== requestId) return;
      image.remove();
      if (fallback) element.textContent = fallbackText;
      else element.hidden = true;
    };
    element.append(image);
  }

  global.JukeboxAvatars = { safeUrl, initial, apply };
})(typeof window !== "undefined" ? window : globalThis);
