(function avatarCropUtilities(global) {
  function geometry({ imageWidth, imageHeight, frameSize, zoom = 1, offsetX = 0, offsetY = 0 }) {
    const width = Number(imageWidth);
    const height = Number(imageHeight);
    const frame = Number(frameSize);
    if (!(width > 0) || !(height > 0) || !(frame > 0)) {
      throw new Error("Kích thước ảnh crop không hợp lệ.");
    }

    const boundedZoom = Math.min(3, Math.max(1, Number(zoom) || 1));
    const scale = Math.max(frame / width, frame / height) * boundedZoom;
    const renderedWidth = width * scale;
    const renderedHeight = height * scale;
    const maxOffsetX = Math.max(0, (renderedWidth - frame) / 2);
    const maxOffsetY = Math.max(0, (renderedHeight - frame) / 2);
    const clampedOffsetX = Math.min(maxOffsetX, Math.max(-maxOffsetX, Number(offsetX) || 0));
    const clampedOffsetY = Math.min(maxOffsetY, Math.max(-maxOffsetY, Number(offsetY) || 0));

    return {
      scale,
      renderedWidth,
      renderedHeight,
      offsetX: clampedOffsetX,
      offsetY: clampedOffsetY,
      left: (frame - renderedWidth) / 2 + clampedOffsetX,
      top: (frame - renderedHeight) / 2 + clampedOffsetY,
    };
  }

  function drawToCanvas(canvas, image, crop, frameSize, outputSize = 512) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Trình duyệt không hỗ trợ xử lý ảnh.");
    const ratio = outputSize / frameSize;
    canvas.width = outputSize;
    canvas.height = outputSize;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      crop.left * ratio,
      crop.top * ratio,
      crop.renderedWidth * ratio,
      crop.renderedHeight * ratio
    );
  }

  global.JukeboxAvatarCrop = { geometry, drawToCanvas };
})(typeof window !== "undefined" ? window : globalThis);
