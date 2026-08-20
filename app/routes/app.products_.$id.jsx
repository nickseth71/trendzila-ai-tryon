// Product detail: /app/products/:id
// Lets the merchant upload three reference images (front/back/side) for a
// single product. On save, each image is uploaded to Shopify Files (via
// the staged-upload flow the Admin API requires for file uploads) and then
// written onto the product as a file_reference metafield. The metafield
// definitions (tryon.front_image / tryon.back_image / tryon.side_image)
// are created automatically the first time this runs, so there's no
// separate setup step for the merchant or developer.

import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

// Media types the file picker should offer — reference photos are always images.
const PICKER_DATA = { mediaTypes: ["MediaImage"] };

const METAFIELD_NAMESPACE = "tryon";

const IMAGE_FIELDS = [
  { key: "front_image", formField: "front", label: "Front image" },
  { key: "back_image", formField: "back", label: "Back image" },
  { key: "side_image", formField: "side", label: "Side image" },
];

function toProductGid(id) {
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

export async function loader({ request, params }) {
  const { admin } = await authenticate.admin(request);
  const productGid = toProductGid(params.id);

  const response = await admin.graphql(
    `#graphql
    query ProductDetail($id: ID!) {
      product(id: $id) {
        id
        title
        front: metafield(namespace: "tryon", key: "front_image") {
          reference { ... on MediaImage { image { url } } }
        }
        back: metafield(namespace: "tryon", key: "back_image") {
          reference { ... on MediaImage { image { url } } }
        }
        side: metafield(namespace: "tryon", key: "side_image") {
          reference { ... on MediaImage { image { url } } }
        }
      }
    }`,
    { variables: { id: productGid } },
  );

  const { data } = await response.json();

  if (!data?.product) {
    throw new Response("Product not found", { status: 404 });
  }

  return {
    product: { id: data.product.id, title: data.product.title },
    existingImages: {
      front: data.product.front?.reference?.image?.url || null,
      back: data.product.back?.reference?.image?.url || null,
      side: data.product.side?.reference?.image?.url || null,
    },
  };
}

// Registers the three file_reference metafield definitions if they don't
// already exist. Safe to call on every save — an existing definition just
// comes back as a "TAKEN" userError, which isn't treated as a failure.
async function ensureMetafieldDefinitions(admin) {
  for (const field of IMAGE_FIELDS) {
    const response = await admin.graphql(
      `#graphql
      mutation EnsureTryOnMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { code message }
        }
      }`,
      {
        variables: {
          definition: {
            name: field.label,
            namespace: METAFIELD_NAMESPACE,
            key: field.key,
            type: "file_reference",
            ownerType: "PRODUCT",
            access: { storefront: "PUBLIC_READ" },
          },
        },
      },
    );
    const { data } = await response.json();
    const errors = data?.metafieldDefinitionCreate?.userErrors || [];
    const blocking = errors.filter((e) => e.code !== "TAKEN");
    if (blocking.length) {
      throw new Error(blocking.map((e) => e.message).join(", "));
    }
  }
}

// Shopify's Admin API requires a 3-step upload for files:
// 1. stagedUploadsCreate — get a short-lived signed upload URL
// 2. POST the raw bytes to that URL (Google Cloud Storage, not Shopify)
// 3. fileCreate — tell Shopify to turn the uploaded blob into a real File/MediaImage
async function uploadImageFile(admin, file) {
  const stagedResponse = await admin.graphql(
    `#graphql
    mutation StagedUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [
          {
            filename: file.name || "reference-image.jpg",
            mimeType: file.type || "image/jpeg",
            httpMethod: "POST",
            resource: "IMAGE",
            fileSize: String(file.size),
          },
        ],
      },
    },
  );

  const stagedJson = await stagedResponse.json();
  const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const stagedErrors = stagedJson.data?.stagedUploadsCreate?.userErrors || [];
  if (!target || stagedErrors.length) {
    throw new Error(
      stagedErrors.map((e) => e.message).join(", ") ||
        "Could not start the image upload.",
    );
  }

  // Parameters must be appended before the file field, in the order Shopify sent them.
  const uploadForm = new FormData();
  for (const param of target.parameters) {
    uploadForm.append(param.name, param.value);
  }
  uploadForm.append("file", file);

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: uploadForm,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Image upload failed (${uploadResponse.status}).`);
  }

  const fileCreateResponse = await admin.graphql(
    `#graphql
    mutation CreateFile($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        files: [
          {
            originalSource: target.resourceUrl,
            contentType: "IMAGE",
            alt: file.name,
          },
        ],
      },
    },
  );

  const fileJson = await fileCreateResponse.json();
  const created = fileJson.data?.fileCreate?.files?.[0];
  const fileErrors = fileJson.data?.fileCreate?.userErrors || [];
  if (!created || fileErrors.length) {
    throw new Error(
      fileErrors.map((e) => e.message).join(", ") ||
        "Could not save the uploaded image.",
    );
  }

  // created.id is the MediaImage GID — that's what a file_reference metafield stores.
  // The image may still be PROCESSING at this point; that's fine, the reference is valid either way.
  return created.id;
}

export async function action({ request, params }) {
  const { admin } = await authenticate.admin(request);
  const productGid = toProductGid(params.id);

  const formData = await request.formData();

  const uploads = [];
  const picked = [];
  for (const field of IMAGE_FIELDS) {
    const file = formData.get(field.formField);
    if (file && typeof file === "object" && "size" in file && file.size > 0) {
      uploads.push({ field, file });
      continue;
    }
    // Imported via the "Import from Shopify" picker — already a real
    // File/MediaImage on this store, so it just needs writing to the
    // metafield directly, no staged upload required.
    const pickedFileId = formData.get(`${field.formField}_file_id`);
    if (pickedFileId) {
      picked.push({ field, fileGid: String(pickedFileId) });
    }
  }

  if (uploads.length === 0 && picked.length === 0) {
    return { error: "Choose at least one image before saving." };
  }

  try {
    await ensureMetafieldDefinitions(admin);

    const metafieldsInput = [];
    for (const { field, file } of uploads) {
      const fileGid = await uploadImageFile(admin, file);
      metafieldsInput.push({
        ownerId: productGid,
        namespace: METAFIELD_NAMESPACE,
        key: field.key,
        type: "file_reference",
        value: fileGid,
      });
    }
    for (const { field, fileGid } of picked) {
      metafieldsInput.push({
        ownerId: productGid,
        namespace: METAFIELD_NAMESPACE,
        key: field.key,
        type: "file_reference",
        value: fileGid,
      });
    }

    const setResponse = await admin.graphql(
      `#graphql
      mutation SetTryOnImages($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key }
          userErrors { field message }
        }
      }`,
      { variables: { metafields: metafieldsInput } },
    );

    const setJson = await setResponse.json();
    const setErrors = setJson.data?.metafieldsSet?.userErrors || [];
    if (setErrors.length) {
      return { error: setErrors.map((e) => e.message).join(", ") };
    }

    return {
      success: true,
      savedFields: [...uploads, ...picked].map((u) => u.field.formField),
    };
  } catch (error) {
    return {
      error: error.message || "Something went wrong while saving the images.",
    };
  }
}

export default function ProductDetail() {
  const { product, existingImages } = useLoaderData();
  const fetcher = useFetcher();
  const previewFetcher = useFetcher();
  const navigation = useNavigation();

  const [previews, setPreviews] = useState({
    front: null,
    back: null,
    side: null,
  });

  // Files picked from Shopify's existing library via the Intents API,
  // keyed by field: { id: "gid://shopify/MediaImage/...", url: "..." }
  const [pickedFiles, setPickedFiles] = useState({
    front: null,
    back: null,
    side: null,
  });

  const [importingField, setImportingField] = useState(null);
  const pendingPreviewField = useRef(null);

  // The image currently shown in the "view full size" modal.
  const [viewingImage, setViewingImage] = useState(null);
  const viewModalRef = useRef(null);

  // Revoke object URLs on unmount so they don't leak.
  useEffect(() => {
    return () => {
      Object.values(previews).forEach((url) => url && URL.revokeObjectURL(url));
    };
  }, [previews]);

  // Which field is currently being dragged over, for the dropzone highlight.
  const [dragOverField, setDragOverField] = useState(null);

  function applyFile(fieldKey, file) {
    if (!file) return;
    setPreviews((current) => ({
      ...current,
      [fieldKey]: URL.createObjectURL(file),
    }));
    // A manual upload replaces any previously-imported file for this slot.
    setPickedFiles((current) => ({ ...current, [fieldKey]: null }));
  }

  function handleFileChange(fieldKey, event) {
    applyFile(fieldKey, event.target.files?.[0]);
  }

  function handleDrop(fieldKey, event) {
    event.preventDefault();
    setDragOverField(null);
    applyFile(fieldKey, event.dataTransfer.files?.[0]);
  }

  async function handleImport(fieldKey) {
    if (typeof window === "undefined" || !window.shopify?.intents) return;
    setImportingField(fieldKey);
    try {
      const activity = await window.shopify.intents.invoke(
        "pick:shopify/File",
        {
          data: PICKER_DATA,
          productId: product.id,
        },
      );
      const response = await activity.complete;
      if (response.code !== "ok") return;

      const fileId = response.data?.ids?.[0];
      if (!fileId) return;

      // A picked file replaces any pending manual upload for this slot.
      setPreviews((current) => {
        if (current[fieldKey]) URL.revokeObjectURL(current[fieldKey]);
        return { ...current, [fieldKey]: null };
      });
      setPickedFiles((current) => ({
        ...current,
        [fieldKey]: { id: fileId, url: null },
      }));

      // Stash which field this lookup is for so the response can be routed
      // back to the right slot once it resolves.
      pendingPreviewField.current = fieldKey;
      previewFetcher.load(
        `/app/api/file-preview?ids=${encodeURIComponent(fileId)}`,
      );
    } finally {
      setImportingField(null);
    }
  }

  // Route the resolved preview URL back to whichever field triggered it.
  useEffect(() => {
    if (previewFetcher.state !== "idle" || !previewFetcher.data) return;
    const fieldKey = pendingPreviewField.current;
    if (!fieldKey) return;
    const image = previewFetcher.data.images || {};
    setPickedFiles((current) => {
      const entry = current[fieldKey];
      if (!entry) return current;
      const url = image[entry.id];
      if (!url || entry.url === url) return current;
      return { ...current, [fieldKey]: { ...entry, url } };
    });
  }, [previewFetcher.state, previewFetcher.data]);

  function openViewModal(url, label) {
    setViewingImage({ url, label });
  }

  function closeViewModal() {
    setViewingImage(null);
  }

  const isSaving = fetcher.state !== "idle";
  const result = fetcher.data;

  return (
    <s-page heading={product.title}>
      <s-section>
        <s-link href="/app/products">← Back to products</s-link>
      </s-section>

      <s-section heading="AI try-on reference images">
        <s-paragraph>
          Upload a front, back, and side reference photo of this product. Saving
          writes each image to this product's{" "}
          <s-text tone="subdued">tryon.*</s-text> metafields — those metafield
          definitions are created automatically the first time you save, so
          there's nothing to set up beforehand.
        </s-paragraph>

        {result?.error && (
          <s-banner tone="critical" heading="Couldn't save images">
            <s-paragraph>{result.error}</s-paragraph>
          </s-banner>
        )}
        {result?.success && (
          <s-banner tone="success" heading="Saved">
            <s-paragraph>Reference images updated.</s-paragraph>
          </s-banner>
        )}

        <fetcher.Form method="post" encType="multipart/form-data">
          <s-stack direction="block" gap="base">
            {IMAGE_FIELDS.map(({ formField, label }) => {
              const picked = pickedFiles[formField];
              const previewUrl =
                previews[formField] || picked?.url || existingImages[formField];

              return (
                <s-box
                  key={formField}
                  border="base"
                  borderRadius="base"
                  padding="base"
                >
                  <s-stack direction="inline" gap="base" alignItems="start">
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      <s-box
                        border="base"
                        borderRadius="base"
                        overflow="hidden"
                        inlineSize="72px"
                        blockSize="72px"
                      >
                        {previewUrl ? (
                          <s-image
                            objectFit="cover"
                            alt={`${label} preview`}
                            src={previewUrl}
                          />
                        ) : picked ? (
                          <s-spinner accessibilityLabel="Loading preview" />
                        ) : null}
                      </s-box>
                      {previewUrl && (
                        <button
                          type="button"
                          command="--show"
                          commandFor="view-image-modal"
                          onClick={() => openViewModal(previewUrl, label)}
                          aria-label={`View ${label} full size`}
                          style={{
                            position: "absolute",
                            top: "4px",
                            right: "4px",
                            width: "22px",
                            height: "22px",
                            borderRadius: "50%",
                            border: "none",
                            background: "rgba(0,0,0,0.55)",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                      )}
                    </div>

                    <s-stack direction="block" gap="small-200">
                      <s-text>{label}</s-text>
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="stretch"
                      >
                        <label
                          htmlFor={`${formField}-file-input`}
                          onDragOver={(event) => {
                            event.preventDefault();
                            setDragOverField(formField);
                          }}
                          onDragLeave={() => setDragOverField(null)}
                          onDrop={(event) => handleDrop(formField, event)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            cursor: "pointer",
                            border: `1px dashed ${
                              dragOverField === formField
                                ? "#005bd3"
                                : "#8a8a8a"
                            }`,
                            borderRadius: "8px",
                            padding: "10px 14px",
                            background:
                              dragOverField === formField
                                ? "#eaf2ff"
                                : "transparent",
                          }}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M12 3v12" />
                            <path d="M7 8l5-5 5 5" />
                            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                          </svg>
                          <s-text>Choose file or drag and drop</s-text>
                          <input
                            id={`${formField}-file-input`}
                            type="file"
                            name={formField}
                            accept="image/png,image/jpeg,image/webp"
                            onChange={(event) =>
                              handleFileChange(formField, event)
                            }
                            style={{ display: "none" }}
                          />
                        </label>

                        <s-button
                          type="button"
                          variant="secondary"
                          loading={importingField === formField}
                          onClick={() => handleImport(formField)}
                        >
                          Import from Shopify
                        </s-button>
                      </s-stack>
                      {picked && (
                        <input
                          type="hidden"
                          name={`${formField}_file_id`}
                          value={picked.id}
                        />
                      )}
                    </s-stack>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>

          <s-box paddingBlockStart="base">
            <s-button variant="primary" type="submit" loading={isSaving}>
              Done
            </s-button>
          </s-box>
        </fetcher.Form>
      </s-section>

      <s-modal
        id="view-image-modal"
        ref={viewModalRef}
        heading={viewingImage?.label || "Preview"}
      >
        {viewingImage && (
          <s-box inlineSize="100%" blockSize="480px">
            <s-image
              objectFit="contain"
              alt={`${viewingImage.label} full size`}
              src={viewingImage.url}
            />
          </s-box>
        )}
        <s-button
          slot="secondary-actions"
          type="button"
          command="--hide"
          commandFor="view-image-modal"
          onClick={closeViewModal}
        >
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}
