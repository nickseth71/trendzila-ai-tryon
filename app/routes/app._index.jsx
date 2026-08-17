import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="Trendzila">
      <s-section heading="AI Try-On">
        <s-paragraph>
          Let customers see how a product looks on them before they buy. Upload
          front, back, and side reference photos for a product, and shoppers get
          a floating <s-text emphasis="bold">AI Try-On</s-text> button on that
          product's page — they upload their own photo (or use a sample), and
          Gemini generates a realistic try-on image in seconds.
        </s-paragraph>
      </s-section>

      <s-section heading="How it works">
        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge>1</s-badge>
              <s-stack direction="block" gap="small-200">
                <s-text emphasis="bold">Add reference photos</s-text>
                <s-text tone="subdued">
                  Go to <s-link href="/app/products">Products</s-link> and
                  upload a front, back, and side photo for any product.
                </s-text>
              </s-stack>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge>2</s-badge>
              <s-stack direction="block" gap="small-200">
                <s-text emphasis="bold">Widget appears automatically</s-text>
                <s-text tone="subdued">
                  Any product with a front photo saved shows the AI Try-On
                  button on its storefront page — no extra setup per product.
                </s-text>
              </s-stack>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge>3</s-badge>
              <s-stack direction="block" gap="small-200">
                <s-text emphasis="bold">Customer tries it on</s-text>
                <s-text tone="subdued">
                  They upload a photo (or use a sample), tap Generate, and see
                  themselves wearing the product — front, side, and back —
                  powered by Gemini.
                </s-text>
              </s-stack>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About">
        <s-paragraph>
          <s-text>Organization: </s-text>
          <s-text emphasis="bold">Trendzila</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>App: </s-text>
          <s-text emphasis="bold">AI Try-On</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text tone="subdued">
            Adds a Gemini-powered virtual try-on experience to your product
            pages.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Next steps">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/products">Add reference photos</s-link> to your
            first product
          </s-list-item>
          <s-list-item>
            Preview the widget on that product's storefront page
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
