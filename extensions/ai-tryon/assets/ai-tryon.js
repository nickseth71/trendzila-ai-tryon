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
    const variantId = root.dataset.variantId;
    const initialAvailable = root.dataset.available === "true";
    const productHandle = root.dataset.productHandle;

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
      download: root.querySelector("[data-tryon-download]"),
      shareBtn: root.querySelector("[data-tryon-share]"),
    };

    const state = {
      step: "intro",
      uploadData: "",
      sampleImageUrl: "",
      resultImages: {},
      angleStatus: {},
      activeAngle: "front",
      variantId: variantId || null,
      available: variantId ? initialAvailable : false,
      addingToCart: false,
    };

    // Availability lookup for every variant, keyed by variant id. Loaded
    // once in the background; used so we can tell whether whatever variant
    // the shopper currently has selected is actually in stock.
    let variantsById = null;
    if (productHandle) {
      fetch(`/products/${productHandle}.js`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data || !Array.isArray(data.variants)) return;
          variantsById = {};
          data.variants.forEach((v) => {
            variantsById[String(v.id)] = v;
          });
          if (state.step === "result") {
            syncSelectedVariant();
            updatePrimaryState();
          }
        })
        .catch(() => {});
    }

    // Reads the variant the shopper currently has selected directly from
    // the page's own add-to-cart form — the same source of truth the theme
    // itself uses — rather than relying on the value at page load or on a
    // theme-specific "variant changed" event that may never fire.
    function getSelectedVariantIdFromPage() {
      const field = document.querySelector(
        'form[action*="/cart/add"] [name="id"]',
      );
      return field && field.value ? String(field.value) : null;
    }

    // Refreshes state.variantId/state.available from whatever is currently
    // selected on the page. Call this right before anything that depends
    // on knowing the exact variant (opening the sheet, showing the Add to
    // Cart button, actually adding to cart).
    function syncSelectedVariant() {
      const id = getSelectedVariantIdFromPage() || state.variantId;
      if (!id) {
        state.variantId = null;
        state.available = false;
        return;
      }
      state.variantId = id;
      if (variantsById && variantsById[id]) {
        state.available = !!variantsById[id].available;
      } else if (id === variantId) {
        // Haven't loaded the variants map yet (or it failed) — fall back
        // to the value rendered at page load for the original variant.
        state.available = initialAvailable;
      } else {
        // A different variant than the one rendered server-side, and we
        // don't have fresh availability data for it yet — assume it's
        // orderable; /cart/add.js is the final authority and will reject
        // it with a clear error if it's actually out of stock.
        state.available = true;
      }
    }

    els.cta.addEventListener("click", openSheet);
    els.overlay.addEventListener("click", closeSheet);
    els.close.addEventListener("click", closeSheet);
    els.uploadBox.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", handleFileChange);
    els.sampleBtn.addEventListener("click", useSamplePhoto);
    els.primary.addEventListener("click", handlePrimary);
    els.shareBtn.addEventListener("click", handleShare);
    els.download.addEventListener("click", handleDownload);
    els.angleTabs.querySelectorAll("[data-angle]").forEach((btn) => {
      btn.addEventListener("click", () => setActiveAngle(btn.dataset.angle));
    });

    function openSheet() {
      state.step = "intro";
      showError("");
      syncSelectedVariant();
      els.overlay.hidden = false;
      els.sheet.classList.add("open");
      els.sheet.setAttribute("aria-hidden", "false");
      lockBodyScroll();
      render();
    }

    function closeSheet() {
      els.overlay.hidden = true;
      els.sheet.classList.remove("open");
      els.sheet.setAttribute("aria-hidden", "true");
      unlockBodyScroll();
    }

    let bodyScrollLockCount = 0;
    let savedBodyOverflow = "";

    function lockBodyScroll() {
      if (bodyScrollLockCount === 0) {
        savedBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
      }
      bodyScrollLockCount += 1;
    }

    function unlockBodyScroll() {
      bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
      if (bodyScrollLockCount === 0) {
        document.body.style.overflow = savedBodyOverflow;
      }
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
      showResultError("");
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
      els.demoNote.hidden = !message;
      els.demoNote.textContent = message || "";
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
        addCurrentProductToCart();
      }
    }

    async function addCurrentProductToCart() {
      syncSelectedVariant();
      if (!state.available || !state.variantId || state.addingToCart) return;

      state.addingToCart = true;
      showResultError("");
      updatePrimaryState();

      try {
        const response = await fetch("/cart/add.js", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            items: [{ id: state.variantId, quantity: 1 }],
          }),
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            (payload && payload.description) ||
              "Could not add this item to your cart.",
          );
        }

        // Let the theme's own cart drawer/count refresh itself if it's
        // listening for this; if nothing is, the reload below still
        // leaves the cart correctly updated.
        root.dispatchEvent(
          new CustomEvent("tryon:add-to-cart", {
            bubbles: true,
            detail: { productId, productTitle, variantId: state.variantId },
          }),
        );

        closeSheet();
        window.setTimeout(() => window.location.reload(), 200);
      } catch (err) {
        state.addingToCart = false;
        updatePrimaryState();
        showResultError(
          err.message ||
            "Could not add this item to your cart. Please try again.",
        );
      }
    }

    function handleDownload() {
      const imageUrl = state.resultImages[state.activeAngle];
      if (!imageUrl) return;
      const safeTitle = (productTitle || "try-on")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const link = document.createElement("a");
      link.href = imageUrl;
      link.download = `${safeTitle}-${state.activeAngle}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
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
        els.download.hidden = false;
      } else {
        els.resultImg.hidden = true;
        els.angleLoading.hidden = false;
        els.download.hidden = true;
        els.angleLoadingLabel.textContent = `${ANGLE_LABELS[state.activeAngle]} view is generating`;
      }
    }

    function updatePrimaryState() {
      if (state.step === "result") syncSelectedVariant();
      const outOfStock = state.step === "result" && !state.available;

      els.primary.disabled =
        state.step === "processing" ||
        (state.step === "upload" && !state.uploadData) ||
        outOfStock ||
        state.addingToCart;

      els.primary.classList.toggle("tryon-primary--out-of-stock", outOfStock);

      const labels = {
        intro: "Start Try On",
        upload: state.uploadData ? "Generate Look" : "Upload Photo",
        processing: "Generating...",
        result: outOfStock
          ? "Out of Stock"
          : state.addingToCart
            ? "Adding..."
            : "Add to Cart",
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
