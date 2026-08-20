// Resource route: GET /app/api/file-preview?ids=gid1,gid2
// Used after the merchant picks existing files via the Intents API file
// picker (shopify.intents.invoke('pick:shopify/File')), which only
// returns file IDs — this resolves those IDs to previewable image URLs
// so we can show a thumbnail before the merchant hits Save.

import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids") || "";
  const ids = idsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return { images: {} };
  }

  const response = await admin.graphql(
    `#graphql
    query FilePreview($ids: [ID!]!) {
      nodes(ids: $ids) {
        id
        ... on MediaImage {
          image { url }
        }
      }
    }`,
    { variables: { ids } },
  );

  const { data } = await response.json();

  const images = {};
  for (const node of data?.nodes || []) {
    if (node?.image?.url) {
      images[node.id] = node.image.url;
    }
  }

  return { images };
}
