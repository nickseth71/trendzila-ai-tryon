(function () {
  "use strict";

  const ANGLES = ["front", "side", "back"];
  const ANGLE_LABELS = { front: "Front", side: "Side", back: "Back" };

  document.querySelectorAll(".tryon-root").forEach(initTryOnWidget);

  function initTryOnWidget(root) {
    const productId = root.dataset.productId;
    const productTitle = root.dataset.productTitle || "";
    const shop = root.dataset.shop;
    const endpoint = root.dataset.tryonEndpoint;
    const samplePhotoUrl = root.dataset.samplePhotoUrl;

    const els = {
      cta: root.querySelector("[data-tryon-open]"),
      overlay: root.querySelector("[data-tryon-overlay]"),
      sheet: root.querySelector("[data-tryon-sheet]"),
      close: root.querySelector("[data-tryon-close]"),
      primary: root.querySelector("[data-tryon-primary]"),
      steps: {
        intro: root.querySelector('[data-step="intro"]'),
        upload: root.querySelector('[data-step="upload"]'),
        processing: root.querySelector('[data-step="processing"]'),
        result: root.querySelector('[data-step="result"]'),
      },
      uploadBox: root.querySelector("[data-tryon-upload-box]"),
      uploadPreview: root.querySelector("[data-tryon-upload-preview]"),
      uploadPlaceholder: root.querySelector("[data-tryon-upload-placeholder]"),
      fileInput: root.querySelector("[data-tryon-file-input]"),
      error: root.querySelector("[data-tryon-error]"),
      sampleBtn: root.querySelector("[data-tryon-sample]"),
      demoNote: root.querySelector("[data-tryon-demo-note]"),
      angleTabs: root.querySelector("[data-tryon-angle-tabs]"),
      resultImage: root.querySelector("[data-tryon-result-image]"),
      resultImg: root.querySelector("[data-tryon-result-img]"),
      angleLoading: root.querySelector("[data-tryon-angle-loading]"),
      angleLoadingLabel: root.querySelector("[data-tryon-angle-loading-label]"),
      shareBtn: root.querySelector("[data-tryon-share]"),
    };

    const state = {
      step: "intro",
      uploadData: "",
      sampleImageUrl: "",
      resultImages: {},
      angleStatus: {},
      activeAngle: "front",
    };

    els.cta.addEventListener("click", openSheet);
    els.overlay.addEventListener("click", closeSheet);
    els.close.addEventListener("click", closeSheet);
    els.uploadBox.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", handleFileChange);
    els.sampleBtn.addEventListener("click", useSamplePhoto);
    els.primary.addEventListener("click", handlePrimary);
    els.shareBtn.addEventListener("click", handleShare);
    els.angleTabs.querySelectorAll("[data-angle]").forEach((btn) => {
      btn.addEventListener("click", () => setActiveAngle(btn.dataset.angle));
    });

    function openSheet() {
      state.step = "intro";
      showError("");
      els.overlay.hidden = false;
      els.sheet.classList.add("open");
      els.sheet.setAttribute("aria-hidden", "false");
      render();
    }

    function closeSheet() {
      els.overlay.hidden = true;
      els.sheet.classList.remove("open");
      els.sheet.setAttribute("aria-hidden", "true");
    }

    function showError(message) {
      if (!message) {
        els.error.hidden = true;
        els.error.textContent = "";
        return;
      }
      els.error.hidden = false;
      els.error.textContent = message;
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function compressImage(dataUrl, maxSide, quality) {
      maxSide = maxSide || 1500;
      quality = quality || 0.86;
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const width = Math.round(img.width * scale);
          const height = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = dataUrl;
      });
    }

    async function handleFileChange(event) {
      const file = event.target.files && event.target.files[0];
      showError("");
      if (!file) return;

      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        showError("Upload a JPG, PNG, or WEBP image.");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        showError("Image is too large. Upload an image under 10 MB.");
        return;
      }

      const dataUrl = await fileToDataUrl(file);
      const compressed = await compressImage(dataUrl);
      els.uploadPreview.src = dataUrl;
      els.uploadPreview.hidden = false;
      els.uploadPlaceholder.hidden = true;
      state.uploadData = compressed;
      state.sampleImageUrl = "";
      updatePrimaryState();
    }

    function useSamplePhoto() {
      showError("");
      els.uploadPreview.src = samplePhotoUrl;
      els.uploadPreview.hidden = false;
      els.uploadPlaceholder.hidden = true;
      state.uploadData = "sample";
      state.sampleImageUrl = samplePhotoUrl;
      updatePrimaryState();
    }

    async function generateAngle(angle) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          Object.assign(
            { angle, productId, shop },
            state.sampleImageUrl
              ? { sampleImageUrl: state.sampleImageUrl }
              : { imageDataUrl: state.uploadData },
          ),
        ),
      });
      const payload = await response.json();
      if (!response.ok || !payload.imageUrl) {
        throw new Error(payload.message || "Generation failed");
      }
      return payload.imageUrl;
    }

    async function generateBackgroundAngle(angle) {
      state.angleStatus[angle] = "loading";
      renderAngleTabs();
      try {
        const imageUrl = await generateAngle(angle);
        state.resultImages[angle] = imageUrl;
        state.angleStatus[angle] = "ready";
      } catch (err) {
        state.angleStatus[angle] = "failed";
      }
      renderAngleTabs();
      if (state.activeAngle === angle) renderResultImage();
    }

    async function generateTryOn() {
      if (!state.uploadData) {
        els.fileInput.click();
        return;
      }

      state.step = "processing";
      showError("");
      state.activeAngle = "front";
      state.resultImages = {};
      state.angleStatus = { front: "loading", side: "queued", back: "queued" };
      render();

      try {
        const frontImageUrl = await generateAngle("front");
        state.resultImages = { front: frontImageUrl };
        state.angleStatus = { front: "ready", side: "loading", back: "queued" };
        state.step = "result";
        render();
        generateBackgroundAngle("side");
        window.setTimeout(() => generateBackgroundAngle("back"), 1200);
      } catch (err) {
        state.step = "result";
        state.resultImages = {};
        state.angleStatus = { front: "failed", side: "failed", back: "failed" };
        showResultError(
          err.message ||
            "We could not generate this try-on. Please try another photo.",
        );
        render();
      }
    }

    function showResultError(message) {
      els.demoNote.hidden = false;
      els.demoNote.textContent = message;
    }

    function handlePrimary() {
      if (state.step === "intro") {
        state.step = "upload";
        render();
        return;
      }
      if (state.step === "upload") {
        generateTryOn();
        return;
      }
      if (state.step === "result") {
        closeSheet();
        window.setTimeout(() => {
          const event = new CustomEvent("tryon:add-to-cart", {
            detail: { productId, productTitle },
          });
          root.dispatchEvent(event);
        }, 250);
      }
    }

    async function handleShare() {
      const resultImage = state.resultImages[state.activeAngle];
      if (!resultImage) return;
      const url = resultImage.startsWith("http")
        ? resultImage
        : window.location.href;
      if (navigator.share) {
        await navigator.share({
          title: "My AI Try On",
          text: `Try-on result for ${productTitle}.`,
          url,
        });
        return;
      }
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        window.alert("Result link copied.");
      }
    }

    function setActiveAngle(angle) {
      state.activeAngle = angle;
      renderAngleTabs();
      renderResultImage();
    }

    function renderAngleTabs() {
      els.angleTabs.querySelectorAll("[data-angle]").forEach((btn) => {
        const angle = btn.dataset.angle;
        btn.classList.toggle("active", angle === state.activeAngle);
        btn.querySelectorAll("span").forEach((s) => s.remove());
        const status = state.angleStatus[angle];
        if (status === "loading") appendTag(btn, "Generating");
        if (status === "queued") appendTag(btn, "Queued");
        if (status === "failed") appendTag(btn, "Retry later");
      });
    }

    function appendTag(btn, text) {
      const span = document.createElement("span");
      span.textContent = text;
      btn.appendChild(span);
    }

    function renderResultImage() {
      const imageUrl = state.resultImages[state.activeAngle];
      if (imageUrl) {
        els.resultImg.src = imageUrl;
        els.resultImg.hidden = false;
        els.angleLoading.hidden = true;
      } else {
        els.resultImg.hidden = true;
        els.angleLoading.hidden = false;
        els.angleLoadingLabel.textContent = `${ANGLE_LABELS[state.activeAngle]} view is generating`;
      }
    }

    function updatePrimaryState() {
      els.primary.disabled =
        state.step === "processing" ||
        (state.step === "upload" && !state.uploadData);
      const labels = {
        intro: "Start Try On",
        upload: state.uploadData ? "Generate Look" : "Upload Photo",
        processing: "Generating...",
        result: "Add to Cart",
      };
      els.primary.textContent = labels[state.step] || "Try Again";
    }

    function render() {
      Object.keys(els.steps).forEach((key) => {
        els.steps[key].hidden = key !== state.step;
      });
      if (state.step === "result") {
        renderAngleTabs();
        renderResultImage();
      }
      updatePrimaryState();
    }

    render();
  }
})();
