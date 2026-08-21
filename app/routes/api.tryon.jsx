// import prisma from "../db.server";
// import { unauthenticated } from "../shopify.server";

// const GEMINI_ENDPOINT =
//   "https://generativelanguage.googleapis.com/v1beta/interactions";
// const GEMINI_MODEL = "gemini-3.1-flash-image";

// const ANGLE_KEY = {
//   front: "front_image",
//   back: "back_image",
//   side: "side_image",
// };

// function buildPrompt(productTitle, angle) {
//   const angleLine = {
//     front:
//       "Generate a front-facing try-on result. The person should face the camera.",
//     back: "Generate a back-facing try-on result, showing the back print and collar.",
//     side: "Generate a three-quarter side try-on result.",
//   }[angle];

//   return `Create a realistic fashion try-on image for the product "${productTitle}".

// Use image 1 as the customer/person reference.
// Use image 2 as the garment/product reference.

// Dress the person in the exact garment shown in image 2 — preserve its color, pattern, print, collar shape, sleeve length, and overall fit.
// Preserve the person's face, skin tone, body shape, hair, and pose.
// Replace only the garment being worn. Keep the original background and lighting where possible.
// ${angleLine}
// Do not add unrelated text or logos. Do not make the person nude or sexualized.
// Return one vertical try-on image.`;
// }

// function parseDataUrl(dataUrl) {
//   const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
//   if (!match) throw new Error("Invalid image data URL.");
//   return { mimeType: match[1], base64: match[2] };
// }

// async function remoteImageToInline(url) {
//   const res = await fetch(url);
//   if (!res.ok) throw new Error(`Could not fetch image: ${res.status}`);
//   const buffer = Buffer.from(await res.arrayBuffer());
//   const contentType = (res.headers.get("content-type") || "image/jpeg").split(
//     ";",
//   )[0];
//   return { mimeType: contentType, base64: buffer.toString("base64") };
// }

// function findOutputImage(json) {
//   if (json?.output_image?.data) return json.output_image.data;

//   const stack = [json];
//   while (stack.length) {
//     const current = stack.pop();
//     if (!current || typeof current !== "object") continue;
//     if (
//       current.type === "image" &&
//       typeof current.data === "string" &&
//       current.data.length > 100
//     ) {
//       return current.data;
//     }
//     for (const value of Object.values(current)) {
//       if (value && typeof value === "object") stack.push(value);
//     }
//   }
//   return "";
// }

// async function fetchProductAndImage(shop, productGid, angleKey) {
//   const { admin } = await unauthenticated.admin(shop);

//   const response = await admin.graphql(
//     `#graphql
//     query TryOnImage($id: ID!) {
//       product(id: $id) {
//         title
//         image: metafield(namespace: "tryon", key: "${angleKey}") {
//           reference { ... on MediaImage { image { url } } }
//         }
//       }
//     }`,
//     { variables: { id: productGid } },
//   );

//   const { data } = await response.json();
//   return {
//     title: data?.product?.title,
//     imageUrl: data?.product?.image?.reference?.image?.url,
//   };
// }

// function corsHeaders(request) {
//   const origin = request.headers.get("Origin") || "*";
//   return {
//     "Access-Control-Allow-Origin": origin,
//     "Access-Control-Allow-Methods": "POST, OPTIONS",
//     "Access-Control-Allow-Headers": "Content-Type",
//   };
// }

// // Handles the browser's CORS preflight (OPTIONS) request.
// export async function loader({ request }) {
//   return new Response(null, { headers: corsHeaders(request) });
// }

// export async function action({ request }) {
//   const cors = corsHeaders(request);
//   const json = (data, init = {}) =>
//     Response.json(data, {
//       ...init,
//       headers: { ...cors, ...(init.headers || {}) },
//     });

//   if (request.method !== "POST") {
//     return json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
//   }

//   let body;
//   try {
//     body = await request.json();
//   } catch {
//     return json({ error: "INVALID_BODY" }, { status: 400 });
//   }

//   const {
//     shop,
//     productId,
//     angle = "front",
//     imageDataUrl,
//     sampleImageUrl,
//   } = body;
//   const angleKey = ANGLE_KEY[angle] || ANGLE_KEY.front;

//   if (!shop) {
//     return json({ error: "MISSING_SHOP" }, { status: 400 });
//   }
//   if (!productId) {
//     return json({ error: "MISSING_PRODUCT" }, { status: 400 });
//   }
//   if (!imageDataUrl && !sampleImageUrl) {
//     return json(
//       { error: "MISSING_IMAGE", message: "Upload a clear half-length photo." },
//       { status: 400 },
//     );
//   }
//   if (!process.env.GEMINI_API_KEY) {
//     return json(
//       {
//         error: "MISSING_GEMINI_API_KEY",
//         message: "GEMINI_API_KEY is not set on the server.",
//       },
//       { status: 500 },
//     );
//   }

//   // Confirm the shop is one that actually has the app installed.
//   const session = await prisma.session.findFirst({ where: { shop } });
//   if (!session) {
//     return json({ error: "UNKNOWN_SHOP" }, { status: 403 });
//   }

//   const gid = productId.startsWith("gid://")
//     ? productId
//     : `gid://shopify/Product/${productId}`;

//   try {
//     const { title, imageUrl: productImageUrl } = await fetchProductAndImage(
//       shop,
//       gid,
//       angleKey,
//     );
//     if (!productImageUrl) {
//       return json({ error: "NO_PRODUCT_IMAGE" }, { status: 422 });
//     }

//     const [personImage, productImage] = await Promise.all([
//       imageDataUrl
//         ? parseDataUrl(imageDataUrl)
//         : remoteImageToInline(sampleImageUrl),
//       remoteImageToInline(productImageUrl),
//     ]);

//     const geminiRes = await fetch(GEMINI_ENDPOINT, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "x-goog-api-key": process.env.GEMINI_API_KEY,
//       },
//       body: JSON.stringify({
//         model: GEMINI_MODEL,
//         input: [
//           { type: "text", text: buildPrompt(title, angle) },
//           {
//             type: "image",
//             mime_type: personImage.mimeType,
//             data: personImage.base64,
//           },
//           {
//             type: "image",
//             mime_type: productImage.mimeType,
//             data: productImage.base64,
//           },
//         ],
//         response_format: {
//           type: "image",
//           mime_type: "image/jpeg",
//           aspect_ratio: "3:4",
//           image_size: "512",
//         },
//       }),
//     });

//     const payload = await geminiRes.json();
//     if (!geminiRes.ok) {
//       return json(
//         {
//           error: "GEMINI_REQUEST_FAILED",
//           message: payload?.error?.message || "Gemini request failed.",
//         },
//         { status: geminiRes.status },
//       );
//     }

//     const imageBase64 = findOutputImage(payload);
//     if (!imageBase64) {
//       return json({ error: "NO_IMAGE_RETURNED" }, { status: 502 });
//     }

//     return json({
//       angle,
//       imageUrl: `data:image/jpeg;base64,${imageBase64}`,
//     });
//   } catch (error) {
//     return json(
//       {
//         error: "GENERATION_FAILED",
//         message: error.message || "Could not generate this try-on.",
//       },
//       { status: 500 },
//     );
//   }
// }

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.1-flash-image";

const ANGLE_KEY = {
  front: "front_image",
  back: "back_image",
  side: "side_image",
};

function buildPrompt(productTitle, angle) {
  const angleLine = {
    front:
      "Generate a front-facing try-on result. The person should face the camera.",
    back: "Generate a back-facing try-on result, showing the back print and collar.",
    side: "Generate a three-quarter side try-on result.",
  }[angle];

  return `Create a realistic fashion try-on image for the product "${productTitle}".

Use image 1 as the customer/person reference.
Use image 2 as the garment/product reference.

Dress the person in the exact garment shown in image 2 — preserve its color, pattern, print, collar shape, sleeve length, hemline, and overall silhouette precisely as shown. Do not shorten, lengthen, add, or remove any part of the garment (for example, do not turn long or short sleeves into a sleeveless/tank style, and do not change the neckline or hem).
Preserve the person's face, skin tone, body shape, hair, and pose.
Replace only the garment being worn. Keep the original background and lighting where possible.
${angleLine}
This is a photo-accurate product visualization, not a redesign — treat image 2 as the ground truth for every garment detail, including on angles not directly visible in it.
Do not add unrelated text or logos. Do not make the person nude or sexualized.
Return one vertical try-on image.`;
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid image data URL.");
  return { mimeType: match[1], base64: match[2] };
}

async function remoteImageToInline(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = (res.headers.get("content-type") || "image/jpeg").split(
    ";",
  )[0];
  return { mimeType: contentType, base64: buffer.toString("base64") };
}

// As of the Interactions API's June 2026 schema change, responses are
// shaped as `steps: [{ type: "model_output", content: [...] }]` rather than
// the old flat `outputs` array. A "thinking" model can also emit thought
// steps alongside the actual image, so we deliberately walk the documented
// structure to grab the real generated image rather than guessing at
// whichever image-shaped blob happens to be found first.
function findOutputImage(json) {
  const steps = Array.isArray(json?.steps) ? json.steps : [];
  for (const step of steps) {
    if (step?.type !== "model_output") continue;
    const content = Array.isArray(step.content) ? step.content : [];
    for (const block of content) {
      if (block?.type !== "image") continue;
      const data =
        block.data ||
        block.image_bytes ||
        block.bytes ||
        block.inline_data?.data;
      if (typeof data === "string" && data.length > 100) return data;
    }
  }

  // Should be rare once the structured path above matches what the API
  // actually sends — logged so it's visible in server logs if it's firing
  // more than expected, which would mean the response shape has changed
  // again and this needs another look.
  console.warn(
    "findOutputImage: no image found via steps[].content[], falling back to generic search. Response keys:",
    json && typeof json === "object" ? Object.keys(json) : typeof json,
  );

  const stack = [json];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (
      current.type === "image" &&
      typeof current.data === "string" &&
      current.data.length > 100
    ) {
      return current.data;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

async function fetchProductAndImage(shop, productGid, angleKey) {
  const { admin } = await unauthenticated.admin(shop);

  const response = await admin.graphql(
    `#graphql
    query TryOnImage($id: ID!) {
      product(id: $id) {
        title
        image: metafield(namespace: "tryon", key: "${angleKey}") {
          reference { ... on MediaImage { image { url } } }
        }
      }
    }`,
    { variables: { id: productGid } },
  );

  const { data } = await response.json();
  return {
    title: data?.product?.title,
    imageUrl: data?.product?.image?.reference?.image?.url,
  };
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// Handles the browser's CORS preflight (OPTIONS) request.
export async function loader({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

export async function action({ request }) {
  const cors = corsHeaders(request);
  const json = (data, init = {}) =>
    Response.json(data, {
      ...init,
      headers: { ...cors, ...(init.headers || {}) },
    });

  if (request.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const {
    shop,
    productId,
    angle = "front",
    imageDataUrl,
    sampleImageUrl,
  } = body;
  const angleKey = ANGLE_KEY[angle] || ANGLE_KEY.front;

  if (!shop) {
    return json({ error: "MISSING_SHOP" }, { status: 400 });
  }
  if (!productId) {
    return json({ error: "MISSING_PRODUCT" }, { status: 400 });
  }
  if (!imageDataUrl && !sampleImageUrl) {
    return json(
      { error: "MISSING_IMAGE", message: "Upload a clear half-length photo." },
      { status: 400 },
    );
  }
  if (!process.env.GEMINI_API_KEY) {
    return json(
      {
        error: "MISSING_GEMINI_API_KEY",
        message: "GEMINI_API_KEY is not set on the server.",
      },
      { status: 500 },
    );
  }

  // Confirm the shop is one that actually has the app installed.
  const session = await prisma.session.findFirst({ where: { shop } });
  if (!session) {
    return json({ error: "UNKNOWN_SHOP" }, { status: 403 });
  }

  const gid = productId.startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${productId}`;

  try {
    const { title, imageUrl: productImageUrl } = await fetchProductAndImage(
      shop,
      gid,
      angleKey,
    );
    if (!productImageUrl) {
      return json({ error: "NO_PRODUCT_IMAGE" }, { status: 422 });
    }

    const [personImage, productImage] = await Promise.all([
      imageDataUrl
        ? parseDataUrl(imageDataUrl)
        : remoteImageToInline(sampleImageUrl),
      remoteImageToInline(productImageUrl),
    ]);

    const geminiRes = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "Api-Revision": "2026-05-20",
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: [
          { type: "text", text: buildPrompt(title, angle) },
          {
            type: "image",
            mime_type: personImage.mimeType,
            data: personImage.base64,
          },
          {
            type: "image",
            mime_type: productImage.mimeType,
            data: productImage.base64,
          },
        ],
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "3:4",
          image_size: "1K",
        },
      }),
    });

    const payload = await geminiRes.json();
    if (!geminiRes.ok) {
      return json(
        {
          error: "GEMINI_REQUEST_FAILED",
          message: payload?.error?.message || "Gemini request failed.",
        },
        { status: geminiRes.status },
      );
    }

    const imageBase64 = findOutputImage(payload);
    if (!imageBase64) {
      return json({ error: "NO_IMAGE_RETURNED" }, { status: 502 });
    }

    return json({
      angle,
      imageUrl: `data:image/jpeg;base64,${imageBase64}`,
    });
  } catch (error) {
    return json(
      {
        error: "GENERATION_FAILED",
        message: error.message || "Could not generate this try-on.",
      },
      { status: 500 },
    );
  }
}