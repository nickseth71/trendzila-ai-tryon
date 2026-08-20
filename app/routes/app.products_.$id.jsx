// Product detail: /app/products/:id
// Lets the merchant upload three reference images (front/back/side) for a
// single product. On save, each image is uploaded to Shopify Files (via
// the staged-upload flow the Admin API requires for file uploads) and then
// written onto the product as a file_reference metafield. The metafield
// definitions (tryon.front_image / tryon.back_image / tryon.side_image)
// are created automatically the first time this runs, so there's no
// separate setup step for the merchant or developer.

import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

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
        # This product's own media only — used to populate the
        # "Import from Shopify" picker so it never shows images
        # belonging to other products.
        media(first: 50) {
          nodes {
            id
            ... on MediaImage {
              image { url }
            }
          }
        }
      }
    }`,
    { variables: { id: productGid } },
  );

  const { data } = await response.json();

  if (!data?.product) {
    throw new Response("Product not found", { status: 404 });
  }

  const productImages = (data.product.media?.nodes || [])
    .filter((node) => node?.image?.url)
    .map((node) => ({ id: node.id, url: node.image.url }));

  return {
    product: { id: data.product.id, title: data.product.title },
    existingImages: {
      front: data.product.front?.reference?.image?.url || null,
      back: data.product.back?.reference?.image?.url || null,
      side: data.product.side?.reference?.image?.url || null,
    },
    productImages,
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
    // Selected from the "Import from Shopify" picker — already a real
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
  const { product, existingImages, productImages } = useLoaderData();
  const fetcher = useFetcher();

  const [previews, setPreviews] = useState({
    front: null,
    back: null,
    side: null,
  });

  // Files picked from this product's own media, keyed by field:
  // { id: "gid://shopify/MediaImage/...", url: "..." }
  const [pickedFiles, setPickedFiles] = useState({
    front: null,
    back: null,
    side: null,
  });

  // Which field the "Import from Shopify" modal is currently choosing for.
  const [importField, setImportField] = useState(null);

  // The image currently shown in the full-size preview modal.
  const [previewImage, setPreviewImage] = useState(null);

  // Revoke object URLs on unmount so they don't leak.
  useEffect(() => {
    return () => {
      Object.values(previews).forEach((url) => url && URL.revokeObjectURL(url));
    };
  }, [previews]);

  function handleFileChange(fieldKey, event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreviews((current) => ({
      ...current,
      [fieldKey]: URL.createObjectURL(file),
    }));
    // A manual upload replaces any previously-imported file for this slot.
    setPickedFiles((current) => ({ ...current, [fieldKey]: null }));
  }

  function handlePickImage(image) {
    if (!importField) return;
    setPreviews((current) => {
      if (current[importField]) URL.revokeObjectURL(current[importField]);
      return { ...current, [importField]: null };
    });
    setPickedFiles((current) => ({
      ...current,
      [importField]: { id: image.id, url: image.url },
    }));
  }

  const isSaving = fetcher.state !== "idle";
  const result = fetcher.data;
  const importFieldLabel =
    IMAGE_FIELDS.find((f) => f.formField === importField)?.label || "image";

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
          <s-stack gap="large">
            {IMAGE_FIELDS.map(({ formField, label }) => {
              const picked = pickedFiles[formField];
              const previewUrl =
                previews[formField] || picked?.url || existingImages[formField];

              return (
                <s-stack
                  key={formField}
                  direction="inline"
                  gap="base"
                  blockAlignment="center"
                >
                  {/* Thumbnail with the eye icon overlaid top-right */}
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <s-box
                      border="base"
                      borderRadius="base"
                      overflow="hidden"
                      inlineSize="160px"
                      blockSize="160px"
                    >
                      {previewUrl ? (
                        <s-image
                          objectFit="cover"
                          alt={`${label} preview`}
                          src={previewUrl}
                        />
                      ) : null}
                    </s-box>
                    {previewUrl && (
                      <div style={{ position: "absolute", top: 6, right: 6 }}>
                        <s-button
                          icon="view"
                          variant="tertiary"
                          accessibilityLabel={`View ${label} full size`}
                          commandFor="preview-modal"
                          command="--show"
                          onClick={() =>
                            setPreviewImage({ label, url: previewUrl })
                          }
                        ></s-button>
                      </div>
                    )}
                  </div>

                  {/* Buttons on the side */}
                  <s-stack gap="small-200">
                    <s-text>{label}</s-text>
                    <input
                      type="file"
                      name={formField}
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => handleFileChange(formField, event)}
                    />
                    {picked && (
                      <input
                        type="hidden"
                        name={`${formField}_file_id`}
                        value={picked.id}
                      />
                    )}
                    <s-button
                      type="button"
                      variant="tertiary"
                      commandFor="import-modal"
                      command="--show"
                      onClick={() => setImportField(formField)}
                    >
                      Import from Shopify
                    </s-button>
                  </s-stack>
                </s-stack>
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

      {/* Import picker — scoped to this product's own media only */}
      <s-modal id="import-modal" heading={`Choose ${importFieldLabel}`}>
        {productImages.length === 0 ? (
          <s-paragraph>
            This product doesn't have any images yet. Upload one directly
            instead.
          </s-paragraph>
        ) : (
          <s-grid gap="base" gridTemplateColumns="repeat(4, minmax(0, 1fr))">
            {productImages.map((image) => (
              <s-button
                key={image.id}
                type="button"
                variant="tertiary"
                commandFor="import-modal"
                command="--hide"
                onClick={() => handlePickImage(image)}
              >
                <s-box
                  border="base"
                  borderRadius="base"
                  overflow="hidden"
                  inlineSize="100%"
                  blockSize="100px"
                >
                  <s-image objectFit="cover" alt="" src={image.url} />
                </s-box>
              </s-button>
            ))}
          </s-grid>
        )}
        <s-button
          slot="secondary-actions"
          commandFor="import-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      {/* Full-size image preview */}
      <s-modal id="preview-modal" heading={previewImage?.label || "Preview"}>
        {previewImage && (
          <s-image
            objectFit="contain"
            alt={previewImage.label}
            src={previewImage.url}
          />
        )}
        <s-button
          slot="secondary-actions"
          commandFor="preview-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}
