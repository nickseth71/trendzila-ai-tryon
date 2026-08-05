// App Proxy route.
// Shopify proxies storefront requests from https://{shop}/apps/tryon
// to this route, per the [app_proxy] block in shopify.app.toml.
// Same Gemini call/prompt logic as the original prototype's
// app/api/tryon/route.js — the only real change is that the product
// reference images come from this product's tryon.front_image /
// tryon.back_image / tryon.side_image metafields (set via the
// /app/products/:id dashboard page) instead of a hardcoded image map.

import { authenticate } from "../shopify.server";

export const runtime = "nodejs";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.1-flash-image";
const IMAGE_SIZE = "512";

const ANGLES = ["front", "side", "back"];

const angleInstruction = {
  front:
    "Generate a front-facing try-on result. The person should face the camera or stand in a natural front-facing pose.",
  side:
    "Generate a side or three-quarter side try-on result. Keep the person turned to the side so the garment's side profile, sleeve volume, and side print placement are visible.",
  back:
    "Generate a back-facing try-on result. Show the back of the person wearing the same garment, with the back print placement and collar visible."
};

function buildPrompt(angle, productTitle) {
  const description = productTitle
    ? `the exact garment shown in the reference product image (${productTitle})`
    : "the exact garment shown in the reference product image";

  return `Create a realistic fashion try-on image for a mobile fashion ecommerce product page.

Use image 1 as the customer/person reference.
Use image 2 as the garment/product reference.

Dress the person in ${description}.

Critical fit requirement:
The garment must not be cropped or shortened beyond what is shown in the product reference image. Match the garment length, hem placement, and silhouette shown in image 2 exactly. Do not make the garment look one or two sizes too small.

Preserve the person's face, skin tone, body shape, hair, pose direction, and identity.
Preserve the garment's print/pattern, collar or neckline shape, sleeve details, drape, and fabric tone from image 2.
Replace only the garment area being tried on. Preserve the original background and natural lighting where possible.
${angleInstruction[angle]}
Do not add unrelated text or logos. Do not change the garment's color, pattern, or silhouette from what is shown in image 2.
Do not make the person nude or sexualized.
Return one vertical try-on image.`;
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image data URL.");
  }
  return { mimeType: match[1], base64: match[2] };
}

async function remoteImageToInlinePart(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch image: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { mimeType: contentType.split(";")[0], base64: buffer.toString("base64") };
}

async function personImageToInlinePart({ imageDataUrl, imageUrl }) {
  if (imageDataUrl) return parseDataUrl(imageDataUrl);
  return remoteImageToInlinePart(imageUrl);
}

function findOutputImage(json) {
  if (json?.output_image?.data) return json.output_image.data;
  const stack = [json];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (current.type === "image" && typeof current.data === "string" && current.data.length > 100) {
      return current.data;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

function toProductGid(id) {
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

// Pulls the front/back/side reference images straight from the metafields
// written by the /app/products/:id dashboard page. This is what replaces
// the static `productImageByAngle` map from the prototype.
async function getProductTryOnImages(admin, productGid) {
  const response = await admin.graphql(
    `#graphql
    query TryOnMetafields($id: ID!) {
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
    { variables: { id: productGid } }
  );

  const { data } = await response.json();
  const product = data?.product;

  if (!product) return null;

  return {
    title: product.title,
    imagesByAngle: {
      front: product.front?.reference?.image?.url || null,
      side: product.side?.reference?.image?.url || null,
      back: product.back?.reference?.image?.url || null
    }
  };
}

export async function action({ request }) {
  try {
    if (request.method !== "POST") {
      return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
    }

    // Verifies the Shopify HMAC signature on the proxied request and
    // hands back an admin API client scoped to the shop it came from.
    const { admin } = await authenticate.public.appProxy(request);

    if (!admin) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const body = await request.json();
    const { imageDataUrl, imageUrl: personImageUrl, angle = "front", productId } = body;

    const normalizedAngle = ANGLES.includes(angle) ? angle : "front";

    if ((!imageDataUrl || typeof imageDataUrl !== "string") && (!personImageUrl || typeof personImageUrl !== "string")) {
      return Response.json(
        { error: "MISSING_IMAGE", message: "Upload a clear half-length photo." },
        { status: 400 }
      );
    }

    if (!productId || typeof productId !== "string") {
      return Response.json(
        { error: "MISSING_PRODUCT", message: "productId is required." },
        { status: 400 }
      );
    }

    if (!process.env.GEMINI_API_KEY) {
      return Response.json(
        { error: "MISSING_GEMINI_API_KEY", message: "GEMINI_API_KEY is not configured on the server." },
        { status: 500 }
      );
    }

    const productGid = toProductGid(productId);
    const tryOnData = await getProductTryOnImages(admin, productGid);

    if (!tryOnData || !tryOnData.imagesByAngle.front) {
      return Response.json(
        {
          error: "PRODUCT_NOT_ELIGIBLE",
          message: "This product has no front reference image saved yet."
        },
        { status: 403 }
      );
    }

    // Fall back to the front image if the requested angle wasn't uploaded.
    const productImageUrl = tryOnData.imagesByAngle[normalizedAngle] || tryOnData.imagesByAngle.front;

    const [personImage, productImage] = await Promise.all([
      personImageToInlinePart({ imageDataUrl, imageUrl: personImageUrl }),
      remoteImageToInlinePart(productImageUrl)
    ]);

    const geminiResponse = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: [
          { type: "text", text: buildPrompt(normalizedAngle, tryOnData.title) },
          { type: "image", mime_type: personImage.mimeType, data: personImage.base64 },
          { type: "image", mime_type: productImage.mimeType, data: productImage.base64 }
        ],
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "3:4",
          image_size: IMAGE_SIZE
        }
      })
    });

    const payload = await geminiResponse.json();

    if (!geminiResponse.ok) {
      return Response.json(
        { error: "GEMINI_REQUEST_FAILED", message: payload?.error?.message || "Gemini image generation failed." },
        { status: geminiResponse.status }
      );
    }

    const imageBase64 = findOutputImage(payload);

    if (!imageBase64) {
      return Response.json(
        { error: "NO_IMAGE_RETURNED", message: "Gemini did not return an image." },
        { status: 502 }
      );
    }

    return Response.json({
      angle: normalizedAngle,
      imageUrl: `data:image/jpeg;base64,${imageBase64}`,
      model: GEMINI_MODEL,
      imageSize: IMAGE_SIZE
    });
  } catch (error) {
    return Response.json(
      { error: "GENERATION_FAILED", message: error?.message || "We could not generate this try-on. Please try another photo." },
      { status: 500 }
    );
  }
}

// GET is not supported — this route only handles the POST generation call.
export async function loader() {
  return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
}
